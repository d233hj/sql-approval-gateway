import { passwordSchema } from '@sql-approval/shared';

import { loadConfig } from './config.js';
import { createGateway } from './http.js';
import { InstanceLockError, probeInstance } from './instance.js';
import { randomToken, sha256Hex } from './util.js';
import { resetVault } from './vault.js';
import { VERSION } from './version.js';

function usage(): never {
  process.stderr.write(
    [
      'Usage: sag-core [serve] [--data-dir <path>] [--port <port>]',
      '       sag-core setup --password-stdin [--data-dir <path>]',
      '       sag-core reset --confirm [--data-dir <path>]',
      '',
    ].join('\n'),
  );
  process.exitCode = 2;
  throw new Error('invalid command');
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function configOverrides(args: string[]): { dataDir?: string; port?: number } {
  const dataDir = optionValue(args, '--data-dir');
  const portText = optionValue(args, '--port');
  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw new Error('--port must be an integer');
    port = Number(portText);
  }
  if (dataDir === undefined && port === undefined) return {};
  return { ...(dataDir !== undefined ? { dataDir } : {}), ...(port !== undefined ? { port } : {}) };
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const knownCommands = new Set(['serve', 'setup', 'reset']);
  const first = args[0];
  const command = first && knownCommands.has(first) ? first : 'serve';
  if (command === first) args.shift();
  const config = loadConfig(process.env, configOverrides(args));

  if (command === 'reset') {
    if (!args.includes('--confirm')) {
      process.stderr.write('reset requires --confirm\n');
      process.exitCode = 2;
      return;
    }
    const backup = resetVault(config.vaultPath);
    process.stdout.write(
      `${JSON.stringify({ ok: true, backup, data_dir: config.dataDir })}\n`,
    );
    return;
  }

  if (command === 'setup') {
    if (!args.includes('--password-stdin')) {
      process.stderr.write('setup requires --password-stdin\n');
      process.exitCode = 2;
      return;
    }
    const password = await readPasswordFromStdin();
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: 'INVALID_PASSWORD_POLICY' })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const gateway = await createGateway({ config });
    const agentToken = `sag_${randomToken(32)}`;
    try {
      await gateway.vault.setup(parsed.data);
      gateway.store.upsertClient('agent_default', 'default agent', sha256Hex(agentToken));
      gateway.store.appendAudit({
        actor: 'system',
        action: 'admin.setup',
        detail: { agent_client_id: 'agent_default' },
      });
    } finally {
      await gateway.stop();
    }
    // One-time display, matching the HTTP setup flow. Never write this to logs.
    process.stdout.write(`${JSON.stringify({ ok: true, agent_token: agentToken })}\n`);
    return;
  }

  if (command !== 'serve') usage();

  const gateway = await createGateway({
    config,
    logger: {
      info(event) {
        process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
      },
      warn(event) {
        process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
      },
    },
  });
  const started = await gateway.start();
  process.stdout.write(
    `${JSON.stringify({
      event: 'listening',
      url: started.url,
      pid: process.pid,
      version: VERSION,
    })}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${JSON.stringify({ event: 'shutdown', signal })}\n`);
    await gateway.stop();
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });
}

run().catch(async (error: unknown) => {
  if (error instanceof InstanceLockError) {
    // DESIGN §3.2: the second process probes the running instance, prints its
    // URL and exits with code 3 instead of starting a competing gateway.
    const existing = error.existing;
    const probe = existing ? await probeInstance(existing) : null;
    process.stdout.write(
      `${JSON.stringify({
        event: 'already_running',
        code: error.code,
        pid: existing?.pid ?? null,
        url: probe?.url ?? existing?.url ?? null,
        healthy: probe?.healthy ?? false,
        version: probe?.version ?? null,
      })}\n`,
    );
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : 'startup failed';
  // Startup errors are configuration errors; messages never include secrets.
  process.stderr.write(`${JSON.stringify({ event: 'fatal', message })}\n`);
  process.exitCode = 1;
});
