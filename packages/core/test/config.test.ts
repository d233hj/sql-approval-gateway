import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';
import type { GatewayLogger } from '../src/http.js';
import { request, startTestGateway } from './helpers.js';

const WARNING =
  'non-loopback bind enabled; ensure host firewall/publish restricts access';

function tempDataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sag-config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertConfigError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, pattern);
    return true;
  });
}

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

test('SAG_HOST rejects non-loopback binds by default', (t) => {
  const dataDir = tempDataDir(t);

  for (const host of ['0.0.0.0', '::']) {
    assertConfigError(
      () => loadConfig({}, { dataDir, host }),
      /SAG_HOST must be a loopback address/,
    );
    assertConfigError(
      () => loadConfig({ SAG_HOST: host }, { dataDir }),
      /SAG_HOST must be a loopback address/,
    );
  }

  assert.equal(loadConfig({}, { dataDir }).host, '127.0.0.1');
  assert.equal(loadConfig({ SAG_HOST: 'localhost' }, { dataDir }).host, 'localhost');
  assert.equal(loadConfig({ SAG_HOST: '::1' }, { dataDir }).host, '::1');
  assert.equal(loadConfig({}, { dataDir }).allowNonLoopbackBind, false);
});

test('SAG_ALLOW_NON_LOOPBACK_BIND=1 permits only the two wildcard binds', (t) => {
  const dataDir = tempDataDir(t);

  for (const host of ['0.0.0.0', '::']) {
    const config = loadConfig({ SAG_ALLOW_NON_LOOPBACK_BIND: '1', SAG_HOST: host }, { dataDir });
    assert.equal(config.host, host);
    assert.equal(config.allowNonLoopbackBind, true);
  }

  // Specific non-loopback addresses remain rejected even with the switch on.
  for (const host of ['192.168.1.5', '203.0.113.7', '10.0.0.1', 'example.com']) {
    assertConfigError(
      () => loadConfig({ SAG_ALLOW_NON_LOOPBACK_BIND: '1', SAG_HOST: host }, { dataDir }),
      /may only be 0\.0\.0\.0 or ::/,
    );
  }

  // The switch is explicit: only the literal value 1 enables it.
  for (const value of ['0', 'true', 'yes', '']) {
    assertConfigError(
      () => loadConfig({ SAG_ALLOW_NON_LOOPBACK_BIND: value, SAG_HOST: '0.0.0.0' }, { dataDir }),
      /SAG_HOST must be a loopback address/,
    );
  }

  // A loopback bind is still valid while the switch is on.
  assert.equal(
    loadConfig({ SAG_ALLOW_NON_LOOPBACK_BIND: '1', SAG_HOST: '127.0.0.1' }, { dataDir }).host,
    '127.0.0.1',
  );
  // Tests can exercise the same posture without touching process.env.
  assert.equal(
    loadConfig({}, { dataDir, host: '0.0.0.0', allowNonLoopbackBind: true }).host,
    '0.0.0.0',
  );
});

test('wildcard bind warns once and keeps Host/Origin validation loopback-only', async (t) => {
  const warnings: Array<Record<string, unknown>> = [];
  const logger: GatewayLogger = {
    info() {},
    warn(event) {
      warnings.push(event);
    },
  };

  const app = await startTestGateway(t, {
    host: '0.0.0.0',
    allowNonLoopbackBind: true,
    logger,
  });
  const port = new URL(app.url).port;

  // The advertised URL stays a usable loopback URL; 0.0.0.0 is a bind address.
  assert.equal(new URL(app.url).hostname, '127.0.0.1');

  const bindWarnings = warnings.filter((event) => event.event === 'non_loopback_bind_enabled');
  assert.equal(bindWarnings.length, 1);
  assert.equal(bindWarnings[0]!.message, WARNING);
  const warningText = JSON.stringify(bindWarnings[0]);
  assert.equal(warningText.includes('0.0.0.0'), false);
  assert.equal(warningText.includes(app.dir), false);

  const evilHost = await request(app.url, '/v1/health', {
    headers: { Host: 'evil.com' },
  });
  assert.equal(evilHost.status, 400, evilHost.text);
  assert.equal(bodyOf(evilHost).code, 'INVALID_HOST');

  // A wildcard bind address is not a valid Host value either.
  const wildcardHost = await request(app.url, '/v1/health', {
    headers: { Host: `0.0.0.0:${port}` },
  });
  assert.equal(wildcardHost.status, 400, wildcardHost.text);
  assert.equal(bodyOf(wildcardHost).code, 'INVALID_HOST');

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const goodHost = await request(app.url, '/v1/health', {
      headers: { Host: host },
    });
    assert.equal(goodHost.status, 200, `${host}: ${goodHost.text}`);
  }

  const badOrigin = await request(app.url, '/v1/health', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(badOrigin.status, 403, badOrigin.text);
  assert.equal(bodyOf(badOrigin).code, 'ORIGIN_REJECTED');

  const goodOrigin = await request(app.url, '/v1/health', {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(goodOrigin.status, 200, goodOrigin.text);
  assert.equal(goodOrigin.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`);

  const health = await request(app.url, '/v1/health');
  assert.equal(health.status, 200, health.text);
  assert.deepEqual(Object.keys(bodyOf(health)).sort(), [
    'ok',
    'pid',
    'service',
    'started_at',
    'version',
  ]);
  assert.equal(health.text.includes('0.0.0.0'), false);
  assert.equal(health.text.includes(app.dir), false);
});

test('a default loopback bind does not emit the non-loopback warning', async (t) => {
  const warnings: Array<Record<string, unknown>> = [];
  const app = await startTestGateway(t, {
    logger: {
      info() {},
      warn(event) {
        warnings.push(event);
      },
    },
  });
  assert.equal(new URL(app.url).hostname, '127.0.0.1');
  assert.equal(
    warnings.some((event) => event.event === 'non_loopback_bind_enabled'),
    false,
  );
});
