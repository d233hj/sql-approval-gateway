/**
 * Zero-dependency contract test for the DSH Host half.
 *
 *   node packages/dsh-plugin/test-host.mjs
 *
 * Starts a local mock of the gateway Agent API, then verifies that all six
 * tools forward the expected request, return structured objects, and map HTTP
 * and network failures to tool errors. Covers sql_submit_and_wait's success,
 * terminal-failure, and still-pending-after-wait paths, plus cancellation and
 * duplicate-submission refusal. No database and no real gateway needed.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  TOOL_NAMES,
  apply,
  createTools,
} from './index.js';

const TOKEN = 'sag_test_token_0123456789abcdef';
const EXPIRES_AT = '2026-11-12T13:00:00.000Z';
const requests = [];
const bodies = [];

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, payload, headers = {}) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

function errorBody(code, message, requestId = 'req-mock') {
  return { code, message, request_id: requestId };
}

function proposalRecord(overrides = {}) {
  return {
    id: 'proposal-1',
    source_id: 'src-1',
    sql: 'SELECT 1 AS n',
    params: null,
    purpose: 'unit test',
    max_rows: 10,
    timeout_s: 5,
    status: 'PENDING_APPROVAL',
    status_message: null,
    digest: 'digest-1',
    policy_version: 'sag-policy-1',
    created_at: '2026-11-12T12:00:00.000Z',
    updated_at: '2026-11-12T12:00:00.000Z',
    expires_at: EXPIRES_AT,
    request_key: 'req-1',
    result: null,
    ...overrides,
  };
}

function createMockGateway() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    let body = null;
    if (request.method === 'POST') {
      try {
        body = await readJsonBody(request);
      } catch {
        send(response, 400, errorBody('INVALID_REQUEST', 'Invalid JSON'));
        return;
      }
    }
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.authorization ?? null,
      body,
    });
    if (body !== null) bodies.push(body);

    if (url.pathname.startsWith('/v1/agent/') && request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(response, 401, errorBody('UNAUTHENTICATED', 'Authentication required', 'req-auth'));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/sources') {
      send(response, 200, [{ id: 'src-1', name: 'demo', dialect: 'sqlite' }]);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/agent/proposals') {
      if (typeof body?.sql === 'string' && /^\s*(insert|update|delete|drop|exec)\b/i.test(body.sql)) {
        send(response, 400, errorBody('NOT_SELECT', 'Only SELECT statements are allowed', 'req-policy'));
        return;
      }
      if (body?.request_key === 'dup-key') {
        send(response, 200, { id: 'proposal-dup', status: 'PENDING_APPROVAL', expires_at: EXPIRES_AT });
        return;
      }
      // sql markers route the submit-and-wait scenarios to distinct proposals.
      const marker = typeof body?.sql === 'string' ? body.sql : '';
      let proposalId = 'proposal-1';
      if (marker.includes('wait-timeout')) proposalId = 'proposal-wait-pending';
      else if (marker.includes('wait-cancel')) proposalId = 'proposal-wait-cancel';
      else if (marker.includes('wait-fail')) proposalId = 'proposal-wait-fail';
      else if (marker.includes('wait-ok')) proposalId = 'proposal-wait-ok';
      send(response, 201, { id: proposalId, status: 'PENDING_APPROVAL', expires_at: EXPIRES_AT });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/proposal-wait-ok') {
      send(
        response,
        200,
        proposalRecord({ id: 'proposal-wait-ok', status: 'SUCCEEDED', status_message: 'done' }),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/proposal-wait-fail') {
      send(
        response,
        200,
        proposalRecord({
          id: 'proposal-wait-fail',
          status: 'FAILED',
          status_message: 'query failed',
          error_code: 'QUERY_FAILED',
        }),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/v1/agent/proposals/proposal-wait-pending' ||
        url.pathname === '/v1/agent/proposals/proposal-wait-cancel')
    ) {
      send(
        response,
        200,
        proposalRecord({
          id: url.pathname.split('/').at(-1),
          status: 'PENDING_APPROVAL',
        }),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/proposal-1') {
      send(response, 200, proposalRecord());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/proposal-1/rows') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('page_size') ?? 100);
      send(response, 200, {
        columns: [{ name: 'n', type: 'integer' }],
        rows: [[1], [2]],
        page,
        page_size: pageSize,
        total_rows: 2,
        truncated: false,
        executed_at: '2026-11-12T12:01:00.000Z',
        duration_ms: 7,
        expires_at: EXPIRES_AT,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/proposal-wait-ok/rows') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('page_size') ?? 100);
      send(response, 200, {
        columns: [{ name: 'n', type: 'integer' }],
        rows: [[1]],
        page,
        page_size: pageSize,
        total_rows: 1,
        truncated: false,
        executed_at: '2026-11-12T12:02:00.000Z',
        duration_ms: 2,
        expires_at: EXPIRES_AT,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/agent/proposals/proposal-1/cancel') {
      send(response, 200, { id: 'proposal-1', status: 'CANCELLED' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/missing') {
      send(response, 404, errorBody('PROPOSAL_NOT_FOUND', 'Proposal not found', 'req-missing'));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/bad-json') {
      if (!response.writableEnded) {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain');
        response.end('not-json');
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/slow') {
      setTimeout(() => {
        if (!response.writableEnded) send(response, 200, proposalRecord({ id: 'slow' }));
      }, 400);
      return;
    }

    send(response, 404, errorBody('NOT_FOUND', 'Not found', 'req-not-found'));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function main() {
  const server = createMockGateway();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const tools = createTools({
      url: base,
      token: TOKEN,
      requestTimeoutMs: 5000,
      // Short poll interval keeps the contract test fast; the tool default is 1s.
      pollIntervalMs: 25,
    });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    assert.equal(tools.length, 6);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    assert.equal(tools.some((tool) => /approve|reject|admin/i.test(tool.name)), false);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.output.schema.type, 'object');
      assert.deepEqual(tool.output.render({}, { ok: true }), [
        { type: 'text', text: JSON.stringify({ ok: true }, null, 2) },
      ]);
    }
    assert.deepEqual(byName.sql_submit.parameters.required, ['source_id', 'sql']);
    assert.equal(byName.sql_submit.parameters.properties.source_id.type, 'string');
    assert.equal(byName.sql_submit.parameters.properties.max_rows.type, 'integer');
    assert.equal(byName.sql_submit.parameters.properties.timeout_s.type, 'integer');
    assert.equal(byName.sql_submit.parameters.properties.request_key.type, 'string');
    assert.deepEqual(byName.sql_submit_and_wait.parameters.required, ['source_id', 'sql']);
    assert.equal(byName.sql_submit_and_wait.parameters.properties.source_id.type, 'string');
    assert.equal(byName.sql_submit_and_wait.parameters.properties.sql.type, 'string');
    assert.equal(byName.sql_submit_and_wait.parameters.properties.params.type, 'object');
    assert.equal(byName.sql_submit_and_wait.parameters.properties.max_rows.type, 'integer');
    assert.equal(byName.sql_submit_and_wait.parameters.properties.timeout_s.type, 'integer');
    assert.equal(byName.sql_submit_and_wait.parameters.properties.wait_seconds.type, 'integer');
    assert.match(byName.sql_submit_and_wait.description, /不会批准/);
    assert.match(byName.sql_submit_and_wait.description, /审批台/);
    assert.match(byName.sql_submit_and_wait.description, /不会代用户批准/);
    assert.equal(byName.sql_result.parameters.properties.page_size.type, 'integer');
    pass('six tools registered with core-compatible snake_case schemas');

    const sources = await byName.sql_list_sources.execute({});
    assert.deepEqual(sources, {
      sources: [{ id: 'src-1', name: 'demo', dialect: 'sqlite' }],
    });
    assert.equal(requests.at(-1).authorization, `Bearer ${TOKEN}`);
    pass('sql_list_sources forwards GET /v1/agent/sources');

    const submitted = await byName.sql_submit.execute({
      source_id: 'src-1',
      sql: 'SELECT 1 AS n',
      purpose: 'unit test',
      max_rows: 10,
      timeout_s: 5,
      request_key: 'req-1',
    });
    assert.equal(submitted.proposal_id, 'proposal-1');
    assert.equal(submitted.status, 'PENDING_APPROVAL');
    assert.equal(submitted.expires_at, EXPIRES_AT);
    assert.deepEqual(bodies.at(-1), {
      source_id: 'src-1',
      sql: 'SELECT 1 AS n',
      purpose: 'unit test',
      max_rows: 10,
      timeout_s: 5,
      request_key: 'req-1',
    });
    pass('sql_submit forwards the snake_case proposal body');

    const duplicate = await byName.sql_submit.execute({
      source_id: 'src-1',
      sql: 'SELECT 1 AS n',
      request_key: 'dup-key',
    });
    assert.equal(duplicate.proposal_id, 'proposal-dup');
    pass('sql_submit preserves core idempotency responses');

    const waited = await byName.sql_submit_and_wait.execute({
      source_id: 'src-1',
      sql: 'SELECT 1 AS n -- wait-ok',
      purpose: 'wait success',
      max_rows: 500,
    });
    assert.deepEqual(waited, {
      proposal_id: 'proposal-wait-ok',
      status: 'SUCCEEDED',
      result: {
        columns: [{ name: 'n', type: 'integer' }],
        rows: [[1]],
        total_rows: 1,
        truncated: false,
      },
    });
    assert.deepEqual(bodies.at(-1), {
      source_id: 'src-1',
      sql: 'SELECT 1 AS n -- wait-ok',
      purpose: 'wait success',
      max_rows: 500,
    });
    const waitRowsRequests = requests.filter(
      (request) => request.path === '/v1/agent/proposals/proposal-wait-ok/rows',
    );
    assert.equal(waitRowsRequests.length, 1);
    assert.match(waitRowsRequests[0].search, /page=1/);
    assert.match(waitRowsRequests[0].search, /page_size=100/);
    assert.ok(
      requests.some(
        (request) =>
          request.method === 'GET' && request.path === '/v1/agent/proposals/proposal-wait-ok',
      ),
    );
    pass('sql_submit_and_wait polls to SUCCEEDED and returns the capped first page');

    const failed = await byName.sql_submit_and_wait.execute({
      source_id: 'src-1',
      sql: 'SELECT 1 AS n -- wait-fail',
      wait_seconds: 5,
    });
    assert.deepEqual(failed, {
      proposal_id: 'proposal-wait-fail',
      status: 'FAILED',
      error_code: 'QUERY_FAILED',
    });
    assert.equal(
      requests.some((request) => request.path === '/v1/agent/proposals/proposal-wait-fail/rows'),
      false,
    );
    pass('sql_submit_and_wait returns status and error_code for a terminal failure');

    const pendingArgs = {
      source_id: 'src-1',
      sql: 'SELECT 1 AS n -- wait-timeout',
      wait_seconds: 5,
    };
    const pendingStartedAt = Date.now();
    const pendingPromise = byName.sql_submit_and_wait.execute(pendingArgs);
    await assert.rejects(
      () => byName.sql_submit_and_wait.execute(pendingArgs),
      (error) => {
        assert.equal(error.name, 'SagToolError');
        assert.equal(error.code, 'SUBMIT_IN_FLIGHT');
        return true;
      },
    );
    const pending = await pendingPromise;
    assert.deepEqual(pending, {
      proposal_id: 'proposal-wait-pending',
      status: 'PENDING_APPROVAL',
      pending: true,
      message: '等待人工批准；可稍后用 sql_status/sql_result 继续',
    });
    assert.ok(Date.now() - pendingStartedAt >= 5000);
    assert.equal(
      requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path === '/v1/agent/proposals' &&
          request.body?.sql?.includes('wait-timeout'),
      ).length,
      1,
    );
    assert.equal(requests.some((request) => /approve|approvals/i.test(request.path)), false);
    pass('sql_submit_and_wait returns pending after wait_seconds without approving');
    pass('concurrent identical submissions are refused with SUBMIT_IN_FLIGHT');

    const cancelController = new AbortController();
    const cancelPromise = byName.sql_submit_and_wait.execute(
      { source_id: 'src-1', sql: 'SELECT 1 AS n -- wait-cancel', wait_seconds: 5 },
      { signal: cancelController.signal },
    );
    setTimeout(() => cancelController.abort(), 100);
    await assert.rejects(
      () => cancelPromise,
      (error) => {
        assert.equal(error.name, 'SagToolError');
        assert.equal(error.code, 'SAG_CANCELLED');
        return true;
      },
    );
    // The in-flight guard must be released after cancellation, so the same
    // query can start again instead of failing as a duplicate.
    const retryController = new AbortController();
    const retryPromise = byName.sql_submit_and_wait.execute(
      { source_id: 'src-1', sql: 'SELECT 1 AS n -- wait-cancel', wait_seconds: 5 },
      { signal: retryController.signal },
    );
    setTimeout(() => retryController.abort(), 100);
    await assert.rejects(
      () => retryPromise,
      (error) => {
        assert.equal(error.code, 'SAG_CANCELLED');
        return true;
      },
    );
    pass('polling aborts on exec.signal and releases the in-flight guard');

    const postsBeforeInvalidWait = requests.filter(
      (request) => request.method === 'POST',
    ).length;
    for (const waitSeconds of [4, 301, 5.5, 'fast']) {
      await assert.rejects(
        () =>
          byName.sql_submit_and_wait.execute({
            source_id: 'src-1',
            sql: 'SELECT 1 AS n',
            wait_seconds: waitSeconds,
          }),
        (error) => {
          assert.equal(error.code, 'INVALID_ARGUMENT');
          return true;
        },
      );
    }
    assert.equal(
      requests.filter((request) => request.method === 'POST').length,
      postsBeforeInvalidWait,
    );
    pass('wait_seconds is validated as an integer in 5–300 before submitting');

    const status = await byName.sql_status.execute({ proposal_id: 'proposal-1' });
    assert.equal(status.proposal_id, 'proposal-1');
    assert.equal(status.status, 'PENDING_APPROVAL');
    assert.equal(status.digest, 'digest-1');
    assert.equal(status.source_id, 'src-1');
    pass('sql_status maps the proposal object');

    const result = await byName.sql_result.execute({
      proposal_id: 'proposal-1',
      page: 1,
      page_size: 2,
    });
    assert.equal(result.proposal_id, 'proposal-1');
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(result.rows, [[1], [2]]);
    assert.equal(result.total_rows, 2);
    assert.equal(result.page_size, 2);
    assert.equal(result.truncated, false);
    assert.match(requests.at(-1).search, /page=1/);
    assert.match(requests.at(-1).search, /page_size=2/);
    pass('sql_result forwards pagination and returns rows');

    const cancelled = await byName.sql_cancel.execute({ proposal_id: 'proposal-1' });
    assert.equal(cancelled.proposal_id, 'proposal-1');
    assert.equal(cancelled.status, 'CANCELLED');
    pass('sql_cancel forwards POST /cancel');

    await assert.rejects(
      () => byName.sql_status.execute({ proposal_id: 'missing' }),
      (error) => {
        assert.equal(error.name, 'SagToolError');
        assert.equal(error.code, 'PROPOSAL_NOT_FOUND');
        assert.equal(error.status, 404);
        assert.equal(error.requestId, 'req-missing');
        assert.match(error.message, /^\[PROPOSAL_NOT_FOUND\]/);
        return true;
      },
    );
    pass('HTTP errors map to coded tool-error text');

    await assert.rejects(
      () => byName.sql_submit.execute({ source_id: 'src-1', sql: 'INSERT INTO t VALUES (1)' }),
      (error) => {
        assert.equal(error.code, 'NOT_SELECT');
        assert.equal(error.status, 400);
        return true;
      },
    );
    pass('core policy errors keep their error code');

    await assert.rejects(
      () => byName.sql_status.execute({ proposal_id: 'bad-json' }),
      (error) => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        return true;
      },
    );
    pass('non-JSON 200 responses map to INVALID_RESPONSE');

    const impatient = createTools({ url: base, token: TOKEN, requestTimeoutMs: 80 });
    await assert.rejects(
      () => impatient.find((tool) => tool.name === 'sql_status').execute({ proposal_id: 'slow' }),
      (error) => {
        assert.equal(error.code, 'SAG_TIMEOUT');
        return true;
      },
    );
    pass('request timeouts map to SAG_TIMEOUT');

    const badToken = createTools({
      url: base,
      token: 'sag_wrong_token_0123456789',
      requestTimeoutMs: 5000,
    });
    await assert.rejects(
      () => badToken.find((tool) => tool.name === 'sql_list_sources').execute({}),
      (error) => {
        assert.equal(error.code, 'UNAUTHENTICATED');
        assert.equal(error.status, 401);
        return true;
      },
    );
    pass('401 maps to UNAUTHENTICATED without leaking the token');

    const badUrl = createTools({ url: 'http://example.com:43119', token: TOKEN });
    await assert.rejects(
      () => badUrl.find((tool) => tool.name === 'sql_list_sources').execute({}),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID');
        return true;
      },
    );
    pass('non-loopback SAG_URL is refused');

    await assert.rejects(
      () => byName.sql_status.execute({}),
      (error) => {
        assert.equal(error.code, 'INVALID_ARGUMENT');
        return true;
      },
    );
    pass('missing proposal_id is rejected before any request');

    const registered = [];
    const routes = [];
    const fakeContext = {
      logger: { info() {}, warn() {} },
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
      effect(effect) {
        return effect();
      },
      get(name) {
        if (name !== 'webServer') return undefined;
        return {
          register(route) {
            routes.push(route);
            return () => {};
          },
        };
      },
    };
    apply(fakeContext, { url: base, token: TOKEN });
    assert.equal(registered.length, 6);
    assert.deepEqual(
      registered.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    assert.equal(registered.some((tool) => /approve|reject|admin/i.test(tool.name)), false);
    assert.equal(routes.length, 2);
    assert.ok(routes.every((route) => route.kind === 'exact' && route.path.endsWith('/client-config')));

    const configRoute = routes.find((route) => route.path === '/sql-approval/client-config');
    let configPayload = '';
    const fakeResponse = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(value) {
        configPayload = value ?? '';
      },
    };
    configRoute.handler({ method: 'GET' }, fakeResponse);
    assert.equal(fakeResponse.statusCode, 200);
    const clientConfig = JSON.parse(configPayload);
    assert.equal(clientConfig.core_url, base);
    assert.equal(clientConfig.embed_url, `${base}/?embed=1`);
    assert.equal(JSON.stringify(clientConfig).includes(TOKEN), false);
    pass('apply registers exactly six tools and a token-free client-config route');
  } finally {
    await close(server);
  }

  const closedPort = port;
  const down = createTools({
    url: `http://127.0.0.1:${closedPort}`,
    token: TOKEN,
    requestTimeoutMs: 1000,
  });
  await assert.rejects(
    () => down.find((tool) => tool.name === 'sql_list_sources').execute({}),
    (error) => {
      assert.equal(error.code, 'SAG_UNREACHABLE');
      assert.match(error.message, /^\[SAG_UNREACHABLE\]/);
      return true;
    },
  );
  pass('connection failures map to SAG_UNREACHABLE');

  console.log(`\n${checks} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
