/**
 * Zero-dependency development/preview server.
 *
 * It exists because Vite/esbuild cannot spawn its service process inside this
 * sandbox (spawn EPERM). It provides the same browser contract:
 *
 *   http://127.0.0.1:5173  ──/v1──▶  http://127.0.0.1:43119
 *
 * The browser stays on one origin, so the HttpOnly `sag_session` cookie is
 * same-origin without CORS credentials. Core requires `Host:
 * 127.0.0.1:43119` and rejects a foreign Origin, so both headers are rewritten
 * for the loopback dev hop. Production is expected to serve the built `dist/`
 * directly from core's own origin (no proxy involved).
 *
 * In dev mode (default) `/src/*.js` is transpiled from `/src/*.ts` on demand
 * with the TypeScript compiler API; no child process and no bundler.
 * In preview mode (`--dist`) the files emitted by `npm run build` are served.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(root, 'src');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const serveDist = process.argv.includes('--dist');
const documentRoot = serveDist ? distDir : root;
const port = Number(process.env.PORT || 5173);
const host = '127.0.0.1';
const CORE_ORIGIN = 'http://127.0.0.1:43119';
const coreUrl = new URL(CORE_ORIGIN);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self' dsh-app: http://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
]);

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

let typescriptPromise = null;
const transpileCache = new Map();

async function loadTypeScript() {
  if (!typescriptPromise) {
    typescriptPromise = import('typescript').then((module) => module.default ?? module);
  }
  return typescriptPromise;
}

async function transpileTypeScript(file) {
  const info = await stat(file);
  const cached = transpileCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.code;

  const ts = await loadTypeScript();
  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      sourceMap: false,
    },
  });

  if (result.diagnostics && result.diagnostics.length > 0) {
    const messages = result.diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n');
    throw new Error(`TypeScript transpile failed for ${path.basename(file)}:\n${messages}`);
  }

  transpileCache.set(file, { mtimeMs: info.mtimeMs, code: result.outputText });
  return result.outputText;
}

function safeJoin(base, relative) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendBuffer(req, res, status, body, type) {
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Type': type,
    'Content-Length': body.length,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

async function serveFile(req, res, file) {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const body = await readFile(file);
  const type = MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
  sendBuffer(req, res, 200, body, type);
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    await serveFile(req, res, path.join(documentRoot, 'index.html'));
    return;
  }

  if (pathname === '/styles.css') {
    await serveFile(req, res, path.join(documentRoot, 'styles.css'));
    return;
  }

  if (pathname.startsWith('/assets/')) {
    const base = serveDist ? documentRoot : publicDir;
    const file = safeJoin(base, pathname.slice(1));
    if (!file) {
      sendText(res, 404, 'Not Found');
      return;
    }
    await serveFile(req, res, file);
    return;
  }

  if (!serveDist && pathname.startsWith('/src/') && pathname.endsWith('.js')) {
    const name = pathname.slice('/src/'.length, -'.js'.length);
    if (name.includes('/')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const file = safeJoin(srcDir, `${name}.ts`);
    if (!file) {
      sendText(res, 404, 'Not Found');
      return;
    }
    try {
      const code = await transpileTypeScript(file);
      sendBuffer(req, res, 200, Buffer.from(code, 'utf8'), MIME.get('.js'));
    } catch (error) {
      console.error(`[web] ${error instanceof Error ? error.message : String(error)}`);
      sendText(res, 500, 'TypeScript transpile failed; see the dev-server console.');
    }
    return;
  }

  if (serveDist) {
    const file = safeJoin(documentRoot, pathname.slice(1));
    if (file) {
      const info = await stat(file).catch(() => null);
      if (info && info.isFile()) {
        await serveFile(req, res, file);
        return;
      }
    }
  }

  // SPA fallback for extensionless routes.
  if (path.extname(pathname) === '') {
    await serveFile(req, res, path.join(documentRoot, 'index.html'));
    return;
  }

  sendText(res, 404, 'Not Found');
}

function proxyToCore(req, res) {
  const target = new URL(req.url ?? '/', CORE_ORIGIN);
  const headers = { ...req.headers };
  // Loopback-only rewrite: make core's exact Host/Origin checks pass.
  headers.host = coreUrl.host;
  headers.origin = CORE_ORIGIN;
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];

  const upstream = http.request(
    {
      protocol: 'http:',
      hostname: coreUrl.hostname,
      port: coreUrl.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.setTimeout(180_000, () => {
    upstream.destroy(new Error('core request timed out'));
  });

  upstream.on('error', (error) => {
    console.error(`[web] proxy error for ${req.method ?? 'GET'} ${target.pathname}: ${error.message}`);
    if (!res.headersSent) {
      const body = JSON.stringify({
        code: 'NETWORK_ERROR',
        message: 'Unable to reach the local core service.',
        request_id: '',
      });
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } else {
      res.destroy();
    }
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    proxyToCore(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...baseHeaders, Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  void serveStatic(req, res, pathname).catch((error) => {
    console.error(`[web] static error: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else res.destroy();
  });
});

server.listen(port, host, () => {
  const mode = serveDist ? 'preview (dist/)' : 'dev (src/)';
  console.log(`[web] SQL Approval Gateway approval console — ${mode}`);
  console.log(`[web] open http://${host}:${port}`);
  console.log(`[web] proxy /v1 → ${CORE_ORIGIN} (Host + Origin rewritten for loopback)`);
  if (serveDist) {
    console.log('[web] serve the artifact produced by `npm run build`');
  }
});

server.on('error', (error) => {
  console.error(`[web] server error: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
