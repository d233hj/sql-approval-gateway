import { createRequire } from 'node:module';

import type * as mssqlTypes from 'mssql';

import type { ResultColumn } from '../result.js';
import { ExecutorError, readErrnoCode, readErrorNumber } from './errors.js';
import type { ConnectorOptions, ConnectorResult } from './types.js';
import { normalizeCell } from './values.js';

// mssql is CommonJS-only. A namespace import would depend on cjs-module-lexer
// detecting its exports, so it is loaded through createRequire and typed with
// the @types/mssql declarations.
const require = createRequire(import.meta.url);
const mssql = require('mssql') as typeof mssqlTypes;

/** How long a cancelled request may take before the connection is discarded. */
const CANCEL_SETTLE_MS = 2000;
const DEFAULT_PORT = 1433;
const CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface PoolEntry {
  promise: Promise<mssqlTypes.ConnectionPool>;
  pool: mssqlTypes.ConnectionPool | null;
}

const pools = new Map<string, PoolEntry>();

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readPort(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0 && parsed <= 65535) return parsed;
  }
  return DEFAULT_PORT;
}

function readBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return undefined;
}

export interface ResolvedMssqlConnection {
  server: string;
  port: number;
  database: string | undefined;
  user: string | undefined;
  password: string | undefined;
  trustServerCertificate: boolean;
}

export function resolveMssqlConnection(
  connection: Record<string, unknown>,
): ResolvedMssqlConnection {
  const server = readString(
    connection.host,
    connection.server,
    connection.serverName,
    connection.address,
  );
  if (!server) {
    throw new ExecutorError('QUERY_FAILED', 'SQL Server source has no server configured');
  }
  return {
    server,
    port: readPort(connection.port),
    database: readString(connection.database, connection.db),
    user: readString(connection.username, connection.user),
    password: readString(connection.password),
    trustServerCertificate:
      readBoolean(
        connection.trustServerCertificate,
        connection.trust_server_certificate,
        connection.trustCertificate,
      ) ?? false,
  };
}

export function buildConfig(connection: Record<string, unknown>): mssqlTypes.config {
  const resolved = resolveMssqlConnection(connection);
  return {
    server: resolved.server,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    password: resolved.password,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    options: {
      // DESIGN §7.2: Encrypt is mandatory; TrustServerCertificate follows the
      // source configuration (default false).
      encrypt: true,
      trustServerCertificate: resolved.trustServerCertificate,
      appName: 'sql-approval-gateway (read-only)',
      readOnlyIntent: true,
      cancelTimeout: 1000,
      enableArithAbort: true,
      useUTC: true,
    },
    pool: {
      min: 0,
      max: 4,
      idleTimeoutMillis: 60_000,
    },
    arrayRowMode: true,
  };
}

async function createPool(
  sourceKey: string,
  connection: Record<string, unknown>,
  entry: PoolEntry,
): Promise<mssqlTypes.ConnectionPool> {
  const pool = new mssql.ConnectionPool(buildConfig(connection));
  pool.on('error', () => {
    // Pool-level errors surface through the request that triggered them; this
    // listener only prevents an unhandled 'error' event from killing the worker.
  });
  try {
    await pool.connect();
  } catch (error) {
    try {
      await pool.close();
    } catch {
      // Ignore close failures on a pool that never connected.
    }
    throw mapMssqlError(error);
  }
  entry.pool = pool;
  return pool;
}

/** Returns the shared pool for this source, creating it on first use. */
export function getPool(
  sourceKey: string,
  connection: Record<string, unknown>,
): Promise<mssqlTypes.ConnectionPool> {
  const existing = pools.get(sourceKey);
  if (existing) return existing.promise;
  const entry: PoolEntry = { promise: Promise.resolve(null as never), pool: null };
  entry.promise = createPool(sourceKey, connection, entry).catch((error: unknown) => {
    if (pools.get(sourceKey) === entry) pools.delete(sourceKey);
    throw error;
  });
  pools.set(sourceKey, entry);
  return entry.promise;
}

/** DESIGN §7.2: discard the connection only when the driver cannot recover it. */
export async function destroyPool(sourceKey: string): Promise<void> {
  const entry = pools.get(sourceKey);
  if (!entry) return;
  pools.delete(sourceKey);
  try {
    const pool = entry.pool ?? (await entry.promise.catch(() => null));
    await pool?.close();
  } catch {
    // The connection is being discarded; a close error is not actionable.
  }
}

export async function closeAllPools(): Promise<void> {
  const keys = [...pools.keys()];
  await Promise.all(keys.map((key) => destroyPool(key)));
}

export interface PoolStats {
  sources: number;
  connections: number;
}

export function poolStats(): PoolStats {
  let connections = 0;
  for (const entry of pools.values()) connections += entry.pool?.size ?? 0;
  return { sources: pools.size, connections };
}

function typeName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.declaration === 'string') return record.declaration;
  return typeof record.name === 'string' ? record.name : undefined;
}

/**
 * Maps the `recordset` payload to result columns. With `arrayRowMode` the
 * driver emits an array of `{ index, name, ... }`, but older drivers emit an
 * object map; both shapes are accepted. When `name` is missing the origin
 * `column` name and finally a positional placeholder are used.
 */
export function resolveMssqlColumns(recordsetColumns: unknown): ResultColumn[] {
  const entries: unknown[] = Array.isArray(recordsetColumns)
    ? recordsetColumns
    : typeof recordsetColumns === 'object' && recordsetColumns !== null
      ? Object.values(recordsetColumns as Record<string, unknown>)
      : [];
  return entries.map((column, index) => {
    const record = (column ?? {}) as Record<string, unknown>;
    const declaredName = typeof record.name === 'string' ? record.name : '';
    const originName = typeof record.column === 'string' ? record.column : '';
    const name =
      declaredName.trim().length > 0
        ? declaredName
        : originName.trim().length > 0
          ? originName
          : `column_${index + 1}`;
    const type = typeName(record.type);
    return type === undefined ? { name } : { name, type };
  });
}

export function mapMssqlError(error: unknown): ExecutorError {
  const code = readErrnoCode(error);
  const dbErrorNumber = readErrorNumber(error);
  switch (code) {
    case 'ETIMEOUT':
      return new ExecutorError('QUERY_TIMEOUT', 'Query timed out', { dbErrorNumber });
    case 'ECANCEL':
      return new ExecutorError('CANCELLED', 'Query was cancelled', { dbErrorNumber });
    case 'ECANCELTIMEOUT':
    case 'ESOCKET':
    case 'ECONNCLOSED':
    case 'ECONNRESET':
    case 'ENOTOPEN':
      return new ExecutorError('QUERY_FAILED', 'Database connection lost', {
        dbErrorNumber,
        destroyConnection: true,
      });
    default:
      return new ExecutorError('QUERY_FAILED', 'Query failed', { dbErrorNumber });
  }
}

interface RequestConstructor {
  new (
    parent: mssqlTypes.ConnectionPool,
    overrides?: { requestTimeout?: number },
  ): mssqlTypes.Request;
}

const RequestWithTimeout = mssql.Request as unknown as RequestConstructor;

/**
 * Streams a query through the shared pool, stopping after max_rows + 1 rows and
 * cancelling the request (POC: cancel leaves the pooled connection reusable).
 */
export async function executeMssqlQuery(
  sourceKey: string,
  connection: Record<string, unknown>,
  sql: string,
  params: unknown,
  options: ConnectorOptions,
): Promise<ConnectorResult> {
  const started = Date.now();
  const maxRows = Math.max(1, Math.trunc(options.maxRows));
  const pool = await getPool(sourceKey, connection);

  if (options.cancel.cancelled) {
    throw new ExecutorError('CANCELLED', 'Query was cancelled');
  }

  const request = new RequestWithTimeout(pool, {
    requestTimeout: Math.max(1, options.timeoutMs),
  });
  request.stream = true;

  if (params !== null && params !== undefined) {
    if (Array.isArray(params)) {
      throw new ExecutorError('QUERY_FAILED', 'SQL Server sources require named parameters');
    }
    if (typeof params !== 'object') {
      throw new ExecutorError('QUERY_FAILED', 'Unsupported parameter shape');
    }
    for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
      try {
        request.input(name, value);
      } catch {
        throw new ExecutorError('QUERY_FAILED', 'Unable to bind query parameters');
      }
    }
  }

  return await new Promise<ConnectorResult>((resolvePromise, rejectPromise) => {
    const rows: unknown[][] = [];
    let columns: Array<{ name: string; type?: string }> = [];
    let truncated = false;
    let settled = false;
    let cancelTimer: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = () => {
      if (cancelTimer) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      // Keep the 'error' listener: the driver can still emit after we settle,
      // and an EventEmitter 'error' without a listener would crash the worker.
      request.removeAllListeners('row');
      request.removeAllListeners('recordset');
      request.removeAllListeners('done');
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        columns,
        rows,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    const fail = (error: ExecutorError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error.destroyConnection) void destroyPool(sourceKey);
      rejectPromise(error);
    };

    const cancelRequest = (reason: 'truncated' | 'external') => {
      if (settled) return;
      try {
        // `cancel()` throws when the driver request has not started yet; the
        // private `_cancel` hook is only installed once it has.
        const internal = request as unknown as { _cancel?: () => void };
        if (typeof internal._cancel === 'function') request.cancel();
      } catch {
        // The driver may already have finished the request.
      }
      if (cancelTimer) return;
      cancelTimer = setTimeout(() => {
        cancelTimer = null;
        if (settled) return;
        // A cancel that never settles means the connection is suspect.
        void destroyPool(sourceKey);
        if (reason === 'truncated') succeed();
        else fail(new ExecutorError('QUERY_FAILED', 'Query cancellation timed out'));
      }, CANCEL_SETTLE_MS);
      cancelTimer.unref?.();
    };

    unsubscribe = options.cancel.onCancel(() => cancelRequest('external'));

    request.on('recordset', (recordsetColumns: unknown) => {
      if (columns.length > 0) return;
      columns = resolveMssqlColumns(recordsetColumns);
    });

    request.on('row', (row: unknown) => {
      if (settled) return;
      if (rows.length >= maxRows) {
        truncated = true;
        cancelRequest('truncated');
        return;
      }
      if (Array.isArray(row)) {
        rows.push(row.map((cell) => normalizeCell(cell)));
      } else if (typeof row === 'object' && row !== null) {
        rows.push(
          Object.values(row as Record<string, unknown>).map((cell) => normalizeCell(cell)),
        );
      } else {
        rows.push([normalizeCell(row)]);
      }
    });

    request.on('error', (error: unknown) => {
      if (settled) return;
      const mapped = mapMssqlError(error);
      if (truncated && (mapped.code === 'CANCELLED' || mapped.destroyConnection)) {
        // Our own row-limit cancel: the rows read so far are the complete
        // truncated result. A cancel timeout discards the connection.
        if (mapped.destroyConnection) void destroyPool(sourceKey);
        succeed();
        return;
      }
      fail(mapped);
    });

    request.on('done', () => {
      if (settled) return;
      succeed();
    });

    try {
      const completion = request.query(sql) as unknown as Promise<unknown> | undefined;
      // In stream mode the promise settles after 'done'; swallowing it keeps a
      // driver rejection from becoming an unhandled rejection.
      if (completion && typeof completion.catch === 'function') {
        completion.catch(() => {});
      }
    } catch (error) {
      fail(mapMssqlError(error));
    }
  });
}
