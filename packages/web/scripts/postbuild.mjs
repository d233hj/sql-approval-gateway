/**
 * Post-build: copy the static shell next to the tsc output and enforce the
 * security invariants this SPA promises. Runs in the npm build script after
 * `tsc -p tsconfig.json` (which emits dist/src/*.js).
 */
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');

const staticFiles = ['index.html', 'styles.css', 'public/assets/favicon.svg'];

const forbidden = [
  {
    pattern: /\b(?:localStorage|sessionStorage|indexedDB)\s*(?:\.|\[)/,
    label: 'browser persistence API',
  },
  {
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/,
    label: 'HTML injection sink',
  },
  { pattern: /\beval\s*\(|new\s+Function\s*\(/, label: 'code evaluation' },
  { pattern: /https?:\/\/(?!127\.0\.0\.1|localhost)/, label: 'external URL' },
];

async function listSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSources(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

const sourceFiles = [
  path.join(root, 'index.html'),
  path.join(root, 'styles.css'),
  ...(await listSources(path.join(root, 'src'))),
];

const failures = [];
for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      failures.push(`${path.relative(root, file)}: ${rule.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[web] security invariant check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

await mkdir(path.join(dist, 'assets'), { recursive: true });
for (const relative of staticFiles) {
  const from = path.join(root, relative);
  const to = relative.startsWith('public/')
    ? path.join(dist, relative.slice('public/'.length))
    : path.join(dist, path.basename(relative));
  await cp(from, to);
}

try {
  await stat(path.join(dist, 'src', 'main.js'));
} catch {
  console.error('[web] dist/src/main.js is missing — did tsc fail?');
  process.exit(1);
}

const files = ['index.html', 'styles.css', 'assets/favicon.svg', 'src/main.js'];
console.log('[web] build complete:');
for (const relative of files) {
  const info = await stat(path.join(dist, relative));
  console.log(`  dist/${relative}  ${info.size} B`);
}
