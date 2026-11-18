import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_PORT,
  PROPOSAL_TTL_MS,
  RESULT_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '@sql-approval/shared';

import { VERSION } from './version.js';

export interface AppConfig {
  dataDir: string;
  vaultPath: string;
  dbPath: string;
  endpointPath: string;
  instanceLockPath: string;
  instanceLockDbPath: string;
  host: string;
  port: number;
  /**
   * True only when SAG_ALLOW_NON_LOOPBACK_BIND=1. Binding still has to target
   * one of the two wildcard addresses; a concrete non-loopback host is never
   * accepted. HTTP Host/Origin validation is independent of this flag.
   */
  allowNonLoopbackBind: boolean;
  version: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  proposalTtlMs: number;
  resultTtlMs: number;
}

export interface ConfigOverrides {
  dataDir?: string;
  host?: string;
  allowNonLoopbackBind?: boolean;
  port?: number;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  proposalTtlMs?: number;
  resultTtlMs?: number;
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The only bind addresses allowed behind SAG_ALLOW_NON_LOOPBACK_BIND=1. A
 * wildcard bind is what a container needs (the host only publishes
 * 127.0.0.1); specific non-loopback addresses stay rejected so the switch
 * cannot expose the gateway on an arbitrary interface by accident.
 */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::']);

/** True when the host is a non-loopback wildcard bind address. */
export function isWildcardBindHost(host: string): boolean {
  return WILDCARD_BIND_HOSTS.has(host);
}

/** SAG_ALLOW_NON_LOOPBACK_BIND is explicit: only the literal value 1 enables it. */
function parseAllowNonLoopbackBind(value: string | undefined): boolean {
  return value?.trim() === '1';
}

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const appName = 'sql-approval';
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, appName);
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? join(xdg, appName) : join(homedir(), '.local', 'share', appName);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new ConfigError('SAG_PORT must be an integer');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('SAG_PORT must be between 0 and 65535');
  }
  return port;
}

function parseDuration(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new ConfigError(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): AppConfig {
  const dataDir = resolve(overrides.dataDir ?? env.SAG_DATA_DIR?.trim() ?? defaultDataDir());
  const host = overrides.host ?? env.SAG_HOST?.trim() ?? '127.0.0.1';
  const allowNonLoopbackBind =
    overrides.allowNonLoopbackBind ?? parseAllowNonLoopbackBind(env.SAG_ALLOW_NON_LOOPBACK_BIND);
  if (!LOOPBACK_HOSTS.has(host)) {
    if (!allowNonLoopbackBind) {
      throw new ConfigError('SAG_HOST must be a loopback address (127.0.0.1, localhost, or ::1)');
    }
    if (!WILDCARD_BIND_HOSTS.has(host)) {
      throw new ConfigError(
        'SAG_HOST may only be 0.0.0.0 or :: when SAG_ALLOW_NON_LOOPBACK_BIND=1',
      );
    }
  }
  const port = overrides.port ?? parsePort(env.SAG_PORT, DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('port must be between 0 and 65535');
  }

  const sessionIdleMs =
    overrides.sessionIdleMs ??
    parseDuration(env.SAG_SESSION_IDLE_MS, SESSION_IDLE_MS, 'SAG_SESSION_IDLE_MS');
  const sessionAbsoluteMs =
    overrides.sessionAbsoluteMs ??
    parseDuration(env.SAG_SESSION_ABSOLUTE_MS, SESSION_ABSOLUTE_MS, 'SAG_SESSION_ABSOLUTE_MS');
  const proposalTtlMs =
    overrides.proposalTtlMs ??
    parseDuration(env.SAG_PROPOSAL_TTL_MS, PROPOSAL_TTL_MS, 'SAG_PROPOSAL_TTL_MS');
  const resultTtlMs =
    overrides.resultTtlMs ??
    parseDuration(env.SAG_RESULT_TTL_MS, RESULT_TTL_MS, 'SAG_RESULT_TTL_MS');

  return {
    dataDir,
    vaultPath: join(dataDir, 'vault.json'),
    dbPath: join(dataDir, 'control.db'),
    endpointPath: join(dataDir, 'endpoint.json'),
    instanceLockPath: join(dataDir, 'instance.lock'),
    instanceLockDbPath: join(dataDir, 'instance-lock.db'),
    host,
    port,
    allowNonLoopbackBind,
    version: VERSION,
    sessionIdleMs,
    sessionAbsoluteMs,
    proposalTtlMs,
    resultTtlMs,
  };
}

export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(dataDir, 0o700);
    } catch {
      // Best effort only; an existing directory may be owned by another process.
    }
  }
}
