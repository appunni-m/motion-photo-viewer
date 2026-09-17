/** Small formatting and classification helpers shared by the UI. */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function formatDateTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** EXIF timestamps look like `2023:05:04 11:22:33`. */
export function parseExifDate(value) {
  if (typeof value !== 'string') return 0;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isFinite(t) ? t : 0;
}

/** The best available capture time for an entry. */
export function capturedAt(entry) {
  const exif = parseExifDate(entry.result?.meta?.takenAt);
  return exif || entry.lastModified || 0;
}

export const KIND_LABEL = {
  motion: 'Motion',
  live: 'Live',
  still: 'Still',
  video: 'Video',
  other: 'File',
  unknown: 'File',
};

/**
 * Classification used by the filter chips. A "motion picture" is any file with
 * a playable embedded video: motion photos, Live Photos and HEIC motion items.
 */
export function classify(entry) {
  if (entry.status === 'failed') return 'problem';
  // A plain video file is a video, not a motion photo, even though it is
  // playable and the core reports a plan for it.
  if (entry.result?.kind === 'video') return 'video';
  const motion = entry.result?.motion;
  if (entry.live) return 'live';
  if (motion?.playable) return 'motion';
  if (entry.result?.still) return 'still';
  if (motion?.found) return 'problem';
  return 'still';
}

/** Short badges shown on a tile and in the inspector. */
export function badgesFor(entry) {
  const out = [];
  const motion = entry.result?.motion;
  const still = entry.result?.still;
  if (motion?.playable) out.push({ text: 'MOTION', tone: 'on' });
  if (entry.live) out.push({ text: 'LIVE', tone: 'on' });
  const family = motion?.family;
  if (family === 'samsung') out.push({ text: 'SAMSUNG', tone: 'brand' });
  else if (family === 'google') out.push({ text: 'GOOGLE', tone: 'brand' });
  else if (String(family ?? '').startsWith('heif')) out.push({ text: 'HEIC ITEM', tone: 'brand' });
  const container = entry.result?.container;
  if (container === 'heif') out.push({ text: 'HEIC', tone: 'plain' });
  else if (container === 'avif') out.push({ text: 'AVIF', tone: 'plain' });
  else if (container === 'mp4') out.push({ text: 'MP4', tone: 'plain' });
  const codec = motion?.codec ?? '';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) out.push({ text: 'HEVC', tone: 'warn' });
  if (still?.width && still?.height) out.push({ text: `${still.width}×${still.height}`, tone: 'plain' });
  for (const marker of entry.result?.markers ?? []) {
    if (marker.includes('MotionPhoto_Data')) out.push({ text: 'EmbeddedVideoFile', tone: 'plain' });
  }
  return out;
}

/** Human explanation for an entry the core could not turn into a player. */
export function problemText(entry) {
  if (entry.status === 'failed') return entry.error ?? 'This file could not be read.';
  const motion = entry.result?.motion;
  if (!motion) return '';
  if (motion.playable) return '';
  if (motion.found) return motion.reason ?? 'An embedded video was detected but not extracted.';
  return '';
}
