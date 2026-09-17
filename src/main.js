/**
 * UI controller.
 *
 * Everything here is presentation and scheduling. The decision of *what a file
 * is* and *where its video lives* is made in WebAssembly; this file only shows
 * the answer and asks for more bytes when the core says it needs them.
 */

import { Scanner, deepScan, preloadCore } from './scan.js';
import { filesFromDataTransfer, filesFromInput, isScannable, pairLivePhotos, pickDirectory } from './files.js';
import { PreviewService } from './preview.js';
import {
  badgesFor, capturedAt, classify, formatBytes, formatDateTime, formatDuration,
  KIND_LABEL, problemText,
} from './format.js';

const BATCH = 120;
const TILE_WIDTH = 360;

const el = (id) => document.getElementById(id);
const ui = {
  folderButton: el('pick-folder'),
  filesButton: el('pick-files'),
  cancelButton: el('cancel-scan'),
  fileInput: el('file-input'),
  folderInput: el('folder-input'),
  dropzone: el('dropzone'),
  scanPanel: el('scan-panel'),
  progressFill: el('progress-fill'),
  progressText: el('progress-text'),
  scanNotes: el('scan-notes'),
  summary: el('summary'),
  statMotion: el('stat-motion'),
  statLive: el('stat-live'),
  statStills: el('stat-stills'),
  statVideos: el('stat-videos'),
  statFailed: el('stat-failed'),
  statBytes: el('stat-bytes'),
  statBytesLabel: el('stat-bytes-label'),
  toolbar: el('toolbar'),
  grid: el('grid'),
  empty: el('empty'),
  search: el('search'),
  sort: el('sort'),
  viewer: el('viewer'),
  viewerName: el('viewer-name'),
  viewerSub: el('viewer-sub'),
  viewerStill: el('viewer-still'),
  viewerVideo: el('viewer-video'),
  viewerPlaceholder: el('viewer-placeholder'),
  viewerPlay: el('viewer-play'),
  viewerStillBtn: el('viewer-still-btn'),
  viewerTime: el('viewer-time'),
  viewerPrev: el('viewer-prev'),
  viewerNext: el('viewer-next'),
  viewerBadges: el('viewer-badges'),
  viewerFacts: el('viewer-facts'),
  viewerReport: el('viewer-report'),
  viewerCopy: el('viewer-copy'),
  viewerSave: el('viewer-save'),
  viewerDeep: el('viewer-deep'),
  viewerQuit: el('viewer-quit'),
};

const state = {
  entries: [],
  visible: [],
  rendered: 0,
  filter: 'all',
  sort: 'name',
  query: '',
  scanning: false,
  current: null,
  previews: new PreviewService({ concurrency: 2, maxUrls: 6 }),
  scanner: null,
  observer: null,
  sentinel: null,
  scanStart: 0,
  totalBytes: 0,
  copyTimer: 0,
};

// ---------------------------------------------------------------- tile render

function createTile(entry) {
  const article = document.createElement('article');
  article.className = 'tile';
  article.tabIndex = 0;
  article.dataset.id = entry.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const canvas = document.createElement('canvas');
  canvas.width = TILE_WIDTH;
  canvas.height = Math.round(TILE_WIDTH * 0.75);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', entry.name);
  thumb.append(canvas);

  const state_ = document.createElement('span');
  state_.className = 'thumb-state';
  thumb.append(state_);

  const play = document.createElement('span');
  play.className = 'thumb-play';
  play.setAttribute('aria-hidden', 'true');
  thumb.append(play);

  const body = document.createElement('div');
  body.className = 'tile-body';
  const name = document.createElement('p');
  name.className = 'tile-name';
  name.textContent = entry.name;
  name.title = entry.path;
  const meta = document.createElement('p');
  meta.className = 'tile-meta';
  const badges = document.createElement('div');
  badges.className = 'badges';
  body.append(name, meta, badges);

  article.append(thumb, body);
  article.__entry = entry;
  article.__canvas = canvas;
  article.__meta = meta;
  article.__badges = badges;
  article.__state = state_;
  article.addEventListener('click', () => openViewer(entry));
  article.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openViewer(entry);
    }
  });
  return article;
}

function describeTile(entry) {
  if (entry.status === 'pending') return { meta: 'waiting…', badges: [] };
  if (entry.status === 'failed') return { meta: entry.error ?? 'unreadable', badges: [] };
  const meta = entry.result?.meta ?? {};
  const parts = [];
  const model = [meta.make, meta.model].filter(Boolean).join(' ').trim();
  if (model) parts.push(model);
  const when = capturedAt(entry);
  if (when) parts.push(formatDateTime(when));
  parts.push(formatBytes(entry.size));
  const still = entry.result?.still;
  if (still?.width && still?.height) parts.push(`${still.width}×${still.height}`);
  const duration = formatDuration(entry.result?.motion?.durationMs);
  if (duration) parts.push(`motion ${duration}`);
  return { meta: parts.join(' · '), badges: badgesFor(entry) };
}

function updateTile(article) {
  const entry = article.__entry;
  const { meta, badges } = describeTile(entry);
  article.__meta.textContent = meta;
  article.__badges.replaceChildren(
    ...badges.map((badge) => {
      const span = document.createElement('span');
      span.className = `badge badge-${badge.tone}`;
      span.textContent = badge.text;
      return span;
    }),
  );
  const kind = classify(entry);
  article.dataset.kind = kind;
  article.classList.toggle('is-motion', kind === 'motion' || kind === 'live');
  article.classList.toggle('is-problem', kind === 'problem');
  const problem = problemText(entry);
  article.__state.textContent = problem ? '!' : '';
  article.__state.title = problem;
  article.title = problem || entry.path;
}

/** Decodes a thumbnail only once the tile is close to the viewport. */
function ensureThumb(article) {
  const entry = article.__entry;
  if (article.__thumbRequested) return;
  article.__thumbRequested = true;
  const canvas = article.__canvas;
  state.previews
    .thumbnail(entry, canvas, TILE_WIDTH * (window.devicePixelRatio > 1 ? 1 : 1))
    .then((status) => {
      if (status === 'ok') return;
      article.__state.textContent = status === 'unsupported' ? (entry.ext || '?').toUpperCase() : '';
      article.__state.title =
        status === 'unsupported' ? 'This browser cannot decode this image format' : '';
      article.__canvas.classList.add('is-blank');
    })
    .catch(() => {});
}

function observeTiles(nodes) {
  if (!state.observer) {
    state.observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          state.observer.unobserve(record.target);
          ensureThumb(record.target);
        }
      },
      { rootMargin: '400px 0px' },
    );
  }
  for (const node of nodes) state.observer.observe(node);
}

// ------------------------------------------------------------------ filtering

function matchesFilter(entry) {
  if (state.filter === 'all') return true;
  const kind = classify(entry);
  if (state.filter === 'motion') return kind === 'motion';
  if (state.filter === 'live') return kind === 'live';
  if (state.filter === 'still') return kind === 'still';
  if (state.filter === 'video') return kind === 'video';
  if (state.filter === 'problem') return kind === 'problem';
  return true;
}

function matchesQuery(entry) {
  if (!state.query) return true;
  const q = state.query;
  const hay = [
    entry.name, entry.path, entry.ext,
    entry.result?.meta?.make, entry.result?.meta?.model, entry.result?.meta?.takenAt,
    entry.result?.motion?.family, entry.result?.motion?.codec, entry.result?.container,
    ...(entry.result?.markers ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function sortEntries(list) {
  const by = state.sort;
  const copy = [...list];
  if (by === 'date-desc') copy.sort((a, b) => capturedAt(b) - capturedAt(a));
  else if (by === 'date-asc') copy.sort((a, b) => capturedAt(a) - capturedAt(b));
  else if (by === 'size-desc') copy.sort((a, b) => b.size - a.size);
  else if (by === 'kind') copy.sort((a, b) => classify(a).localeCompare(classify(b)) || a.name.localeCompare(b.name));
  else copy.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return copy;
}

function refresh({ resetScroll = true } = {}) {
  state.visible = sortEntries(
    state.entries.filter((entry) => !entry.hiddenAsCompanion && matchesFilter(entry) && matchesQuery(entry)),
  );
  state.rendered = 0;
  ui.grid.replaceChildren();
  if (state.sentinel) {
    state.sentinel.remove();
    state.sentinel = null;
  }
  if (resetScroll) window.scrollTo({ top: 0, behavior: 'auto' });
  renderBatch();
  updateSummary();
}

function renderBatch() {
  const slice = state.visible.slice(state.rendered, state.rendered + BATCH);
  if (!slice.length && state.rendered === 0) {
    ui.empty.hidden = false;
    ui.empty.textContent = state.entries.length
      ? 'Nothing matches the current filter.'
      : 'No files were found in that folder.';
    return;
  }
  ui.empty.hidden = true;
  const frag = document.createDocumentFragment();
  const nodes = slice.map((entry) => {
    const node = createTile(entry);
    updateTile(node);
    frag.append(node);
    return node;
  });
  ui.grid.append(frag);
  state.rendered += slice.length;
  observeTiles(nodes);

  if (state.rendered < state.visible.length) {
    state.sentinel = document.createElement('button');
    state.sentinel.type = 'button';
    state.sentinel.className = 'load-more';
    state.sentinel.textContent = `Show ${Math.min(BATCH, state.visible.length - state.rendered)} more of ${state.visible.length}`;
    state.sentinel.addEventListener('click', () => {
      state.sentinel?.remove();
      state.sentinel = null;
      renderBatch();
    });
    ui.grid.after(state.sentinel);
  }
}

function updateSummary() {
  const counts = { motion: 0, live: 0, still: 0, video: 0, problem: 0 };
  for (const entry of state.entries) {
    if (entry.hiddenAsCompanion) continue;
    counts[classify(entry)] = (counts[classify(entry)] ?? 0) + 1;
  }
  ui.summary.hidden = !state.entries.length;
  ui.statMotion.textContent = String(counts.motion);
  ui.statLive.textContent = String(counts.live);
  ui.statStills.textContent = String(counts.still);
  ui.statVideos.textContent = String(counts.video);
  ui.statFailed.textContent = String(counts.problem);
  const { bytesRead } = state.scanner?.totals ?? { bytesRead: 0 };
  ui.statBytes.textContent = formatBytes(bytesRead);
  const share = state.totalBytes ? (bytesRead / state.totalBytes) * 100 : 0;
  ui.statBytesLabel.textContent = `read of ${formatBytes(state.totalBytes)} (${share < 1 ? share.toFixed(2) : share.toFixed(1)}%)`;
}

// ---------------------------------------------------------------------- scan

async function startScan(entries) {
  const scannable = entries.filter((entry) => isScannable(entry.file));
  const skipped = entries.length - scannable.length;
  state.entries = scannable;
  state.totalBytes = scannable.reduce((sum, entry) => sum + entry.size, 0);
  state.previews.clear();
  state.scanning = true;
  state.scanStart = performance.now();
  ui.scanPanel.hidden = false;
  ui.toolbar.hidden = false;
  ui.cancelButton.hidden = false;
  ui.dropzone.hidden = true;
  ui.scanNotes.textContent = skipped
    ? `${skipped} file${skipped === 1 ? '' : 's'} skipped (not a photo or video format).`
    : '';

  refresh({ resetScroll: true });

  const scanned = new Map();
  const scanner = new Scanner({
    onResult: (entry, result, stats) => {
      entry.result = result;
      entry.stats = stats;
      entry.status = result.ok === false ? 'failed' : 'ok';
      if (result.ok === false) entry.error = result.notes?.[0] ?? 'unreadable';
      scanned.set(entry.id, entry);
      const node = ui.grid.querySelector(`[data-id="${cssEscape(entry.id)}"]`);
      if (node) {
        updateTile(node);
        node.__thumbRequested = false;
        ensureThumb(node);
      }
      // Pair up as we go so Live Photo badges appear without a second pass.
      if (scanned.size % 32 === 0) maybePair();
      updateSummary();
    },
    onProgress: ({ done, total, bytesRead }) => {
      const share = total ? done / total : 0;
      ui.progressFill.style.width = `${(share * 100).toFixed(1)}%`;
      const elapsed = (performance.now() - state.scanStart) / 1000;
      ui.progressText.textContent = `${done} / ${total} files · ${formatBytes(bytesRead)} read · ${elapsed.toFixed(1)}s`;
    },
  });
  state.scanner = scanner;

  await scanner.run(scannable);
  state.scanning = false;
  ui.cancelButton.hidden = true;
  ui.progressFill.style.width = '100%';
  const elapsed = (performance.now() - state.scanStart) / 1000;
  const found = state.entries.filter((entry) => classify(entry) === 'motion' || classify(entry) === 'live').length;
  const { bytesRead } = scanner.totals;
  ui.progressText.textContent =
    `${state.entries.length} files in ${elapsed.toFixed(1)}s · ${formatBytes(bytesRead)} read` +
    ` (${state.totalBytes ? ((bytesRead / state.totalBytes) * 100).toFixed(1) : '0'}% of the folder)`;
  ui.scanNotes.textContent =
    `${found} motion picture${found === 1 ? '' : 's'} found` +
    (skipped ? `, ${skipped} file${skipped === 1 ? '' : 's'} skipped as non-media` : '') +
    '. Open one and press Play.';
  maybePair(true);
  refresh({ resetScroll: false });
}

function maybePair(force = false) {
  if (!force && state.entries.length > 2000) return;
  const paired = pairLivePhotos(state.entries);
  return paired;
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// -------------------------------------------------------------------- viewer

const viewerState = { videoLoaded: false, saveUrl: null };

function openViewer(entry) {
  state.current = entry;
  viewerState.videoLoaded = false;
  ui.viewerVideo.pause();
  ui.viewerVideo.removeAttribute('src');
  ui.viewerVideo.load();
  ui.viewerVideo.hidden = true;
  ui.viewerStill.hidden = true;
  ui.viewerPlaceholder.hidden = true;

  ui.viewerName.textContent = entry.name;
  const { meta } = describeTile(entry);
  ui.viewerSub.textContent = meta;

  ui.viewerBadges.replaceChildren(
    ...badgesFor(entry).map((badge) => {
      const span = document.createElement('span');
      span.className = `badge badge-${badge.tone}`;
      span.textContent = badge.text;
      return span;
    }),
  );

  const facts = [
    ['Kind', KIND_LABEL[classify(entry)] ?? classify(entry)],
    ['Container', entry.result?.container ?? '—'],
    ['Detection', entry.result?.motion?.method ?? '—'],
    ['Confidence', entry.result?.motion?.confidence ?? '—'],
    ['Video', entry.result?.motion?.video ? `${formatBytes(entry.result.motion.video.len)} at byte ${entry.result.motion.video.off.toLocaleString()}` : '—'],
    [
      'Codec',
      entry.result?.motion?.codec ??
        (entry.live
          ? `${entry.live.entry.name} — ${entry.live.entry.result?.motion?.codec ?? 'unknown'}`
          : '—'),
    ],
    ['Motion length', formatDuration(entry.result?.motion?.durationMs) || '—'],
    ['Marker frame', entry.result?.motion?.timestampUs ? `${(entry.result.motion.timestampUs / 1e6).toFixed(2)}s into the clip` : '—'],
    ['Camera', [entry.result?.meta?.make, entry.result?.meta?.model].filter(Boolean).join(' ') || '—'],
    ['Captured', entry.result?.meta?.takenAt ?? (entry.lastModified ? formatDateTime(entry.lastModified) : '—')],
    ['File', `${formatBytes(entry.size)} · ${entry.path}`],
    ['Bytes read', entry.stats ? `${formatBytes(entry.stats.bytesRead)} in ${entry.stats.reads} read(s), ${entry.stats.passes} pass(es)` : '—'],
  ];
  ui.viewerFacts.replaceChildren(
    ...facts.flatMap(([key, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );

  ui.viewerReport.textContent = JSON.stringify(
    { core: entry.result, stats: entry.stats, pair: entry.live ? { companion: entry.live.entry.name, by: entry.live.by } : null },
    null,
    2,
  );

  const playable = Boolean(entry.result?.motion?.playable) || Boolean(entry.live);
  ui.viewerPlay.hidden = !playable;
  ui.viewerStillBtn.hidden = true;
  ui.viewerSave.hidden = !playable;
  ui.viewerTime.textContent = '';

  const stillUrl = state.previews.stillUrl(entry);
  if (stillUrl) {
    ui.viewerStill.src = stillUrl;
    ui.viewerStill.hidden = false;
    ui.viewerStill.onerror = () => {
      ui.viewerStill.hidden = true;
      const hevcStill = entry.result?.container === 'heif';
      if (playable) {
        showPlaceholder(
          hevcStill
            ? 'This HEIC still is HEVC-coded, which this browser cannot draw. Press “Play motion” to try the embedded clip.'
            : 'This browser cannot draw this still image. Press “Play motion” to watch the embedded clip.',
        );
      } else if (hevcStill) {
        reportPlaybackFailure(entry);
      } else {
        showPlaceholder('This browser cannot draw this image format.');
      }
    };
  } else if (playable) {
    showPlaceholder('Press “Play motion” to watch the embedded clip.');
  } else {
    showPlaceholder('No preview available for this file.');
  }

  if (typeof ui.viewer.showModal === 'function') {
    if (!ui.viewer.open) ui.viewer.showModal();
  } else {
    ui.viewer.setAttribute('open', '');
  }
  updateNavButtons();
}

function showPlaceholder(text) {
  ui.viewerPlaceholder.textContent = text;
  ui.viewerPlaceholder.hidden = false;
}

function playMotion() {
  const entry = state.current;
  if (!entry) return;
  const url = state.previews.videoUrl(entry);
  if (!url) {
    showPlaceholder('No playable video could be assembled for this file.');
    return;
  }
  if (!viewerState.videoLoaded) {
    ui.viewerVideo.src = url;
    ui.viewerVideo.hidden = false;
    ui.viewerStill.hidden = true;
    ui.viewerPlaceholder.hidden = true;
    ui.viewerStillBtn.hidden = false;
    viewerState.videoLoaded = true;
  }

  // `canPlayType` is a hint, never a verdict: it judges a codec *string*, and an
  // engine that answers "" may still decode the file through a hardware path.
  // So the clip is always attempted, and the browser's own error event is what
  // produces an explanation.
  const codec = entry.result?.motion?.codec ?? '';
  const support = state.previews.canPlay(entry);
  if (support === '' && codec && !entry.live) {
    ui.viewerTime.textContent = `trying ${codec}…`;
  }
  ui.viewerVideo.play().catch(() => reportPlaybackFailure(entry));
}

/** Explains a clip the engine really could not decode, without overclaiming. */
function reportPlaybackFailure(entry) {
  // A Live Photo keeps its clip in a companion file, so the codec belongs to
  // that file's own scan rather than to the still.
  const companion = entry?.live?.entry;
  const codec = entry?.result?.motion?.codec ?? companion?.result?.motion?.codec ?? '';
  const hevc = /^(hvc1|hev1)/.test(codec);
  const heicStill = entry?.result?.container === 'heif';
  const parts = [];

  if (companion) {
    parts.push(
      `This is a Live Photo: its clip is the companion file ${companion.name}` +
        (codec ? ` (${codec})` : '') +
        ', which this browser cannot decode.',
    );
  } else if (hevc && heicStill) {
    parts.push('Both the picture and the clip in this HEIC are HEVC-coded, and this browser has no HEVC decoder.');
  } else if (codec) {
    parts.push(`This browser cannot decode the clip's ${codec} video.`);
  } else {
    parts.push('This browser cannot play the extracted clip.');
  }

  parts.push('The file itself is intact and nothing was modified.');
  parts.push(
    hevc
      ? 'Safari, or any HEVC-capable player, opens it.'
      : 'A player that supports this codec opens it.',
  );
  parts.push('“Save extracted video” writes the clip out byte for byte, so nothing is lost.');
  if (hevc && heicStill) parts.push('For the same reason the still cannot be drawn here.');
  showPlaceholder(parts.join(' '));
}

function showStill() {
  ui.viewerVideo.pause();
  ui.viewerVideo.hidden = true;
  ui.viewerStill.hidden = false;
  ui.viewerStillBtn.hidden = true;
}

function updateNavButtons() {
  const index = state.visible.indexOf(state.current);
  ui.viewerPrev.disabled = index <= 0;
  ui.viewerNext.disabled = index < 0 || index >= state.visible.length - 1;
}

function step(delta) {
  const index = state.visible.indexOf(state.current);
  if (index < 0) return;
  const next = state.visible[index + delta];
  if (next) openViewer(next);
}

function closeViewer() {
  ui.viewerVideo.pause();
  ui.viewerVideo.removeAttribute('src');
  ui.viewerVideo.load();
  if (state.current) state.previews.release(state.current);
  state.current = null;
  if (typeof ui.viewer.close === 'function' && ui.viewer.open) ui.viewer.close();
  else ui.viewer.removeAttribute('open');
}

async function saveVideo() {
  const entry = state.current;
  if (!entry) return;
  const url = state.previews.videoUrl(entry);
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = `${entry.name.replace(/\.[^.]+$/, '')}-motion.mp4`;
  document.body.append(link);
  link.click();
  link.remove();
}

async function runDeepScan() {
  const entry = state.current;
  if (!entry) return;
  ui.viewerDeep.disabled = true;
  ui.viewerDeep.textContent = 'Deep scanning…';
  try {
    const { result, stats } = await deepScan(entry.file);
    entry.result = result;
    entry.stats = stats;
    entry.status = result.ok === false ? 'failed' : 'ok';
    openViewer(entry);
    const node = ui.grid.querySelector(`[data-id="${cssEscape(entry.id)}"]`);
    if (node) {
      updateTile(node);
      node.__thumbRequested = false;
      ensureThumb(node);
    }
    updateSummary();
  } catch (error) {
    ui.viewerDeep.textContent = `Deep scan failed: ${error.message}`;
    return;
  } finally {
    ui.viewerDeep.disabled = false;
    ui.viewerDeep.textContent = 'Deep scan this file';
  }
}

// --------------------------------------------------------------------- wiring

function wireFolderInput() {
  ui.folderInput.addEventListener('change', () => {
    const entries = filesFromInput(ui.folderInput);
    ui.folderInput.value = '';
    if (entries.length) startScan(entries);
  });
  ui.fileInput.addEventListener('change', () => {
    const entries = filesFromInput(ui.fileInput);
    ui.fileInput.value = '';
    if (entries.length) startScan(entries);
  });
  ui.filesButton.addEventListener('click', () => ui.fileInput.click());
  ui.folderButton.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const entries = await pickDirectory();
        if (entries?.length) startScan(entries);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        // Fall through to the input-based picker.
      }
    }
    ui.folderInput.click();
  });
  ui.cancelButton.addEventListener('click', () => {
    state.scanner?.cancel();
    ui.cancelButton.hidden = true;
    ui.progressText.textContent = 'Stopped.';
  });
}

function wireDropzone() {
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    document.addEventListener(type, stop, false);
  }
  document.addEventListener('dragover', () => ui.dropzone.classList.add('is-over'));
  document.addEventListener('dragleave', () => ui.dropzone.classList.remove('is-over'));
  document.addEventListener('drop', async (event) => {
    ui.dropzone.classList.remove('is-over');
    const entries = await filesFromDataTransfer(event.dataTransfer);
    if (entries.length) startScan(entries);
  });
}

function wireToolbar() {
  for (const chip of ui.toolbar.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      for (const other of ui.toolbar.querySelectorAll('.chip')) other.classList.toggle('is-on', other === chip);
      state.filter = chip.dataset.filter;
      refresh();
    });
  }
  ui.search.addEventListener('input', () => {
    state.query = ui.search.value.trim().toLowerCase();
    refresh({ resetScroll: false });
  });
  ui.sort.addEventListener('change', () => {
    state.sort = ui.sort.value;
    refresh({ resetScroll: false });
  });
}

function wireViewer() {
  ui.viewerPlay.addEventListener('click', playMotion);
  ui.viewerStillBtn.addEventListener('click', showStill);
  ui.viewerQuit.addEventListener('click', closeViewer);
  ui.viewerPrev.addEventListener('click', () => step(-1));
  ui.viewerNext.addEventListener('click', () => step(1));
  ui.viewerSave.addEventListener('click', saveVideo);
  ui.viewerDeep.addEventListener('click', runDeepScan);
  ui.viewerCopy.addEventListener('click', async () => {
    const entry = state.current;
    if (!entry) return;
    const report = ui.viewerReport.textContent;
    try {
      await navigator.clipboard.writeText(report);
      ui.viewerCopy.textContent = 'Copied';
      clearTimeout(state.copyTimer);
      state.copyTimer = setTimeout(() => { ui.viewerCopy.textContent = 'Copy report'; }, 1500);
    } catch {
      ui.viewerCopy.textContent = 'Copy failed';
    }
  });
  ui.viewerVideo.addEventListener('error', () => {
    // Only while the viewer is open and holding a real source: tearing the
    // element down on close also fires an error for the empty source.
    if (!ui.viewer.open || !ui.viewerVideo.getAttribute('src')) return;
    ui.viewerVideo.hidden = true;
    if (ui.viewerStill.getAttribute('src')) ui.viewerStill.hidden = false;
    if (state.current) reportPlaybackFailure(state.current);
  });
  ui.viewerVideo.addEventListener('timeupdate', () => {
    const d = ui.viewerVideo.duration;
    if (!Number.isFinite(d)) return;
    ui.viewerTime.textContent = `${ui.viewerVideo.currentTime.toFixed(1)}s / ${d.toFixed(1)}s`;
  });
  ui.viewer.addEventListener('close', () => {
    ui.viewerVideo.pause();
    ui.viewerVideo.removeAttribute('src');
    ui.viewerVideo.load();
    if (state.current) state.previews.release(state.current);
    state.current = null;
  });
  ui.viewer.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeViewer();
  });
  document.addEventListener('keydown', (event) => {
    if (!ui.viewer.open) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === ' ') {
      event.preventDefault();
      if (ui.viewerVideo.hidden) playMotion();
      else if (ui.viewerVideo.paused) ui.viewerVideo.play().catch(() => {});
      else ui.viewerVideo.pause();
    }
  });
}

/**
 * Publishes the header's real height so the toolbar can stick exactly below it.
 * The tagline wraps at narrow widths, which makes a hard-coded offset leave a
 * strip where the grid shows through.
 */
function syncHeaderHeight() {
  const header = document.querySelector('.topbar');
  if (!header) return;
  const apply = () =>
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(header.getBoundingClientRect().height)}px`);
  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(header);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
}

function boot() {
  syncHeaderHeight();
  wireFolderInput();
  wireDropzone();
  wireToolbar();
  wireViewer();
  preloadCore().catch(() => {});
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

boot();
