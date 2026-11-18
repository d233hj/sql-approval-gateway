import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import type * as mssqlTypes from 'mssql';

import {
  PROBE_TIMEOUT_MS,
  type SourceDialect,
  type SourceTestErrorCode,
  type SourceTestReadonly,
  type SourceTestResult,
} from '@sql-approval/shared';

import { readErrnoCode, readErrorNumber } from './executor/errors.js';

/**
 * Connection/read-only probes for the admin "test connection" action.
 *
 * Design constraints:
 *  - The SQL is fixed per dialect. No caller-supplied statement is accepted.
 *  - Every probe owns its own connection and its own deadline; neither the
 *    user executor worker nor its connection pool is involved.
 *  - Driver messages are never returned. A failure exposes only a stable code
 *    and (when the driver provides one) a numeric error number, because driver
 *    text may contain the host, user or password.
 */

const require = createRequire(import.meta.url);

const MSSQL_PROBE_SQL =
  "SELECT SUSER_SNAME() AS login_name, IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin, HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT') AS can_insert";
const MSSQL_VERSION_SQL = 'SELECT @@VERSION AS version';
const PG_READONLY_SQL = 'SHOW default_transaction_read_only';
const PG_CURRENT_USER_SQL = 'SELECT current_user';
const PG_VERSION_SQL = 'SHOW server_version';
const MYSQL_CURRENT_USER_SQL = 'SELECT CURRENT_USER()';
const MYSQL_GRANTS_SQL = 'SHOW GRANTS FOR CURRENT_USER()';
const MYSQL_VERSION_SQL = 'SELECT VERSION() AS version';

type ProbeOutcome = Omit<SourceTestResult, 'latency_ms'>;

class ProbeTimeout extends Error {
  constructor() {
    super('probe timed out');
    this.name = 'ProbeTimeout';
  }
}

/** Internal failure carrying a stable, secret-free public representation. */
class ProbeFailure extends Error {
  readonly code: SourceTestErrorCode;
  readonly detail: string;
  readonly dbErrorNumber: number | undefined;

  constructor(code: SourceTestErrorCode, detail: string, dbErrorNumber?: number) {
    super(detail);
    this.name = 'ProbeFailure';
    this.code = code;
    this.detail = detail;
    this.dbErrorNumber = dbErrorNumber;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readPort(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0 && parsed <= 65535) return parsed;
  }
  return fallback;
}

function readBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return undefined;
}

function toInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Version strings are truncated to one line and 160 characters. Every dialect
 * reports a product version here; no host, path or account information is
 * added by this module.
 */
export function sanitizeServerVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value
    .split(/\r?\n/, 1)[0]!
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (firstLine.length === 0) return undefined;
  return firstLine.slice(0, 160);
}

function fail(
  code: SourceTestErrorCode,
  detail: string,
  dbErrorNumber?: number,
): ProbeOutcome {
  return {
    ok: false,
    readonly: { ok: false, checked: false, details: [detail] },
    error_code: code,
    ...(dbErrorNumber === undefined ? {} : { db_error_number: dbErrorNumber }),
  };
}

function mapError(error: unknown): ProbeOutcome {
  if (error instanceof ProbeTimeout) return fail('QUERY_TIMEOUT', '探针执行超时');
  if (error instanceof ProbeFailure) {
    return fail(error.code, error.detail, error.dbErrorNumber);
  }
  return fail('QUERY_FAILED', '连接或查询失败', readErrorNumber(error));
}

/**
 * Races one probe against its own deadline. `onTimeout` is the cleanup hook
 * (close the pool/client); it is invoked when the deadline wins so a slow
 * driver cannot keep a connection alive after the response was sent.
 */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Cleanup is best effort; the timeout result is what matters.
      }
      rejectPromise(new ProbeTimeout());
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PROBE_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1), PROBE_TIMEOUT_MS);
}

// --------------------------------------------------------------------- sqlite

/**
 * SQLite has no credentials: opening the file with `readOnly: true` is the
 * strongest available proof that the gateway can read it without write access.
 */
function probeSqlite(connection: Record<string, unknown>): ProbeOutcome {
  const file = readString(connection.file, connection.database, connection.path, connection.filename);
  if (!file) return fail('QUERY_FAILED', 'SQLite 数据源缺少数据库文件配置');

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    let server: string | undefined;
    try {
      const row = db.prepare('SELECT sqlite_version() AS version').get() as
        | Record<string, unknown>
        | undefined;
      server = sanitizeServerVersion(
        row?.version === undefined ? undefined : `SQLite ${String(row.version)}`,
      );
    } catch {
      // The version is informational; the read-only open already succeeded.
    }
    return {
      ok: true,
      ...(server === undefined ? {} : { server }),
      readonly: {
        ok: true,
        checked: true,
        details: ['以 readOnly 模式打开成功'],
      },
    };
  } catch {
    // Never surface the driver message: SQLite errors can include the path.
    return fail('QUERY_FAILED', '以 readOnly 模式打开失败');
  } finally {
    try {
      db?.close();
    } catch {
      // The handle may already be closed after a failed open.
    }
  }
}

// ---------------------------------------------------------------------- mssql

function loadMssql(): typeof mssqlTypes | null {
  try {
    return require('mssql') as typeof mssqlTypes;
  } catch {
    return null;
  }
}

function buildMssqlProbeConfig(
  connection: Record<string, unknown>,
  timeoutMs: number,
): mssqlTypes.config {
  const host = readString(
    connection.host,
    connection.server,
    connection.serverName,
    connection.address,
  );
  if (!host) throw new ProbeFailure('QUERY_FAILED', 'SQL Server 数据源缺少服务器配置');
  return {
    server: host,
    port: readPort(connection.port, 1433),
    database: readString(connection.database, connection.db),
    user: readString(connection.username, connection.user),
    password: readString(connection.password),
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    options: {
      encrypt: true,
      trustServerCertificate:
        readBoolean(
          connection.trustServerCertificate,
          connection.trust_server_certificate,
          connection.trustCertificate,
        ) ?? false,
      appName: 'sql-approval-gateway (probe)',
      readOnlyIntent: true,
      cancelTimeout: 1000,
      enableArithAbort: true,
      useUTC: true,
    },
  };
}

function firstRecord(recordset: unknown): Record<string, unknown> | null {
  if (!Array.isArray(recordset)) return null;
  const first = recordset[0];
  return isRecord(first) ? first : null;
}

function classifyDriverError(error: unknown): ProbeFailure {
  const code = readErrnoCode(error);
  const dbErrorNumber = readErrorNumber(error);
  switch (code) {
    case 'ETIMEOUT':
    case 'ESOCKETTIMEDOUT':
    case 'PROTOCOL_TIMEOUT':
    case 'ETIMEDOUT':
      return new ProbeFailure('QUERY_TIMEOUT', '连接或查询超时', dbErrorNumber);
    default:
      return new ProbeFailure('QUERY_FAILED', '连接或查询失败', dbErrorNumber);
  }
}

/**
 * `readonly.ok = is_sysadmin === 0 && can_insert === 0`. A missing/non-numeric
 * field is treated as "cannot verify" and fails closed (ok=false, checked=false).
 */
export function evaluateMssqlReadonly(row: unknown): SourceTestReadonly {
  const record = isRecord(row) ? row : null;
  const isSysadmin = toInteger(record?.is_sysadmin);
  const canInsert = toInteger(record?.can_insert);
  if (isSysadmin === null || canInsert === null) {
    return {
      ok: false,
      checked: false,
      details: ['无法判定 sysadmin / INSERT 权限'],
    };
  }
  const details: string[] = [];
  if (isSysadmin !== 0) details.push('命中 sysadmin 服务器角色');
  if (canInsert !== 0) details.push('命中当前数据库 INSERT 权限');
  const ok = isSysadmin === 0 && canInsert === 0;
  if (ok) details.push('非 sysadmin 且当前数据库无 INSERT 权限');
  return { ok, checked: true, details };
}

async function closeMssqlPool(pool: mssqlTypes.ConnectionPool | null): Promise<void> {
  if (!pool) return;
  try {
    await withDeadline(
      Promise.resolve().then(() => pool!.close()),
      1000,
    );
  } catch {
    // The pool may never have connected; there is nothing actionable to do.
  }
}

async function probeMssql(
  connection: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const mssql = loadMssql();
  if (!mssql) return fail('DRIVER_UNAVAILABLE', 'mssql 驱动未安装');

  let config: mssqlTypes.config;
  try {
    config = buildMssqlProbeConfig(connection, timeoutMs);
  } catch (error) {
    return mapError(error);
  }

  let pool: mssqlTypes.ConnectionPool | null = null;
  try {
    const outcome = await withDeadline(
      (async (): Promise<ProbeOutcome> => {
        pool = new mssql.ConnectionPool(config);
        await pool.connect();
        const result = await pool.request().query(MSSQL_PROBE_SQL);
        const readonly = evaluateMssqlReadonly(firstRecord(result.recordset));

        let server: string | undefined;
        try {
          const versionResult = await pool.request().query(MSSQL_VERSION_SQL);
          server = sanitizeServerVersion(firstRecord(versionResult.recordset)?.version);
        } catch {
          // A missing version does not invalidate the read-only result.
        }
        return {
          ok: true,
          ...(server === undefined ? {} : { server }),
          readonly,
        };
      })(),
      timeoutMs,
      () => {
        void closeMssqlPool(pool);
      },
    );
    return outcome;
  } catch (error) {
    return mapError(error);
  } finally {
    void closeMssqlPool(pool);
  }
}

// ------------------------------------------------------------------- postgres

interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows?: Array<Record<string, unknown>> }>;
  end(): Promise<void> | void;
}

interface PgModuleLike {
  Client: new (config: Record<string, unknown>) => PgClientLike;
}

function loadPg(): PgModuleLike | null {
  try {
    const module = require('pg') as Record<string, unknown>;
    if (typeof module.Client === 'function') return module as unknown as PgModuleLike;
  } catch {
    // The optional driver is not installed.
  }
  return null;
}

function firstRowValue(result: { rows?: Array<Record<string, unknown>> }): unknown {
  const row = result.rows?.[0];
  if (!row) return undefined;
  return Object.values(row)[0];
}

/**
 * `default_transaction_read_only=on` proves the session cannot write.
 * `off` does not prove the opposite (the role may still be SELECT-only), so it
 * is reported as unverified instead of failing the connection test.
 */
export function evaluatePostgresReadonly(value: unknown): SourceTestReadonly {
  const flag = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (flag === 'on' || flag === 'true') {
    return {
      ok: true,
      checked: true,
      details: ['default_transaction_read_only=on'],
    };
  }
  if (flag === 'off' || flag === 'false') {
    return {
      ok: true,
      checked: false,
      details: ['default_transaction_read_only=off', '未验证写权限'],
    };
  }
  return {
    ok: true,
    checked: false,
    details: ['无法判定 default_transaction_read_only', '未验证写权限'],
  };
}

async function closePgClient(client: PgClientLike | null): Promise<void> {
  if (!client) return;
  try {
    await withDeadline(
      Promise.resolve().then(() => client!.end()),
      1000,
    );
  } catch {
    // The connection may already be gone.
  }
}

async function probePostgres(
  connection: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const pg = loadPg();
  if (!pg) return fail('DRIVER_UNAVAILABLE', 'pg 驱动未安装');

  const host = readString(connection.host, connection.server);
  if (!host) return fail('QUERY_FAILED', 'PostgreSQL 数据源缺少服务器配置');

  const config: Record<string, unknown> = {
    host,
    port: readPort(connection.port, 5432),
    database: readString(connection.database, connection.db),
    user: readString(connection.username, connection.user),
    password: readString(connection.password),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'sql-approval-gateway (probe)',
  };

  let client: PgClientLike | null = null;
  let connected = false;
  try {
    const outcome = await withDeadline(
      (async (): Promise<ProbeOutcome> => {
        client = new pg.Client(config);
        await client.connect();
        connected = true;

        let readonly: SourceTestReadonly;
        try {
          const flagResult = await client.query(PG_READONLY_SQL);
          await client.query(PG_CURRENT_USER_SQL);
          readonly = evaluatePostgresReadonly(firstRowValue(flagResult));
        } catch {
          readonly = {
            ok: true,
            checked: false,
            details: ['查询只读状态失败，未验证写权限'],
          };
        }

        let server: string | undefined;
        try {
          const versionResult = await client.query(PG_VERSION_SQL);
          server = sanitizeServerVersion(
            firstRowValue(versionResult) === undefined
              ? undefined
              : `PostgreSQL ${String(firstRowValue(versionResult))}`,
          );
        } catch {
          // A missing version does not invalidate the read-only result.
        }

        return {
          ok: true,
          ...(server === undefined ? {} : { server }),
          readonly,
        };
      })(),
      timeoutMs,
      () => {
        void closePgClient(client);
      },
    );
    return outcome;
  } catch (error) {
    if (connected) {
      return {
        ok: true,
        readonly: {
          ok: true,
          checked: false,
          details: ['连接成功但未完成只读判定', '未验证写权限'],
        },
      };
    }
    return mapError(error);
  } finally {
    void closePgClient(client);
  }
}

// ---------------------------------------------------------------------- mysql

interface MysqlConnectionLike {
  query(sql: string): Promise<unknown>;
  end(): Promise<void> | void;
}

type MysqlConnect = (config: Record<string, unknown>) => Promise<MysqlConnectionLike>;

function loadMysql(): MysqlConnect | null {
  try {
    const module = require('mysql2/promise') as Record<string, unknown>;
    if (typeof module.createConnection === 'function') {
      const createConnection = module.createConnection as (
        config: Record<string, unknown>,
      ) => Promise<MysqlConnectionLike>;
      return (config) => createConnection.call(module, config);
    }
  } catch {
    // The optional driver is not installed.
  }
  return null;
}

/** mysql2/promise returns `[rows, fields]`; this normalizes both shapes. */
function mysqlRows(result: unknown): Array<Record<string, unknown>> {
  const payload = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord);
}

function mysqlFirstValue(result: unknown): unknown {
  const row = mysqlRows(result)[0];
  if (!row) return undefined;
  return Object.values(row)[0];
}

/**
 * Only the privilege list (the part between GRANT and ON) is inspected, so a
 * table or account named "all"/"update" cannot spoof a write privilege. Any
 * INSERT/UPDATE/DELETE/ALL privilege makes the source non-read-only.
 */
export function parseMysqlGrants(grants: readonly string[]): SourceTestReadonly {
  if (grants.length === 0) {
    return {
      ok: true,
      checked: false,
      details: ['未取得 GRANT 列表', '未验证写权限'],
    };
  }
  const hits = new Set<string>();
  for (const grant of grants) {
    const match = /^\s*GRANT\s+(.+?)\s+ON\s+/i.exec(grant);
    const privilegeList = match ? match[1]! : grant;
    const write = /\b(INSERT|UPDATE|DELETE|ALL)\b/i.exec(privilegeList);
    if (write) hits.add(write[1]!.toUpperCase());
  }
  if (hits.size === 0) {
    return {
      ok: true,
      checked: true,
      details: ['GRANT 未包含 INSERT/UPDATE/DELETE/ALL'],
    };
  }
  return {
    ok: false,
    checked: true,
    details: [`GRANT 命中写权限: ${[...hits].sort().join(', ')}`],
  };
}

async function closeMysqlConnection(connection: MysqlConnectionLike | null): Promise<void> {
  if (!connection) return;
  try {
    await withDeadline(
      Promise.resolve().then(() => connection!.end()),
      1000,
    );
  } catch {
    // The connection may already be gone.
  }
}

async function probeMysql(
  connection: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const createConnection = loadMysql();
  if (!createConnection) return fail('DRIVER_UNAVAILABLE', 'mysql2 驱动未安装');

  const host = readString(connection.host, connection.server);
  if (!host) return fail('QUERY_FAILED', 'MySQL 数据源缺少服务器配置');

  const config: Record<string, unknown> = {
    host,
    port: readPort(connection.port, 3306),
    database: readString(connection.database, connection.db),
    user: readString(connection.username, connection.user),
    password: readString(connection.password),
    connectTimeout: timeoutMs,
    multipleStatements: false,
    dateStrings: true,
  };

  let client: MysqlConnectionLike | null = null;
  let connected = false;
  try {
    const outcome = await withDeadline(
      (async (): Promise<ProbeOutcome> => {
        client = await createConnection(config);
        connected = true;

        let readonly: SourceTestReadonly;
        try {
          await client.query(MYSQL_CURRENT_USER_SQL);
          const grantsResult = await client.query(MYSQL_GRANTS_SQL);
          const grants = mysqlRows(grantsResult)
            .map((row) => {
              const value = Object.values(row)[0];
              return typeof value === 'string' ? value : '';
            })
            .filter((value) => value.length > 0);
          readonly = parseMysqlGrants(grants);
        } catch {
          readonly = {
            ok: true,
            checked: false,
            details: ['查询 GRANT 失败，未验证写权限'],
          };
        }

        let server: string | undefined;
        try {
          const versionResult = await client.query(MYSQL_VERSION_SQL);
          server = sanitizeServerVersion(
            mysqlFirstValue(versionResult) === undefined
              ? undefined
              : `MySQL ${String(mysqlFirstValue(versionResult))}`,
          );
        } catch {
          // A missing version does not invalidate the read-only result.
        }

        return {
          ok: true,
          ...(server === undefined ? {} : { server }),
          readonly,
        };
      })(),
      timeoutMs,
      () => {
        void closeMysqlConnection(client);
      },
    );
    return outcome;
  } catch (error) {
    if (connected) {
      return {
        ok: true,
        readonly: {
          ok: true,
          checked: false,
          details: ['连接成功但未完成只读判定', '未验证写权限'],
        },
      };
    }
    return mapError(error);
  } finally {
    void closeMysqlConnection(client);
  }
}

// ------------------------------------------------------------------ dispatcher

async function probeFor(
  dialect: SourceDialect,
  connection: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  switch (dialect) {
    case 'sqlite':
      return probeSqlite(connection);
    case 'mssql':
      return probeMssql(connection, timeoutMs);
    case 'postgres':
      return probePostgres(connection, timeoutMs);
    case 'mysql':
      return probeMysql(connection, timeoutMs);
  }
}

/**
 * Runs the fixed probe for one dialect. Never throws: a failed connection is a
 * normal `ok: false` result, so the caller keeps the source intact.
 */
export async function runSourceProbe(
  dialect: SourceDialect,
  connection: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<SourceTestResult> {
  const started = Date.now();
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  let outcome: ProbeOutcome;
  try {
    outcome = await withDeadline(probeFor(dialect, connection, timeoutMs), timeoutMs);
  } catch (error) {
    outcome = mapError(error);
  }
  return {
    ...outcome,
    latency_ms: Math.max(0, Date.now() - started),
  };
}
