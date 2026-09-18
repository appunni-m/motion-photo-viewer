/**
 * Optional still decoders.
 *
 * The browser draws JPEG, PNG, WebP and AVIF by itself, and Safari draws HEIC.
 * That path is always tried first, because it is native, fast, and free. When it
 * fails - a HEIC in Chrome, which has no HEVC decoder - the viewer can hand the
 * bytes to a decoder module instead.
 *
 * A module is installed by placing it at `decoders/<id>.js` in the site. Nothing
 * is shipped there by default, so an installation without one costs exactly
 * nothing: one failed fetch, remembered, and the honest explanation stands.
 *
 * See `docs/DECODERS.md` for the contract a module implements.
 */

/**
 * Decoders this viewer knows how to ask, and whether each is installed. The page
 * declares what the build shipped (`<meta name="motion-photo-decoders">`), so an
 * installation without one never requests a file that is not there.
 */
const KNOWN = [
  {
    id: 'hevc',
    label: 'HEIC',
    /** Containers whose pictures the module claims it can decode. */
    containers: ['heif'],
    url: () => new URL('../decoders/hevc.js', import.meta.url),
  },
];

function declaredIds() {
  const meta = document.querySelector('meta[name="motion-photo-decoders"]');
  const value = meta?.getAttribute('content') ?? '';
  // An unbuilt page keeps its placeholder: that means none.
  if (!value || value.includes('__DECODERS__')) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const MODULES = KNOWN.filter((module) => declaredIds().includes(module.id));

/** id -> { status, decoder, promise }. Status: unknown, loading, ready, absent, failed. */
const registry = new Map();

function entryFor(id) {
  let entry = registry.get(id);
  if (!entry) {
    entry = { status: 'unknown', decoder: null, promise: null, reason: '' };
    registry.set(id, entry);
  }
  return entry;
}

/** What the viewer can say about its decoders without loading anything. */
export function decoderStatus() {
  return MODULES.map((module) => {
    const entry = entryFor(module.id);
    return { id: module.id, label: module.label, status: entry.status, reason: entry.reason };
  });
}

/**
 * The decoder responsible for a container, loading it if it is installed.
 * Resolves to `null` when nothing is installed for that format, which is the
 * normal case and not an error.
 */
export async function decoderFor(container) {
  for (const module of MODULES) {
    if (!module.containers.includes(container)) continue;
    const entry = entryFor(module.id);
    if (entry.status === 'ready') return entry.decoder;
    if (entry.status === 'absent' || entry.status === 'failed') return null;
    if (entry.status === 'loading') return entry.promise;

    entry.status = 'loading';
    entry.promise = (async () => {
      const url = module.url();
      try {
        // Declared installed, so this import is expected to succeed; a failure
        // here means a broken installation, not a missing one.
        const decoded = await import(/* @vite-ignore */ url.href);
        const factory = decoded.default;
        if (typeof factory !== 'function') throw new Error('module has no default export');
        const decoder = await factory();
        if (typeof decoder?.decode !== 'function') throw new Error('decoder has no decode()');
        entry.status = 'ready';
        entry.decoder = decoder;
        return decoder;
      } catch (error) {
        entry.status = 'failed';
        entry.reason = String(error?.message ?? error);
        return null;
      }
    })();
    return entry.promise;
  }
  return null;
}

/**
 * Decodes still bytes with an installed module.
 *
 * @returns {Promise<{width: number, height: number, rgba: Uint8ClampedArray}|null>}
 */
export async function decodeStill(container, bytes, info = {}) {
  const decoder = await decoderFor(container);
  if (!decoder) return null;
  try {
    const frame = await decoder.decode(bytes, { container, ...info });
    if (!frame?.rgba || !frame.width || !frame.height) return null;
    return frame;
  } catch {
    return null;
  }
}

/** True once a module has been loaded, without triggering a load. */
export function decoderLoaded() {
  for (const entry of registry.values()) {
    if (entry.status === 'ready') return true;
  }
  return false;
}
