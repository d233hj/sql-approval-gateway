'use strict';

/**
 * SQL Approval Gateway — Windows desktop shell (DESIGN §8.2).
 *
 * The shell loads the SPA hosted by core. Core is either reused (an existing
 * healthy instance on the target origin) or spawned as an Electron
 * utilityProcess using the built CLI entry point.
 *
 * This file is CommonJS on purpose: packages/desktop/package.json has no
 * "type":"module", so Electron's main process and the empty sandboxed preload
 * both load as CommonJS.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  utilityProcess,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// A parent Electron host (e.g. DSH) may export ELECTRON_RUN_AS_NODE=1. In that
// mode `require('electron')` is not the Electron API; fail with a clear hint
// instead of a TypeError deep inside main().
if (!app || typeof app.setName !== 'function') {
  process.stderr.write(
    'SQL Approval Gateway must run under Electron. ' +
      'Unset ELECTRON_RUN_AS_NODE (or run the packaged app) before starting it.\n',
  );
  process.exit(1);
}

const {
  DEFAULT_TARGET_URL,
  LOCK_VERIFY_DELAY_MS,
  STOP_FORCE_MS,
  STOP_GRACE_MS,
  buildCoreArgs,
  buildLoginItemSettings,
  endpointProblems,
  healthCheck,
  isAllowedNavigation,
  lockViaRenderer,
  parseEndpoint,
  parseTargetUrl,
  resolveDataDir,
  resolveEndpointTarget,
  sanitizeSettings,
  stopChildProcess,
  waitForHealth,
} = require('./lib.js');

const APP_NAME = 'SQL Approval Gateway';
const APP_USER_MODEL_ID = 'com.sqlapproval.gateway';
const CORE_ENTRY_RELATIVE = path.join('..', 'core', 'dist', 'src', 'cli.js');
const HEALTH_INITIAL_TIMEOUT_MS = 2000;
const HEALTH_START_TIMEOUT_MS = 15000;
const LOCK_STATE_TIMEOUT_MS = 2000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const START_HIDDEN = process.argv.includes('--hidden');

app.setName(APP_NAME);

let target = null;
let mainWindow = null;
let tray = null;
let coreChild = null;
let coreExited = false;
let coreStopPromise = null;
let coreStopDone = false;
let coreStopErrorShown = false;
let isQuitting = false;
let settings = sanitizeSettings(null);

let logFilePath = '';
let logBytes = 0;
let dataDir = '';
let settingsPath = '';
let coreEntry = '';

// --------------------------------------------------------------- logging

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ event: 'log_serialize_failed' });
  }
}

function rotateLogIfNeeded(nextBytes) {
  if (logBytes === 0 || logBytes + nextBytes <= LOG_ROTATE_BYTES) return;
  try {
    fs.rmSync(`${logFilePath}.1`, { force: true });
    fs.renameSync(logFilePath, `${logFilePath}.1`);
  } catch {
    // Rotation is best effort; keep appending rather than losing the event.
  }
  logBytes = 0;
}

function log(level, event, detail) {
  const record = {
    ...(detail && typeof detail === 'object' ? detail : {}),
    ts: new Date().toISOString(),
    level,
    event,
  };
  const line = `${safeJson(record)}\n`;
  if (!logFilePath) return;
  const bytes = Buffer.byteLength(line, 'utf8');
  rotateLogIfNeeded(bytes);
  try {
    fs.appendFileSync(logFilePath, line, 'utf8');
    logBytes += bytes;
  } catch {
    // Logging must never take the shell down.
  }
}

function initLogging() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // If the directory cannot be created there is nowhere to log; continue.
  }
  logFilePath = path.join(logDir, 'desktop.log');
  logBytes = 0;
  try {
    const stat = fs.statSync(logFilePath);
    logBytes = stat.size;
    if (logBytes > LOG_ROTATE_BYTES) {
      fs.rmSync(`${logFilePath}.1`, { force: true });
      fs.renameSync(logFilePath, `${logFilePath}.1`);
      logBytes = 0;
    }
  } catch {
    // No existing log file yet.
  }
}

function appendCoreOutput(stream, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      log('info', 'core_output', { source: 'core', stream, line: trimmed.slice(0, 2000) });
    }
  }
}

// --------------------------------------------------------------- settings

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'desktop-settings.json');
  try {
    settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch {
    settings = sanitizeSettings(null);
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('warn', 'settings_write_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// --------------------------------------------------------------- core

function startCore() {
  if (!fs.existsSync(coreEntry)) {
    return {
      ok: false,
      message:
        `未找到 core 入口：\n${coreEntry}\n\n` +
        '请先在仓库根目录运行：npm run build -w @sql-approval/core',
    };
  }

  let args;
  try {
    args = buildCoreArgs({ dataDir, port: target.port });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      message: `无法创建数据目录：${dataDir}\n${error instanceof Error ? error.message : String(error)}`,
    };
  }

  log('info', 'core_spawn_requested', { entry: coreEntry, args });
  try {
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // Packaged builds carry core/web/shared outside the asar; the server must
    // serve the bundled SPA instead of looking for a monorepo build output.
    if (app.isPackaged) childEnv.SAG_WEB_DIST = path.join(process.resourcesPath, 'web', 'dist');
    // The desktop shell shows native notifications from the renderer. Disabling
    // core's hidden-PowerShell toast keeps HIPS/EDR products from flagging the
    // gateway for a "hidden PowerShell" action.
    childEnv.SAG_TOAST = '0';
    coreChild = utilityProcess.fork(coreEntry, args, {
      cwd: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..'),
      env: childEnv,
      stdio: 'pipe',
      serviceName: 'sql-approval-core',
    });
  } catch (error) {
    coreChild = null;
    return {
      ok: false,
      message: `utilityProcess.fork 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  coreExited = false;
  if (coreChild.stdout) coreChild.stdout.on('data', (chunk) => appendCoreOutput('stdout', chunk));
  if (coreChild.stderr) coreChild.stderr.on('data', (chunk) => appendCoreOutput('stderr', chunk));
  coreChild.on('spawn', () => {
    log('info', 'core_spawned', { pid: coreChild ? coreChild.pid : null });
  });
  coreChild.on('exit', (code) => {
    coreExited = true;
    coreChild = null;
    log('info', 'core_exited', { code });
    if (!isQuitting) {
      log('warn', 'core_exited_unexpectedly', { code });
    }
  });
  return { ok: true };
}

/**
 * Stops the spawned core with a bounded two-phase state machine (FAIL-2):
 * graceful kill, wait 5s, hard kill, wait 2s. A child that survives both
 * windows is logged and reported to the user exactly once. `before-quit`
 * awaits this promise, so no core process is left behind.
 */
async function stopCore() {
  if (coreStopPromise) return coreStopPromise;
  const child = coreChild;
  if (!child || coreExited) {
    coreStopPromise = Promise.resolve({ ok: true, skipped: true, forced: false });
    return coreStopPromise;
  }

  // Electron's UtilityProcess.kill() takes no signal argument, so the handle
  // adapts it: graceful stop uses kill(), the forced stop maps SIGKILL to
  // process.kill(pid, 'SIGKILL') — TerminateProcess on Windows.
  const handle = {
    pid: child.pid,
    once: (event, listener) => child.once(event, listener),
    removeListener: (event, listener) => child.removeListener(event, listener),
    kill: (signal) => {
      try {
        if (signal === 'SIGKILL') {
          if (!Number.isInteger(child.pid)) return false;
          process.kill(child.pid, 'SIGKILL');
          return true;
        }
        return child.kill() !== false;
      } catch (error) {
        log('warn', 'core_kill_failed', {
          signal: signal ?? 'SIGTERM',
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };

  log('info', 'core_stop_requested', {
    pid: child.pid ?? null,
    grace_ms: STOP_GRACE_MS,
    force_ms: STOP_FORCE_MS,
  });

  coreStopPromise = stopChildProcess(handle, {
    graceTimeoutMs: STOP_GRACE_MS,
    forceTimeoutMs: STOP_FORCE_MS,
    log: (level, event, detail) => log(level, event, detail),
  }).then((result) => {
    if (result.ok) {
      log('info', 'core_stopped', {
        forced: result.forced === true,
        pid: child.pid ?? null,
      });
    } else {
      log('error', 'core_stop_failed', {
        pid: child.pid ?? null,
        alive_after: result.aliveAfter === true,
        grace_ms: STOP_GRACE_MS,
        force_ms: STOP_FORCE_MS,
      });
      showCoreStopError(child.pid ?? null);
    }
    return result;
  });
  return coreStopPromise;
}

/** One error box per run: the core survived SIGTERM and the forced kill. */
function showCoreStopError(pid) {
  if (coreStopErrorShown) return;
  coreStopErrorShown = true;
  const detail = [
    'core 进程在收到正常停止信号和强制结束信号后仍未退出。',
    `PID：${pid ?? 'unknown'}`,
    '请从任务管理器结束该进程，或重启系统后再试。',
    '',
    `日志：${logFilePath}`,
  ].join('\n');
  try {
    dialog.showErrorBox(`${APP_NAME} — core 未能退出`, detail);
  } catch {
    // A quitting shell may no longer be able to show a dialog.
  }
}

/**
 * G-08: when endpoint.json exists it must describe the same process and
 * version that /v1/health just reported. A missing file means a core started
 * with a different data directory; that is warned about and reused.
 */
function verifyEndpoint(healthPayload) {
  const endpointPath = path.join(dataDir, 'endpoint.json');
  let raw;
  try {
    raw = fs.readFileSync(endpointPath, 'utf8');
  } catch {
    log('warn', 'endpoint_missing', { path: endpointPath });
    return null;
  }

  const endpoint = parseEndpoint(raw);
  if (!endpoint) {
    log('warn', 'endpoint_malformed', { path: endpointPath });
    return null;
  }

  const problems = endpointProblems(endpoint, healthPayload);
  if (endpoint.port !== target.port) {
    problems.push(`url endpoint=${endpoint.url} target=${target.origin}`);
  }
  if (problems.length > 0) {
    log('error', 'endpoint_mismatch', { problems });
    return `endpoint.json 与 /v1/health 不一致（G-08），拒绝连接：\n${problems.join('\n')}`;
  }
  log('info', 'endpoint_verified', {
    pid: healthPayload.pid,
    version: healthPayload.version,
  });
  return null;
}

// --------------------------------------------------------------- window

function installWebContentsGuards() {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url, target.origin)) {
        event.preventDefault();
        log('warn', 'navigation_blocked', { url });
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url, target.origin)) {
        event.preventDefault();
        log('warn', 'redirect_blocked', { url });
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      log('warn', 'window_open_blocked', { url });
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      log('warn', 'webview_blocked');
    });
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'app.ico'),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // Closing the window keeps the shell (and core) alive in the tray unless the
  // user disabled that preference. Quit from the tray sets isQuitting first.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      log('info', 'window_hidden_to_tray');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log('error', 'spa_load_failed', { code, description, url });
    dialog.showErrorBox(
      'SQL Approval Gateway — 页面加载失败',
      [
        `无法加载审批台：${target.href}`,
        `错误：${description} (${code})`,
        '',
        `日志：${logFilePath}`,
      ].join('\n'),
    );
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'renderer_gone', { reason: details.reason, exitCode: details.exitCode });
  });

  mainWindow.loadURL(target.href).catch((error) => {
    log('error', 'load_url_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return mainWindow;
}

function showWindow() {
  if (!target) return;
  const window = createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    log('warn', 'tray_icon_missing', { path: iconPath });
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  rebuildTrayMenu();
}

function getLoginItemEnabled() {
  try {
    const { args } = buildLoginItemSettings(false, app.getAppPath(), app.isPackaged);
    return app.getLoginItemSettings({ args }).openAtLogin === true;
  } catch {
    return false;
  }
}

function setLoginItem(enabled) {
  try {
    app.setLoginItemSettings(buildLoginItemSettings(enabled, app.getAppPath(), app.isPackaged));
    log('info', 'login_item_updated', { enabled, packaged: app.isPackaged });
  } catch (error) {
    log('error', 'login_item_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    dialog.showErrorBox(
      'SQL Approval Gateway — 开机自启设置失败',
      `${error instanceof Error ? error.message : String(error)}\n\n日志：${logFilePath}`,
    );
  }
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开审批台', click: showWindow },
    {
      label: '锁定',
      click: () => {
        void lockGateway();
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getLoginItemEnabled(),
      click: (item) => setLoginItem(item.checked),
    },
    {
      label: '关闭窗口时最小化到托盘',
      type: 'checkbox',
      checked: settings.minimizeToTray,
      click: (item) => {
        settings = sanitizeSettings({ ...settings, minimizeToTray: item.checked });
        saveSettings();
        rebuildTrayMenu();
        log('info', 'minimize_to_tray_updated', { enabled: settings.minimizeToTray });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

/** Renderer -> main notification bridge (only our own window may use it). */
function registerNotificationBridge() {
  ipcMain.on('sag:notify', (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== mainWindow.webContents) return;
    const title =
      payload && typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'SQL 审批 · 新提案';
    const body = payload && typeof payload.body === 'string' ? payload.body.trim().slice(0, 300) : '';
    if (body === '') return;
    log('info', 'notification_requested', { title });
    showNotification(title, body);
  });
}

/**
 * Native Windows toast. Unpackaged Electron apps only get toasts when their
 * AUMID matches a Start Menu shortcut, which `ensureNotificationShortcut`
 * creates once. If Windows refuses, fall back to a tray balloon.
 */
function showNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
      return;
    }
  } catch (error) {
    log('warn', 'notification_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  notifyFromTray(title, body);
}

/**
 * Register the app's AUMID through a Start Menu shortcut so Windows accepts its
 * toasts. Idempotent and best effort: failure never affects the console.
 */
function ensureNotificationShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const programs = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    );
    fs.mkdirSync(programs, { recursive: true });
    const linkPath = path.join(programs, `${APP_NAME}.lnk`);
    const written = shell.writeShortcutLink(linkPath, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
      description: APP_NAME,
      appUserModelId: APP_USER_MODEL_ID,
    });
    log(written ? 'info' : 'warn', 'notification_shortcut', { path: linkPath, written });
  } catch (error) {
    log('warn', 'notification_shortcut_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Tray balloon (Windows) with a best-effort Notification fallback. */
function notifyFromTray(title, content) {
  try {
    if (
      tray &&
      !tray.isDestroyed() &&
      typeof tray.displayBalloon === 'function' &&
      process.platform === 'win32'
    ) {
      tray.displayBalloon({ title, content });
      return;
    }
  } catch (error) {
    log('warn', 'tray_balloon_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body: content }).show();
      return;
    }
  } catch (error) {
    log('warn', 'notification_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  log('warn', 'notify_failed', { title, content });
}

/** GET /v1/admin/state (cookie-only, non-mutating) with a hard timeout. */
async function readAdminState() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      controller?.abort();
    } catch {
      // Aborting is best effort.
    }
  }, LOCK_STATE_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(`${target.origin}/v1/admin/state`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      log('warn', 'lock_state_http_error', { status: response.status });
      return null;
    }
    return await response.json();
  } catch (error) {
    log('warn', 'lock_state_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tray-initiated lock (FAIL-1). The SPA holds the session and CSRF tokens in
 * memory, so the main process does not mint a request: it dispatches the
 * no-argument `sag:lock` DOM event into the console, waits 1s, then judges
 * success by re-reading /v1/admin/state (`unlocked=false`). A cookie-only
 * /v1/admin/lock call would be rejected by core with 403 and is gone.
 */
async function lockGateway() {
  log('info', 'lock_requested', { source: 'tray' });
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!window) {
    log('warn', 'lock_no_window');
    notifyFromTray(APP_NAME, '请先打开审批台解锁后再锁定');
    return { ok: false, reason: 'no_window' };
  }

  const result = await lockViaRenderer(window, {
    verifyDelayMs: LOCK_VERIFY_DELAY_MS,
    readState: readAdminState,
  });
  log(result.ok ? 'info' : 'error', 'lock_result', {
    ok: result.ok,
    reason: result.reason,
    state: result.state ?? null,
    delay_ms: result.delayMs ?? null,
    timeout_ms: result.timeoutMs ?? null,
  });

  if (result.ok) {
    showWindow();
    return result;
  }
  if (result.reason === 'not_locked') {
    notifyFromTray(APP_NAME, '锁定未生效：core 仍处于解锁状态，请重试');
  } else if (result.reason === 'dispatch_timeout') {
    notifyFromTray(APP_NAME, '锁定超时：审批台未响应，请重试');
  } else {
    notifyFromTray(APP_NAME, '无法通过审批台锁定，请重试');
  }
  return result;
}

// --------------------------------------------------------------- startup

function failStartup(message) {
  log('error', 'startup_failed', { message });
  if (isQuitting) return;
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title: `${APP_NAME} — 启动失败`,
      message: '无法连接或启动本地 core 服务',
      detail: [
        `目标：${target ? target.origin : DEFAULT_TARGET_URL}`,
        `数据目录：${dataDir || '(未初始化)'}`,
        `core 入口：${coreEntry || '(未初始化)'}`,
        `日志：${logFilePath || '(未初始化)'}`,
        '',
        message,
      ].join('\n'),
      buttons: ['退出'],
      noLink: true,
    });
  } catch {
    dialog.showErrorBox(`${APP_NAME} — 启动失败`, `${message}\n\n日志：${logFilePath}`);
  }
  app.quit();
}

async function bootstrap() {
  initLogging();
  loadSettings();

  log('info', 'app_start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    argv: process.argv.slice(1),
  });

  try {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  } catch {
    // Optional on non-Windows.
  }

  const userData = app.getPath('userData');
  // Portable builds keep their data next to the .exe (PORTABLE_EXECUTABLE_DIR
  // is set by electron-builder's portable target); an installed build uses the
  // per-user directory. SAG_DATA_DIR still wins over both.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const isPortable = app.isPackaged && typeof portableDir === 'string' && portableDir.trim() !== '';
  const fallbackDataDir = isPortable
    ? path.join(portableDir.trim(), 'data')
    : path.join(userData, 'data');
  const resolvedDataDir = resolveDataDir(process.env.SAG_DATA_DIR, fallbackDataDir, isPortable ? 'portable' : 'userData');
  dataDir = path.resolve(resolvedDataDir.dir);
  log('info', 'data_dir_resolved', { data_dir: dataDir, source: resolvedDataDir.source });
  // Packaged builds bundle core/web/shared under resources; the dev run keeps
  // the monorepo-relative entry point.
  coreEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'core', 'dist', 'src', 'cli.js')
    : path.resolve(__dirname, CORE_ENTRY_RELATIVE);

  // Renderer security checklist (DESIGN §8.2): every permission is denied
  // except Web Notifications for the gateway's own origin — the console uses
  // them for "new proposal" toasts when the window is in the tray.
  try {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const url = details && details.requestingUrl ? details.requestingUrl : '';
      if (permission === 'notifications' && target && isAllowedNavigation(url, target.origin)) {
        log('info', 'permission_granted', { permission, origin: url });
        callback(true);
        return;
      }
      log('warn', 'permission_denied', {
        permission,
        origin: details && details.requestingUrl ? details.requestingUrl : null,
      });
      callback(false);
    });
    defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      if (permission === 'notifications' && target && requestingOrigin === target.origin) {
        return true;
      }
      log('warn', 'permission_check_denied', { permission, origin: requestingOrigin });
      return false;
    });
  } catch (error) {
    log('error', 'permission_handler_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  installWebContentsGuards();

  // FAIL-3 port discovery: <dataDir>/endpoint.json (written by core with the
  // very same --data-dir we pass) wins over SAG_URL; a file that does not
  // verify against /v1/health falls back to SAG_URL / the default port.
  const discovered = await resolveEndpointTarget({
    dataDir,
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    check: (origin) => healthCheck(origin, { timeoutMs: HEALTH_INITIAL_TIMEOUT_MS }),
  });

  let health = null;
  let targetFromEndpoint = false;
  if (discovered.ok) {
    target = discovered.target;
    health = discovered.health;
    targetFromEndpoint = true;
    log('info', 'endpoint_discovered', {
      url: target.origin,
      pid: discovered.endpoint.pid,
      version: discovered.endpoint.version,
      path: discovered.endpointPath,
    });
  } else {
    log('info', 'endpoint_unavailable', {
      reason: discovered.reason,
      path: discovered.endpointPath ?? null,
      problems: discovered.problems ?? null,
    });
    try {
      target = parseTargetUrl(process.env.SAG_URL ?? DEFAULT_TARGET_URL);
    } catch (error) {
      failStartup(error instanceof Error ? error.message : String(error));
      return;
    }
    log('info', 'target_resolved', {
      origin: target.origin,
      data_dir: dataDir,
      source: 'fallback',
    });
    health = await healthCheck(target.origin, { timeoutMs: HEALTH_INITIAL_TIMEOUT_MS });
    log('info', 'health_probe', { ok: health.ok, error: health.error ?? null });
  }

  if (!health.ok) {
    const started = startCore();
    if (!started.ok) {
      failStartup(started.message);
      return;
    }
    health = await waitForHealth(target.origin, {
      timeoutMs: HEALTH_START_TIMEOUT_MS,
      intervalMs: 250,
      attemptTimeoutMs: 1500,
    });
    log('info', 'health_after_spawn', { ok: health.ok, error: health.error ?? null });
  }

  if (!health.ok) {
    failStartup(
      `core 在 ${HEALTH_START_TIMEOUT_MS / 1000} 秒内未通过 /v1/health。\n` +
        `端口：${target.port}\n` +
        `最后一次错误：${health.error ?? 'unknown'}\n` +
        '请检查日志中的 core_output 行，并确认端口未被其他程序占用。',
    );
    return;
  }

  if (!targetFromEndpoint) {
    const endpointError = verifyEndpoint(health.payload);
    if (endpointError) {
      failStartup(endpointError);
      return;
    }
  }

  if (isQuitting) return;
  registerNotificationBridge();
  ensureNotificationShortcut();
  // A single-purpose console: the default File/Edit/View menu only adds noise
  // and exposes zoom/devtools shortcuts the shell deliberately does not offer.
  Menu.setApplicationMenu(null);
  createTray();
  if (!START_HIDDEN) showWindow();
  log('info', 'app_ready', {
    origin: target.origin,
    data_dir: dataDir,
    hidden: START_HIDDEN,
  });
}

// --------------------------------------------------------------- lifecycle

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // A second launch only asks the first instance to focus its window.
  app.quit();
} else {
  app.on('second-instance', () => {
    log('info', 'second_instance');
    if (app.isReady() && target) showWindow();
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (coreStopDone) return;
    if (!coreChild || coreExited) {
      coreStopDone = true;
      return;
    }
    // Never let the app exit while the core stop sequence is still running:
    // the event is cancelled until stopCore() has settled (FAIL-2).
    event.preventDefault();
    log('info', 'quit_waiting_for_core', { pid: coreChild.pid ?? null });
    if (coreStopPromise) return;
    void stopCore().finally(() => {
      coreStopDone = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // Tray-resident shells stay alive; without the preference, closing the
    // window quits and stops a core started by this shell.
    if (!settings.minimizeToTray) app.quit();
  });

  app.on('activate', () => {
    if (app.isReady() && target) showWindow();
  });

  process.on('uncaughtException', (error) => {
    log('error', 'uncaught_exception', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      log('error', 'bootstrap_failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      });
      failStartup(error instanceof Error ? error.message : String(error));
    });
}

