import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
// Keep the workspace root in the log so a wrong cwd is obvious.
console.log(`[web] cleaned dist (${root})`);
