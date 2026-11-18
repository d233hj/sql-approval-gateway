/**
 * Transport tests for the admin API client (DESIGN §4.3).
 *
 * The SPA has no test framework dependency; this file runs with Node's built-in
 * test runner against the real `api.ts` (Node 24 strips the types):
 *
 *   node --test packages/web/src/api.embed.test.mjs
 *
 * A minimal `window` stub is enough because api.ts only reads `window.parent`,
 * `window.location.search`, `window.setTimeout` and `window.clearTimeout`.
 * `fetch` is stubbed to record the exact headers of every request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminAuthHeaders,
  api,
  hasBearerToken,
  isEmbeddedMode,
  setCsrfToken,
} from './api.ts';

const UNLOCK_BODY = {
  ok: true,
  csrfToken: 'csrf-token-1',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  token: 'session-token-1',
};

let calls = [];
let handler = null;

function installEnvironment({ parentIsSelf, search, handler: nextHandler }) {
  calls = [];
  handler = nextHandler;
  setCsrfToken(null); // also clears any Bearer token left by a previous test

  const fakeWindow = {
    parent: null,
    location: { search },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  fakeWindow.parent = parentIsSelf ? fakeWindow : {};
  globalThis.window = fakeWindow;
  globalThis.fetch = async (url, init = {}) => {
    const record = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
    };
    calls.push(record);
    return handler(record);
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function firstCall(url) {
  return calls.find((call) => call.url === url);
}

test('嵌入模式（parent 不同）unlock 请求 token，后续请求带 Bearer 且不带 CSRF', async () => {
  installEnvironment({
    parentIsSelf: false,
    search: '',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') return jsonResponse(UNLOCK_BODY);
      if (call.url === '/v1/admin/proposals') return jsonResponse([]);
      if (call.url === '/v1/admin/sources') return jsonResponse([]);
      return jsonResponse({ configured: true, unlocked: true, version: '0.1.0' });
    },
  });

  assert.equal(isEmbeddedMode(), true);

  const unlocked = await api.unlock('a-long-admin-password-1');
  assert.equal(unlocked.token, 'session-token-1');
  assert.equal(hasBearerToken(), true);

  const unlockCall = firstCall('/v1/admin/unlock');
  assert.equal(unlockCall.headers['X-SAG-Want-Token'], '1');
  assert.equal(unlockCall.headers.Authorization, undefined);

  await api.listProposals({});
  await api.listSources();

  const listCall = firstCall('/v1/admin/proposals');
  assert.equal(listCall.headers.Authorization, 'Bearer session-token-1');
  assert.equal(listCall.headers['X-SAG-CSRF'], undefined);
  assert.equal(listCall.headers['X-SAG-Want-Token'], undefined);

  const sourcesCall = firstCall('/v1/admin/sources');
  assert.equal(sourcesCall.headers.Authorization, 'Bearer session-token-1');
});

test('嵌入模式（?embed=1）写请求同样用 Bearer，不要求 CSRF', async () => {
  installEnvironment({
    parentIsSelf: true,
    search: '?embed=1',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') return jsonResponse(UNLOCK_BODY);
      if (call.url === '/v1/admin/proposals/p-1/approve') {
        return jsonResponse({
          id: 'p-1',
          status: 'SUCCEEDED',
          result: null,
        });
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(isEmbeddedMode(), true);
  await api.unlock('a-long-admin-password-1');
  await api.approve('p-1');

  const approveCall = firstCall('/v1/admin/proposals/p-1/approve');
  assert.equal(approveCall.method, 'POST');
  assert.equal(approveCall.headers.Authorization, 'Bearer session-token-1');
  assert.equal(approveCall.headers['X-SAG-CSRF'], undefined);
});

test('lock 成功后清除内存 Bearer，后续请求不再带 Authorization', async () => {
  installEnvironment({
    parentIsSelf: false,
    search: '',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') return jsonResponse(UNLOCK_BODY);
      if (call.url === '/v1/admin/lock') return jsonResponse({ ok: true });
      return jsonResponse({ configured: true, unlocked: false, version: '0.1.0' });
    },
  });

  await api.unlock('a-long-admin-password-1');
  await api.lock();

  const lockCall = firstCall('/v1/admin/lock');
  assert.equal(lockCall.headers.Authorization, 'Bearer session-token-1');
  assert.equal(lockCall.headers['X-SAG-CSRF'], undefined);
  assert.equal(hasBearerToken(), false);

  await api.getState();
  const stateCall = firstCall('/v1/admin/state');
  assert.equal(stateCall.headers.Authorization, undefined);
});

test('401 表示 Bearer 会话失效，立即清除 token', async () => {
  installEnvironment({
    parentIsSelf: false,
    search: '',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') return jsonResponse(UNLOCK_BODY);
      return jsonResponse({ code: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    },
  });

  await api.unlock('a-long-admin-password-1');
  assert.equal(hasBearerToken(), true);

  await assert.rejects(api.listProposals({}), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(hasBearerToken(), false);
});

test('非嵌入模式不请求、不保存、不发送 Bearer，仍走 Cookie + CSRF', async () => {
  installEnvironment({
    parentIsSelf: true,
    search: '',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') {
        // Even if a core were to return a token, a same-origin page must ignore it.
        return jsonResponse(UNLOCK_BODY);
      }
      if (call.url === '/v1/admin/lock') return jsonResponse({ ok: true });
      if (call.url === '/v1/admin/proposals') return jsonResponse([]);
      return jsonResponse({ configured: true, unlocked: true, version: '0.1.0' });
    },
  });

  assert.equal(isEmbeddedMode(), false);

  const unlocked = await api.unlock('a-long-admin-password-1');
  assert.equal(hasBearerToken(), false);

  const unlockCall = firstCall('/v1/admin/unlock');
  assert.equal(unlockCall.headers['X-SAG-Want-Token'], undefined);
  assert.equal(unlockCall.headers.Authorization, undefined);

  setCsrfToken(unlocked.csrfToken);
  await api.listProposals({});
  await api.lock();

  const listCall = firstCall('/v1/admin/proposals');
  assert.equal(listCall.headers.Authorization, undefined);
  assert.equal(listCall.headers['X-SAG-CSRF'], undefined);
  assert.equal(listCall.headers['X-SAG-Want-Token'], undefined);

  const lockCall = firstCall('/v1/admin/lock');
  assert.equal(lockCall.headers.Authorization, undefined);
  assert.equal(lockCall.headers['X-SAG-CSRF'], 'csrf-token-1');
});

test('实时事件流头：嵌入模式带 Bearer，非嵌入模式交给 Cookie', async () => {
  installEnvironment({
    parentIsSelf: false,
    search: '',
    handler: (call) => {
      if (call.url === '/v1/admin/unlock') return jsonResponse(UNLOCK_BODY);
      return jsonResponse({ configured: true, unlocked: true, version: '0.1.0' });
    },
  });

  assert.deepEqual(adminAuthHeaders(), {});
  await api.unlock('a-long-admin-password-1');
  assert.deepEqual(adminAuthHeaders(), { Authorization: 'Bearer session-token-1' });
  // No CSRF header: the stream is read-only.
  assert.equal(adminAuthHeaders()['X-SAG-CSRF'], undefined);

  await api.lock();
  assert.deepEqual(adminAuthHeaders(), {});
});
