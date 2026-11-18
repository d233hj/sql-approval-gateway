import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../src/config.js';
import { Gateway, silentLogger } from '../src/http.js';
import {
  INSTANCE_LOCK_FILENAME,
  InstanceLockError,
  acquireInstanceLock,
  isProcessAlive,
  probeInstance,
  readInstanceLock,
  type InstanceLockInfo,
} from '../src/instance.js';
import { startTestGateway } from './helpers.js';

const CORE_CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sag-instance-test-'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Spawns a real core process; stdio is ignored (the sandbox forbids pipes). */
function spawnCore(dir: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, [CORE_CLI, '--data-dir', dir, '--port', '0'], {
    stdio: 'ignore',
    env,
  });
}

/** A pid that is guaranteed to be dead: a child that already exited. */
function deadPid(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('error', rejectPromise);
    child.on('exit', () => {
      if (typeof pid === 'number') resolvePromise(pid);
      else rejectPromise(new Error('child pid unavailable'));
    });
  });
}

/** Waits for children to die and retries the Windows file-handle release. */
async function removeDirAfterChildren(dir: string, children: ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolvePromise();
            return;
          }
          child.once('exit', () => resolvePromise());
          setTimeout(resolvePromise, 3000).unref?.();
        }),
    ),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(100);
    }
  }
}

function countReady(barrierDir: string): number {
  try {
    return readdirSync(barrierDir).filter((name) => name.startsWith('ready.')).length;
  } catch {
    return 0;
  }
}

/** Preload module: announce readiness, then wait for the shared "go" file. */
function writeBarrierModule(barrierDir: string): string {
  const file = join(barrierDir, 'barrier.mjs');
  writeFileSync(
    file,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const dir = process.env.SAG_TEST_BARRIER_DIR;',
      'const id = process.env.SAG_TEST_BARRIER_ID;',
      "writeFileSync(dir + '/ready.' + id, '1');",
      'const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'const deadline = Date.now() + 30000;',
      "while (!existsSync(dir + '/go')) {",
      '  if (Date.now() > deadline) process.exit(98);',
      '  wait(2);',
      '}',
      '',
    ].join('\n'),
  );
  return file;
}

test('the instance mutex is a SQLite exclusive lock and metadata is human-readable', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbFile = join(dir, 'instance-lock.db');
  const startedAt = new Date().toISOString();

  const first = acquireInstanceLock(dbFile, {
    pid: process.pid,
    port: 1234,
    startedAt,
    version: '0.1.0',
  });
  assert.equal(first.info.port, 1234);
  assert.equal(existsSync(dbFile), true);
  assert.deepEqual(readInstanceLock(join(dir, INSTANCE_LOCK_FILENAME)), {
    pid: process.pid,
    port: 1234,
    startedAt,
    version: '0.1.0',
  });

  // A second connection (same process) must be refused by SQLite.
  assert.throws(
    () => acquireInstanceLock(dbFile, { pid: process.pid, port: 4321, startedAt }),
    (error: unknown) => {
      assert.ok(error instanceof InstanceLockError);
      assert.equal(error.code, 'ALREADY_RUNNING');
      assert.equal(error.exitCode, 3);
      assert.equal(error.existing?.pid, process.pid);
      assert.equal(error.existing?.port, 1234);
      return true;
    },
  );

  assert.equal(
    first.update({
      pid: process.pid,
      port: 5555,
      startedAt,
      url: 'http://127.0.0.1:5555',
      version: '0.1.0',
    }),
    true,
  );
  assert.equal(readInstanceLock(join(dir, INSTANCE_LOCK_FILENAME))?.port, 5555);

  first.release();
  assert.equal(existsSync(join(dir, INSTANCE_LOCK_FILENAME)), false);
  assert.equal(existsSync(dbFile), true, 'the lock database stays for the next start');

  // Released: the next owner can take it immediately.
  const second = acquireInstanceLock(dbFile, { pid: process.pid, port: 6666, startedAt });
  second.release();
});

test('a gateway refuses to start while a live instance holds the SQLite lock', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({}, { dataDir: dir, port: 0 });
  const holder = acquireInstanceLock(config.instanceLockDbPath, {
    pid: process.pid,
    port: 1,
    startedAt: new Date().toISOString(),
  });
  try {
    assert.throws(
      () => new Gateway({ config, logger: silentLogger, agentTokenFromEnv: null }),
      (error: unknown) => {
        assert.ok(error instanceof InstanceLockError);
        assert.equal(error.code, 'ALREADY_RUNNING');
        assert.equal(error.exitCode, 3);
        return true;
      },
    );
  } finally {
    holder.release();
  }

  // Released: the gateway starts, publishes its real port and releases on stop.
  const gateway = new Gateway({ config, logger: silentLogger, agentTokenFromEnv: null });
  try {
    const started = await gateway.start();
    const metadata = readInstanceLock(config.instanceLockPath);
    assert.ok(metadata);
    assert.equal(metadata!.pid, process.pid);
    assert.equal(metadata!.port, Number(new URL(started.url).port));
    assert.equal(metadata!.url, started.url);
    assert.equal(typeof metadata!.startedAt, 'string');
    assert.equal(existsSync(config.instanceLockDbPath), true);
    assert.equal(existsSync(config.endpointPath), true);
  } finally {
    await gateway.stop();
  }
  assert.equal(existsSync(config.instanceLockPath), false, 'stop releases the lock and metadata');

  const again = acquireInstanceLock(config.instanceLockDbPath, {
    pid: process.pid,
    port: 7777,
    startedAt: new Date().toISOString(),
  });
  again.release();
});

test('probeInstance health-checks a running gateway and reports a dead one', async (t) => {
  const app = await startTestGateway(t);
  const endpoint = JSON.parse(readFileSync(join(app.dir, 'endpoint.json'), 'utf8')) as InstanceLockInfo;
  const alive = await probeInstance({
    pid: endpoint.pid,
    port: Number(new URL(app.url).port),
    startedAt: endpoint.startedAt,
    url: app.url,
  });
  assert.equal(alive.healthy, true);
  assert.equal(alive.pid, process.pid);
  assert.equal(typeof alive.version, 'string');

  await app.close();
  const dead = await probeInstance(
    { pid: endpoint.pid, port: 1, startedAt: endpoint.startedAt, url: app.url },
    500,
  );
  assert.equal(dead.healthy, false);
});

test('a second core process probes the running instance and exits with code 3', async (t) => {
  const app = await startTestGateway(t);
  const child = spawnCore(app.dir);
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error('second instance did not exit'));
    }, 20_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
  assert.equal(exitCode, 3);
});

test('32 barrier-synchronized CLI processes elect exactly one gateway (3 rounds)', async (t) => {
  for (let round = 1; round <= 3; round += 1) {
    const dir = tempDir();
    const children: ChildProcess[] = [];
    try {
      const barrierDir = join(dir, 'barrier');
      mkdirSync(barrierDir, { recursive: true });
      const barrierFile = writeBarrierModule(barrierDir);
      // Stale human-readable metadata (dead pid) must not influence election.
      writeFileSync(
        join(dir, INSTANCE_LOCK_FILENAME),
        `${JSON.stringify({ pid: await deadPid(), port: 1, startedAt: new Date().toISOString() })}\n`,
      );

      const exits = new Map<number, number | null>();
      for (let index = 0; index < 32; index += 1) {
        const child = spawn(
          process.execPath,
          [
            '--import',
            pathToFileURL(barrierFile).href,
            CORE_CLI,
            '--data-dir',
            dir,
            '--port',
            '0',
          ],
          {
            stdio: 'ignore',
            env: {
              ...process.env,
              SAG_TEST_BARRIER_DIR: barrierDir,
              SAG_TEST_BARRIER_ID: String(index),
            },
          },
        );
        children.push(child);
        child.on('exit', (code) => exits.set(child.pid!, code));
      }

      // Release all 32 processes only once every one of them is at the barrier.
      const readyDeadline = Date.now() + 30_000;
      while (countReady(barrierDir) < 32 && Date.now() < readyDeadline) await delay(20);
      assert.equal(
        countReady(barrierDir),
        32,
        `round ${round}: only ${countReady(barrierDir)}/32 processes reached the barrier`,
      );
      writeFileSync(join(barrierDir, 'go'), '1');

      const deadline = Date.now() + 30_000;
      while (exits.size < 31 && Date.now() < deadline) await delay(20);
      await delay(300);

      const running = children.filter((child) => !exits.has(child.pid!));
      const codes = [...exits.values()];
      assert.equal(
        running.length,
        1,
        `round ${round}: expected exactly one running gateway, got ${running.length} (exit codes: ${codes.join(',')})`,
      );
      assert.equal(codes.length, 31, `round ${round}: expected 31 losers, got ${codes.length}`);
      assert.deepEqual(
        [...new Set(codes)],
        [3],
        `round ${round}: every loser must exit with code 3, got ${codes.join(',')}`,
      );

      const winner = running[0]!;
      assert.equal(
        readInstanceLock(join(dir, INSTANCE_LOCK_FILENAME))?.pid,
        winner.pid,
        `round ${round}: the winner owns the metadata`,
      );

      // A killed owner leaves no stale lock: SQLite releases it with the process.
      winner.kill();
      await new Promise<void>((resolvePromise) => winner.once('exit', () => resolvePromise()));
      const replacement = spawnCore(dir);
      children.push(replacement);
      const outcome = await Promise.race([
        new Promise<{ exited: boolean; code: number | null }>((resolvePromise) => {
          replacement.once('exit', (code) => resolvePromise({ exited: true, code }));
        }),
        delay(2500).then(() => ({ exited: false, code: null })),
      ]);
      assert.equal(
        outcome.exited,
        false,
        `round ${round}: replacement exited with ${outcome.code} instead of taking over`,
      );
      assert.equal(readInstanceLock(join(dir, INSTANCE_LOCK_FILENAME))?.pid, replacement.pid);
      replacement.kill();
      await new Promise<void>((resolvePromise) => replacement.once('exit', () => resolvePromise()));
    } finally {
      await removeDirAfterChildren(dir, children);
    }
  }
});

test('a core on an already-bound port exits with code 3 (different data dir)', async (t) => {
  const app = await startTestGateway(t);
  const port = new URL(app.url).port;
  const dir = tempDir();
  const children: ChildProcess[] = [];
  try {
    const child = spawn(process.execPath, [CORE_CLI, '--data-dir', dir, '--port', port], {
      stdio: 'ignore',
    });
    children.push(child);
    const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error('second port owner did not exit'));
      }, 20_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolvePromise(code);
      });
    });
    assert.equal(exitCode, 3);
  } finally {
    await removeDirAfterChildren(dir, children);
  }
});
