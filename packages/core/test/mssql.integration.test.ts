import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ExecutorError,
  executeQuery,
  shutdownSharedExecutor,
  type ExecutorSourceConfig,
} from '../src/executor/index.js';
import { bearer, cookieAuth, request, setupAndUnlock, startTestGateway } from './helpers.js';

const CRED_KEYS = [
  'SAG_TEST_MSSQL_SERVER',
  'SAG_TEST_MSSQL_PORT',
  'SAG_TEST_MSSQL_USER',
  'SAG_TEST_MSSQL_PASSWORD',
  'SAG_TEST_MSSQL_DATABASE',
] as const;

type Creds = Record<(typeof CRED_KEYS)[number], string>;

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) values[key] = value;
  }
  return values;
}

/**
 * Credentials come from SAG_TEST_MSSQL_* or the gitignored
 * `.work/dev/creds.env`. They are never printed, logged or written anywhere.
 */
function loadCredentials(): Creds | null {
  const fromEnv: Record<string, string> = {};
  for (const key of CRED_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) fromEnv[key] = value;
  }
  if (fromEnv.SAG_TEST_MSSQL_SERVER && fromEnv.SAG_TEST_MSSQL_USER) {
    return fromEnv as Creds;
  }

  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, '.work', 'dev', 'creds.env');
    if (existsSync(candidate)) {
      const parsed = parseEnvFile(readFileSync(candidate, 'utf8'));
      if (parsed.SAG_TEST_MSSQL_SERVER && parsed.SAG_TEST_MSSQL_USER) {
        return parsed as Creds;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

const credentials = loadCredentials();
const skipReason = credentials === null ? 'mssql credentials are not available' : false;

function sourceConfig(creds: Creds): ExecutorSourceConfig {
  return {
    id: 'mssql-integration',
    dialect: 'mssql',
    connection: {
      host: creds.SAG_TEST_MSSQL_SERVER,
      port: Number(creds.SAG_TEST_MSSQL_PORT || 1433),
      database: creds.SAG_TEST_MSSQL_DATABASE,
      username: creds.SAG_TEST_MSSQL_USER,
      password: creds.SAG_TEST_MSSQL_PASSWORD,
      trustServerCertificate: true,
    },
  };
}

test('mssql connector: connect, SELECT 1, row limit, cancel then pool reuse', { skip: skipReason }, async (t) => {
  const creds = credentials as Creds;
  const source = sourceConfig(creds);
  t.after(async () => {
    await shutdownSharedExecutor();
  });

  const one = await executeQuery(source, 'SELECT 1 AS one', null, {
    maxRows: 10,
    timeoutMs: 15_000,
  });
  assert.equal(one.truncated, false);
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0]?.[0], 1);
  assert.equal(one.columns[0]?.name, 'one');

  // max_rows + 1 rows are read, then request.cancel() is issued (POC-3).
  const limited = await executeQuery(
    source,
    'SELECT @@SPID AS spid, n FROM (VALUES (1),(2),(3),(4),(5)) AS v(n)',
    null,
    { maxRows: 2, timeoutMs: 15_000 },
  );
  assert.equal(limited.truncated, true);
  assert.equal(limited.rows.length, 2);
  const spid = limited.rows[0]?.[0];
  assert.ok(spid !== undefined && spid !== null);

  // POC-3: after cancel the pooled connection is reusable (same SPID).
  const again = await executeQuery(source, 'SELECT @@SPID AS spid', null, {
    maxRows: 10,
    timeoutMs: 15_000,
  });
  assert.equal(again.rows[0]?.[0], spid, 'the pool must reuse the same connection after cancel');

  // Named parameters are bound with request.input.
  const parameterised = await executeQuery(source, 'SELECT @value AS value', { value: 42 }, {
    maxRows: 10,
    timeoutMs: 15_000,
  });
  assert.equal(parameterised.rows[0]?.[0], 42);

  // requestTimeout is the driver-level deadline; a timeout fails with
  // QUERY_TIMEOUT and leaves the pool usable.
  await assert.rejects(
    () => executeQuery(source, "WAITFOR DELAY '00:00:05'", null, { maxRows: 10, timeoutMs: 1000 }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorError);
      assert.equal(error.code, 'QUERY_TIMEOUT');
      return true;
    },
  );
  const afterTimeout = await executeQuery(source, 'SELECT 1 AS one', null, {
    maxRows: 10,
    timeoutMs: 15_000,
  });
  assert.equal(afterTimeout.rows[0]?.[0], 1);
});

test('mssql source test probe reports connection and read-only status', { skip: skipReason }, async (t) => {
  const creds = credentials as Creds;
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const created = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: 'mssql-probe',
      dialect: 'mssql',
      connection: sourceConfig(creds).connection,
    },
  });
  assert.equal(created.status, 201, created.text);
  const sourceId = String((created.json as Record<string, unknown>).id);

  const tested = await request(app.url, `/v1/admin/sources/${sourceId}/test`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(tested.status, 200, tested.text);
  const body = (tested.json ?? {}) as Record<string, unknown>;
  assert.equal(body.ok, true, tested.text);
  assert.equal(typeof body.latency_ms, 'number');
  const readonly = body.readonly as Record<string, unknown>;
  assert.equal(typeof readonly.ok, 'boolean');
  assert.equal(readonly.checked, true);
  assert.ok(Array.isArray(readonly.details));
  assert.equal(tested.text.includes(String(creds.SAG_TEST_MSSQL_PASSWORD)), false);
  assert.equal(tested.text.includes(String(creds.SAG_TEST_MSSQL_SERVER)), false);

  // A probe never deletes the source.
  const sources = await request(app.url, '/v1/admin/sources', {
    headers: bearer(auth.sessionToken),
  });
  assert.equal(sources.status, 200, sources.text);
  assert.equal(
    (sources.json as Array<Record<string, unknown>>).some((entry) => entry.id === sourceId),
    true,
  );
});

test('mssql strict mode rejects a writable credential at approval until disabled', { skip: skipReason }, async (t) => {
  const creds = credentials as Creds;
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const created = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: 'mssql-strict',
      dialect: 'mssql',
      connection: sourceConfig(creds).connection,
    },
  });
  assert.equal(created.status, 201, created.text);
  const sourceId = String((created.json as Record<string, unknown>).id);

  // The test endpoint persists the verdict; the probe identifies sysadmin/INSERT.
  const tested = await request(app.url, `/v1/admin/sources/${sourceId}/test`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(tested.status, 200, tested.text);
  const probeBody = (tested.json ?? {}) as Record<string, unknown>;
  assert.equal(probeBody.ok, true, tested.text);
  const readonly = probeBody.readonly as Record<string, unknown>;
  assert.equal(readonly.ok, false);
  assert.equal(readonly.checked, true);
  const details = (readonly.details as string[]).join(' | ');
  assert.match(details, /sysadmin/);
  assert.match(details, /INSERT/);
  assert.equal(tested.text.includes(String(creds.SAG_TEST_MSSQL_PASSWORD)), false);

  const cached = app.gateway.store.getSourceProbe(sourceId);
  assert.ok(cached);
  assert.equal(cached!.readonly_ok, 0);
  assert.ok(cached!.readonly_checked_at);
  assert.equal(cached!.readonly_details?.includes('sysadmin'), true);

  // A legal SELECT is still rejected at approval: no execution, no result.
  const submitted = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT 1 AS ok',
      purpose: 'mssql strict mode',
      max_rows: 10,
    },
  });
  assert.equal(submitted.status, 201, submitted.text);
  const proposalId = String((submitted.json as Record<string, unknown>).id);

  const approved = await request(app.url, `/v1/admin/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(approved.status, 200, approved.text);
  const approvedBody = (approved.json ?? {}) as Record<string, unknown>;
  assert.equal(approvedBody.status, 'FAILED');
  assert.equal(approvedBody.error_code, 'SOURCE_NOT_READONLY');
  assert.equal(approvedBody.result, null);
  assert.equal(app.gateway.store.getResultMeta(proposalId), null);

  const rows = await request(app.url, `/v1/agent/proposals/${proposalId}/rows`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(rows.status, 409, rows.text);

  // Write statements are rejected by the SQL policy before any probe matters.
  const write = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sourceId, sql: 'DELETE FROM work_orders' },
  });
  assert.equal(write.status, 400, write.text);
  const writeCode = String(((write.json ?? {}) as Record<string, unknown>).code);
  assert.ok(
    writeCode === 'FORBIDDEN_STATEMENT' || writeCode === 'NOT_SELECT',
    `unexpected policy code ${writeCode}`,
  );

  // With strict mode off the same credential executes a plain SELECT.
  const relaxed = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    headers: bearer(auth.sessionToken),
    body: { 'security.require_readonly_source': false },
  });
  assert.equal(relaxed.status, 200, relaxed.text);

  const allowed = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sourceId, sql: 'SELECT 1 AS ok', max_rows: 10 },
  });
  assert.equal(allowed.status, 201, allowed.text);
  const allowedId = String((allowed.json as Record<string, unknown>).id);
  const allowedApproval = await request(app.url, '/v1/admin/proposals/' + allowedId + '/approve', {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(allowedApproval.status, 200, allowedApproval.text);
  const allowedBody = (allowedApproval.json ?? {}) as Record<string, unknown>;
  assert.equal(allowedBody.status, 'SUCCEEDED');
  assert.equal((allowedBody.result as Record<string, unknown>).total_rows, 1);

  const allowedRows = await request(app.url, `/v1/agent/proposals/${allowedId}/rows`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(allowedRows.status, 200, allowedRows.text);
  assert.deepEqual(
    ((allowedRows.json ?? {}) as Record<string, unknown>).rows,
    [[1]],
  );
  assert.equal(allowedRows.text.includes(String(creds.SAG_TEST_MSSQL_PASSWORD)), false);
});

test('mssql end-to-end: submit → approve → execute → rows', { skip: skipReason }, async (t) => {
  const creds = credentials as Creds;
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const created = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: 'mssql-integration',
      dialect: 'mssql',
      connection: sourceConfig(creds).connection,
    },
  });
  assert.equal(created.status, 201, created.text);
  const sourceId = String((created.json as Record<string, unknown>).id);

  // The integration login is `sa`, so the probe correctly reports a writable
  // source. This test covers submit → approve → execute → rows, therefore the
  // strict read-only guard is disabled explicitly; the dedicated strict-mode
  // test below proves the rejection path with the same credentials.
  const relaxed = await request(app.url, '/v1/admin/settings', {
    method: 'PUT',
    headers: bearer(auth.sessionToken),
    body: { 'security.require_readonly_source': false },
  });
  assert.equal(relaxed.status, 200, relaxed.text);

  const submitted = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT 1 AS one',
      purpose: 'mssql integration',
      max_rows: 10,
    },
  });
  assert.equal(submitted.status, 201, submitted.text);
  const proposalId = String((submitted.json as Record<string, unknown>).id);

  const approved = await request(app.url, `/v1/admin/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(approved.status, 200, approved.text);
  const body = (approved.json ?? {}) as Record<string, unknown>;
  assert.equal(body.status, 'SUCCEEDED');
  const result = body.result as Record<string, unknown>;
  assert.equal(result.total_rows, 1);
  assert.equal(result.truncated, false);

  const rows = await request(app.url, `/v1/agent/proposals/${proposalId}/rows?page=1&page_size=10`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(rows.status, 200, rows.text);
  const rowsBody = (rows.json ?? {}) as Record<string, unknown>;
  assert.deepEqual(rowsBody.rows, [[1]]);
  assert.equal(rowsBody.total_rows, 1);

  // The connection secret must never be echoed back to any client.
  assert.equal(rows.text.includes(String(creds.SAG_TEST_MSSQL_PASSWORD)), false);
  assert.equal(approved.text.includes(String(creds.SAG_TEST_MSSQL_PASSWORD)), false);
});
