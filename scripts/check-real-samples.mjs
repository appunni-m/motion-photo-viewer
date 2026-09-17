/**
 * Checks the core against genuine camera files.
 *
 * Every other check in this repository runs on files this repository built, so
 * this one exists to close that gap: it downloads three real Samsung motion
 * photos from the public test data of `g0ddest/sm_motion_photo` (an MIT-licensed
 * Android library) and asserts the exact byte ranges that were recovered from
 * them by hand, with ExifTool and ffprobe.
 *
 * It needs the network, so it is deliberately *not* part of `make verify`. Run
 * it when changing detection code, or when adding support for a new device.
 *
 *   node scripts/check-real-samples.mjs [--dir /path/to/samples] [--local photo.jpg]
 *
 * `--local` checks one file of your own instead of the corpus. Add
 * `--expect <offset>:<length>` when you know the video's byte range - ExifTool
 * reports the length, and the offset can be recovered with
 * `exiftool -b -EmbeddedVideoFile file.jpg > v.mp4` plus a search for those
 * bytes - and the range is asserted exactly.
 *
 * The samples are large (17 MB in total) and stay in a temporary directory;
 * nothing is added to the repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MotionPhotoCore, mergeStages, planToBlob } from '../src/wasm.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const BASE = 'https://raw.githubusercontent.com/g0ddest/sm_motion_photo/HEAD/tests/data';

/**
 * The ground truth, recovered independently of this parser: the range of the
 * video inside each file, in bytes.
 */
const SAMPLES = [
  {
    name: 'photo.jpg',
    device: 'Galaxy S8 (SM-G950U)',
    expect: { container: 'jpeg', videoOff: 3366251, videoLen: 4647675, codec: 'avc1.640028', make: 'samsung' },
  },
  {
    name: 'photo.heic',
    device: 'Samsung 2020',
    expect: { container: 'heif', videoLen: 3005799, codecPrefix: 'hvc1' },
  },
  {
    name: 'photo-sg22-ultra.heic',
    device: 'Galaxy S22 Ultra',
    expect: { container: 'heif', videoLen: 2341602, codecPrefix: 'hvc1' },
  },
];

const problems = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const bad = (message) => {
  problems.push(message);
  process.stdout.write(`  FAIL  ${message}\n`);
};
const assertEqual = (actual, expected, what) => {
  if (actual === expected) ok(`${what}: ${actual}`);
  else bad(`${what}: got ${actual}, expected ${expected}`);
};

async function fetchSample(name, dir) {
  const path = join(dir, name);
  if (existsSync(path) && readFileSync(path).length > 1024) return path;
  process.stdout.write(`  ..    downloading ${name}\n`);
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`cannot download ${name}: ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

/** The bounded read loop the worker runs, over a local file. */
async function scan(core, bytes) {
  const size = bytes.length;
  const file = new File([bytes], 'sample');
  const stats = { reads: 0, bytesRead: 0 };
  const read = async (off, len) => {
    const buf = new Uint8Array(await file.slice(off, off + len).arrayBuffer());
    stats.reads += 1;
    stats.bytesRead += buf.length;
    return buf;
  };

  const whole = size <= 128 * 1024;
  let head = await read(0, whole ? size : 64 * 1024);
  let tail = whole ? new Uint8Array(0) : await read(size - 64 * 1024, 64 * 1024);
  let result = null;
  for (let pass = 0; pass < 6; pass += 1) {
    result = core.probe({ head, tail, fileSize: size });
    if (result.plan || !result.readMore) break;
    const more = result.readMore;
    if (more.target === 'head') {
      if (more.bytes <= head.length) break;
      head = await read(0, Math.min(more.bytes, size));
      continue;
    }
    if (more.target === 'tail') {
      if (more.bytes <= tail.length) break;
      tail = await read(size - Math.min(more.bytes, size), Math.min(more.bytes, size));
      continue;
    }
    if (more.target === 'window') {
      const off = more.off;
      const len = Math.min(more.bytes, size - off);
      const win = await read(off, len);
      result = mergeStages(
        result,
        core.prepare({
          region: { off: more.regionOff, len: more.regionLen },
          w1: { bytes: win, off },
          w2: tail.length ? { bytes: tail, off: size - tail.length } : null,
          fileSize: size,
        }),
      );
      if (result.plan || !result.readMore) break;
      continue;
    }
    break;
  }
  return { result, stats, file };
}

function ffprobeStreams(path) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height', '-of', 'json', path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(out).streams ?? [];
  } catch {
    return null;
  }
}

const localArg = args.indexOf('--local');
const expectArg = args.indexOf('--expect');
const dir = dirArg >= 0 ? resolve(args[dirArg + 1]) : mkdtempSync(join(tmpdir(), 'mpv-real-'));

const { instance } = await WebAssembly.instantiate(
  readFileSync(join(ROOT, 'wasm', 'motion_photo_wasm.wasm')),
  {},
);
const core = new MotionPhotoCore(instance.exports);

/** A file of the user's own, checked without the corpus expectations. */
if (localArg >= 0 && args[localArg + 1]) {
  const path = resolve(args[localArg + 1]);
  const bytes = new Uint8Array(readFileSync(path));
  process.stdout.write(`motion-photo-viewer real-camera check (local file)\n\n${path} (${bytes.length} bytes)\n`);
  const { result, stats, file } = await scan(core, bytes);
  const motion = result.motion ?? {};
  const expect = expectArg >= 0 && args[expectArg + 1] ? args[expectArg + 1].split(':').map(Number) : null;
  ok(`container ${result.container}, kind ${result.kind}`);
  ok(`route ${motion.method} (${motion.family}, ${motion.confidence})`);
  ok(`video ${JSON.stringify(motion.video)} of ${bytes.length} bytes`);
  if (motion.codec) ok(`codec ${motion.codec}`);
  ok(`camera ${[result.meta?.make, result.meta?.model].filter(Boolean).join(' ') || 'unknown'}`);
  ok(`read ${stats.bytesRead} bytes (${((stats.bytesRead / bytes.length) * 100).toFixed(1)}%) in ${stats.reads} reads`);
  if (motion.timestampUs) ok(`marker frame at ${(motion.timestampUs / 1e6).toFixed(3)}s`);
  if (expect) {
    assertEqual(motion.video?.off, expect[0], 'video offset');
    assertEqual(motion.video?.len, expect[1], 'video length');
  }
  if (result.plan) {
    const extracted = new Uint8Array(await planToBlob(file, result.plan).arrayBuffer());
    assertEqual(String.fromCharCode(...extracted.subarray(4, 8)), 'ftyp', 'extracted bytes start with ftyp');
    const out = join(dir, `${path.split('/').pop()}.extracted.mp4`);
    writeFileSync(out, extracted);
    const streams = ffprobeStreams(out);
    const video = streams?.find((s) => s.codec_type === 'video');
    if (video) ok(`ffprobe reads the extraction: ${video.codec_name} ${video.width}x${video.height}`);
    else if (streams === null) process.stdout.write('  ..    ffprobe not installed; skipped stream validation\n');
    else bad('ffprobe found no video stream in the extracted file');
    process.stdout.write(`  ..    extracted to ${out}\n`);
  } else {
    bad('no plan was produced');
  }
  process.stdout.write(problems.length ? `\n${problems.length} check(s) failed\n` : '\nall real-camera checks passed\n');
  process.exit(problems.length ? 1 : 0);
}
process.stdout.write(`motion-photo-viewer real-camera check (samples in ${dir})\n`);

for (const sample of SAMPLES) {
  let path;
  try {
    path = await fetchSample(sample.name, dir);
  } catch (error) {
    bad(`${sample.name}: ${error.message}`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  process.stdout.write(`\n${sample.name} — ${sample.device} (${bytes.length} bytes)\n`);

  const { result, stats, file } = await scan(core, bytes);
  const motion = result.motion ?? {};

  assertEqual(result.container, sample.expect.container, 'container');
  assertEqual(motion.playable, true, 'playable');
  if (sample.expect.videoOff !== undefined) {
    assertEqual(motion.video?.off, sample.expect.videoOff, 'video offset');
  }
  assertEqual(motion.video?.len, sample.expect.videoLen, 'video length');
  if (sample.expect.codec) assertEqual(motion.codec, sample.expect.codec, 'codec');
  if (sample.expect.codecPrefix) {
    if (String(motion.codec ?? '').startsWith(sample.expect.codecPrefix)) ok(`codec: ${motion.codec}`);
    else bad(`codec: got ${motion.codec}, expected a ${sample.expect.codecPrefix}* string`);
  }
  if (sample.expect.make) {
    const make = String(result.meta?.make ?? '').toLowerCase();
    if (make.includes(sample.expect.make)) ok(`camera: ${result.meta.make} ${result.meta.model ?? ''}`);
    else bad(`camera: got ${JSON.stringify(result.meta?.make)}, expected ${sample.expect.make}`);
  }
  if (motion.video) {
    ok(`route: ${motion.method} (${motion.family}, ${motion.confidence})`);
    ok(`read ${stats.bytesRead} of ${bytes.length} bytes (${((stats.bytesRead / bytes.length) * 100).toFixed(1)}%) in ${stats.reads} reads`);
  }

  // The extracted bytes must be a standalone MP4, and ffprobe must agree.
  if (result.plan) {
    const blob = planToBlob(file, result.plan);
    const extracted = new Uint8Array(await blob.arrayBuffer());
    const magic = String.fromCharCode(...extracted.subarray(4, 8));
    assertEqual(magic, 'ftyp', 'extracted bytes start with an ftyp box');
    assertEqual(result.plan.direct, true, 'a real camera file needs no rebuild');

    const out = join(dir, `${sample.name}.extracted.mp4`);
    writeFileSync(out, extracted);
    const streams = ffprobeStreams(out);
    if (streams === null) {
      process.stdout.write('  ..    ffprobe not installed; skipping stream validation\n');
    } else {
      const video = streams.find((s) => s.codec_type === 'video');
      if (video) ok(`ffprobe reads the extraction: ${video.codec_name} ${video.width}x${video.height}`);
      else bad('ffprobe found no video stream in the extracted file');

      // Compare with what ffmpeg decodes from the original file.
      const original = join(dir, `${sample.name}.original.mp4`);
      writeFileSync(original, bytes.subarray(motion.video.off, motion.video.off + motion.video.len));
      const originalStreams = ffprobeStreams(original);
      const originalVideo = originalStreams?.find((s) => s.codec_type === 'video');
      if (originalVideo) {
        assertEqual(video?.codec_name, originalVideo.codec_name, 'codec matches the original range');
        assertEqual(video?.width, originalVideo.width, 'width matches the original range');
        assertEqual(video?.height, originalVideo.height, 'height matches the original range');
      }
    }
  } else {
    bad(`no plan was produced (${JSON.stringify(motion)})`);
  }
}

process.stdout.write(problems.length ? `\n${problems.length} check(s) failed\n` : '\nall real-camera checks passed\n');
process.exit(problems.length ? 1 : 0);
