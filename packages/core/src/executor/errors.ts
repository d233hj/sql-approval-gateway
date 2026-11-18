import type { ExecutorErrorCode } from './types.js';

/**
 * Executor failure. `message` is always a generic, secret-free description:
 * driver messages can contain SQL text or connection details and are never
 * propagated to callers or logs.
 */
export class ExecutorError extends Error {
  readonly code: ExecutorErrorCode;
  readonly dbErrorNumber: number | undefined;
  readonly destroyConnection: boolean;

  constructor(
    code: ExecutorErrorCode,
    message: string,
    options: { dbErrorNumber?: number; destroyConnection?: boolean } = {},
  ) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
    this.dbErrorNumber = options.dbErrorNumber;
    this.destroyConnection = options.destroyConnection ?? false;
  }
}

export function isExecutorError(value: unknown): value is ExecutorError {
  return value instanceof ExecutorError;
}

export function readErrnoCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function readErrorNumber(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.number === 'number') return record.number;
  if (typeof record.errno === 'number') return record.errno;
  const original = record.originalError;
  if (typeof original === 'object' && original !== null) {
    const nested = (original as Record<string, unknown>).number;
    if (typeof nested === 'number') return nested;
  }
  return undefined;
}
