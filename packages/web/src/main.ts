/**
 * SQL Approval Gateway — approval console SPA (dependency-free).
 *
 * Rendering uses DOM APIs and `textContent` only: no persistence APIs, no
 * third-party assets, no HTML string sinks. SQL is highlighted by the small
 * tokenizer below; every token is a `<span>` with a `tok-*` class.
 */

import { ApiError, adminAuthHeaders, api, isEmbeddedMode, setCsrfToken } from './api.js';
import { formatDateTime, formatRelative } from './format.js';
import {
  DEFAULT_SETTINGS,
  PROPOSAL_STATUSES,
  STATUS_LABELS,
} from './types.js';
import type {
  ApproveResponse,
  ClientCreateResponse,
  ClientSummary,
  Proposal,
  ProposalStatus,
  ProposalsQuery,
  ResultPage,
  SettingKey,
  SettingRange,
  SettingsSnapshot,
  SettingsValues,
  SourceConnectionInput,
  SourceCreateInput,
  SourceDialect,
  SourceSummary,
  SourceTestResult,
  SourceUpdateInput,
} from './types.js';

/* --------------------------------------------------------------- constants */

const IDLE_CHECK_MS = 60 * 1000;
const COUNTDOWN_TICK_MS = 1000;
const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const SESSION_MESSAGE = '会话未建立，请重新解锁';
/** Live console stream: reconnect backoff, quiet-failure threshold, banner. */
const LIVE_BACKOFF_MS = [1000, 2000, 5000, 10000];
const LIVE_FAILURE_LIMIT = 3;
const LIVE_LIST_LIMIT = 100;
const LIVE_REFRESH_DEBOUNCE_MS = 150;
const NOTICE_AUTO_HIDE_MS = 5000;

const SOURCE_DIALECTS: SourceDialect[] = ['sqlite', 'mssql', 'postgres', 'mysql'];
const DIALECT_LABELS: Record<SourceDialect, string> = {
  sqlite: 'SQLite',
  mssql: 'SQL Server',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
};
const DEFAULT_PORTS: Record<SourceDialect, string> = {
  sqlite: '',
  mssql: '1433',
  postgres: '5432',
  mysql: '3306',
};

const KEYWORDS = new Set<string>([
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'ON',
  'GROUP',
  'BY',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IN',
  'LIKE',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'UNION',
  'ALL',
  'DISTINCT',
  'TOP',
  'INSERT',
  'UPDATE',
  'DELETE',
  'SET',
  'VALUES',
  'INTO',
]);

const OPERATOR_CHARS = '+-*/%=<>!|&^~?:,.;()[]{}@#';

/* ------------------------------------------------------------------- types */

type View = 'pending' | 'all';
type Phase = 'boot' | 'setup' | 'unlock' | 'shell';
type Screen = 'console' | 'settings';

interface SourceFormState {
  name: string;
  dialect: SourceDialect;
  file: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  trust: boolean;
}

interface SessionSettingsForm {
  idleMinutes: string;
  absoluteHours: string;
  showCountdown: boolean;
}

interface ExecutionSettingsForm {
  defaultMaxRows: string;
  maxMaxRows: string;
  defaultTimeoutS: string;
  maxTimeoutS: string;
  approvalWindowHours: string;
  resultTtlHours: string;
}

interface SourceTestFailure {
  code: string;
  message: string;
}

interface SettingsUi {
  settingsBusy: boolean;
  settingsError: string | null;
  sourcesBusy: boolean;
  sourcesError: string | null;
  sourcesNotice: string | null;
  deleting: Set<string>;
  testing: Set<string>;
  testResults: Map<string, SourceTestResult>;
  testErrors: Map<string, SourceTestFailure>;
  editingId: string | null;
  editForm: SourceFormState;
  editBusy: boolean;
  editError: string | null;
  addBusy: boolean;
  addError: string | null;
  form: SourceFormState;
  sessionForm: SessionSettingsForm;
  sessionBusy: boolean;
  sessionError: string | null;
  sessionNotice: string | null;
  executionForm: ExecutionSettingsForm;
  executionBusy: boolean;
  executionError: string | null;
  executionNotice: string | null;
  securityBusy: boolean;
  securityError: string | null;
  securityNotice: string | null;
  passwordCurrent: string;
  passwordNew: string;
  passwordConfirm: string;
  passwordBusy: boolean;
  passwordError: string | null;
  passwordNotice: string | null;
  clients: ClientSummary[];
  clientsBusy: boolean;
  clientsError: string | null;
  clientsNotice: string | null;
  revoking: Set<string>;
  clientName: string;
  clientCreating: boolean;
  clientCreateError: string | null;
  /** One-time token response; stays in memory until 「我已保存」. */
  createdClient: ClientCreateResponse | null;
  clientCopyNotice: string | null;
  clientCopyError: string | null;
}

interface CardUi {
  purposeOpen: boolean;
  detailsOpen: boolean;
  rejectOpen: boolean;
  rejectReason: string;
  rejectBusy: boolean;
  approveBusy: boolean;
  rows?: ResultPage;
  rowsBusy: boolean;
  rowsError?: string;
  rowsTicket: number;
  error?: string;
  notice?: string;
  approveInfo?: ApproveResponse;
}

interface AppState {
  phase: Phase;
  configured: boolean;
  unlocked: boolean;
  version: string;
  bootError: string | null;
  unlockedAt: number | null;
  screen: Screen;
  view: View;
  proposals: Proposal[];
  pendingCount: number;
  sources: SourceSummary[];
  sourceNames: Map<string, string>;
  q: string;
  filtersOpen: boolean;
  statusFilter: '' | ProposalStatus;
  pageSize: number;
  listLoading: boolean;
  listError: string | null;
  cards: Map<string, CardUi>;
  settings: SettingsSnapshot | null;
}

interface Refs {
  tabPending: HTMLButtonElement | null;
  tabAll: HTMLButtonElement | null;
  filterToggle: HTMLButtonElement | null;
  filterPanel: HTMLElement | null;
  statusField: HTMLElement | null;
  search: HTMLInputElement | null;
  statusSelect: HTMLSelectElement | null;
  pageSize: HTMLSelectElement | null;
  list: HTMLElement | null;
  alert: HTMLElement | null;
}

interface SqlToken {
  text: string;
  cls: string | null;
}

interface PasswordField {
  field: HTMLElement;
  input: HTMLInputElement;
}

/* ------------------------------------------------------------------- state */

const mount: HTMLElement = document.getElementById('app') ?? document.body;

const state: AppState = {
  phase: 'boot',
  configured: false,
  unlocked: false,
  version: '',
  bootError: null,
  unlockedAt: null,
  screen: 'console',
  view: 'pending',
  proposals: [],
  pendingCount: 0,
  sources: [],
  sourceNames: new Map<string, string>(),
  q: '',
  filtersOpen: false,
  statusFilter: '',
  pageSize: DEFAULT_PAGE_SIZE,
  listLoading: false,
  listError: null,
  cards: new Map<string, CardUi>(),
  settings: null,
};

const refs: Refs = {
  tabPending: null,
  tabAll: null,
  filterToggle: null,
  filterPanel: null,
  statusField: null,
  search: null,
  statusSelect: null,
  pageSize: null,
  list: null,
  alert: null,
};

const settingsUi: SettingsUi = {
  settingsBusy: false,
  settingsError: null,
  sourcesBusy: false,
  sourcesError: null,
  sourcesNotice: null,
  deleting: new Set<string>(),
  testing: new Set<string>(),
  testResults: new Map<string, SourceTestResult>(),
  testErrors: new Map<string, SourceTestFailure>(),
  editingId: null,
  editForm: emptySourceForm(),
  editBusy: false,
  editError: null,
  addBusy: false,
  addError: null,
  form: emptySourceForm(),
  sessionForm: emptySessionSettingsForm(),
  sessionBusy: false,
  sessionError: null,
  sessionNotice: null,
  executionForm: emptyExecutionSettingsForm(),
  executionBusy: false,
  executionError: null,
  executionNotice: null,
  securityBusy: false,
  securityError: null,
  securityNotice: null,
  passwordCurrent: '',
  passwordNew: '',
  passwordConfirm: '',
  passwordBusy: false,
  passwordError: null,
  passwordNotice: null,
  clients: [],
  clientsBusy: false,
  clientsError: null,
  clientsNotice: null,
  revoking: new Set<string>(),
  clientName: '',
  clientCreating: false,
  clientCreateError: null,
  createdClient: null,
  clientCopyNotice: null,
  clientCopyError: null,
};

let lastSuccessAt = 0;
let searchTimer: number | null = null;
let listTicket = 0;
let locking = false;
let countdownNode: HTMLSpanElement | null = null;

/*
 * Live-update bookkeeping. None of it survives a locked session: the push
 * stream is aborted and every timer cleared by stopLiveUpdates().
 */
let liveAbort: AbortController | null = null;
let liveGeneration = 0;
let liveRetryTimer: number | null = null;
let liveRetryIndex = 0;
let liveFailures = 0;
let liveHadConnection = false;
/** True while a stream is open; the shell re-render reads it for the badge. */
let liveConnected = false;
/** Set when the document left the page: the next connect must resync first. */
let liveNeedsSnapshot = false;
let liveRefreshTimer: number | null = null;
let liveStatusEl: HTMLElement | null = null;
let liveFailureEl: HTMLElement | null = null;
let noticeTimer: number | null = null;
let noticeEl: HTMLElement | null = null;
let noticeTextEl: HTMLElement | null = null;
/** Set when an event arrives while the settings screen hides the list. */
let missedPushRefresh = false;
/**
 * Ids already present in the list or announced by an earlier push. Membership
 * here is the dedupe key: an id is "new" only if it was never seen in this
 * unlocked session, so a burst of events cannot announce it twice.
 */
const seenProposalIds = new Set<string>();

/* ----------------------------------------------------------------- helpers */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className.length > 0) node.className = className;
  return node;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = el('span', className);
  node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function showError(node: HTMLElement, message: string): void {
  if (message.length === 0) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function setBusy(
  node: HTMLButtonElement,
  busy: boolean,
  busyLabel: string,
  idleLabel: string,
): void {
  node.disabled = busy;
  node.textContent = busy ? busyLabel : idleLabel;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function fmtTimestamp(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function fmtClock(time: number): string {
  const date = new Date(time);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return fmtTimestamp(time);
}

function relTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '时间未知';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSeconds < 60) return '刚刚';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(iso);
}

function sourceName(sourceId: string): string {
  return state.sourceNames.get(sourceId) ?? sourceId;
}

/** Records the timestamp of the last successful request (idle-lock basis). */
async function call<T>(operation: () => Promise<T>): Promise<T> {
  const result = await operation();
  lastSuccessAt = Date.now();
  return result;
}

function isSessionError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.code === 'CSRF_MISSING')
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403 || error.code === 'CSRF_MISSING') {
      return SESSION_MESSAGE;
    }
    if (error.code === 'NETWORK_ERROR') return '无法连接本地网关，请稍后重试';
    if (error.code === 'TIMEOUT') return '请求超时，请稍后重试';
    const retry =
      error.retryAfterSeconds === null ? '' : `（${error.retryAfterSeconds} 秒后重试）`;
    return `${error.message}${retry}`;
  }
  return '发生未知错误，请稍后重试';
}

function describeUnlockError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return '密码不正确';
    if (error.retryAfterSeconds !== null) {
      return `尝试次数过多，请 ${error.retryAfterSeconds} 秒后重试`;
    }
  }
  return describeError(error);
}

function validatePassword(password: string): string | null {
  if (password.length < 12) return '密码至少需要 12 位';
  if (!/[A-Za-z]/.test(password)) return '密码必须包含字母';
  if (!/[0-9]/.test(password)) return '密码必须包含数字';
  return null;
}

function emptySourceForm(dialect: SourceDialect = 'sqlite'): SourceFormState {
  return {
    name: '',
    dialect,
    file: '',
    host: '',
    port: DEFAULT_PORTS[dialect],
    database: '',
    username: '',
    password: '',
    trust: false,
  };
}

function emptySessionSettingsForm(): SessionSettingsForm {
  return {
    idleMinutes: String(DEFAULT_SETTINGS['session.idle_minutes']),
    absoluteHours: String(DEFAULT_SETTINGS['session.absolute_hours']),
    showCountdown: DEFAULT_SETTINGS['ui.show_countdown'],
  };
}

function emptyExecutionSettingsForm(): ExecutionSettingsForm {
  return {
    defaultMaxRows: String(DEFAULT_SETTINGS['proposal.default_max_rows']),
    maxMaxRows: String(DEFAULT_SETTINGS['proposal.max_max_rows']),
    defaultTimeoutS: String(DEFAULT_SETTINGS['proposal.default_timeout_s']),
    maxTimeoutS: String(DEFAULT_SETTINGS['proposal.max_timeout_s']),
    approvalWindowHours: String(DEFAULT_SETTINGS['proposal.approval_window_hours']),
    resultTtlHours: String(DEFAULT_SETTINGS['result.ttl_hours']),
  };
}

function hydrateSettingsDrafts(snapshot: SettingsSnapshot): void {
  const values = snapshot.settings;
  settingsUi.sessionForm = {
    idleMinutes: String(values['session.idle_minutes']),
    absoluteHours: String(values['session.absolute_hours']),
    showCountdown: values['ui.show_countdown'],
  };
  settingsUi.executionForm = {
    defaultMaxRows: String(values['proposal.default_max_rows']),
    maxMaxRows: String(values['proposal.max_max_rows']),
    defaultTimeoutS: String(values['proposal.default_timeout_s']),
    maxTimeoutS: String(values['proposal.max_timeout_s']),
    approvalWindowHours: String(values['proposal.approval_window_hours']),
    resultTtlHours: String(values['result.ttl_hours']),
  };
}

function rangeText(range: SettingRange | null): string {
  if (range?.min === undefined || range.max === undefined) return '有效范围内';
  return `${range.min}–${range.max}`;
}

/** Parses an integer input and enforces the server-provided inclusive range. */
function parseBoundedInt(raw: string, range: SettingRange | null): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return null;
  if (range?.min !== undefined && value < range.min) return null;
  if (range?.max !== undefined && value > range.max) return null;
  return value;
}

function idleLimitMs(): number {
  const minutes =
    state.settings?.settings['session.idle_minutes'] ??
    DEFAULT_SETTINGS['session.idle_minutes'];
  return minutes * 60 * 1000;
}

function absoluteLimitMs(): number {
  const hours =
    state.settings?.settings['session.absolute_hours'] ??
    DEFAULT_SETTINGS['session.absolute_hours'];
  return hours * 60 * 60 * 1000;
}

function fmtRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Refreshes the header idle countdown; hidden when `ui.show_countdown` is off. */
function updateCountdown(): void {
  const node = countdownNode;
  if (node === null) return;
  const show =
    state.phase === 'shell' &&
    state.unlockedAt !== null &&
    (state.settings?.settings['ui.show_countdown'] ??
      DEFAULT_SETTINGS['ui.show_countdown']);
  if (!show) {
    node.hidden = true;
    node.textContent = '';
    node.classList.remove('warn');
    return;
  }
  const baseline = lastSuccessAt > 0 ? lastSuccessAt : (state.unlockedAt ?? Date.now());
  const remaining = idleLimitMs() - (Date.now() - baseline);
  node.hidden = false;
  node.textContent = `空闲 ${fmtRemaining(remaining)}`;
  node.classList.toggle('warn', remaining < 60 * 1000);
}

/** Form errors keep the wire `code` visible, as the approval cards do. */
function describeActionError(error: unknown): string {
  if (error instanceof ApiError) {
    const retry =
      error.retryAfterSeconds === null ? '' : `（${error.retryAfterSeconds} 秒后重试）`;
    return `${error.code}：${error.message}${retry}`;
  }
  return describeError(error);
}

interface InputFieldOptions {
  type?: string;
  placeholder?: string;
  autocomplete?: string;
}

interface InputField {
  field: HTMLElement;
  input: HTMLInputElement;
}

function inputField(
  id: string,
  caption: string,
  value: string,
  onInput: (value: string) => void,
  options: InputFieldOptions = {},
): InputField {
  const field = el('label', 'field');
  field.htmlFor = id;
  const label = el('span', 'field-label');
  label.textContent = caption;
  const input = el('input', 'input');
  input.id = id;
  if (options.type !== undefined) input.type = options.type;
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;
  if (options.autocomplete !== undefined) {
    input.setAttribute('autocomplete', options.autocomplete);
  }
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  field.append(label, input);
  return { field, input };
}

function numberSettingField(
  id: string,
  caption: string,
  value: string,
  range: SettingRange | null,
  onInput: (value: string) => void,
  hint?: string,
): InputField {
  const field = el('label', 'field');
  field.htmlFor = id;
  const label = el('span', 'field-label');
  label.textContent = caption;
  const input = el('input', 'input');
  input.id = id;
  input.type = 'number';
  input.step = '1';
  input.inputMode = 'numeric';
  if (range?.min !== undefined) input.min = String(range.min);
  if (range?.max !== undefined) input.max = String(range.max);
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  field.append(label, input);
  if (hint !== undefined) {
    const note = el('span', 'field-hint');
    note.textContent = hint;
    field.append(note);
  }
  return { field, input };
}

function truncatedId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/* --------------------------------------------------------------- tokenizer */

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch) || ch === '$';
}

/**
 * Splits SQL into highlighted tokens: line `--` and block comments, quoted
 * strings, numbers, identifiers/keywords, and operators (plain text otherwise).
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let buffer = '';
  let bufferClass: string | null = null;
  let bufferOpen = false;

  const flush = (): void => {
    if (bufferOpen && buffer.length > 0) tokens.push({ text: buffer, cls: bufferClass });
    buffer = '';
    bufferClass = null;
    bufferOpen = false;
  };

  const push = (text: string, cls: string | null): void => {
    if (!bufferOpen) {
      bufferOpen = true;
      bufferClass = cls;
    } else if (bufferClass !== cls) {
      flush();
      bufferOpen = true;
      bufferClass = cls;
    }
    buffer += text;
  };

  let index = 0;
  while (index < sql.length) {
    const ch = sql.charAt(index);

    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end + 1;
      push(sql.slice(index, stop), 'tok-com');
      index = stop;
      continue;
    }

    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      push(sql.slice(index, stop), 'tok-com');
      index = stop;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql.charAt(cursor) === quote) {
          if (sql.charAt(cursor + 1) === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      push(sql.slice(index, cursor), 'tok-str');
      index = cursor;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(sql.charAt(index + 1)))) {
      let cursor = index;
      while (cursor < sql.length && (isDigit(sql.charAt(cursor)) || sql.charAt(cursor) === '.')) {
        cursor += 1;
      }
      push(sql.slice(index, cursor), 'tok-num');
      index = cursor;
      continue;
    }

    if (isIdentifierStart(ch)) {
      let cursor = index + 1;
      while (cursor < sql.length && isIdentifierPart(sql.charAt(cursor))) cursor += 1;
      const word = sql.slice(index, cursor);
      push(word, KEYWORDS.has(word.toUpperCase()) ? 'tok-kw' : 'tok-id');
      index = cursor;
      continue;
    }

    if (OPERATOR_CHARS.includes(ch)) {
      let cursor = index + 1;
      while (cursor < sql.length && OPERATOR_CHARS.includes(sql.charAt(cursor))) cursor += 1;
      push(sql.slice(index, cursor), 'tok-op');
      index = cursor;
      continue;
    }

    push(ch, null);
    index += 1;
  }

  flush();
  return tokens;
}

function renderSqlBlock(sql: string): HTMLPreElement {
  const pre = el('pre', 'sql');
  for (const token of tokenizeSql(sql)) {
    const node = el('span');
    node.textContent = token.text;
    if (token.cls !== null) node.className = token.cls;
    pre.append(node);
  }
  return pre;
}

/* ------------------------------------------------------------------- cards */

function cardState(proposalId: string): CardUi {
  const existing = state.cards.get(proposalId);
  if (existing !== undefined) return existing;
  const created: CardUi = {
    purposeOpen: false,
    detailsOpen: false,
    rejectOpen: false,
    rejectReason: '',
    rejectBusy: false,
    approveBusy: false,
    rowsBusy: false,
    rowsTicket: 0,
  };
  state.cards.set(proposalId, created);
  return created;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatParams(params: unknown): string {
  if (params === null || params === undefined) return '无参数';
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return String(params);
  }
}

function addFact(list: HTMLDListElement, term: string, value: string): void {
  const dt = el('dt');
  dt.textContent = term;
  const dd = el('dd');
  dd.textContent = value;
  list.append(dt, dd);
}

function buildApproveSummary(info: ApproveResponse): HTMLElement {
  const box = el('div', 'summary');
  if (info.result !== null) {
    const parts = [`返回 ${info.result.total_rows} 行`];
    if (info.result.truncated) parts.push('已截断');
    parts.push(`耗时 ${info.result.duration_ms} ms`);
    const columns = info.result.columns.map((column) => column.name).join(', ');
    const line = el('p', 'summary-line');
    line.textContent = `执行成功 · ${parts.join(' · ')}${columns.length > 0 ? ` · 列：${columns}` : ''}`;
    box.append(line);
    if (info.result.executed_at.length > 0) {
      const meta = el('p', 'summary-meta');
      meta.textContent = `执行时间：${fmtDate(info.result.executed_at)}`;
      box.append(meta);
    }
  } else {
    const line = el('p', 'summary-line bad');
    line.textContent = `执行未返回结果${info.error_code ? `（${info.error_code}）` : ''}`;
    box.append(line);
  }
  return box;
}

function buildRowsTable(rows: ResultPage, proposalId: string): HTMLElement {
  const block = el('div', 'table-block');

  const wrap = el('div', 'table-wrap');
  const table = el('table', 'rows');

  const head = el('thead');
  const headRow = el('tr');
  for (const column of rows.columns) {
    const cell = el('th');
    cell.textContent = column.name;
    if (column.type !== undefined) cell.title = column.type;
    headRow.append(cell);
  }
  head.append(headRow);

  const body = el('tbody');
  if (rows.rows.length === 0) {
    const row = el('tr');
    const cell = el('td', 'cell-empty');
    cell.colSpan = Math.max(1, rows.columns.length);
    cell.textContent = '没有返回行';
    row.append(cell);
    body.append(row);
  } else {
    for (const values of rows.rows) {
      const row = el('tr');
      for (let index = 0; index < rows.columns.length; index += 1) {
        const value = values[index];
        const cell = el('td');
        if (value === null || value === undefined) cell.classList.add('cell-null');
        cell.textContent = cellText(value);
        row.append(cell);
      }
      body.append(row);
    }
  }
  table.append(head, body);
  wrap.append(table);
  block.append(wrap);

  const size = rows.page_size > 0 ? rows.page_size : state.pageSize;
  const totalPages = Math.max(1, Math.ceil(rows.total_rows / size));
  const pager = el('div', 'pager');
  const info = el('span', 'pager-info');
  const duration =
    rows.duration_ms === null ? '' : ` · 耗时 ${rows.duration_ms} ms`;
  info.textContent = `第 ${rows.page} / ${totalPages} 页 · 共 ${rows.total_rows} 行${
    rows.truncated ? '（已截断）' : ''
  }${duration}`;

  const prev = button('上一页', 'btn ghost small', () => {
    void loadRows(proposalId, rows.page - 1);
  });
  prev.disabled = rows.page <= 1;
  const next = button('下一页', 'btn ghost small', () => {
    void loadRows(proposalId, rows.page + 1);
  });
  next.disabled = rows.page >= totalPages;

  pager.append(info, prev, next);
  block.append(pager);
  return block;
}

function buildResultSection(proposal: Proposal, ui: CardUi): HTMLElement {
  const section = el('div', 'result');
  const head = el('div', 'result-head');
  const title = el('h3', 'details-title');
  title.textContent = '执行结果';
  const open = button(ui.rows ? '刷新结果' : '查看结果', 'btn ghost small', () => {
    void loadRows(proposal.id, ui.rows ? ui.rows.page : 1);
  });
  open.disabled = ui.rowsBusy;
  head.append(title, open);
  section.append(head);

  if (ui.rowsBusy) {
    const busy = el('p', 'hint');
    busy.textContent = '正在加载结果…';
    section.append(busy);
  }
  if (ui.rowsError !== undefined) {
    const failure = el('p', 'error');
    failure.textContent = ui.rowsError;
    section.append(failure);
  }
  if (ui.rows !== undefined) section.append(buildRowsTable(ui.rows, proposal.id));
  return section;
}

function buildDetails(proposal: Proposal, ui: CardUi): HTMLElement {
  const details = el('div', 'details');

  const facts = el('dl', 'facts');
  addFact(facts, '来源', `${sourceName(proposal.source_id)}（${proposal.source_id}）`);
  addFact(facts, '完整目的', (proposal.purpose ?? '').trim() || '未填写目的');
  addFact(facts, '摘要', proposal.digest);
  addFact(facts, '执行限制', `最多 ${proposal.max_rows} 行 · 超时 ${proposal.timeout_s} 秒`);
  addFact(facts, '创建时间', fmtDate(proposal.created_at));
  addFact(facts, '更新时间', fmtDate(proposal.updated_at));
  if (proposal.status_message !== null && proposal.status_message.length > 0) {
    addFact(facts, '状态信息', proposal.status_message);
  }
  details.append(facts);

  const paramsTitle = el('h3', 'details-title');
  paramsTitle.textContent = '参数';
  const params = el('pre', 'params');
  params.textContent = formatParams(proposal.params);
  details.append(paramsTitle, params);

  if (proposal.status === 'SUCCEEDED') details.append(buildResultSection(proposal, ui));
  return details;
}

function buildCard(proposal: Proposal): HTMLElement {
  const ui = cardState(proposal.id);
  const card = el('article', 'card');
  card.dataset['id'] = proposal.id;

  card.append(renderSqlBlock(proposal.sql));

  const purposeText = (proposal.purpose ?? '').trim();
  if (purposeText.length === 0) {
    const purpose = el('p', 'purpose muted');
    purpose.textContent = '未填写目的';
    card.append(purpose);
  } else {
    const purpose = el('p', 'purpose');
    purpose.textContent = purposeText;
    if (!ui.purposeOpen) purpose.classList.add('clamped');
    const row = el('div', 'purpose-row');
    row.append(
      purpose,
      button(ui.purposeOpen ? '收起' : '展开目的', 'link', () => {
        ui.purposeOpen = !ui.purposeOpen;
        paintList();
      }),
    );
    card.append(row);
  }

  const meta = el('div', 'meta');
  const status = span('status', STATUS_LABELS[proposal.status]);
  status.classList.add(`status-${proposal.status.toLowerCase()}`);
  meta.append(
    span('meta-source', sourceName(proposal.source_id)),
    span('meta-sep', '·'),
    status,
    span('meta-sep', '·'),
    span('meta-time', relTime(proposal.created_at)),
  );
  card.append(meta);

  const pending = proposal.status === 'PENDING_APPROVAL';
  const actions = el('div', 'actions');
  if (pending) {
    const approve = button(ui.approveBusy ? '批准中…' : '批准', 'btn primary', () => {
      void approveProposal(proposal.id);
    });
    approve.disabled = ui.approveBusy;
    const reject = button('拒绝', 'btn danger', () => {
      ui.rejectOpen = !ui.rejectOpen;
      if (!ui.rejectOpen) ui.rejectReason = '';
      paintList();
    });
    reject.disabled = ui.rejectBusy;
    actions.append(approve);
    if (strictReadonlyEnabled() && sourceKnownWritable(proposal.source_id)) {
      actions.append(
        span('approve-readonly-warning', '该数据源非只读，批准将被拒绝'),
      );
    }
    actions.append(reject);
  }
  actions.append(
    button(ui.detailsOpen ? '收起详情' : '详细信息', 'btn ghost', () => {
      ui.detailsOpen = !ui.detailsOpen;
      paintList();
    }),
  );
  card.append(actions);

  if (pending && ui.rejectOpen) {
    const form = el('div', 'reject');
    const area = el('textarea', 'textarea');
    area.rows = 3;
    area.placeholder = '拒绝原因（可选）';
    area.value = ui.rejectReason;
    area.addEventListener('input', () => {
      ui.rejectReason = area.value;
    });
    const row = el('div', 'reject-actions');
    const confirm = button(ui.rejectBusy ? '提交中…' : '确认拒绝', 'btn danger', () => {
      void rejectProposal(proposal.id);
    });
    confirm.disabled = ui.rejectBusy;
    const cancel = button('取消', 'btn ghost', () => {
      ui.rejectOpen = false;
      ui.rejectReason = '';
      paintList();
    });
    cancel.disabled = ui.rejectBusy;
    row.append(confirm, cancel);
    form.append(area, row);
    card.append(form);
  }

  if (ui.error !== undefined) {
    const error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.textContent = ui.error;
    card.append(error);
  }
  if (ui.notice !== undefined) {
    const notice = el('p', 'notice');
    notice.textContent = ui.notice;
    card.append(notice);
  }
  if (ui.approveInfo !== undefined) card.append(buildApproveSummary(ui.approveInfo));
  if (ui.detailsOpen) card.append(buildDetails(proposal, ui));

  return card;
}

/* ------------------------------------------------------------------- paint */

function paintFilters(): void {
  const { tabPending, tabAll, filterToggle, filterPanel, statusField, search, statusSelect, pageSize } =
    refs;
  if (tabPending === null || tabAll === null) return;

  tabPending.textContent = `待审批 (${state.pendingCount})`;
  tabPending.classList.toggle('active', state.view === 'pending');
  tabAll.classList.toggle('active', state.view === 'all');
  if (filterToggle !== null) filterToggle.textContent = state.filtersOpen ? '收起筛选' : '筛选';
  if (filterPanel !== null) filterPanel.hidden = !state.filtersOpen;
  if (statusField !== null) statusField.hidden = state.view !== 'all';
  if (search !== null && search.value !== state.q) search.value = state.q;
  if (statusSelect !== null) statusSelect.value = state.statusFilter;
  if (pageSize !== null) pageSize.value = String(state.pageSize);
}

function paintList(): void {
  const list = refs.list;
  if (list === null) return;
  list.textContent = '';

  if (refs.alert !== null) {
    refs.alert.hidden = state.listError === null;
    refs.alert.textContent = state.listError ?? '';
  }

  if (state.listLoading && state.proposals.length === 0) {
    const loading = el('p', 'hint');
    loading.textContent = '正在加载…';
    list.append(loading);
    return;
  }

  if (state.proposals.length === 0) {
    const empty = el('p', 'empty');
    empty.textContent = state.view === 'pending' ? '没有待审批的 SQL' : '没有匹配的 SQL';
    list.append(empty);
    return;
  }

  for (const proposal of state.proposals) list.append(buildCard(proposal));
}

function resetRefs(): void {
  refs.tabPending = null;
  refs.tabAll = null;
  refs.filterToggle = null;
  refs.filterPanel = null;
  refs.statusField = null;
  refs.search = null;
  refs.statusSelect = null;
  refs.pageSize = null;
  refs.list = null;
  refs.alert = null;
  liveStatusEl = null;
  liveFailureEl = null;
  noticeEl = null;
  noticeTextEl = null;
}

/* ------------------------------------------------------------ boot screens */

function renderBoot(): void {
  state.phase = 'boot';
  mount.textContent = '';
  const card = el('section', 'card auth-card');
  const title = el('h1', 'auth-title');
  title.textContent = 'SQL 审批';
  const hint = el('p', 'hint');
  hint.textContent = '正在连接本地网关…';
  card.append(title, hint);
  mount.append(card);
}

function renderBootError(): void {
  mount.textContent = '';
  const card = el('section', 'card auth-card');
  const title = el('h1', 'auth-title');
  title.textContent = '无法连接网关';
  const error = el('p', 'error');
  error.textContent = state.bootError ?? '未知错误';
  const hint = el('p', 'hint');
  hint.textContent = '请确认本地核心服务已启动，然后重试。';
  const retry = button('重试', 'btn primary', () => {
    void refreshRootState();
  });
  card.append(title, error, hint, retry);
  mount.append(card);
}

function passwordField(
  id: string,
  caption: string,
  placeholder: string,
  autocomplete: string,
): PasswordField {
  const field = el('div', 'field');
  const label = el('label', 'field-label');
  label.htmlFor = id;
  label.textContent = caption;

  const shell = el('div', 'secret');
  const input = el('input', 'input');
  input.type = 'password';
  input.id = id;
  input.setAttribute('autocomplete', autocomplete);
  input.placeholder = placeholder;

  const toggle = button('显示', 'btn ghost small', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? '隐藏' : '显示';
    toggle.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
    input.focus();
  });
  toggle.setAttribute('aria-label', '显示密码');

  shell.append(input, toggle);
  field.append(label, shell);
  return { field, input };
}

function renderSetup(): void {
  state.phase = 'setup';
  mount.textContent = '';

  const card = el('section', 'card auth-card');
  const title = el('h1', 'auth-title');
  title.textContent = '初始化管理密码';
  const intro = el('p', 'hint');
  intro.textContent = '首次使用，请设置管理密码：至少 12 位，且同时包含字母和数字。';

  const form = el('form', 'form');
  form.noValidate = true;
  const password = passwordField(
    'setup-password',
    '密码',
    '至少 12 位，含字母和数字',
    'new-password',
  );
  const confirm = passwordField('setup-confirm', '确认密码', '再次输入密码', 'new-password');
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.textContent = '设置并解锁';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      showError(error, '');
      const passwordValue = password.input.value;
      const confirmValue = confirm.input.value;
      const problem = validatePassword(passwordValue);
      if (problem !== null) {
        showError(error, problem);
        password.input.focus();
        return;
      }
      if (passwordValue !== confirmValue) {
        showError(error, '两次输入的密码不一致');
        confirm.input.focus();
        return;
      }

      setBusy(submit, true, '正在设置…', '设置并解锁');
      try {
        await api.setup(passwordValue, confirmValue);
        state.configured = true;
        const unlocked = await unlockWithPassword(passwordValue, error);
        if (!unlocked) {
          setBusy(submit, false, '正在设置…', '设置并解锁');
          password.input.focus();
        }
      } catch (setupError) {
        showError(error, describeError(setupError));
        setBusy(submit, false, '正在设置…', '设置并解锁');
      }
    })();
  });

  form.append(password.field, confirm.field, error, submit);
  card.append(title, intro, form);
  mount.append(card);
  password.input.focus();
}

function renderUnlock(message: string | null): void {
  state.phase = 'unlock';
  mount.textContent = '';

  const card = el('section', 'card auth-card');
  const title = el('h1', 'auth-title');
  title.textContent = '解锁审批台';
  const intro = el('p', 'hint');
  intro.textContent = '输入管理密码以继续。';

  const form = el('form', 'form');
  form.noValidate = true;
  const field = passwordField('unlock-password', '密码', '管理密码', 'current-password');
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.textContent = '解锁';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const passwordValue = field.input.value;
      if (passwordValue.length === 0) {
        showError(error, '请输入密码');
        field.input.focus();
        return;
      }
      showError(error, '');
      setBusy(submit, true, '正在解锁…', '解锁');
      const unlocked = await unlockWithPassword(passwordValue, error);
      if (!unlocked) {
        setBusy(submit, false, '正在解锁…', '解锁');
        field.input.focus();
      }
    })();
  });

  form.append(field.field, error, submit);
  card.append(title, intro);
  if (message !== null && message.length > 0) {
    const banner = el('p', 'banner');
    banner.textContent = message;
    card.append(banner);
  }
  card.append(form);
  mount.append(card);
  field.input.focus();
}

/* ------------------------------------------------------------------- shell */

function buildHeadStatus(): HTMLElement {
  const status = el('span', 'head-status');
  const lockState = span(
    'lock-state',
    state.unlockedAt === null ? '已解锁' : `已解锁 ${fmtClock(state.unlockedAt)}`,
  );
  const countdown = el('span', 'idle-countdown');
  countdown.hidden = true;
  status.append(lockState, countdown);
  countdownNode = countdown;
  updateCountdown();
  return status;
}

function buildHeader(): HTMLElement {
  const header = el('header', 'topbar');
  const brand = el('div', 'brand');
  const title = el('h1', 'brand-title');
  title.textContent = 'SQL 审批';
  const sub = el('p', 'brand-sub');
  sub.textContent = state.version.length > 0 ? `审批台 v${state.version}` : '审批台';
  brand.append(title, sub);

  const group = el('div', 'head-actions');
  const settings = button('设置', 'btn ghost small', () => {
    void openSettings();
  });
  const lock = button('锁定', 'btn ghost small', () => {
    void lockSession(null);
  });
  group.append(buildHeadStatus(), settings, lock);
  header.append(brand, group);
  return header;
}

function labeledField(caption: string, control: HTMLElement): HTMLElement {
  const field = el('div', 'field');
  const label = el('span', 'field-label');
  label.textContent = caption;
  field.append(label, control);
  return field;
}

function buildFilterPanel(): HTMLElement {
  const panel = el('div', 'filter-panel');
  panel.hidden = !state.filtersOpen;

  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = '搜索 SQL 或目的';
  search.setAttribute('aria-label', '搜索 SQL 或目的');
  search.value = state.q;
  search.addEventListener('input', () => {
    state.q = search.value;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      void loadProposals();
    }, SEARCH_DEBOUNCE_MS);
  });

  const statusSelect = el('select', 'input');
  statusSelect.setAttribute('aria-label', '按状态筛选');
  const anyOption = el('option');
  anyOption.value = '';
  anyOption.textContent = '全部状态';
  statusSelect.append(anyOption);
  for (const status of PROPOSAL_STATUSES) {
    const option = el('option');
    option.value = status;
    option.textContent = STATUS_LABELS[status];
    statusSelect.append(option);
  }
  statusSelect.value = state.statusFilter;
  statusSelect.addEventListener('change', () => {
    state.statusFilter =
      statusSelect.value === '' ? '' : (statusSelect.value as ProposalStatus);
    void loadProposals();
  });
  const statusField = labeledField('状态', statusSelect);

  const pageSize = el('select', 'input');
  pageSize.setAttribute('aria-label', '每页条数');
  for (const size of PAGE_SIZE_OPTIONS) {
    const option = el('option');
    option.value = String(size);
    option.textContent = `${size} 行`;
    pageSize.append(option);
  }
  pageSize.value = String(state.pageSize);
  pageSize.addEventListener('change', () => {
    const next = Number.parseInt(pageSize.value, 10);
    state.pageSize = Number.isFinite(next) ? next : DEFAULT_PAGE_SIZE;
    void refreshOpenRows();
  });

  panel.append(labeledField('搜索', search), statusField, labeledField('每页条数', pageSize));

  refs.filterPanel = panel;
  refs.search = search;
  refs.statusSelect = statusSelect;
  refs.statusField = statusField;
  refs.pageSize = pageSize;
  return panel;
}

function renderShell(): void {
  state.phase = 'shell';
  mount.textContent = '';
  resetRefs();

  if (state.screen === 'settings') {
    renderSettings();
    return;
  }

  const app = el('div', 'app');
  app.append(buildHeader());

  const toolbar = el('div', 'toolbar');
  const tabsRow = el('div', 'tabs-row');
  const tabs = el('div', 'tabs');
  const tabPending = button('待审批', 'tab', () => {
    void switchView('pending');
  });
  const tabAll = button('全部', 'tab', () => {
    void switchView('all');
  });
  tabs.append(tabPending, tabAll);
  const filterToggle = button('筛选', 'btn ghost small', () => {
    state.filtersOpen = !state.filtersOpen;
    paintFilters();
  });
  const refreshButton = button('刷新', 'btn ghost small', () => {
    void loadProposals();
  });
  refreshButton.setAttribute('aria-label', '手动刷新列表');
  const liveStatus = el('span', 'live-status live-connecting');
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.textContent = '实时 · 重连中';
  const toolbarActions = el('div', 'toolbar-actions');
  toolbarActions.append(liveStatus, refreshButton, filterToggle);
  tabsRow.append(tabs, toolbarActions);
  const panel = buildFilterPanel();
  toolbar.append(tabsRow, panel);

  const notice = el('div', 'live-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const noticeText = el('span', 'live-notice-text');
  const noticeClose = button('关闭', 'btn ghost small', () => {
    hideNewProposalNotice();
  });
  noticeClose.setAttribute('aria-label', '关闭提示');
  notice.append(noticeText, noticeClose);

  const liveFailure = el('p', 'live-failure');
  liveFailure.setAttribute('role', 'status');
  liveFailure.hidden = true;
  liveFailure.textContent = '实时连接中断，正在重连';

  const alert = el('p', 'alert');
  alert.setAttribute('role', 'status');
  alert.hidden = true;
  const list = el('div', 'list');

  app.append(toolbar, notice, liveFailure, alert, list);
  mount.append(app);

  refs.tabPending = tabPending;
  refs.tabAll = tabAll;
  refs.filterToggle = filterToggle;
  refs.alert = alert;
  refs.list = list;
  liveStatusEl = liveStatus;
  liveFailureEl = liveFailure;
  noticeEl = notice;
  noticeTextEl = noticeText;

  paintLiveStatus(liveConnected);
  paintFilters();
  paintList();
}

/* ---------------------------------------------------------------- settings */

function repaintSettings(): void {
  if (state.phase === 'shell' && state.screen === 'settings') renderSettings();
}

/** Drops form contents (including passwords) when the local session ends. */
function resetSettingsUi(): void {
  settingsUi.settingsBusy = false;
  settingsUi.settingsError = null;
  settingsUi.sourcesBusy = false;
  settingsUi.sourcesError = null;
  settingsUi.sourcesNotice = null;
  settingsUi.deleting.clear();
  settingsUi.testing.clear();
  settingsUi.testResults.clear();
  settingsUi.testErrors.clear();
  settingsUi.editingId = null;
  settingsUi.editForm = emptySourceForm();
  settingsUi.editBusy = false;
  settingsUi.editError = null;
  settingsUi.addBusy = false;
  settingsUi.addError = null;
  settingsUi.form = emptySourceForm();
  settingsUi.sessionForm = emptySessionSettingsForm();
  settingsUi.sessionBusy = false;
  settingsUi.sessionError = null;
  settingsUi.sessionNotice = null;
  settingsUi.executionForm = emptyExecutionSettingsForm();
  settingsUi.executionBusy = false;
  settingsUi.executionError = null;
  settingsUi.executionNotice = null;
  settingsUi.securityBusy = false;
  settingsUi.securityError = null;
  settingsUi.securityNotice = null;
  settingsUi.passwordCurrent = '';
  settingsUi.passwordNew = '';
  settingsUi.passwordConfirm = '';
  settingsUi.passwordBusy = false;
  settingsUi.passwordError = null;
  settingsUi.passwordNotice = null;
  settingsUi.clients = [];
  settingsUi.clientsBusy = false;
  settingsUi.clientsError = null;
  settingsUi.clientsNotice = null;
  settingsUi.revoking.clear();
  settingsUi.clientName = '';
  settingsUi.clientCreating = false;
  settingsUi.clientCreateError = null;
  settingsUi.createdClient = null;
  settingsUi.clientCopyNotice = null;
  settingsUi.clientCopyError = null;
}

function openSettings(): void {
  if (state.phase !== 'shell' || state.screen === 'settings') return;
  state.screen = 'settings';
  renderShell();
  void loadSettingsSnapshot();
  void loadSettingsSources();
  void loadSettingsClients();
}

function closeSettings(): void {
  if (state.screen !== 'settings') return;
  // Leaving the page must not keep entered passwords in the in-memory form.
  settingsUi.passwordCurrent = '';
  settingsUi.passwordNew = '';
  settingsUi.passwordConfirm = '';
  settingsUi.passwordError = null;
  settingsUi.passwordNotice = null;
  state.screen = 'console';
  renderShell();
  // Events that arrived while the settings screen covered the list were not
  // painted; take one snapshot now so the console is never stale.
  if (missedPushRefresh) {
    missedPushRefresh = false;
    void loadProposals();
  }
}

function buildSettingsHeader(): HTMLElement {
  const header = el('header', 'topbar');
  const brand = el('div', 'brand');
  const title = el('h1', 'brand-title');
  title.textContent = '设置';
  const sub = el('p', 'brand-sub');
  sub.textContent = state.version.length > 0 ? `SQL 审批 v${state.version}` : 'SQL 审批';
  brand.append(title, sub);

  const group = el('div', 'head-actions');
  const back = button('返回审批台', 'btn ghost small', () => {
    closeSettings();
  });
  const lock = button('锁定', 'btn ghost small', () => {
    void lockSession(null);
  });
  group.append(buildHeadStatus(), back, lock);
  header.append(brand, group);
  return header;
}

type ReadonlyLevel = 'ok' | 'warn' | 'unknown' | 'fail';

interface ReadonlyBadgeSpec {
  level: ReadonlyLevel;
  label: string;
  title: string;
  details: string[];
  errorCode?: string;
}

function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'REQUEST_FAILED';
}

function readonlyBadgeSpec(sourceId: string): ReadonlyBadgeSpec {
  if (settingsUi.testing.has(sourceId)) {
    return {
      level: 'unknown',
      label: '校验中…',
      title: '正在测试连接并校验只读状态',
      details: [],
    };
  }
  const failure = settingsUi.testErrors.get(sourceId);
  if (failure !== undefined) {
    return {
      level: 'fail',
      label: '测试失败',
      title: `${failure.code}：${failure.message}`,
      details: [`错误码：${failure.code}`, failure.message],
      errorCode: failure.code,
    };
  }
  const result = settingsUi.testResults.get(sourceId);
  if (result === undefined) {
    return { level: 'unknown', label: '未校验', title: '尚未测试该数据源', details: [] };
  }
  if (!result.ok) {
    const code = result.error_code ?? 'UNKNOWN';
    return {
      level: 'fail',
      label: '测试失败',
      title: `连接失败（${code}）`,
      details: [`错误码：${code}`, ...result.readonly.details],
      errorCode: code,
    };
  }
  if (!result.readonly.checked) {
    return {
      level: 'unknown',
      label: '未验证',
      title: '连接测试未能判定写权限，严格模式只拦截已确认可写的账号',
      details: result.readonly.details,
    };
  }
  if (result.readonly.ok) {
    return {
      level: 'ok',
      label: '只读',
      title: '连接测试确认当前连接为只读',
      details: result.readonly.details,
    };
  }
  return {
    level: 'warn',
    label: '可写风险 · 严格模式将阻止执行',
    title: '连接测试发现该账号具备写权限',
    details: result.readonly.details,
  };
}

function buildReadonlyBadge(sourceId: string): HTMLElement {
  const spec = readonlyBadgeSpec(sourceId);
  const wrap = el('span', 'readonly-badge-group');
  const badgeClass = `badge readonly-badge readonly-${spec.level}`;

  if (spec.errorCode !== undefined) {
    wrap.append(span('source-test-fail', `错误码 ${spec.errorCode}`));
  }
  if (spec.details.length === 0) {
    const badge = span(badgeClass, spec.label);
    badge.title = spec.title;
    wrap.append(badge);
    return wrap;
  }

  const details = el('details', 'readonly-details');
  const summary = el('summary', 'readonly-details-summary');
  summary.title = '点击展开只读判定详情';
  const summaryBadge = span(badgeClass, spec.label);
  summaryBadge.title = spec.title;
  summary.append(summaryBadge);
  const list = el('ul', 'readonly-details-list');
  for (const detail of spec.details) {
    const item = el('li');
    item.textContent = detail;
    list.append(item);
  }
  details.append(summary, list);
  wrap.append(details);
  return wrap;
}

function strictReadonlyEnabled(): boolean {
  return (
    state.settings?.settings['security.require_readonly_source'] ??
    DEFAULT_SETTINGS['security.require_readonly_source']
  );
}

/** A confirmed writable source is the only case strict mode refuses. */
function sourceKnownWritable(sourceId: string): boolean {
  const result = settingsUi.testResults.get(sourceId);
  return result !== undefined && result.readonly.checked && result.readonly.ok === false;
}

function buildSourceTestBlock(source: SourceSummary): HTMLElement {
  const block = el('div', 'source-test-block');
  if (settingsUi.testing.has(source.id)) {
    const hint = el('p', 'hint');
    hint.textContent = '正在测试连接并校验只读状态…';
    block.append(hint);
    return block;
  }

  const error = settingsUi.testErrors.get(source.id);
  if (error !== undefined) {
    const node = el('p', 'error');
    node.setAttribute('role', 'alert');
    node.textContent = `${error.code}：${error.message}`;
    block.append(node);
  }

  const result = settingsUi.testResults.get(source.id);
  if (result === undefined) return block;

  const line = el('p', 'source-test-line');
  line.append(span('source-test-latency', `延迟 ${result.latency_ms} ms`));
  if (!result.ok) {
    const failure = span(
      'source-test-fail',
      result.error_code === undefined
        ? ' · 连接失败'
        : ` · 连接失败（${result.error_code}）`,
    );
    line.append(failure);
  }
  block.append(line);

  if (result.server !== undefined) {
    const server = el('p', 'hint');
    server.textContent = `服务器：${result.server}`;
    block.append(server);
  }

  return block;
}

function buildSourceRow(source: SourceSummary): HTMLElement {
  const row = el('li', 'source-row');
  const line = el('div', 'source-line');
  const main = el('div', 'source-main');
  const name = span('source-name', source.name);
  name.title = source.name;
  const dialect = span('badge', DIALECT_LABELS[source.dialect] ?? source.dialect);
  main.append(name, dialect, buildReadonlyBadge(source.id));

  const id = el('code', 'source-id');
  id.textContent = truncatedId(source.id);
  id.title = source.id;

  const busy = settingsUi.deleting.has(source.id);
  const testing = settingsUi.testing.has(source.id);
  const editing = settingsUi.editingId === source.id;
  const actions = el('div', 'source-actions');

  const test = button(testing ? '测试中…' : '测试', 'btn ghost small', () => {
    void testSourceRow(source);
  });
  test.disabled = testing || busy;
  test.setAttribute('aria-label', `测试数据源 ${source.name}`);

  const edit = button(editing ? '收起' : '编辑', 'btn ghost small', () => {
    toggleSourceEdit(source);
  });
  edit.disabled = settingsUi.editBusy || busy;
  edit.setAttribute('aria-label', `${editing ? '收起' : '编辑'}数据源 ${source.name}`);

  const remove = button(busy ? '删除中…' : '删除', 'btn danger small', () => {
    void deleteSourceRow(source);
  });
  remove.disabled = busy || settingsUi.addBusy || settingsUi.editBusy;
  remove.setAttribute('aria-label', `删除数据源 ${source.name}`);

  actions.append(test, edit, remove);
  line.append(main, id, actions);
  row.append(line);

  if (testing || settingsUi.testResults.has(source.id) || settingsUi.testErrors.has(source.id)) {
    row.append(buildSourceTestBlock(source));
  }
  if (editing) row.append(buildSourceEditForm(source));
  return row;
}

function buildSourceList(): HTMLElement {
  const wrap = el('div', 'source-block');

  if (settingsUi.sourcesBusy && state.sources.length === 0) {
    const busy = el('p', 'hint');
    busy.textContent = '正在加载数据源…';
    wrap.append(busy);
  } else if (state.sources.length === 0) {
    const empty = el('p', 'empty compact');
    empty.textContent = '暂无数据源，请使用下方表单添加。';
    wrap.append(empty);
  } else {
    const list = el('ul', 'source-list');
    for (const source of state.sources) list.append(buildSourceRow(source));
    wrap.append(list);
  }

  if (settingsUi.sourcesError !== null) {
    const error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.textContent = settingsUi.sourcesError;
    wrap.append(error);
  }
  if (settingsUi.sourcesNotice !== null) {
    const notice = el('p', 'notice');
    notice.setAttribute('role', 'status');
    notice.textContent = settingsUi.sourcesNotice;
    wrap.append(notice);
  }
  return wrap;
}

function validateSourceForm(formState: SourceFormState): string | null {
  if (formState.name.trim().length === 0) return '请填写数据源名称';
  if (formState.dialect === 'sqlite') {
    if (formState.file.trim().length === 0) return '请填写 SQLite 数据库文件路径';
    return null;
  }
  if (formState.host.trim().length === 0) return '请填写主机地址';
  const portText = formState.port.trim();
  if (!/^\d+$/.test(portText)) return '端口必须是 1–65535 之间的整数';
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) return '端口必须是 1–65535 之间的整数';
  if (formState.database.trim().length === 0) return '请填写数据库名';
  if (formState.username.trim().length === 0) return '请填写用户名';
  return null;
}

function toSourceInput(formState: SourceFormState): SourceCreateInput {
  const name = formState.name.trim();
  if (formState.dialect === 'sqlite') {
    return { name, dialect: 'sqlite', connection: { file: formState.file.trim() } };
  }
  const connection: SourceCreateInput['connection'] = {
    host: formState.host.trim(),
    port: Number.parseInt(formState.port, 10),
    database: formState.database.trim(),
    username: formState.username.trim(),
    password: formState.password,
  };
  if (formState.dialect === 'mssql' && formState.trust) {
    connection.trustServerCertificate = true;
  }
  return { name, dialect: formState.dialect, connection };
}

function buildSourceForm(): HTMLElement {
  const formState = settingsUi.form;
  const form = el('form', 'form-grid');
  form.noValidate = true;

  const name = inputField(
    'source-name',
    '名称',
    formState.name,
    (value) => {
      formState.name = value;
    },
    { placeholder: '例如：本机业务库' },
  );

  const dialectField = el('label', 'field');
  dialectField.htmlFor = 'source-dialect';
  const dialectLabel = el('span', 'field-label');
  dialectLabel.textContent = '方言';
  const dialectSelect = el('select', 'input');
  dialectSelect.id = 'source-dialect';
  for (const item of SOURCE_DIALECTS) {
    const option = el('option');
    option.value = item;
    option.textContent = DIALECT_LABELS[item];
    dialectSelect.append(option);
  }
  dialectSelect.value = formState.dialect;
  dialectField.append(dialectLabel, dialectSelect);

  const file = inputField(
    'source-file',
    '数据库文件路径',
    formState.file,
    (value) => {
      formState.file = value;
    },
    { placeholder: '例如：C:\\data\\app.db' },
  );
  file.field.classList.add('span-2');

  const host = inputField(
    'source-host',
    '主机',
    formState.host,
    (value) => {
      formState.host = value;
    },
    { placeholder: '例如：127.0.0.1' },
  );
  const port = inputField(
    'source-port',
    '端口',
    formState.port,
    (value) => {
      formState.port = value;
    },
    { type: 'number' },
  );
  const database = inputField(
    'source-database',
    '数据库',
    formState.database,
    (value) => {
      formState.database = value;
    },
  );
  const username = inputField(
    'source-username',
    '用户名',
    formState.username,
    (value) => {
      formState.username = value;
    },
  );

  const password = passwordField(
    'source-password',
    '密码',
    '数据库密码（可留空）',
    'new-password',
  );
  password.input.value = formState.password;
  password.input.addEventListener('input', () => {
    formState.password = password.input.value;
  });

  const trustField = el('label', 'check-field');
  const trust = el('input');
  trust.type = 'checkbox';
  trust.checked = formState.trust;
  trust.addEventListener('change', () => {
    formState.trust = trust.checked;
  });
  const trustText = el('span');
  trustText.textContent = '信任服务器证书（trustServerCertificate，仅 SQL Server）';
  trustField.append(trust, trustText);

  const serverFields = [host.field, port.field, database.field, username.field, password.field];

  const applyDialect = (resetPort: boolean): void => {
    const dialect = dialectSelect.value as SourceDialect;
    formState.dialect = dialect;
    const sqlite = dialect === 'sqlite';
    file.field.hidden = !sqlite;
    for (const field of serverFields) field.hidden = sqlite;
    trustField.hidden = dialect !== 'mssql';
    if (!sqlite && resetPort) {
      const nextPort = DEFAULT_PORTS[dialect];
      formState.port = nextPort;
      port.input.value = nextPort;
    }
  };
  applyDialect(false);
  dialectSelect.addEventListener('change', () => {
    applyDialect(true);
  });

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.addError === null;
  error.textContent = settingsUi.addError ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.addBusy;
  submit.textContent = settingsUi.addBusy ? '添加中…' : '添加数据源';
  const actions = el('div', 'form-actions span-2');
  actions.append(submit);

  form.append(
    name.field,
    dialectField,
    file.field,
    host.field,
    port.field,
    database.field,
    username.field,
    password.field,
    trustField,
    error,
    actions,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitSourceForm();
  });
  return form;
}

async function submitSourceForm(): Promise<void> {
  if (settingsUi.addBusy) return;
  settingsUi.addError = null;

  const problem = validateSourceForm(settingsUi.form);
  if (problem !== null) {
    settingsUi.addError = problem;
    repaintSettings();
    return;
  }

  const dialect = settingsUi.form.dialect;
  const name = settingsUi.form.name.trim();
  const input = toSourceInput(settingsUi.form);
  settingsUi.addBusy = true;
  repaintSettings();
  try {
    await call(() => api.createSource(input));
    settingsUi.form = emptySourceForm(dialect);
    settingsUi.sourcesNotice = `已添加数据源「${name}」`;
    await loadSettingsSources();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.addError = describeActionError(error);
  } finally {
    settingsUi.addBusy = false;
    repaintSettings();
  }
}

async function deleteSourceRow(source: SourceSummary): Promise<void> {
  if (settingsUi.deleting.has(source.id)) return;
  if (!window.confirm(`确定删除数据源「${source.name}」吗？该操作不可撤销。`)) return;

  settingsUi.deleting.add(source.id);
  settingsUi.sourcesError = null;
  settingsUi.sourcesNotice = null;
  repaintSettings();
  try {
    await call(() => api.deleteSource(source.id));
    state.sources = state.sources.filter((item) => item.id !== source.id);
    state.sourceNames.delete(source.id);
    settingsUi.testResults.delete(source.id);
    settingsUi.testErrors.delete(source.id);
    settingsUi.testing.delete(source.id);
    if (settingsUi.editingId === source.id) {
      settingsUi.editingId = null;
      settingsUi.editForm = emptySourceForm();
      settingsUi.editError = null;
    }
    settingsUi.sourcesNotice = `已删除数据源「${source.name}」`;
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.sourcesError = describeActionError(error);
  } finally {
    settingsUi.deleting.delete(source.id);
    repaintSettings();
  }
}

async function testSourceRow(source: SourceSummary): Promise<void> {
  if (settingsUi.testing.has(source.id)) return;
  settingsUi.testing.add(source.id);
  settingsUi.testErrors.delete(source.id);
  repaintSettings();
  try {
    const result = await call(() => api.testSource(source.id));
    settingsUi.testResults.set(source.id, result);
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.testErrors.set(source.id, {
      code: errorCodeOf(error),
      message: error instanceof ApiError ? error.message : describeError(error),
    });
  } finally {
    settingsUi.testing.delete(source.id);
    repaintSettings();
  }
}

function toggleSourceEdit(source: SourceSummary): void {
  if (settingsUi.editBusy) return;
  if (settingsUi.editingId === source.id) {
    cancelSourceEdit();
    return;
  }
  const formState = emptySourceForm(source.dialect);
  formState.name = source.name;
  // Connection fields start blank: an empty field keeps the stored value.
  formState.port = '';
  settingsUi.editingId = source.id;
  settingsUi.editForm = formState;
  settingsUi.editError = null;
  settingsUi.sourcesNotice = null;
  repaintSettings();
}

function cancelSourceEdit(): void {
  settingsUi.editingId = null;
  settingsUi.editForm = emptySourceForm();
  settingsUi.editError = null;
  repaintSettings();
}

/** Only the edited connection fields are sent; the vault merges them. */
function buildPartialSourceConnection(formState: SourceFormState): SourceConnectionInput {
  const connection: SourceConnectionInput = {};
  if (formState.dialect === 'sqlite') {
    if (formState.file.trim().length > 0) connection.file = formState.file.trim();
    return connection;
  }
  if (formState.host.trim().length > 0) connection.host = formState.host.trim();
  if (formState.port.trim().length > 0) connection.port = Number.parseInt(formState.port, 10);
  if (formState.database.trim().length > 0) connection.database = formState.database.trim();
  if (formState.username.trim().length > 0) connection.username = formState.username.trim();
  if (formState.password.length > 0) connection.password = formState.password;
  return connection;
}

function buildSourceEditForm(source: SourceSummary): HTMLElement {
  const formState = settingsUi.editForm;
  const form = el('form', 'form-grid source-edit');
  form.noValidate = true;

  const hint = el('p', 'hint span-2');
  hint.textContent =
    '连接字段留空表示保持原值；密码留空表示保持原密码。修改方言时必须重新填写连接信息。';

  const name = inputField('source-edit-name', '名称', formState.name, (value) => {
    formState.name = value;
  });

  const dialectField = el('label', 'field');
  dialectField.htmlFor = 'source-edit-dialect';
  const dialectLabel = el('span', 'field-label');
  dialectLabel.textContent = '方言';
  const dialectSelect = el('select', 'input');
  dialectSelect.id = 'source-edit-dialect';
  for (const item of SOURCE_DIALECTS) {
    const option = el('option');
    option.value = item;
    option.textContent = DIALECT_LABELS[item];
    dialectSelect.append(option);
  }
  dialectSelect.value = formState.dialect;
  dialectField.append(dialectLabel, dialectSelect);

  const file = inputField(
    'source-edit-file',
    '数据库文件路径',
    formState.file,
    (value) => {
      formState.file = value;
    },
    { placeholder: '留空 = 保持不变' },
  );
  file.field.classList.add('span-2');

  const host = inputField(
    'source-edit-host',
    '主机',
    formState.host,
    (value) => {
      formState.host = value;
    },
    { placeholder: '留空 = 保持不变' },
  );
  const port = inputField(
    'source-edit-port',
    '端口',
    formState.port,
    (value) => {
      formState.port = value;
    },
    { type: 'number', placeholder: '留空 = 保持不变' },
  );
  const database = inputField(
    'source-edit-database',
    '数据库',
    formState.database,
    (value) => {
      formState.database = value;
    },
    { placeholder: '留空 = 保持不变' },
  );
  const username = inputField(
    'source-edit-username',
    '用户名',
    formState.username,
    (value) => {
      formState.username = value;
    },
    { placeholder: '留空 = 保持不变' },
  );
  const password = passwordField(
    'source-edit-password',
    '密码',
    '留空 = 保持原密码',
    'new-password',
  );
  password.input.value = formState.password;
  password.input.addEventListener('input', () => {
    formState.password = password.input.value;
  });

  const serverFields = [host.field, port.field, database.field, username.field, password.field];
  const applyDialect = (resetPort: boolean): void => {
    const dialect = dialectSelect.value as SourceDialect;
    formState.dialect = dialect;
    const sqlite = dialect === 'sqlite';
    file.field.hidden = !sqlite;
    for (const field of serverFields) field.hidden = sqlite;
    if (!sqlite && resetPort) {
      const nextPort = DEFAULT_PORTS[dialect];
      formState.port = nextPort;
      port.input.value = nextPort;
    }
  };
  applyDialect(false);
  dialectSelect.addEventListener('change', () => {
    applyDialect(true);
  });

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.editError === null;
  error.textContent = settingsUi.editError ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.editBusy;
  submit.textContent = settingsUi.editBusy ? '保存中…' : '保存修改';
  const cancel = button('取消', 'btn ghost', () => {
    cancelSourceEdit();
  });
  cancel.disabled = settingsUi.editBusy;
  const actions = el('div', 'form-actions span-2');
  actions.append(cancel, submit);

  form.append(
    hint,
    name.field,
    dialectField,
    file.field,
    host.field,
    port.field,
    database.field,
    username.field,
    password.field,
    error,
    actions,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitSourceEdit(source);
  });
  return form;
}

async function submitSourceEdit(source: SourceSummary): Promise<void> {
  if (settingsUi.editBusy) return;
  settingsUi.editError = null;

  const formState = settingsUi.editForm;
  const name = formState.name.trim();
  if (name.length === 0) {
    settingsUi.editError = '请填写数据源名称';
    repaintSettings();
    return;
  }

  const dialectChanged = formState.dialect !== source.dialect;
  const patch: SourceUpdateInput = { name, dialect: formState.dialect };
  if (dialectChanged) {
    const problem = validateSourceForm(formState);
    if (problem !== null) {
      settingsUi.editError = problem;
      repaintSettings();
      return;
    }
    patch.connection = toSourceInput(formState).connection;
  } else {
    const portText = formState.port.trim();
    if (portText.length > 0) {
      const port = Number.parseInt(portText, 10);
      if (!/^\d+$/.test(portText) || !Number.isFinite(port) || port < 1 || port > 65535) {
        settingsUi.editError = '端口必须是 1–65535 之间的整数';
        repaintSettings();
        return;
      }
    }
    const connection = buildPartialSourceConnection(formState);
    if (Object.keys(connection).length > 0) patch.connection = connection;
  }

  settingsUi.editBusy = true;
  repaintSettings();
  try {
    const updated = await call(() => api.updateSource(source.id, patch));
    state.sources = state.sources.map((item) => (item.id === source.id ? updated : item));
    state.sourceNames.set(updated.id, updated.name);
    settingsUi.editingId = null;
    settingsUi.editForm = emptySourceForm();
    settingsUi.sourcesNotice = `已更新数据源「${updated.name}」`;
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.editError = describeActionError(error);
  } finally {
    settingsUi.editBusy = false;
    repaintSettings();
  }
}

function buildSourcesCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const head = el('div', 'section-head');
  const title = el('h2', 'section-title');
  title.textContent = '数据源';
  const count = span('count', `${state.sources.length} 个`);
  head.append(title, count);

  const hint = el('p', 'hint');
  hint.textContent = '数据源用于识别提案来源并执行审批查询；连接信息由 core 加密保存。';

  const subtitle = el('h3', 'section-subtitle');
  subtitle.textContent = '添加数据源';

  section.append(head, hint, buildSourceList(), subtitle, buildSourceForm());
  return section;
}

/* --------------------------------------------------------- agent clients */

function buildClientsCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const head = el('div', 'section-head');
  const title = el('h2', 'section-title');
  title.textContent = 'Agent 客户端';
  const count = span('count', `${settingsUi.clients.length} 个`);
  head.append(title, count);

  const hint = el('p', 'hint');
  hint.textContent =
    'Agent token 供 DSH/MCP 提交与查询提案；只能提交/查询，不能批准。token 只在创建时显示一次。';

  section.append(head, hint);
  if (settingsUi.createdClient !== null) {
    section.append(buildClientTokenPanel(settingsUi.createdClient));
  }
  section.append(buildClientList());

  const subtitle = el('h3', 'section-subtitle');
  subtitle.textContent = '创建 token';
  section.append(subtitle, buildClientCreateForm());
  return section;
}

/** One-time token panel: shown until the operator confirms having saved it. */
function buildClientTokenPanel(created: ClientCreateResponse): HTMLElement {
  const panel = el('div', 'token-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', '新建 Agent token');

  const title = el('p', 'token-title');
  title.textContent = `「${created.name}」的 Agent token`;

  const warning = el('p', 'token-warning');
  warning.textContent =
    '只显示一次，关闭后无法再次查看；只能提交/查询，不能批准。';

  const line = el('div', 'token-line');
  const value = el('code', 'token-value');
  value.textContent = created.token;
  value.title = '点击可全选 token';
  const copy = button('复制', 'btn ghost small', () => {
    void copyAgentToken(created.token);
  });
  copy.setAttribute('aria-label', '复制 Agent token');
  line.append(value, copy);

  panel.append(title, warning, line);

  if (settingsUi.clientCopyError !== null) {
    const error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.textContent = settingsUi.clientCopyError;
    panel.append(error);
  } else if (settingsUi.clientCopyNotice !== null) {
    const notice = el('p', 'notice');
    notice.setAttribute('role', 'status');
    notice.textContent = settingsUi.clientCopyNotice;
    panel.append(notice);
  }

  const actions = el('div', 'token-actions');
  const saved = button('我已保存', 'btn primary small', () => {
    settingsUi.createdClient = null;
    settingsUi.clientCopyNotice = null;
    settingsUi.clientCopyError = null;
    void loadSettingsClients();
  });
  saved.setAttribute('aria-label', '我已保存该 token，关闭面板');
  actions.append(saved);
  panel.append(actions);
  return panel;
}

function buildClientList(): HTMLElement {
  const wrap = el('div', 'source-block');

  if (settingsUi.clientsBusy && settingsUi.clients.length === 0) {
    const busy = el('p', 'hint');
    busy.textContent = '正在加载 Agent 客户端…';
    wrap.append(busy);
  } else if (settingsUi.clients.length === 0) {
    const empty = el('p', 'empty compact');
    empty.textContent = '还没有 Agent 客户端；DSH/MCP 需要 token 才能提交提案';
    wrap.append(empty);
  } else {
    const list = el('ul', 'source-list');
    for (const client of settingsUi.clients) list.append(buildClientRow(client));
    wrap.append(list);
  }

  if (settingsUi.clientsError !== null) {
    const error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.textContent = settingsUi.clientsError;
    wrap.append(error);
  }
  if (settingsUi.clientsNotice !== null) {
    const notice = el('p', 'notice');
    notice.setAttribute('role', 'status');
    notice.textContent = settingsUi.clientsNotice;
    wrap.append(notice);
  }
  return wrap;
}

function buildClientRow(client: ClientSummary): HTMLElement {
  const row = el('li', 'source-row');
  const line = el('div', 'source-line');
  const main = el('div', 'source-main');
  const name = span('source-name', client.name);
  name.title = client.name;
  const disabled = client.disabled !== 0;
  const status = span(
    disabled ? 'badge badge-off' : 'badge badge-on',
    disabled ? '已禁用' : '生效中',
  );
  main.append(name, status);

  const meta = el('p', 'client-meta');
  const created = span(
    'client-meta-item',
    `创建于 ${formatRelative(client.created_at)}（${formatDateTime(client.created_at)}）`,
  );
  created.title = `创建时间：${formatDateTime(client.created_at)}`;
  const used = span(
    'client-meta-item',
    client.last_used_at === null
      ? '从未使用'
      : `最近使用 ${formatRelative(client.last_used_at)}`,
  );
  used.title =
    client.last_used_at === null
      ? '该 token 从未被用于调用 API'
      : `最近使用：${formatDateTime(client.last_used_at)}`;
  const id = el('code', 'source-id');
  id.textContent = truncatedId(client.id);
  id.title = client.id;
  meta.append(
    created,
    span('meta-sep', '·'),
    used,
    span('meta-sep', '·'),
    id,
  );

  const busy = settingsUi.revoking.has(client.id);
  const actions = el('div', 'source-actions');
  const revoke = button(busy ? '撤销中…' : '撤销', 'btn danger small', () => {
    void revokeClient(client);
  });
  revoke.disabled = busy || disabled;
  revoke.setAttribute('aria-label', `撤销 Agent 客户端 ${client.name}`);
  actions.append(revoke);

  line.append(main, actions);
  row.append(line, meta);
  return row;
}

function buildClientCreateForm(): HTMLElement {
  const form = el('form', 'form-grid');
  form.noValidate = true;

  const name = inputField(
    'client-name',
    '客户端名称',
    settingsUi.clientName,
    (value) => {
      settingsUi.clientName = value;
    },
    { placeholder: '例如：dsh-local、mcp-claude', autocomplete: 'off' },
  );
  name.field.classList.add('span-2');

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.clientCreateError === null;
  error.textContent = settingsUi.clientCreateError ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.clientCreating;
  submit.textContent = settingsUi.clientCreating ? '创建中…' : '创建 token';
  const actions = el('div', 'form-actions span-2');
  actions.append(submit);

  form.append(name.field, error, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitClientForm();
  });
  return form;
}

async function submitClientForm(): Promise<void> {
  if (settingsUi.clientCreating) return;
  settingsUi.clientCreateError = null;
  const name = settingsUi.clientName.trim();

  if (name.length === 0) {
    settingsUi.clientCreateError = '请填写客户端名称';
    repaintSettings();
    return;
  }
  if (name.length > 100) {
    settingsUi.clientCreateError = '客户端名称不能超过 100 个字符';
    repaintSettings();
    return;
  }

  settingsUi.clientCreating = true;
  repaintSettings();
  try {
    const created = await call(() => api.createClient(name));
    settingsUi.createdClient = created;
    settingsUi.clientName = '';
    settingsUi.clientCopyNotice = null;
    settingsUi.clientCopyError = null;
    settingsUi.clientsError = null;
    settingsUi.clientsNotice = null;
    settingsUi.clients.push({
      id: created.id,
      name: created.name,
      created_at: created.created_at,
      last_used_at: null,
      disabled: 0,
    });
    await loadSettingsClients();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.clientCreateError = describeActionError(error);
  } finally {
    settingsUi.clientCreating = false;
    repaintSettings();
  }
}

async function copyAgentToken(token: string): Promise<void> {
  settingsUi.clientCopyNotice = null;
  settingsUi.clientCopyError = null;
  try {
    const clipboard = (navigator as Navigator & { clipboard?: Clipboard })
      .clipboard;
    if (clipboard === undefined) throw new Error('clipboard unavailable');
    await clipboard.writeText(token);
    settingsUi.clientCopyNotice = '已复制到剪贴板';
  } catch {
    settingsUi.clientCopyError = '复制失败，请手动选中 token 后复制';
  } finally {
    repaintSettings();
  }
}

async function revokeClient(client: ClientSummary): Promise<void> {
  if (settingsUi.revoking.has(client.id)) return;
  if (
    !window.confirm(
      `确定撤销 Agent 客户端「${client.name}」吗？撤销后该 token 立即失效且无法恢复。`,
    )
  ) {
    return;
  }

  settingsUi.revoking.add(client.id);
  settingsUi.clientsError = null;
  settingsUi.clientsNotice = null;
  repaintSettings();
  try {
    await call(() => api.revokeClient(client.id));
    settingsUi.clientsNotice = `已撤销「${client.name}」的 token`;
    await loadSettingsClients();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.clientsError = describeActionError(error);
  } finally {
    settingsUi.revoking.delete(client.id);
    repaintSettings();
  }
}

function buildSettingsStatus(): HTMLElement {
  const wrap = el('div');
  const hint = el('p', 'hint');
  hint.textContent = settingsUi.settingsBusy ? '正在加载设置…' : '设置尚未加载。';
  wrap.append(hint);
  if (settingsUi.settingsError !== null) {
    const error = el('p', 'error');
    error.setAttribute('role', 'alert');
    error.textContent = settingsUi.settingsError;
    wrap.append(error);
  }
  if (!settingsUi.settingsBusy) {
    const retry = button('重试加载', 'btn ghost small', () => {
      void loadSettingsSnapshot();
    });
    wrap.append(retry);
  }
  return wrap;
}

function buildSessionSettingsCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const head = el('div', 'section-head');
  const title = el('h2', 'section-title');
  title.textContent = '会话与锁定';
  head.append(title);

  const hint = el('p', 'hint');
  hint.textContent =
    '空闲超时后自动锁定；关闭倒计时只隐藏头部显示，空闲锁定仍然生效。';
  section.append(head, hint);

  if (state.settings === null) {
    section.append(buildSettingsStatus());
    return section;
  }

  const ranges = state.settings.ranges;
  const formState = settingsUi.sessionForm;
  const form = el('form', 'form-grid');
  form.noValidate = true;

  const idle = numberSettingField(
    'setting-idle-minutes',
    '空闲锁定（分钟）',
    formState.idleMinutes,
    ranges['session.idle_minutes'],
    (value) => {
      formState.idleMinutes = value;
    },
    '1 分钟–1 天',
  );
  const absolute = numberSettingField(
    'setting-absolute-hours',
    '会话绝对上限（小时）',
    formState.absoluteHours,
    ranges['session.absolute_hours'],
    (value) => {
      formState.absoluteHours = value;
    },
    `范围 ${rangeText(ranges['session.absolute_hours'])} 小时`,
  );

  const checkField = el('label', 'check-field');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = formState.showCountdown;
  checkbox.addEventListener('change', () => {
    formState.showCountdown = checkbox.checked;
  });
  const checkText = el('span');
  checkText.textContent = '显示空闲倒计时（关闭后仍会空闲锁定）';
  checkField.append(checkbox, checkText);

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.sessionError === null;
  error.textContent = settingsUi.sessionError ?? '';

  const notice = el('p', 'notice span-2');
  notice.setAttribute('role', 'status');
  notice.hidden = settingsUi.sessionNotice === null;
  notice.textContent = settingsUi.sessionNotice ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.sessionBusy;
  submit.textContent = settingsUi.sessionBusy ? '保存中…' : '保存会话设置';
  const actions = el('div', 'form-actions span-2');
  actions.append(submit);

  form.append(idle.field, absolute.field, checkField, error, notice, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSessionSettings();
  });
  section.append(form);
  return section;
}

async function saveSessionSettings(): Promise<void> {
  if (settingsUi.sessionBusy) return;
  const ranges = state.settings?.ranges;
  if (ranges === undefined) return;
  const formState = settingsUi.sessionForm;

  const idle = parseBoundedInt(formState.idleMinutes, ranges['session.idle_minutes']);
  if (idle === null) {
    settingsUi.sessionError = `空闲锁定必须是 ${rangeText(
      ranges['session.idle_minutes'],
    )} 的整数`;
    settingsUi.sessionNotice = null;
    repaintSettings();
    return;
  }
  const absolute = parseBoundedInt(
    formState.absoluteHours,
    ranges['session.absolute_hours'],
  );
  if (absolute === null) {
    settingsUi.sessionError = `会话绝对上限必须是 ${rangeText(
      ranges['session.absolute_hours'],
    )} 的整数`;
    settingsUi.sessionNotice = null;
    repaintSettings();
    return;
  }

  const patch: Partial<SettingsValues> = {
    'session.idle_minutes': idle,
    'session.absolute_hours': absolute,
    'ui.show_countdown': formState.showCountdown,
  };
  settingsUi.sessionBusy = true;
  settingsUi.sessionError = null;
  settingsUi.sessionNotice = null;
  repaintSettings();
  try {
    const response = await call(() => api.updateSettings(patch));
    if (state.settings !== null) {
      state.settings = { ...state.settings, settings: response.settings };
    }
    settingsUi.sessionForm = {
      idleMinutes: String(response.settings['session.idle_minutes']),
      absoluteHours: String(response.settings['session.absolute_hours']),
      showCountdown: response.settings['ui.show_countdown'],
    };
    settingsUi.sessionNotice = '已保存会话与锁定设置并立即生效。';
    updateCountdown();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.sessionError = describeActionError(error);
  } finally {
    settingsUi.sessionBusy = false;
    repaintSettings();
  }
}

function buildExecutionSettingsCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const head = el('div', 'section-head');
  const title = el('h2', 'section-title');
  title.textContent = '审批与执行';
  head.append(title);

  const hint = el('p', 'hint');
  hint.textContent =
    '默认值与上限由服务端校验；提案请求未指定时使用这里的默认值。';
  section.append(head, hint);

  if (state.settings === null) {
    section.append(buildSettingsStatus());
    return section;
  }

  const ranges = state.settings.ranges;
  const formState = settingsUi.executionForm;
  const form = el('form', 'form-grid');
  form.noValidate = true;

  const defaultRows = numberSettingField(
    'setting-default-rows',
    '默认行数',
    formState.defaultMaxRows,
    ranges['proposal.default_max_rows'],
    (value) => {
      formState.defaultMaxRows = value;
    },
    `范围 ${rangeText(ranges['proposal.default_max_rows'])}`,
  );
  const maxRows = numberSettingField(
    'setting-max-rows',
    '最大行数',
    formState.maxMaxRows,
    ranges['proposal.max_max_rows'],
    (value) => {
      formState.maxMaxRows = value;
    },
    `范围 ${rangeText(ranges['proposal.max_max_rows'])}`,
  );
  const defaultTimeout = numberSettingField(
    'setting-default-timeout',
    '默认超时（秒）',
    formState.defaultTimeoutS,
    ranges['proposal.default_timeout_s'],
    (value) => {
      formState.defaultTimeoutS = value;
    },
    `范围 ${rangeText(ranges['proposal.default_timeout_s'])} 秒`,
  );
  const maxTimeout = numberSettingField(
    'setting-max-timeout',
    '最大超时（秒）',
    formState.maxTimeoutS,
    ranges['proposal.max_timeout_s'],
    (value) => {
      formState.maxTimeoutS = value;
    },
    `范围 ${rangeText(ranges['proposal.max_timeout_s'])} 秒`,
  );
  const approvalWindow = numberSettingField(
    'setting-approval-window',
    '审批窗口（小时）',
    formState.approvalWindowHours,
    ranges['proposal.approval_window_hours'],
    (value) => {
      formState.approvalWindowHours = value;
    },
    `范围 ${rangeText(ranges['proposal.approval_window_hours'])} 小时`,
  );
  const resultTtl = numberSettingField(
    'setting-result-ttl',
    '结果保留（小时）',
    formState.resultTtlHours,
    ranges['result.ttl_hours'],
    (value) => {
      formState.resultTtlHours = value;
    },
    `范围 ${rangeText(ranges['result.ttl_hours'])} 小时`,
  );

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.executionError === null;
  error.textContent = settingsUi.executionError ?? '';

  const notice = el('p', 'notice span-2');
  notice.setAttribute('role', 'status');
  notice.hidden = settingsUi.executionNotice === null;
  notice.textContent = settingsUi.executionNotice ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.executionBusy;
  submit.textContent = settingsUi.executionBusy ? '保存中…' : '保存审批设置';
  const actions = el('div', 'form-actions span-2');
  actions.append(submit);

  form.append(
    defaultRows.field,
    maxRows.field,
    defaultTimeout.field,
    maxTimeout.field,
    approvalWindow.field,
    resultTtl.field,
    error,
    notice,
    actions,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveExecutionSettings();
  });
  section.append(form);
  return section;
}

async function saveExecutionSettings(): Promise<void> {
  if (settingsUi.executionBusy) return;
  const ranges = state.settings?.ranges;
  if (ranges === undefined) return;
  const formState = settingsUi.executionForm;

  const fields: Array<{ key: SettingKey; value: string; caption: string }> = [
    {
      key: 'proposal.default_max_rows',
      value: formState.defaultMaxRows,
      caption: '默认行数',
    },
    { key: 'proposal.max_max_rows', value: formState.maxMaxRows, caption: '最大行数' },
    {
      key: 'proposal.default_timeout_s',
      value: formState.defaultTimeoutS,
      caption: '默认超时',
    },
    {
      key: 'proposal.max_timeout_s',
      value: formState.maxTimeoutS,
      caption: '最大超时',
    },
    {
      key: 'proposal.approval_window_hours',
      value: formState.approvalWindowHours,
      caption: '审批窗口',
    },
    { key: 'result.ttl_hours', value: formState.resultTtlHours, caption: '结果保留' },
  ];

  const parsed = new Map<SettingKey, number>();
  for (const field of fields) {
    const value = parseBoundedInt(field.value, ranges[field.key]);
    if (value === null) {
      settingsUi.executionError = `${field.caption}必须是 ${rangeText(
        ranges[field.key],
      )} 的整数`;
      settingsUi.executionNotice = null;
      repaintSettings();
      return;
    }
    parsed.set(field.key, value);
  }

  const defaultRows = parsed.get('proposal.default_max_rows') ?? 0;
  const maxRows = parsed.get('proposal.max_max_rows') ?? 0;
  if (defaultRows > maxRows) {
    settingsUi.executionError = '默认行数不能大于最大行数';
    settingsUi.executionNotice = null;
    repaintSettings();
    return;
  }
  const defaultTimeout = parsed.get('proposal.default_timeout_s') ?? 0;
  const maxTimeout = parsed.get('proposal.max_timeout_s') ?? 0;
  if (defaultTimeout > maxTimeout) {
    settingsUi.executionError = '默认超时不能大于最大超时';
    settingsUi.executionNotice = null;
    repaintSettings();
    return;
  }

  const patch: Partial<SettingsValues> = {
    'proposal.default_max_rows': defaultRows,
    'proposal.max_max_rows': maxRows,
    'proposal.default_timeout_s': defaultTimeout,
    'proposal.max_timeout_s': maxTimeout,
    'proposal.approval_window_hours': parsed.get('proposal.approval_window_hours') ?? 0,
    'result.ttl_hours': parsed.get('result.ttl_hours') ?? 0,
  };
  settingsUi.executionBusy = true;
  settingsUi.executionError = null;
  settingsUi.executionNotice = null;
  repaintSettings();
  try {
    const response = await call(() => api.updateSettings(patch));
    if (state.settings !== null) {
      state.settings = { ...state.settings, settings: response.settings };
    }
    settingsUi.executionForm = {
      defaultMaxRows: String(response.settings['proposal.default_max_rows']),
      maxMaxRows: String(response.settings['proposal.max_max_rows']),
      defaultTimeoutS: String(response.settings['proposal.default_timeout_s']),
      maxTimeoutS: String(response.settings['proposal.max_timeout_s']),
      approvalWindowHours: String(
        response.settings['proposal.approval_window_hours'],
      ),
      resultTtlHours: String(response.settings['result.ttl_hours']),
    };
    settingsUi.executionNotice = '已保存审批与执行设置并立即生效。';
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.executionError = describeActionError(error);
  } finally {
    settingsUi.executionBusy = false;
    repaintSettings();
  }
}

function buildPasswordForm(): HTMLElement {
  const form = el('form', 'form-grid');
  form.noValidate = true;

  const current = passwordField(
    'password-current',
    '当前密码',
    '当前管理密码',
    'current-password',
  );
  current.input.value = settingsUi.passwordCurrent;
  current.input.addEventListener('input', () => {
    settingsUi.passwordCurrent = current.input.value;
  });

  const next = passwordField(
    'password-new',
    '新密码',
    '至少 12 位，含字母和数字',
    'new-password',
  );
  next.input.value = settingsUi.passwordNew;
  next.input.addEventListener('input', () => {
    settingsUi.passwordNew = next.input.value;
  });

  const confirm = passwordField(
    'password-confirm',
    '确认新密码',
    '再次输入新密码',
    'new-password',
  );
  confirm.input.value = settingsUi.passwordConfirm;
  confirm.input.addEventListener('input', () => {
    settingsUi.passwordConfirm = confirm.input.value;
  });

  const error = el('p', 'error span-2');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.passwordError === null;
  error.textContent = settingsUi.passwordError ?? '';

  const notice = el('p', 'notice span-2');
  notice.setAttribute('role', 'status');
  notice.hidden = settingsUi.passwordNotice === null;
  notice.textContent = settingsUi.passwordNotice ?? '';

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.disabled = settingsUi.passwordBusy;
  submit.textContent = settingsUi.passwordBusy ? '更新中…' : '更新密码';
  const actions = el('div', 'form-actions span-2');
  actions.append(submit);

  form.append(current.field, next.field, confirm.field, error, notice, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitPasswordForm();
  });
  return form;
}

async function submitPasswordForm(): Promise<void> {
  if (settingsUi.passwordBusy) return;
  settingsUi.passwordError = null;
  settingsUi.passwordNotice = null;

  if (settingsUi.passwordCurrent.length === 0) {
    settingsUi.passwordError = '请输入当前密码';
    repaintSettings();
    return;
  }
  const problem = validatePassword(settingsUi.passwordNew);
  if (problem !== null) {
    settingsUi.passwordError = problem;
    repaintSettings();
    return;
  }
  if (settingsUi.passwordNew !== settingsUi.passwordConfirm) {
    settingsUi.passwordError = '两次输入的新密码不一致';
    repaintSettings();
    return;
  }

  settingsUi.passwordBusy = true;
  repaintSettings();
  try {
    await call(() => api.changePassword(settingsUi.passwordCurrent, settingsUi.passwordNew));
    settingsUi.passwordCurrent = '';
    settingsUi.passwordNew = '';
    settingsUi.passwordConfirm = '';
    settingsUi.passwordNotice = '密码已更新，其他会话已退出。';
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHENTICATED') {
      if (isEmbeddedMode()) {
        // The transport drops its Bearer token on 401, so the embedded session
        // cannot continue; ask for a fresh unlock.
        handleSessionLost('当前密码不正确，请重新解锁');
        return;
      }
      settingsUi.passwordError = '当前密码不正确（UNAUTHENTICATED）';
    } else if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    } else {
      settingsUi.passwordError = describeActionError(error);
    }
  } finally {
    settingsUi.passwordBusy = false;
    repaintSettings();
  }
}

function buildReadonlySecurityField(): HTMLElement {
  const wrap = el('div', 'security-readonly');
  const loaded = state.settings !== null;
  const enabled =
    state.settings?.settings['security.require_readonly_source'] ??
    DEFAULT_SETTINGS['security.require_readonly_source'];

  const field = el('label', 'check-field');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'setting-require-readonly-source';
  checkbox.checked = enabled;
  checkbox.disabled = !loaded || settingsUi.securityBusy;
  checkbox.addEventListener('change', () => {
    void saveReadonlySetting(checkbox.checked);
  });

  const text = el('span', 'readonly-setting-text');
  const caption = el('span', 'readonly-setting-title');
  caption.textContent = '严格只读校验';
  const description = el('span', 'readonly-setting-desc');
  description.textContent =
    '拒绝使用非只读数据库账号执行查询（探测失败或账号可写时阻止执行）';
  text.append(caption, description);
  field.htmlFor = checkbox.id;
  field.append(checkbox, text);
  wrap.append(field);

  if (!loaded) {
    const hint = el('p', 'hint');
    hint.textContent = settingsUi.settingsBusy
      ? '正在加载严格只读设置…'
      : '设置尚未加载，暂时无法修改严格只读校验。';
    wrap.append(hint);
  }

  const busy = el('p', 'hint');
  busy.hidden = !settingsUi.securityBusy;
  busy.textContent = '正在保存严格只读校验…';

  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  error.hidden = settingsUi.securityError === null;
  error.textContent = settingsUi.securityError ?? '';

  const notice = el('p', 'notice');
  notice.setAttribute('role', 'status');
  notice.hidden = settingsUi.securityNotice === null;
  notice.textContent = settingsUi.securityNotice ?? '';

  wrap.append(busy, error, notice);
  return wrap;
}

async function saveReadonlySetting(value: boolean): Promise<void> {
  if (settingsUi.securityBusy || state.settings === null) return;
  const key = 'security.require_readonly_source' as const;
  const previous = state.settings.settings[key];
  state.settings = {
    ...state.settings,
    settings: { ...state.settings.settings, [key]: value },
  };
  settingsUi.securityBusy = true;
  settingsUi.securityError = null;
  settingsUi.securityNotice = null;
  repaintSettings();
  try {
    const response = await call(() => api.updateSettings({ [key]: value }));
    state.settings = { ...state.settings, settings: response.settings };
    settingsUi.securityNotice = response.settings[key]
      ? '已开启严格只读校验，批准前将强制校验数据源。'
      : '已关闭严格只读校验。';
  } catch (error) {
    // The toggle is optimistic; restore the last known server value on failure.
    state.settings = {
      ...state.settings,
      settings: { ...state.settings.settings, [key]: previous },
    };
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.securityError = describeActionError(error);
  } finally {
    settingsUi.securityBusy = false;
    repaintSettings();
  }
}

function buildSecurityCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const title = el('h2', 'section-title');
  title.textContent = '安全';
  const head = el('div', 'section-head');
  head.append(title);

  const hint = el('p', 'hint');
  hint.textContent = '修改管理密码：至少 12 位，且同时包含字母和数字。';

  section.append(head, hint, buildReadonlySecurityField(), buildPasswordForm());
  return section;
}

function buildAboutCard(): HTMLElement {
  const section = el('section', 'card settings-section');
  const title = el('h2', 'section-title');
  title.textContent = '关于';
  const head = el('div', 'section-head');
  head.append(title);

  const facts = el('dl', 'facts');
  addFact(facts, 'core 版本', state.version.length > 0 ? `v${state.version}` : '未知');
  section.append(head, facts);
  return section;
}

function renderSettings(): void {
  mount.textContent = '';
  const app = el('div', 'app');
  app.append(
    buildSettingsHeader(),
    buildSessionSettingsCard(),
    buildExecutionSettingsCard(),
    buildSourcesCard(),
    buildClientsCard(),
    buildSecurityCard(),
    buildAboutCard(),
  );
  mount.append(app);
}

/* -------------------------------------------------------------------- data */

function buildQuery(): ProposalsQuery {
  const query: ProposalsQuery = { limit: 100 };
  if (state.view === 'pending') query.status = 'PENDING_APPROVAL';
  else if (state.statusFilter !== '') query.status = state.statusFilter;
  const trimmed = state.q.trim();
  if (trimmed.length > 0) query.q = trimmed;
  return query;
}

function applySources(sources: SourceSummary[]): void {
  state.sources = sources;
  const names = new Map<string, string>();
  for (const source of sources) names.set(source.id, source.name);
  state.sourceNames = names;
}

async function loadSources(): Promise<void> {
  try {
    const sources = await call(() => api.listSources());
    applySources(sources);
    paintList();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    // Source names are cosmetic: fall back to the raw source id.
  }
}

async function loadSettingsSnapshot(): Promise<void> {
  if (settingsUi.settingsBusy) return;
  settingsUi.settingsBusy = true;
  settingsUi.settingsError = null;
  repaintSettings();
  try {
    const snapshot = await call(() => api.getSettings());
    state.settings = snapshot;
    hydrateSettingsDrafts(snapshot);
    updateCountdown();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.settingsError = describeActionError(error);
  } finally {
    settingsUi.settingsBusy = false;
    repaintSettings();
  }
}

/**
 * Loads settings after unlock so the header countdown and client-side idle
 * limit use the configured values. Failures are silent: the core remains the
 * authority and the fallback defaults still lock the page.
 */
async function loadRuntimeSettings(): Promise<void> {
  try {
    const snapshot = await call(() => api.getSettings());
    state.settings = snapshot;
    updateCountdown();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
    }
  }
}

async function loadSettingsSources(): Promise<void> {
  settingsUi.sourcesBusy = true;
  settingsUi.sourcesError = null;
  repaintSettings();
  try {
    const sources = await call(() => api.listSources());
    applySources(sources);
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.sourcesError = describeActionError(error);
  } finally {
    settingsUi.sourcesBusy = false;
    repaintSettings();
  }
}

async function loadSettingsClients(): Promise<void> {
  settingsUi.clientsBusy = true;
  settingsUi.clientsError = null;
  repaintSettings();
  try {
    settingsUi.clients = await call(() => api.listClients());
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    settingsUi.clientsError = describeActionError(error);
  } finally {
    settingsUi.clientsBusy = false;
    repaintSettings();
  }
}

async function loadProposals(): Promise<void> {
  if (state.phase !== 'shell') return;
  listTicket += 1;
  const ticket = listTicket;
  state.listLoading = true;
  paintList();

  try {
    const proposals = await call(() => api.listProposals(buildQuery()));
    if (ticket !== listTicket) return;
    state.proposals = proposals;
    // Anything the user just loaded is already on screen: never announce it.
    rememberSeen(proposals);
    recountPending();
    state.listError = null;
  } catch (error) {
    if (ticket !== listTicket) return;
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    state.proposals = [];
    state.listError = describeError(error);
  } finally {
    if (ticket === listTicket) {
      state.listLoading = false;
      paintList();
      paintFilters();
    }
  }
}

function recountPending(): void {
  if (state.view === 'pending' || state.statusFilter === '') {
    state.pendingCount = state.proposals.filter(
      (proposal) => proposal.status === 'PENDING_APPROVAL',
    ).length;
  }
}

/* ------------------------------------------------ live updates (SSE push) */

/**
 * The push refresh asks exactly what the list asks (same view status, same
 * search, same limit) so an id-set diff is meaningful. In the "all" view the
 * request intentionally drops any status filter, matching the list default.
 */
function buildRemoteQuery(): ProposalsQuery {
  const query: ProposalsQuery = { limit: LIVE_LIST_LIMIT };
  if (state.view === 'pending') query.status = 'PENDING_APPROVAL';
  const trimmed = state.q.trim();
  if (trimmed.length > 0) query.q = trimmed;
  return query;
}

/** Whether a fetched proposal would appear in the list currently on screen. */
function inListScope(proposal: Proposal): boolean {
  if (state.view === 'pending') return proposal.status === 'PENDING_APPROVAL';
  if (state.statusFilter !== '') return proposal.status === state.statusFilter;
  return true;
}

/** Approve/reject in flight: never yank the card the user is acting on. */
function isCardBusy(proposalId: string): boolean {
  const ui = state.cards.get(proposalId);
  if (ui === undefined) return false;
  return ui.approveBusy || ui.rejectBusy;
}

function rememberSeen(proposals: Proposal[]): void {
  for (const proposal of proposals) seenProposalIds.add(proposal.id);
}

function showNewProposalNotice(count: number): void {
  if (noticeEl === null || noticeTextEl === null) return;
  noticeTextEl.textContent = `收到 ${count} 条新的 SQL 审批请求`;
  noticeEl.hidden = false;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null;
    hideNewProposalNotice();
  }, NOTICE_AUTO_HIDE_MS);
}

function hideNewProposalNotice(): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (noticeEl !== null) noticeEl.hidden = true;
}

function paintLiveStatus(connected: boolean): void {
  if (liveStatusEl === null) return;
  liveStatusEl.textContent = connected ? '实时 · 已连接' : '实时 · 重连中';
  liveStatusEl.classList.toggle('live-connected', connected);
  liveStatusEl.classList.toggle('live-connecting', !connected);
}

/* ------------------------------------------- desktop shell notifications */

/**
 * The Windows desktop shell (not the embedded DSH iframe) shows native OS
 * notifications for new proposals while its window is in the tray. Native
 * notifications avoid core spawning a hidden `powershell.exe`, which HIPS/EDR
 * products rightly flag as suspicious behavior.
 */
declare global {
  interface Window {
    /** Set by the desktop shell's sandboxed preload (constant flags only). */
    sagDesktop?: {
      shell?: boolean;
      notify?: (title: string, body: string) => void;
    };
  }
}

function isDesktopShell(): boolean {
  if (isEmbeddedMode()) return false;
  if (typeof window !== 'undefined' && window.sagDesktop?.shell === true) return true;
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron/');
}

let desktopNotificationPermission: NotificationPermission | 'unsupported' = 'default';

async function ensureDesktopNotifications(): Promise<void> {
  if (!isDesktopShell()) {
    desktopNotificationPermission = 'unsupported';
    return;
  }
  // The desktop shell exposes a main-process bridge; no Web Notification
  // permission is involved and Windows shows a tray balloon.
  if (window.sagDesktop?.notify) {
    desktopNotificationPermission = 'granted';
    return;
  }
  if (typeof Notification === 'undefined') {
    desktopNotificationPermission = 'unsupported';
    return;
  }
  try {
    // Electron reports "denied" until the session permission handler grants it,
    // so ask unconditionally rather than trusting the initial value.
    desktopNotificationPermission = await Notification.requestPermission();
  } catch {
    desktopNotificationPermission = 'unsupported';
  }
}

function notifyPendingProposals(count: number): void {
  if (count <= 0 || !isDesktopShell()) return;
  const title = 'SQL 审批 · 新提案';
  const body = `收到 ${count} 条新的 SQL 审批请求`;
  // A focused window already shows the in-page banner; notify when the console
  // is not the foreground window (tray, minimized, or another app on top).
  // `document.hidden` is not reliable for Electron windows hidden via hide().
  if (document.hasFocus()) return;
  if (window.sagDesktop?.notify) {
    window.sagDesktop.notify(title, body);
    return;
  }
  if (desktopNotificationPermission !== 'granted') return;
  try {
    const notification = new Notification(title, {
      body,
      tag: 'sag-pending-proposals',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Notifications are a convenience; never break the console.
  }
}

function showLiveFailure(): void {
  if (liveFailureEl !== null) liveFailureEl.hidden = false;
}

function hideLiveFailure(): void {
  if (liveFailureEl !== null) liveFailureEl.hidden = true;
}

/**
 * Diffs one freshly fetched snapshot against the list on screen:
 * - new ids are inserted at the top (newest first) and announced once;
 * - ids missing from the snapshot are dropped, keeping `state.cards` so the
 *   details/result expansion survives a removal;
 * - no diff means no repaint at all, so focus and caret never move.
 */
function applyRemoteSnapshot(remote: Proposal[]): void {
  const scoped = remote.filter((proposal) => inListScope(proposal));
  const scopedIds = new Set(scoped.map((proposal) => proposal.id));
  const listIds = new Set(state.proposals.map((proposal) => proposal.id));

  // Removals are only trustworthy when the fetch asked the same status question
  // as the list. With an explicit status filter in the "all" view the fetch is a
  // superset, so a missing id may simply be another status: keep it.
  const comparable = state.view === 'pending' || state.statusFilter === '';
  const removals = comparable
    ? state.proposals.filter(
        (proposal) => !scopedIds.has(proposal.id) && !isCardBusy(proposal.id),
      )
    : [];

  const additions = scoped.filter((proposal) => !listIds.has(proposal.id));
  const freshPending = additions.filter(
    (proposal) =>
      proposal.status === 'PENDING_APPROVAL' && !seenProposalIds.has(proposal.id),
  ).length;

  for (const proposal of scoped) seenProposalIds.add(proposal.id);

  if (additions.length === 0 && removals.length === 0) return;

  const removedIds = new Set(removals.map((proposal) => proposal.id));
  state.proposals = [
    ...additions,
    ...state.proposals.filter((proposal) => !removedIds.has(proposal.id)),
  ];
  recountPending();
  paintFilters();
  paintList();

  if (freshPending > 0) {
    showNewProposalNotice(freshPending);
    // The desktop shell mirrors the in-page banner to a native OS notification
    // when its window is hidden (tray/minimized).
    notifyPendingProposals(freshPending);
  }
}

/**
 * A push arrived: refresh the list once (debounced so a burst of changes costs
 * one request). Fetching silently keeps the list and the user's focus intact.
 */
function scheduleLiveRefresh(): void {
  if (liveRefreshTimer !== null) return;
  // Hidden Electron windows throttle timers (Chromium backgrounds them), so a
  // debounced push could arrive a minute late. When the console is not visible,
  // take the snapshot immediately instead.
  if (document.hidden) {
    void refreshFromPush();
    return;
  }
  liveRefreshTimer = window.setTimeout(() => {
    liveRefreshTimer = null;
    void refreshFromPush();
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

async function refreshFromPush(): Promise<void> {
  if (!state.unlocked || state.phase !== 'shell' || locking) return;
  if (state.screen !== 'console' || refs.list === null) {
    // The settings screen has no list on display; remember the miss so the
    // console refreshes when it comes back instead of showing a stale list.
    if (state.phase === 'shell' && state.screen === 'settings') missedPushRefresh = true;
    return;
  }
  const listTicketAtStart = listTicket;
  try {
    const remote = await api.listProposals(buildRemoteQuery());
    // A manual refresh / search / view switch happened while we waited: its
    // response is newer, so ours is not allowed to repaint the list.
    if (listTicketAtStart !== listTicket) return;
    if (!state.unlocked || state.phase !== 'shell') return;
    applyRemoteSnapshot(remote);
  } catch (error) {
    if (isSessionError(error)) {
      stopLiveUpdates();
      handleSessionLost(SESSION_MESSAGE);
    }
    // Any other failure is already covered by the stream status line.
  }
}

/** Parses one SSE frame; only proposal.* events trigger a refresh. */
function handleSseBlock(raw: string): void {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return;
  if (eventName !== 'proposal.created' && eventName !== 'proposal.updated') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  // The payload is deliberately tiny (id/source/at); the list is the authority.
  if (typeof (parsed as { id?: unknown }).id !== 'string') return;
  scheduleLiveRefresh();
}

function noteLiveFailure(): void {
  liveFailures += 1;
  if (liveFailures >= LIVE_FAILURE_LIMIT) showLiveFailure();
}

function scheduleLiveReconnect(): void {
  if (liveRetryTimer !== null) return;
  if (!state.unlocked || state.phase !== 'shell') return;
  const delayMs =
    LIVE_BACKOFF_MS[Math.min(liveRetryIndex, LIVE_BACKOFF_MS.length - 1)] ?? LIVE_BACKOFF_MS[0];
  liveRetryIndex += 1;
  liveRetryTimer = window.setTimeout(() => {
    liveRetryTimer = null;
    void connectLiveUpdates();
  }, delayMs);
}

/**
 * Opens (or reopens) the push stream. `fetch` is used instead of `EventSource`
 * because the embedded console must send the in-memory Bearer token, which
 * EventSource cannot do; the body is decoded as `text/event-stream` by hand.
 */
async function connectLiveUpdates(): Promise<void> {
  if (liveAbort !== null) return;
  if (!state.unlocked || state.phase !== 'shell') return;

  const controller = new AbortController();
  liveAbort = controller;
  liveGeneration += 1;
  const generation = liveGeneration;
  paintLiveStatus(false);

  let response: Response;
  try {
    response = await fetch('/v1/events', {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...adminAuthHeaders() },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    if (generation !== liveGeneration || controller.signal.aborted) return;
    liveAbort = null;
    noteLiveFailure();
    scheduleLiveReconnect();
    return;
  }

  if (generation !== liveGeneration || controller.signal.aborted) {
    // Stopped while the request was in flight: do not keep the body.
    void response.body?.cancel().catch(() => {});
    return;
  }

  if (response.status === 401 || response.status === 403 || response.status === 423) {
    // Session gone (or the gateway locked): the unlock screen is the only way
    // forward; retrying the stream would just spin.
    liveAbort = null;
    handleSessionLost(SESSION_MESSAGE);
    return;
  }

  if (!response.ok || response.body === null) {
    liveAbort = null;
    noteLiveFailure();
    scheduleLiveReconnect();
    return;
  }

  liveFailures = 0;
  hideLiveFailure();
  liveConnected = true;
  paintLiveStatus(true);
  const isReconnect = liveHadConnection;
  liveHadConnection = true;
  liveRetryIndex = 0;
  // After a gap the missed events are unknown, so take one full snapshot first.
  if (isReconnect || liveNeedsSnapshot) void loadProposals();
  liveNeedsSnapshot = false;

  try {
    await readEventStream(response.body);
  } catch {
    // A dropped connection is expected; reconnect below.
  }
  if (generation !== liveGeneration) return;
  liveAbort = null;
  liveConnected = false;
  paintLiveStatus(false);
  scheduleLiveReconnect();
}

async function readEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value === undefined) continue;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleSseBlock(rawFrame);
      boundary = buffer.indexOf('\n\n');
    }
    // A malformed peer must not grow the buffer without bound.
    if (buffer.length > 1_000_000) buffer = '';
  }
}

/** Starts the live stream (idempotent); called after unlock. */
function startLiveUpdates(): void {
  if (liveAbort !== null) return;
  void ensureDesktopNotifications();
  void connectLiveUpdates();
}

/** Aborts the stream, cancels every timer and clears stream-only UI state. */
function stopLiveUpdates(): void {
  liveGeneration += 1;
  if (liveRetryTimer !== null) {
    window.clearTimeout(liveRetryTimer);
    liveRetryTimer = null;
  }
  if (liveRefreshTimer !== null) {
    window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }
  const controller = liveAbort;
  liveAbort = null;
  if (controller !== null) controller.abort();
  liveRetryIndex = 0;
  liveFailures = 0;
  liveHadConnection = false;
  liveConnected = false;
  liveNeedsSnapshot = false;
  missedPushRefresh = false;
  seenProposalIds.clear();
  hideNewProposalNotice();
  hideLiveFailure();
  paintLiveStatus(false);
}

async function switchView(view: View): Promise<void> {
  if (state.view === view) return;
  state.view = view;
  paintFilters();
  await loadProposals();
}

async function loadRows(proposalId: string, page: number): Promise<void> {
  const ui = cardState(proposalId);
  ui.rowsTicket += 1;
  const ticket = ui.rowsTicket;
  ui.rowsBusy = true;
  ui.rowsError = undefined;
  paintList();
  try {
    const data = await call(() => api.getRows(proposalId, Math.max(1, page), state.pageSize));
    if (ticket !== ui.rowsTicket) return;
    ui.rows = data;
  } catch (error) {
    if (ticket !== ui.rowsTicket) return;
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    ui.rowsError = describeError(error);
  } finally {
    if (ticket === ui.rowsTicket) {
      ui.rowsBusy = false;
      paintList();
    }
  }
}

async function refreshOpenRows(): Promise<void> {
  for (const [proposalId, ui] of state.cards) {
    if (ui.rows !== undefined) void loadRows(proposalId, 1);
  }
}

/* ----------------------------------------------------------------- actions */

async function approveProposal(proposalId: string): Promise<void> {
  const ui = cardState(proposalId);
  if (ui.approveBusy) return;
  ui.approveBusy = true;
  ui.error = undefined;
  ui.notice = undefined;
  paintList();

  try {
    const response = await call(() => api.approve(proposalId));
    if (state.view === 'pending') {
      // The card no longer matches the pending view: drop it locally so the
      // list and the "待审批 (N)" counter update without a full reload.
      state.proposals = state.proposals.filter((item) => item.id !== proposalId);
      state.cards.delete(proposalId);
      recountPending();
    } else {
      // "全部" keeps the card: patch its status in place; paintList rebuilds
      // the meta line and the action area (no approve/reject for non-pending).
      const proposal = state.proposals.find((item) => item.id === proposalId);
      if (proposal !== undefined) proposal.status = response.status;
      ui.approveInfo = response;
      recountPending();
    }
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    if (error instanceof ApiError && error.code === 'TIMEOUT') {
      ui.error = '请求超时，审批结果未知，请刷新列表后确认。';
    } else {
      ui.error = describeError(error);
    }
  } finally {
    ui.approveBusy = false;
    paintList();
    paintFilters();
  }
}

async function rejectProposal(proposalId: string): Promise<void> {
  const ui = cardState(proposalId);
  if (ui.rejectBusy) return;
  ui.rejectBusy = true;
  ui.error = undefined;
  paintList();

  try {
    const response = await call(() => api.reject(proposalId, ui.rejectReason));
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (proposal !== undefined) proposal.status = response.status;
    ui.rejectOpen = false;
    ui.rejectReason = '';
    ui.notice = '已拒绝该 SQL 提案';
    recountPending();
  } catch (error) {
    if (isSessionError(error)) {
      handleSessionLost(SESSION_MESSAGE);
      return;
    }
    ui.error = describeError(error);
  } finally {
    ui.rejectBusy = false;
    paintList();
    paintFilters();
  }
}

async function unlockWithPassword(
  password: string,
  errorNode: HTMLElement,
): Promise<boolean> {
  try {
    const response = await api.unlock(password);
    setCsrfToken(response.csrfToken);
    lastSuccessAt = Date.now();
    state.unlocked = true;
    state.unlockedAt = Date.now();
    state.screen = 'console';
    resetSettingsUi();
    state.view = 'pending';
    state.q = '';
    state.listError = null;
    state.cards.clear();
    state.proposals = [];
    state.listLoading = true;
    renderShell();
    void loadSources();
    void loadProposals();
    void loadRuntimeSettings();
    startLiveUpdates();
    return true;
  } catch (error) {
    showError(errorNode, describeUnlockError(error));
    return false;
  }
}

function endLocalSession(): void {
  setCsrfToken(null);
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  stopLiveUpdates();
  listTicket += 1;
  state.phase = 'unlock';
  state.unlocked = false;
  state.unlockedAt = null;
  state.screen = 'console';
  resetSettingsUi();
  state.proposals = [];
  state.pendingCount = 0;
  state.listLoading = false;
  state.listError = null;
  state.cards.clear();
  state.q = '';
  state.filtersOpen = false;
  state.statusFilter = '';
  state.view = 'pending';
  state.settings = null;
  countdownNode = null;
  lastSuccessAt = 0;
  resetRefs();
}

function handleSessionLost(message: string): void {
  endLocalSession();
  renderUnlock(message);
}

async function lockSession(message: string | null): Promise<void> {
  if (locking) return;
  locking = true;
  try {
    if (state.phase === 'shell') {
      try {
        await api.lock();
      } catch {
        // The local session ends regardless of the network result.
      }
    }
    endLocalSession();
    renderUnlock(message);
  } finally {
    locking = false;
  }
}

/* -------------------------------------------------------------------- boot */

async function refreshRootState(): Promise<void> {
  renderBoot();
  try {
    const rootState = await api.getState();
    state.configured = rootState.configured;
    state.unlocked = rootState.unlocked;
    state.version = rootState.version;
    state.bootError = null;
  } catch (error) {
    state.bootError = describeError(error);
    renderBootError();
    return;
  }

  if (!state.configured) {
    renderSetup();
    return;
  }
  if (!state.unlocked) {
    renderUnlock(null);
    return;
  }

  state.unlockedAt = Date.now();
  state.listLoading = true;
  renderShell();
  void loadSources();
  void loadProposals();
  void loadRuntimeSettings();
  startLiveUpdates();
}

function postHello(): void {
  try {
    window.parent.postMessage({ type: 'sag:hello', version: 1 }, '*');
  } catch {
    // Framing policy can refuse the message; the console still works.
  }
}

function boot(): void {
  if (isEmbeddedMode()) {
    postHello();
    window.addEventListener('load', postHello, { once: true });
  }
  void refreshRootState();
}

/**
 * Desktop-shell lock hook (tray). The main process cannot mint a CSRF-protected
 * /v1/admin/lock request because the session tokens live only in this page, so
 * it asks the console to lock itself by dispatching this no-argument event.
 * main.js then re-reads /v1/admin/state and requires `unlocked=false`.
 */
window.addEventListener('sag:lock', () => {
  void lockSession(null);
});

/**
 * A backgrounded tab may have its stream closed by the OS/browser. Returning to
 * the tab reconnects immediately instead of waiting for the backoff timer; the
 * console is never polled.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.unlocked || state.phase !== 'shell') return;
  if (liveAbort !== null) return;
  if (liveRetryTimer !== null) {
    window.clearTimeout(liveRetryTimer);
    liveRetryTimer = null;
  }
  liveRetryIndex = 0;
  void connectLiveUpdates();
});

/**
 * Leaving the document (navigation, tab discard) drops the socket and timers.
 * A back/forward-cache restore returns to `visible`, which reconnects above.
 */
window.addEventListener('pagehide', () => {
  stopLiveUpdates();
  // A restored document may have missed events while it was gone.
  liveNeedsSnapshot = true;
});

window.setInterval(() => {
  if (state.phase !== 'shell') return;
  updateCountdown();
}, COUNTDOWN_TICK_MS);

window.setInterval(() => {
  if (state.phase !== 'shell') return;
  if (
    state.unlockedAt !== null &&
    Date.now() - state.unlockedAt >= absoluteLimitMs()
  ) {
    void lockSession('会话已达绝对时长上限，请重新解锁');
    return;
  }
  if (lastSuccessAt === 0) return;
  if (Date.now() - lastSuccessAt < idleLimitMs()) return;
  void lockSession('会话因空闲已锁定，请重新解锁');
}, IDLE_CHECK_MS);

boot();
