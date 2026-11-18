import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { readVaultDocument } from '../src/vault.js';
import { randomToken } from '../src/util.js';
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

interface SourceBody {
  id: string;
  name: string;
  dialect: string;
}

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

function sqliteFixture(dir: string, name = 'probe.db'): string {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO demo (name) VALUES (\'row\');');
  } finally {
    db.close();
  }
  return file;
}

async function createSqliteSource(
  app: TestApp,
  auth: Authenticated,
  connection: Record<string, unknown>,
  name = `source-${randomToken(6)}`,
): Promise<SourceBody> {
  const created = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: { name, dialect: 'sqlite', connection },
  });
  assert.equal(created.status, 201, created.text);
  return created.json as SourceBody;
}

async function updateSource(
  app: TestApp,
  auth: Authenticated,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; json: unknown }> {
  return request(app.url, `/v1/admin/sources/${id}`, {
    method: 'PUT',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body,
  });
}

async function testSource(
  app: TestApp,
  auth: Authenticated,
  id: string,
  headers: Record<string, string> = cookieAuth(auth.cookie, auth.csrfToken),
): Promise<{ status: number; text: string; json: unknown }> {
  return request(app.url, `/v1/admin/sources/${id}/test`, {
    method: 'POST',
    headers,
  });
}

function vaultSecretFor(app: TestApp, sourceId: string): Record<string, unknown> {
  const secret = app.gateway.vault.getSourceSecret(sourceId);
  assert.ok(secret, 'source secret must exist while unlocked');
  return secret;
}

test('PUT name keeps the connection ciphertext, password and testability', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const file = sqliteFixture(app.dir);
  const source = await createSqliteSource(app, auth, { file, password: 'old-pass' });

  const before = readVaultDocument(join(app.dir, 'vault.json')).sources.find(
    (entry) => entry.id === source.id,
  );
  assert.ok(before, 'the source must be in the vault');

  const renamed = await updateSource(app, auth, source.id, { name: 'renamed-source' });
  assert.equal(renamed.status, 200, renamed.text);
  const renamedBody = bodyOf(renamed);
  assert.equal(renamedBody.name, 'renamed-source');
  assert.equal(renamedBody.dialect, 'sqlite');
  assert.deepEqual(Object.keys(renamedBody).sort(), ['dialect', 'id', 'name']);
  assert.equal(renamed.text.includes(file), false);

  const after = readVaultDocument(join(app.dir, 'vault.json')).sources.find(
    (entry) => entry.id === source.id,
  );
  assert.ok(after, 'the source must still be in the vault');
  // "改名不动连接": the wrapped secret is byte-for-byte unchanged.
  assert.deepEqual(after.secret, before.secret);

  assert.deepEqual(vaultSecretFor(app, source.id), { file, password: 'old-pass' });

  const tested = await testSource(app, auth, source.id);
  assert.equal(tested.status, 200, tested.text);
  assert.equal(bodyOf(tested).ok, true, tested.text);
});

test('connection password is preserved when omitted/empty and replaced when provided', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const file = sqliteFixture(app.dir);
  const source = await createSqliteSource(app, auth, {
    file,
    password: 'old-pass',
    custom_marker: 'keep-me',
  });
  const beforeRotation = readVaultDocument(join(app.dir, 'vault.json')).sources.find(
    (entry) => entry.id === source.id,
  );
  assert.ok(beforeRotation);

  const cleared = await updateSource(app, auth, source.id, { connection: { password: '' } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(vaultSecretFor(app, source.id), {
    file,
    password: 'old-pass',
    custom_marker: 'keep-me',
  });

  const rotated = await updateSource(app, auth, source.id, {
    connection: { password: 'new-pass' },
  });
  assert.equal(rotated.status, 200, rotated.text);
  // Unspecified connection fields are preserved by the shallow merge.
  assert.deepEqual(vaultSecretFor(app, source.id), {
    file,
    password: 'new-pass',
    custom_marker: 'keep-me',
  });
  const afterRotation = readVaultDocument(join(app.dir, 'vault.json')).sources.find(
    (entry) => entry.id === source.id,
  );
  assert.ok(afterRotation);
  assert.notDeepEqual(afterRotation.secret, beforeRotation.secret, 'the secret is re-encrypted');

  // A later metadata-only update must not disturb the rotated password.
  assert.equal((await updateSource(app, auth, source.id, { name: 'after-rotate' })).status, 200);
  assert.deepEqual(vaultSecretFor(app, source.id), {
    file,
    password: 'new-pass',
    custom_marker: 'keep-me',
  });

  const tested = await testSource(app, auth, source.id);
  assert.equal(tested.status, 200, tested.text);
  assert.equal(bodyOf(tested).ok, true);

  const rawVault = readVaultDocument(join(app.dir, 'vault.json'));
  const serialized = JSON.stringify(rawVault);
  assert.equal(serialized.includes('old-pass'), false);
  assert.equal(serialized.includes('new-pass'), false);
});

test('changing dialect without a connection is rejected and leaves the source unchanged', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const file = sqliteFixture(app.dir);
  const source = await createSqliteSource(app, auth, { file });

  const missingConnection = await updateSource(app, auth, source.id, { dialect: 'postgres' });
  assert.equal(missingConnection.status, 400, missingConnection.text);
  assert.equal(bodyOf(missingConnection).code, 'INVALID_REQUEST');

  const current = await request(app.url, '/v1/admin/sources', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(current.status, 200);
  const listed = (current.json as Array<Record<string, unknown>>).find(
    (entry) => entry.id === source.id,
  );
  assert.ok(listed);
  assert.equal(listed.dialect, 'sqlite');
  assert.deepEqual(vaultSecretFor(app, source.id), { file });

  // Passing the *same* dialect alone is a harmless no-op.
  const sameDialect = await updateSource(app, auth, source.id, { dialect: 'sqlite' });
  assert.equal(sameDialect.status, 200, sameDialect.text);

  // An explicit connection allows the dialect change.
  const changed = await updateSource(app, auth, source.id, {
    dialect: 'postgres',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      database: 'demo',
      username: 'demo-user',
      password: 'demo-secret',
    },
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(bodyOf(changed).dialect, 'postgres');
  const secret = vaultSecretFor(app, source.id);
  assert.equal(secret.host, '127.0.0.1');
  assert.equal(secret.password, 'demo-secret');
});

test('empty update body is a no-op without an audit entry', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const source = await createSqliteSource(app, auth, { file: sqliteFixture(app.dir) });

  const response = await updateSource(app, auth, source.id, {});
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(bodyOf(response), { id: source.id, name: source.name, dialect: 'sqlite' });

  const audit = await request(app.url, '/v1/admin/audit', {
    headers: { Cookie: auth.cookie },
  });
  const actions = (audit.json as Array<Record<string, unknown>>).map((entry) => entry.action);
  assert.equal(actions.includes('source.update'), false);
});

test('sqlite test succeeds with readonly.ok=true and no connection leak', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const file = sqliteFixture(app.dir);
  const password = 'probe-secret';
  const source = await createSqliteSource(app, auth, { file, password });

  const tested = await testSource(app, auth, source.id);
  assert.equal(tested.status, 200, tested.text);
  const body = bodyOf(tested);
  assert.equal(body.ok, true, tested.text);
  assert.equal(typeof body.latency_ms, 'number');
  const readonly = body.readonly as Record<string, unknown>;
  assert.equal(readonly.ok, true);
  assert.equal(readonly.checked, true);
  assert.ok(Array.isArray(readonly.details));
  assert.match(String(body.server), /^SQLite /);

  assert.equal(tested.text.includes(file), false, 'the database path must not be echoed');
  assert.equal(tested.text.includes(password), false);
  assert.equal(/"connection"|"password"|"username"|"host"/.test(tested.text), false);

  // The endpoint accepts no user SQL: a body is ignored, never executed.
  const withSql = await request(app.url, `/v1/admin/sources/${source.id}/test`, {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: { sql: 'DROP TABLE demo' },
  });
  assert.equal(withSql.status, 200, withSql.text);
  assert.equal(bodyOf(withSql).ok, true);
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const row = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demo'").get();
    assert.ok(row, 'the probe must not execute caller-supplied SQL');
  } finally {
    check.close();
  }

  const audit = await request(app.url, '/v1/admin/audit', {
    headers: { Cookie: auth.cookie },
  });
  const entries = audit.json as Array<Record<string, unknown>>;
  const testEntries = entries.filter((entry) => entry.action === 'source.test');
  assert.equal(testEntries.length, 2);
  for (const entry of testEntries) {
    assert.deepEqual(entry.detail, {
      source_id: source.id,
      ok: true,
      readonly: { ok: true },
    });
  }
  const verification = await request(app.url, '/v1/admin/audit/verify', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(bodyOf(verification).valid, true);
});

test('failed sqlite test returns ok=false and keeps the source', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const missingFile = join(app.dir, 'does-not-exist.db');
  const source = await createSqliteSource(app, auth, { file: missingFile });

  const tested = await testSource(app, auth, source.id);
  assert.equal(tested.status, 200, tested.text);
  const body = bodyOf(tested);
  assert.equal(body.ok, false);
  assert.equal(body.error_code, 'QUERY_FAILED');
  const readonly = body.readonly as Record<string, unknown>;
  assert.equal(readonly.ok, false);
  assert.equal(readonly.checked, false);
  assert.equal(tested.text.includes(missingFile), false);

  const sources = await request(app.url, '/v1/admin/sources', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(sources.status, 200);
  assert.deepEqual(
    (sources.json as Array<Record<string, unknown>>).map((entry) => entry.id),
    [source.id],
  );
  assert.equal(existsSync(missingFile), false, 'a probe must not create the database file');
});

test('unknown sources return 404 for update and test', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const missingUpdate = await updateSource(app, auth, 'no-such-source', { name: 'x' });
  assert.equal(missingUpdate.status, 404, missingUpdate.text);
  assert.equal(bodyOf(missingUpdate).code, 'SOURCE_NOT_FOUND');

  const missingTest = await testSource(app, auth, 'no-such-source');
  assert.equal(missingTest.status, 404, missingTest.text);
  assert.equal(bodyOf(missingTest).code, 'SOURCE_NOT_FOUND');
});

test('locked gateway rejects update and test with 423', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);

  const lock = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(lock.status, 200, lock.text);
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, false);

  const update = await request(app.url, `/v1/admin/sources/${source.id}`, {
    method: 'PUT',
    body: { name: 'should-not-apply' },
  });
  assert.equal(update.status, 423, update.text);
  assert.equal(bodyOf(update).code, 'NOT_UNLOCKED');

  const tested = await request(app.url, `/v1/admin/sources/${source.id}/test`, {
    method: 'POST',
  });
  assert.equal(tested.status, 423, tested.text);
  assert.equal(bodyOf(tested).code, 'NOT_UNLOCKED');
});

test('cookie update/test without CSRF is rejected', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const source = await createSqliteSource(app, auth, { file: sqliteFixture(app.dir) });

  const update = await request(app.url, `/v1/admin/sources/${source.id}`, {
    method: 'PUT',
    headers: { Cookie: auth.cookie },
    body: { name: 'no-csrf' },
  });
  assert.equal(update.status, 403, update.text);
  assert.equal(bodyOf(update).code, 'CSRF_REJECTED');

  const tested = await request(app.url, `/v1/admin/sources/${source.id}/test`, {
    method: 'POST',
    headers: { Cookie: auth.cookie },
  });
  assert.equal(tested.status, 403, tested.text);
  assert.equal(bodyOf(tested).code, 'CSRF_REJECTED');
});

test('source.update audit records field names but no connection details', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const file = sqliteFixture(app.dir);
  const source = await createSqliteSource(app, auth, { file, password: 'audit-secret' });

  const updated = await updateSource(app, auth, source.id, {
    name: 'audited',
    connection: { password: 'audit-secret-2' },
  });
  assert.equal(updated.status, 200, updated.text);

  const tested = await testSource(app, auth, source.id);
  assert.equal(bodyOf(tested).ok, true);

  const audit = await request(app.url, '/v1/admin/audit', {
    headers: { Cookie: auth.cookie },
  });
  const entries = audit.json as Array<Record<string, unknown>>;
  const updateEntry = entries.find((entry) => entry.action === 'source.update');
  assert.ok(updateEntry, 'source.update must be audited');
  const detail = updateEntry.detail as Record<string, unknown>;
  assert.deepEqual(detail.fields, ['name', 'connection']);
  assert.equal(detail.name, 'audited');
  assert.equal(detail.dialect, 'sqlite');
  assert.equal(audit.text.includes('audit-secret'), false);
  assert.equal(audit.text.includes(file), false);

  const actions = entries.map((entry) => entry.action);
  assert.equal(actions.includes('source.test'), true);

  const verification = await request(app.url, '/v1/admin/audit/verify', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(bodyOf(verification).valid, true);
});
