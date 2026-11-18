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

export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export const ALLOWED_PROPOSAL_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = {
  // FAILED is reachable from PENDING_APPROVAL for system failures detected at
  // approval time (policy re-check, source removed, lock); it is never an
  // approval decision (that is REJECTED).
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  APPROVED: ['EXECUTING', 'FAILED'],
  EXECUTING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const SOURCE_DIALECTS = ['sqlite', 'mssql', 'postgres', 'mysql'] as const;

export type SourceDialect = (typeof SOURCE_DIALECTS)[number];

export interface SourceSummary {
  id: string;
  name: string;
  dialect: SourceDialect;
}

/**
 * Agent client metadata as exposed by `GET /v1/admin/clients`. The plaintext
 * token and its hash are intentionally not part of this shape.
 */
export interface ClientSummary {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** 1 = revoked/disabled; kept numeric for backwards compatibility. */
  disabled: number;
}

/** Fixed deadline for one connection/read-only probe; never user-configurable. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * How long a persisted read-only probe result stays authoritative for the
 * strict pre-execution guard. Older results are refreshed by a live probe
 * before approval, so permission changes are observed within ten minutes.
 */
export const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;

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

/**
 * Result of `POST /v1/admin/sources/{id}/test`. Only generic error codes are
 * exposed; driver messages can contain connection strings and are never
 * returned. `server` is a sanitized version string.
 */
export interface SourceTestResult {
  ok: boolean;
  latency_ms: number;
  server?: string;
  readonly: SourceTestReadonly;
  error_code?: SourceTestErrorCode;
  db_error_number?: number;
}

export interface ProposalSummary {
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
  request_key: string | null;
}

export interface AuditVerification {
  valid: boolean;
  checked: number;
  broken_at?: number;
}

export const POLICY_VERSION = 'sag-policy-1';
export const SESSION_COOKIE_NAME = 'sag_session';
export const CSRF_HEADER = 'x-sag-csrf';
export const WANT_TOKEN_HEADER = 'x-sag-want-token';
export const DEFAULT_PORT = 43119;
export const MAX_BODY_BYTES = 256 * 1024;
export const SESSION_IDLE_MS = 10 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
