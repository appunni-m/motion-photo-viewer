/**
 * Assembles the static site that GitHub Pages serves.
 *
 * Only files the browser actually requests are copied, and every reference is
 * relative so the site works from a project subpath
 * (`/motion-photo-viewer/`) exactly as it does from a domain root.
 */

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requested = process.argv[2] ?? '_site';
const OUT = resolve(ROOT, requested);
const rel = relative(ROOT, OUT);

if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || OUT === ROOT) {
  throw new Error(`Pages output must be a child of the repository, not ${OUT}`);
}

try {
  if ((await stat(OUT)).isSymbolicLink()) throw new Error(`Pages output must not be a symlink: ${OUT}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const FILES = ['index.html', 'styles.css', 'sw.js'];
const DIRS = ['src', 'wasm', 'docs'];

for (const file of FILES) await cp(join(ROOT, file), join(OUT, file));
for (const dir of DIRS) await cp(join(ROOT, dir), join(OUT, dir), { recursive: true });
// The README's screenshots and the research log are repository material, not
// things a visitor's browser should ever download.
await rm(join(OUT, 'docs', 'screenshot.png'), { force: true });
await rm(join(OUT, 'docs', 'research'), { recursive: true, force: true });

// A build id derived from the shipped bytes: used for the service-worker cache
// name and as a cache-busting query so a new deploy is never served stale.
const hash = createHash('sha256');
async function digestDir(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await digestDir(full);
    else if (entry.isFile() && !entry.name.endsWith('.map')) hash.update(await readFile(full));
  }
}
for (const file of FILES) hash.update(await readFile(join(OUT, file)));
for (const dir of DIRS) await digestDir(join(OUT, dir));
const buildId = hash.digest('hex').slice(0, 12);

// Replace the build placeholder everywhere it appears.
for (const file of ['index.html', 'sw.js']) {
  const path = join(OUT, file);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replaceAll('__BUILD_ID__', buildId));
}

// Stamp the wasm reference so caches key on the artifact identity.
const wasmOnly = createHash('sha256').update(await readFile(join(OUT, 'wasm', 'motion_photo_wasm.wasm'))).digest('hex').slice(0, 8);
await writeFile(
  join(OUT, 'build.json'),
  `${JSON.stringify({ buildId, wasm: wasmOnly, built: new Date().toISOString() }, null, 2)}\n`,
);

process.stdout.write(`Pages artifact assembled at ${rel}/ (build ${buildId})\n`);
