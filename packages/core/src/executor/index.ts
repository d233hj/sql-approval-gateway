import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { canonicalJson } from '../util.js';
import { ExecutorError } from './errors.js';
import type {
  ExecuteOptions,
  ExecuteResult,
  ExecutorSourceConfig,
  FromWorkerMessage,
  ToWorkerMessage,
  WorkerErrorMessage,
  WorkerInitData,
} from './types.js';

/** Hard backstop after the driver-level deadline: the worker is terminated. */
const HARD_TIMEOUT_GRACE_MS = 500;
/** Grace period for a cancelled query to release its statement/connection. */
const CANCEL_GRACE_MS = 300;
const WORKER_ONLINE_TIMEOUT_MS = 5000;
/** Upper bound on how long shutdown waits for a worker thread to die. */
const TERMINATE_WAIT_MS = 5000;
const MAX_ROWS_LIMIT = 5000;

interface PendingQuery {
  id: number;
  settled: boolean;
  timer: NodeJS.Timeout | null;
  settle(outcome: { result?: ExecuteResult; error?: Error }): void;
}

interface WorkerHandle {
  key: string;
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, PendingQuery>;
  dead: boolean;
  termination: Promise<void> | null;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(), ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
    );
  });
}

function sourceKeyFor(source: ExecutorSourceConfig): string {
  if (typeof source.id === 'string' && source.id.length > 0) {
    return `${source.dialect}:${source.id}`;
  }
  let fingerprint: string;
  try {
    fingerprint = canonicalJson({ dialect: source.dialect, connection: source.connection });
  } catch {
    fingerprint = `${source.dialect}:${Date.now()}:${Math.random()}`;
  }
  return `${source.dialect}:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
}

function mapWorkerError(message: WorkerErrorMessage): ExecutorError {
  const options = {
    ...(message.dbErrorNumber === undefined ? {} : { dbErrorNumber: message.dbErrorNumber }),
    ...(message.destroyConnection ? { destroyConnection: true } : {}),
  };
  if (message.code === 'QUERY_TIMEOUT') {
    return new ExecutorError('QUERY_TIMEOUT', 'Query timed out', options);
  }
  if (message.code === 'CANCELLED') {
    return new ExecutorError('CANCELLED', 'Query was cancelled', options);
  }
  return new ExecutorError('QUERY_FAILED', 'Query failed', options);
}

async function terminateWorker(handle: WorkerHandle, graceMs: number): Promise<void> {
  await delay(graceMs);
  try {
    // A worker blocked inside native driver code cannot be preempted; the wait
    // is bounded so shutdown never hangs on such a thread.
    await raceTimeout(handle.worker.terminate(), TERMINATE_WAIT_MS);
  } catch {
    // Already gone.
  }
}

/**
 * Executes read-only queries in worker threads, one long-lived worker per
 * source so the mssql connection pool is reused across queries. Timeouts and
 * aborts terminate the worker (and therefore its connections) after a short
 * grace period; normal completion keeps the worker alive.
 */
export class Executor {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly cancelGraceMs: number;
  private nextId = 1;

  constructor(options: { cancelGraceMs?: number } = {}) {
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
  }

  get workerCount(): number {
    return this.workers.size;
  }

  get activeQueries(): number {
    let total = 0;
    for (const handle of this.workers.values()) total += handle.pending.size;
    return total;
  }

  async execute(
    source: ExecutorSourceConfig,
    sql: string,
    params: unknown,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (options.signal?.aborted) {
      throw new ExecutorError('LOCKED', 'Query was aborted before it started');
    }
    const key = sourceKeyFor(source);
    const handle = this.ensureWorker(key, source);
    try {
      await this.waitForReady(handle, options.signal);
    } catch (error) {
      this.discard(handle);
      throw error instanceof ExecutorError
        ? error
        : new ExecutorError('QUERY_FAILED', 'Executor worker failed to start');
    }
    if (handle.dead) {
      const aborted = options.signal?.aborted === true;
      throw new ExecutorError(
        aborted ? 'LOCKED' : 'QUERY_FAILED',
        aborted ? 'Query was aborted' : 'Executor worker is not available',
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    const maxRows = Math.min(Math.max(Math.trunc(options.maxRows) || 1, 1), MAX_ROWS_LIMIT);
    const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs));

    return await new Promise<ExecuteResult>((resolvePromise, rejectPromise) => {
      let onAbort: (() => void) | null = null;
      const pending: PendingQuery = {
        id,
        settled: false,
        timer: null,
        settle(outcome) {
          if (pending.settled) return;
          pending.settled = true;
          if (pending.timer) clearTimeout(pending.timer);
          pending.timer = null;
          if (onAbort && options.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          handle.pending.delete(id);
          if (outcome.error) rejectPromise(outcome.error);
          else resolvePromise(outcome.result as ExecuteResult);
        },
      };

      pending.timer = setTimeout(() => {
        if (pending.settled) return;
        // The worker did not finish within the deadline: cancel and terminate.
        this.dispose(handle);
        pending.settle({ error: new ExecutorError('QUERY_TIMEOUT', 'Query timed out') });
      }, timeoutMs + HARD_TIMEOUT_GRACE_MS);
      pending.timer.unref?.();

      onAbort = () => {
        if (pending.settled) return;
        this.dispose(handle);
        pending.settle({ error: new ExecutorError('LOCKED', 'Query was aborted') });
      };
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      handle.pending.set(id, pending);
      const message: ToWorkerMessage = {
        type: 'execute',
        id,
        sql,
        params: params ?? null,
        maxRows,
        timeoutMs,
      };
      try {
        handle.worker.postMessage(message);
      } catch {
        pending.settle({
          error: new ExecutorError('QUERY_FAILED', 'Unable to reach the executor worker'),
        });
      }
    });
  }

  /** Aborts every in-flight query (lock/shutdown) and waits for the workers. */
  async abortAll(reason: 'LOCKED' | 'CANCELLED' = 'LOCKED'): Promise<void> {
    const handles = [...this.workers.values()];
    this.workers.clear();
    for (const handle of handles) {
      handle.dead = true;
      for (const pending of handle.pending.values()) {
        try {
          handle.worker.postMessage({ type: 'cancel', id: pending.id, reason: 'aborted' });
        } catch {
          // The worker may already be gone.
        }
      }
      // Let the worker close its pools during the grace period; the terminate
      // below is the backstop.
      try {
        handle.worker.postMessage({ type: 'shutdown' });
      } catch {
        // The worker may already be gone.
      }
      for (const pending of [...handle.pending.values()]) {
        pending.settle({
          error: new ExecutorError(
            reason,
            reason === 'LOCKED' ? 'Query was aborted because the gateway locked' : 'Query was aborted',
          ),
        });
      }
      handle.termination = this.trackTermination(handle);
    }
    await Promise.all(handles.map((handle) => handle.termination ?? Promise.resolve()));
    await Promise.all([...this.retiring]);
  }

  /** Graceful shutdown: stop workers and close their connection pools. */
  async shutdown(): Promise<void> {
    const handles = [...this.workers.values()];
    this.workers.clear();
    for (const handle of handles) {
      handle.dead = true;
      try {
        handle.worker.postMessage({ type: 'shutdown' });
      } catch {
        // The worker may already be gone.
      }
      for (const pending of [...handle.pending.values()]) {
        pending.settle({ error: new ExecutorError('CANCELLED', 'Executor is shutting down') });
      }
      handle.termination = this.trackTermination(handle);
    }
    await Promise.all(handles.map((handle) => handle.termination ?? Promise.resolve()));
    await Promise.all([...this.retiring]);
  }

  /**
   * Waits for the worker to come online, but fails fast with LOCKED when the
   * query is aborted during startup (a lock can land before the worker is up).
   */
  private waitForReady(handle: WorkerHandle, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return handle.ready;
    if (signal.aborted) {
      return Promise.reject(new ExecutorError('LOCKED', 'Query was aborted'));
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        cleanup();
        rejectPromise(new ExecutorError('LOCKED', 'Query was aborted'));
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      handle.ready.then(
        () => {
          cleanup();
          resolvePromise();
        },
        (error: unknown) => {
          cleanup();
          rejectPromise(error);
        },
      );
    });
  }

  private trackTermination(handle: WorkerHandle): Promise<void> {
    const termination = terminateWorker(handle, this.cancelGraceMs);
    this.retiring.add(termination);
    void termination.finally(() => {
      this.retiring.delete(termination);
    });
    return termination;
  }

  private ensureWorker(key: string, source: ExecutorSourceConfig): WorkerHandle {
    const existing = this.workers.get(key);
    if (existing && !existing.dead) return existing;
    if (existing) this.workers.delete(key);

    const init: WorkerInitData = {
      sourceKey: key,
      dialect: source.dialect,
      // The decrypted connection (including credentials) travels only through
      // workerData, never through messages or logs.
      connection: source.connection,
    };
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: init,
      execArgv: [],
      name: `sag-executor:${source.dialect}`,
    });

    const handle: WorkerHandle = {
      key,
      worker,
      ready: Promise.resolve(),
      pending: new Map(),
      dead: false,
      termination: null,
    };

    handle.ready = new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error('executor worker did not start'));
      }, WORKER_ONLINE_TIMEOUT_MS);
      timer.unref?.();
      worker.once('online', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`executor worker exited with code ${code}`));
      });
    });
    // Nobody may be awaiting `ready` yet; keep the rejection handled.
    handle.ready.catch(() => {});

    worker.on('message', (message: FromWorkerMessage) => {
      const pending = handle.pending.get(message.id);
      if (!pending) return;
      if (message.type === 'result') {
        pending.settle({
          result: {
            columns: message.columns,
            rows: message.rows,
            truncated: message.truncated,
            durationMs: message.durationMs,
          },
        });
        return;
      }
      if (message.destroyConnection) this.dispose(handle);
      pending.settle({ error: mapWorkerError(message) });
    });

    const failAll = (error: Error) => {
      handle.dead = true;
      if (this.workers.get(key) === handle) this.workers.delete(key);
      for (const pending of [...handle.pending.values()]) pending.settle({ error });
    };
    worker.on('error', () => {
      failAll(new ExecutorError('QUERY_FAILED', 'Executor worker failed'));
    });
    worker.on('exit', () => {
      failAll(new ExecutorError('QUERY_FAILED', 'Executor worker exited'));
    });

    this.workers.set(key, handle);
    return handle;
  }

  private dispose(handle: WorkerHandle): void {
    if (handle.dead) return;
    handle.dead = true;
    if (this.workers.get(handle.key) === handle) this.workers.delete(handle.key);
    for (const pending of handle.pending.values()) {
      try {
        handle.worker.postMessage({ type: 'cancel', id: pending.id, reason: 'aborted' });
      } catch {
        // The worker may already be gone.
      }
    }
    handle.termination = this.trackTermination(handle);
  }

  private discard(handle: WorkerHandle): void {
    handle.dead = true;
    if (this.workers.get(handle.key) === handle) this.workers.delete(handle.key);
    try {
      const termination = handle.worker.terminate().then(() => undefined);
      this.retiring.add(termination);
      void termination.finally(() => {
        this.retiring.delete(termination);
      });
    } catch {
      // Already gone.
    }
  }
}

let sharedExecutor: Executor | null = null;

function shared(): Executor {
  sharedExecutor ??= new Executor();
  return sharedExecutor;
}

/**
 * Convenience entry point used by tests and non-gateway callers. The gateway
 * owns its own `Executor` so it can abort and shut down deterministically.
 */
export function executeQuery(
  sourceConfig: ExecutorSourceConfig,
  sql: string,
  params: unknown,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  return shared().execute(sourceConfig, sql, params, options);
}

export async function shutdownSharedExecutor(): Promise<void> {
  const executor = sharedExecutor;
  sharedExecutor = null;
  if (executor) await executor.shutdown();
}

export { ExecutorError } from './errors.js';
export type {
  ExecuteOptions,
  ExecuteResult,
  ExecutorErrorCode,
  ExecutorSourceConfig,
} from './types.js';
