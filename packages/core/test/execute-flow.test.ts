import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { ALLOWED_PROPOSAL_TRANSITIONS } from '@sql-approval/shared';

import {
  addTestSource,
  bearer,
  cookieAuth,
  request,
  setupAndUnlock,
  startTestGateway,
  type Authenticated,
  type TestApp,
} from './helpers.js';

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

function createDatabase(file: string, statements: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

function seedItems(file: string, count: number): void {
  createDatabase(file, ['CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)']);
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
    for (let index = 1; index <= count; index += 1) insert.run(index, `item-${index}`);
  } finally {
    db.close();
  }
}

async function addSqliteSource(
  app: TestApp,
  auth: Authenticated,
  file: string,
): Promise<string> {
  const response = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: `sqlite-${Math.random().toString(36).slice(2, 10)}`,
      dialect: 'sqlite',
      connection: { file },
    },
  });
  assert.equal(response.status, 201, response.text);
  return String(bodyOf(response).id);
}

interface SubmitOptions {
  sql: string;
  maxRows?: number;
  timeoutS?: number;
  purpose?: string;
}

async function submit(
  app: TestApp,
  auth: Authenticated,
  sourceId: string,
  options: SubmitOptions,
): Promise<string> {
  const response = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: options.sql,
      purpose: options.purpose ?? 'execution test',
      ...(options.maxRows === undefined ? {} : { max_rows: options.maxRows }),
      ...(options.timeoutS === undefined ? {} : { timeout_s: options.timeoutS }),
    },
  });
  assert.equal(response.status, 201, response.text);
  return String(bodyOf(response).id);
}

async function approve(
  app: TestApp,
  auth: Authenticated,
  proposalId: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, `/v1/admin/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

async function agentRows(
  app: TestApp,
  auth: Authenticated,
  proposalId: string,
  query = '',
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(
    app.url,
    `/v1/agent/proposals/${proposalId}/rows${query}`,
    { headers: bearer(auth.agentToken) },
  );
  return { status: response.status, body: bodyOf(response), text: response.text };
}

async function waitForStatus(
  app: TestApp,
  proposalId: string,
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.gateway.store.getProposal(proposalId)?.status === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`proposal did not reach ${expected}`);
}

test('submit → approve → execute → paged rows for agent and admin', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'data.sqlite');
  seedItems(file, 5);
  const sourceId = await addSqliteSource(app, auth, file);

  const proposalId = await submit(app, auth, sourceId, {
    sql: 'SELECT id, name FROM items ORDER BY id',
    maxRows: 10,
  });
  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.body.status, 'SUCCEEDED');
  assert.equal(executed.body.error_code, undefined);
  const result = executed.body.result as Record<string, unknown>;
  assert.equal(result.total_rows, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    (result.columns as Array<Record<string, unknown>>).map((column) => column.name),
    ['id', 'name'],
  );
  assert.equal(typeof result.duration_ms, 'number');
  assert.equal(typeof result.executed_at, 'string');
  assert.equal(typeof result.expires_at, 'string');

  const firstPage = await agentRows(app, auth, proposalId, '?page=1&page_size=2');
  assert.equal(firstPage.status, 200, firstPage.text);
  assert.equal(firstPage.body.page, 1);
  assert.equal(firstPage.body.page_size, 2);
  assert.equal(firstPage.body.total_rows, 5);
  assert.equal(firstPage.body.truncated, false);
  assert.deepEqual(
    (firstPage.body.columns as Array<Record<string, unknown>>).map((column) => column.name),
    ['id', 'name'],
  );
  assert.deepEqual(firstPage.body.rows, [
    [1, 'item-1'],
    [2, 'item-2'],
  ]);

  const thirdPage = await agentRows(app, auth, proposalId, '?page=3&page_size=2');
  assert.equal(thirdPage.status, 200, thirdPage.text);
  assert.deepEqual(thirdPage.body.rows, [[5, 'item-5']]);

  const adminPage = await request(
    app.url,
    `/v1/admin/proposals/${proposalId}/rows?page=1&page_size=10`,
    { headers: bearer(auth.sessionToken) },
  );
  assert.equal(adminPage.status, 200, adminPage.text);
  assert.equal(bodyOf(adminPage).total_rows, 5);
  assert.deepEqual((bodyOf(adminPage).rows as unknown[]).length, 5);

  const status = await request(app.url, `/v1/agent/proposals/${proposalId}`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(status.status, 200, status.text);
  assert.equal(bodyOf(status).status, 'SUCCEEDED');
  assert.equal((bodyOf(status).result as Record<string, unknown>).total_rows, 5);

  // A source secret (the database path) never leaks through the API.
  assert.equal(status.text.includes(app.dir), false);
  assert.equal(adminPage.text.includes(app.dir), false);
});

test('max_rows reads one extra row, truncates and reports it', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'truncate.sqlite');
  seedItems(file, 5);
  const sourceId = await addSqliteSource(app, auth, file);

  const proposalId = await submit(app, auth, sourceId, {
    sql: 'SELECT id FROM items ORDER BY id',
    maxRows: 2,
  });
  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.body.status, 'SUCCEEDED');
  const result = executed.body.result as Record<string, unknown>;
  assert.equal(result.total_rows, 2);
  assert.equal(result.truncated, true);

  const page = await agentRows(app, auth, proposalId, '?page_size=100');
  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.truncated, true);
  assert.deepEqual(page.body.rows, [[1], [2]]);
});

// Streams rows slowly (a fresh random blob per row) so a timeout or a lock can
// be observed between rows; a blocking aggregate cannot be interrupted because
// node:sqlite exposes no interrupt API.
const SLOW_STREAM_SQL =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) ' +
  'SELECT x + length(hex(randomblob(2000000))) AS v FROM c';

test('a query timeout aborts execution and stores no rows', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'timeout.sqlite');
  createDatabase(file, ['CREATE TABLE t (id INTEGER)']);
  const sourceId = await addSqliteSource(app, auth, file);

  const proposalId = await submit(app, auth, sourceId, {
    sql: SLOW_STREAM_SQL,
    maxRows: 5000,
    timeoutS: 1,
  });
  const startedAt = Date.now();
  const executed = await approve(app, auth, proposalId);
  const elapsed = Date.now() - startedAt;
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.body.status, 'FAILED');
  assert.equal(executed.body.error_code, 'QUERY_TIMEOUT');
  assert.equal(executed.body.result, null);
  assert.ok(elapsed >= 900, `timeout fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `timeout fired too late: ${elapsed}ms`);

  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'timeout');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);

  const rows = await agentRows(app, auth, proposalId);
  assert.equal(rows.status, 409, rows.text);
  assert.equal(rows.body.code, 'INVALID_STATE');
});

test('locking during execution aborts in-flight work, marks FAILED(locked) and writes no rows', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'lock.sqlite');
  createDatabase(file, ['CREATE TABLE t (id INTEGER)']);
  const sourceId = await addSqliteSource(app, auth, file);

  const proposalId = await submit(app, auth, sourceId, {
    sql: SLOW_STREAM_SQL,
    timeoutS: 60,
  });

  const approval = approve(app, auth, proposalId);
  await waitForStatus(app, proposalId, 'EXECUTING');
  // Let the worker actually start streaming before locking.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

  const lock = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(lock.status, 200, lock.text);

  const executed = await approval;
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.body.status, 'FAILED');
  assert.equal(executed.body.error_code, 'LOCKED');
  assert.equal(executed.body.result, null);

  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'locked');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);
  assert.equal(app.gateway.executor.workerCount, 0, 'the worker must be terminated');
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, false);

  // The lock failure is audited (action=proposal.failed, reason=locked).
  const audits = app.gateway.store.listAudit(0, 1000);
  const failedAudit = audits.find(
    (entry) => entry.action === 'proposal.failed' && entry.proposal_id === proposalId,
  );
  assert.ok(failedAudit, 'proposal.failed audit entry is missing for the lock path');
  assert.equal((JSON.parse(failedAudit!.detail_json) as Record<string, unknown>).reason, 'locked');
});

test('results expire after the TTL and hourly maintenance removes them', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'ttl.sqlite');
  seedItems(file, 2);
  const sourceId = await addSqliteSource(app, auth, file);

  const proposalId = await submit(app, auth, sourceId, {
    sql: 'SELECT id FROM items ORDER BY id',
    maxRows: 10,
  });
  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.body.status, 'SUCCEEDED', executed.text);

  const meta = app.gateway.store.getResultMeta(proposalId);
  assert.ok(meta);
  const executedAt = Date.parse(meta!.executed_at);
  // Write-time invariant: expires_at is always derived from executed_at.
  assert.equal(Date.parse(meta!.expires_at) - executedAt, 24 * 60 * 60 * 1000);

  // executed_at is NOT authoritative: moving it does not expire the result,
  // and cleanup ignores it as long as expires_at is in the future.
  app.gateway.store.db
    .prepare('UPDATE result_meta SET executed_at = ? WHERE proposal_id = ?')
    .run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), proposalId);
  const stillAvailable = await agentRows(app, auth, proposalId);
  assert.equal(stillAvailable.status, 200, stillAvailable.text);
  app.gateway.runMaintenance(Date.now());
  assert.ok(app.gateway.store.getResultMeta(proposalId), 'cleanup keys on expires_at only');

  // The API rejects an expired result (expires_at moved into the past).
  app.gateway.store.db
    .prepare('UPDATE result_meta SET expires_at = ? WHERE proposal_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), proposalId);
  const expired = await agentRows(app, auth, proposalId);
  assert.equal(expired.status, 410, expired.text);
  assert.equal(expired.body.code, 'RESULT_EXPIRED');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);

  // A second execution, then the hourly maintenance pass removes it at TTL.
  const secondId = await submit(app, auth, sourceId, {
    sql: 'SELECT id FROM items ORDER BY id',
    maxRows: 10,
  });
  assert.equal((await approve(app, auth, secondId)).body.status, 'SUCCEEDED');
  const secondMeta = app.gateway.store.getResultMeta(secondId);
  assert.ok(secondMeta);
  app.gateway.runMaintenance(Date.parse(secondMeta!.expires_at) + 1);
  assert.equal(app.gateway.store.getResultMeta(secondId), null);
  assert.equal(app.gateway.store.getResultRows(secondId, 0, 10).length, 0, 'rows cascade');
  const gone = await agentRows(app, auth, secondId);
  assert.equal(gone.status, 410, gone.text);
  assert.equal(gone.body.code, 'RESULT_EXPIRED');
});

test('approval re-checks the recorded policy version and fails closed', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'policy.sqlite');
  seedItems(file, 1);
  const sourceId = await addSqliteSource(app, auth, file);

  // The shared state machine must allow the system-failure edge.
  assert.ok(
    ALLOWED_PROPOSAL_TRANSITIONS.PENDING_APPROVAL.includes('FAILED'),
    'PENDING_APPROVAL → FAILED must be a legal transition',
  );

  const proposalId = await submit(app, auth, sourceId, { sql: 'SELECT id FROM items' });
  app.gateway.store.db
    .prepare('UPDATE proposals SET policy_version = ? WHERE id = ?')
    .run('sag-policy-0', proposalId);

  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.status, 409, executed.text);
  assert.equal(executed.body.code, 'POLICY_DENIED');
  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'policy_version_mismatch');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);

  // The failure is audited once with a machine-readable reason.
  const audits = app.gateway.store.listAudit(0, 1000);
  const failedAudit = audits.find(
    (entry) => entry.action === 'proposal.failed' && entry.proposal_id === proposalId,
  );
  assert.ok(failedAudit, 'proposal.failed audit entry is missing');
  assert.equal(
    (JSON.parse(failedAudit!.detail_json) as Record<string, unknown>).reason,
    'policy_version_mismatch',
  );

  // The same edge works through the plain transition API (used by the executor).
  const secondId = await submit(app, auth, sourceId, { sql: 'SELECT id FROM items' });
  assert.equal(
    app.gateway.store.transitionProposal(secondId, 'PENDING_APPROVAL', 'FAILED', 'test'),
    true,
  );
  assert.equal(app.gateway.store.getProposal(secondId)?.status, 'FAILED');
});

test('oversized rows are truncated with a marker and the total payload is capped', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'sizes.sqlite');
  createDatabase(file, [
    'CREATE TABLE huge_row (payload TEXT)',
    'CREATE TABLE many_rows (payload TEXT)',
  ]);
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO huge_row (payload) VALUES (?)').run('x'.repeat(70 * 1024));
    const insert = db.prepare('INSERT INTO many_rows (payload) VALUES (?)');
    for (let index = 0; index < 150; index += 1) insert.run('y'.repeat(60 * 1024));
  } finally {
    db.close();
  }
  const sourceId = await addSqliteSource(app, auth, file);

  const hugeId = await submit(app, auth, sourceId, {
    sql: 'SELECT payload FROM huge_row',
    maxRows: 10,
  });
  const hugeExecuted = await approve(app, auth, hugeId);
  assert.equal(hugeExecuted.body.status, 'SUCCEEDED', hugeExecuted.text);
  assert.equal((hugeExecuted.body.result as Record<string, unknown>).total_rows, 1);

  const hugePage = await agentRows(app, auth, hugeId, '?page_size=1');
  assert.equal(hugePage.status, 200, hugePage.text);
  // An oversized row is stored as a marker object (not an array): clients can
  // tell truncation from data by the `__truncated` flag.
  const marker = (hugePage.body.rows as unknown[])[0] as Record<string, unknown>;
  assert.equal(marker.__truncated, true);
  assert.ok(Number(marker.original_bytes) > 64 * 1024);
  assert.equal(typeof marker.preview, 'string');

  const manyId = await submit(app, auth, sourceId, {
    sql: 'SELECT payload FROM many_rows',
    maxRows: 500,
  });
  const manyExecuted = await approve(app, auth, manyId);
  assert.equal(manyExecuted.body.status, 'SUCCEEDED', manyExecuted.text);
  const manyResult = manyExecuted.body.result as Record<string, unknown>;
  assert.equal(manyResult.truncated, true);
  const stored = Number(manyResult.total_rows);
  assert.ok(stored > 0, 'some rows are stored before the cap');
  assert.ok(stored < 150, `total payload cap must stop storage, stored ${stored}`);

  const manyPage = await agentRows(app, auth, manyId, '?page_size=1');
  assert.equal(manyPage.status, 200, manyPage.text);
  assert.equal(manyPage.body.truncated, true);
  assert.equal(manyPage.body.total_rows, stored);
});

test('query parameters are bound by the connector', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const file = join(app.dir, 'params.sqlite');
  seedItems(file, 4);
  const sourceId = await addSqliteSource(app, auth, file);

  const positional = await submit(app, auth, sourceId, {
    sql: 'SELECT name FROM items WHERE id = ?',
    maxRows: 10,
  });
  // Re-submit with parameters: submit() has no params option, so use the API.
  const withParams = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT name FROM items WHERE id = ?',
      params: [3],
      max_rows: 10,
    },
  });
  assert.equal(withParams.status, 201, withParams.text);
  const proposalId = String(bodyOf(withParams).id);
  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.body.status, 'SUCCEEDED', executed.text);
  const page = await agentRows(app, auth, proposalId, '?page_size=10');
  assert.deepEqual(page.body.rows, [['item-3']]);

  // A named-parameter query also works (bare names are accepted).
  const named = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT name FROM items WHERE id = :id',
      params: { id: 2 },
      max_rows: 10,
    },
  });
  assert.equal(named.status, 201, named.text);
  const namedId = String(bodyOf(named).id);
  const namedExecuted = await approve(app, auth, namedId);
  assert.equal(namedExecuted.body.status, 'SUCCEEDED', namedExecuted.text);
  const namedPage = await agentRows(app, auth, namedId, '?page_size=10');
  assert.deepEqual(namedPage.body.rows, [['item-2']]);

  // Without bound parameters SQLite treats the placeholder as NULL, so the
  // query returns no rows (and still succeeds).
  const unbound = await approve(app, auth, positional);
  assert.equal(unbound.body.status, 'SUCCEEDED', unbound.text);
  assert.equal((unbound.body.result as Record<string, unknown>).total_rows, 0);
});

test('a source without a database file fails the strict probe with an error code only', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);
  const proposalId = await submit(app, auth, source.id, { sql: 'SELECT 1 AS one' });
  const executed = await approve(app, auth, proposalId);
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.body.status, 'FAILED');
  // Strict mode is on by default: the approval-time probe cannot even open the
  // source, so the proposal fails before the executor is involved.
  assert.equal(executed.body.error_code, 'SOURCE_PROBE_FAILED');
  assert.equal(executed.text.includes('SELECT'), false, 'SQL must not be echoed');
  assert.equal(executed.text.includes(app.dir), false, 'paths must not be echoed');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null, 'no result may be stored');
});
