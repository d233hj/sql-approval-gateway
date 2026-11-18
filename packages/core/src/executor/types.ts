import type { SourceDialect } from '@sql-approval/shared';

import type { ResultColumn } from '../result.js';

/** A decrypted source configuration. Secrets must never be logged or echoed. */
export interface ExecutorSourceConfig {
  /** Stable id used to key the worker and (for mssql) the connection pool. */
  id?: string;
  dialect: SourceDialect;
  connection: Record<string, unknown>;
}

export interface ExecuteOptions {
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
}

export type ExecutorErrorCode =
  | 'QUERY_TIMEOUT'
  | 'QUERY_FAILED'
  | 'CANCELLED'
  | 'LOCKED';

export interface CancelToken {
  readonly cancelled: boolean;
  /** Registers a callback invoked when the token is cancelled. */
  onCancel(callback: () => void): () => void;
}

export interface ConnectorOptions {
  maxRows: number;
  timeoutMs: number;
  cancel: CancelToken;
}

export interface ConnectorResult {
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
}

// ------------------------------------------------------------------ protocol

export interface WorkerInitData {
  sourceKey: string;
  dialect: SourceDialect;
  /** Decrypted connection settings; transported only through workerData. */
  connection: Record<string, unknown>;
}

export interface ExecuteMessage {
  type: 'execute';
  id: number;
  sql: string;
  params: unknown;
  maxRows: number;
  timeoutMs: number;
}

export interface CancelMessage {
  type: 'cancel';
  id: number;
  reason: 'timeout' | 'aborted' | 'shutdown';
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type ToWorkerMessage = ExecuteMessage | CancelMessage | ShutdownMessage;

export interface ResultMessage {
  type: 'result';
  id: number;
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
}

export type WorkerErrorCode = 'QUERY_TIMEOUT' | 'QUERY_FAILED' | 'CANCELLED';

export interface WorkerErrorMessage {
  type: 'error';
  id: number;
  code: WorkerErrorCode;
  /** Generic, secret-free description; never the raw driver message. */
  message: string;
  dbErrorNumber?: number;
  /** True when the driver connection must be discarded. */
  destroyConnection?: boolean;
}

export type FromWorkerMessage = ResultMessage | WorkerErrorMessage;
