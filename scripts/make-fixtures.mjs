/**
 * Real-media fixtures, built with ffmpeg.
 *
 * The rest of the suite runs on synthetic files whose bytes are known exactly.
 * This script adds genuinely encoded H.264 clips so the extraction can be
 * checked two ways that synthetic data cannot: byte-for-byte against the
 * original file, and by handing the result to ffprobe.
 *
 * Everything lands in tests/fixtures/generated/ and is safe to delete.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  concat, googleMotionXmp, heicGridOnly, heicWithMpvd, jpegShell, samsungHeicMpvdSeft,
  samsungHeicSefd, samsungMotionJpeg, samsungSeftJpeg, withExifOrientation, xmpApp1,
} from './synth.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'tests', 'fixtures', 'generated');

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args], { stdio: 'inherit' });
}

if (!hasFfmpeg()) {
  process.stdout.write('ffmpeg is not installed; skipping real-media fixtures\n');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const put = (name, bytes) => {
  writeFileSync(join(OUT, name), bytes);
  return { name, bytes: bytes.length };
};

process.stdout.write('generating real H.264 media with ffmpeg\n');

// A still image.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1', join(OUT, 'photo.jpg')]);

// A short clip whose `moov` is at the front: this is the shape that can be
// sliced out of a motion photo byte for byte.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  join(OUT, 'video-faststart.mp4'),
]);

// A bigger clip whose `moov` is at the end (ffmpeg's default), so the head and
// tail windows cannot both see the container: the sample-table rebuild has to
// take over.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=480x360:rate=30:duration=6',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  join(OUT, 'video-trailer.mp4'),
]);

// An HEVC clip, so the codec-string path is exercised with real HEVC media.
// Chrome and Edge decode HEVC only with platform support, so this is also the
// fixture that proves an unsupported codec is still *attempted*.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
  '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-tag:v', 'hvc1', '-movflags', '+faststart',
  join(OUT, 'video-hevc.mp4'),
]);

// A QuickTime companion, for the Live Photo pairing path.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  join(OUT, 'live.mov'),
]);

const photo = readFileSync(join(OUT, 'photo.jpg'));
const faststart = readFileSync(join(OUT, 'video-faststart.mp4'));
const trailer = readFileSync(join(OUT, 'video-trailer.mp4'));
const mov = readFileSync(join(OUT, 'live.mov'));
const hevc = readFileSync(join(OUT, 'video-hevc.mp4'));

const manifest = { generated: new Date().toISOString(), files: [] };

// 1. Samsung/Xiaomi shape: raw JPEG with the MP4 appended, no metadata at all.
//    The clip is short and faststart, so the whole container is inside the tail
//    window and extraction is a single verbatim slice.
put('motion-samsung-faststart.jpg', concat([photo, faststart]));
manifest.files.push({
  name: 'motion-samsung-faststart.jpg',
  kind: 'motion',
  family: 'samsung',
  expectBytes: 'video-faststart.mp4',
  note: 'JPEG + faststart MP4, no XMP: must be extracted byte for byte',
});

// 2. The same, but with the `moov` at the end and the clip too large for its
//    `ftyp` to be in a window: the sample-table rebuild has to reproduce the
//    sample data, which ffprobe then validates.
put('motion-samsung-trailer.jpg', concat([photo, trailer]));
manifest.files.push({
  name: 'motion-samsung-trailer.jpg',
  kind: 'motion',
  family: 'samsung',
  note: 'JPEG + trailer-moov MP4: the rebuilt file must still be a valid MP4',
});

// 3. Google Motion Photo 1.0: XMP container directory with exact lengths.
{
  const shell = concat([photo, new Uint8Array([0xff, 0xd9])]);
  const packet = (stillLen) =>
    googleMotionXmp({ stillLen, videoLen: faststart.length, timestampUs: 500000 });
  const build = (stillLen) =>
    concat([shell.slice(0, 2), xmpApp1(packet(stillLen)), shell.slice(2), faststart]);
  let file = build(0);
  file = build(file.length - faststart.length);
  put('motion-google.jpg', file);
  manifest.files.push({
    name: 'motion-google.jpg',
    kind: 'motion',
    family: 'google',
    expectBytes: 'video-faststart.mp4',
    note: 'Motion Photo 1.0 container directory',
  });
}

// 4. A Live Photo pair: two files, paired by name in the UI.
put('live.jpg', photo);
put('live.mov', mov);
manifest.files.push({ name: 'live.jpg', kind: 'still', note: 'pairs with live.mov' });
manifest.files.push({ name: 'live.mov', kind: 'video', note: 'companion video' });

// 5. Plain files that must not be mistaken for motion photos. Their names must
//    not share a stem, or the Live Photo pairing rule would (correctly) pair
//    them.
put('plain-video.mp4', faststart);
manifest.files.push({ name: 'plain-video.mp4', kind: 'video', note: 'a plain video file' });
put('plain-still.jpg', photo);
manifest.files.push({ name: 'plain-still.jpg', kind: 'still', note: 'a plain still' });

// 6. The shapes real cameras write, around genuinely encoded H.264.
//
//    Samsung ends its motion photos with a SEFT trailer, and Motion Photo 1.0
//    puts the video of a HEIC or AVIF still in a top-level `mpvd` box. Neither
//    is a HEIF item, so each shape gets its own fixture.
{
  const seft = samsungSeftJpeg({ video: trailer, image: photo });
  put('motion-samsung-seft.jpg', seft.file);
  manifest.files.push({
    name: 'motion-samsung-seft.jpg',
    kind: 'motion',
    family: 'samsung',
    expectBytes: 'video-trailer.mp4',
    note: 'SEFT trailer with the video inline, as a Galaxy device writes it',
  });

  const mpv2 = samsungSeftJpeg({ video: faststart, useMpv2: true, image: photo });
  put('motion-samsung-mpv2.jpg', mpv2.file);
  manifest.files.push({
    name: 'motion-samsung-mpv2.jpg',
    kind: 'motion',
    family: 'samsung',
    expectBytes: 'video-faststart.mp4',
    note: 'SEFT trailer whose MotionPhoto_Data block is an mpv2 pointer record',
  });

  const mpvd = heicWithMpvd({ video: trailer });
  put('motion-google-mpvd.heic', mpvd.file);
  manifest.files.push({
    name: 'motion-google-mpvd.heic',
    kind: 'motion',
    family: 'google',
    expectBytes: 'video-trailer.mp4',
    note: 'Motion Photo 1.0 mpvd box, the structure Google extracts',
  });

  const s22 = samsungHeicMpvdSeft({ video: trailer });
  put('motion-samsung-mpvd-sefd.heic', s22.file);
  manifest.files.push({
    name: 'motion-samsung-mpvd-sefd.heic',
    kind: 'motion',
    family: 'samsung',
    note: 'Samsung HEIC: mpvd holding [MP4][sefd] with an mpv2 record',
  });

  const sefd = samsungHeicSefd({ video: trailer });
  put('motion-samsung-sefd.heic', sefd.file);
  manifest.files.push({
    name: 'motion-samsung-sefd.heic',
    kind: 'motion',
    family: 'samsung',
    note: 'Samsung 2020 HEIC: a top-level sefd box carries the trailer',
  });
}

// 7. A synthetic HEIC with a video item, covering the item-based reading.
{
  const { heicWithItem, buildMp4 } = await import('./synth.mjs');
  const item = heicWithItem((offset) => buildMp4({ payload: 4096, moovAtFront: true, baseOffset: offset }).bytes);
  put('motion-heic-item.heic', item.file);
  manifest.files.push({
    name: 'motion-heic-item.heic',
    kind: 'motion',
    family: 'heif-item',
    note: 'HEIF video item resolved through iloc + cdsc',
  });
}

// 8. Landscape pictures that must be *displayed* as portrait ones: the EXIF
//    Orientation tag is the only thing that says so, and the grid tile and the
//    viewer have to agree about it.
//
//    Solid white, so a tile's painted area is exactly the rectangle it drew and
//    an orientation mistake cannot hide behind the test pattern's dark corners.
//
//    Two variants, because they take different paths through the viewer: one
//    where the tile is drawn from the full still, and one where it is drawn from
//    an IFD1 embedded preview that carries no orientation of its own.
{
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=640x480', '-frames:v', '1', '-q:v', '2', join(OUT, 'solid.jpg')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=96x72', '-frames:v', '1', '-q:v', '2', join(OUT, 'solid-thumb.jpg')]);
  const solid = readFileSync(join(OUT, 'solid.jpg'));
  const solidThumb = readFileSync(join(OUT, 'solid-thumb.jpg'));

  put('rotated-portrait.jpg', withExifOrientation(solid, 6));
  manifest.files.push({
    name: 'rotated-portrait.jpg',
    kind: 'still',
    orientation: 6,
    note: '640x480 that must display as 480x640, from the full still',
  });

  put('rotated-preview.jpg', withExifOrientation(solid, 6, solidThumb));
  manifest.files.push({
    name: 'rotated-preview.jpg',
    kind: 'still',
    orientation: 6,
    hasPreview: true,
    note: 'Orientation=6 with an unrotated IFD1 preview: the tile must rotate it',
  });
}

// 9. HEVC in a HEIC: the codec string must be valid RFC 6381, and playback must
//    be attempted rather than refused on the strength of canPlayType.
{
  const hevcHeic = heicWithMpvd({ video: hevc });
  put('motion-hevc.heic', hevcHeic.file);
  manifest.files.push({
    name: 'motion-hevc.heic',
    kind: 'motion',
    family: 'google',
    expectBytes: 'video-hevc.mp4',
    expectCodecPrefix: 'hvc1.1.',
    note: 'HEVC clip: valid codec string, and playback is always attempted',
  });
}

// 10. A plain HEIC: a grid of HEVC image tiles and no motion at all. Its tiles
//     are `hvc1` items with extents, which is exactly what a careless video-item
//     test mistakes for a clip.
{
  put('plain.heic', heicGridOnly({}).file);
  manifest.files.push({
    name: 'plain.heic',
    kind: 'still',
    note: 'HEVC image tiles only: must never be classified as motion',
  });
}

// 11. Something that is not media at all, to prove it is skipped, not parsed.
put('notes.txt', new TextEncoder().encode('not a picture\n'));
manifest.files.push({ name: 'notes.txt', kind: 'other' });

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const total = manifest.files.reduce((sum, f) => sum + (statSync(join(OUT, f.name)).isFile() ? statSync(join(OUT, f.name)).size : 0), 0);
process.stdout.write(`wrote ${manifest.files.length} fixture files (${(total / 1024).toFixed(0)} kB) to tests/fixtures/generated/\n`);
if (!existsSync(join(OUT, 'manifest.json'))) throw new Error('manifest missing');
