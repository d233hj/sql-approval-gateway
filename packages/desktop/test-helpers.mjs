import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TARGET_URL,
  LOCK_DISPATCH_CODE,
  LOCK_DISPATCH_TIMEOUT_MS,
  LOCK_VERIFY_DELAY_MS,
  STOP_FORCE_MS,
  STOP_GRACE_MS,
  buildCoreArgs,
  buildLoginItemSettings,
  endpointProblems,
  healthCheck,
  isAllowedNavigation,
  isLockedState,
  lockViaRenderer,
  parseEndpoint,
  parseTargetUrl,
  resolveDataDir,
  resolveEndpointTarget,
  sanitizeSettings,
  stopChildProcess,
  waitForHealth,
} from './lib.js';

// --------------------------------------------------------------- SAG_URL

test('default target is the loopback SPA origin', () => {
  const target = parseTargetUrl();
  assert.equal(DEFAULT_TARGET_URL, 'http://127.0.0.1:43119');
  assert.equal(target.origin, 'http://127.0.0.1:43119');
  assert.equal(target.href, 'http://127.0.0.1:43119/');
  assert.equal(target.port, 43119);
  assert.equal(target.hostname, '127.0.0.1');
});

test('loopback aliases and IPv6 loopback are accepted', () => {
  assert.equal(parseTargetUrl('http://localhost:43119').origin, 'http://localhost:43119');
  assert.equal(parseTargetUrl('http://[::1]:43119').hostname, '::1');
  assert.equal(parseTargetUrl('http://127.0.0.1:43119/').port, 43119);
});

test('non-loopback, non-http and credential URLs are rejected', () => {
  for (const raw of [
    'https://127.0.0.1:43119',
    'http://example.com:43119',
    'http://10.0.0.1:43119',
    'http://0.0.0.0:43119',
    'http://127.0.0.2:43119',
    'http://user:pass@127.0.0.1:43119',
    'http://127.0.0.1',
    'http://127.0.0.1:43119/app',
    'http://127.0.0.1:43119/?embed=1',
    'http://127.0.0.1:43119/#x',
    'file:///C:/Windows/System32/calc.exe',
    'not a url',
    '',
  ]) {
    assert.throws(() => parseTargetUrl(raw), undefined, raw);
  }
});

// --------------------------------------------------------------- navigation

test('navigation allow-list is the exact target origin', () => {
  const origin = 'http://127.0.0.1:43119';
  assert.equal(isAllowedNavigation('http://127.0.0.1:43119/', origin), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1:43119/proposals/1?x=1', origin), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1:43120/', origin), false);
  assert.equal(isAllowedNavigation('https://127.0.0.1:43119/', origin), false);
  assert.equal(isAllowedNavigation('http://localhost:43119/', origin), false);
  assert.equal(isAllowedNavigation('http://127.0.0.1:43119.evil.example/', origin), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)', origin), false);
  assert.equal(isAllowedNavigation('about:blank', origin), false);
  assert.equal(isAllowedNavigation('not a url', origin), false);
});

// --------------------------------------------------------------- core args

test('core args match the CLI contract', () => {
  assert.deepEqual(buildCoreArgs({ dataDir: 'C:\\Users\\me\\AppData\\data', port: 43119 }), [
    '--data-dir',
    'C:\\Users\\me\\AppData\\data',
    '--port',
    '43119',
  ]);
});

test('core args reject missing data dir and invalid ports', () => {
  assert.throws(() => buildCoreArgs({ port: 43119 }), TypeError);
  assert.throws(() => buildCoreArgs({ dataDir: '  ', port: 43119 }), TypeError);
  for (const port of [0, -1, 65536, 1.5, 'abc', undefined]) {
    assert.throws(() => buildCoreArgs({ dataDir: 'C:\\data', port }), TypeError, String(port));
  }
});

test('data dir honours a launcher override and otherwise uses the user profile', () => {
  const fallback = 'C:\\Users\\me\\AppData\\Roaming\\SQL Approval Gateway\\data';
  assert.deepEqual(resolveDataDir(undefined, fallback), { dir: fallback, source: 'userData' });
  assert.deepEqual(resolveDataDir('   ', fallback), { dir: fallback, source: 'userData' });
  assert.deepEqual(resolveDataDir('E:\\sql-gateway\\data', fallback), {
    dir: 'E:\\sql-gateway\\data',
    source: 'env',
  });
  assert.deepEqual(resolveDataDir('  E:\\sql-gateway\\data  ', fallback), {
    dir: 'E:\\sql-gateway\\data',
    source: 'env',
  });
  assert.deepEqual(resolveDataDir(undefined, 'E:\\portable\\data', 'portable'), {
    dir: 'E:\\portable\\data',
    source: 'portable',
  });
  assert.throws(() => resolveDataDir('E:\\x', '  '), TypeError);
});

// --------------------------------------------------------------- health

function fakeResponse({ status = 200, body = { ok: true, version: '0.1.0', pid: 123 } } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('health check parses a healthy response', async () => {
  const calls = [];
  const result = await healthCheck('http://127.0.0.1:43119', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.version, '0.1.0');
  assert.equal(result.payload.pid, 123);
  assert.equal(calls[0].url, 'http://127.0.0.1:43119/v1/health');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
});

test('health check maps HTTP failures and malformed payloads', async () => {
  const http = await healthCheck('http://127.0.0.1:43119', {
    fetchImpl: async () => fakeResponse({ status: 503 }),
  });
  assert.deepEqual(http, { ok: false, error: 'http_503' });

  const unhealthy = await healthCheck('http://127.0.0.1:43119', {
    fetchImpl: async () => fakeResponse({ body: { ok: false } }),
  });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.error, 'unhealthy');
});

test('health check times out even when fetch never settles', async () => {
  const started = Date.now();
  const result = await healthCheck('http://127.0.0.1:43119', {
    timeoutMs: 25,
    fetchImpl: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: false, error: 'timeout' });
  assert.ok(elapsed >= 15, `elapsed ${elapsed}ms should reach the timeout`);
  assert.ok(elapsed < 1000, `elapsed ${elapsed}ms should be bounded`);
});

test('health check reports network errors', async () => {
  const result = await healthCheck('http://127.0.0.1:43119', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'network_error');
  assert.equal(result.detail, 'ECONNREFUSED');
});

test('waitForHealth succeeds after transient failures', async () => {
  let nowMs = 0;
  let attempts = 0;
  const result = await waitForHealth('http://127.0.0.1:43119', {
    timeoutMs: 15_000,
    intervalMs: 250,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    check: async () => {
      attempts += 1;
      return attempts >= 3 ? { ok: true, payload: {} } : { ok: false, error: 'network_error' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.equal(nowMs, 500);
});

test('waitForHealth gives up after the 15s budget', async () => {
  let nowMs = 0;
  let attempts = 0;
  const result = await waitForHealth('http://127.0.0.1:43119', {
    timeoutMs: 1000,
    intervalMs: 250,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    check: async () => {
      attempts += 1;
      return { ok: false, error: 'network_error' };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'network_error');
  assert.equal(nowMs, 1000);
  assert.ok(attempts >= 4, `expected repeated probes, got ${attempts}`);
});

// --------------------------------------------------------------- settings/login

test('desktop settings default to minimize-to-tray', () => {
  assert.deepEqual(sanitizeSettings(null), { minimizeToTray: true });
  assert.deepEqual(sanitizeSettings({ minimizeToTray: false }), { minimizeToTray: false });
  assert.deepEqual(sanitizeSettings({ minimizeToTray: 'no' }), { minimizeToTray: true });
});

test('login item opens hidden in tray', () => {
  assert.deepEqual(buildLoginItemSettings(true, 'C:\\app', true), {
    openAtLogin: true,
    args: ['--hidden'],
  });
  assert.deepEqual(buildLoginItemSettings(false, 'C:\\app', false), {
    openAtLogin: false,
    args: ['C:\\app', '--hidden'],
  });
});

// ----------------------------------------------------------- endpoint.json

test('endpoint.json parses the core-written shape', () => {
  const raw = JSON.stringify({
    url: 'http://127.0.0.1:43120',
    pid: 4242,
    version: '0.1.0',
    startedAt: '2026-11-13T00:00:00.000Z',
  });
  assert.deepEqual(parseEndpoint(raw), {
    url: 'http://127.0.0.1:43120',
    port: 43120,
    pid: 4242,
    version: '0.1.0',
    startedAt: '2026-11-13T00:00:00.000Z',
  });
  // Object input is accepted; startedAt is optional.
  assert.deepEqual(parseEndpoint({ url: 'http://localhost:43119', pid: 7, version: '1.0.0' }), {
    url: 'http://localhost:43119',
    port: 43119,
    pid: 7,
    version: '1.0.0',
    startedAt: null,
  });
});

test('endpoint.json rejects malformed or non-loopback records', () => {
  for (const raw of [
    'not json',
    '[]',
    'null',
    JSON.stringify({ url: 'http://127.0.0.1:43119', pid: 0, version: '0.1.0' }),
    JSON.stringify({ url: 'http://127.0.0.1:43119', pid: 1.5, version: '0.1.0' }),
    JSON.stringify({ url: 'http://127.0.0.1:43119', pid: 10, version: '' }),
    JSON.stringify({ url: 'https://127.0.0.1:43119', pid: 10, version: '0.1.0' }),
    JSON.stringify({ url: 'http://10.0.0.1:43119', pid: 10, version: '0.1.0' }),
    JSON.stringify({ url: 'http://127.0.0.1', pid: 10, version: '0.1.0' }),
    JSON.stringify({ url: 'http://127.0.0.1:43119/app', pid: 10, version: '0.1.0' }),
    JSON.stringify({ url: 42, pid: 10, version: '0.1.0' }),
  ]) {
    assert.equal(parseEndpoint(raw), null, String(raw));
  }
});

test('endpoint verification requires matching pid and version', () => {
  const endpoint = parseEndpoint(
    '{"url":"http://127.0.0.1:43120","pid":42,"version":"0.1.0"}',
  );
  const healthy = { ok: true, pid: 42, version: '0.1.0' };
  assert.deepEqual(endpointProblems(endpoint, healthy), []);
  assert.equal(endpointProblems(endpoint, { ...healthy, pid: 43 }).length, 1);
  assert.equal(endpointProblems(endpoint, { ...healthy, version: '9.9.9' }).length, 1);
  assert.equal(endpointProblems(endpoint, { ok: false }).length, 1);
  assert.equal(endpointProblems(null, healthy).length, 1);
});

test('startup discovery prefers a verified endpoint.json', async () => {
  const checks = [];
  const result = await resolveEndpointTarget({
    dataDir: 'C:\\Users\\me\\AppData\\data',
    readFile: async (file) => {
      assert.ok(file.endsWith('endpoint.json'), file);
      return JSON.stringify({
        url: 'http://127.0.0.1:43120',
        pid: 42,
        version: '0.1.0',
      });
    },
    check: async (url) => {
      checks.push(url);
      return { ok: true, payload: { ok: true, pid: 42, version: '0.1.0' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.target.origin, 'http://127.0.0.1:43120');
  assert.equal(result.endpoint.pid, 42);
  assert.ok(result.endpointPath.endsWith('endpoint.json'));
  assert.deepEqual(checks, ['http://127.0.0.1:43120']);
});

test('startup discovery falls back on missing, malformed, unhealthy or mismatched endpoint', async () => {
  const valid = JSON.stringify({ url: 'http://127.0.0.1:43120', pid: 42, version: '0.1.0' });
  const cases = [
    {
      name: 'missing',
      readFile: () => null,
      check: async () => ({ ok: true, payload: { ok: true, pid: 42, version: '0.1.0' } }),
      reason: 'missing',
    },
    {
      name: 'malformed',
      readFile: () => '{',
      check: async () => ({ ok: true, payload: { ok: true, pid: 42, version: '0.1.0' } }),
      reason: 'malformed',
    },
    {
      name: 'unhealthy',
      readFile: () => valid,
      check: async () => ({ ok: false, error: 'network_error' }),
      reason: 'unhealthy',
    },
    {
      name: 'mismatch',
      readFile: () => valid,
      check: async () => ({ ok: true, payload: { ok: true, pid: 43, version: '0.1.0' } }),
      reason: 'mismatch',
    },
  ];
  for (const item of cases) {
    const result = await resolveEndpointTarget({
      dataDir: 'C:\\data',
      readFile: item.readFile,
      check: item.check,
    });
    assert.equal(result.ok, false, item.name);
    assert.equal(result.reason, item.reason, item.name);
  }
});

// ------------------------------------------------------------- tray lock

test('tray lock evaluates the no-argument sag:lock event then waits 1s', async () => {
  const calls = [];
  const sleeps = [];
  const fakeWindow = {
    webContents: {
      executeJavaScript: async (code, gesture) => {
        calls.push({ code, gesture });
      },
    },
  };
  const result = await lockViaRenderer(fakeWindow, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readState: async () => ({ configured: true, unlocked: false }),
  });

  assert.equal(LOCK_DISPATCH_CODE, "window.dispatchEvent(new Event('sag:lock'))");
  assert.equal(LOCK_VERIFY_DELAY_MS, 1000);
  assert.deepEqual(calls, [{ code: LOCK_DISPATCH_CODE, gesture: true }]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'locked');
  assert.equal(isLockedState({ unlocked: false }), true);
  assert.equal(isLockedState({ unlocked: true }), false);
  assert.equal(isLockedState(null), false);
});

test('tray lock fails without a window, dispatch or a locked state', async () => {
  const noWindow = await lockViaRenderer(null, {});
  assert.equal(noWindow.ok, false);
  assert.equal(noWindow.reason, 'no_window');

  const dispatchFailed = await lockViaRenderer(
    {
      webContents: {
        executeJavaScript: async () => {
          throw new Error('renderer gone');
        },
      },
    },
    {},
  );
  assert.equal(dispatchFailed.ok, false);
  assert.equal(dispatchFailed.reason, 'dispatch_failed');
  assert.equal(dispatchFailed.error, 'renderer gone');

  const stillUnlocked = await lockViaRenderer(
    { webContents: { executeJavaScript: async () => {} } },
    {
      sleep: async () => {},
      readState: async () => ({ configured: true, unlocked: true }),
    },
  );
  assert.equal(stillUnlocked.ok, false);
  assert.equal(stillUnlocked.reason, 'not_locked');

  const noReader = await lockViaRenderer(
    { webContents: { executeJavaScript: async () => {} } },
    { sleep: async () => {} },
  );
  assert.equal(noReader.reason, 'no_state_reader');
});

test('tray lock times out a hung executeJavaScript after 3s', async () => {
  const timers = createManualTimers();
  let stateRead = false;
  const pending = lockViaRenderer(
    {
      webContents: {
        // A renderer that never answers the evaluation must not hang the tray.
        executeJavaScript: () => new Promise(() => {}),
      },
    },
    {
      timers,
      readState: async () => {
        stateRead = true;
        return { unlocked: false };
      },
    },
  );

  assert.equal(LOCK_DISPATCH_TIMEOUT_MS, 3000);
  assert.deepEqual(timers.pendingDelays(), [3000]);
  timers.fire(3000);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dispatch_timeout');
  assert.equal(result.timeoutMs, 3000);
  assert.equal(stateRead, false);
  assert.deepEqual(timers.pendingDelays(), []);
});

// ------------------------------------------------------------- stop core

/** Deterministic timer double: `fire(ms)` runs the first timer with that delay. */
function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(ms) {
      for (const [id, item] of [...pending]) {
        if (item.ms !== ms) continue;
        pending.delete(id);
        item.fn();
        return true;
      }
      return false;
    },
    pendingDelays() {
      return [...pending.values()].map((item) => item.ms);
    },
  };
}

/** Minimal utilityProcess/kill target for the state machine. */
function fakeChild() {
  const kills = [];
  const listeners = new Map();
  const child = {
    pid: 4242,
    kill(signal) {
      kills.push(signal ?? 'SIGTERM');
      return true;
    },
    once(event, listener) {
      listeners.set(event, listener);
      return child;
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    emitExit(code = 0) {
      const listener = listeners.get('exit');
      if (typeof listener === 'function') listener(code);
    },
    hasExitListener() {
      return listeners.has('exit');
    },
    kills,
  };
  return child;
}

test('stop uses a graceful exit when the child leaves within 5s', async () => {
  const child = fakeChild();
  const events = [];
  const stopping = stopChildProcess(child, {
    log: (_level, event) => events.push(event),
  });
  child.emitExit(0);
  const result = await stopping;

  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(child.hasExitListener(), false);
  assert.ok(events.includes('child_stop_requested'));
  assert.ok(events.includes('child_exited'));
});

test('stop escalates at 5s to SIGKILL and gives up after a further 2s', async () => {
  const timers = createManualTimers();
  const child = fakeChild();
  const events = [];
  const stopping = stopChildProcess(child, {
    timers,
    log: (_level, event) => events.push(event),
  });

  assert.equal(STOP_GRACE_MS, 5000);
  assert.equal(STOP_FORCE_MS, 2000);
  assert.deepEqual(timers.pendingDelays(), [5000]);

  timers.fire(5000);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(timers.pendingDelays(), [2000]);

  timers.fire(2000);
  const result = await stopping;
  assert.equal(result.ok, false);
  assert.equal(result.forced, true);
  assert.equal(result.aliveAfter, true);
  assert.ok(events.includes('child_stop_timeout'));
  assert.ok(events.includes('child_force_kill'));
  assert.ok(events.includes('child_stop_failed'));
  assert.equal(child.hasExitListener(), false);
});

test('stop succeeds when the forced kill lands inside the 2s window', async () => {
  const timers = createManualTimers();
  const child = fakeChild();
  const stopping = stopChildProcess(child, { timers });

  timers.fire(5000);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emitExit(137);

  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
  assert.deepEqual(timers.pendingDelays(), []);
  assert.equal(child.hasExitListener(), false);
});

test('stop accepts an injected kill strategy for Electron utilityProcess', async () => {
  const timers = createManualTimers();
  const child = fakeChild();
  const signals = [];
  const stopping = stopChildProcess(child, {
    timers,
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
  });

  assert.deepEqual(signals, ['SIGTERM']);
  timers.fire(5000);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.emitExit(1);

  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
  assert.deepEqual(child.kills, []); // the injected strategy replaced child.kill
});

test('stop treats a missing child as already stopped', async () => {
  assert.deepEqual(await stopChildProcess(null), {
    ok: true,
    skipped: true,
    forced: false,
    aliveAfter: false,
  });
});
