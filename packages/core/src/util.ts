import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function safeEqualHex(a: string, b: string): boolean {
  return safeEqualString(a, b);
}

/**
 * Deterministic JSON used by digests and the audit hash chain.
 * Object keys are sorted recursively; undefined object values are omitted.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('circular value');
    seen.add(value);
    const out = value.map((item) => (item === undefined ? null : canonicalize(item, seen)));
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) throw new TypeError('circular value');
    seen.add(value);
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item, seen);
    }
    seen.delete(value);
    return out;
  }
  return null;
}

export function isoNow(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
