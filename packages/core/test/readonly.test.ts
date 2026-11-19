import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  PROBE_CACHE_TTL_MS,
  type SourceDialect,
  type SourceTestResult,
} from '@sql-approval/shared';

import { parseReadonlyDetails, readCachedReadonly } from '../src/readonly.js';
import { readSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import { randomToken } from '../src/util.js';
import {
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

function sqliteFixture(dir: string, name = 'readonly.db'): string {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT)');
  } finally {
    db.close();
  }
  return file;
}

interface ProbeStub {
  calls: Array<{ dialect: SourceDialect; connection: Record<string, unknown> }>;
  probe: (dialect: SourceDialect, connection: Record<string, unknown>) => Promise<SourceTestResult>;
  set(next: () => SourceTestResult): void;
}

function probeResult(readonly: SourceTestResult['readonly']): SourceTestResult {
  return { ok: true, latency_ms: 1, readonly };
}

function probeStub(initial: () => SourceTestResult): ProbeStub {
  let next = initial;
  const calls: ProbeStub['calls'] = [];
  return {
    calls,
    set(value) {
      next = value;
    },
    async probe(dialect, connection) {
      calls.push({ dialect, connection });
      return next();
    },
  };
}

async function createSqliteSource(
  app: TestApp,
  auth: Authenticated,
  file: string,
): Promise<string> {
  const created = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: `readonly-${randomToken(6)}`,
      dialect: 'sqlite',
      connection: { file },
    },
  });
  assert.equal(created.status, 201, created.text);
  return String(bodyOf(created).id);
}

async function testSource(
  app: TestApp,
  auth: Authenticated,
  sourceId: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, `/v1/admin/sources/${sourceId}/test`, {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

async function submit(
  app: TestApp,
  auth: Authenticated,
  sourceId: string,
  sql: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sourceId, sql, purpose: 'readonly guard test' },
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
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
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, `/v1/agent/proposals/${proposalId}/rows`, {
    headers: bearer(auth.agentToken),
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

async function putSettings(
  app: TestApp,
  auth: Authenticated,
  patch: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: patch,
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

function failingProposalAudit(app: TestApp, proposalId: string): Record<string, unknown> {
  const entry = app.gateway.store
    .listAudit(0, 1000)
    .find((item) => item.action === 'proposal.failed' && item.proposal_id === proposalId);
  assert.ok(entry, `proposal.failed audit entry is missing for ${proposalId}`);
  return JSON.parse(entry!.detail_json) as Record<string, unknown>;
}

test('security.require_readonly_source defaults to true and is a boolean setting', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const initial = await request(app.url, '/v1/admin/settings', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(initial.status, 200, initial.text);
  const settings = bodyOf(initial).settings as Record<string, unknown>;
  assert.equal(settings['security.require_readonly_source'], true);
  const ranges = bodyOf(initial).ranges as Record<string, unknown>;
  assert.deepEqual(ranges['security.require_readonly_source'], { type: 'boolean' });
  assert.equal(app.gateway.store.getSetting('security.require_readonly_source'), 'true');

  const disabled = await putSettings(app, auth, {
    'security.require_readonly_source': false,
  });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(
    (disabled.body.settings as Record<string, unknown>)['security.require_readonly_source'],
    false,
  );
  assert.equal(app.gateway.store.getSetting('security.require_readonly_source'), 'false');

  const invalid = await putSettings(app, auth, {
    'security.require_readonly_source': 'false',
  });
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.body.code, 'INVALID_REQUEST');

  const enabled = await putSettings(app, auth, {
    'security.require_readonly_source': true,
  });
  assert.equal(enabled.status, 200, enabled.text);
});

test('security.allow_system_catalog defaults to false and is a boolean setting', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const initial = await request(app.url, '/v1/admin/settings', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(initial.status, 200, initial.text);
  const settings = bodyOf(initial).settings as Record<string, unknown>;
  assert.equal(settings['security.allow_system_catalog'], false);
  const ranges = bodyOf(initial).ranges as Record<string, unknown>;
  assert.deepEqual(ranges['security.allow_system_catalog'], { type: 'boolean' });

  const enabled = await putSettings(app, auth, {
    'security.allow_system_catalog': true,
  });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(
    (enabled.body.settings as Record<string, unknown>)['security.allow_system_catalog'],
    true,
  );
  assert.equal(app.gateway.store.getSetting('security.allow_system_catalog'), 'true');

  const invalid = await putSettings(app, auth, {
    'security.allow_system_catalog': 'yes',
  });
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.body.code, 'INVALID_REQUEST');
});

test('strict mode rejects a writable source with SOURCE_NOT_READONLY and stores no result', async (t) => {
  const writable = probeStub(() =>
    probeResult({
      ok: false,
      checked: true,
      details: ['命中 sysadmin 服务器角色', '命中当前数据库 INSERT 权限'],
    }),
  );
  const app = await startTestGateway(t, { probeSource: writable.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  assert.equal(created.status, 201, created.text);
  const proposalId = String(created.body.id);

  const approved = await approve(app, auth, proposalId);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'FAILED');
  assert.equal(approved.body.error_code, 'SOURCE_NOT_READONLY');
  assert.equal(approved.body.result, null);
  assert.equal(writable.calls.length, 1, 'the writable verdict requires one live probe');

  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'source_not_readonly');
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);
  assert.equal(app.gateway.store.getResultRows(proposalId, 0, 10).length, 0);

  const rows = await agentRows(app, auth, proposalId);
  assert.equal(rows.status, 409, rows.text);
  assert.equal(rows.body.code, 'INVALID_STATE');

  const detail = failingProposalAudit(app, proposalId);
  assert.equal(detail.reason, 'source_not_readonly');
});

test('a failed probe fails the proposal with SOURCE_PROBE_FAILED and clears the cache', async (t) => {
  const failing = probeStub(() => ({
    ok: false,
    latency_ms: 1,
    readonly: { ok: false, checked: false, details: ['连接或查询失败'] },
    error_code: 'QUERY_FAILED',
  }));
  const app = await startTestGateway(t, { probeSource: failing.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const proposalId = String(created.body.id);
  const approved = await approve(app, auth, proposalId);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'FAILED');
  assert.equal(approved.body.error_code, 'SOURCE_PROBE_FAILED');
  assert.equal(approved.body.result, null);
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);

  const probe = app.gateway.store.getSourceProbe(sourceId);
  assert.ok(probe);
  assert.equal(probe!.readonly_ok, null);
  assert.equal(probe!.readonly_checked_at, null);
  assert.equal(probe!.readonly_details, null);

  const detail = failingProposalAudit(app, proposalId);
  assert.equal(detail.reason, 'source_probe_failed');
  assert.equal(detail.probe_error_code, 'QUERY_FAILED');
});

test('the test endpoint persists the probe cache and approval reuses it within ten minutes', async (t) => {
  const readable = probeStub(() =>
    probeResult({ ok: true, checked: true, details: ['以 readOnly 模式打开成功'] }),
  );
  const app = await startTestGateway(t, { probeSource: readable.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  const tested = await testSource(app, auth, sourceId);
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.body.ok, true);
  assert.equal(readable.calls.length, 1);

  const cached = app.gateway.store.getSourceProbe(sourceId);
  assert.ok(cached);
  assert.equal(cached!.readonly_ok, 1);
  assert.ok(cached!.readonly_checked_at);
  assert.deepEqual(parseReadonlyDetails(cached!.readonly_details), [
    '以 readOnly 模式打开成功',
  ]);

  const audits = app.gateway.store.listAudit(0, 1000);
  assert.ok(audits.some((entry) => entry.action === 'source.test'));

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.body.status, 'SUCCEEDED', approved.text);
  assert.equal(readable.calls.length, 1, 'a fresh cache must not be probed again');
  assert.equal((approved.body.result as Record<string, unknown>).total_rows, 1);
});

test('a missing probe cache triggers a live probe before execution', async (t) => {
  const readable = probeStub(() =>
    probeResult({ ok: true, checked: true, details: ['stub probe'] }),
  );
  const app = await startTestGateway(t, { probeSource: readable.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));
  assert.equal(app.gateway.store.getSourceProbe(sourceId)?.readonly_checked_at, null);

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.body.status, 'SUCCEEDED', approved.text);
  assert.equal(readable.calls.length, 1, 'a missing cache must be filled on approval');
  const cached = app.gateway.store.getSourceProbe(sourceId);
  assert.equal(cached!.readonly_ok, 1);
  assert.ok(cached!.readonly_checked_at);
});

test('a cache older than ten minutes is refreshed before execution', async (t) => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const readable = probeStub(() =>
    probeResult({ ok: true, checked: true, details: ['stub probe'] }),
  );
  const app = await startTestGateway(t, {
    clock: () => now,
    sessionIdleMs: 24 * 60 * 60 * 1000,
    probeSource: readable.probe,
  });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  // Session bounds are settings-backed; widen the idle window so advancing the
  // clock past the probe TTL does not expire the admin session.
  assert.equal(
    (await putSettings(app, auth, { 'session.idle_minutes': 60 })).status,
    200,
  );
  assert.equal((await testSource(app, auth, sourceId)).body.ok, true);
  assert.equal(readable.calls.length, 1);

  now += PROBE_CACHE_TTL_MS + 1;
  readable.set(() =>
    probeResult({ ok: false, checked: true, details: ['命中 sysadmin 服务器角色'] }),
  );
  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.body.status, 'FAILED', approved.text);
  assert.equal(approved.body.error_code, 'SOURCE_NOT_READONLY');
  assert.equal(readable.calls.length, 2, 'a stale cache must be refreshed');

  const cached = app.gateway.store.getSourceProbe(sourceId);
  assert.equal(cached!.readonly_ok, 0);
  assert.equal(cached!.readonly_checked_at, new Date(now).toISOString());
});

test('a fresh negative cache rejects repeated approvals without probing again', async (t) => {
  const writable = probeStub(() =>
    probeResult({ ok: false, checked: true, details: ['命中当前数据库 INSERT 权限'] }),
  );
  const app = await startTestGateway(t, { probeSource: writable.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  assert.equal((await testSource(app, auth, sourceId)).body.ok, true);
  assert.equal(app.gateway.store.getSourceProbe(sourceId)?.readonly_ok, 0);

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.body.error_code, 'SOURCE_NOT_READONLY');
  assert.equal(writable.calls.length, 1, 'the persisted negative verdict is reused');
});

test('disabling strict mode skips the probe and executes normally', async (t) => {
  const writable = probeStub(() =>
    probeResult({ ok: false, checked: true, details: ['命中 sysadmin 服务器角色'] }),
  );
  const app = await startTestGateway(t, { probeSource: writable.probe });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  const relaxed = await putSettings(app, auth, {
    'security.require_readonly_source': false,
  });
  assert.equal(relaxed.status, 200, relaxed.text);

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'SUCCEEDED');
  assert.equal((approved.body.result as Record<string, unknown>).total_rows, 1);
  assert.equal(writable.calls.length, 0, 'strict mode off must not probe');
  assert.equal(app.gateway.store.getSourceProbe(sourceId)?.readonly_checked_at, null);
});

test('a real sqlite read-only source passes strict mode and is cached', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSqliteSource(app, auth, sqliteFixture(app.dir));

  const tested = await testSource(app, auth, sourceId);
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.body.ok, true);
  const readonly = tested.body.readonly as Record<string, unknown>;
  assert.equal(readonly.ok, true);
  assert.equal(readonly.checked, true);
  assert.ok(Array.isArray(readonly.details));

  const cached = app.gateway.store.getSourceProbe(sourceId);
  assert.equal(cached!.readonly_ok, 1);

  const created = await submit(app, auth, sourceId, 'SELECT 1 AS one');
  const approved = await approve(app, auth, String(created.body.id));
  assert.equal(approved.body.status, 'SUCCEEDED', approved.text);
});

test('probe cache freshness rules re-probe for missing, stale and malformed records', () => {
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
  const record = {
    readonly_ok: 1,
    readonly_checked_at: at(0),
    readonly_details: '["detail-a"]',
  };

  const fresh = readCachedReadonly(record, base + 1000);
  assert.ok(fresh);
  assert.equal(fresh!.readonly.ok, true);
  assert.deepEqual(fresh!.readonly.details, ['detail-a']);

  assert.equal(readCachedReadonly(null, base), null);
  assert.equal(
    readCachedReadonly({ ...record, readonly_checked_at: null }, base),
    null,
  );
  assert.equal(readCachedReadonly({ ...record, readonly_ok: null }, base), null);
  assert.equal(
    readCachedReadonly({ ...record, readonly_checked_at: 'not-a-date' }, base),
    null,
  );
  // Older than the TTL is stale; a future timestamp is treated as stale too.
  assert.equal(readCachedReadonly(record, base + PROBE_CACHE_TTL_MS + 1), null);
  assert.equal(readCachedReadonly(record, base - 1), null);
  assert.equal(
    readCachedReadonly({ ...record, readonly_ok: 0 }, base)!.readonly.ok,
    false,
  );

  assert.deepEqual(parseReadonlyDetails(null), []);
  assert.deepEqual(parseReadonlyDetails('not json'), []);
  assert.deepEqual(parseReadonlyDetails('{"a":1}'), []);
  assert.deepEqual(parseReadonlyDetails('["ok", 3]'), ['ok']);
});

test('a schema v2 database migrates to v3 and gains NULL probe columns', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sag-readonly-migrate-'));
  const file = join(dir, 'control.db');
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(
      `CREATE TABLE sources (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         dialect TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO sources (id, name, dialect, created_at, updated_at)
         VALUES ('legacy-source', 'legacy', 'sqlite',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO settings (key, value) VALUES ('ui.show_countdown', 'false');
       PRAGMA user_version = 2;`,
    );
  } finally {
    legacy.close();
  }

  const store = openStore(file);
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const version = store.db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, 3);
  const columns = (
    store.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const column of ['readonly_ok', 'readonly_checked_at', 'readonly_details']) {
    assert.ok(columns.includes(column), `missing migrated column ${column}`);
  }

  assert.equal(store.getSource('legacy-source')?.name, 'legacy');
  assert.deepEqual(store.getSourceProbe('legacy-source'), {
    readonly_ok: null,
    readonly_checked_at: null,
    readonly_details: null,
  });
  const settings = readSettings(store);
  assert.equal(settings['security.require_readonly_source'], true);
  assert.equal(settings['ui.show_countdown'], false, 'an existing value is preserved');
});
