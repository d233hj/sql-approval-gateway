import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';

import {
  CSRF_HEADER,
  MAX_BODY_BYTES,
  POLICY_VERSION,
  PROPOSAL_STATUSES,
  SESSION_COOKIE_NAME,
  WANT_TOKEN_HEADER,
  changePasswordRequestSchema,
  clientCreateRequestSchema,
  passwordSchema,
  proposalCreateRequestSchema,
  rejectRequestSchema,
  setupRequestSchema,
  sourceCreateRequestSchema,
  sourceUpdateRequestSchema,
  unlockRequestSchema,
  type ApiErrorBody,
  type ErrorCode,
  type ProposalStatus,
  type ProposalSummary,
  type SourceDialect,
  type SourceSummary,
  type SourceTestResult,
} from '@sql-approval/shared';
import { ZodError } from 'zod';

import type { AppConfig } from './config.js';
import { ensureDataDir, isWildcardBindHost } from './config.js';
import {
  ApiError,
  VaultError,
  StoreError,
  isRecord,
} from './errors.js';
import {
  InstanceLockError,
  acquireInstanceLock,
  probeInstance,
  type InstanceLockHandle,
  type InstanceLockInfo,
} from './instance.js';
import {
  notifyNewProposal,
  type NewProposalNotification,
} from './notify.js';
import { Executor, ExecutorError } from './executor/index.js';
import type { ExecutorErrorCode } from './executor/types.js';
import { ProposalEventBus, type ProposalEventType } from './events.js';
import { SqlPolicyError, validateReadOnlySql } from './policy.js';
import { runSourceProbe } from './probes.js';
import {
  probeFailure,
  readonlyFailure,
  readCachedReadonly,
  type SourceGuardFailure,
} from './readonly.js';
import { AttemptRateLimiter } from './rate-limit.js';
import {
  RESULT_PAGE_DEFAULT_SIZE,
  RESULT_PAGE_MAX_SIZE,
  parseStoredJson,
  type ResultColumn,
} from './result.js';
import { SessionManager, type SessionRecord } from './session.js';
import {
  encodeSettingsPatch,
  parseSettingsPatch,
  readSettings,
  settingsSnapshot,
} from './settings.js';
import {
  WEB_BUILD_COMMAND,
  WEB_CSP,
  contentTypeForFilePath,
  readStaticFile,
  resolveStaticFile,
  resolveWebDistDir,
  staticIndexPath,
  staticRelativePath,
} from './static.js';
import { openStore, type ClientRecord, type Store } from './store.js';
import {
  canonicalJson,
  isIsoDate,
  randomToken,
  safeEqualString,
  sha256Hex,
} from './util.js';
import { VaultService } from './vault.js';
import { SERVICE_NAME, VERSION } from './version.js';

export interface GatewayLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
}

export const consoleLogger: GatewayLogger = {
  info(event) {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  },
  warn(event) {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  },
};

export const silentLogger: GatewayLogger = {
  info() {},
  warn() {},
};

export interface GatewayOptions {
  config: AppConfig;
  clock?: () => number;
  logger?: GatewayLogger;
  agentTokenFromEnv?: string | null;
  /** Injectable equivalent of SAG_SETUP_PASSWORD_FILE (tests use this). */
  setupPasswordFile?: string | null;
  /**
   * Overrides the SPA dist directory. Production resolution is
   * `SAG_WEB_DIST` → `<repo>/packages/web/dist`; tests point this at a
   * temporary fixture without mutating process env.
   */
  webDistDir?: string;
  /**
   * Source probe used by the test endpoint and the strict pre-execution guard.
   * Defaults to the fixed per-dialect probes in `probes.ts`; tests inject a
   * deterministic stub so the strict-mode decision matrix is exercised without
   * a live server.
   */
  probeSource?: (
    dialect: SourceDialect,
    connection: Record<string, unknown>,
  ) => Promise<SourceTestResult>;
  /**
   * Side effect fired once per newly created proposal. Defaults to the
   * best-effort Windows toast; tests inject a no-op or a spy so the suite never
   * spawns PowerShell.
   */
  notifyNewProposal?: (input: NewProposalNotification) => unknown;
}

export interface StartedGateway {
  url: string;
  port: number;
}

interface AdminAuth {
  session: SessionRecord;
  token: string;
  via: 'cookie' | 'bearer';
}

interface ErrorShape {
  status: number;
  code: ErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * A wildcard bind address is not a usable client URL. Keep advertising the
 * loopback address that the host is expected to publish
 * (SAG_ALLOW_NON_LOOPBACK_BIND only widens the bind, never the Host/Origin
 * allow-list enforced below).
 */
const WILDCARD_ADVERTISED_HOSTS: Readonly<Record<string, string>> = {
  '0.0.0.0': '127.0.0.1',
  '::': '::1',
};

const NON_LOOPBACK_BIND_WARNING =
  'non-loopback bind enabled; ensure host firewall/publish restricts access';

/** DESIGN §5: results are cleaned at startup and every hour. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

interface ProposalExecutionOutcome {
  status: 'SUCCEEDED' | 'FAILED';
  result: {
    columns: ResultColumn[];
    total_rows: number;
    truncated: boolean;
    duration_ms: number;
    executed_at: string;
    expires_at: string;
  } | null;
  error_code?:
    | ExecutorErrorCode
    | 'SOURCE_NOT_FOUND'
    | 'NOT_UNLOCKED'
    | SourceGuardFailure['code'];
  db_error_number?: number;
}


/**
 * HTTP gateway. It intentionally uses only node:http and a tiny hand-written
 * router; no web framework is part of the v0.1 core.
 */
export class Gateway {
  readonly config: AppConfig;
  readonly store: Store;
  readonly vault: VaultService;
  readonly sessions: SessionManager;
  readonly rateLimiter: AttemptRateLimiter;
  readonly executor: Executor;
  /** Live proposal stream fan-out; one subscriber per open console. */
  readonly events = new ProposalEventBus();

  private readonly logger: GatewayLogger;
  private readonly clock: () => number;
  private readonly agentTokenFromEnv: string | null;
  private readonly setupPasswordFile: string | null;
  private readonly webDistDir: string;
  private readonly probeSource: NonNullable<GatewayOptions['probeSource']>;
  private readonly notify: NonNullable<GatewayOptions['notifyNewProposal']>;
  private server: Server | null = null;
  private port = 0;
  private startedAt = 0;
  private storeClosed = false;
  private closing = false;
  private locking = false;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private instanceLock: InstanceLockHandle | null = null;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.logger = options.logger ?? consoleLogger;
    this.clock = options.clock ?? Date.now;
    this.webDistDir = options.webDistDir ?? resolveWebDistDir();
    this.probeSource = options.probeSource ?? runSourceProbe;
    this.notify = options.notifyNewProposal ?? notifyNewProposal;
    ensureDataDir(this.config.dataDir);

    // DESIGN §3.2: single instance. The SQLite exclusive lock is taken before
    // the store is opened so a second process never touches a live control.db.
    const startedAt = new Date(this.clock()).toISOString();
    this.instanceLock = acquireInstanceLock(this.config.instanceLockDbPath, {
      pid: process.pid,
      port: this.config.port,
      startedAt,
      version: VERSION,
    });

    try {
      const envToken =
        options.agentTokenFromEnv !== undefined
          ? options.agentTokenFromEnv
          : process.env.SAG_AGENT_TOKEN?.trim() ?? null;
      if (envToken !== null) {
        if (!envToken.startsWith('sag_') || envToken.length < 16) {
          throw new Error('SAG_AGENT_TOKEN must start with "sag_" and be at least 16 characters');
        }
        this.agentTokenFromEnv = envToken;
      } else {
        this.agentTokenFromEnv = null;
      }

      const setupFile =
        options.setupPasswordFile !== undefined
          ? options.setupPasswordFile
          : process.env.SAG_SETUP_PASSWORD_FILE?.trim() ?? null;
      this.setupPasswordFile = setupFile && setupFile.length > 0 ? setupFile : null;

      this.store = openStore(this.config.dbPath, {
        now: this.clock,
        proposalTtlMs: this.config.proposalTtlMs,
        resultTtlMs: this.config.resultTtlMs,
      });
      this.store.recoverInterrupted(this.clock());
      this.store.expirePending(this.clock());
      this.store.deleteExpiredResults(this.clock());

      if (this.agentTokenFromEnv) {
        this.store.upsertClient(
          'agent_default',
          'default agent',
          sha256Hex(this.agentTokenFromEnv),
        );
      }

      this.vault = new VaultService(this.config.vaultPath);
      this.sessions = new SessionManager({
        idleMs: () => readSettings(this.store)['session.idle_minutes'] * 60 * 1000,
        absoluteMs: () => readSettings(this.store)['session.absolute_hours'] * 60 * 60 * 1000,
        clock: this.clock,
        onEmpty: () => this.handleSessionsEmpty(),
      });
      this.rateLimiter = new AttemptRateLimiter();
      this.executor = new Executor();
    } catch (error) {
      this.instanceLock?.release();
      this.instanceLock = null;
      throw error;
    }
  }

  async start(): Promise<StartedGateway> {
    if (this.server) {
      return { url: this.urlFor(this.port), port: this.port };
    }
    await this.applySetupPasswordFile();
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    this.closing = false;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          this.server = null;
          rejectPromise(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: this.config.host, port: this.config.port });
      });
    } catch (error) {
      if (!isErrnoCode(error, 'EADDRINUSE')) throw error;
      // Second mutex (DESIGN §3.2): even with the data-dir lock, a foreign
      // process may already serve this port. Probe it, report ALREADY_RUNNING
      // and give our own lock back so the next start is not blocked.
      const startedAt = new Date(this.clock()).toISOString();
      const probe = await probeInstance({
        pid: 0,
        port: this.config.port,
        startedAt,
        url: this.urlFor(this.config.port),
      });
      this.instanceLock?.release();
      this.instanceLock = null;
      throw new InstanceLockError('ALREADY_RUNNING', 'Port is already in use', {
        pid: probe.pid ?? 0,
        port: this.config.port,
        startedAt,
        url: probe.url,
      });
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      await this.stop();
      throw new Error('Gateway did not obtain a TCP address');
    }
    this.port = address.port;
    this.startedAt = this.clock();
    this.writeInstanceLock();
    this.writeEndpoint();
    this.runMaintenance();
    this.startMaintenanceTimer();
    if (this.config.allowNonLoopbackBind && isWildcardBindHost(this.config.host)) {
      // No address, path or secret: operators should see that the bind posture
      // changed without this line becoming a configuration/topology leak.
      this.logger.warn({
        event: 'non_loopback_bind_enabled',
        message: NON_LOOPBACK_BIND_WARNING,
      });
    }
    this.logger.info({
      event: 'gateway_started',
      host: this.config.host,
      port: this.port,
      version: VERSION,
    });
    return { url: this.urlFor(this.port), port: this.port };
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.stopMaintenanceTimer();
    // Close long-lived streams first so server.close() does not wait on them.
    this.events.closeAll();
    await this.abortInFlight('interrupted');
    await this.executor.shutdown();
    this.sessions.clear();
    this.vault.lock();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections();
        const timer = setTimeout(() => server.closeAllConnections(), 1000);
        timer.unref();
      });
    }
    this.removeEndpoint();
    if (!this.storeClosed) {
      this.storeClosed = true;
      this.store.close();
    }
    if (this.instanceLock) {
      this.instanceLock.release();
      this.instanceLock = null;
    }
    this.logger.info({ event: 'gateway_stopped' });
  }

  /** Runs TTL / approval-window cleanup. Exposed for tests and the hourly timer. */
  runMaintenance(nowMs = this.clock()): void {
    try {
      const expiredResults = this.store.deleteExpiredResults(nowMs);
      // Collect the rows first: the expiry announcement must describe committed
      // status changes, never proposals that were already terminal.
      const expiring = this.store.listExpiringPending(nowMs);
      const expiredProposals = this.store.expirePending(nowMs);
      for (const proposal of expiring) {
        this.broadcastProposal('proposal.updated', proposal.id, this.sourceLabel(proposal.sourceId));
      }
      if (expiredResults > 0 || expiredProposals > 0) {
        this.logger.info({
          event: 'maintenance',
          expired_results: expiredResults,
          expired_proposals: expiredProposals,
        });
      }
    } catch {
      this.logger.warn({ event: 'maintenance_failed' });
    }
  }

  private startMaintenanceTimer(): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => this.runMaintenance(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref?.();
  }

  private stopMaintenanceTimer(): void {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  private writeInstanceLock(): void {
    const info: InstanceLockInfo = {
      pid: process.pid,
      port: this.port,
      startedAt: new Date(this.startedAt).toISOString(),
      url: this.urlFor(this.port),
      version: VERSION,
    };
    if (!this.instanceLock || !this.instanceLock.update(info)) {
      this.logger.warn({ event: 'instance_lock_update_failed' });
    }
  }

  private urlFor(port: number): string {
    const advertised = WILDCARD_ADVERTISED_HOSTS[this.config.host] ?? this.config.host;
    const host = advertised.includes(':') ? `[${advertised}]` : advertised;
    return `http://${host}:${port}`;
  }

  private writeEndpoint(): void {
    if (this.closing) return;
    const payload = {
      url: this.urlFor(this.port),
      pid: process.pid,
      version: VERSION,
      startedAt: new Date(this.startedAt).toISOString(),
    };
    try {
      writeFileSync(this.config.endpointPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    } catch {
      this.logger.warn({ event: 'endpoint_write_failed' });
    }
  }

  private removeEndpoint(): void {
    try {
      if (!existsSync(this.config.endpointPath)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.config.endpointPath, 'utf8'));
      if (isRecord(parsed) && parsed.pid === process.pid) {
        rmSync(this.config.endpointPath, { force: true });
      }
    } catch {
      // A stale or malformed endpoint file is harmless.
    }
  }

  // --------------------------------------------------------------- transport

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const path = safePathname(request.url);
    this.setBaselineHeaders(response, requestId);
    let status = 500;
    try {
      const host = this.validateHost(request);
      this.validateOrigin(request, response, host);
      if ((request.method ?? 'GET').toUpperCase() === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'authorization,content-type,x-sag-csrf',
        );
        response.setHeader('Access-Control-Max-Age', '600');
        response.statusCode = 204;
        response.end();
        status = 204;
        return;
      }
      if (this.closing) {
        throw new ApiError('INVALID_STATE', 503, 'Gateway is shutting down');
      }
      await this.dispatch(request, response, path);
      status = response.statusCode;
    } catch (error) {
      status = this.sendError(response, error, requestId);
    } finally {
      this.logger.info({
        event: 'http_request',
        request_id: requestId,
        method: request.method ?? 'UNKNOWN',
        path,
        status,
        duration_ms: Date.now() - started,
      });
    }
  }

  private setBaselineHeaders(response: ServerResponse, requestId: string): void {
    response.setHeader('X-Request-ID', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'self' dsh-app: http://127.0.0.1:*; base-uri 'none'; form-action 'none'",
    );
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }

  private validateHost(request: IncomingMessage): string {
    const raw = request.headers.host;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
    }
    if (/[\s/@]/.test(raw)) {
      throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
    }
    let hostname: string;
    let portText: string | null = null;
    if (raw.startsWith('[')) {
      const end = raw.indexOf(']');
      if (end === -1) throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
      hostname = raw.slice(1, end).toLowerCase();
      const remainder = raw.slice(end + 1);
      if (remainder.length > 0) {
        if (!remainder.startsWith(':')) {
          throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
        }
        portText = remainder.slice(1);
      }
    } else {
      const colon = raw.lastIndexOf(':');
      if (colon !== -1) {
        hostname = raw.slice(0, colon).toLowerCase();
        portText = raw.slice(colon + 1);
      } else {
        hostname = raw.toLowerCase();
      }
    }
    if (!LOOPBACK_HOSTNAMES.has(hostname)) {
      throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
    }
    if (portText !== null) {
      if (!/^\d+$/.test(portText) || Number(portText) !== this.currentPort()) {
        throw new ApiError('INVALID_HOST', 400, 'Invalid Host header');
      }
    }
    return raw;
  }

  private currentPort(): number {
    if (this.port !== 0) return this.port;
    const address = this.server?.address();
    if (address && typeof address === 'object') return address.port;
    return this.config.port;
  }

  private validateOrigin(
    request: IncomingMessage,
    response: ServerResponse,
    host: string,
  ): void {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return;
    const port = this.currentPort();
    const allowed = new Set([
      `http://${host.toLowerCase()}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
      'dsh-app://app',
    ]);
    if (!allowed.has(origin.toLowerCase())) {
      throw new ApiError('ORIGIN_REJECTED', 403, 'Origin is not allowed');
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    requestId: string,
  ): number {
    if (response.writableEnded || response.destroyed) return response.statusCode || status;
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', String(Buffer.byteLength(payload)));
    response.setHeader('X-Request-ID', requestId);
    response.end(payload);
    return status;
  }

  private sendError(response: ServerResponse, error: unknown, requestId: string): number {
    const shape = shapeError(error);
    if (response.writableEnded || response.destroyed) return response.statusCode || shape.status;
    if (shape.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(shape.retryAfterSeconds));
    }
    if (shape.status >= 500) {
      this.logger.warn({
        event: 'request_failed',
        request_id: requestId,
        code: shape.code,
      });
    }
    const body: ApiErrorBody = {
      code: shape.code,
      message: shape.message,
      request_id: requestId,
    };
    return this.sendJson(response, shape.status, body, requestId);
  }

  // --------------------------------------------------------------- dispatch

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();

    if (path === '/v1/health') {
      this.requireMethod(method, 'GET');
      this.sendJson(
        response,
        200,
        {
          ok: true,
          version: VERSION,
          service: SERVICE_NAME,
          pid: process.pid,
          started_at: new Date(this.startedAt).toISOString(),
        },
        this.requestId(response),
      );
      return;
    }

    if (path === '/v1/events') {
      this.requireMethod(method, 'GET');
      // Same admin session as the rest of /v1/admin: cookie or Bearer. A
      // locked gateway answers 423, an absent/expired session 401.
      this.requireAdmin(request, { unlocked: true, mutating: false });
      this.handleEvents(request, response);
      return;
    }

    if (path === '/v1/admin/state') {
      this.requireMethod(method, 'GET');
      this.sessions.pruneExpired();
      this.sendJson(
        response,
        200,
        {
          configured: this.vault.configured,
          unlocked: this.vault.unlocked,
          version: VERSION,
        },
        this.requestId(response),
      );
      return;
    }

    if (path === '/v1/admin/setup') {
      this.requireMethod(method, 'POST');
      await this.handleSetup(request, response);
      return;
    }

    if (path === '/v1/admin/unlock') {
      this.requireMethod(method, 'POST');
      await this.handleUnlock(request, response);
      return;
    }

    if (path === '/v1/admin/lock') {
      this.requireMethod(method, 'POST');
      await this.handleLock(request, response);
      return;
    }

    if (path === '/v1/admin/password') {
      this.requireMethod(method, 'POST');
      await this.handleChangePassword(request, response);
      return;
    }

    if (path === '/v1/agent/sources') {
      this.requireMethod(method, 'GET');
      const client = this.authenticateAgent(request);
      void client;
      this.sendJson(response, 200, this.store.listSources(), this.requestId(response));
      return;
    }

    if (path === '/v1/agent/proposals') {
      this.requireMethod(method, 'POST');
      await this.handleAgentSubmit(request, response);
      return;
    }

    const agentProposalMatch = /^\/v1\/agent\/proposals\/([^/]+)$/.exec(path);
    if (agentProposalMatch) {
      this.requireMethod(method, 'GET');
      this.handleAgentGetProposal(request, response, agentProposalMatch[1]!);
      return;
    }

    const agentCancelMatch = /^\/v1\/agent\/proposals\/([^/]+)\/cancel$/.exec(path);
    if (agentCancelMatch) {
      this.requireMethod(method, 'POST');
      this.handleAgentCancel(request, response, agentCancelMatch[1]!);
      return;
    }

    const agentRowsMatch = /^\/v1\/agent\/proposals\/([^/]+)\/rows$/.exec(path);
    if (agentRowsMatch) {
      this.requireMethod(method, 'GET');
      this.handleRows(request, response, agentRowsMatch[1]!, 'agent');
      return;
    }

    const adminRowsMatch = /^\/v1\/admin\/proposals\/([^/]+)\/rows$/.exec(path);
    if (adminRowsMatch) {
      this.requireMethod(method, 'GET');
      this.handleRows(request, response, adminRowsMatch[1]!, 'admin');
      return;
    }

    if (path === '/v1/admin/proposals') {
      this.requireMethod(method, 'GET');
      this.handleAdminListProposals(request, response);
      return;
    }

    const adminApproveMatch = /^\/v1\/admin\/proposals\/([^/]+)\/approve$/.exec(path);
    if (adminApproveMatch) {
      this.requireMethod(method, 'POST');
      await this.handleAdminApprove(request, response, adminApproveMatch[1]!);
      return;
    }

    const adminRejectMatch = /^\/v1\/admin\/proposals\/([^/]+)\/reject$/.exec(path);
    if (adminRejectMatch) {
      this.requireMethod(method, 'POST');
      await this.handleAdminReject(request, response, adminRejectMatch[1]!);
      return;
    }

    if (path === '/v1/admin/settings') {
      if (method === 'GET') {
        this.requireAdmin(request, { unlocked: true, mutating: false });
        this.sendJson(
          response,
          200,
          settingsSnapshot(this.store),
          this.requestId(response),
        );
        return;
      }
      if (method === 'PUT') {
        await this.handleUpdateSettings(request, response);
        return;
      }
      this.requireMethod(method, 'GET');
      return;
    }

    if (path === '/v1/admin/sources') {
      if (method === 'GET') {
        this.requireAdmin(request, { unlocked: true, mutating: false });
        this.sendJson(response, 200, this.store.listSources(), this.requestId(response));
        return;
      }
      if (method === 'POST') {
        await this.handleAdminAddSource(request, response);
        return;
      }
      this.requireMethod(method, 'GET');
      return;
    }

    const adminSourceTestMatch = /^\/v1\/admin\/sources\/([^/]+)\/test$/.exec(path);
    if (adminSourceTestMatch) {
      this.requireMethod(method, 'POST');
      await this.handleAdminTestSource(request, response, adminSourceTestMatch[1]!);
      return;
    }

    const adminSourceMatch = /^\/v1\/admin\/sources\/([^/]+)$/.exec(path);
    if (adminSourceMatch) {
      if (method === 'PUT') {
        await this.handleAdminUpdateSource(request, response, adminSourceMatch[1]!);
        return;
      }
      this.requireMethod(method, 'DELETE');
      await this.handleAdminDeleteSource(request, response, adminSourceMatch[1]!);
      return;
    }

    if (path === '/v1/admin/audit/verify') {
      this.requireMethod(method, 'GET');
      this.requireAdmin(request, { unlocked: false, mutating: false });
      this.sendJson(
        response,
        200,
        this.store.verifyAuditChain(),
        this.requestId(response),
      );
      return;
    }

    if (path === '/v1/admin/audit') {
      this.requireMethod(method, 'GET');
      this.requireAdmin(request, { unlocked: false, mutating: false });
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const after = parseInteger(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const entries = this.store.listAudit(after).map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        actor: entry.actor,
        action: entry.action,
        proposal_id: entry.proposal_id,
        detail: parseJsonOrNull(entry.detail_json),
        prev_hash: entry.prev_hash,
        hash: entry.hash,
      }));
      this.sendJson(response, 200, entries, this.requestId(response));
      return;
    }

    if (path === '/v1/admin/clients') {
      if (method === 'GET') {
        this.handleAdminListClients(request, response);
        return;
      }
      if (method === 'POST') {
        await this.handleAdminCreateClient(request, response);
        return;
      }
      this.requireMethod(method, 'GET');
      return;
    }

    const adminClientMatch = /^\/v1\/admin\/clients\/([^/]+)$/.exec(path);
    if (adminClientMatch) {
      this.requireMethod(method, 'DELETE');
      this.handleAdminRevokeClient(request, response, adminClientMatch[1]!);
      return;
    }

    if (path === '/v1' || path.startsWith('/v1/')) {
      // API namespace is never served from the SPA; unknown /v1 paths stay JSON.
      throw new ApiError('NOT_FOUND', 404, 'Not found');
    }

    // Same-origin SPA hosting (DESIGN §8.1/§8.3). Unknown paths do NOT fall
    // back to index.html, so a typo or a stale asset URL is a visible 404.
    await this.serveStatic(request, response, path);
  }

  // ------------------------------------------------------------ static SPA

  private async serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new ApiError('METHOD_NOT_ALLOWED', 405, 'Method not allowed');
    }

    if (path === '/') {
      const indexFile = staticIndexPath(this.webDistDir);
      const body = readStaticFile(indexFile);
      if (!body) {
        this.sendJson(
          response,
          503,
          {
            code: 'WEB_NOT_BUILT',
            message: 'Web UI is not built',
            hint: `Build the SPA first: ${WEB_BUILD_COMMAND}`,
            request_id: this.requestId(response),
          },
          this.requestId(response),
        );
        return;
      }
      this.sendStaticFile(response, indexFile, body, method);
      return;
    }

    const relativePath = staticRelativePath(path);
    if (relativePath === null) {
      throw new ApiError('INVALID_REQUEST', 400, 'Invalid static path');
    }
    const filePath = resolveStaticFile(this.webDistDir, relativePath);
    if (filePath === null) {
      throw new ApiError('INVALID_REQUEST', 400, 'Invalid static path');
    }
    const body = readStaticFile(filePath);
    if (!body) throw new ApiError('NOT_FOUND', 404, 'Not found');
    this.sendStaticFile(response, filePath, body, method);
  }

  private sendStaticFile(
    response: ServerResponse,
    filePath: string,
    body: Buffer,
    method: string,
  ): void {
    if (response.writableEnded || response.destroyed) return;
    this.applyStaticHeaders(response);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeForFilePath(filePath));
    response.setHeader('Content-Length', String(body.length));
    if (method === 'HEAD') {
      response.end();
      return;
    }
    response.end(body);
  }

  /** SPA-only headers; API responses keep the stricter baseline policy. */
  private applyStaticHeaders(response: ServerResponse): void {
    response.setHeader('Content-Security-Policy', WEB_CSP);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // No X-Frame-Options on purpose: embedding is controlled by frame-ancestors.
  }

  private requestId(response: ServerResponse): string {
    return String(response.getHeader('X-Request-ID') ?? '');
  }

  private requireMethod(method: string, expected: string): void {
    if (method !== expected) {
      throw new ApiError('METHOD_NOT_ALLOWED', 405, 'Method not allowed');
    }
  }

  // ------------------------------------------------------------ live events

  /**
   * Opens one long-lived `text/event-stream` for the approval console. The
   * response is registered with the in-process bus only after the headers are
   * flushed, so the client sees `200` immediately, and both request and
   * response close events remove the subscriber (a closed tab can never leak
   * the heartbeat timer). Events carry ids and a source label only.
   */
  private handleEvents(request: IncomingMessage, response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(': connected\n\n');
    this.events.subscribe(response);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.events.unsubscribe(response);
    };
    request.on('close', cleanup);
    request.on('error', cleanup);
    response.on('close', cleanup);
    response.on('error', cleanup);
    this.logger.info({ event: 'events_connected' });
  }

  /**
   * Publishes one proposal change. Best effort by design: a listener problem
   * must never delay or fail the proposal write that already happened.
   */
  private broadcastProposal(type: ProposalEventType, proposalId: string, source: string): void {
    try {
      this.events.broadcast({ type, id: proposalId, source, at: this.clock() });
    } catch {
      this.logger.warn({ event: 'events_broadcast_failed', proposal_id: proposalId });
    }
  }

  /** Display label for event payloads: source name, falling back to the id. */
  private sourceLabel(sourceId: string): string {
    return this.store.getSource(sourceId)?.name ?? sourceId;
  }

  // ------------------------------------------------------------- admin flows

  private async handleSetup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.vault.configured) {
      throw new ApiError('ALREADY_CONFIGURED', 409, 'Gateway is already configured');
    }
    const body = setupRequestSchema.parse(await this.readJson(request));
    // vault.setup() uses an exclusive create; every losing concurrent request
    // throws ALREADY_CONFIGURED before an agent token is generated.
    const generatedToken = await this.initializeVault(body.password, 'http');

    this.sendJson(
      response,
      200,
      generatedToken ? { ok: true, agent_token: generatedToken } : { ok: true },
      this.requestId(response),
    );
  }

  private async initializeVault(
    password: string,
    via: 'http' | 'password_file',
  ): Promise<string | null> {
    await this.vault.setup(password);

    const generatedToken = this.agentTokenFromEnv ? null : `sag_${randomToken(32)}`;
    const tokenToStore = this.agentTokenFromEnv ?? generatedToken;
    if (!tokenToStore) throw new ApiError('INTERNAL_ERROR', 500, 'Unable to initialize agent token');
    this.store.upsertClient('agent_default', 'default agent', sha256Hex(tokenToStore));
    this.store.appendAudit({
      actor: 'system',
      action: 'admin.setup',
      detail: { agent_client_id: 'agent_default', via },
      nowMs: this.clock(),
    });
    this.logger.info({ event: 'admin_setup', via });
    return generatedToken;
  }

  private async applySetupPasswordFile(): Promise<void> {
    const file = this.setupPasswordFile;
    if (!file) return;
    if (!existsSync(file)) {
      this.logger.warn({ event: 'setup_password_file_missing' });
      return;
    }

    let password: string;
    try {
      password = readFileSync(file, 'utf8');
    } catch {
      throw new Error('Unable to read SAG_SETUP_PASSWORD_FILE');
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        throw new Error('Unable to remove SAG_SETUP_PASSWORD_FILE after reading');
      }
    }

    if (this.vault.configured) {
      this.logger.info({ event: 'setup_password_file_ignored' });
      return;
    }

    const normalized = password.replace(/\r?\n$/, '');
    const parsed = passwordSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error('SAG_SETUP_PASSWORD_FILE does not satisfy the password policy');
    }

    const generatedToken = await this.initializeVault(parsed.data, 'password_file');
    if (generatedToken) this.writeOneTimeAgentToken(generatedToken);
  }

  private writeOneTimeAgentToken(token: string): void {
    const file = join(this.config.dataDir, 'agent-token.once');
    try {
      // POSIX: mode 0600. Windows ignores the POSIX mode and inherits the data
      // directory ACL (the default %APPDATA%\sql-approval is user-private; a
      // custom SAG_DATA_DIR inherits whatever ACL its parent grants).
      writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
      this.logger.info({ event: 'agent_token_written_once' });
    } catch {
      // The token is intentionally never logged. If this file cannot be
      // created, restart with SAG_AGENT_TOKEN to provision one explicitly.
      this.logger.warn({ event: 'agent_token_file_not_written' });
    }
  }

  private async handleUnlock(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.vault.configured) {
      throw new ApiError('INVALID_STATE', 409, 'Gateway is not configured');
    }
    const ip = clientIp(request);
    const body = unlockRequestSchema.parse(await this.readJson(request));
    const decision = this.rateLimiter.begin(ip, this.clock());
    if (!decision.allowed) {
      throw new ApiError('RATE_LIMITED', 429, 'Too many attempts', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    try {
      await this.vault.unlock(body.password);
    } catch (error) {
      if (error instanceof VaultError) {
        this.rateLimiter.recordFailure(ip, this.clock());
        try {
          this.store.appendAudit({
            actor: 'anonymous',
            action: 'admin.unlock_failed',
            detail: {},
            nowMs: this.clock(),
          });
        } catch {
          // Do not turn a failed login into an internal-error oracle.
        }
        throw new ApiError('UNAUTHENTICATED', 401, 'Authentication failed');
      }
      throw error;
    }

    this.rateLimiter.recordSuccess(ip);
    this.locking = false;
    const created = this.sessions.create(ip, 'admin');
    this.store.appendAudit({
      actor: 'admin',
      action: 'admin.unlock',
      detail: {},
      nowMs: this.clock(),
    });
    // The server enforces the sliding idle deadline. The cookie lifetime tracks
    // the current absolute session bound so an active session is not logged out
    // by a stale browser Max-Age before the next request can slide server state.
    const absoluteMs = readSettings(this.store)['session.absolute_hours'] * 60 * 60 * 1000;
    setSessionCookie(response, created.token, Math.max(1, Math.ceil(absoluteMs / 1000)));
    this.logger.info({ event: 'admin_unlock' });

    const payload: Record<string, unknown> = {
      ok: true,
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt,
    };
    if (request.headers[WANT_TOKEN_HEADER] === '1') {
      payload.token = created.token;
    }
    this.sendJson(response, 200, payload, this.requestId(response));
  }

  private async handleLock(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.vault.unlocked) {
      this.sessions.clear();
      clearSessionCookie(response);
      this.sendJson(response, 200, { ok: true }, this.requestId(response));
      return;
    }
    const auth = this.requireAdmin(request, { unlocked: true, mutating: true });
    this.locking = true;
    // DESIGN §4.3: stop in-flight queries before the DEK is wiped, mark their
    // proposals FAILED(locked) and never write a result for them.
    await this.abortInFlight('locked');
    this.store.appendAudit({
      actor: 'admin',
      action: 'admin.lock',
      detail: {},
      nowMs: this.clock(),
    });
    this.sessions.clear();
    // A locked console may not keep a live stream: it would never see another
    // event and would hold a socket the next unlock cannot attribute.
    this.events.closeAll();
    this.vault.lock();
    clearSessionCookie(response);
    this.logger.info({ event: 'admin_lock', via: auth.via });
    this.sendJson(response, 200, { ok: true }, this.requestId(response));
  }

  /** Session expiry and explicit lock share one teardown path. */
  private handleSessionsEmpty(): void {
    this.locking = true;
    if (this.inFlight.size === 0) {
      this.finishLock();
      return;
    }
    void this.abortInFlight('locked').finally(() => this.finishLock());
  }

  private finishLock(): void {
    this.events.closeAll();
    if (this.vault.unlocked) {
      this.vault.lock();
      this.logger.info({ event: 'vault_locked', reason: 'sessions_empty' });
    }
  }

  /**
   * Aborts every in-flight execution, transitions its proposal to a terminal
   * FAILED state (no result rows are written) and waits for the workers.
   */
  private async abortInFlight(statusMessage: 'locked' | 'interrupted'): Promise<void> {
    const ids = [...this.inFlight.keys()];
    for (const controller of this.inFlight.values()) {
      try {
        controller.abort(statusMessage);
      } catch {
        // Aborting is best effort; the executor teardown below is decisive.
      }
    }
    for (const id of ids) {
      try {
        // One audit event per aborted proposal (reason=locked/interrupted).
        this.store.failProposal(id, 'EXECUTING', statusMessage, 'system', this.clock());
      } catch {
        // The store may already be closing; the executor abort still applies.
      }
    }
    await this.executor.abortAll(statusMessage === 'locked' ? 'LOCKED' : 'CANCELLED');
  }

  private async handleChangePassword(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const auth = this.requireAdmin(request, { unlocked: true, mutating: true });
    const body = changePasswordRequestSchema.parse(await this.readJson(request));
    try {
      await this.vault.changePassword(body.current, body.new);
    } catch (error) {
      if (error instanceof VaultError && error.code === 'INVALID_PASSWORD') {
        throw new ApiError('UNAUTHENTICATED', 401, 'Authentication failed');
      }
      throw error;
    }
    this.store.appendAudit({
      actor: 'admin',
      action: 'admin.password_change',
      detail: {},
      nowMs: this.clock(),
    });
    this.sessions.invalidateOthers(auth.token);
    this.logger.info({ event: 'admin_password_changed' });
    this.sendJson(response, 200, { ok: true }, this.requestId(response));
  }

  /**
   * Partial settings update. Validation happens before any write; the store
   * commits the changed keys and the `settings.update` audit entry atomically.
   */
  private async handleUpdateSettings(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const patch = parseSettingsPatch(await this.readJson(request));
    const encoded = encodeSettingsPatch(patch);
    if (Object.keys(encoded).length > 0) {
      this.store.updateSettings(encoded, 'admin', this.clock());
      this.logger.info({
        event: 'settings_updated',
        keys: Object.keys(encoded).sort(),
      });
    }
    this.sendJson(
      response,
      200,
      { settings: readSettings(this.store) },
      this.requestId(response),
    );
  }

  // ------------------------------------------------------------- clients

  /**
   * Agent token management. All three routes require an unlocked gateway plus
   * a cookie session (with CSRF) or an admin session bearer token.
   *
   * A client token only authenticates `/v1/agent/*`; it can never approve a
   * proposal, so creating one cannot grant approval rights.
   */
  private handleAdminListClients(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    this.requireAdmin(request, { unlocked: true, mutating: false });
    // `listClients` selects metadata only: token_hash never leaves the store.
    this.sendJson(response, 200, this.store.listClients(), this.requestId(response));
  }

  /**
   * Creates one agent token. The plaintext token is returned exactly once in
   * this response; only its SHA-256 hash is persisted and the audit entry
   * records the id and name only.
   */
  private async handleAdminCreateClient(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const body = clientCreateRequestSchema.parse(await this.readJson(request));
    const token = `sag_${randomToken(32)}`;
    const client = this.store.createClient(
      body.name,
      sha256Hex(token),
      'admin',
      this.clock(),
    );
    this.logger.info({ event: 'client_created', client_id: client.id });
    this.sendJson(
      response,
      201,
      {
        id: client.id,
        name: client.name,
        token,
        created_at: client.created_at,
      },
      this.requestId(response),
    );
  }

  /**
   * Revokes a token by disabling the client row (records and proposal history
   * are kept). The disabled flag makes `findClientByTokenHash` miss, so the
   * token immediately fails agent authentication with 401.
   */
  private handleAdminRevokeClient(
    request: IncomingMessage,
    response: ServerResponse,
    clientId: string,
  ): void {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    if (!this.store.revokeClient(clientId, 'admin', this.clock())) {
      throw new ApiError('CLIENT_NOT_FOUND', 404, 'Client not found');
    }
    this.logger.info({ event: 'client_revoked', client_id: clientId });
    this.sendJson(response, 200, { ok: true }, this.requestId(response));
  }

  // -------------------------------------------------------------- agent flow

  private async handleAgentSubmit(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const client = this.authenticateAgent(request);
    const body = proposalCreateRequestSchema.parse(await this.readJson(request));
    const source = this.store.getSource(body.source_id);
    if (!source) throw new ApiError('SOURCE_NOT_FOUND', 404, 'Source not found');
    // Policy is dialect-specific: fail closed instead of letting the policy
    // auto-try every dialect when the source dialect is unavailable.
    if (!source.dialect) {
      throw new ApiError('POLICY_DENIED', 400, 'Source dialect is unavailable');
    }
    // Defaults and upper bounds come from the persisted settings, never from a
    // schema default: a missing max_rows/timeout_s must observe the current
    // admin configuration at submission time.
    const settings = readSettings(this.store);
    validateReadOnlySql(body.sql, {
      dialect: source.dialect,
      allowSystemCatalog: settings['security.allow_system_catalog'],
    });

    const maxRows = body.max_rows ?? settings['proposal.default_max_rows'];
    const timeoutS = body.timeout_s ?? settings['proposal.default_timeout_s'];
    if (maxRows > settings['proposal.max_max_rows']) {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        `max_rows must not exceed ${settings['proposal.max_max_rows']}`,
      );
    }
    if (timeoutS > settings['proposal.max_timeout_s']) {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        `timeout_s must not exceed ${settings['proposal.max_timeout_s']}`,
      );
    }

    if (body.request_key) {
      const existing = this.store.getProposalByRequestKey(client.id, body.request_key);
      if (existing) {
        this.sendJson(
          response,
          200,
          { id: existing.id, status: existing.status, expires_at: existing.expires_at },
          this.requestId(response),
        );
        return;
      }
    }

    const digest = sha256Hex(
      canonicalJson({
        client_id: client.id,
        source_id: body.source_id,
        sql: body.sql,
        params: body.params ?? null,
        purpose: body.purpose ?? null,
        max_rows: maxRows,
        timeout_s: timeoutS,
        policy_version: POLICY_VERSION,
      }),
    );
    const proposal = this.store.createProposal({
      clientId: client.id,
      sourceId: body.source_id,
      sql: body.sql,
      params: body.params ?? null,
      purpose: body.purpose ?? null,
      maxRows,
      timeoutS,
      requestKey: body.request_key ?? null,
      digest,
      policyVersion: POLICY_VERSION,
      ttlMs: settings['proposal.approval_window_hours'] * 60 * 60 * 1000,
    });
    this.store.appendAudit({
      actor: client.id,
      action: 'proposal.submit',
      proposalId: proposal.id,
      detail: {
        source_id: proposal.source_id,
        digest: proposal.digest,
        policy_version: proposal.policy_version,
      },
      nowMs: this.clock(),
    });
    // Live console update, after the proposal is durably stored. Replays of the
    // same request_key returned above and therefore never announce twice.
    this.broadcastProposal('proposal.created', proposal.id, source.name);
    // Best-effort operator toast. It runs only after the proposal is persisted
    // and never delays or fails the response; the request_key replay path above
    // returns before reaching this point, so retries do not notify twice.
    try {
      const notified = this.notify({
        sourceName: source.name,
        purpose: proposal.purpose,
        proposalId: proposal.id,
      });
      if (notified instanceof Promise) void notified.catch(() => {});
    } catch {
      // A notification failure must never affect proposal creation.
    }
    this.sendJson(
      response,
      201,
      { id: proposal.id, status: proposal.status, expires_at: proposal.expires_at },
      this.requestId(response),
    );
  }

  private handleAgentGetProposal(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string,
  ): void {
    const client = this.authenticateAgent(request);
    this.store.expirePending(this.clock());
    const proposal = this.store.getProposalForClient(proposalId, client.id);
    if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND', 404, 'Proposal not found');
    this.sendJson(
      response,
      200,
      toAgentProposal(proposal, this.resultSummary(proposal.id)),
      this.requestId(response),
    );
  }

  private handleAgentCancel(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string,
  ): void {
    const client = this.authenticateAgent(request);
    const proposal = this.store.getProposalForClient(proposalId, client.id);
    if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND', 404, 'Proposal not found');
    if (!this.store.cancelProposal(proposalId, client.id, client.id, this.clock())) {
      throw new ApiError('INVALID_STATE', 409, 'Proposal cannot be cancelled');
    }
    this.broadcastProposal('proposal.updated', proposalId, this.sourceLabel(proposal.source_id));
    this.sendJson(
      response,
      200,
      { id: proposalId, status: 'CANCELLED' },
      this.requestId(response),
    );
  }

  // ------------------------------------------------------------ admin query

  private handleAdminListProposals(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    this.requireAdmin(request, { unlocked: true, mutating: false });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const statusRaw = url.searchParams.get('status');
    let status: ProposalStatus | undefined;
    if (statusRaw) {
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new ApiError('INVALID_REQUEST', 400, 'Invalid proposal status');
      }
      status = statusRaw as ProposalStatus;
    }
    const query = url.searchParams.get('q')?.slice(0, 200) || undefined;
    const limit = parseInteger(url.searchParams.get('limit'), 100, 1, 500) ?? 100;
    this.store.expirePending(this.clock());
    const proposals = this.store.listProposals({ status, query, limit });
    this.sendJson(
      response,
      200,
      proposals.map((proposal) => ({
        id: proposal.id,
        client_id: proposal.client_id,
        source_id: proposal.source_id,
        sql: proposal.sql,
        params: proposal.params,
        purpose: proposal.purpose,
        max_rows: proposal.max_rows,
        timeout_s: proposal.timeout_s,
        status: proposal.status,
        status_message: proposal.status_message,
        digest: proposal.digest,
        policy_version: proposal.policy_version,
        created_at: proposal.created_at,
        updated_at: proposal.updated_at,
        expires_at: proposal.expires_at,
      })),
      this.requestId(response),
    );
  }

  /**
   * Approve → execute → store result (DESIGN §7.2). The conditional update is
   * still the only way into APPROVED, so concurrent approvals still produce
   * exactly one executor. Execution happens inside the request so the caller
   * observes the final status; a failure only returns an error code.
   */
  private async handleAdminApprove(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    if (this.locking) {
      throw new ApiError('LOCKED', 423, 'Gateway is locking');
    }
    this.store.expirePending(this.clock());
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND', 404, 'Proposal not found');

    // Policy is re-checked at approval time, including the version recorded at
    // submission (DESIGN §7.1).
    if (proposal.policy_version !== POLICY_VERSION) {
      this.store.failProposal(
        proposalId,
        'PENDING_APPROVAL',
        'policy_version_mismatch',
        'admin',
        this.clock(),
      );
      this.broadcastProposal('proposal.updated', proposalId, this.sourceLabel(proposal.source_id));
      throw new ApiError('POLICY_DENIED', 409, 'Policy version changed; submit the proposal again');
    }
    // Re-check against the source's dialect. If the source or its dialect is
    // unavailable, fail closed and never fall back to auto dialect detection.
    const source = this.store.getSource(proposal.source_id);
    if (!source || !source.dialect) {
      this.store.failProposal(
        proposalId,
        'PENDING_APPROVAL',
        'policy_recheck_failed',
        'admin',
        this.clock(),
      );
      this.broadcastProposal('proposal.updated', proposalId, this.sourceLabel(proposal.source_id));
      throw new ApiError(
        source ? 'POLICY_DENIED' : 'SOURCE_NOT_FOUND',
        source ? 409 : 404,
        source ? 'Source dialect is unavailable' : 'Source not found',
      );
    }
    const settings = readSettings(this.store);
    try {
      validateReadOnlySql(proposal.sql, {
        dialect: source.dialect,
        allowSystemCatalog: settings['security.allow_system_catalog'],
      });
    } catch (error) {
      this.store.failProposal(
        proposalId,
        'PENDING_APPROVAL',
        'policy_recheck_failed',
        'admin',
        this.clock(),
      );
      this.broadcastProposal('proposal.updated', proposalId, this.sourceLabel(proposal.source_id));
      throw error;
    }

    // Strict read-only preflight (v0.7): a configured source is only executed
    // when its most recent probe proves the credential cannot write. The check
    // is skipped entirely when `security.require_readonly_source` is false.
    if (
      proposal.status === 'PENDING_APPROVAL' &&
      settings['security.require_readonly_source']
    ) {
      const guard = await this.enforceReadonlySource(source);
      if (guard) {
        if (
          !this.store.failProposal(
            proposalId,
            'PENDING_APPROVAL',
            guard.reason,
            'admin',
            this.clock(),
            guard.auditDetail,
          )
        ) {
          throw new ApiError('INVALID_STATE', 409, 'Proposal is not pending approval');
        }
        this.broadcastProposal('proposal.updated', proposalId, source.name);
        this.logger.warn({
          event: 'proposal_rejected_readonly_guard',
          proposal_id: proposalId,
          code: guard.code,
        });
        this.sendJson(
          response,
          200,
          { id: proposalId, status: 'FAILED', result: null, error_code: guard.code },
          this.requestId(response),
        );
        return;
      }
    }

    if (!this.store.approveProposal(proposalId, 'admin', this.clock())) {
      throw new ApiError('INVALID_STATE', 409, 'Proposal is not pending approval');
    }
    this.logger.info({ event: 'proposal_approved', proposal_id: proposalId });
    // Announce the approval immediately; execution may take up to timeout_s.
    this.broadcastProposal('proposal.updated', proposalId, source.name);

    const outcome = await this.executeProposal(proposal);
    // ... and again once the terminal status/result is stored.
    this.broadcastProposal('proposal.updated', proposalId, source.name);
    this.sendJson(
      response,
      200,
      {
        id: proposalId,
        status: outcome.status,
        result: outcome.result,
        ...(outcome.error_code === undefined ? {} : { error_code: outcome.error_code }),
        ...(outcome.db_error_number === undefined
          ? {}
          : { db_error_number: outcome.db_error_number }),
      },
      this.requestId(response),
    );
  }

  /**
   * Resolves the read-only verdict for one source at approval time.
   *
   * Order (v0.7):
   *  1. a complete cache younger than PROBE_CACHE_TTL_MS is authoritative;
   *  2. otherwise the fixed per-dialect probe runs live and a completed probe
   *     is persisted (a failed probe clears the cache);
   *  3. probe failure → SOURCE_PROBE_FAILED, `readonly.ok !== true` →
   *     SOURCE_NOT_READONLY.
   *
   * Returns null when execution may proceed. Never exposes connection data.
   */
  private async enforceReadonlySource(
    source: SourceSummary,
  ): Promise<SourceGuardFailure | null> {
    const cached = readCachedReadonly(this.store.getSourceProbe(source.id), this.clock());
    if (cached) {
      return cached.readonly.ok === true ? null : readonlyFailure(cached.readonly);
    }

    const connection = this.vault.getSourceSecret(source.id);
    if (!connection) {
      this.store.clearSourceProbe(source.id);
      return probeFailure({ probe_error_code: 'NOT_UNLOCKED' });
    }

    let probe: SourceTestResult;
    try {
      probe = await this.probeSource(source.dialect, connection);
    } catch {
      this.store.clearSourceProbe(source.id);
      return probeFailure();
    }
    if (!probe.ok) {
      this.store.clearSourceProbe(source.id);
      return probeFailure(
        probe.error_code === undefined ? {} : { probe_error_code: probe.error_code },
      );
    }
    this.store.saveSourceProbe(source.id, probe.readonly, this.clock());
    return probe.readonly.ok === true ? null : readonlyFailure(probe.readonly);
  }

  /**
   * Moves an approved proposal through EXECUTING to SUCCEEDED/FAILED. Failures
   * never persist rows and never expose driver text.
   */
  private async executeProposal(proposal: ProposalSummary): Promise<ProposalExecutionOutcome> {
    const source = this.store.getSource(proposal.source_id);
    if (!source) {
      this.store.failProposal(proposal.id, 'APPROVED', 'source_not_found', 'admin', this.clock());
      return { status: 'FAILED', result: null, error_code: 'SOURCE_NOT_FOUND' };
    }
    const connection = this.vault.getSourceSecret(proposal.source_id);
    if (!connection) {
      this.store.failProposal(proposal.id, 'APPROVED', 'not_unlocked', 'admin', this.clock());
      return { status: 'FAILED', result: null, error_code: 'NOT_UNLOCKED' };
    }

    if (!this.store.transitionProposal(proposal.id, 'APPROVED', 'EXECUTING')) {
      throw new ApiError('INVALID_STATE', 409, 'Proposal cannot be executed');
    }

    const controller = new AbortController();
    this.inFlight.set(proposal.id, controller);
    try {
      const result = await this.executor.execute(
        { id: source.id, dialect: source.dialect, connection },
        proposal.sql,
        proposal.params,
        {
          maxRows: proposal.max_rows,
          timeoutMs: Math.max(1, proposal.timeout_s) * 1000,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) {
        throw new ExecutorError('LOCKED', 'Query was aborted');
      }
      const saved = this.store.saveResult({
        proposalId: proposal.id,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
        durationMs: result.durationMs,
        nowMs: this.clock(),
        ttlMs: readSettings(this.store)['result.ttl_hours'] * 60 * 60 * 1000,
      });
      const meta = this.store.getResultMeta(proposal.id);
      this.store.transitionProposal(proposal.id, 'EXECUTING', 'SUCCEEDED');
      this.store.appendAudit({
        actor: 'admin',
        action: 'proposal.execute',
        proposalId: proposal.id,
        detail: {
          total_rows: saved.totalRows,
          truncated: saved.truncated,
          duration_ms: result.durationMs,
          bytes: saved.bytes,
        },
        nowMs: this.clock(),
      });
      this.logger.info({
        event: 'proposal_executed',
        proposal_id: proposal.id,
        total_rows: saved.totalRows,
        truncated: saved.truncated,
        duration_ms: result.durationMs,
      });
      return {
        status: 'SUCCEEDED',
        result: {
          columns: result.columns,
          total_rows: saved.totalRows,
          truncated: saved.truncated,
          duration_ms: result.durationMs,
          executed_at: meta?.executed_at ?? new Date(this.clock()).toISOString(),
          expires_at: meta?.expires_at ?? new Date(this.clock()).toISOString(),
        },
      };
    } catch (error) {
      const code = this.mapExecutionError(error);
      const statusMessage =
        code === 'LOCKED' ? 'locked' : code === 'QUERY_TIMEOUT' ? 'timeout' : 'query_failed';
      const dbErrorNumber = error instanceof ExecutorError ? error.dbErrorNumber : undefined;
      // One audit event for the failure (action=proposal.failed, reason=...).
      this.store.failProposal(
        proposal.id,
        'EXECUTING',
        statusMessage,
        'admin',
        this.clock(),
        {
          code,
          ...(dbErrorNumber === undefined ? {} : { db_error_number: dbErrorNumber }),
        },
      );
      this.logger.warn({
        event: 'proposal_execution_failed',
        proposal_id: proposal.id,
        code,
      });
      return {
        status: 'FAILED',
        result: null,
        error_code: code,
        ...(dbErrorNumber === undefined ? {} : { db_error_number: dbErrorNumber }),
      };
    } finally {
      this.inFlight.delete(proposal.id);
    }
  }

  private mapExecutionError(error: unknown): ExecutorErrorCode {
    if (error instanceof ExecutorError) return error.code;
    return 'QUERY_FAILED';
  }

  private handleRows(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string,
    audience: 'agent' | 'admin',
  ): void {
    let clientId: string | null = null;
    if (audience === 'agent') {
      clientId = this.authenticateAgent(request).id;
    } else {
      this.requireAdmin(request, { unlocked: false, mutating: false });
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const page = parseInteger(url.searchParams.get('page'), 1, 1, 1_000_000) ?? 1;
    const pageSize =
      parseInteger(url.searchParams.get('page_size'), RESULT_PAGE_DEFAULT_SIZE, 1, RESULT_PAGE_MAX_SIZE) ??
      RESULT_PAGE_DEFAULT_SIZE;

    const proposal =
      clientId === null
        ? this.store.getProposal(proposalId)
        : this.store.getProposalForClient(proposalId, clientId);
    if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND', 404, 'Proposal not found');

    const meta = this.store.getResultMeta(proposalId);
    if (!meta) {
      if (proposal.status === 'SUCCEEDED') {
        throw new ApiError('RESULT_EXPIRED', 410, 'Result is no longer available');
      }
      throw new ApiError('INVALID_STATE', 409, 'Result is not available');
    }
    if (Date.parse(meta.expires_at) <= this.clock()) {
      this.store.deleteResult(proposalId);
      throw new ApiError('RESULT_EXPIRED', 410, 'Result is no longer available');
    }

    const offset = (page - 1) * pageSize;
    const rows = this.store
      .getResultRows(proposalId, offset, pageSize)
      .map((row) => parseStoredJson(row.row_json));
    this.sendJson(
      response,
      200,
      {
        columns: parseStoredJson(meta.columns_json) ?? [],
        rows,
        page,
        page_size: pageSize,
        total_rows: meta.total_rows,
        truncated: meta.truncated === 1,
        executed_at: meta.executed_at,
        duration_ms: meta.duration_ms,
        expires_at: meta.expires_at,
      },
      this.requestId(response),
    );
  }

  private resultSummary(proposalId: string): Record<string, unknown> | null {
    const meta = this.store.getResultMeta(proposalId);
    if (!meta) return null;
    return {
      columns: parseStoredJson(meta.columns_json) ?? [],
      total_rows: meta.total_rows,
      truncated: meta.truncated === 1,
      executed_at: meta.executed_at,
      duration_ms: meta.duration_ms,
      expires_at: meta.expires_at,
    };
  }

  private async handleAdminReject(
    request: IncomingMessage,
    response: ServerResponse,
    proposalId: string,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND', 404, 'Proposal not found');
    const raw = await this.readOptionalJson(request);
    const body = rejectRequestSchema.parse(raw);
    if (!this.store.rejectProposal(proposalId, body.reason ?? null, 'admin', this.clock())) {
      throw new ApiError('INVALID_STATE', 409, 'Proposal is not pending approval');
    }
    this.broadcastProposal('proposal.updated', proposalId, this.sourceLabel(proposal.source_id));
    this.sendJson(
      response,
      200,
      { id: proposalId, status: 'REJECTED' },
      this.requestId(response),
    );
  }

  // ---------------------------------------------------------------- sources

  private async handleAdminAddSource(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const body = sourceCreateRequestSchema.parse(await this.readJson(request));
    const id = randomUUID();
    const metadata = {
      id,
      name: body.name,
      dialect: body.dialect as SourceDialect,
    };
    await this.vault.addSource(metadata, body.connection ?? {});
    try {
      this.store.insertSource(metadata);
    } catch (error) {
      try {
        await this.vault.removeSource(id);
      } catch {
        // Best effort rollback; the original store error is reported.
      }
      throw error;
    }
    this.store.appendAudit({
      actor: 'admin',
      action: 'source.add',
      detail: { source_id: id, name: body.name, dialect: body.dialect },
      nowMs: this.clock(),
    });
    this.sendJson(response, 201, metadata, this.requestId(response));
  }

  /**
   * Partial source update. The vault is written first (metadata + re-encrypted
   * connection); if the control DB update then fails the old vault state is
   * restored so the two stores cannot silently diverge.
   */
  private async handleAdminUpdateSource(
    request: IncomingMessage,
    response: ServerResponse,
    sourceId: string,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const current = this.store.getSource(sourceId);
    if (!current) throw new ApiError('SOURCE_NOT_FOUND', 404, 'Source not found');

    const body = sourceUpdateRequestSchema.parse(await this.readJson(request));
    // Changing dialect replaces the connection contract, so a connection must
    // be supplied in the same request. Passing the *same* dialect is allowed.
    if (
      body.dialect !== undefined &&
      body.dialect !== current.dialect &&
      body.connection === undefined
    ) {
      throw new ApiError(
        'INVALID_REQUEST',
        400,
        'connection is required when the dialect changes',
      );
    }

    const fields: string[] = [];
    if (body.name !== undefined && body.name !== current.name) fields.push('name');
    if (body.dialect !== undefined && body.dialect !== current.dialect) fields.push('dialect');
    if (body.connection !== undefined) fields.push('connection');
    if (fields.length === 0) {
      // Nothing to change: no vault rewrite and no audit entry.
      this.sendJson(response, 200, current, this.requestId(response));
      return;
    }

    const previousSecret = this.vault.getSourceSecret(sourceId);
    if (!previousSecret) {
      throw new ApiError('INTERNAL_ERROR', 500, 'Source credentials are unavailable');
    }

    const updated = await this.vault.updateSource(sourceId, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.dialect === undefined ? {} : { dialect: body.dialect }),
      ...(body.connection === undefined ? {} : { connection: body.connection }),
    });

    let stored: { id: string; name: string; dialect: SourceDialect } | null;
    try {
      stored = this.store.updateSource(sourceId, {
        name: updated.name,
        dialect: updated.dialect,
      });
    } catch (error) {
      try {
        await this.vault.updateSource(sourceId, {
          name: current.name,
          dialect: current.dialect,
          connection: previousSecret,
        });
      } catch {
        // Best effort rollback; the original store error is reported.
      }
      throw error;
    }
    if (!stored) throw new ApiError('SOURCE_NOT_FOUND', 404, 'Source not found');

    this.store.appendAudit({
      actor: 'admin',
      action: 'source.update',
      detail: {
        source_id: sourceId,
        fields,
        name: stored.name,
        dialect: stored.dialect,
      },
      nowMs: this.clock(),
    });
    this.sendJson(response, 200, stored, this.requestId(response));
  }

  /**
   * Connection and read-only probe. The statement is fixed per dialect in
   * `probes.ts`; the request body is deliberately ignored. A failed test is a
   * successful HTTP call (`ok: false`) and never removes the source. The audit
   * detail is limited to source_id, ok and readonly.ok — no latency, server or
   * connection information.
   */
  private async handleAdminTestSource(
    request: IncomingMessage,
    response: ServerResponse,
    sourceId: string,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const source = this.store.getSource(sourceId);
    if (!source) throw new ApiError('SOURCE_NOT_FOUND', 404, 'Source not found');
    // The probe takes no input: any request body is drained and ignored.
    request.resume();
    const connection = this.vault.getSourceSecret(sourceId);
    if (!connection) {
      throw new ApiError('INTERNAL_ERROR', 500, 'Source credentials are unavailable');
    }

    const result = await this.probeSource(source.dialect, connection);
    // A successful probe refreshes the strict-mode cache (schema v3); a failed
    // probe clears it so approval never trusts a stale "read-only" verdict.
    if (result.ok) {
      this.store.saveSourceProbe(sourceId, result.readonly, this.clock());
    } else {
      this.store.clearSourceProbe(sourceId);
    }
    this.store.appendAudit({
      actor: 'admin',
      action: 'source.test',
      detail: {
        source_id: sourceId,
        ok: result.ok,
        readonly: { ok: result.readonly.ok },
      },
      nowMs: this.clock(),
    });
    this.sendJson(response, 200, result, this.requestId(response));
  }

  private async handleAdminDeleteSource(
    request: IncomingMessage,
    response: ServerResponse,
    sourceId: string,
  ): Promise<void> {
    this.requireAdmin(request, { unlocked: true, mutating: true });
    const source = this.store.getSource(sourceId);
    if (!source) throw new ApiError('SOURCE_NOT_FOUND', 404, 'Source not found');
    await this.vault.removeSource(sourceId);
    this.store.deleteSource(sourceId);
    this.store.appendAudit({
      actor: 'admin',
      action: 'source.delete',
      detail: { source_id: sourceId, name: source.name, dialect: source.dialect },
      nowMs: this.clock(),
    });
    this.sendJson(response, 200, { ok: true }, this.requestId(response));
  }

  // ------------------------------------------------------------------ auth

  private authenticateAgent(request: IncomingMessage): ClientRecord {
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
    const token = match[1]!.trim();
    if (!token.startsWith('sag_') || token.length < 16) {
      throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
    }
    const client = this.store.findClientByTokenHash(sha256Hex(token));
    if (!client) throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
    try {
      this.store.touchClient(client.id);
    } catch {
      // last_used_at is informational; never fail authentication for it.
    }
    return client;
  }

  private requireAdmin(
    request: IncomingMessage,
    options: { unlocked: boolean; mutating: boolean },
  ): AdminAuth {
    if (options.unlocked && !this.vault.unlocked) {
      throw new ApiError('NOT_UNLOCKED', 423, 'Gateway is locked');
    }
    const authorization = request.headers.authorization;
    let via: 'cookie' | 'bearer' = 'cookie';
    let token: string | null = null;
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (!match) throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
      token = match[1]!.trim();
      via = 'bearer';
    } else {
      token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME] ?? null;
    }
    const session = this.sessions.get(token);
    if (!session || !token) {
      throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
    }
    if (options.mutating && via === 'cookie') {
      const csrf = request.headers[CSRF_HEADER];
      if (typeof csrf !== 'string' || !safeEqualString(csrf, session.csrfToken)) {
        throw new ApiError('CSRF_REJECTED', 403, 'CSRF token is required');
      }
    }
    return { session, token, via };
  }

  // ------------------------------------------------------------------ body

  private async readJson(request: IncomingMessage): Promise<unknown> {
    return this.readBody(request, true);
  }

  private async readOptionalJson(request: IncomingMessage): Promise<unknown> {
    const contentLength = request.headers['content-length'];
    const transferEncoding = request.headers['transfer-encoding'];
    const hasBody =
      (typeof contentLength === 'string' && Number(contentLength) > 0) ||
      (typeof transferEncoding === 'string' && transferEncoding.length > 0);
    if (!hasBody) return {};
    return this.readBody(request, true);
  }

  private async readBody(request: IncomingMessage, requireJson: boolean): Promise<unknown> {
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported content encoding');
    }
    if (requireJson) {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json\s*(;|$)/i.test(contentType)) {
        request.resume();
        throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 415, 'Content-Type must be application/json');
      }
    }
    const lengthHeader = request.headers['content-length'];
    if (typeof lengthHeader === 'string') {
      const length = Number(lengthHeader);
      if (!Number.isFinite(length) || length < 0) {
        throw new ApiError('INVALID_REQUEST', 400, 'Invalid Content-Length');
      }
      if (length > MAX_BODY_BYTES) {
        request.resume();
        throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
      }
    }

    const chunks = await new Promise<Buffer[]>((resolvePromise, rejectPromise) => {
      const collected: Buffer[] = [];
      let total = 0;
      let settled = false;
      request.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BODY_BYTES) {
          settled = true;
          rejectPromise(new ApiError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large'));
          return;
        }
        collected.push(buffer);
      });
      request.on('end', () => {
        if (settled) return;
        settled = true;
        resolvePromise(collected);
      });
      request.on('error', () => {
        if (settled) return;
        settled = true;
        rejectPromise(new ApiError('INVALID_REQUEST', 400, 'Unable to read request body'));
      });
    });

    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim().length === 0) {
      throw new ApiError('INVALID_JSON', 400, 'Request body is required');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ApiError('INVALID_JSON', 400, 'Request body is not valid JSON');
    }
  }
}

function shapeError(error: unknown): ErrorShape {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryAfterSeconds:
        typeof error.details?.retryAfterSeconds === 'number'
          ? error.details.retryAfterSeconds
          : undefined,
    };
  }
  if (error instanceof ZodError) {
    const fields = error.issues
      .map((issue) => issue.path.join('.'))
      .filter(Boolean)
      .slice(0, 6)
      .join(', ');
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: fields ? `Invalid request body: ${fields}` : 'Invalid request body',
    };
  }
  if (error instanceof SqlPolicyError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof VaultError) {
    if (error.code === 'INVALID_PASSWORD') {
      return { status: 401, code: 'UNAUTHENTICATED', message: 'Authentication failed' };
    }
    if (error.code === 'ALREADY_CONFIGURED') {
      return { status: 409, code: 'ALREADY_CONFIGURED', message: 'Gateway is already configured' };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
  if (error instanceof StoreError) {
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function setSessionCookie(response: ServerResponse, token: string, maxAgeSeconds: number): void {
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
  );
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function parseInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function toAgentProposal(
  proposal: {
    id: string;
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
  },
  result: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: proposal.id,
    source_id: proposal.source_id,
    sql: proposal.sql,
    params: proposal.params,
    purpose: proposal.purpose,
    max_rows: proposal.max_rows,
    timeout_s: proposal.timeout_s,
    status: proposal.status,
    status_message: proposal.status_message,
    digest: proposal.digest,
    policy_version: proposal.policy_version,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    expires_at: proposal.expires_at,
    request_key: proposal.request_key,
    result,
  };
}

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  return new Gateway(options);
}

export function isExpiredProposal(expiresAt: string, now = Date.now()): boolean {
  return isIsoDate(expiresAt) && Date.parse(expiresAt) <= now;
}
