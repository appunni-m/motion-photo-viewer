/**
 * Folder and file intake.
 *
 * Prefers the File System Access API when the browser has it, falls back to
 * `webkitdirectory` input and drag-and-drop. In every path the result is a list
 * of `File` handles: no bytes are read here, and nothing is copied anywhere.
 */

const STILL_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'heic', 'heif', 'hif', 'avif', 'png', 'webp', 'gif', 'tif', 'tiff',
  'bmp', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef',
]);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'webm', 'avi', 'hevc', '265']);

/**
 * Names that sit next to real photographs and are never photographs.
 *
 * A folder copied off a Mac carries an AppleDouble file for every picture
 * (`._IMG_3207.heic`, 4 kB of resource fork). They have the extension of an
 * image, so without this they become a grid full of unreadable tiles - half the
 * folder, on one real sample.
 */
export function isJunk(name) {
  return (
    name.startsWith('._') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('.Spotlight-') ||
    name.startsWith('.fseventsd')
  );
}

export function extensionOf(name) {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
}

export function isScannable(file) {
  if (isJunk(file.name)) return false;
  const ext = extensionOf(file.name);
  return STILL_EXT.has(ext) || VIDEO_EXT.has(ext);
}

/**
 * The key used to pair a still with a video companion.
 *
 * Exactly the file name without its extension. That is how every real
 * convention stores a pair - `IMG_1234.HEIC` with `IMG_1234.MOV` from Apple,
 * `PXL_….jpg` with `PXL_….mp4` from Google Takeout - and anything looser starts
 * pairing unrelated files. Stripping suffixes like `-video` or `-b` looks
 * helpful but is not a convention any camera writes, and it turns an ordinary
 * picture into a Live Photo as soon as a same-named clip exists.
 */
export function pairKey(name) {
  const at = name.lastIndexOf('.');
  return (at <= 0 ? name : name.slice(0, at)).toLowerCase();
}

/**
 * Pairs stills with a separately stored video of the same name.
 *
 * This is the one motion-photo shape that is not a single file, so it is the
 * one shape the WASM core cannot see. It is resolved here, cheaply, without
 * reading anything.
 */
export function pairLivePhotos(entries) {
  const videos = new Map();
  for (const entry of entries) {
    if (entry.family !== 'video' && !VIDEO_EXT.has(entry.ext)) continue;
    const key = pairKey(entry.name);
    const list = videos.get(key);
    if (list) list.push(entry);
    else videos.set(key, [entry]);
  }
  let paired = 0;
  for (const entry of entries) {
    if (entry.family === 'video') continue;
    const candidates = videos.get(pairKey(entry.name));
    if (!candidates?.length) continue;
    // Prefer the smallest plausible companion: a Live Photo video is short.
    const companion = candidates.reduce((a, b) => (a.file.size <= b.file.size ? a : b));
    if (entry.live) continue;
    entry.live = { entry: companion, by: 'name' };
    companion.hiddenAsCompanion = true;
    paired += 1;
  }
  return paired;
}

export function entryFromFile(file, path = '') {
  const name = file.name;
  const ext = extensionOf(name);
  return {
    id: `${path || name}:${file.size}:${file.lastModified}`,
    file,
    name,
    path: path || name,
    ext,
    size: file.size,
    lastModified: file.lastModified,
    scannable: !isJunk(name) && (STILL_EXT.has(ext) || VIDEO_EXT.has(ext)),
    family: VIDEO_EXT.has(ext) ? 'video' : 'unknown',
    result: null,
    stats: null,
    live: null,
    hiddenAsCompanion: false,
    status: 'pending',
  };
}

/** Recursively walks a dropped directory entry (the drag-and-drop path). */
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push(entryFromFile(file, prefix + entry.name));
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Reads a folder from a drag-and-drop event. */
export async function filesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer.items ?? []);
  const out = [];
  const roots = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) out.push(entryFromFile(file));
    }
  }
  if (roots.length) {
    // Directories first, so a bare file drop still works.
    await Promise.all(roots.map((root) => walkEntry(root, '', out)));
  }
  if (!out.length) {
    for (const file of Array.from(dataTransfer.files ?? [])) out.push(entryFromFile(file));
  }
  return out;
}

/** Reads a folder through the File System Access API. */
export async function pickDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') return null;
  const handle = await window.showDirectoryPicker({ mode: 'read', id: 'motion-photos' });
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, child] of dir.entries()) {
      if (child.kind === 'file') {
        const file = await child.getFile();
        out.push(entryFromFile(file, prefix + name));
      } else if (child.kind === 'directory') {
        await walk(child, `${prefix}${name}/`);
      }
    }
  };
  await walk(handle, `${handle.name}/`);
  return out;
}

export function filesFromInput(input) {
  const files = Array.from(input.files ?? []);
  return files.map((file) => entryFromFile(file, file.webkitRelativePath || ''));
}
