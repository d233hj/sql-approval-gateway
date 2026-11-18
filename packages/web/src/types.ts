/**
 * Wire types for the SQL Approval Gateway admin API (DESIGN §6.3).
 *
 * These mirror `packages/shared` and `packages/core/src/http.ts` without taking
 * a build-time dependency on the Node-only workspace packages.
 */

export const PROPOSAL_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  PENDING_APPROVAL: '待审批',
  APPROVED: '已批准',
  EXECUTING: '执行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  REJECTED: '已拒绝',
  CANCELLED: '已取消',
  EXPIRED: '已过期',
};

export interface AdminState {
  configured: boolean;
  unlocked: boolean;
  version: string;
}

export type SourceDialect = 'sqlite' | 'mssql' | 'postgres' | 'mysql';

export interface SourceSummary {
  id: string;
  name: string;
  dialect: SourceDialect;
}

/** Connection details accepted by `POST /v1/admin/sources` (core schema). */
export interface SourceConnectionInput {
  /** sqlite only. */
  file?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  /** mssql only: passed through to the driver (defaults to false). */
  trustServerCertificate?: boolean;
}

export interface SourceCreateInput {
  name: string;
  dialect: SourceDialect;
  connection: SourceConnectionInput;
}

/** Partial `PUT /v1/admin/sources/{id}` body. Omitted fields keep their value. */
export interface SourceUpdateInput {
  name?: string;
  dialect?: SourceDialect;
  connection?: SourceConnectionInput;
}

export const SOURCE_TEST_ERROR_CODES = [
  'QUERY_TIMEOUT',
  'QUERY_FAILED',
  'DRIVER_UNAVAILABLE',
] as const;

export type SourceTestErrorCode = (typeof SOURCE_TEST_ERROR_CODES)[number];

export interface SourceTestReadonly {
  ok: boolean;
  checked: boolean;
  details: string[];
}

/** Response of `POST /v1/admin/sources/{id}/test` (core `SourceTestResult`). */
export interface SourceTestResult {
  ok: boolean;
  latency_ms: number;
  server?: string;
  readonly: SourceTestReadonly;
  error_code?: SourceTestErrorCode;
  db_error_number?: number;
}

/** Agent client metadata from `GET /v1/admin/clients` (no token or hash). */
export interface ClientSummary {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** 1 = revoked/disabled; kept numeric to mirror the core schema. */
  disabled: number;
}

/**
 * Response of `POST /v1/admin/clients`: the plaintext token is returned
 * exactly once and is never listed again.
 */
export interface ClientCreateResponse {
  id: string;
  name: string;
  /** One-time secret, shaped `sag_...` (47 chars). */
  token: string;
  created_at: string;
}

export const SETTING_KEYS = [
  'session.idle_minutes',
  'session.absolute_hours',
  'proposal.default_max_rows',
  'proposal.max_max_rows',
  'proposal.default_timeout_s',
  'proposal.max_timeout_s',
  'proposal.approval_window_hours',
  'result.ttl_hours',
  'ui.show_countdown',
  'security.require_readonly_source',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Wire shape of the batch-A settings contract (mirrors `@sql-approval/shared`). */
export interface SettingsValues {
  'session.idle_minutes': number;
  'session.absolute_hours': number;
  'proposal.default_max_rows': number;
  'proposal.max_max_rows': number;
  'proposal.default_timeout_s': number;
  'proposal.max_timeout_s': number;
  'proposal.approval_window_hours': number;
  'result.ttl_hours': number;
  'ui.show_countdown': boolean;
  /** Strict read-only guard: refuse approvals from writable/unprobed sources. */
  'security.require_readonly_source': boolean;
}

export interface SettingRange {
  type: 'integer' | 'boolean';
  min?: number;
  max?: number;
}

/** `GET /v1/admin/settings` payload; PUT returns only `{settings}`. */
export interface SettingsSnapshot {
  settings: SettingsValues;
  defaults: SettingsValues;
  ranges: Record<SettingKey, SettingRange>;
}

export const DEFAULT_SETTINGS: Readonly<SettingsValues> = Object.freeze({
  'session.idle_minutes': 10,
  'session.absolute_hours': 8,
  'proposal.default_max_rows': 500,
  'proposal.max_max_rows': 5000,
  'proposal.default_timeout_s': 30,
  'proposal.max_timeout_s': 120,
  'proposal.approval_window_hours': 24,
  'result.ttl_hours': 24,
  'ui.show_countdown': true,
  'security.require_readonly_source': true,
});

export interface SetupResponse {
  ok: true;
  /** Only returned when the core did not get a token from SAG_AGENT_TOKEN. */
  agent_token?: string;
}

export interface UnlockResponse {
  ok: true;
  csrfToken: string;
  /** Sliding idle deadline returned by the core (ISO-8601). */
  expiresAt: string;
  /**
   * Embedded (DSH iframe) sessions only: the Bearer session token returned
   * when the request carries `X-SAG-Want-Token: 1`. Kept in memory only.
   */
  token?: string;
}

export interface Proposal {
  id: string;
  client_id: string;
  source_id: string;
  sql: string;
  params: unknown;
  purpose: string | null;
  max_rows: number;
  timeout_s: number;
  status: ProposalStatus;
  status_message: string | null;
  digest: string;
  policy_version: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface ResultColumn {
  name: string;
  type?: string;
}

export interface ResultPage {
  columns: ResultColumn[];
  rows: unknown[][];
  page: number;
  page_size: number;
  total_rows: number;
  truncated: boolean;
  executed_at: string | null;
  duration_ms: number | null;
  expires_at: string | null;
}

export interface ApproveResultSummary {
  columns: ResultColumn[];
  total_rows: number;
  truncated: boolean;
  duration_ms: number;
  executed_at: string;
  expires_at: string;
}

export interface ApproveResponse {
  id: string;
  status: ProposalStatus;
  result: ApproveResultSummary | null;
  error_code?: string;
  db_error_number?: number;
}

export interface RejectResponse {
  id: string;
  status: 'REJECTED';
}

export interface LockResponse {
  ok: true;
}

export interface ProposalsQuery {
  status?: ProposalStatus;
  q?: string;
  limit?: number;
}
