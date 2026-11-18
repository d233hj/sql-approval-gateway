import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { isRecord } from './errors.js';

/** Human-readable metadata; it never participates in the election. */
export const INSTANCE_LOCK_FILENAME = 'instance.lock';
/** Authoritative single-instance mutex (SQLite exclusive lock). */
export const INSTANCE_DB_FILENAME = 'instance-lock.db';

const INSTANCE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  version TEXT
)`;

export interface InstanceLockInfo {
  pid: number;
  port: number;
  startedAt: string;
  url?: string;
  version?: string;
}

export class InstanceLockError extends Error {
  readonly code: 'ALREADY_RUNNING' | 'LOCK_FAILED';
  /** DESIGN §3.2: the second process prints the URL and exits with code 3. */
  readonly exitCode: number;
  readonly existing: InstanceLockInfo | null;

  constructor(
    code: 'ALREADY_RUNNING' | 'LOCK_FAILED',
    message: string,
    existing: InstanceLockInfo | null = null,
  ) {
    super(message);
    this.name = 'InstanceLockError';
    this.code = code;
    this.exitCode = code === 'ALREADY_RUNNING' ? 3 : 1;
    this.existing = existing;
  }
}

export interface InstanceLockHandle {
  readonly dbFile: string;
  readonly metadataFile: string;
  info: InstanceLockInfo;
  /** Updates the row inside the open transaction and the metadata file. */
  update(info: InstanceLockInfo): boolean;
  /** Rolls the transaction back, closes the connection and removes metadata. */
  release(): void;
}

export interface InstanceProbeResult {
  healthy: boolean;
  url: string;
  pid: number | null;
  version: string | null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isErrnoCode(error, 'EPERM');
  }
}

/** Reads the human-readable metadata file (diagnostics only). */
export function readInstanceLock(file: string): InstanceLockInfo | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) return null;
    const pid = parsed.pid;
    const port = parsed.port;
    const startedAt = parsed.startedAt;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof port !== 'number' ||
      !Number.isSafeInteger(port) ||
      port < 0 ||
      port > 65535 ||
      typeof startedAt !== 'string'
    ) {
      return null;
    }
    const info: InstanceLockInfo = { pid, port, startedAt };
    if (typeof parsed.url === 'string' && parsed.url.length > 0) info.url = parsed.url;
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      info.version = parsed.version;
    }
    return info;
  } catch {
    return null;
  }
}

function readEndpointInfo(file: string): InstanceLockInfo | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) return null;
    const pid = parsed.pid;
    const url = parsed.url;
    const version = parsed.version;
    const startedAt = parsed.startedAt;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof url !== 'string' ||
      typeof startedAt !== 'string'
    ) {
      return null;
    }
    let port = 0;
    try {
      port = Number(new URL(url).port);
    } catch {
      port = 0;
    }
    const info: InstanceLockInfo = { pid, port, startedAt, url };
    if (typeof version === 'string' && version.length > 0) info.version = version;
    return info;
  } catch {
    return null;
  }
}

function writeMetadataFile(file: string, info: InstanceLockInfo): boolean {
  try {
    writeFileSync(file, `${JSON.stringify(info)}\n`, { mode: 0o600 });
    return true;
  } catch {
    // Metadata is cosmetic; the SQLite lock is what matters.
    return false;
  }
}

function writeInstanceRow(db: DatabaseSync, info: InstanceLockInfo): void {
  db.prepare(
    `INSERT INTO instance (id, pid, port, started_at, version)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       port = excluded.port,
       started_at = excluded.started_at,
       version = excluded.version`,
  ).run(info.pid, info.port, info.startedAt, info.version ?? null);
}

function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const errcode = record.errcode;
  if (errcode === 5 || errcode === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
  const message = typeof record.message === 'string' ? record.message : '';
  return /database is locked|database table is locked|busy/i.test(message);
}

/**
 * Acquires the single-instance mutex with a SQLite exclusive lock.
 *
 * The file system has no compare-and-swap, so a lock file cannot be "taken
 * over" safely: every rename/delete patch leaves a window in which a
 * concurrent starter's fresh lock is moved away. SQLite's locking is atomic and
 * is released by the OS when the process dies, so:
 *
 *   1. open `instance-lock.db` (rollback journal, never WAL);
 *   2. `PRAGMA locking_mode = EXCLUSIVE` then `BEGIN EXCLUSIVE`;
 *   3. write the `instance` row and keep the transaction open until exit.
 *
 * A second process fails `BEGIN EXCLUSIVE` with SQLITE_BUSY; it reports
 * ALREADY_RUNNING (exit code 3) using the metadata file / endpoint.json.
 */
export function acquireInstanceLock(dbFile: string, info: InstanceLockInfo): InstanceLockHandle {
  mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
  const metadataFile = join(dirname(dbFile), INSTANCE_LOCK_FILENAME);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { timeout: 0 });
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('PRAGMA locking_mode = EXCLUSIVE;');
    db.exec('BEGIN EXCLUSIVE;');
    db.exec(INSTANCE_TABLE_SQL);
    writeInstanceRow(db, info);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The connection may never have opened.
    }
    if (isLockContention(error)) {
      const existing =
        readInstanceLock(metadataFile) ??
        readEndpointInfo(join(dirname(dbFile), 'endpoint.json'));
      throw new InstanceLockError(
        'ALREADY_RUNNING',
        'Another gateway instance is already running',
        existing,
      );
    }
    throw new InstanceLockError('LOCK_FAILED', 'Unable to acquire the instance lock');
  }

  const connection = db;
  let released = false;
  const handle: InstanceLockHandle = {
    dbFile,
    metadataFile,
    info: { ...info },
    update(next: InstanceLockInfo): boolean {
      if (released) return false;
      try {
        writeInstanceRow(connection, next);
        handle.info = { ...next };
        writeMetadataFile(metadataFile, next);
        return true;
      } catch {
        return false;
      }
    },
    release(): void {
      if (released) return;
      released = true;
      try {
        connection.exec('ROLLBACK;');
      } catch {
        // The transaction may already be gone (e.g. after a fatal I/O error).
      }
      try {
        connection.close();
      } catch {
        // Closing is best effort; process exit releases the OS lock anyway.
      }
      const current = readInstanceLock(metadataFile);
      if (!current || current.pid === process.pid) {
        try {
          rmSync(metadataFile, { force: true });
        } catch {
          // Metadata is cosmetic.
        }
      }
    },
  };
  writeMetadataFile(metadataFile, info);
  return handle;
}

/**
 * Health probe used by the second instance before it reports the running URL.
 * Only loopback URLs are probed.
 */
export function probeInstance(
  info: InstanceLockInfo,
  timeoutMs = 2000,
): Promise<InstanceProbeResult> {
  const url = info.url ?? `http://127.0.0.1:${info.port}`;
  const target = `${url.replace(/\/+$/, '')}/v1/health`;
  return new Promise<InstanceProbeResult>((resolvePromise) => {
    let settled = false;
    const done = (result: InstanceProbeResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let request: ReturnType<typeof httpRequest>;
    try {
      request = httpRequest(target, { method: 'GET', timeout: timeoutMs, agent: false }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          const record = isRecord(parsed) ? parsed : {};
          done({
            healthy: incoming.statusCode === 200 && record.ok === true,
            url,
            pid: typeof record.pid === 'number' ? record.pid : null,
            version: typeof record.version === 'string' ? record.version : null,
          });
        });
      });
    } catch {
      done({ healthy: false, url, pid: null, version: null });
      return;
    }
    request.on('timeout', () => {
      request.destroy();
      done({ healthy: false, url, pid: null, version: null });
    });
    request.on('error', () => done({ healthy: false, url, pid: null, version: null }));
    request.end();
  });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
