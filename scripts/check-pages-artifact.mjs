/**
 * Validates the assembled Pages artifact before it is uploaded.
 *
 * The checks encode the product promises: the site is self-contained (no
 * external origins, no absolute paths that would break under a project
 * subpath), it stays small enough to load instantly, and it ships the same
 * WebAssembly ABI the tests exercise.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = resolve(ROOT, process.argv[2] ?? '_site');

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
    else fail(`unexpected non-file entry: ${relative(SITE, full)}`);
  }
  return out;
}

const files = await walk(SITE);
const seen = new Set(files.map((f) => relative(SITE, f).split('\\').join('/')));

// --- required files --------------------------------------------------------
for (const required of [
  'index.html',
  'styles.css',
  'sw.js',
  'src/main.js',
  'src/worker.js',
  'src/wasm.js',
  'wasm/motion_photo_wasm.wasm',
  'build.json',
]) {
  if (!seen.has(required)) fail(`missing required file: ${required}`);
}

// --- nothing that should not ship ------------------------------------------
for (const name of seen) {
  if (name.endsWith('.map')) fail(`source map would ship: ${name}`);
  if (name.endsWith('.md') && !name.startsWith('docs/')) fail(`stray markdown: ${name}`);
  if (/(^|\/)(package\.json|Cargo\.toml|Cargo\.lock|Makefile)$/.test(name)) fail(`build input shipped: ${name}`);
}

// --- placeholder replacement ------------------------------------------------
const build = JSON.parse(await readFile(join(SITE, 'build.json'), 'utf8'));
if (!/^[0-9a-f]{12}$/.test(build.buildId)) fail(`bad build id: ${build.buildId}`);
for (const file of ['index.html', 'sw.js']) {
  const text = await readFile(join(SITE, file), 'utf8');
  if (text.includes('__BUILD_ID__')) fail(`${file} still contains the build placeholder`);
}
const swText = await readFile(join(SITE, 'sw.js'), 'utf8');
if (!swText.includes(build.buildId)) fail('sw.js does not carry the build id');

// --- the site must be self-contained ---------------------------------------
const textFiles = files.filter((f) => ['.html', '.css', '.js', '.json'].includes(extname(f)));
for (const file of textFiles) {
  const name = relative(SITE, file).split('\\').join('/');
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
    const url = match[0];
    if (/^https?:\/\/(ns\.|www\.w3\.org|adobe\.ns|ns\.google\.com)/.test(url)) continue;
    if (/^https?:\/\/(developer|github)\./.test(url)) continue;
    fail(`${name} references an external origin: ${url}`);
  }
  // Absolute paths break a project Pages site.
  for (const match of text.matchAll(/(?:src|href)\s*=\s*"(\/[^/][^"]*)"/g)) {
    fail(`${name} uses an absolute path: ${match[1]}`);
  }
}

// --- the module is the one the tests ran ------------------------------------
const wasm = await readFile(join(SITE, 'wasm', 'motion_photo_wasm.wasm'));
if (wasm.subarray(0, 4).toString('hex') !== '0061736d') fail('wasm magic number is wrong');
if (wasm.length > 200 * 1024) notes.push(`wasm is ${(wasm.length / 1024).toFixed(0)} kB`);
let module;
try {
  module = new WebAssembly.Module(wasm);
} catch (error) {
  fail(`wasm does not compile: ${error.message}`);
}
if (module) {
  const imports = WebAssembly.Module.imports(module);
  if (imports.length) fail(`wasm declares ${imports.length} imports; the app expects none`);
  const fns = WebAssembly.Module.exports(module).filter((e) => e.kind === 'function').map((e) => e.name).sort();
  const expected = ['mp_alloc', 'mp_free', 'mp_free_result', 'mp_prepare', 'mp_probe'];
  if (JSON.stringify(fns) !== JSON.stringify(expected)) fail(`wasm ABI mismatch: ${fns.join(', ')}`);
}

// --- the service worker caches only files that exist ------------------------
const shellBlock = swText.match(/const SHELL = \[([\s\S]*?)\]/);
if (!shellBlock) {
  fail('sw.js has no shell list');
} else {
  for (const ref of shellBlock[1].matchAll(/'([^']+)'/g)) {
    const entry = ref[1].replace(/^\.\//, '');
    if (entry === '' || entry === 'index.html') continue;
    if (!seen.has(entry)) fail(`service worker caches a file that is not shipped: ${ref[1]}`);
  }
}

// --- size budget -----------------------------------------------------------
let total = 0;
for (const file of files) total += (await stat(file)).size;
if (total > 3 * 1024 * 1024) fail(`artifact is ${(total / 1024 / 1024).toFixed(1)} MB, over the 3 MB budget`);
notes.push(`${files.length} files, ${(total / 1024).toFixed(0)} kB total`);
notes.push(`wasm sha256 ${createHash('sha256').update(wasm).digest('hex').slice(0, 16)}`);

if (problems.length) {
  process.stdout.write('Pages artifact check failed:\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(`Pages artifact check passed: ${notes.join('; ')}\n`);
