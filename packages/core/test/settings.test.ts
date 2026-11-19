import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_SETTINGS,
  SETTINGS_RANGES,
  type SettingsValues,
} from '@sql-approval/shared';

import { readSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import {
  addTestSource,
  bearer,
  cookieAuth,
  request,
  setupAndUnlock,
  startTestGateway,
  uniquePassword,
  type Authenticated,
  type TestApp,
} from './helpers.js';
import { randomToken } from '../src/util.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
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

async function getSettings(
  app: TestApp,
  auth: Authenticated,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await request(app.url, '/v1/admin/settings', {
    headers: { Cookie: auth.cookie },
  });
  return { status: response.status, body: bodyOf(response), text: response.text };
}

async function submitWithoutBounds(
  app: TestApp,
  auth: Authenticated,
  sourceId: string,
): Promise<Record<string, unknown>> {
  const response = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT 1 AS one',
      purpose: 'settings test',
    },
  });
  assert.equal(response.status, 201, response.text);
  return bodyOf(response);
}

function settingsOf(body: Record<string, unknown>): SettingsValues {
  return body.settings as SettingsValues;
}

test('GET settings returns persisted defaults plus ranges for the UI', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const response = await getSettings(app, auth);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(settingsOf(response.body), DEFAULT_SETTINGS);
  assert.deepEqual(response.body.defaults, DEFAULT_SETTINGS);
  assert.deepEqual(response.body.ranges, SETTINGS_RANGES);
  assert.deepEqual(response.body.ranges, {
    'session.idle_minutes': { type: 'integer', min: 1, max: 1440 },
    'session.absolute_hours': { type: 'integer', min: 1, max: 24 },
    'proposal.default_max_rows': { type: 'integer', min: 1, max: 5000 },
    'proposal.max_max_rows': { type: 'integer', min: 100, max: 5000 },
    'proposal.default_timeout_s': { type: 'integer', min: 1, max: 120 },
    'proposal.max_timeout_s': { type: 'integer', min: 1, max: 120 },
    'proposal.approval_window_hours': { type: 'integer', min: 1, max: 168 },
    'result.ttl_hours': { type: 'integer', min: 1, max: 168 },
    'ui.show_countdown': { type: 'boolean' },
    'security.require_readonly_source': { type: 'boolean' },
    'security.allow_system_catalog': { type: 'boolean' },
  });
  // Every default is already materialized as a JSON row in `settings`.
  assert.equal(app.gateway.store.getSetting('session.idle_minutes'), '10');
  assert.equal(app.gateway.store.getSetting('ui.show_countdown'), 'true');
});

test('PUT applies a partial update, returns it and persists it', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const updated = await putSettings(app, auth, {
    'session.idle_minutes': 25,
    'ui.show_countdown': false,
  });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(settingsOf(updated.body), {
    ...DEFAULT_SETTINGS,
    'session.idle_minutes': 25,
    'ui.show_countdown': false,
  });
  assert.equal(app.gateway.store.getSetting('session.idle_minutes'), '25');
  assert.equal(app.gateway.store.getSetting('ui.show_countdown'), 'false');

  const reread = await getSettings(app, auth);
  assert.equal(reread.status, 200, reread.text);
  assert.equal(settingsOf(reread.body)['session.idle_minutes'], 25);
  assert.equal(settingsOf(reread.body)['ui.show_countdown'], false);
  // Untouched keys keep their previous values.
  assert.equal(settingsOf(reread.body)['proposal.default_max_rows'], 500);
});

test('settings survive a store reopen and are re-seeded only when absent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sag-settings-test-'));
  const file = join(dir, 'control.db');

  const first = openStore(file);
  try {
    first.updateSettings({ 'result.ttl_hours': '7' }, 'admin');
  } finally {
    first.close();
  }

  const second = openStore(file);
  t.after(() => {
    try {
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  assert.equal(readSettings(second)['result.ttl_hours'], 7);
  assert.equal(readSettings(second)['session.idle_minutes'], 10);
});

test('a user_version 1 database migrates to 3 and seeds only missing settings', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sag-settings-upgrade-'));
  const file = join(dir, 'control.db');
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
        "INSERT INTO settings(key, value) VALUES ('result.ttl_hours', '7');" +
        'PRAGMA user_version = 1;',
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
  const settings = readSettings(store);
  assert.equal(settings['result.ttl_hours'], 7, 'an existing custom value is preserved');
  assert.equal(settings['session.idle_minutes'], 10, 'missing defaults are seeded');
});

test('unknown keys, wrong types and out-of-range values are rejected with 400', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const rejected: Array<Record<string, unknown>> = [
    { 'unknown.key': 1 },
    { 'session.idle_minutes': 0 },
    { 'session.idle_minutes': 1441 },
    { 'session.idle_minutes': '10' },
    { 'session.idle_minutes': 1.5 },
    { 'ui.show_countdown': 'true' },
    { 'proposal.max_max_rows': 99 },
    { 'proposal.approval_window_hours': 169 },
  ];
  for (const patch of rejected) {
    const response = await putSettings(app, auth, patch);
    assert.equal(response.status, 400, `${JSON.stringify(patch)}: ${response.text}`);
    assert.equal(response.body.code, 'INVALID_REQUEST');
  }

  const unchanged = await getSettings(app, auth);
  assert.deepEqual(settingsOf(unchanged.body), DEFAULT_SETTINGS);
});

test('settings endpoints return 423 while the vault is locked', async (t) => {
  const app = await startTestGateway(t);
  const password = uniquePassword();
  const setup = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });
  assert.equal(setup.status, 200, setup.text);

  const getLocked = await request(app.url, '/v1/admin/settings');
  assert.equal(getLocked.status, 423, getLocked.text);
  assert.equal(bodyOf(getLocked).code, 'NOT_UNLOCKED');

  const putLocked = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    body: { 'session.idle_minutes': 5 },
  });
  assert.equal(putLocked.status, 423, putLocked.text);
  assert.equal(bodyOf(putLocked).code, 'NOT_UNLOCKED');
});

test('a cookie-authenticated PUT without CSRF is rejected', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const response = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    headers: { Cookie: auth.cookie },
    body: { 'session.idle_minutes': 5 },
  });
  assert.equal(response.status, 403, response.text);
  assert.equal(bodyOf(response).code, 'CSRF_REJECTED');
  assert.equal(app.gateway.store.getSetting('session.idle_minutes'), '10');
});

test('idle_minutes applies immediately: 1 minute expires, 1440 minutes survives', async (t) => {
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const app = await startTestGateway(t, { clock: () => now });
  const auth = await setupAndUnlock(app);

  const shortened = await putSettings(app, auth, { 'session.idle_minutes': 1 });
  assert.equal(shortened.status, 200, shortened.text);

  now += MINUTE_MS + 1;
  const expired = await request(app.url, '/v1/admin/proposals', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(expired.status, 401, expired.text);
  assert.equal(bodyOf(expired).code, 'UNAUTHENTICATED');
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, false);

  // Re-unlock (idle is still 1 minute) and widen it for the *existing* session.
  const unlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password: auth.password },
  });
  assert.equal(unlock.status, 200, unlock.text);
  const cookie = String(unlock.headers['set-cookie']).split(';', 1)[0]!;
  const csrf = String(bodyOf(unlock).csrfToken);
  const widened = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    headers: cookieAuth(cookie, csrf),
    body: { 'session.idle_minutes': 1440 },
  });
  assert.equal(widened.status, 200, widened.text);

  now += MINUTE_MS + 1;
  const alive = await request(app.url, '/v1/admin/proposals', {
    headers: { Cookie: cookie },
  });
  assert.equal(alive.status, 200, alive.text);
});

test('submitting without max_rows/timeout_s uses the configured defaults', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);

  const updated = await putSettings(app, auth, {
    'proposal.default_max_rows': 42,
    'proposal.default_timeout_s': 7,
  });
  assert.equal(updated.status, 200, updated.text);

  const created = await submitWithoutBounds(app, auth, source.id);
  const proposal = await request(app.url, `/v1/agent/proposals/${String(created.id)}`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(proposal.status, 200, proposal.text);
  assert.equal(bodyOf(proposal).max_rows, 42);
  assert.equal(bodyOf(proposal).timeout_s, 7);
});

test('max_max_rows and max_timeout_s reject oversized submissions with 400', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);
  const updated = await putSettings(app, auth, {
    'proposal.max_max_rows': 100,
    'proposal.max_timeout_s': 10,
  });
  assert.equal(updated.status, 200, updated.text);

  const tooManyRows = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: source.id, sql: 'SELECT 1 AS one', max_rows: 101 },
  });
  assert.equal(tooManyRows.status, 400, tooManyRows.text);
  assert.equal(bodyOf(tooManyRows).code, 'INVALID_REQUEST');

  const tooLong = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: source.id, sql: 'SELECT 1 AS one', timeout_s: 11 },
  });
  assert.equal(tooLong.status, 400, tooLong.text);
  assert.equal(bodyOf(tooLong).code, 'INVALID_REQUEST');

  // Exactly at the configured ceiling is still accepted.
  const boundary = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: source.id,
      sql: 'SELECT 1 AS one',
      max_rows: 100,
      timeout_s: 10,
    },
  });
  assert.equal(boundary.status, 201, boundary.text);
});

test('approval_window_hours drives new expires_at values only', async (t) => {
  let now = Date.parse('2026-09-01T00:00:00.000Z');
  const app = await startTestGateway(t, { clock: () => now });
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);

  assert.equal(
    (await putSettings(app, auth, { 'proposal.approval_window_hours': 2 })).status,
    200,
  );
  const first = await submitWithoutBounds(app, auth, source.id);
  const firstProposal = app.gateway.store.getProposal(String(first.id))!;
  assert.equal(
    Date.parse(firstProposal.expires_at) - Date.parse(firstProposal.created_at),
    2 * HOUR_MS,
  );

  now += 1000;
  assert.equal(
    (await putSettings(app, auth, { 'proposal.approval_window_hours': 5 })).status,
    200,
  );
  const second = await submitWithoutBounds(app, auth, source.id);
  const secondProposal = app.gateway.store.getProposal(String(second.id))!;
  assert.equal(
    Date.parse(secondProposal.expires_at) - Date.parse(secondProposal.created_at),
    5 * HOUR_MS,
  );

  // The already-created proposal keeps its original window.
  const unchanged = app.gateway.store.getProposal(firstProposal.id)!;
  assert.equal(unchanged.expires_at, firstProposal.expires_at);
});

test('result.ttl_hours determines expires_at at execution completion', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const file = join(app.dir, 'ttl-settings.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare('INSERT INTO items (id, name) VALUES (1, ?)').run('only');
  } finally {
    db.close();
  }
  const added = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: { name: `ttl-source-${randomToken(4)}`, dialect: 'sqlite', connection: { file } },
  });
  assert.equal(added.status, 201, added.text);
  const sourceId = String(bodyOf(added).id);

  assert.equal((await putSettings(app, auth, { 'result.ttl_hours': 3 })).status, 200);
  const created = await submitWithoutBounds(app, auth, sourceId);
  const approved = await request(
    app.url,
    `/v1/admin/proposals/${String(created.id)}/approve`,
    { method: 'POST', headers: bearer(auth.sessionToken) },
  );
  assert.equal(approved.status, 200, approved.text);
  assert.equal(bodyOf(approved).status, 'SUCCEEDED');

  const meta = app.gateway.store.getResultMeta(String(created.id))!;
  assert.equal(Date.parse(meta.expires_at) - Date.parse(meta.executed_at), 3 * HOUR_MS);
});

test('settings.update audit records changed key names only and keeps the chain valid', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);

  const updated = await putSettings(app, auth, {
    'session.idle_minutes': 11,
    'ui.show_countdown': false,
  });
  assert.equal(updated.status, 200, updated.text);

  const audits = app.gateway.store.listAudit(0, 1000);
  const entry = audits.find((item) => item.action === 'settings.update');
  assert.ok(entry, 'settings.update audit entry is missing');
  const detail = JSON.parse(entry!.detail_json) as Record<string, unknown>;
  assert.deepEqual(detail, { keys: ['session.idle_minutes', 'ui.show_countdown'] });
  assert.equal(entry!.detail_json.includes('11'), false);
  assert.equal(entry!.detail_json.includes('false'), false);
  assert.equal(entry!.proposal_id, null);
  assert.equal(entry!.actor, 'admin');

  const verification = await request(app.url, '/v1/admin/audit/verify', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(verification.status, 200, verification.text);
  assert.equal(bodyOf(verification).valid, true);
});
