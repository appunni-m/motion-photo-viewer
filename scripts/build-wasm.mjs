/**
 * Builds the WebAssembly artifact that ships with the app.
 *
 * The module is produced from the Rust crate with a pinned toolchain, then
 * optionally run through `wasm-opt`. No wasm-bindgen and no JS glue: the crate
 * exports a raw C ABI, so the build is one `cargo build` and one file copy.
 *
 * Usage:
 *   node scripts/build-wasm.mjs           build and copy into wasm/
 *   node scripts/build-wasm.mjs --check   build and compare with the committed file
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = join(ROOT, 'target', 'wasm32-unknown-unknown', 'release', 'motion_photo_wasm.wasm');
const OUT_DIR = join(ROOT, 'wasm');
const OUT = join(OUT_DIR, 'motion_photo_wasm.wasm');
const CHECK = process.argv.includes('--check');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function which(binary) {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  });
}

mkdirSync(OUT_DIR, { recursive: true });

process.stdout.write('building the Rust crate for wasm32-unknown-unknown\n');
run('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown']);
if (!existsSync(TARGET)) throw new Error(`cargo produced no module at ${TARGET}`);

let bytes = readFileSync(TARGET);
process.stdout.write(`  cargo output: ${bytes.length} bytes (sha256 ${sha256(bytes).slice(0, 16)})\n`);

// wasm-opt is optional locally and required in the release build. The flags are
// deliberately conservative: shrink, drop metadata, no new proposals.
if (which('wasm-opt')) {
  const optimized = join(OUT_DIR, '.motion_photo_wasm.opt.wasm');
  run('wasm-opt', [
    '-Oz',
    '--strip-debug',
    '--strip-producers',
    '--strip-dwarf',
    '--vacuum',
    '--dce',
    '--enable-mutable-globals',
    '--enable-sign-ext',
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    TARGET,
    '-o',
    optimized,
  ]);
  const before = bytes.length;
  bytes = readFileSync(optimized);
  process.stdout.write(`  wasm-opt:     ${bytes.length} bytes (${before - bytes.length} saved)\n`);
} else if (process.env.WASM_OPT_REQUIRED === '1') {
  throw new Error('WASM_OPT_REQUIRED=1 but wasm-opt is not on PATH');
} else {
  process.stdout.write('  wasm-opt:     not installed, shipping the cargo output\n');
}

const digest = sha256(bytes);

if (CHECK && existsSync(OUT)) {
  const committed = readFileSync(OUT);
  const committedDigest = sha256(committed);
  if (committedDigest !== digest) {
    process.stdout.write(
      `\nthe committed wasm differs from a fresh build\n` +
        `  committed: ${committed.length} bytes ${committedDigest.slice(0, 16)}\n` +
        `  rebuilt:   ${bytes.length} bytes ${digest.slice(0, 16)}\n` +
        `Run \`make wasm\` and commit wasm/motion_photo_wasm.wasm.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('the committed wasm matches a fresh build\n');
  }
  process.exit(process.exitCode ?? 0);
}

writeFileSync(OUT, bytes);
writeFileSync(
  join(OUT_DIR, 'BUILD.txt'),
  [
    `artifact: wasm/motion_photo_wasm.wasm`,
    `bytes: ${bytes.length}`,
    `sha256: ${digest}`,
    `built: ${statSync(TARGET).mtime.toISOString()}`,
    '',
    'Rebuild with `make wasm`. The Pages workflow rebuilds from source and uses',
    'that fresh module, so this file is a convenience for local development.',
    '',
  ].join('\n'),
);

process.stdout.write(`wrote ${OUT.replace(`${ROOT}/`, '')} (${bytes.length} bytes)\n`);
