/** Formatting helpers shared by the list, detail and result table. */

import { STATUS_LABELS, type ProposalStatus } from './types.js';

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const diff = time - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '后' : '前';
  if (abs < 45_000) return '刚刚';
  if (abs < 60 * 60_000) return `${Math.max(1, Math.round(abs / 60_000))} 分钟${suffix}`;
  if (abs < 36 * 60 * 60_000) return `${Math.round(abs / (60 * 60_000))} 小时${suffix}`;
  if (abs < 30 * 24 * 60 * 60_000) return `${Math.round(abs / (24 * 60 * 60_000))} 天${suffix}`;
  return formatDateTime(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** Header idle countdown: `mm:ss`, or `h:mm:ss` for very long windows. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatInteger(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
}

export function statusLabel(status: ProposalStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export function sqlPreview(sql: string, maxLength = 140): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

/** Pretty JSON for the params panel; returns null when there is nothing to show. */
export function formatParams(params: unknown): string | null {
  if (params === null || params === undefined) return null;
  if (typeof params === 'string') return params.length > 0 ? params : null;
  if (Array.isArray(params) && params.length === 0) return null;
  try {
    const text = JSON.stringify(params, null, 2);
    if (text === undefined || text === '{}' || text === 'null') return null;
    return text;
  } catch {
    return String(params);
  }
}

export interface CellDisplay {
  text: string;
  kind: 'null' | 'empty' | 'string' | 'number' | 'boolean' | 'json';
}

export function formatCell(value: unknown): CellDisplay {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' };
  if (typeof value === 'string') {
    return value.length === 0
      ? { text: '（空字符串）', kind: 'empty' }
      : { text: value, kind: 'string' };
  }
  if (typeof value === 'number') return { text: String(value), kind: 'number' };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'boolean' };
  try {
    return { text: JSON.stringify(value, null, 2) ?? String(value), kind: 'json' };
  } catch {
    return { text: String(value), kind: 'json' };
  }
}

export function isOversizedRowMarker(
  value: unknown,
): value is { __truncated: true; original_bytes?: number; preview?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__truncated === true
  );
}

export function isPendingExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now;
}
