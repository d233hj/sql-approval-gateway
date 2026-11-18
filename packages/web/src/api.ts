/**
 * Admin API client.
 *
 * Two transports are supported (DESIGN §4.3):
 *   - same-origin Web/desktop: HttpOnly `sag_session` cookie + in-memory CSRF;
 *   - cross-origin embedding (the DSH iframe): in-memory Bearer session.
 *
 * Third-party-cookie policies can suppress the SameSite=Strict session cookie
 * inside a `dsh-app://app` frame. Embedded mode therefore asks unlock for the
 * session token with `X-SAG-Want-Token: 1` and authenticates every admin call
 * with `Authorization: Bearer <token>`; CSRF is not used in that mode.
 *
 * Both tokens are deliberately kept in module-level variables only: never
 * localStorage, sessionStorage, IndexedDB, a URL, or a cookie readable from
 * JavaScript. A page refresh therefore requires unlocking again
 * (DESIGN §4.3 / §8.1).
 */

import type {
  AdminState,
  ApproveResponse,
  ClientCreateResponse,
  ClientSummary,
  LockResponse,
  Proposal,
  ProposalsQuery,
  RejectResponse,
  ResultPage,
  SettingsSnapshot,
  SettingsValues,
  SetupResponse,
  SourceCreateInput,
  SourceSummary,
  SourceTestResult,
  SourceUpdateInput,
  UnlockResponse,
} from './types.js';

const API_BASE = '/v1';
const CSRF_HEADER = 'X-SAG-CSRF';
const WANT_TOKEN_HEADER = 'X-SAG-Want-Token';
const DEFAULT_TIMEOUT_MS = 30_000;
/** A proposal's timeout_s is capped at 120s, so allow the whole approve call. */
const APPROVE_TIMEOUT_MS = 150_000;

let csrfToken: string | null = null;
let bearerToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { requestId?: string | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
  if (token === null) {
    // Clearing the cookie session is also a session teardown: the embedded
    // Bearer token must never outlive the page's in-memory session.
    bearerToken = null;
  }
}

export function hasCsrfToken(): boolean {
  return csrfToken !== null;
}

/** True while the in-memory Bearer session of embedded mode is available. */
export function hasBearerToken(): boolean {
  return bearerToken !== null;
}

/**
 * Headers for the live-event stream (`GET /v1/events`). Same-origin pages rely
 * on the HttpOnly session cookie (sent by `credentials: 'same-origin'`); the
 * embedded iframe has no readable cookie and attaches the in-memory Bearer
 * token instead. Never includes the CSRF token: the stream is read-only.
 */
export function adminAuthHeaders(): Record<string, string> {
  return bearerToken === null ? {} : { Authorization: `Bearer ${bearerToken}` };
}

/**
 * True when this document runs inside another browsing context (the DSH
 * shell) or was explicitly opened with `?embed=1`. In that frame the session
 * cookie may be treated as a third-party cookie and not sent, so the SPA uses
 * the Bearer session instead (DESIGN §4.3).
 */
export function isEmbeddedMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.parent !== window) return true;
  const search = window.location?.search;
  if (typeof search !== 'string' || search.length === 0) return false;
  try {
    return new URLSearchParams(search).get('embed') === '1';
  } catch {
    return false;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Attach the in-memory CSRF token and fail closed when it is absent. */
  csrf?: boolean;
  /** Ask /admin/unlock for the embedded Bearer session token. */
  wantToken?: boolean;
  timeoutMs?: number;
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  if (options.wantToken) {
    headers[WANT_TOKEN_HEADER] = '1';
  }

  if (bearerToken !== null) {
    // Embedded DSH iframe: the cookie is likely withheld, so authenticate with
    // the in-memory session token. Bearer sessions never require CSRF.
    headers.Authorization = `Bearer ${bearerToken}`;
  } else if (options.csrf) {
    if (csrfToken === null) {
      throw new ApiError(0, 'CSRF_MISSING', 'The CSRF token is not available; unlock again.');
    }
    headers[CSRF_HEADER] = csrfToken;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', 'The request timed out.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the gateway.');
  } finally {
    window.clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (bearerToken !== null && (response.status === 401 || response.status === 403)) {
      // The core rejected the Bearer session (expired/locked/restarted). Never
      // retry with a dead token; the UI returns to the unlock screen.
      bearerToken = null;
    }
    const errorBody = isRecord(parsed) ? (parsed as ErrorBody) : null;
    const code =
      errorBody && typeof errorBody.code === 'string'
        ? errorBody.code
        : `HTTP_${response.status}`;
    const message =
      errorBody && typeof errorBody.message === 'string'
        ? errorBody.message
        : response.statusText || 'Request failed';
    const requestId =
      errorBody && typeof errorBody.request_id === 'string'
        ? errorBody.request_id
        : response.headers.get('X-Request-ID');
    const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    throw new ApiError(response.status, code, message, {
      requestId,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    });
  }

  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCsrf(): void {
  // Bearer sessions (embedded DSH iframe) are authenticated by the
  // Authorization header, so they never require a CSRF token.
  if (bearerToken !== null) return;
  if (csrfToken === null) {
    throw new ApiError(0, 'CSRF_MISSING', 'The CSRF token is not available; unlock again.');
  }
}

export const api = {
  getState(): Promise<AdminState> {
    return request<AdminState>('/admin/state');
  },

  setup(password: string, confirm: string): Promise<SetupResponse> {
    return request<SetupResponse>('/admin/setup', {
      method: 'POST',
      body: { password, confirm },
      timeoutMs: 60_000,
    });
  },

  /**
   * Create a session. In a same-origin page this is the cookie session only;
   * in an embedded iframe the request also asks for the session Bearer token
   * (`X-SAG-Want-Token: 1`) and keeps it in memory for later admin calls.
   */
  async unlock(password: string): Promise<UnlockResponse> {
    const embedded = isEmbeddedMode();
    // A stale token would shadow the password grant on the server.
    bearerToken = null;
    const response = await request<UnlockResponse>('/admin/unlock', {
      method: 'POST',
      body: { password },
      timeoutMs: 60_000,
      wantToken: embedded,
    });
    if (embedded) {
      bearerToken =
        typeof response.token === 'string' && response.token.length > 0
          ? response.token
          : null;
    }
    return response;
  },

  async lock(): Promise<LockResponse> {
    if (bearerToken === null) requireCsrf();
    try {
      return await request<LockResponse>('/admin/lock', { method: 'POST', csrf: true });
    } finally {
      // Locking always ends the local session, even if the response is lost.
      bearerToken = null;
    }
  },

  listProposals(query: ProposalsQuery): Promise<Proposal[]> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return request<Proposal[]>(`/admin/proposals${suffix ? `?${suffix}` : ''}`);
  },

  /** Source metadata only (no connection information), for display names. */
  listSources(): Promise<SourceSummary[]> {
    return request<SourceSummary[]>('/admin/sources');
  },

  getSettings(): Promise<SettingsSnapshot> {
    return request<SettingsSnapshot>('/admin/settings');
  },

  /** Partial update: only the supplied keys are written by the core. */
  updateSettings(
    patch: Partial<SettingsValues>,
  ): Promise<{ settings: SettingsValues }> {
    requireCsrf();
    return request<{ settings: SettingsValues }>('/admin/settings', {
      method: 'PUT',
      body: patch,
      csrf: true,
    });
  },

  /** Partial source update; an omitted/empty password keeps the stored one. */
  updateSource(id: string, patch: SourceUpdateInput): Promise<SourceSummary> {
    requireCsrf();
    return request<SourceSummary>(`/admin/sources/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: patch,
      csrf: true,
      timeoutMs: 60_000,
    });
  },

  /** Connection + read-only probe. A failed probe is still HTTP 200 (`ok: false`). */
  testSource(id: string): Promise<SourceTestResult> {
    requireCsrf();
    return request<SourceTestResult>(
      `/admin/sources/${encodeURIComponent(id)}/test`,
      { method: 'POST', csrf: true, timeoutMs: 60_000 },
    );
  },

  createSource(input: SourceCreateInput): Promise<SourceSummary> {
    requireCsrf();
    return request<SourceSummary>('/admin/sources', {
      method: 'POST',
      body: input,
      csrf: true,
      timeoutMs: 60_000,
    });
  },

  deleteSource(id: string): Promise<{ ok: true }> {
    requireCsrf();
    return request<{ ok: true }>(`/admin/sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      csrf: true,
    });
  },

  /** Agent client metadata only; plaintext tokens never appear in the list. */
  listClients(): Promise<ClientSummary[]> {
    return request<ClientSummary[]>('/admin/clients');
  },

  /** Returns the plaintext agent token exactly once (`sag_...`). */
  createClient(name: string): Promise<ClientCreateResponse> {
    requireCsrf();
    return request<ClientCreateResponse>('/admin/clients', {
      method: 'POST',
      body: { name },
      csrf: true,
      timeoutMs: 60_000,
    });
  },

  /** Revokes a token by disabling its client row; history is preserved. */
  revokeClient(id: string): Promise<{ ok: true }> {
    requireCsrf();
    return request<{ ok: true }>(`/admin/clients/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      csrf: true,
    });
  },

  changePassword(current: string, next: string): Promise<{ ok: true }> {
    requireCsrf();
    return request<{ ok: true }>('/admin/password', {
      method: 'POST',
      body: { current, new: next },
      csrf: true,
      timeoutMs: 60_000,
    });
  },

  approve(proposalId: string): Promise<ApproveResponse> {
    requireCsrf();
    return request<ApproveResponse>(
      `/admin/proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: 'POST', csrf: true, timeoutMs: APPROVE_TIMEOUT_MS },
    );
  },

  reject(proposalId: string, reason: string): Promise<RejectResponse> {
    requireCsrf();
    const trimmed = reason.trim();
    return request<RejectResponse>(
      `/admin/proposals/${encodeURIComponent(proposalId)}/reject`,
      {
        method: 'POST',
        csrf: true,
        body: trimmed.length > 0 ? { reason: trimmed } : {},
      },
    );
  },

  getRows(proposalId: string, page: number, pageSize: number): Promise<ResultPage> {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    return request<ResultPage>(
      `/admin/proposals/${encodeURIComponent(proposalId)}/rows?${params.toString()}`,
    );
  },
};
