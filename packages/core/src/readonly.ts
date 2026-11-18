import { PROBE_CACHE_TTL_MS, type SourceTestReadonly } from '@sql-approval/shared';

import type { SourceProbeRecord } from './store.js';

/**
 * Strict read-only preflight (v0.7).
 *
 * The approval path must not execute against a source that can write. This
 * module holds the pure decision logic; the HTTP layer performs the probe and
 * the persistence, `store.ts` owns the three `sources` cache columns.
 */

/** Machine-readable failure codes returned by `POST .../approve`. */
export type SourceGuardErrorCode = 'SOURCE_PROBE_FAILED' | 'SOURCE_NOT_READONLY';

/** Audit reason written to `proposal.failed` for each failure code. */
export type SourceGuardReason = 'source_probe_failed' | 'source_not_readonly';

export interface SourceGuardFailure {
  code: SourceGuardErrorCode;
  reason: SourceGuardReason;
  /** Extra, secret-free fields for the audit detail. */
  auditDetail: Record<string, unknown>;
}

export interface CachedReadonly {
  readonly: SourceTestReadonly;
  checkedAtMs: number;
}

/** Base58-free, tolerant parse of the stored JSON `readonly_details` array. */
export function parseReadonlyDetails(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * Reads the cache only when it is complete and fresh. A missing timestamp, a
 * malformed timestamp, a `readonly_ok` of NULL or a timestamp older than
 * `ttlMs` all mean "re-probe". A future timestamp is treated as stale too, so
 * a clock that moves backwards cannot indefinitely extend a result.
 */
export function readCachedReadonly(
  record: SourceProbeRecord | null,
  nowMs: number,
  ttlMs: number = PROBE_CACHE_TTL_MS,
): CachedReadonly | null {
  if (
    record === null ||
    record.readonly_ok === null ||
    record.readonly_checked_at === null
  ) {
    return null;
  }
  const checkedAtMs = Date.parse(record.readonly_checked_at);
  if (!Number.isFinite(checkedAtMs)) return null;
  const age = nowMs - checkedAtMs;
  if (age < 0 || age > ttlMs) return null;
  return {
    readonly: {
      ok: record.readonly_ok === 1,
      checked: true,
      details: parseReadonlyDetails(record.readonly_details),
    },
    checkedAtMs,
  };
}

/** The source itself could not be reached; nothing may be executed. */
export function probeFailure(detail: Record<string, unknown> = {}): SourceGuardFailure {
  return { code: 'SOURCE_PROBE_FAILED', reason: 'source_probe_failed', auditDetail: detail };
}

/**
 * The probe completed but proved write capability. `readonly.ok` must be
 * exactly true; an unverified result fails closed.
 */
export function readonlyFailure(readonly: SourceTestReadonly): SourceGuardFailure {
  return {
    code: 'SOURCE_NOT_READONLY',
    reason: 'source_not_readonly',
    auditDetail: { readonly: { ok: readonly.ok, checked: readonly.checked } },
  };
}
