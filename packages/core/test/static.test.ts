import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { WEB_BUILD_COMMAND, resolveWebDistDir, staticRelativePath } from '../src/static.js';
import { request, startTestGateway, type RawResponse } from './helpers.js';

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>SPA-FIXTURE</title>',
  '<link rel="stylesheet" href="/styles.css"></head>',
  '<body><div id="root">SPA-FIXTURE</div>',
  '<script type="module" src="/app.js"></script></body></html>',
].join('');

const APP_JS = 'export const fixture = 1;\n';
const STYLES_CSS = 'body { color: #111; }\n';
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n';

/** Builds a throw-away dist fixture so tests never depend on packages/web. */
function createDistFixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sag-web-dist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'app.js'), APP_JS);
  writeFileSync(join(dir, 'styles.css'), STYLES_CSS);
  writeFileSync(join(dir, 'assets', 'logo.svg'), LOGO_SVG);
  return dir;
}

/**
 * Sends a request path verbatim (the shared helper re-parses it through URL,
 * which would normalize `..` before it reached the server).
 */
function rawRequest(baseUrl: string, rawPath: string): Promise<RawResponse> {
  const target = new URL(baseUrl);
  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: rawPath,
        method: 'GET',
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolvePromise({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text,
            json,
          });
        });
      },
    );
    outgoing.on('error', rejectPromise);
    outgoing.end();
  });
}

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name];
  return Array.isArray(raw) ? raw.join(',') : raw ?? '';
}

test('serves /, embedded /?embed=1 and assets from the dist directory', async (t) => {
  const distDir = createDistFixture(t);
  const app = await startTestGateway(t, { webDistDir: distDir });

  const index = await request(app.url, '/');
  assert.equal(index.status, 200, index.text);
  assert.match(headerOf(index.headers, 'content-type'), /^text\/html/);
  assert.equal(index.text, INDEX_HTML);

  const embedded = await request(app.url, '/?embed=1');
  assert.equal(embedded.status, 200, embedded.text);
  assert.equal(embedded.text, INDEX_HTML, 'embed must serve the same index.html');
  assert.match(headerOf(embedded.headers, 'content-type'), /^text\/html/);

  const script = await request(app.url, '/app.js');
  assert.equal(script.status, 200, script.text);
  assert.match(headerOf(script.headers, 'content-type'), /javascript/);
  assert.equal(script.text, APP_JS);

  const styles = await request(app.url, '/styles.css');
  assert.equal(styles.status, 200, styles.text);
  assert.match(headerOf(styles.headers, 'content-type'), /^text\/css/);
  assert.equal(styles.text, STYLES_CSS);

  const svg = await request(app.url, '/assets/logo.svg');
  assert.equal(svg.status, 200, svg.text);
  assert.match(headerOf(svg.headers, 'content-type'), /^image\/svg\+xml/);
  assert.equal(svg.text, LOGO_SVG);
});

test('SPA pages carry the embed-permitting CSP, nosniff and no-referrer', async (t) => {
  const distDir = createDistFixture(t);
  const app = await startTestGateway(t, { webDistDir: distDir });

  const index = await request(app.url, '/');
  const csp = headerOf(index.headers, 'content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/);
  assert.match(csp, /img-src 'self' data:/);
  assert.ok(
    csp.includes("frame-ancestors 'self' dsh-app:"),
    `CSP must allow dsh-app: embedding, got: ${csp}`,
  );
  assert.equal(headerOf(index.headers, 'x-content-type-options'), 'nosniff');
  assert.equal(headerOf(index.headers, 'referrer-policy'), 'no-referrer');
  assert.equal(index.headers['x-frame-options'], undefined, 'X-Frame-Options must not be set');

  // API responses keep the stricter baseline policy (static CSP is not global).
  const health = await request(app.url, '/v1/health');
  assert.equal(health.status, 200, health.text);
  assert.match(headerOf(health.headers, 'content-security-policy'), /default-src 'none'/);
});

test('rejects traversal and unknown paths instead of falling back to index.html', async (t) => {
  const distDir = createDistFixture(t);
  const app = await startTestGateway(t, { webDistDir: distDir });

  for (const rawPath of ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const traversal = await rawRequest(app.url, rawPath);
    assert.ok(
      traversal.status === 400 || traversal.status === 404,
      `${rawPath} must be rejected, got ${traversal.status}`,
    );
    assert.equal(traversal.text.includes('SPA-FIXTURE'), false);
  }

  const backslash = await rawRequest(app.url, '/%5c..%5cetc%5cpasswd');
  assert.equal(backslash.status, 400, backslash.text);
  assert.equal(bodyOf(backslash).code, 'INVALID_REQUEST');

  const unknown = await request(app.url, '/nope');
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(bodyOf(unknown).code, 'NOT_FOUND');
  assert.equal(unknown.text.includes('SPA-FIXTURE'), false, 'no index fallback');

  const unknownAsset = await request(app.url, '/assets/nope.js');
  assert.equal(unknownAsset.status, 404, unknownAsset.text);

  const unknownApi = await request(app.url, '/v1/nope');
  assert.equal(unknownApi.status, 404, unknownApi.text);
  assert.equal(bodyOf(unknownApi).code, 'NOT_FOUND');
  assert.equal(unknownApi.text.includes('SPA-FIXTURE'), false);
});

test('returns 503 WEB_NOT_BUILT for / when dist is missing, without touching /v1', async (t) => {
  const missing = join(tmpdir(), `sag-web-missing-${randomBytes(8).toString('hex')}`);
  const app = await startTestGateway(t, { webDistDir: missing });

  const index = await request(app.url, '/');
  assert.equal(index.status, 503, index.text);
  assert.match(headerOf(index.headers, 'content-type'), /^application\/json/);
  assert.equal(bodyOf(index).code, 'WEB_NOT_BUILT');
  assert.ok(
    String(bodyOf(index).hint).includes(WEB_BUILD_COMMAND),
    `hint should mention ${WEB_BUILD_COMMAND}`,
  );

  const health = await request(app.url, '/v1/health');
  assert.equal(health.status, 200, health.text);
  assert.equal(bodyOf(health).ok, true);

  const asset = await request(app.url, '/app.js');
  assert.equal(asset.status, 404, asset.text);
});

test('resolves SAG_WEB_DIST before the repo build output and rejects unsafe paths', () => {
  const explicit = join(tmpdir(), 'sag-explicit-dist');
  assert.equal(resolveWebDistDir({ SAG_WEB_DIST: explicit }), resolve(explicit));

  const fallback = resolveWebDistDir({});
  assert.ok(fallback.endsWith(join('packages', 'web', 'dist')), fallback);
  assert.equal(fallback, resolve(fallback));

  assert.equal(staticRelativePath('/app.js'), 'app.js');
  assert.equal(staticRelativePath('/assets/logo.svg'), 'assets/logo.svg');
  assert.equal(staticRelativePath('/'), null);
  assert.equal(staticRelativePath('/../etc/passwd'), null);
  assert.equal(staticRelativePath('/%2e%2e/etc/passwd'), null);
  assert.equal(staticRelativePath('/a%5cb'), null);
  assert.equal(staticRelativePath('/%00'), null);
  assert.equal(staticRelativePath('/C:/Windows/win.ini'), null);
});
