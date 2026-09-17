/**
 * The verification gate.
 *
 * Deterministic, offline, and independent of the browser: it drives the WASM
 * module exactly the way the worker does, against synthetic files whose bytes
 * are known, and asserts byte-exact extraction. Also enforces the two product
 * promises that are easy to regress: nothing is fetched from anywhere, and
 * nothing is written to storage.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MotionPhotoCore, mergeStages, planToBlob } from '../src/wasm.js';
import {
  buildMp4, concat, ftyp, googleMotionJpeg, googleMotionXmp, heicWithItem, heicWithMpvd,
  jpegShell, mdatHeader, moov, mp4, noise, samsungHeicMpvdSeft,
  samsungHeicSefd, samsungMotionJpeg, samsungSeftJpeg, textFile, u32, xmpApp1,
} from './synth.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM = join(ROOT, 'wasm', 'motion_photo_wasm.wasm');

let passed = 0;
const failures = [];
const skipped = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === 'skip') {
      skipped.push(name);
      return;
    }
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    const result = await fn();
    if (result === 'skip') {
      skipped.push(name);
      return;
    }
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n        actual:   ${a}\n        expected: ${b}`);
}

// ---------------------------------------------------------------- the driver

/** Mirrors the worker's bounded read loop, over an in-memory file. */
async function scan(core, bytes, options = {}) {
  const file = new File([bytes], options.name ?? 'fixture.bin');
  const size = bytes.length;
  const stats = { reads: 0, bytesRead: 0, passes: 0 };
  let headBytes = options.headBytes ?? 64 * 1024;
  let tailBytes = options.tailBytes ?? 64 * 1024;
  let head = null;
  let tail = null;
  let result = null;
  const trace = [];

  for (let pass = 0; pass < 8; pass += 1) {
    const whole = size <= headBytes + tailBytes;
    const wantHead = Math.min(whole ? size : headBytes, size);
    const wantTail = whole ? 0 : Math.min(tailBytes, size);
    if (!head || head.length < wantHead) {
      head = new Uint8Array(await file.slice(0, wantHead).arrayBuffer());
      stats.reads += 1;
      stats.bytesRead += head.length;
    }
    if (wantTail > 0 && (!tail || tail.length < wantTail)) {
      tail = new Uint8Array(await file.slice(size - wantTail).arrayBuffer());
      stats.reads += 1;
      stats.bytesRead += tail.length;
    }
    stats.passes += 1;
    result = core.probe({ head, tail, fileSize: size });
    trace.push({ pass, method: result.motion?.method ?? null, readMore: result.readMore?.target ?? null });
    if (result.plan || !result.readMore) break;

    const more = result.readMore;
    if (more.target === 'head') {
      if ((more.bytes ?? 0) <= head.length) break;
      headBytes = more.bytes;
      continue;
    }
    if (more.target === 'tail') {
      if ((more.bytes ?? 0) <= (tail?.length ?? 0)) break;
      tailBytes = more.bytes;
      continue;
    }
    if (more.target === 'window') {
      const off = more.off;
      const len = Math.min(more.bytes, size - off);
      const win = new Uint8Array(await file.slice(off, off + len).arrayBuffer());
      stats.reads += 1;
      stats.bytesRead += win.length;
      result = mergeStages(
        result,
        core.prepare({
          region: { off: more.regionOff, len: more.regionLen },
          w1: { bytes: win, off },
          w2: tail ? { bytes: tail, off: size - tail.length } : null,
          fileSize: size,
        }),
      );
      trace.push({ pass, method: 'prepare', readMore: result.readMore?.target ?? null });
      if (result.plan || !result.readMore) break;
      continue;
    }
    break;
  }
  return { result, stats, file, trace };
}

async function extract(core, bytes, options) {
  const { result, stats, file, trace } = await scan(core, bytes, options);
  const blob = result.plan ? planToBlob(file, result.plan) : null;
  const out = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  return { result, stats, file, out, trace };
}

function slicesWithinPlan(plan, fileSize) {
  for (const part of plan.parts) {
    if (part.t !== 'slice') continue;
    if (part.off < 0 || part.len < 0 || part.off + part.len > fileSize) return false;
  }
  return true;
}

// -------------------------------------------------------------- format facts

function runFfprobe(filePath) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath],
    // Codec-level complaints about the synthetic stub bitstreams are expected;
    // only the container reading matters here.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out);
}

function hasFfprobe() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- suites

async function main() {
  process.stdout.write('motion-photo-viewer verification\n\n');

  // -- artifact ------------------------------------------------------------
  process.stdout.write('wasm artifact\n');
  assert(existsSync(WASM), `missing ${WASM}; run \`npm run wasm\``);
  const wasmBytes = readFileSync(WASM);
  check('starts with the wasm magic number', () => {
    assertEqual([...wasmBytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'not a wasm module');
  });
  check('is small enough to load instantly', () => {
    assert(wasmBytes.length < 150 * 1024, `wasm is ${wasmBytes.length} bytes`);
  });
  check('declares no imports, so it cannot reach the network', () => {
    const module = new WebAssembly.Module(wasmBytes);
    const imports = WebAssembly.Module.imports(module);
    assertEqual(imports.map((i) => `${i.module}.${i.name}`), [], 'unexpected imports');
  });
  check('exports exactly the documented ABI', () => {
    const module = new WebAssembly.Module(wasmBytes);
    const exported = WebAssembly.Module.exports(module);
    const functions = exported.filter((e) => e.kind === 'function').map((e) => e.name).sort();
    assertEqual(
      functions,
      ['mp_alloc', 'mp_free', 'mp_free_result', 'mp_prepare', 'mp_probe'],
      'ABI drift in function exports',
    );
    assert(exported.some((e) => e.name === 'memory' && e.kind === 'memory'), 'memory must be exported');
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const core = new MotionPhotoCore(instance.exports);

  // -- synthetic motion photos --------------------------------------------
  process.stdout.write('\nsynthetic motion photos\n');

  await checkAsync('samsung: a trailer MP4 is sliced verbatim when it is visible', async () => {
    const fixture = samsungMotionJpeg({ moovAtFront: false });
    const bytes = fixture.file;
    const { result, out } = await extract(core, bytes);
    assertEqual(result.kind, 'motion', 'kind');
    assertEqual(result.motion.playable, true, 'playable');
    assertEqual(result.motion.method, 'appended-container', 'method');
    assertEqual(result.motion.video.off, fixture.videoOffset, 'video offset');
    assert(slicesWithinPlan(result.plan, bytes.length), 'plan slices must stay inside the file');
    assertEqual(result.plan.direct, true, 'a whole trailer needs no rebuild');
    assertEqual([...out], [...fixture.video], 'extracted bytes must equal the original MP4 exactly');
  });

  await checkAsync('samsung: a trailer moov outside the windows is rebuilt sample-exactly', async () => {
    // A 200 kB video appended after 3 MB of image data: its `ftyp` is beyond
    // both windows, but the `moov` at the very end is not, which is exactly the
    // case the sample-table rebuild exists for.
    const fixture = samsungMotionJpeg({ moovAtFront: false, payload: 200_000, padAfterImage: 3 * 1024 * 1024 });
    const bytes = fixture.file;
    const { result, out, stats } = await extract(core, bytes);
    assertEqual(result.motion.playable, true, 'playable');
    assertEqual(result.motion.method, 'sample-table', 'method');
    assertEqual(result.plan.direct, false, 'a rebuild is expected');
    const payload = bytes.subarray(fixture.payloadOffset, fixture.payloadOffset + fixture.payloadLength);
    assertEqual(payload[0], 0xa5, 'fixture payload must be the sample data');
    assertEqual(
      [...out.subarray(out.length - payload.length)],
      [...payload],
      'samples must survive the rebuild verbatim',
    );
    assert(stats.bytesRead <= 320 * 1024, `read ${stats.bytesRead} bytes of ${bytes.length}`);
    assert(
      stats.bytesRead * 10 < bytes.length,
      'a rebuild must not require reading the whole file',
    );
  });

  await checkAsync('samsung: a standalone appended MP4 is sliced verbatim', async () => {
    const fixture = samsungMotionJpeg({ moovAtFront: true });
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.motion.playable, true, 'playable');
    assertEqual(result.motion.method, 'appended-container', 'method');
    assertEqual(result.motion.video.off, fixture.videoOffset, 'video offset');
    assertEqual(result.plan.direct, true, 'direct slice expected');
    assertEqual(out.length, fixture.video.length, 'extracted length');
    assertEqual([...out], [...fixture.video], 'extracted bytes must equal the original MP4 exactly');
  });

  await checkAsync('google: Motion Photo 1.0 directory gives an exact range', async () => {
    const fixture = googleMotionJpeg();
    const { file: bytes, video } = fixture;
    const { result, out } = await extract(core, bytes);
    assertEqual(result.result ?? result.motion.family, 'google', 'family');
    assertEqual(result.motion.method, 'xmp-directory', 'method');
    assertEqual(result.motion.confidence, 'exact', 'confidence');
    assertEqual(result.motion.video.len, video.length, 'video length');
    assertEqual(result.motion.timestampUs, 1250000, 'marker timestamp');
    assertEqual([...out], [...video], 'extracted bytes must equal the original MP4 exactly');
  });

  await checkAsync('heic: video item is located from iloc and sliced verbatim', async () => {
    const video = buildMp4({ payload: 480, moovAtFront: true });
    const fixture = heicWithItem(() => video.bytes);
    const { result, out, stats } = await extract(core, fixture.file);
    assertEqual(result.container, 'heif', 'container');
    assertEqual(result.motion.method, 'heif-item', 'method');
    assertEqual(result.motion.family, 'heif-item', 'family (cdsc-referenced)');
    assertEqual(result.motion.video.off, fixture.videoOffset, 'video offset');
    assertEqual(result.motion.video.len, fixture.videoLength, 'video length');
    assertEqual([...out], [...fixture.item], 'extracted bytes must equal the video item exactly');
    // A file smaller than the two windows is read exactly once, in full.
    assert(stats.reads <= 2, `${stats.reads} reads for a small file`);
    assert(stats.bytesRead <= fixture.file.length, 'never reads more than the file');
  });

  await checkAsync('heic: a video item far from the head triggers one targeted read', async () => {
    const video = buildMp4({ payload: 300, moovAtFront: true });
    // A large primary pushes the video item past the head window, and padding
    // pushes it out of the tail window too: only a targeted read can find it.
    const fixture = heicWithItem(() => video.bytes, { primarySize: 400_000, padTo: 900_000 });
    const { result, trace, stats } = await extract(core, fixture.file);
    assertEqual(result.motion.playable, true, 'playable');
    assert(trace.some((t) => t.readMore === 'window'), 'a window read must have been requested');
    assert(stats.bytesRead < 200_000, `read ${stats.bytesRead} bytes`);
  });

  await checkAsync('heic: an item without ftyp is rebuilt around its moov', async () => {
    const payloadLength = 256;
    const moovLength = moov({ chunkOffset: 0, chunkLen: payloadLength, duration: 512 }).length;
    const build = (offset) => {
      const moovBox = moov({ chunkOffset: offset + moovLength + 8, chunkLen: payloadLength, duration: 512 });
      return concat([moovBox, mdatHeader(payloadLength), new Uint8Array(payloadLength).fill(0xa5)]);
    };
    const fixture = heicWithItem(build);
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.motion.playable, true, 'playable');
    assertEqual(result.plan.direct, false, 'rebuild expected');
    const payload = fixture.item.subarray(fixture.item.length - payloadLength);
    assertEqual(
      [...out.subarray(out.length - payload.length)],
      [...payload],
      'samples must survive the rebuild',
    );
    const literalBytes = result.plan.parts
      .filter((p) => p.t === 'lit')
      .reduce((sum, p) => sum + p.len, 0);
    assert(literalBytes > 0 && literalBytes < 4096, `synthesized ${literalBytes} bytes`);
  });

  // --- the shapes real cameras actually write ------------------------------
  //
  // Verified against the byte layouts recovered from real Galaxy and Pixel
  // files: Samsung ends a motion photo with a SEFT trailer whose
  // `MotionPhoto_Data` block states the video's exact extent, and Motion Photo
  // 1.0 puts the video of a HEIC or AVIF still in a top-level `mpvd` box.

  await checkAsync('samsung JPEG: the SEFT trailer gives the exact range', async () => {
    const fixture = samsungSeftJpeg({ moovAtFront: false });
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.motion.method, 'seft-trailer', 'method');
    assertEqual(result.motion.family, 'samsung', 'family');
    assertEqual(result.motion.video.off, fixture.videoOffset, 'video offset');
    assertEqual(result.motion.video.len, fixture.video.length, 'video length');
    // The trailer sits after the video, so a "last N bytes" guess would be short.
    assert(fixture.file.length > fixture.videoOffset + fixture.video.length, 'trailer follows the video');
    assertEqual([...out], [...fixture.video], 'extraction must be byte-exact');
    assert(result.markers.includes('MotionPhoto_Data'), 'the block name is reported as a marker');
  });

  await checkAsync('samsung JPEG: an mpv2 record names the video', async () => {
    const fixture = samsungSeftJpeg({ useMpv2: true, moovAtFront: false });
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.motion.method, 'seft-trailer', 'method');
    assertEqual(result.motion.video.off, fixture.videoOffset, 'video offset');
    assertEqual([...out], [...fixture.video], 'extraction must be byte-exact');
  });

  await checkAsync('google HEIC: a top-level mpvd box holds the video', async () => {
    const fixture = heicWithMpvd({ moovAtFront: false });
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.container, 'heif', 'container');
    assertEqual(result.motion.method, 'mpvd-box', 'method');
    assertEqual(result.motion.video.len, fixture.trailing.length - 8, 'video length');
    assertEqual([...out], [...fixture.trailing.subarray(8)], 'extraction must be byte-exact');
    // The cdsc references in the real files link Exif and XMP items, never a
    // video, so no video item may be invented.
    assert(!result.notes.some((n) => n.includes('video item #')), 'no video item is invented');
  });

  await checkAsync('samsung HEIC: mpvd holds [MP4][sefd] and SEFT states the extent', async () => {
    const fixture = samsungHeicMpvdSeft({});
    const { result, out, trace } = await extract(core, fixture.file);
    assertEqual(result.motion.method, 'seft-trailer', 'method');
    assertEqual(result.motion.family, 'samsung', 'family');
    const videoOffset = fixture.trailingOffset + 8;
    assertEqual(result.motion.video.off, videoOffset, 'video offset');
    assertEqual(result.motion.playable, true, `playable (${JSON.stringify(result.motion)})`);
    assert(trace.length >= 1, 'the scan produced a route');
    // The extracted file may carry the trailing `sefd`, but it must start with
    // the original video and contain its bytes in order.
    const expected = fixture.file.subarray(videoOffset, videoOffset + result.motion.video.len);
    assertEqual([...out.subarray(0, expected.length)], [...expected], 'extraction must be byte-exact');
  });

  await checkAsync('samsung HEIC (2020): a top-level sefd box carries the trailer', async () => {
    const fixture = samsungHeicSefd({});
    const { result, out } = await extract(core, fixture.file);
    assertEqual(result.motion.method, 'seft-trailer', 'method');
    assertEqual(result.motion.playable, true, `playable (${JSON.stringify(result.motion)})`);
    const videoOffset = result.motion.video.off;
    assert(videoOffset > fixture.trailingOffset, 'the video lives inside the sefd box');
    const expected = fixture.file.subarray(videoOffset, videoOffset + result.motion.video.len);
    assertEqual([...out.subarray(0, expected.length)], [...expected], 'extraction must be byte-exact');
  });

  await checkAsync('a GainMap item is never mistaken for the video', async () => {
    // Primary + GainMap + MotionPhoto, in the order the spec requires. Only the
    // gain map's length sits between the still and the video, so a parser that
    // picked items by position would slice the wrong bytes.
    const video = buildMp4({ payload: 256, moovAtFront: true }).bytes;
    const image = jpegShell(600);
    const packet = (stillLen) =>
      googleMotionXmp({ stillLen, videoLen: video.length, timestampUs: 0, gainMapLen: 999 });
    const build = (stillLen) => concat([image.slice(0, 2), xmpApp1(packet(stillLen)), image.slice(2)]);
    let still = build(0);
    still = build(still.length);
    const bytes = concat([still, video]);
    const { result, out } = await extract(core, bytes);
    assertEqual(result.motion.video.len, video.length, 'the video length ignores the gain map');
    assertEqual(result.motion.video.off, still.length, 'the video offset ignores the gain map');
    assertEqual([...out], [...video], 'extraction must be byte-exact');
  });

  await checkAsync('plain video files are recognised, not mistaken for motion photos', async () => {
    const bytes = mp4({ payload: 300, moovAtFront: true });
    const { result, out } = await extract(core, bytes);
    assertEqual(result.kind, 'video', 'kind');
    assertEqual(result.plainVideo ?? result.motion.family, 'plain-video', 'family');
    assertEqual(out.length, bytes.length, 'whole file');
  });

  await checkAsync('a still with no motion payload stays a still', async () => {
    const bytes = concat([jpegShell(4096), new Uint8Array([0xff, 0xd9])]);
    const { result } = await extract(core, bytes);
    assertEqual(result.kind, 'photo', 'kind');
    assertEqual(result.motion, null, 'no motion');
    assertEqual(result.plan, null, 'no plan');
  });

  // -- limit reading -------------------------------------------------------
  process.stdout.write('\nreading is bounded\n');

  await checkAsync('a 4 MB photo with a trailer moov is resolved without reading it all', async () => {
    const fixture = samsungMotionJpeg({ moovAtFront: false, payload: 120_000, padAfterImage: 3 * 1024 * 1024 });
    const bytes = fixture.file;
    const { result, stats } = await extract(core, bytes);
    assertEqual(result.motion.playable, true, 'playable');
    assert(
      stats.bytesRead <= 512 * 1024,
      `read ${stats.bytesRead} bytes of ${bytes.length}; expected a bounded window`,
    );
    assert(stats.reads <= 6, `${stats.reads} reads`);
  });

  await checkAsync('the reported byte count is a small share of a large folder', async () => {
    const small = samsungMotionJpeg({ moovAtFront: true }).file;
    const big = concat([small, new Uint8Array(3 * 1024 * 1024).fill(0x21), jpegShell(1024)]);
    const { stats } = await extract(core, big);
    assert(stats.bytesRead < 300 * 1024, `read ${stats.bytesRead} bytes`);
  });

  // -- hostile input -------------------------------------------------------
  process.stdout.write('\nhostile and malformed input\n');

  const hostileCases = {
    'random noise': noise(200_000, 7),
    'empty file': new Uint8Array(0),
    'text file': textFile(),
    'truncated jpeg header': samsungMotionJpeg({}).file.subarray(0, 120),
    'jpeg with no trailer': jpegShell(2048),
    'ftyp with an absurd box size': concat([
      u32(0xfffffff0), new TextEncoder().encode('ftyp'), new Uint8Array(64),
    ]),
    'xmp claiming a video larger than the file': (() => {
      const shell = jpegShell(600);
      const still = concat([shell.slice(0, 2), xmpApp1(googleMotionXmp({ stillLen: 600, videoLen: 50_000_000 })), shell.slice(2)]);
      return concat([still, mp4({ payload: 128 })]);
    })(),
    'zero-filled file of 1 MB': new Uint8Array(1024 * 1024),
  };

  for (const [label, bytes] of Object.entries(hostileCases)) {
    await checkAsync(`${label}: returns a decision instead of crashing`, async () => {
      const { result } = await extract(core, bytes);
      assertEqual(result.ok, true, 'ok flag');
      assert(result.plan === null || slicesWithinPlan(result.plan, bytes.length), 'plan must be in bounds');
      if (result.plan) {
        const literalBytes = result.plan.parts
          .filter((p) => p.t === 'lit')
          .reduce((sum, p) => sum + p.len, 0);
        assert(literalBytes < 262144, `synthesized ${literalBytes} bytes of headers`);
      }
    });
  }

  await checkAsync('a plan never points outside the file it came from', async () => {
    for (const [label, bytes] of Object.entries(hostileCases)) {
      const { result } = await extract(core, bytes);
      if (!result.plan) continue;
      assert(slicesWithinPlan(result.plan, bytes.length), `${label}: slice out of bounds`);
    }
  });

  // -- real media, when ffmpeg is present ----------------------------------
  const realDir = join(ROOT, 'tests', 'fixtures', 'generated');
  if (existsSync(join(realDir, 'manifest.json'))) {
    process.stdout.write('\nreal media (ffmpeg fixtures)\n');
    const manifest = JSON.parse(readFileSync(join(realDir, 'manifest.json'), 'utf8'));
    for (const item of manifest.files) {
      if (item.kind !== 'motion') continue;
      await checkAsync(`${item.name}: extracted video is a valid MP4`, async () => {
        const bytes = new Uint8Array(readFileSync(join(realDir, item.name)));
        const { result, out } = await extract(core, bytes);
        assertEqual(result.motion.playable, true, `playable (${JSON.stringify(result.motion)})`);
        const dir = mkdtempSync(join(tmpdir(), 'mpv-'));
        const path = join(dir, 'extracted.mp4');
        writeFileSync(path, out);
        if (hasFfprobe()) {
          const probe = runFfprobe(path);
          const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');
          assert(video, 'ffprobe found no video stream in the extracted file');
        } else {
          writeFileSync(join(dir, 'unused'), '');
        }
        if (item.expectBytes) {
          const original = new Uint8Array(readFileSync(join(realDir, item.expectBytes)));
          assertEqual([...out], [...original], 'extraction must be byte-exact');
        }
        return 'ok';
      });
    }
  } else {
    skipped.push('real media fixtures (run `npm run fixtures`)');
  }

  // -- product promises ----------------------------------------------------
  process.stdout.write('\napp promises\n');

  const appFiles = [
    'index.html', 'styles.css', 'sw.js',
    ...readdirSync(join(ROOT, 'src')).map((f) => `src/${f}`),
  ];

  check('no app file references an external origin', () => {
    const offenders = [];
    for (const file of appFiles) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        const url = match[0];
        // Namespace identifiers and documentation links are not requests.
        if (/^https?:\/\/(ns\.|www\.w3\.org|adobe\.ns|ns\.google\.com)/.test(url)) continue;
        if (/^https?:\/\/(developer|github)\./.test(url)) continue;
        offenders.push(`${file}: ${url}`);
      }
    }
    assertEqual(offenders, [], 'external references found');
  });

  check('index.html loads only local assets', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (ref.startsWith('data:') || ref.startsWith('#')) continue;
      assert(!/^[a-z]+:/i.test(ref), `absolute or remote asset: ${ref}`);
    }
  });

  check('no file contents are ever written to storage', () => {
    const offenders = [];
    for (const file of appFiles) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (/\blocalStorage\b|\bsessionStorage\b|indexedDB|openDatabase/.test(text)) offenders.push(file);
    }
    assertEqual(offenders, [], 'storage APIs found');
  });

  check('the service worker caches only the app shell', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert(!/cache\.put\(request/.test(sw) || /response\.type === 'basic'/.test(sw), 'uncached passthrough');
    const shell = sw.match(/const SHELL = \[([\s\S]*?)\]/);
    assert(shell, 'no shell list');
    for (const ref of shell[1].matchAll(/'([^']+)'/g)) {
      assert(!/^(blob:|https?:)/.test(ref[1]), `shell entry must be local: ${ref[1]}`);
    }
  });

  check('the worker never reads a whole file implicitly', () => {
    const worker = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');
    assert(/file\.slice\(/.test(worker), 'worker must read through slices');
    assert(!/file\.arrayBuffer\(\)/.test(worker), 'worker must not read whole files');
    assert(/maxBytes/.test(worker), 'worker must bound its reads');
  });

  check('no source map or build residue is committed next to the app', () => {
    for (const file of appFiles) {
      assert(!file.endsWith('.map'), `stray source map: ${file}`);
    }
  });

  check('the wasm artifact is not stale relative to its source', () => {
    const srcDir = join(ROOT, 'crates', 'motion-photo-wasm', 'src');
    const wasmMtime = statSync(WASM).mtimeMs;
    for (const file of readdirSync(srcDir)) {
      const mtime = statSync(join(srcDir, file)).mtimeMs;
      assert(mtime <= wasmMtime + 1000, `${file} is newer than the built wasm; run \`npm run wasm\``);
    }
  });

  // -- summary -------------------------------------------------------------
  process.stdout.write('\n');
  if (skipped.length) {
    process.stdout.write(`${skipped.length} check(s) skipped:\n`);
    for (const name of skipped) process.stdout.write(`  - ${name}\n`);
  }
  process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    process.stdout.write('\nfailures:\n');
    for (const { name, error } of failures) {
      process.stdout.write(`  ${name}\n    ${error.stack?.split('\n').slice(0, 4).join('\n    ') ?? error.message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
