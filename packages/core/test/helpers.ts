import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  Gateway,
  silentLogger,
  type GatewayLogger,
  type GatewayOptions,
} from '../src/http.js';
import { randomToken } from '../src/util.js';

export interface TestApp {
  dir: string;
  url: string;
  gateway: Gateway;
  setupPasswordFile?: string;
  close(): Promise<void>;
}

export interface TestAppOptions {
  clock?: () => number;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  proposalTtlMs?: number;
  /** Writes this password into a one-time file and sets the documented env var. */
  setupPasswordFileContent?: string;
  /** Overrides the SPA dist directory (defaults to SAG_WEB_DIST / repo path). */
  webDistDir?: string;
  /** Bind address; defaults to the loopback address chosen by loadConfig. */
  host?: string;
  /** Equivalent of SAG_ALLOW_NON_LOOPBACK_BIND=1 for tests. */
  allowNonLoopbackBind?: boolean;
  /** Capture startup warnings; defaults to the silent logger. */
  logger?: GatewayLogger;
  /** Deterministic probe stub injected through `GatewayOptions.probeSource`. */
  probeSource?: GatewayOptions['probeSource'];
  /**
   * Toast side effect. Defaults to a no-op so the suite never spawns
   * PowerShell; tests that assert notifications inject a spy.
   */
  notifyNewProposal?: GatewayOptions['notifyNewProposal'];
}

export async function startTestGateway(
  t: TestContext,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'sag-core-test-'));
  const config = loadConfig(
    {},
    {
      dataDir: dir,
      port: 0,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.allowNonLoopbackBind === undefined
        ? {}
        : { allowNonLoopbackBind: options.allowNonLoopbackBind }),
      sessionIdleMs: options.sessionIdleMs ?? 10 * 60 * 1000,
      sessionAbsoluteMs: options.sessionAbsoluteMs ?? 8 * 60 * 60 * 1000,
      proposalTtlMs: options.proposalTtlMs ?? 24 * 60 * 60 * 1000,
    },
  );
  let setupPasswordFile: string | undefined;
  let gateway: Gateway;
  try {
    const gatewayOptions = {
      config,
      clock: options.clock ?? Date.now,
      logger: options.logger ?? silentLogger,
      agentTokenFromEnv: null,
      ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
      ...(options.probeSource === undefined ? {} : { probeSource: options.probeSource }),
      notifyNewProposal: options.notifyNewProposal ?? (() => {}),
    };
    if (options.setupPasswordFileContent !== undefined) {
      setupPasswordFile = join(dir, 'setup-password.txt');
      writeFileSync(setupPasswordFile, options.setupPasswordFileContent, { mode: 0o600 });
      const previous = process.env.SAG_SETUP_PASSWORD_FILE;
      process.env.SAG_SETUP_PASSWORD_FILE = setupPasswordFile;
      try {
        // Constructor resolution is synchronous; start() consumes the file.
        gateway = new Gateway(gatewayOptions);
      } finally {
        if (previous === undefined) delete process.env.SAG_SETUP_PASSWORD_FILE;
        else process.env.SAG_SETUP_PASSWORD_FILE = previous;
      }
    } else {
      gateway = new Gateway(gatewayOptions);
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  let started;
  try {
    started = await gateway.start();
  } catch (error) {
    try {
      await gateway.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await gateway.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  t.after(close);
  return { dir, url: started.url, gateway, setupPasswordFile, close };
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export function request(
  baseUrl: string,
  path: string,
  options: RawRequestOptions = {},
): Promise<RawResponse> {
  const target = new URL(path, baseUrl);
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = value;
  }

  const text =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (text !== undefined) {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    if (!hasHeader(headers, 'content-length')) {
      headers['Content-Length'] = String(Buffer.byteLength(text));
    }
  }

  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = bodyText.length > 0 ? JSON.parse(bodyText) : null;
          } catch {
            json = null;
          }
          resolvePromise({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text: bodyText,
            json,
          });
        });
      },
    );
    outgoing.on('error', rejectPromise);
    if (text !== undefined) outgoing.write(text);
    outgoing.end();
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

export function uniquePassword(): string {
  return `Aa1!${randomBytes(18).toString('base64url')}`;
}

export function cookieFrom(response: RawResponse): string {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((value) => value.startsWith('sag_session='));
  if (!session) throw new Error('response did not set sag_session');
  return session.split(';', 1)[0]!;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function cookieAuth(
  cookie: string,
  csrfToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...extra, Cookie: cookie, 'X-SAG-CSRF': csrfToken };
}

export interface Authenticated {
  password: string;
  agentToken: string;
  sessionToken: string;
  csrfToken: string;
  cookie: string;
}

export async function setupAndUnlock(
  app: TestApp,
  options: { wantToken?: boolean } = {},
): Promise<Authenticated> {
  const password = uniquePassword();
  const setup = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });
  assert.equal(setup.status, 200, setup.text);
  const setupBody = setup.json as Record<string, unknown>;
  assert.equal(typeof setupBody.agent_token, 'string');
  const agentToken = String(setupBody.agent_token);

  const headers: Record<string, string> = {};
  if (options.wantToken) headers['X-SAG-Want-Token'] = '1';
  const unlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    headers,
    body: { password },
  });
  assert.equal(unlock.status, 200, unlock.text);
  const body = unlock.json as Record<string, unknown>;
  assert.equal(typeof body.csrfToken, 'string');
  const sessionToken = options.wantToken ? String(body.token) : '';
  return {
    password,
    agentToken,
    sessionToken,
    csrfToken: String(body.csrfToken),
    cookie: cookieFrom(unlock),
  };
}

export async function addTestSource(
  app: TestApp,
  auth: Authenticated,
  options: { name?: string; marker?: string } = {},
): Promise<{ id: string; name: string; dialect: string }> {
  const body: Record<string, unknown> = {
    name: options.name ?? `source-${randomToken(6)}`,
    dialect: 'sqlite',
  };
  if (options.marker !== undefined) {
    body.connection = { credential_marker: options.marker };
  }
  const response = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body,
  });
  assert.equal(response.status, 201, response.text);
  return response.json as { id: string; name: string; dialect: string };
}

export async function submitProposal(
  app: TestApp,
  agentToken: string,
  sourceId: string,
): Promise<Record<string, unknown>> {
  const response = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(agentToken),
    body: {
      source_id: sourceId,
      sql: 'SELECT 1 AS one',
      purpose: 'test proposal',
    },
  });
  assert.equal(response.status, 201, response.text);
  return response.json as Record<string, unknown>;
}
