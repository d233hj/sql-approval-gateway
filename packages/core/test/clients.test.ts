import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../src/util.js';
import {
  bearer,
  cookieAuth,
  request,
  setupAndUnlock,
  startTestGateway,
  uniquePassword,
  type Authenticated,
  type TestApp,
} from './helpers.js';

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

interface CreatedClient {
  id: string;
  name: string;
  token: string;
  created_at: string;
}

async function createClient(
  app: TestApp,
  auth: Authenticated,
  name: string,
): Promise<CreatedClient> {
  const response = await request(app.url, '/v1/admin/clients', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: { name },
  });
  assert.equal(response.status, 201, response.text);
  return bodyOf(response) as unknown as CreatedClient;
}

async function revokeClient(
  app: TestApp,
  auth: Authenticated,
  clientId: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, `/v1/admin/clients/${clientId}`, {
    method: 'DELETE',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

function clientRow(
  app: TestApp,
  clientId: string,
): { token_hash: string; name: string; disabled: number; last_used_at: string | null } | undefined {
  return app.gateway.store.db
    .prepare('SELECT token_hash, name, disabled, last_used_at FROM clients WHERE id = ?')
    .get(clientId) as
    | { token_hash: string; name: string; disabled: number; last_used_at: string | null }
    | undefined;
}

function auditEntries(
  app: TestApp,
  action: string,
): Array<{ action: string; detail: Record<string, unknown> }> {
  return (
    app.gateway.store.db
      .prepare('SELECT action, detail_json FROM audit WHERE action = ? ORDER BY seq ASC')
      .all(action) as Array<{ action: string; detail_json: string }>
  ).map((row) => ({
    action: row.action,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
  }));
}

test('POST /v1/admin/clients issues a 47-char sag_ token and stores only its sha256', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const created = await createClient(app, auth, 'ci agent');
  assert.equal(created.name, 'ci agent');
  assert.equal(typeof created.id, 'string');
  assert.ok(Number.isFinite(Date.parse(created.created_at)));

  assert.equal(created.token.length, 47);
  assert.equal(created.token.startsWith('sag_'), true);
  assert.match(created.token, /^sag_[A-Za-z0-9_-]{43}$/);
  assert.equal('token_hash' in created, false);

  const row = clientRow(app, created.id);
  assert.equal(row?.token_hash, sha256Hex(created.token));
  assert.notEqual(row?.token_hash, created.token);
  assert.equal(row?.disabled, 0);
  assert.equal(row?.name, 'ci agent');

  // The plaintext token must never appear in the persisted token hash column.
  const plaintext = app.gateway.store.db
    .prepare('SELECT COUNT(*) AS count FROM clients WHERE token_hash = ?')
    .get(created.token) as { count: number };
  assert.equal(plaintext.count, 0);

  // Listing (store level) must not carry the secret column either.
  const listed = app.gateway.store
    .listClients()
    .find((client) => client.id === created.id);
  assert.ok(listed);
  assert.equal('token_hash' in listed, false);
});

test('a newly created token authenticates the agent API and updates last_used_at', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  // Bearer admin sessions skip CSRF, matching the documented auth contract.
  const created = await (async () => {
    const response = await request(app.url, '/v1/admin/clients', {
      method: 'POST',
      headers: bearer(auth.sessionToken),
      body: { name: 'bearer created' },
    });
    assert.equal(response.status, 201, response.text);
    return bodyOf(response) as unknown as CreatedClient;
  })();

  const sources = await request(app.url, '/v1/agent/sources', {
    headers: bearer(created.token),
  });
  assert.equal(sources.status, 200, sources.text);
  assert.deepEqual(sources.json, []);

  const row = clientRow(app, created.id);
  assert.ok(row?.last_used_at, 'successful agent auth should stamp last_used_at');
});

test('GET /v1/admin/clients returns metadata only, never token or token_hash', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const created = await createClient(app, auth, 'listed agent');

  const list = await request(app.url, '/v1/admin/clients', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(list.status, 200, list.text);
  const clients = list.json as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(clients));

  const entry = clients.find((client) => client.id === created.id);
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), [
    'created_at',
    'disabled',
    'id',
    'last_used_at',
    'name',
  ]);
  assert.equal(entry.name, 'listed agent');
  assert.equal(entry.disabled, 0);
  assert.equal(entry.last_used_at, null);

  assert.equal(list.text.includes(created.token), false);
  assert.equal(list.text.includes(sha256Hex(created.token)), false);
  assert.equal(list.text.includes('token_hash'), false);
  assert.equal('token' in entry, false);
});

test('DELETE /v1/admin/clients/{id} disables the row and rejects the old token with 401', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const created = await createClient(app, auth, 'revoked agent');

  const revoked = await revokeClient(app, auth, created.id);
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual(revoked.body, { ok: true });

  // The record is kept (disable, not delete) and the flag is set.
  assert.equal(clientRow(app, created.id)?.disabled, 1);

  const agent = await request(app.url, '/v1/agent/sources', {
    headers: bearer(created.token),
  });
  assert.equal(agent.status, 401, agent.text);
  assert.equal(bodyOf(agent).code, 'UNAUTHENTICATED');

  const list = await request(app.url, '/v1/admin/clients', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(list.status, 200, list.text);
  const entry = (list.json as Array<Record<string, unknown>>).find(
    (client) => client.id === created.id,
  );
  assert.equal(entry?.disabled, 1);
});

test('repeat revoke is idempotent and writes no duplicate client.revoke audit', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const created = await createClient(app, auth, 'twice revoked');

  assert.equal((await revokeClient(app, auth, created.id)).status, 200);
  assert.equal((await revokeClient(app, auth, created.id)).status, 200);

  const revokes = auditEntries(app, 'client.revoke').filter(
    (entry) => entry.detail.client_id === created.id,
  );
  assert.equal(revokes.length, 1);
});

test('admin clients routes return 423 while the gateway is locked', async (t) => {
  const app = await startTestGateway(t);
  const password = uniquePassword();
  const setup = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });
  assert.equal(setup.status, 200, setup.text);

  const get = await request(app.url, '/v1/admin/clients');
  assert.equal(get.status, 423, get.text);
  assert.equal(bodyOf(get).code, 'NOT_UNLOCKED');

  const post = await request(app.url, '/v1/admin/clients', {
    method: 'POST',
    body: { name: 'locked agent' },
  });
  assert.equal(post.status, 423, post.text);
  assert.equal(bodyOf(post).code, 'NOT_UNLOCKED');

  const del = await request(app.url, '/v1/admin/clients/agent_default', {
    method: 'DELETE',
  });
  assert.equal(del.status, 423, del.text);
  assert.equal(bodyOf(del).code, 'NOT_UNLOCKED');
});

test('empty, whitespace-only and over-long client names are rejected with 400', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const before = app.gateway.store.listClients().length;

  const bodies: unknown[] = [
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(101) },
    {},
  ];
  for (const body of bodies) {
    const response = await request(app.url, '/v1/admin/clients', {
      method: 'POST',
      headers: cookieAuth(auth.cookie, auth.csrfToken),
      body,
    });
    assert.equal(response.status, 400, `${JSON.stringify(body)} -> ${response.text}`);
    assert.equal(bodyOf(response).code, 'INVALID_REQUEST');
  }

  assert.equal(app.gateway.store.listClients().length, before);
  assert.equal(auditEntries(app, 'client.create').length, 0);

  // Exactly 100 characters is still valid.
  const maxName = await createClient(app, auth, 'y'.repeat(100));
  assert.equal(maxName.name.length, 100);
});

test('deleting an unknown client id returns 404 CLIENT_NOT_FOUND', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const missing = await revokeClient(app, auth, 'does-not-exist');
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.body.code, 'CLIENT_NOT_FOUND');
});

test('client mutations require CSRF for cookie sessions but not for bearer sessions', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const before = app.gateway.store.listClients().length;

  const noCsrf = await request(app.url, '/v1/admin/clients', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: { name: 'no csrf' },
  });
  assert.equal(noCsrf.status, 403, noCsrf.text);
  assert.equal(bodyOf(noCsrf).code, 'CSRF_REJECTED');
  assert.equal(app.gateway.store.listClients().length, before);

  const created = await request(app.url, '/v1/admin/clients', {
    method: 'POST',
    headers: bearer(auth.sessionToken),
    body: { name: 'bearer session' },
  });
  assert.equal(created.status, 201, created.text);
  const createdBody = bodyOf(created) as unknown as CreatedClient;

  const revoke = await request(app.url, `/v1/admin/clients/${createdBody.id}`, {
    method: 'DELETE',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(revoke.status, 200, revoke.text);
});

test('client.create and client.revoke audits record the id and name only', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const created = await createClient(app, auth, 'audited agent');
  assert.equal((await revokeClient(app, auth, created.id)).status, 200);

  const creates = auditEntries(app, 'client.create').filter(
    (entry) => entry.detail.client_id === created.id,
  );
  assert.equal(creates.length, 1);
  assert.deepEqual(Object.keys(creates[0]!.detail).sort(), ['client_id', 'name']);
  assert.equal(creates[0]!.detail.name, 'audited agent');
  assert.equal(JSON.stringify(creates[0]!.detail).includes(created.token), false);

  const revokes = auditEntries(app, 'client.revoke').filter(
    (entry) => entry.detail.client_id === created.id,
  );
  assert.equal(revokes.length, 1);
  assert.deepEqual(Object.keys(revokes[0]!.detail).sort(), ['client_id', 'name']);
  assert.equal(revokes[0]!.detail.name, 'audited agent');

  // The audit is visible through the admin API and carries no secret.
  const audit = await request(app.url, '/v1/admin/audit', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(audit.status, 200, audit.text);
  assert.equal(audit.text.includes(created.token), false);
  assert.equal(audit.text.includes(sha256Hex(created.token)), false);
});

test('the setup-issued default token can also be revoked by id', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const revoke = await revokeClient(app, auth, 'agent_default');
  assert.equal(revoke.status, 200, revoke.text);

  const agent = await request(app.url, '/v1/agent/sources', {
    headers: bearer(auth.agentToken),
  });
  assert.equal(agent.status, 401, agent.text);
});
