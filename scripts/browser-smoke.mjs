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

  // ---- EXIF orientation ---------------------------------------------------
  //
  // `rotated-portrait.jpg` holds landscape pixels with Orientation=6, so a
  // viewer that ignores the tag draws it sideways. The tile and the viewer must
  // agree, which is why both decode through an <img>.
  const measureTile = async (name) => {
    // Bring the tile on screen first: thumbnails are decoded lazily, and a tile
    // below the fold has nothing painted yet.
    await page
      .locator('.tile', { hasText: name })
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    const painted = await page
      .waitForFunction(
        (tileName) => {
          const tile = [...document.querySelectorAll('.tile')].find(
            (t) => t.querySelector('.tile-name')?.textContent === tileName,
          );
          const canvas = tile?.querySelector('canvas');
          if (!canvas) return false;
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          let lit = 0;
          for (let i = 0; i < data.length; i += 4 * 53) {
            if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) lit += 1;
          }
          return lit > 20;
        },
        name,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!painted) return null;
    return page.evaluate((tileName) => {
      const tile = [...document.querySelectorAll('.tile')].find(
        (t) => t.querySelector('.tile-name')?.textContent === tileName,
      );
      const canvas = tile.querySelector('canvas');
      const { data, width, height } = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height);
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { w: maxX - minX, h: maxY - minY };
    }, name);
  };

  // Exact geometry, recorded by the renderer: what was drawn, from what source
  // size, and with which rotation applied. Pixel measurement alone cannot tell
  // a rotated picture from a pattern with dark corners.
  const geometry = await (async () => {
    await page
      .locator('.tile', { hasText: 'rotated-portrait.jpg' })
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const read = (name) => {
        const tile = [...document.querySelectorAll('.tile')].find(
          (t) => t.querySelector('.tile-name')?.textContent === name,
        );
        const canvas = tile?.querySelector('canvas');
        return canvas
          ? {
              drawn: canvas.dataset.drawn,
              source: canvas.dataset.source,
              orientation: canvas.dataset.orientation,
            }
          : null;
      };
      return {
        control: read('solid.jpg'),
        rotated: read('rotated-portrait.jpg'),
        preview: read('rotated-preview.jpg'),
      };
    });
  })();
  const dims = (value) => (value ?? '0x0').split('x').map(Number);
  for (const [label, expectedOrientation] of [
    ['control', '1'],
    ['rotated', '1'], // the engine applied the tag itself
    ['preview', '6'], // the embedded preview carries no tag, so we apply it
  ]) {
    const entry = geometry[label];
    if (!entry?.drawn) {
      bad(`${label}: nothing recorded by the renderer`);
      continue;
    }
    const [dw, dh] = dims(entry.drawn);
    const [sw, sh] = dims(entry.source);
    assert(
      entry.orientation === expectedOrientation,
      `${label}: rotation applied is ${entry.orientation} (expected ${expectedOrientation})`,
    );
    if (label === 'control') {
      assert(dw > dh && sw > sh, `${label}: landscape in, landscape out (${entry.source} -> ${entry.drawn})`);
    } else {
      assert(dh > dw, `${label}: drawn portrait (${entry.source} -> ${entry.drawn})`);
    }
  }

  // The same picture twice: once as the camera stored it, once with
  // Orientation=6. Their painted areas must have swapped proportions.
  // A control image with no EXIF at all, to compare against.
  const control = await measureTile('photo.jpg');
  assert(
    control && control.w > control.h,
    `the unrotated control tile is landscape (${control ? `${control.w}x${control.h}` : 'nothing painted'})`,
  );

  const portrait = await measureTile('rotated-portrait.jpg');
  assert(
    portrait && portrait.w > 10 && portrait.h > portrait.w,
    `the rotated tile is drawn portrait (${portrait ? `${portrait.w}x${portrait.h}` : 'nothing painted'})`,
  );

  // The same picture, but the tile is drawn from an IFD1 preview that has no
  // orientation tag of its own: the viewer has to apply the main image's.
  const preview = await measureTile('rotated-preview.jpg');
  assert(
    preview && preview.w > 10 && preview.h > preview.w,
    `the tile drawn from an unrotated preview is still portrait (${preview ? `${preview.w}x${preview.h}` : 'nothing painted'})`,
  );

  const viewerPortrait = await (async () => {
    await page.evaluate(() => {
      const tile = [...document.querySelectorAll('.tile')].find(
        (t) => t.querySelector('.tile-name')?.textContent === 'rotated-portrait.jpg',
      );
      tile?.click();
    });
    await page.waitForSelector('#viewer[open]', { timeout: 10000 });
    const size = await page.evaluate(async () => {
      const img = document.getElementById('viewer-still');
      if (!img || img.hidden) return null;
      if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    await page.locator('#viewer-quit').click();
    return size;
  })();
  assert(
    viewerPortrait && viewerPortrait.h > viewerPortrait.w,
    `the viewer draws the same picture portrait (${viewerPortrait ? `${viewerPortrait.w}x${viewerPortrait.h}` : 'no image'})`,
  );

  // ---- ordinary pictures must not look like motion pictures ---------------
  const stillCheck = await page.evaluate(() => {
    const names = ['plain.heic', 'plain-still.jpg', 'photo.jpg'];
    const out = {};
    for (const name of names) {
      const tile = [...document.querySelectorAll('.tile')].find(
        (t) => t.querySelector('.tile-name')?.textContent === name,
      );
      if (!tile) {
        out[name] = null;
        continue;
      }
      const play = tile.querySelector('.thumb-play');
      out[name] = {
        kind: tile.dataset.kind,
        opacity: play ? getComputedStyle(play).opacity : '0',
        badges: [...tile.querySelectorAll('.badge')].map((b) => b.textContent),
      };
    }
    return out;
  });
  for (const [name, info] of Object.entries(stillCheck)) {
    if (!info) {
      bad(`${name} is missing from the grid`);
      continue;
    }
    assert(info.kind === 'still', `${name} is classified as a still (${info.kind})`);
    assert(info.opacity === '0', `${name} shows no play affordance (opacity ${info.opacity})`);
    assert(!info.badges.includes('MOTION'), `${name} carries no MOTION badge`);
  }

  // The play affordance must not appear on hover either: that is what made
  // ordinary photographs look like motion pictures.
  const hoverName = 'plain-still.jpg';
  await page.locator('.tile', { hasText: hoverName }).first().hover();
  await page.waitForTimeout(150);
  const hoveredOpacity = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.tile')].find(
      (t) => t.querySelector('.tile-name')?.textContent === 'plain-still.jpg',
    );
    const play = tile?.querySelector('.thumb-play');
    return play ? getComputedStyle(play).opacity : '0';
  });
  assert(hoveredOpacity === '0', `hovering a still keeps the play affordance hidden (${hoveredOpacity})`);

  // ---- a HEIC still that cannot be drawn is not a failed clip -------------
  {
    const opened = await page.evaluate(() => {
      const tile = [...document.querySelectorAll('.tile')].find(
        (t) => t.querySelector('.tile-name')?.textContent === 'plain.heic',
      );
      if (!tile) return false;
      tile.click();
      return true;
    });
    if (!opened) {
      bad('the HEIC fixture is missing from the grid');
    } else {
      await page.waitForSelector('#viewer[open]', { timeout: 10000 });
      const explained = await page
        .waitForFunction(
          () => {
            const placeholder = document.getElementById('viewer-placeholder');
            return !placeholder.hidden && /HEIC/.test(placeholder.textContent);
          },
          null,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false);
      const text = (await page.locator('#viewer-placeholder').textContent()).trim();
      assert(explained, 'a HEIC that cannot be drawn is explained');
      assert(/HEVC/.test(text), `the explanation names HEVC (${text.slice(0, 80)}…)`);
      assert(
        !/extracted clip|Save extracted video/.test(text),
        'a picture failure does not talk about a clip that does not exist',
      );
      assert(await page.locator('#viewer-play').isHidden(), 'a plain HEIC offers no play button');
      await page.locator('#viewer-quit').click();
      await page.waitForTimeout(200);
    }
  }

  // ---- macOS metadata must not become tiles -------------------------------
  const junkTiles = await page.evaluate(() =>
    [...document.querySelectorAll('.tile')].filter((t) => t.querySelector('.tile-name').textContent.startsWith('._')).length,
  );
  assert(junkTiles === 0, `AppleDouble sidecars are skipped (${junkTiles} shown)`);

  // ---- a tile-grid HEIC reports the picture's size, not a tile's ----------
  const gridSize = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.tile')].find(
      (t) => t.querySelector('.tile-name')?.textContent === 'plain.heic',
    );
    return tile?.querySelector('.tile-meta')?.textContent ?? '';
  });
  assert(
    /4032×3024/.test(gridSize),
    `a grid HEIC reports the assembled size (${gridSize.trim().slice(0, 80)})`,
  );

  // ---- a Live Photo failure names the companion and its codec -------------
  {
    const opened = await page.evaluate(() => {
      const tile = [...document.querySelectorAll('.tile')].find(
        (t) => t.querySelector('.tile-name')?.textContent === 'paired-hevc.jpg',
      );
      if (!tile) return false;
      tile.click();
      return true;
    });
    if (!opened) {
      bad('the Live Photo pair is missing from the grid');
    } else {
      await page.waitForSelector('#viewer[open]', { timeout: 10000 });
      const facts = await page.locator('#viewer-facts').textContent();
      assert(
        /paired-hevc\.mov/.test(facts) && /hvc1/.test(facts),
        'the inspector names the companion file and its codec',
      );
      if (await page.locator('#viewer-play').isVisible()) {
        await page.locator('#viewer-play').click();
        const explained = await page
          .waitForFunction(
            () => {
              const placeholder = document.getElementById('viewer-placeholder');
              return !placeholder.hidden && /paired-hevc\.mov/.test(placeholder.textContent);
            },
            null,
            { timeout: 20000 },
          )
          .then(() => true)
          .catch(() => false);
        const text = await page.locator('#viewer-placeholder').textContent();
        assert(
          explained && /HEVC/.test(text),
          `the failure names the companion and the codec (${text.trim().slice(0, 90)}…)`,
        );
      }
      await page.locator('#viewer-quit').click();
      await page.waitForTimeout(200);
    }
  }

  // ---- an unsupported codec must still be attempted -----------------------
  const hevcAttempt = await page.evaluate(async () => {
    const tile = [...document.querySelectorAll('.tile')].find(
      (t) => t.querySelector('.tile-name')?.textContent === 'motion-hevc.heic',
    );
    if (!tile) return { found: false };
    tile.click();
    return {
      found: true,
      canPlay: document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    };
  });
  if (!hevcAttempt.found) {
    bad('the HEVC fixture is missing from the grid');
  } else {
    await page.waitForSelector('#viewer[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => document.getElementById('viewer-name')?.textContent === 'motion-hevc.heic',
      null,
      { timeout: 10000 },
    ).catch(() => {});
    assert(
      (await page.locator('#viewer-name').textContent()) === 'motion-hevc.heic',
      'the HEVC fixture opened in the viewer',
    );
    const report = await page.locator('#viewer-report').textContent();
    assert(
      /"codec": ?"hvc1\.[A-C]?\d+\.[0-9a-f]+\.[HL]\d+/.test(report),
      'the reported HEVC codec string is RFC 6381 shaped',
    );
    if (await page.locator('#viewer-play').isVisible()) {
      await page.locator('#viewer-play').click();
      const attempted = await page
        .waitForFunction(() => Boolean(document.getElementById('viewer-video').getAttribute('src')), null, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      assert(attempted, 'playback is attempted even when canPlayType reports no support');
      // Either it decodes (platform HEVC) or the viewer explains why - never a
      // refusal based on the codec string alone.
      await page.waitForTimeout(1500);
      const state = await page.evaluate(() => {
        const video = document.getElementById('viewer-video');
        const placeholder = document.getElementById('viewer-placeholder');
        return {
          decoded: video.videoWidth > 0,
          explained: !placeholder.hidden && /HEVC|HEVC-coded|cannot decode/.test(placeholder.textContent),
        };
      });
      assert(state.decoded || state.explained, 'the clip either plays or is explained, not silently refused');
    }
    await page.locator('#viewer-quit').click();
    await page.waitForTimeout(200);
  }

  // ---- the sticky chrome must not bleed -----------------------------------
  //
  // The filter bar sticks under the header while the grid scrolls beneath it.
  // If either bar is translucent, or its spacing is a margin rather than
  // padding, photographs show through the controls.
  const chrome = await page.evaluate(() => {
    const header = document.querySelector('.topbar');
    const toolbar = document.getElementById('toolbar');
    const style = getComputedStyle(toolbar);
    return {
      headerHeight: Math.round(header.getBoundingClientRect().height),
      declared: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
      position: style.position,
      top: style.top,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      background: style.backgroundColor,
      opaque: !/rgba\(.*,\s*0?\.\d+\)/.test(style.backgroundColor),
    };
  });
  assert(chrome.position === 'sticky', `the filter bar is sticky on a wide window (${chrome.position})`);
  assert(
    chrome.declared === `${chrome.headerHeight}px`,
    `the sticky offset is the measured header height (${chrome.declared} vs ${chrome.headerHeight}px)`,
  );
  assert(chrome.top === `${chrome.headerHeight}px`, `the bar sticks at that offset (${chrome.top})`);
  assert(chrome.opaque, `the filter bar has an opaque background (${chrome.background})`);
  assert(
    chrome.marginTop === '0px' && chrome.marginBottom === '0px',
    `the bar keeps its spacing inside itself (${chrome.marginTop} / ${chrome.marginBottom})`,
  );

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(250);
  const stuck = await page.evaluate(() => {
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const toolbar = document.getElementById('toolbar').getBoundingClientRect();
    return { headerBottom: Math.round(header.bottom), toolbarTop: Math.round(toolbar.top) };
  });
  assert(
    Math.abs(stuck.toolbarTop - stuck.headerBottom) <= 1,
    `scrolled, the bar sits flush under the header (${stuck.toolbarTop} vs ${stuck.headerBottom})`,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

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
