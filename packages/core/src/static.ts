/**
 * Same-origin static hosting for the Web SPA (DESIGN §8.1, §8.3).
 *
 * The core gateway serves `packages/web/dist` itself so that a browser and the
 * DSH iframe (`http://127.0.0.1:<port>/?embed=1`) never need a second server.
 * Only the filesystem/path/content-type policy lives here; the HTTP response
 * (status/headers/body) is written by `http.ts`.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CSP for SPA documents only (DESIGN §8.1/§8.3). `frame-ancestors` allows the
 * DSH desktop shell (`dsh-app:`) to embed the page in an iframe, while keeping
 * the gateway's API responses on the much stricter `default-src 'none'` policy.
 */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' http://127.0.0.1:*; img-src 'self' data:; " +
  "frame-ancestors 'self' dsh-app:";

/** Command shown when the SPA build output is missing. */
export const WEB_BUILD_COMMAND = 'npm run build -w @sql-approval/web';

/**
 * Static file resolution. The repository root is found by walking up from this
 * module (works both for `src/static.ts` via ts-node/tsc and for the compiled
 * `dist/src/static.js`), looking for the monorepo marker.
 */
export function findRepoRoot(startFile: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(startFile);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fileExists(join(dir, 'package.json')) && fileExists(join(dir, 'packages', 'web'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Lookup order (DESIGN §8.1): `SAG_WEB_DIST` wins, otherwise the checked-in
 * monorepo build output `<repo>/packages/web/dist`.
 */
export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAG_WEB_DIST?.trim();
  if (configured) return resolve(configured);
  return join(findRepoRoot(), 'packages', 'web', 'dist');
}

export function staticIndexPath(distDir: string): string {
  return join(distDir, 'index.html');
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeForFilePath(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Converts a URL pathname into a dist-relative POSIX path, or `null` when the
 * request must be rejected (encoded `..`, absolute paths, backslashes, NUL).
 * The WHATWG URL parser already collapses literal `..` segments, but clients
 * can still send `%2e%2e`, `%5c` or `%00`; every unsafe shape is refused rather
 * than resolved.
 */
export function staticRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null;
    if (segment.includes('\0') || segment.includes('\\')) return null;
  }
  // Windows drive/absolute paths would otherwise escape through path.resolve.
  if (/^[A-Za-z]:/.test(segments[0]!)) return null;
  if (segments[0]!.startsWith('..')) return null;
  return segments.join('/');
}

/**
 * Resolves a dist-relative path inside `distDir`, refusing anything that
 * escapes it (defense in depth on top of `staticRelativePath`).
 */
export function resolveStaticFile(distDir: string, relativePath: string): string | null {
  const root = resolve(distDir);
  const candidate = resolve(root, ...relativePath.split('/'));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

/** Reads a regular file, or returns `null` when it does not exist/is a dir. */
export function readStaticFile(filePath: string): Buffer | null {
  try {
    if (!statSync(filePath).isFile()) return null;
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function fileExists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}
