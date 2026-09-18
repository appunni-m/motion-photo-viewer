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
const DIRS = ['src', 'docs'];

for (const file of FILES) await cp(join(ROOT, file), join(OUT, file));
for (const dir of DIRS) await cp(join(ROOT, dir), join(OUT, dir), { recursive: true });

// The wasm directory is listed rather than copied: it also holds the optimizer's
// intermediate, which is a build artifact and does not belong in the artifact.
await mkdir(join(OUT, 'wasm'), { recursive: true });
await cp(join(ROOT, 'wasm', 'motion_photo_wasm.wasm'), join(OUT, 'wasm', 'motion_photo_wasm.wasm'));
try {
  await cp(join(ROOT, 'wasm', 'BUILD.txt'), join(OUT, 'wasm', 'BUILD.txt'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
// Optional still decoders. Nothing is shipped there by default: the viewer runs
// without one, and `docs/DECODERS.md` describes what to drop in. Whatever is
// there is declared in the page, so the browser never probes for a file that was
// never installed - a 404 in every reader's console.
let installedDecoders = [];
try {
  if ((await stat(join(ROOT, 'decoders'))).isDirectory()) {
    await cp(join(ROOT, 'decoders'), join(OUT, 'decoders'), { recursive: true });
    installedDecoders = (await readdir(join(ROOT, 'decoders')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.replace(/\.js$/, ''));
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

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
  await writeFile(
    path,
    text.replaceAll('__BUILD_ID__', buildId).replaceAll('__DECODERS__', installedDecoders.join(',')),
  );
}

// Stamp the wasm reference so caches key on the artifact identity.
const wasmOnly = createHash('sha256').update(await readFile(join(OUT, 'wasm', 'motion_photo_wasm.wasm'))).digest('hex').slice(0, 8);
await writeFile(
  join(OUT, 'build.json'),
  `${JSON.stringify({ buildId, wasm: wasmOnly, built: new Date().toISOString() }, null, 2)}\n`,
);

process.stdout.write(`Pages artifact assembled at ${rel}/ (build ${buildId})\n`);
