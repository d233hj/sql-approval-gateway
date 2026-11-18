import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import {
  ALLOWED_PROPOSAL_TRANSITIONS,
  DEFAULT_SETTINGS,
  POLICY_VERSION,
  SETTING_KEYS,
  type AuditVerification,
  type ClientSummary,
  type ProposalStatus,
  type ProposalSummary,
  type SourceDialect,
  type SourceSummary,
  type SourceTestReadonly,
} from '@sql-approval/shared';

import { StoreError } from './errors.js';
import {
  RESULT_MAX_TOTAL_BYTES,
  encodeResultRow,
  type ResultColumn,
} from './result.js';
import { canonicalJson, isIsoDate, sha256Hex } from './util.js';

export const SCHEMA_VERSION = 3;
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

const SOURCE_DIALECTS_SQL = "'sqlite','mssql','postgres','mysql'";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK (dialect IN (${SOURCE_DIALECTS_SQL})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  readonly_ok INTEGER,
  readonly_checked_at TEXT,
  readonly_details TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sql TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT 'null',
  purpose TEXT,
  max_rows INTEGER NOT NULL,
  timeout_s INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT,
  digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  request_key TEXT,
  UNIQUE (client_id, request_key)
);

CREATE TABLE IF NOT EXISTS result_meta (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  columns_json TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  freshness TEXT,
  executed_at TEXT NOT NULL,
  duration_ms INTEGER,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_rows (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (proposal_id, row_index)
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  proposal_id TEXT,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status_created
  ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_client_created
  ON proposals(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_expires
  ON proposals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_at
  ON audit(at);
CREATE INDEX IF NOT EXISTS idx_sources_name
  ON sources(name);
`;

export interface StoreOptions {
  now?: () => number;
  proposalTtlMs?: number;
  resultTtlMs?: number;
}

export interface CreateProposalInput {
  clientId: string;
  sourceId: string;
  sql: string;
  params?: unknown;
  purpose?: string | null;
  maxRows: number;
  timeoutS: number;
  requestKey?: string | null;
  digest: string;
  policyVersion?: string;
  /** Approval window override; defaults to the store-level proposal TTL. */
  ttlMs?: number;
}

export interface ResultMetaRecord {
  proposal_id: string;
  columns_json: string;
  total_rows: number;
  truncated: number;
  freshness: string | null;
  executed_at: string;
  duration_ms: number | null;
  expires_at: string;
}

export interface SaveResultInput {
  proposalId: string;
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
  nowMs?: number;
  /** Result TTL override; defaults to the store-level result TTL. */
  ttlMs?: number;
}

export interface SaveResultOutcome {
  totalRows: number;
  truncated: boolean;
  bytes: number;
}

export interface StoredResultRow {
  row_index: number;
  row_json: string;
}

/**
 * Persisted read-only probe result for one source (schema v3). All three
 * columns are NULL until `POST /sources/{id}/test` succeeds once, so an
 * upgraded installation never inherits an unverified `readonly_ok`.
 */
export interface SourceProbeRecord {
  readonly_ok: number | null;
  readonly_checked_at: string | null;
  readonly_details: string | null;
}

export interface ClientRecord extends ClientSummary {
  token_hash: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  proposal_id: string | null;
  detail_json: string;
  prev_hash: string;
  hash: string;
}

interface ProposalRow {
  id: string;
  client_id: string;
  source_id: string;
  sql: string;
  params_json: string;
  purpose: string | null;
  max_rows: number;
  timeout_s: number;
  status: string;
  status_message: string | null;
  digest: string;
  policy_version: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  request_key: string | null;
}

export function openStore(file: string, options: StoreOptions = {}): Store {
  const memory = file === ':memory:';
  if (!memory) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  let priorVersion = 0;
  if (!memory && existsSync(file)) {
    try {
      priorVersion = readUserVersion(file);
    } catch {
      throw new StoreError('MIGRATION_FAILED', 'control.db is not a readable SQLite database');
    }
    if (priorVersion > SCHEMA_VERSION) {
      throw new StoreError(
        'MIGRATION_FAILED',
        `control.db schema version ${priorVersion} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (priorVersion < SCHEMA_VERSION) {
      copyFileSync(file, `${file}.bak-${priorVersion}`);
    }
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { timeout: 5000 });
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    migrate(db, priorVersion);
    if (!memory) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort on platforms/filesystems without POSIX modes.
      }
    }
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The connection may never have opened; preserve the migration error.
    }
    if (error instanceof StoreError) throw error;
    throw new StoreError('MIGRATION_FAILED', 'Database migration failed');
  }

  if (!db) throw new StoreError('MIGRATION_FAILED', 'Database migration failed');
  return new Store(db, options);
}

function readUserVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    const value = row?.user_version;
    return typeof value === 'number' ? value : Number(value ?? 0);
  } finally {
    db.close();
  }
}

function migrate(db: DatabaseSync, priorVersion: number): void {
  const current = readUserVersionFromDb(db);
  if (current > SCHEMA_VERSION) {
    throw new StoreError('MIGRATION_FAILED', 'Database schema is newer than the application');
  }
  if (current === SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA_SQL);
    ensureSourceProbeColumns(db);
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    // Batch-A settings are seeded on every migration step; INSERT OR IGNORE
    // keeps values an existing installation already customized.
    const seedSetting = db.prepare(
      'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)',
    );
    for (const key of SETTING_KEYS) {
      seedSetting.run(key, JSON.stringify(DEFAULT_SETTINGS[key]));
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure; the original error is more useful.
    }
    throw error;
  }
  if (priorVersion !== 0) {
    // Migration succeeded; the pre-migration copy remains alongside the database.
  }
}

function readUserVersionFromDb(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : Number(row?.user_version ?? 0);
}

/**
 * Schema v3 adds the read-only probe cache to an existing `sources` table.
 * `CREATE TABLE IF NOT EXISTS` cannot add columns, so every missing column is
 * added explicitly; an old database therefore upgrades in place with NULL
 * values (nothing is ever assumed read-only).
 */
function ensureSourceProbeColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(sources)').all() as Array<Record<string, unknown>>).map((row) =>
      String(row.name),
    ),
  );
  const additions: Array<[string, string]> = [
    ['readonly_ok', 'INTEGER'],
    ['readonly_checked_at', 'TEXT'],
    ['readonly_details', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
  }
}

export class Store {
  readonly db: DatabaseSync;
  private readonly nowFn: () => number;
  readonly proposalTtlMs: number;
  readonly resultTtlMs: number;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db;
    this.nowFn = options.now ?? Date.now;
    this.proposalTtlMs = options.proposalTtlMs ?? 24 * 60 * 60 * 1000;
    this.resultTtlMs = options.resultTtlMs ?? 24 * 60 * 60 * 1000;
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return this.nowFn();
  }

  isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  // --------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row.value) : null;
  }

  /** Raw `key -> JSON text` map; callers apply the shared settings contract. */
  listSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[String(row.key)] = String(row.value);
    return result;
  }

  /**
   * Upserts the changed settings and writes exactly one `settings.update`
   * audit entry inside the same transaction. The detail records key names
   * only, never values.
   */
  updateSettings(
    entries: Record<string, string>,
    actor: string,
    nowMs = this.now(),
  ): string[] {
    const keys = Object.keys(entries).sort();
    if (keys.length === 0) return keys;
    this.withTransaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      for (const key of keys) upsert.run(key, entries[key]!);
      this.insertAudit({
        actor,
        action: 'settings.update',
        detail: { keys },
        nowMs,
      });
    });
    return keys;
  }

  // ---------------------------------------------------------------- sources

  insertSource(source: SourceSummary): void {
    const at = this.isoNow();
    this.db
      .prepare(
        `INSERT INTO sources (id, name, dialect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(source.id, source.name, source.dialect, at, at);
  }

  /** Partial metadata update; returns null when the source no longer exists. */
  updateSource(
    id: string,
    patch: { name?: string; dialect?: SourceDialect },
  ): SourceSummary | null {
    const current = this.getSource(id);
    if (!current) return null;
    const next: SourceSummary = {
      id: current.id,
      name: patch.name ?? current.name,
      dialect: patch.dialect ?? current.dialect,
    };
    this.db
      .prepare('UPDATE sources SET name = ?, dialect = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.dialect, this.isoNow(), id);
    return next;
  }

  deleteSource(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  getSource(id: string): SourceSummary | null {
    const row = this.db
      .prepare('SELECT id, name, dialect FROM sources WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapSource(row) : null;
  }

  listSources(): SourceSummary[] {
    const rows = this.db
      .prepare('SELECT id, name, dialect FROM sources ORDER BY name, id')
      .all() as Record<string, unknown>[];
    return rows.map(mapSource);
  }

  /**
   * Reads the persisted read-only probe cache. Returns null for an unknown
   * source or for a source that was never successfully tested.
   */
  getSourceProbe(id: string): SourceProbeRecord | null {
    const row = this.db
      .prepare(
        'SELECT readonly_ok, readonly_checked_at, readonly_details FROM sources WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      readonly_ok: row.readonly_ok === null ? null : Number(row.readonly_ok),
      readonly_checked_at:
        row.readonly_checked_at === null ? null : String(row.readonly_checked_at),
      readonly_details: row.readonly_details === null ? null : String(row.readonly_details),
    };
  }

  /**
   * Persists a successful probe result. `readonly_details` is stored as a JSON
   * array of already-sanitized strings; no connection data is accepted here.
   */
  saveSourceProbe(
    id: string,
    readonly: SourceTestReadonly,
    nowMs = this.now(),
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE sources
         SET readonly_ok = ?, readonly_checked_at = ?, readonly_details = ?
         WHERE id = ?`,
      )
      .run(
        readonly.ok ? 1 : 0,
        new Date(nowMs).toISOString(),
        JSON.stringify(readonly.details),
        id,
      );
    return Number(result.changes) > 0;
  }

  /**
   * Drops the cache after a failed probe, so the next approval performs a live
   * probe instead of trusting a result that may predate a permission change.
   */
  clearSourceProbe(id: string): void {
    this.db
      .prepare(
        `UPDATE sources
         SET readonly_ok = NULL, readonly_checked_at = NULL, readonly_details = NULL
         WHERE id = ?`,
      )
      .run(id);
  }

  // ---------------------------------------------------------------- clients

  upsertClient(id: string, name: string, tokenHash: string): void {
    const at = this.isoNow();
    this.db
      .prepare(
        `INSERT INTO clients (id, name, token_hash, created_at, last_used_at, disabled)
         VALUES (?, ?, ?, ?, NULL, 0)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           token_hash = excluded.token_hash,
           disabled = 0`,
      )
      .run(id, name, tokenHash, at);
  }

  findClientByTokenHash(tokenHash: string): ClientRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, token_hash, created_at, last_used_at, disabled
         FROM clients WHERE token_hash = ? AND disabled = 0`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...mapClient(row),
      token_hash: String(row.token_hash),
    };
  }

  getClient(id: string): ClientSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, name, created_at, last_used_at, disabled
         FROM clients WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapClient(row) : null;
  }

  /**
   * Creates one agent client and writes the `client.create` audit entry in the
   * same transaction. Only the SHA-256 hash of the token is accepted here; the
   * plaintext token is returned to the caller exactly once by the HTTP layer.
   */
  createClient(
    name: string,
    tokenHash: string,
    actor = 'admin',
    nowMs = this.now(),
  ): ClientSummary {
    const id = randomUUID();
    const createdAt = new Date(nowMs).toISOString();
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO clients (id, name, token_hash, created_at, last_used_at, disabled)
           VALUES (?, ?, ?, ?, NULL, 0)`,
        )
        .run(id, name, tokenHash, createdAt);
      this.insertAudit({
        actor,
        action: 'client.create',
        detail: { client_id: id, name },
        nowMs,
      });
    });
    return { id, name, created_at: createdAt, last_used_at: null, disabled: 0 };
  }

  /**
   * Revokes an agent client by disabling it (the row, and with it the proposal
   * history, is kept). Idempotent: revoking an already disabled client reports
   * success but writes no duplicate audit entry. Returns false when the client
   * does not exist.
   */
  revokeClient(id: string, actor = 'admin', nowMs = this.now()): boolean {
    return this.withTransaction(() => {
      const client = this.getClient(id);
      if (!client) return false;
      const result = this.db
        .prepare('UPDATE clients SET disabled = 1 WHERE id = ? AND disabled = 0')
        .run(id);
      if (Number(result.changes) === 1) {
        this.insertAudit({
          actor,
          action: 'client.revoke',
          detail: { client_id: id, name: client.name },
          nowMs,
        });
      }
      return true;
    });
  }

  touchClient(id: string, minimumIntervalMs = 5 * 60 * 1000): void {
    const at = this.isoNow();
    const cutoff = new Date(this.now() - minimumIntervalMs).toISOString();
    this.db
      .prepare(
        `UPDATE clients SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      )
      .run(at, id, cutoff);
  }

  listClients(): ClientSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, created_at, last_used_at, disabled
         FROM clients ORDER BY created_at, id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapClient);
  }

  // -------------------------------------------------------------- proposals

  createProposal(input: CreateProposalInput): ProposalSummary {
    if (input.requestKey) {
      const existing = this.getProposalByRequestKey(input.clientId, input.requestKey);
      if (existing) return existing;
    }
    const at = this.isoNow();
    const expiresAt = new Date(this.now() + (input.ttlMs ?? this.proposalTtlMs)).toISOString();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO proposals (
             id, client_id, source_id, sql, params_json, purpose, max_rows, timeout_s,
             status, status_message, digest, policy_version, created_at, updated_at,
             expires_at, request_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.clientId,
          input.sourceId,
          input.sql,
          JSON.stringify(input.params ?? null),
          input.purpose ?? null,
          input.maxRows,
          input.timeoutS,
          input.digest,
          input.policyVersion ?? POLICY_VERSION,
          at,
          at,
          expiresAt,
          input.requestKey ?? null,
        );
    } catch (error) {
      if (input.requestKey) {
        const existing = this.getProposalByRequestKey(input.clientId, input.requestKey);
        if (existing) return existing;
      }
      throw error;
    }
    const created = this.getProposal(id);
    if (!created) throw new StoreError('STORE_FAILED', 'Failed to read created proposal');
    return created;
  }

  getProposal(id: string): ProposalSummary | null {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(id) as ProposalRow | undefined;
    return row ? mapProposal(row) : null;
  }

  getProposalForClient(id: string, clientId: string): ProposalSummary | null {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE id = ? AND client_id = ?')
      .get(id, clientId) as ProposalRow | undefined;
    return row ? mapProposal(row) : null;
  }

  getProposalByRequestKey(clientId: string, requestKey: string): ProposalSummary | null {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE client_id = ? AND request_key = ?')
      .get(clientId, requestKey) as ProposalRow | undefined;
    return row ? mapProposal(row) : null;
  }

  listProposals(options: {
    status?: ProposalStatus;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): ProposalSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.status) {
      clauses.push('status = ?');
      parameters.push(options.status);
    }
    if (options.query) {
      clauses.push('(sql LIKE ? OR purpose LIKE ?)');
      const like = `%${options.query}%`;
      parameters.push(like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    parameters.push(limit, offset);
    const rows = this.db
      .prepare(`SELECT * FROM proposals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...parameters) as unknown as ProposalRow[];
    return rows.map(mapProposal);
  }

  expirePending(nowMs = this.now()): number {
    const result = this.db
      .prepare(
        `UPDATE proposals SET status = 'EXPIRED', updated_at = ?
         WHERE status = 'PENDING_APPROVAL' AND expires_at <= ?`,
      )
      .run(new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
    return Number(result.changes);
  }

  /**
   * Pending proposals that `expirePending(nowMs)` is about to close, with the
   * source id needed for the live-update payload. Read it *before* expiring so
   * the caller can announce only the rows that actually changed.
   */
  listExpiringPending(nowMs = this.now()): { id: string; sourceId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_id FROM proposals
         WHERE status = 'PENDING_APPROVAL' AND expires_at <= ?`,
      )
      .all(new Date(nowMs).toISOString()) as { id: string; source_id: string }[];
    return rows.map((row) => ({ id: String(row.id), sourceId: String(row.source_id) }));
  }

  recoverInterrupted(nowMs = this.now()): number {
    const result = this.db
      .prepare(
        `UPDATE proposals
         SET status = 'FAILED', status_message = 'interrupted', updated_at = ?
         WHERE status IN ('APPROVED', 'EXECUTING')`,
      )
      .run(new Date(nowMs).toISOString());
    return Number(result.changes);
  }

  /**
   * Atomic approval. The conditional WHERE is the concurrency guard: exactly
   * one caller can observe changes === 1 for a PENDING_APPROVAL proposal.
   */
  approveProposal(id: string, actor: string, nowMs = this.now()): boolean {
    this.expirePending(nowMs);
    return this.withTransaction(() => {
      const now = new Date(nowMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE proposals SET status = 'APPROVED', updated_at = ?
           WHERE id = ? AND status = 'PENDING_APPROVAL'`,
        )
        .run(now, id);
      if (Number(result.changes) !== 1) return false;
      this.insertAudit({
        actor,
        action: 'proposal.approve',
        proposalId: id,
        detail: {},
        nowMs,
      });
      return true;
    });
  }

  rejectProposal(id: string, reason: string | null, actor: string, nowMs = this.now()): boolean {
    return this.withTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE proposals
           SET status = 'REJECTED', status_message = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING_APPROVAL'`,
        )
        .run(reason ?? 'rejected', new Date(nowMs).toISOString(), id);
      if (Number(result.changes) !== 1) return false;
      this.insertAudit({
        actor,
        action: 'proposal.reject',
        proposalId: id,
        detail: reason ? { reason } : {},
        nowMs,
      });
      return true;
    });
  }

  cancelProposal(id: string, clientId: string, actor: string, nowMs = this.now()): boolean {
    return this.withTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE proposals
           SET status = 'CANCELLED', status_message = 'cancelled', updated_at = ?
           WHERE id = ? AND client_id = ? AND status = 'PENDING_APPROVAL'`,
        )
        .run(new Date(nowMs).toISOString(), id, clientId);
      if (Number(result.changes) !== 1) return false;
      this.insertAudit({
        actor,
        action: 'proposal.cancel',
        proposalId: id,
        detail: {},
        nowMs,
      });
      return true;
    });
  }

  /** Conditional transition used by the executor and by tests. */
  transitionProposal(
    id: string,
    from: ProposalStatus,
    to: ProposalStatus,
    statusMessage: string | null = null,
    nowMs = this.now(),
  ): boolean {
    if (!ALLOWED_PROPOSAL_TRANSITIONS[from].includes(to)) return false;
    const result = this.db
      .prepare(
        `UPDATE proposals SET status = ?, status_message = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(to, statusMessage, new Date(nowMs).toISOString(), id, from);
    return Number(result.changes) === 1;
  }

  /**
   * Terminal failure that is not an approval decision (policy re-check failed,
   * source missing, lock/interrupted execution). Uses the shared transition
   * table (which allows PENDING_APPROVAL → FAILED) and writes one audit event
   * with the machine-readable reason.
   */
  failProposal(
    id: string,
    from: ProposalStatus,
    reason: string,
    actor = 'system',
    nowMs = this.now(),
    detail: Record<string, unknown> = {},
  ): boolean {
    return this.withTransaction(() => {
      if (!this.transitionProposal(id, from, 'FAILED', reason, nowMs)) return false;
      this.insertAudit({
        actor,
        action: 'proposal.failed',
        proposalId: id,
        detail: { reason, ...detail },
        nowMs,
      });
      return true;
    });
  }

  // ----------------------------------------------------------------- results

  /**
   * Persists one proposal result. Rows larger than 64 KB are replaced by a
   * truncation marker; the total payload is capped at 8 MB.
   *
   * `expires_at` is the authoritative TTL anchor and is always derived from
   * `executed_at` (`expires_at = executed_at + ttl`; the HTTP layer passes the
   * current `result.ttl_hours` setting, 24 h falls back at store level).
   * Cleanup and the rows API compare against `expires_at` only.
   */
  saveResult(input: SaveResultInput): SaveResultOutcome {
    const now = input.nowMs ?? this.now();
    const executedAt = new Date(now).toISOString();
    const expiresAt = new Date(
      Date.parse(executedAt) + (input.ttlMs ?? this.resultTtlMs),
    ).toISOString();
    const encoded: string[] = [];
    let bytes = 0;
    let truncated = input.truncated;
    for (const row of input.rows) {
      const item = encodeResultRow(row);
      if (bytes + item.bytes > RESULT_MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      encoded.push(item.json);
      bytes += item.bytes;
    }

    this.withTransaction(() => {
      this.db.prepare('DELETE FROM result_rows WHERE proposal_id = ?').run(input.proposalId);
      this.db.prepare('DELETE FROM result_meta WHERE proposal_id = ?').run(input.proposalId);
      this.db
        .prepare(
          `INSERT INTO result_meta (
             proposal_id, columns_json, total_rows, truncated, freshness,
             executed_at, duration_ms, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.proposalId,
          JSON.stringify(input.columns),
          encoded.length,
          truncated ? 1 : 0,
          executedAt,
          executedAt,
          Math.max(0, Math.trunc(input.durationMs)),
          expiresAt,
        );
      const insert = this.db.prepare(
        'INSERT INTO result_rows (proposal_id, row_index, row_json) VALUES (?, ?, ?)',
      );
      encoded.forEach((json, index) => {
        insert.run(input.proposalId, index, json);
      });
    });

    return { totalRows: encoded.length, truncated, bytes };
  }

  getResultMeta(proposalId: string): ResultMetaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM result_meta WHERE proposal_id = ?')
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      proposal_id: String(row.proposal_id),
      columns_json: String(row.columns_json),
      total_rows: Number(row.total_rows),
      truncated: Number(row.truncated),
      freshness: row.freshness === null ? null : String(row.freshness),
      executed_at: String(row.executed_at),
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
      expires_at: String(row.expires_at),
    };
  }

  getResultRows(proposalId: string, offset = 0, limit = 100): StoredResultRow[] {
    return this.db
      .prepare(
        `SELECT row_index, row_json FROM result_rows
         WHERE proposal_id = ? ORDER BY row_index ASC LIMIT ? OFFSET ?`,
      )
      .all(
        proposalId,
        Math.min(Math.max(Math.trunc(limit), 1), 500),
        Math.max(Math.trunc(offset), 0),
      ) as unknown as StoredResultRow[];
  }

  deleteResult(proposalId: string): boolean {
    const result = this.db.prepare('DELETE FROM result_meta WHERE proposal_id = ?').run(proposalId);
    this.db
      .prepare(
        'DELETE FROM result_rows WHERE proposal_id = ? AND proposal_id NOT IN (SELECT proposal_id FROM result_meta)',
      )
      .run(proposalId);
    return Number(result.changes) > 0;
  }

  /** TTL cleanup, run at startup and hourly. Returns the number of results removed. */
  deleteExpiredResults(nowMs = this.now()): number {
    const cutoff = new Date(nowMs).toISOString();
    return this.withTransaction(() => {
      const result = this.db
        .prepare('DELETE FROM result_meta WHERE expires_at <= ?')
        .run(cutoff);
      this.db
        .prepare(
          'DELETE FROM result_rows WHERE proposal_id NOT IN (SELECT proposal_id FROM result_meta)',
        )
        .run();
      return Number(result.changes);
    });
  }

  // ----------------------------------------------------------------- audit

  appendAudit(input: {
    actor: string;
    action: string;
    proposalId?: string | null;
    detail?: Record<string, unknown>;
    nowMs?: number;
  }): number {
    return this.withTransaction(() => this.insertAudit(input));
  }

  private insertAudit(input: {
    actor: string;
    action: string;
    proposalId?: string | null;
    detail?: Record<string, unknown>;
    nowMs?: number;
  }): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit')
      .get() as Record<string, unknown>;
    const seq = Number(row.max_seq) + 1;
    const at = new Date(input.nowMs ?? this.now()).toISOString();
    const detail = input.detail ?? {};
    const proposalId = input.proposalId ?? null;
    const previous = this.db
      .prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    const prevHash = previous ? String(previous.hash) : AUDIT_GENESIS_HASH;
    const record = {
      seq,
      at,
      actor: input.actor,
      action: input.action,
      proposal_id: proposalId,
      detail,
    };
    const hash = sha256Hex(`${prevHash}${canonicalJson(record)}`);
    this.db
      .prepare(
        `INSERT INTO audit (seq, at, actor, action, proposal_id, detail_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seq,
        at,
        input.actor,
        input.action,
        proposalId,
        canonicalJson(detail),
        prevHash,
        hash,
      );
    return seq;
  }

  verifyAuditChain(): AuditVerification {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq ASC').all() as unknown as AuditEntry[];
    let prevHash = AUDIT_GENESIS_HASH;
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq || row.prev_hash !== prevHash) {
        return { valid: false, checked: expectedSeq - 1, broken_at: row.seq };
      }
      let detail: unknown;
      try {
        detail = JSON.parse(row.detail_json);
      } catch {
        return { valid: false, checked: expectedSeq - 1, broken_at: row.seq };
      }
      const record = {
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        action: row.action,
        proposal_id: row.proposal_id,
        detail,
      };
      const expected = sha256Hex(`${prevHash}${canonicalJson(record)}`);
      if (expected !== row.hash) {
        return { valid: false, checked: expectedSeq - 1, broken_at: row.seq };
      }
      prevHash = row.hash;
      expectedSeq += 1;
    }
    return { valid: true, checked: rows.length };
  }

  listAudit(after = 0, limit = 200): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(after, Math.min(Math.max(limit, 1), 1000)) as unknown as AuditEntry[];
  }

  // ---------------------------------------------------------------- helpers

  withTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }
}

function mapSource(row: Record<string, unknown>): SourceSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    dialect: String(row.dialect) as SourceDialect,
  };
}

function mapClient(row: Record<string, unknown>): ClientSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    created_at: String(row.created_at),
    last_used_at: row.last_used_at === null ? null : String(row.last_used_at),
    disabled: Number(row.disabled),
  };
}

function mapProposal(row: ProposalRow): ProposalSummary {
  let params: unknown = null;
  try {
    params = JSON.parse(row.params_json);
  } catch {
    params = null;
  }
  const status = String(row.status) as ProposalStatus;
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    source_id: String(row.source_id),
    sql: String(row.sql),
    params,
    purpose: row.purpose === null ? null : String(row.purpose),
    max_rows: Number(row.max_rows),
    timeout_s: Number(row.timeout_s),
    status,
    status_message: row.status_message === null ? null : String(row.status_message),
    digest: String(row.digest),
    policy_version: String(row.policy_version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    expires_at: String(row.expires_at),
    request_key: row.request_key === null ? null : String(row.request_key),
  };
}

export function isUnexpiredProposal(proposal: ProposalSummary, nowMs = Date.now()): boolean {
  return isIsoDate(proposal.expires_at) && Date.parse(proposal.expires_at) > nowMs;
}
