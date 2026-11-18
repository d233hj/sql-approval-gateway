/**
 * Result storage rules shared by the executor and the store.
 *
 * DESIGN §5/§7.2: a single row larger than 64 KB is truncated and marked, a
 * single proposal keeps at most 8 MB of rows, and results expire 24 h after
 * execution.
 */

export const RESULT_MAX_ROW_BYTES = 64 * 1024;
export const RESULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const RESULT_PAGE_DEFAULT_SIZE = 100;
export const RESULT_PAGE_MAX_SIZE = 500;

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

export interface EncodedResultRow {
  json: string;
  bytes: number;
  truncated: boolean;
}

function stringify(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

/**
 * Serialises one row for `result_rows.row_json`. Oversized rows are replaced
 * by a self-describing marker (valid JSON) that keeps the original size and a
 * short preview, so a client can tell truncation from real data.
 */
export function encodeResultRow(row: unknown): EncodedResultRow {
  const json = stringify(row);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= RESULT_MAX_ROW_BYTES) return { json, bytes, truncated: false };
  const marker = stringify({
    __truncated: true,
    original_bytes: bytes,
    preview: json.slice(0, 1024),
  });
  return { json: marker, bytes: Buffer.byteLength(marker, 'utf8'), truncated: true };
}

export function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isOversizedRowMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__truncated === true
  );
}
