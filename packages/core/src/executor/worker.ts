import { parentPort, workerData } from 'node:worker_threads';

import { ExecutorError } from './errors.js';
import { closeAllPools, executeMssqlQuery } from './mssql.js';
import { executeSqliteQuery } from './sqlite.js';
import type {
  CancelToken,
  ExecuteMessage,
  FromWorkerMessage,
  ToWorkerMessage,
  WorkerInitData,
} from './types.js';

class Token implements CancelToken {
  private flag = false;
  private readonly callbacks = new Set<() => void>();

  get cancelled(): boolean {
    return this.flag;
  }

  onCancel(callback: () => void): () => void {
    if (this.flag) {
      callback();
      return () => {};
    }
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  cancel(): void {
    if (this.flag) return;
    this.flag = true;
    for (const callback of [...this.callbacks]) {
      try {
        callback();
      } catch {
        // A failing cancel callback must not block the others.
      }
    }
    this.callbacks.clear();
  }
}

const port = parentPort;
if (!port) {
  throw new Error('executor worker requires a parent port');
}

const init = workerData as WorkerInitData;
const running = new Map<number, Token>();

function post(message: FromWorkerMessage): void {
  try {
    port!.postMessage(message);
  } catch {
    // The parent may already be gone (timeout/lock terminate).
  }
}

function toErrorMessage(id: number, error: unknown): FromWorkerMessage {
  if (error instanceof ExecutorError) {
    return {
      type: 'error',
      id,
      code: error.code === 'LOCKED' ? 'CANCELLED' : error.code,
      message: error.message,
      ...(error.dbErrorNumber === undefined ? {} : { dbErrorNumber: error.dbErrorNumber }),
      ...(error.destroyConnection ? { destroyConnection: true } : {}),
    };
  }
  return { type: 'error', id, code: 'QUERY_FAILED', message: 'Query failed' };
}

async function runExecute(message: ExecuteMessage): Promise<void> {
  const token = new Token();
  running.set(message.id, token);
  try {
    const options = {
      maxRows: message.maxRows,
      timeoutMs: message.timeoutMs,
      cancel: token,
    };
    let result;
    if (init.dialect === 'sqlite') {
      result = await executeSqliteQuery(init.connection, message.sql, message.params, options);
    } else if (init.dialect === 'mssql') {
      result = await executeMssqlQuery(
        init.sourceKey,
        init.connection,
        message.sql,
        message.params,
        options,
      );
    } else {
      throw new ExecutorError('QUERY_FAILED', 'Unsupported source dialect');
    }
    post({
      type: 'result',
      id: message.id,
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      durationMs: result.durationMs,
    });
  } catch (error) {
    post(toErrorMessage(message.id, error));
  } finally {
    running.delete(message.id);
  }
}

async function shutdown(): Promise<void> {
  await closeAllPools();
  port!.close();
}

port.on('message', (message: ToWorkerMessage) => {
  if (message.type === 'execute') {
    void runExecute(message);
    return;
  }
  if (message.type === 'cancel') {
    running.get(message.id)?.cancel();
    return;
  }
  if (message.type === 'shutdown') {
    void shutdown();
  }
});
