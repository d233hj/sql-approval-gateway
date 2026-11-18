import { spawn } from 'node:child_process';

/**
 * Windows desktop notification for newly created proposals.
 *
 * This module is deliberately best-effort: a toast is a convenience for the
 * operator, never part of the proposal contract. Every failure path returns
 * `false` and every user-controlled value is passed through PowerShell single
 * quotes (with `'` doubled), so proposal creation can never be affected by a
 * notification problem or by content injection.
 */

/** Hard limit: at most one toast every three seconds, globally. */
export const TOAST_MIN_INTERVAL_MS = 3_000;

/** Maximum number of Unicode code points kept from the purpose text. */
export const TOAST_BODY_TEXT_LIMIT = 80;

export const TOAST_TITLE = 'SQL 审批 · 新提案';

/**
 * AUMID used for the toast. Windows 10 1709+ rejects arbitrary AppIds: the
 * notifier must match an AppId registered by Start-menu shortcut or package
 * manifest. PowerShell's own shortcut always exists on Windows, so it is the
 * only reliable choice for an unpackaged gateway. The toast is therefore
 * attributed to "Windows PowerShell" in Action Center.
 */
export const TOAST_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Toast payload. `proposalId` is accepted for call-site correlation and audit
 * only; it is intentionally not rendered and not sent to PowerShell.
 */
export interface NewProposalNotification {
  sourceName: string;
  purpose: string | null;
  proposalId: string;
}

/** Mutable rate-limit state; injectable so tests never touch the shared one. */
export interface ToastRateLimitState {
  lastNotifiedAt: number;
}

export interface ShouldNotifyOptions {
  /** Defaults to `process.platform`; tests pin this. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`; tests pin this. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the module-wide state shared by production calls. */
  state?: ToastRateLimitState;
}

/** A fresh state has never notified (negative infinity is always older). */
export function createToastRateLimitState(): ToastRateLimitState {
  return { lastNotifiedAt: Number.NEGATIVE_INFINITY };
}

const sharedRateLimitState = createToastRateLimitState();

/**
 * Gate for one toast at `now`. Returns true only on win32, unless SAG_TOAST=0,
 * and only when at least three seconds have elapsed since the previous toast.
 * A true result consumes the budget; a false result changes nothing.
 */
export function shouldNotify(
  now: number,
  options: ShouldNotifyOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return false;

  const env = options.env ?? process.env;
  // Opt-in only. The desktop shell shows native notifications; core's toast
  // helper launches a hidden powershell.exe, which HIPS/EDR products flag as
  // suspicious behavior, so it is disabled unless explicitly enabled.
  if (env.SAG_TOAST !== '1') return false;

  const state = options.state ?? sharedRateLimitState;
  if (now - state.lastNotifiedAt < TOAST_MIN_INTERVAL_MS) return false;
  state.lastNotifiedAt = now;
  return true;
}

/** Quote one value as a PowerShell single-quoted literal (`'` -> `''`). */
export function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Keep the visible text short and single-line: control characters become
 * spaces (a newline inside a quoted literal is legal but would break the toast
 * layout), runs of whitespace collapse, and the result is trimmed.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate by Unicode code points so surrogate pairs (emoji) stay intact. */
function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= limit ? value : codePoints.slice(0, limit).join('');
}

/** Body line: `来源名：目的`, with the purpose capped at 80 code points. */
export function buildToastBody(input: NewProposalNotification): string {
  const sourceName = sanitizeText(input.sourceName) || '（未知来源）';
  const purpose =
    truncateCodePoints(sanitizeText(input.purpose ?? ''), TOAST_BODY_TEXT_LIMIT) ||
    '（未填写目的）';
  return `${sourceName}：${purpose}`;
}

/**
 * Build the `-Command` script. Every literal, including the message and the
 * user-derived body, is single-quoted; the script contains no double quotes at
 * all, so nothing is ever interpolated into a command string.
 */
export function buildToastScript(input: NewProposalNotification): string {
  const title = quotePowerShellString(TOAST_TITLE);
  const body = quotePowerShellString(buildToastBody(input));
  const appId = quotePowerShellString(TOAST_APP_ID);
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$texts = $template.GetElementsByTagName('text')",
    `$texts.Item(0).AppendChild($template.CreateTextNode(${title})) > $null`,
    `$texts.Item(1).AppendChild($template.CreateTextNode(${body})) > $null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${appId}).Show($toast)`,
  ].join('\n');
}

/**
 * Spawn options for the toast helper.
 *
 * `detached` and `windowsHide` must both stay off. Verified on Windows 11
 * (2026-11-18): a PowerShell started with either flag (CREATE_NEW_PROCESS_GROUP
 * or CREATE_NO_WINDOW) exits 0 without ever showing the toast, while the same
 * `-Command` succeeds with ordinary spawning. `-WindowStyle Hidden` already
 * keeps the window invisible, and `unref()` keeps the gateway from waiting.
 */
export const TOAST_SPAWN_OPTIONS = {
  stdio: 'ignore' as const,
  detached: false,
  windowsHide: false,
};

/**
 * Fire-and-forget toast. Ignored stdio and `unref()` mean the gateway never
 * waits for PowerShell. Synchronous failures are swallowed; an asynchronous
 * spawn failure (for example powershell.exe missing) is swallowed by the
 * attached error listener, which also prevents an unhandled 'error' event from
 * terminating the gateway.
 */
export function notifyNewProposal(input: NewProposalNotification): boolean {
  try {
    if (!shouldNotify(Date.now())) return false;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', buildToastScript(input)],
      TOAST_SPAWN_OPTIONS,
    );
    child.on('error', () => {
      // Best effort only: a toast failure is never a proposal failure.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
