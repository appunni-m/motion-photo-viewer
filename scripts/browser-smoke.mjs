/**
 * Headless browser smoke test.
 *
 * Drives the real page against the real fixtures in Chromium, and enforces the
 * one promise that can only be checked in a browser: that the app never talks
 * to anything but its own origin. A request to any other host fails the run.
 *
 * Usage:
 *   node scripts/browser-smoke.mjs [--root _site] [--screenshot docs/screenshot.png]
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const SITE = resolve(ROOT, argOf('--root', existsSync(join(ROOT, '_site')) ? '_site' : '.'));
const SCREENSHOT = argOf('--screenshot', '');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'generated');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

const problems = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const bad = (message) => {
  problems.push(message);
  process.stdout.write(`  FAIL  ${message}\n`);
};
const assert = (condition, message) => (condition ? ok(message) : bad(message));

if (!existsSync(FIXTURES)) {
  process.stdout.write('no fixtures: run `npm run fixtures` first\n');
  process.exit(0);
}

// ---------------------------------------------------------------- the server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith('/')) path += 'index.html';
  const full = join(SITE, path);
  if (!full.startsWith(SITE)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ browser
let browser;
try {
  // Prefer an installed Chrome: it decodes H.264, which lets the smoke test
  // assert real playback rather than just blob assembly.
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const external = [];
const consoleErrors = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
});
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

process.stdout.write(`motion-photo-viewer browser smoke test (${SITE.replace(`${ROOT}/`, '')})\n`);

try {
  await page.goto(`${origin}/index.html`, { waitUntil: 'load' });

  // The module must be reachable and the shell must render before anything else.
  assert(await page.locator('#dropzone').isVisible(), 'the drop zone renders');
  await page.waitForFunction(() => 'serviceWorker' in navigator, null, { timeout: 5000 }).catch(() => {});

  // The WASM core is loaded through the worker; a fetch of the module proves the
  // app reached it without any bundler.
  const wasmFetched = await page.evaluate(async () => {
    const response = await fetch('wasm/motion_photo_wasm.wasm');
    const buffer = await response.arrayBuffer();
    const module = await WebAssembly.compile(buffer);
    return { bytes: buffer.byteLength, imports: WebAssembly.Module.imports(module).length };
  });
  assert(wasmFetched.bytes > 1000, `the wasm module loads in the page (${wasmFetched.bytes} bytes)`);
  assert(wasmFetched.imports === 0, 'the wasm module needs no host imports');

  // ---- scan a folder ------------------------------------------------------
  // Hand the whole fixture directory to the folder picker: this walks the real
  // `webkitdirectory` path, including files that must be skipped.
  await page.setInputFiles('#folder-input', FIXTURES);
  await page.waitForSelector('.tile', { timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector('#cancel-scan') || document.querySelector('#cancel-scan').hidden,
    null,
    { timeout: 30000 },
  );

  const summary = await page.evaluate(() => ({
    motion: Number(document.getElementById('stat-motion').textContent),
    live: Number(document.getElementById('stat-live').textContent),
    stills: Number(document.getElementById('stat-stills').textContent),
    videos: Number(document.getElementById('stat-videos').textContent),
    bytes: document.getElementById('stat-bytes').textContent,
    bytesLabel: document.getElementById('stat-bytes-label').textContent,
    tiles: document.querySelectorAll('.tile').length,
  }));

  const progress = await page.locator('#progress-text').textContent();
  const notes = await page.locator('#scan-notes').textContent();

  assert(summary.motion >= 4, `motion photos detected (${summary.motion})`);
  assert(summary.live >= 1, `Live Photo pair detected (${summary.live})`);
  assert(summary.videos >= 3, `plain videos detected (${summary.videos})`);
  assert(summary.stills >= 2, `stills detected (${summary.stills})`);
  assert(summary.tiles >= 10, `tiles rendered (${summary.tiles})`);
  assert(/read of/.test(summary.bytesLabel), `the read-share counter is shown (${summary.bytesLabel})`);
  assert(/skipped/.test(notes), `non-media files are reported as skipped (${notes.trim()})`);
  assert(/motion pictures? found/.test(notes), `the summary counts motion pictures (${notes.trim()})`);

  // The whole point: scanning must not read the folder end to end. Small files
  // are read once in full (that is cheaper than two reads), so the interesting
  // claim is that the total stays well under the folder size.
  const share = Number((progress.match(/\(([\d.]+)% of the folder\)/) ?? [])[1] ?? '100');
  assert(share < 95, `reading stayed bounded: ${progress.trim()}`);
  const readBytes = summary.bytes;
  assert(/k?B|MB/.test(readBytes), `a byte count is shown (${readBytes})`);

  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll('.tile')].map((tile) => ({
      name: tile.querySelector('.tile-name').textContent,
      kind: tile.dataset.kind,
      badges: [...tile.querySelectorAll('.badge')].map((b) => b.textContent),
    })),
  );
  process.stdout.write(
    `  info  tiles: ${kinds.map((k) => `${k.name}=${k.kind}`).join(', ')}\n`,
  );
  const motionTile = kinds.find((k) => k.kind === 'motion');
  assert(Boolean(motionTile), 'at least one tile is classified as motion');
  assert(
    kinds.some((k) => k.badges.includes('SAMSUNG') || k.badges.includes('GOOGLE') || k.badges.includes('HEIC ITEM')),
    'a vendor-specific family badge is shown',
  );
  assert(
    !kinds.some((k) => k.name === 'live.mov'),
    'the Live Photo companion is folded into its still',
  );

  // ---- decode a thumbnail -------------------------------------------------
  const painted = await page.waitForFunction(
    () => {
      const canvas = document.querySelector('.tile .thumb canvas');
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Anything that is not the flat background colour means a real decode.
      for (let i = 0; i < data.length; i += 4 * 97) {
        if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) return true;
      }
      return false;
    },
    null,
    { timeout: 20000 },
  )
    .then(() => true)
    .catch(() => false);
  assert(painted, 'a thumbnail was decoded into its canvas');

  // ---- open the viewer and play the embedded video ------------------------
  await page.locator('.tile.is-motion').first().click();
  await page.waitForSelector('#viewer[open]', { timeout: 10000 });
  const facts = await page.locator('#viewer-facts').textContent();
  assert(/Detection/.test(facts), 'the inspector reports the detection route');
  assert(/Video/.test(facts), 'the inspector reports the video byte range');

  const playVisible = await page.locator('#viewer-play').isVisible();
  assert(playVisible, 'the play affordance is offered for a motion photo');

  if (playVisible) {
    await page.locator('#viewer-play').click();
    // Open-source Chromium builds ship without proprietary codecs, so a decode
    // assertion is only meaningful where the engine claims H.264 support.
    const h264 = await page.evaluate(
      () => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    );
    if (h264) {
      const played = await page
        .waitForFunction(
          () => {
            const video = document.getElementById('viewer-video');
            return video && !video.hidden && video.videoWidth > 0 && video.readyState >= 2;
          },
          null,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false);
      assert(played, 'the extracted video decodes in a <video> element');

      const advanced = await page
        .waitForFunction(() => document.getElementById('viewer-video').currentTime > 0.05, null, {
          timeout: 15000,
        })
        .then(() => true)
        .catch(() => false);
      assert(advanced, 'playback advances (the clip is really playing)');
    } else {
      process.stdout.write('  skip  video decode (this browser build has no H.264 codec)\n');
      const hasSrc = await page.evaluate(() => Boolean(document.getElementById('viewer-video').src));
      assert(hasSrc, 'the extracted blob is still handed to the video element');
    }
  }

  await page.locator('#viewer-quit').click();
  await page.waitForSelector('#viewer[open]', { state: 'detached', timeout: 5000 }).catch(() => {});

  // ---- filters ------------------------------------------------------------
  await page.locator('.chip[data-filter="still"]').click();
  const stillCount = await page.locator('.tile').count();
  assert(stillCount >= 1, `the stills filter narrows the grid (${stillCount})`);
  await page.locator('.chip[data-filter="all"]').click();

  if (SCREENSHOT) {
    await mkdir(dirname(resolve(ROOT, SCREENSHOT)), { recursive: true });
    await page.screenshot({ path: resolve(ROOT, SCREENSHOT), fullPage: false });
    ok(`screenshot written to ${SCREENSHOT}`);
  }

  // ---- promises -----------------------------------------------------------
  assert(external.length === 0, `no request left this origin (${external.slice(0, 3).join(', ') || 'none'})`);
  const realErrors = consoleErrors.filter((text) => !/favicon/i.test(text));
  assert(realErrors.length === 0, `no console errors (${realErrors.slice(0, 2).join(' | ') || 'none'})`);

  const stored = await page.evaluate(async () => {
    if (!('caches' in window)) return 0;
    const names = await caches.keys();
    let entries = 0;
    for (const name of names) entries += (await (await caches.open(name)).keys()).length;
    return entries;
  });
  // Only the app shell may be cached, and only files the app itself ships.
  assert(stored <= 16, `no user data was cached (${stored} shell entries)`);
} catch (error) {
  bad(`unexpected failure: ${error.message}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

process.stdout.write(problems.length ? `\n${problems.length} browser check(s) failed\n` : '\nall browser checks passed\n');
process.exit(problems.length ? 1 : 0);
