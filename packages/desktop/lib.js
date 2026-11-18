'use strict';

/**
 * Pure helpers shared by the Electron main process (main.js) and the
 * `node --test` suite (test-helpers.mjs). Nothing here touches Electron or
 * the filesystem (paths are strings; all I/O and timers are injected), so the
 * security-relevant logic can be verified without a GUI (DESIGN §8.2).
 */

const { join } = require('node:path');

const DEFAULT_TARGET_URL = 'http://127.0.0.1:43119';

/** DOM event the tray handler dispatches into the console (no parameters). */
const LOCK_EVENT_NAME = 'sag:lock';
/** Exactly what `webContents.executeJavaScript` evaluates for a tray lock. */
const LOCK_DISPATCH_CODE = `window.dispatchEvent(new Event('${LOCK_EVENT_NAME}'))`;
/** The shell re-reads /v1/admin/state this long after dispatching the event. */
const LOCK_VERIFY_DELAY_MS = 1000;
/** A hung renderer must not stall the tray lock forever. */
const LOCK_DISPATCH_TIMEOUT_MS = 3000;
/** Graceful stop window before the forced kill (FAIL-2). */
const STOP_GRACE_MS = 5000;
/** Wait for the forced kill before declaring the child stuck (FAIL-2). */
const STOP_FORCE_MS = 2000;

/** Only the exact loopback names the gateway itself binds to (§3.2). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

const DEFAULT_SETTINGS = Object.freeze({ minimizeToTray: true });

class TargetUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetUrlError';
    this.code = 'INVALID_TARGET_URL';
  }
}

function normalizeHostname(hostname) {
  return String(hostname).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

/**
 * Parse and validate SAG_URL / the built-in target.
 *
 * Rules:
 * - http only (the core binds a plain loopback HTTP server);
 * - loopback host only (127.0.0.1, localhost, ::1);
 * - explicit port (the port is also passed to a spawned core);
 * - origin only (no credentials, path, query or fragment).
 */
function parseTargetUrl(raw = DEFAULT_TARGET_URL) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TargetUrlError('SAG_URL must be a non-empty http URL');
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new TargetUrlError('SAG_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:') {
    throw new TargetUrlError('SAG_URL must use http:// (TLS is terminated outside the desktop shell)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TargetUrlError('SAG_URL must not contain credentials');
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new TargetUrlError('SAG_URL must point at a loopback address (127.0.0.1, localhost or ::1)');
  }
  if (parsed.port === '') {
    throw new TargetUrlError('SAG_URL must include an explicit port');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TargetUrlError('SAG_URL port must be between 1 and 65535');
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new TargetUrlError('SAG_URL must be an origin only (no path, query or fragment)');
  }
  const origin = `http://${parsed.hostname}:${port}`;
  return {
    href: `${origin}/`,
    origin,
    hostname: normalizeHostname(parsed.hostname),
    port,
  };
}

/** `utilityProcess.fork(coreEntry, buildCoreArgs(...))` argument list. */
function buildCoreArgs({ dataDir, port } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('dataDir is required to start the core');
  }
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new TypeError('port must be an integer between 1 and 65535');
  }
  return ['--data-dir', dataDir, '--port', String(numericPort)];
}

/**
 * Data-directory resolution. A non-empty `SAG_DATA_DIR` pins the shell to the
 * same vault/control database a background service core already uses, so the
 * two can never start cores against different data directories (which would
 * show an empty "setup" screen to a user who already configured the gateway).
 * Without the override the per-user Electron directory is used.
 */
function resolveDataDir(override, fallbackDir, fallbackSource = 'userData') {
  if (typeof fallbackDir !== 'string' || fallbackDir.trim() === '') {
    throw new TypeError('fallbackDir is required');
  }
  if (typeof override === 'string' && override.trim() !== '') {
    return { dir: override.trim(), source: 'env' };
  }
  return { dir: fallbackDir, source: fallbackSource };
}

/**
 * Navigation allow-list: exactly the configured target origin, nothing else.
 * Used by `will-navigate`; malformed URLs are rejected.
 */
function isAllowedNavigation(url, targetOrigin) {
  if (typeof url !== 'string' || typeof targetOrigin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === targetOrigin;
}

/** Persistent desktop-only preferences (never credentials). */
function sanitizeSettings(value) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    minimizeToTray:
      typeof record.minimizeToTray === 'boolean'
        ? record.minimizeToTray
        : DEFAULT_SETTINGS.minimizeToTray,
  };
}

/**
 * Windows login item description. In development `process.execPath` is
 * electron.exe, so the app directory must be passed as the first argument;
 * a packaged build opens the app directly with `--hidden` (tray only, no
 * window — DESIGN §9).
 */
function buildLoginItemSettings(enabled, appPath, isPackaged) {
  const args = isPackaged ? ['--hidden'] : [String(appPath || ''), '--hidden'];
  return { openAtLogin: Boolean(enabled), args };
}

function normalizeHealthPayload(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.ok !== true) return null;
  const payload = {
    ok: true,
    version: typeof body.version === 'string' ? body.version : null,
    pid: Number.isInteger(body.pid) ? body.pid : null,
    started_at: typeof body.started_at === 'string' ? body.started_at : null,
  };
  return payload;
}

/**
 * One GET /v1/health with a hard per-attempt deadline (default 2s, §8.2).
 * Resolves — never rejects — with `{ ok:true, payload }` or
 * `{ ok:false, error }`.
 */
function healthCheck(baseUrl, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 2000));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return Promise.resolve({ ok: false, error: 'fetch_unavailable' });
  }

  const target = `${String(baseUrl).replace(/\/+$/, '')}/v1/health`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  let timer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // Aborting is best effort.
      }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
  });

  const attempt = (async () => {
    try {
      const response = await fetchImpl(target, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response || typeof response.status !== 'number') {
        return { ok: false, error: 'invalid_response' };
      }
      if (response.ok !== true) {
        return { ok: false, error: `http_${response.status}` };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: 'invalid_json' };
      }
      const payload = normalizeHealthPayload(body);
      if (!payload) return { ok: false, error: 'unhealthy', payload: body ?? null };
      return { ok: true, payload };
    } catch (error) {
      return {
        ok: false,
        error: controller && controller.signal.aborted ? 'timeout' : 'network_error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  return Promise.race([attempt, timedOut]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Poll /v1/health until healthy or the total budget expires (15s, §8.2).
 * `check`, `sleep` and `now` are injectable so the timeout path is testable
 * without waiting or starting a GUI.
 */
async function waitForHealth(baseUrl, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 15000));
  const intervalMs = Math.max(0, Number(options.intervalMs ?? 250));
  const attemptTimeoutMs = Math.max(1, Number(options.attemptTimeoutMs ?? 2000));
  const check = typeof options.check === 'function' ? options.check : healthCheck;
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = typeof options.now === 'function' ? options.now : Date.now;

  const deadline = now() + timeoutMs;
  let last = { ok: false, error: 'timeout' };

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) return last;

    last = await check(baseUrl, {
      timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, remaining)),
    });
    if (last && last.ok) return last;

    const left = deadline - now();
    if (left <= 0) return last;
    await sleep(Math.min(intervalMs, left));
  }

  return last;
}

/* -------------------------------------------------- endpoint discovery (G-08) */

/**
 * Parses `<dataDir>/endpoint.json` (written by core: `{url, pid, version,
 * startedAt?}`). Returns `null` unless the record names a positive pid, a
 * non-empty version and an origin-only loopback http URL. Pure: accepts the
 * raw JSON string or an already-parsed object.
 */
function parseEndpoint(value) {
  let record = value;
  if (typeof value === 'string') {
    try {
      record = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const pid = record.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const version = record.version;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof record.url !== 'string') return null;

  let target;
  try {
    target = parseTargetUrl(record.url);
  } catch {
    return null;
  }
  return {
    url: target.origin,
    port: target.port,
    pid,
    version,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
  };
}

/**
 * G-08: `/v1/health` must report the same pid and version as endpoint.json.
 * An empty array means the two agree.
 */
function endpointProblems(endpoint, healthPayload) {
  if (!endpoint) return ['endpoint.json is missing or malformed'];
  if (!healthPayload || typeof healthPayload !== 'object' || healthPayload.ok !== true) {
    return ['health payload is not healthy'];
  }
  const problems = [];
  if (endpoint.pid !== healthPayload.pid) {
    problems.push(
      `pid endpoint=${String(endpoint.pid)} health=${String(healthPayload.pid)}`,
    );
  }
  if (endpoint.version !== healthPayload.version) {
    problems.push(
      `version endpoint=${String(endpoint.version)} health=${String(healthPayload.version)}`,
    );
  }
  return problems;
}

/**
 * Startup port discovery (FAIL-3): prefer a verified endpoint.json, and let
 * the caller fall back to SAG_URL / the default port when the file is missing,
 * malformed, the described core is unhealthy, or pid/version disagree.
 *
 * `readFile(path)` returns the file text or null; `check(url)` returns the
 * `{ok, payload}` shape of `healthCheck`. Both are injected so this stays pure.
 */
async function resolveEndpointTarget(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return { ok: false, reason: 'no_data_dir' };
  }
  const endpointPath = join(dataDir, 'endpoint.json');

  let raw = null;
  try {
    if (typeof options.readFile === 'function') raw = await options.readFile(endpointPath);
  } catch {
    raw = null;
  }
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'missing', endpointPath };
  }
  const endpoint = parseEndpoint(raw);
  if (!endpoint) return { ok: false, reason: 'malformed', endpointPath };
  if (typeof options.check !== 'function') {
    return { ok: false, reason: 'no_health_check', endpointPath, endpoint };
  }

  let health;
  try {
    health = await options.check(endpoint.url);
  } catch (error) {
    return {
      ok: false,
      reason: 'unhealthy',
      endpointPath,
      endpoint,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!health || health.ok !== true) {
    return { ok: false, reason: 'unhealthy', endpointPath, endpoint, health: health ?? null };
  }

  const problems = endpointProblems(endpoint, health.payload);
  if (problems.length > 0) {
    return {
      ok: false,
      reason: 'mismatch',
      endpointPath,
      endpoint,
      health,
      problems,
    };
  }

  return {
    ok: true,
    reason: 'verified',
    endpointPath,
    endpoint,
    health,
    target: parseTargetUrl(endpoint.url),
  };
}

/* ------------------------------------------------------ tray lock (FAIL-1) */

/** `/v1/admin/state` says the vault is locked. */
function isLockedState(state) {
  return Boolean(state) && typeof state === 'object' && state.unlocked === false;
}

/**
 * Tray lock without holding a session in the main process: evaluate the
 * no-argument `sag:lock` event inside the console (which owns the CSRF token),
 * wait for the console to finish, then let the caller re-read /v1/admin/state.
 *
 * The evaluation itself is bounded (3s): a hung renderer resolves as
 * `dispatch_timeout` instead of stalling the tray. `window` is a fake-able
 * `{ webContents: { executeJavaScript(code, gesture) } }`; `readState()`,
 * `sleep` and `timers` are injected so tests do not wait.
 */
async function lockViaRenderer(window, options = {}) {
  const contents = window && window.webContents;
  if (!contents || typeof contents.executeJavaScript !== 'function') {
    return { ok: false, reason: 'no_window' };
  }

  const dispatchTimeoutMs = Math.max(
    1,
    Number(options.dispatchTimeoutMs ?? LOCK_DISPATCH_TIMEOUT_MS),
  );
  const timers =
    options.timers && typeof options.timers.setTimeout === 'function'
      ? options.timers
      : { setTimeout, clearTimeout };

  let timedOut = false;
  let dispatchTimer = null;
  const dispatched = Promise.resolve().then(() =>
    contents.executeJavaScript(LOCK_DISPATCH_CODE, true),
  );
  const deadline = new Promise((_resolve, reject) => {
    dispatchTimer = timers.setTimeout(() => {
      timedOut = true;
      reject(new Error('executeJavaScript_timeout'));
    }, dispatchTimeoutMs);
  });

  try {
    await Promise.race([dispatched, deadline]);
  } catch (error) {
    if (timedOut) {
      return { ok: false, reason: 'dispatch_timeout', timeoutMs: dispatchTimeoutMs };
    }
    return {
      ok: false,
      reason: 'dispatch_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (dispatchTimer !== null) timers.clearTimeout(dispatchTimer);
  }

  const delayMs = Math.max(0, Number(options.verifyDelayMs ?? LOCK_VERIFY_DELAY_MS));
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(delayMs);

  if (typeof options.readState !== 'function') {
    return { ok: false, reason: 'no_state_reader', delayMs };
  }
  let state;
  try {
    state = await options.readState();
  } catch (error) {
    return {
      ok: false,
      reason: 'state_unavailable',
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (isLockedState(state)) return { ok: true, reason: 'locked', delayMs, state };
  return { ok: false, reason: 'not_locked', delayMs, state: state ?? null };
}

/* -------------------------------------------------- two-phase stop (FAIL-2) */

/**
 * Stop state machine: graceful `kill('SIGTERM')`, wait `graceTimeoutMs`
 * (5s), force `kill('SIGKILL')`, wait `forceTimeoutMs` (2s). Resolves with
 * `{ok:false, forced:true, aliveAfter:true}` when the child outlives both
 * windows, so main.js can log and show one error box.
 *
 * `child` only needs `kill(signal?)`, `once('exit', fn)` and
 * `removeListener('exit', fn)` — a fake child in tests. Timers and the kill
 * call are injectable; `log(level, event, detail)` receives transitions.
 */
function stopChildProcess(child, options = {}) {
  const graceTimeoutMs = Math.max(0, Number(options.graceTimeoutMs ?? STOP_GRACE_MS));
  const forceTimeoutMs = Math.max(0, Number(options.forceTimeoutMs ?? STOP_FORCE_MS));
  const timers =
    options.timers && typeof options.timers.setTimeout === 'function'
      ? options.timers
      : { setTimeout, clearTimeout };
  const report = typeof options.log === 'function' ? options.log : () => {};
  const kill =
    typeof options.kill === 'function'
      ? options.kill
      : (signal) => {
          try {
            return child.kill(signal) !== false;
          } catch {
            return false;
          }
        };

  return new Promise((resolve) => {
    if (!child || typeof child.kill !== 'function') {
      resolve({ ok: true, skipped: true, forced: false, aliveAfter: false });
      return;
    }

    let finished = false;
    let forced = false;
    let gracefulAccepted = false;
    let forceAccepted = false;
    let graceTimer = null;
    let forceTimer = null;

    const removeExitListener = () => {
      if (typeof child.removeListener === 'function') child.removeListener('exit', onExit);
      else if (typeof child.off === 'function') child.off('exit', onExit);
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (graceTimer !== null) timers.clearTimeout(graceTimer);
      if (forceTimer !== null) timers.clearTimeout(forceTimer);
      graceTimer = null;
      forceTimer = null;
      removeExitListener();
      resolve({ ...result, gracefulAccepted, forceAccepted });
    };
    function onExit(code) {
      report('info', 'child_exited', { code: code ?? null, forced });
      finish({ ok: true, forced, aliveAfter: false });
    }

    child.once('exit', onExit);
    try {
      gracefulAccepted = kill('SIGTERM') !== false;
    } catch (error) {
      report('warn', 'child_kill_failed', {
        signal: 'SIGTERM',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    report('info', 'child_stop_requested', { signal: 'SIGTERM', accepted: gracefulAccepted });
    if (finished) return;

    graceTimer = timers.setTimeout(() => {
      graceTimer = null;
      if (finished) return;
      forced = true;
      report('warn', 'child_stop_timeout', { timeout_ms: graceTimeoutMs });
      try {
        forceAccepted = kill('SIGKILL') !== false;
      } catch (error) {
        report('warn', 'child_kill_failed', {
          signal: 'SIGKILL',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      report('warn', 'child_force_kill', { signal: 'SIGKILL', accepted: forceAccepted });
      if (finished) return;

      forceTimer = timers.setTimeout(() => {
        forceTimer = null;
        if (finished) return;
        report('error', 'child_stop_failed', {
          grace_ms: graceTimeoutMs,
          force_ms: forceTimeoutMs,
          alive_after: true,
        });
        finish({ ok: false, forced: true, aliveAfter: true });
      }, forceTimeoutMs);
    }, graceTimeoutMs);
  });
}

exports.DEFAULT_TARGET_URL = DEFAULT_TARGET_URL;
exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
exports.TargetUrlError = TargetUrlError;
exports.isLoopbackHostname = isLoopbackHostname;
exports.parseTargetUrl = parseTargetUrl;
exports.buildCoreArgs = buildCoreArgs;
exports.resolveDataDir = resolveDataDir;
exports.isAllowedNavigation = isAllowedNavigation;
exports.sanitizeSettings = sanitizeSettings;
exports.buildLoginItemSettings = buildLoginItemSettings;
exports.healthCheck = healthCheck;
exports.waitForHealth = waitForHealth;
exports.LOCK_EVENT_NAME = LOCK_EVENT_NAME;
exports.LOCK_DISPATCH_CODE = LOCK_DISPATCH_CODE;
exports.LOCK_VERIFY_DELAY_MS = LOCK_VERIFY_DELAY_MS;
exports.LOCK_DISPATCH_TIMEOUT_MS = LOCK_DISPATCH_TIMEOUT_MS;
exports.STOP_GRACE_MS = STOP_GRACE_MS;
exports.STOP_FORCE_MS = STOP_FORCE_MS;
exports.parseEndpoint = parseEndpoint;
exports.endpointProblems = endpointProblems;
exports.resolveEndpointTarget = resolveEndpointTarget;
exports.isLockedState = isLockedState;
exports.lockViaRenderer = lockViaRenderer;
exports.stopChildProcess = stopChildProcess;
