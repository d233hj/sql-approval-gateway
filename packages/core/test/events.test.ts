/**
 * Live proposal events (GET /v1/events) — SSE fan-out, heartbeat and cleanup.
 *
 * The bus is tested with fake responses so heartbeat timing stays fast; the
 * gateway is tested over a real socket to prove auth headers, the frame shape
 * (id/source/at only, never the SQL) and that a closed console leaves no
 * subscriber or timer behind.
 */
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import test from 'node:test';

import {
  ProposalEventBus,
  formatProposalEvent,
  type EventStreamResponse,
} from '../src/events.js';
import {
  addTestSource,
  bearer,
  cookieAuth,
  request,
  setupAndUnlock,
  startTestGateway,
  submitProposal,
} from './helpers.js';

class FakeStream implements EventStreamResponse {
  readonly chunks: string[] = [];
  ended = false;
  writableEnded = false;
  destroyed = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

interface EventStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** Resolves with everything received so far once `pattern` shows up. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  close(): void;
}

async function openEventStream(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<EventStream> {
  const target = new URL('/v1/events', baseUrl);
  const chunks: string[] = [];
  let ended = false;
  const outgoing = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers,
    agent: false,
  });
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    outgoing.once('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        chunks.push(chunk);
      });
      response.on('end', () => {
        ended = true;
      });
      response.on('error', () => {
        ended = true;
      });
      resolve(response);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });

  return {
    status: incoming.statusCode ?? 0,
    headers: incoming.headers,
    async waitFor(pattern: RegExp, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = chunks.join('');
        if (pattern.test(text)) return text;
        if (ended) throw new Error(`stream ended before ${pattern}: ${text}`);
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${pattern}: ${text}`);
        }
        await delay(10);
      }
    },
    close(): void {
      outgoing.destroy();
    },
  };
}

function dataOf(text: string, eventName: string): Record<string, unknown> {
  const frame = text
    .split('\n\n')
    .find((candidate) => candidate.startsWith(`event: ${eventName}`));
  assert.ok(frame !== undefined, `missing ${eventName} frame in ${text}`);
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  assert.ok(dataLine !== undefined, `missing data line in ${frame}`);
  const parsed: unknown = JSON.parse(dataLine.slice('data:'.length).trim());
  assert.equal(typeof parsed, 'object');
  return parsed as Record<string, unknown>;
}

// --------------------------------------------------------------- event bus

test('formatProposalEvent carries only id/source/at', () => {
  const frame = formatProposalEvent({
    type: 'proposal.created',
    id: 'proposal-1',
    source: 'crm',
    at: 1_700_000_000_000,
  });
  assert.equal(
    frame,
    'event: proposal.created\ndata: {"id":"proposal-1","source":"crm","at":1700000000000}\n\n',
  );
  // No SQL/params/connection fields can appear in a frame.
  assert.ok(!frame.includes('sql'));
  assert.ok(!frame.includes('params'));
});

test('bus broadcasts to every live subscriber', () => {
  const bus = new ProposalEventBus(60_000);
  const first = new FakeStream();
  const second = new FakeStream();
  bus.subscribe(first);
  bus.subscribe(second);
  assert.equal(bus.size, 2);

  bus.broadcast({ type: 'proposal.created', id: 'p1', source: 'src', at: 42 });
  const expected = 'event: proposal.created\ndata: {"id":"p1","source":"src","at":42}\n\n';
  assert.deepEqual(first.chunks, [expected]);
  assert.deepEqual(second.chunks, [expected]);
  bus.closeAll();
  assert.equal(bus.size, 0);
});

test('unsubscribe removes only the closed subscriber', () => {
  const bus = new ProposalEventBus(60_000);
  const kept = new FakeStream();
  const closed = new FakeStream();
  bus.subscribe(kept);
  bus.subscribe(closed);
  bus.unsubscribe(closed);
  assert.equal(bus.size, 1);

  bus.broadcast({ type: 'proposal.updated', id: 'p2', source: 'src', at: 7 });
  assert.equal(closed.chunks.length, 0);
  assert.equal(kept.chunks.length, 1);
  bus.closeAll();
});

test('bus drops a dead subscriber instead of throwing', () => {
  const bus = new ProposalEventBus(60_000);
  const alive = new FakeStream();
  const dead = new FakeStream();
  dead.destroyed = true;
  bus.subscribe(alive);
  bus.subscribe(dead);
  bus.broadcast({ type: 'proposal.updated', id: 'p3', source: 'src', at: 1 });
  assert.equal(bus.size, 1);
  assert.equal(alive.chunks.length, 1);
  bus.closeAll();
});

test('heartbeat writes a comment ping', async () => {
  const bus = new ProposalEventBus(5);
  const stream = new FakeStream();
  bus.subscribe(stream);
  await delay(40);
  assert.ok(
    stream.chunks.filter((chunk) => chunk === ': ping\n\n').length > 0,
    `no heartbeat in ${JSON.stringify(stream.chunks)}`,
  );
  bus.unsubscribe(stream);
  const pings = stream.chunks.length;
  await delay(30);
  assert.equal(stream.chunks.length, pings, 'heartbeat kept running after unsubscribe');
});

// ----------------------------------------------------------- gateway stream

test('gateway streams proposal.created under 1s after a submit', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth, { name: 'live-source', marker: 'live' });
  const stream = await openEventStream(app.url, bearer(auth.sessionToken));
  try {
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
    assert.equal(stream.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(stream.headers['x-accel-buffering'], 'no');

    const submittedAt = Date.now();
    const proposal = await submitProposal(app, auth.agentToken, source.id);
    const text = await stream.waitFor(/event: proposal\.created/);
    const latencyMs = Date.now() - submittedAt;
    assert.ok(latencyMs < 1000, `event arrived after ${latencyMs}ms`);

    const data = dataOf(text, 'proposal.created');
    assert.deepEqual(Object.keys(data).sort(), ['at', 'id', 'source']);
    assert.equal(data.id, proposal.id);
    assert.equal(data.source, 'live-source');
    assert.equal(typeof data.at, 'number');
    // The frame must never leak the SQL text the proposal carries.
    assert.ok(!text.includes('SELECT 1 AS one'));
  } finally {
    stream.close();
  }
});

test('gateway announces proposal.updated after a reject', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth, { name: 'reject-source', marker: 'live' });
  const stream = await openEventStream(app.url, bearer(auth.sessionToken));
  try {
    const proposal = await submitProposal(app, auth.agentToken, source.id);
    await stream.waitFor(/event: proposal\.created/);

    const rejected = await request(app.url, `/v1/admin/proposals/${String(proposal.id)}/reject`, {
      method: 'POST',
      headers: cookieAuth(auth.cookie, auth.csrfToken),
      body: { reason: 'not now' },
    });
    assert.equal(rejected.status, 200, rejected.text);

    const text = await stream.waitFor(/event: proposal\.updated/);
    const data = dataOf(text, 'proposal.updated');
    assert.equal(data.id, proposal.id);
    assert.equal(data.source, 'reject-source');
  } finally {
    stream.close();
  }
});

test('gateway announces proposal.updated when the approval window expires', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth, { name: 'expire-source', marker: 'live' });
  const stream = await openEventStream(app.url, bearer(auth.sessionToken));
  try {
    const proposal = await submitProposal(app, auth.agentToken, source.id);
    await stream.waitFor(/event: proposal\.created/);

    // Default approval window is 24 h; sweep from beyond it.
    app.gateway.runMaintenance(Date.now() + 25 * 60 * 60 * 1000);

    const text = await stream.waitFor(/event: proposal\.updated/);
    const data = dataOf(text, 'proposal.updated');
    assert.equal(data.id, proposal.id);
  } finally {
    stream.close();
  }
});

test('a disconnected console leaves no subscriber behind', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const stream = await openEventStream(app.url, bearer(auth.sessionToken));
  try {
    assert.equal(stream.status, 200);
    await waitUntil(() => app.gateway.events.size === 1, 2000, 'subscriber registration');
  } finally {
    stream.close();
  }
  await waitUntil(() => app.gateway.events.size === 0, 3000, 'subscriber cleanup');
});

test('GET /v1/events rejects anonymous callers and locked gateways', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const anonymous = await request(app.url, '/v1/events', {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(anonymous.status, 401, anonymous.text);

  const locked = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
  });
  assert.equal(locked.status, 200, locked.text);

  const afterLock = await request(app.url, '/v1/events', {
    headers: bearer(auth.sessionToken),
  });
  assert.equal(afterLock.status, 423, afterLock.text);
});
