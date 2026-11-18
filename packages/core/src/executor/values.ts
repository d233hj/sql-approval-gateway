/**
 * Cell normalisation shared by the connectors. Values must survive
 * `postMessage` (structured clone) and `JSON.stringify` (result storage):
 * BigInt, Date and binary values are converted to portable representations.
 */
export function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    const numeric = value as number;
    return Number.isFinite(numeric) ? numeric : String(numeric);
  }
  if (type === 'bigint') {
    const big = value as bigint;
    if (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(big);
    }
    return big.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map((item) => normalizeCell(item));
  if (type === 'object') {
    // Driver-specific composite values (e.g. geography) are kept as JSON-safe
    // objects when possible; anything unserialisable is stringified by the
    // storage layer.
    return value;
  }
  return String(value);
}

export function normalizeRow(row: unknown): unknown[] {
  if (Array.isArray(row)) return row.map((cell) => normalizeCell(cell));
  if (typeof row === 'object' && row !== null) {
    return Object.values(row as Record<string, unknown>).map((cell) => normalizeCell(cell));
  }
  return [normalizeCell(row)];
}
