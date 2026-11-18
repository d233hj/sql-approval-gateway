import type { ErrorCode } from '@sql-approval/shared';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class VaultError extends Error {
  readonly code: 'INVALID_PASSWORD' | 'INVALID_VAULT' | 'ALREADY_CONFIGURED';

  constructor(code: 'INVALID_PASSWORD' | 'INVALID_VAULT' | 'ALREADY_CONFIGURED', message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export class StoreError extends Error {
  readonly code: 'MIGRATION_FAILED' | 'STORE_FAILED';

  constructor(code: 'MIGRATION_FAILED' | 'STORE_FAILED', message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
