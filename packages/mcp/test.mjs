#!/usr/bin/env node
/**
 * End-to-end tests for the stdio MCP server.
 *
 * The DSH Windows sandbox denies pipe-backed child processes (`spawn EPERM`),
 * so the server is spawned with regular-file stdio: the test writes JSON-RPC
 * lines to an input file, lets the child consume them to EOF, then reads the
 * captured stdout/stderr files. This still exercises the real child process,
 * stdin line loop and stdout wire format.
 *
 * Run: node packages/mcp/test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, 'server.mjs');
const TOKEN = 'sag_test_0123456789abcdefghijklmnopqrstuvwxyz';

let checks = 0;
function pass(name) {
  checks += 1;
  console.log(`PASS ${name}`);
}

const mockCalls = [];
const pollCounts = new Map();

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': 'req-test',
  });
  response.end(body);
}

const mockServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let body = null;
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  mockCalls.push({
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    authorization: request.headers.authorization,
    body,
  });

  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    json(response, 401, {
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
      request_id: 'req-auth',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/sources') {
    json(response, 200, [{ id: 'src-1', name: 'Local SQLite', dialect: 'sqlite' }]);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/agent/proposals') {
    if (body?.sql === 'SELECT 2 AS m') {
      json(response, 201, {
        id: 'p2',
        status: 'PENDING_APPROVAL',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      return;
    }
    if (body?.sql === 'SELECT 3 AS x') {
      json(response, 201, {
        id: 'p3',
        status: 'PENDING_APPROVAL',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      return;
    }
    if (body?.sql === 'SELECT 4 AS y') {
      json(response, 201, {
        id: 'p4',
        status: 'PENDING_APPROVAL',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      return;
    }
    if (body?.sql === 'SELECT 1 AS n') {
      json(response, 201, {
        id: 'p1',
        status: 'PENDING_APPROVAL',
        expires_at: '2030-01-01T00:00:00.000Z',
      });
      return;
    }
    json(response, 400, {
      code: 'POLICY_DENIED',
      message: 'Only read-only SELECT is allowed',
      request_id: 'req-policy',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/p1') {
    json(response, 200, {
      id: 'p1',
      source_id: 'src-1',
      sql: 'SELECT 1 AS n',
      params: null,
      purpose: 'smoke',
      max_rows: 10,
      timeout_s: 5,
      status: 'PENDING_APPROVAL',
      status_message: null,
      digest: 'digest-1',
      policy_version: 'sag-policy-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2030-01-01T00:00:00.000Z',
      request_key: 'rk-1',
      result: null,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/p1/rows') {
    json(response, 200, {
      columns: [{ name: 'n' }],
      rows: [{ n: 1 }],
      page: Number(url.searchParams.get('page') ?? '1'),
      page_size: Number(url.searchParams.get('page_size') ?? '100'),
      total_rows: 1,
      truncated: false,
      executed_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 1,
      expires_at: '2030-01-01T00:00:00.000Z',
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/agent/proposals/p1/cancel') {
    json(response, 200, { id: 'p1', status: 'CANCELLED' });
    return;
  }

  // Polled proposals for sql_submit_and_wait: p2 becomes SUCCEEDED on the
  // second status read, p3 fails immediately, p4 stays pending.
  const polledMatch = /^\/v1\/agent\/proposals\/(p[234])$/.exec(url.pathname);
  if (request.method === 'GET' && polledMatch) {
    const id = polledMatch[1];
    const polls = (pollCounts.get(id) ?? 0) + 1;
    pollCounts.set(id, polls);
    const base = {
      id,
      source_id: 'src-1',
      params: null,
      purpose: 'submit-and-wait',
      max_rows: 50,
      timeout_s: 5,
      status_message: null,
      digest: `digest-${id}`,
      policy_version: 'sag-policy-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2030-01-01T00:00:00.000Z',
      request_key: null,
      result: null,
    };
    if (id === 'p2') {
      const succeeded = polls > 1;
      json(response, 200, {
        ...base,
        sql: 'SELECT 2 AS m',
        status: succeeded ? 'SUCCEEDED' : 'PENDING_APPROVAL',
        result: succeeded
          ? {
              columns: [{ name: 'm' }],
              total_rows: 1,
              truncated: false,
              executed_at: '2026-01-01T00:00:01.000Z',
              duration_ms: 1,
              expires_at: '2030-01-01T00:00:00.000Z',
            }
          : null,
      });
      return;
    }
    if (id === 'p3') {
      json(response, 200, {
        ...base,
        sql: 'SELECT 3 AS x',
        status: 'FAILED',
        status_message: 'query_failed',
      });
      return;
    }
    json(response, 200, { ...base, sql: 'SELECT 4 AS y', status: 'PENDING_APPROVAL' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/p2/rows') {
    json(response, 200, {
      columns: [{ name: 'm' }],
      rows: [{ m: 2 }],
      page: Number(url.searchParams.get('page') ?? '1'),
      page_size: Number(url.searchParams.get('page_size') ?? '100'),
      total_rows: 1,
      truncated: false,
      executed_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 1,
      expires_at: '2030-01-01T00:00:00.000Z',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/proposals/missing') {
    json(response, 404, {
      code: 'PROPOSAL_NOT_FOUND',
      message: 'Proposal not found',
      request_id: 'req-missing',
    });
    return;
  }

  json(response, 404, { code: 'NOT_FOUND', message: 'Not found', request_id: 'req-404' });
});

function parseStdout(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`stdout contained a non-JSON line: ${line}`);
      }
    });
}

function runServer({ env = {}, lines, timeoutMs = 20_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'sag-mcp-test-'));
  const stdinPath = join(dir, 'stdin.jsonl');
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');

  const input = `${lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')}\n`;
  writeFileSync(stdinPath, input, 'utf8');

  const fds = [
    openSync(stdinPath, 'r'),
    openSync(stdoutPath, 'w'),
    openSync(stderrPath, 'w'),
  ];

  const childEnv = { ...process.env };
  delete childEnv.SAG_URL;
  delete childEnv.SAG_TOKEN;
  Object.assign(childEnv, env);

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: HERE,
    env: childEnv,
    stdio: fds,
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const cleanup = () => {
      for (const fd of fds) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    };

    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = readFileSync(stdoutPath, 'utf8');
      const stderr = readFileSync(stderrPath, 'utf8');
      cleanup();
      if (timedOut) {
        reject(new Error(`server timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`server exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, messages: parseStdout(stdout) });
    });
  });
}

function byId(messages, id) {
  const message = messages.find((item) => item.id === id);
  assert.ok(message, `response for id ${id} is present`);
  return message;
}

function toolPayload(message) {
  assert.ok(message.result, 'tool response has a result');
  assert.ok(Array.isArray(message.result.content), 'tool response has content');
  assert.equal(message.result.content.length, 1);
  assert.equal(message.result.content[0].type, 'text');
  return JSON.parse(message.result.content[0].text);
}

async function testHappyPathAndErrors(baseUrl) {
  const start = mockCalls.length;
  const lines = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'sql_list_sources', arguments: {} },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'sql_submit',
        arguments: {
          source_id: 'src-1',
          sql: 'SELECT 1 AS n',
          purpose: 'smoke',
          max_rows: 10,
          timeout_s: 5,
          request_key: 'rk-1',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'sql_status', arguments: { proposal_id: 'p1' } },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'sql_result',
        arguments: { proposal_id: 'p1', page: 2, page_size: 10 },
      },
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'sql_cancel', arguments: { proposal_id: 'p1' } },
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'sql_submit',
        arguments: { source_id: 'src-1', sql: 'DELETE FROM t' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'sql_status', arguments: { proposal_id: 'missing' } },
    },
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'sql_status', arguments: {} },
    },
    { jsonrpc: '2.0', id: 11, method: 'unknown/method' },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'sql_drop', arguments: {} },
    },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
    '{broken json',
    { jsonrpc: '2.0', id: 13, method: 'tools/list' },
  ];

  const result = await runServer({
    env: { SAG_URL: baseUrl, SAG_TOKEN: TOKEN },
    lines,
  });
  const { messages, stdout, stderr } = result;

  // One response per request with an id, a null-id parse error, and nothing
  // for either notification.
  assert.equal(messages.length, 14, 'notification messages produce no responses');
  assert.equal(messages.filter((message) => message.id === undefined).length, 0);
  assert.equal(messages.filter((message) => message.id === null).length, 1);
  assert.deepEqual(
    messages.filter((message) => message.id !== null).map((message) => message.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  pass('JSON-RPC line framing, ids and notification handling');

  // initialize
  const initialize = byId(messages, 1).result;
  assert.equal(initialize.protocolVersion, '2024-11-05');
  assert.deepEqual(initialize.capabilities, { tools: {} });
  assert.equal(initialize.serverInfo.name, 'sql-approval-mcp');
  assert.equal(typeof initialize.serverInfo.version, 'string');
  pass('initialize returns protocolVersion/capabilities/serverInfo');

  // tools/list
  const tools = byId(messages, 2).result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'sql_list_sources',
      'sql_submit',
      'sql_submit_and_wait',
      'sql_status',
      'sql_result',
      'sql_cancel',
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
  }
  const submitSchema = tools.find((tool) => tool.name === 'sql_submit').inputSchema;
  assert.deepEqual(Object.keys(submitSchema.properties).sort(), [
    'max_rows',
    'purpose',
    'request_key',
    'source_id',
    'sql',
    'timeout_s',
  ]);
  assert.deepEqual(submitSchema.required, ['source_id', 'sql']);
  const submitAndWait = tools.find((tool) => tool.name === 'sql_submit_and_wait');
  assert.match(submitAndWait.description, /不会批准/);
  assert.match(submitAndWait.description, /不会自动批准/);
  const waitSchema = submitAndWait.inputSchema;
  assert.deepEqual(Object.keys(waitSchema.properties).sort(), [
    'max_rows',
    'params',
    'purpose',
    'source_id',
    'sql',
    'timeout_s',
    'wait_seconds',
  ]);
  assert.deepEqual(waitSchema.required, ['source_id', 'sql']);
  assert.equal(waitSchema.properties.wait_seconds.minimum, 5);
  assert.equal(waitSchema.properties.wait_seconds.maximum, 300);
  assert.equal(waitSchema.properties.wait_seconds.default, 120);
  const resultSchema = tools.find((tool) => tool.name === 'sql_result').inputSchema;
  assert.deepEqual(Object.keys(resultSchema.properties).sort(), [
    'page',
    'page_size',
    'proposal_id',
  ]);
  assert.deepEqual(resultSchema.required, ['proposal_id']);
  pass('tools/list exposes 6 tools with core-compatible inputSchema fields');

  // tools/call forwarding
  assert.deepEqual(toolPayload(byId(messages, 3)), [
    { id: 'src-1', name: 'Local SQLite', dialect: 'sqlite' },
  ]);
  assert.deepEqual(toolPayload(byId(messages, 4)), {
    id: 'p1',
    status: 'PENDING_APPROVAL',
    expires_at: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(toolPayload(byId(messages, 5)).id, 'p1');
  assert.equal(toolPayload(byId(messages, 5)).status, 'PENDING_APPROVAL');
  const rows = toolPayload(byId(messages, 6));
  assert.equal(rows.page, 2);
  assert.equal(rows.page_size, 10);
  assert.deepEqual(rows.rows, [{ n: 1 }]);
  assert.deepEqual(toolPayload(byId(messages, 7)), { id: 'p1', status: 'CANCELLED' });
  pass('tools/call forwards each tool to /v1/agent/* and returns text JSON');

  const calls = mockCalls.slice(start);
  assert.equal(calls.length, 7, 'every successful HTTP-backed call reached the mock core');
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${TOKEN}`, 'Bearer token is forwarded');
  }
  const submitCall = calls.find((call) => call.method === 'POST' && call.path === '/v1/agent/proposals');
  assert.deepEqual(submitCall.body, {
    source_id: 'src-1',
    sql: 'SELECT 1 AS n',
    purpose: 'smoke',
    max_rows: 10,
    timeout_s: 5,
    request_key: 'rk-1',
  });
  const rowsCall = calls.find((call) => call.path === '/v1/agent/proposals/p1/rows');
  assert.equal(rowsCall.query.get('page'), '2');
  assert.equal(rowsCall.query.get('page_size'), '10');
  pass('HTTP body/query mapping matches the core Agent API');

  // HTTP error mapping
  const policy = byId(messages, 8);
  assert.equal(policy.result.isError, true);
  assert.equal(toolPayload(policy).error.code, 'POLICY_DENIED');
  assert.equal(toolPayload(policy).error.http_status, 400);
  assert.equal(toolPayload(policy).error.request_id, 'req-policy');

  const missing = byId(messages, 9);
  assert.equal(missing.result.isError, true);
  assert.equal(toolPayload(missing).error.code, 'PROPOSAL_NOT_FOUND');
  assert.equal(toolPayload(missing).error.http_status, 404);
  pass('HTTP errors map to isError:true payloads containing the error code');

  const invalidArgument = byId(messages, 10);
  assert.equal(invalidArgument.result.isError, true);
  assert.equal(toolPayload(invalidArgument).error.code, 'INVALID_ARGUMENT');
  pass('missing required tool arguments return a clear tool error');

  // Protocol errors
  assert.equal(byId(messages, 11).error.code, -32601);
  assert.equal(byId(messages, 12).error.code, -32602);
  const parseError = messages.find((message) => message.id === null);
  assert.equal(parseError.error.code, -32700);
  assert.equal(byId(messages, 13).result.tools.length, 6);
  pass('unknown method -32601, unknown tool -32602, parse error -32700');

  // Secrets and stream hygiene
  assert.equal(stdout.includes(TOKEN), false, 'token never appears on stdout');
  assert.equal(stderr.includes(TOKEN), false, 'token never appears in stderr logs');
  assert.match(stderr, /"token":"configured"/);
  assert.match(stderr, /"event":"mcp_started"/);
  pass('token is not logged; stdout carries only JSON-RPC');
}

async function testSubmitAndWait(baseUrl) {
  const start = mockCalls.length;
  const startedAt = Date.now();
  const result = await runServer({
    env: { SAG_URL: baseUrl, SAG_TOKEN: TOKEN },
    timeoutMs: 30_000,
    lines: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'sql_submit_and_wait',
          arguments: {
            source_id: 'src-1',
            sql: 'SELECT 2 AS m',
            purpose: 'submit-and-wait',
            params: { id: 7 },
            max_rows: 50,
            timeout_s: 5,
            wait_seconds: 5,
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'sql_submit_and_wait',
          arguments: { source_id: 'src-1', sql: 'SELECT 3 AS x', wait_seconds: 5 },
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'sql_submit_and_wait',
          arguments: { source_id: 'src-1', sql: 'SELECT 4 AS y', wait_seconds: 5 },
        },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'sql_submit_and_wait',
          arguments: { source_id: 'src-1', sql: 'SELECT 1 AS n', wait_seconds: 2 },
        },
      },
    ],
  });
  const elapsed = Date.now() - startedAt;
  const { messages, stdout, stderr } = result;
  const calls = mockCalls.slice(start);

  // Success: PENDING on the first poll, SUCCEEDED on the second, then rows.
  assert.deepEqual(toolPayload(byId(messages, 2)), {
    proposal_id: 'p2',
    status: 'SUCCEEDED',
    result: {
      columns: [{ name: 'm' }],
      rows: [{ m: 2 }],
      total_rows: 1,
      truncated: false,
    },
  });
  assert.ok((pollCounts.get('p2') ?? 0) >= 2, 'a successful wait polls until the terminal status');
  const rowsCall = calls.find((call) => call.path === '/v1/agent/proposals/p2/rows');
  assert.equal(rowsCall.query.get('page'), '1');
  assert.equal(rowsCall.query.get('page_size'), '50', 'page_size is min(max_rows, 100)');
  const submitCall = calls.find(
    (call) => call.method === 'POST' && call.path === '/v1/agent/proposals',
  );
  assert.deepEqual(submitCall.body, {
    source_id: 'src-1',
    sql: 'SELECT 2 AS m',
    purpose: 'submit-and-wait',
    params: { id: 7 },
    max_rows: 50,
    timeout_s: 5,
  });

  // Non-success terminal state maps status_message back to an error code.
  assert.deepEqual(toolPayload(byId(messages, 3)), {
    proposal_id: 'p3',
    status: 'FAILED',
    error_code: 'QUERY_FAILED',
  });

  // Pending beyond wait_seconds returns the pending envelope, never approves.
  assert.deepEqual(toolPayload(byId(messages, 4)), {
    proposal_id: 'p4',
    status: 'PENDING_APPROVAL',
    pending: true,
    message: '等待人工批准...',
  });
  assert.ok((pollCounts.get('p4') ?? 0) >= 3, 'pending proposals are polled about once per second');
  assert.ok(elapsed >= 5_000, 'wait_seconds is honored before returning pending');
  assert.equal(stdout.includes(TOKEN), false, 'token never appears on stdout');
  assert.equal(stderr.includes(TOKEN), false, 'token never appears in stderr logs');

  // Invalid wait_seconds is rejected locally, before any HTTP request.
  const postCount = calls.filter((call) => call.method === 'POST').length;
  assert.equal(postCount, 3, 'only the three valid submissions reached the mock core');
  const invalid = byId(messages, 5);
  assert.equal(invalid.result.isError, true);
  assert.equal(toolPayload(invalid).error.code, 'INVALID_ARGUMENT');
  assert.equal(
    calls.some((call) => /\/approve$|\/reject$/.test(call.path)),
    false,
    'sql_submit_and_wait never calls approve/reject',
  );
  pass('sql_submit_and_wait succeeds, fails, times out pending, and never approves');
}

async function testMissingToken(baseUrl) {
  const start = mockCalls.length;
  const result = await runServer({
    env: { SAG_URL: baseUrl },
    lines: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'sql_list_sources', arguments: {} },
      },
    ],
  });

  assert.equal(byId(result.messages, 1).result.protocolVersion, '2024-11-05');
  const call = byId(result.messages, 2);
  assert.equal(call.result.isError, true);
  assert.equal(toolPayload(call).error.code, 'SAG_TOKEN_MISSING');
  assert.match(result.stderr, /"token":"missing"/);
  assert.equal(mockCalls.length, start, 'missing token short-circuits before HTTP');
  pass('missing SAG_TOKEN yields a clear tool error without HTTP');
}

async function testUnreachableCore(deadUrl) {
  const result = await runServer({
    env: { SAG_URL: deadUrl, SAG_TOKEN: TOKEN },
    lines: [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'sql_list_sources', arguments: {} },
      },
    ],
  });

  const call = byId(result.messages, 1);
  assert.equal(call.result.isError, true);
  assert.equal(toolPayload(call).error.code, 'GATEWAY_UNAVAILABLE');
  pass('unreachable core maps to GATEWAY_UNAVAILABLE');
}

async function getDeadUrl() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function main() {
  await new Promise((resolve, reject) => {
    mockServer.once('error', reject);
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  const { port } = mockServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await testHappyPathAndErrors(baseUrl);
    await testSubmitAndWait(baseUrl);
    await testMissingToken(baseUrl);
    await testUnreachableCore(await getDeadUrl());
    console.log(`\nAll ${checks} MCP checks passed.`);
  } finally {
    mockServer.closeAllConnections?.();
    await new Promise((resolve) => mockServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
