/**
 * Scan scheduler.
 *
 * Fan-out is bounded by a small worker pool. Probing a file is a handful of
 * small reads plus a microsecond-scale WASM parse, so the pool exists to hide
 * disk latency, not to burn cores.
 */

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class Scanner {
  #onResult;
  #onProgress;
  #workers = [];
  #queue = [];
  #next = 0;
  #active = 0;
  #done = 0;
  #cancelled = false;
  #totals = { bytesRead: 0, reads: 0, ms: 0, bytes: 0, files: 0 };
  #progressTimer = 0;
  #resolveRun = null;

  constructor({ onResult, onProgress, concurrency } = {}) {
    this.#onResult = onResult ?? (() => {});
    this.#onProgress = onProgress ?? (() => {});
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.concurrency = Math.max(1, Math.min(concurrency ?? 6, hw));
  }

  get totals() {
    return { ...this.#totals };
  }

  get cancelled() {
    return this.#cancelled;
  }

  #spawn() {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (event) => this.#settle(worker, event.data);
    worker.onerror = (event) => {
      this.#settle(worker, {
        ok: false,
        error: event.message || 'worker failed to start',
        id: worker.__currentId,
      });
    };
    worker.__busy = false;
    return worker;
  }

  #settle(worker, message) {
    const entry = worker.__entry;
    worker.__busy = false;
    worker.__entry = null;
    this.#active -= 1;

    if (entry) {
      this.#done += 1;
      if (message?.ok) {
        this.#totals.bytesRead += message.stats?.bytesRead ?? 0;
        this.#totals.reads += message.stats?.reads ?? 0;
        this.#totals.ms += message.stats?.ms ?? 0;
        this.#onResult(entry, message.result, message.stats);
      } else {
        this.#onResult(
          entry,
          { ok: false, kind: 'unknown', container: 'unknown', notes: [message?.error ?? 'scan failed'] },
          { bytesRead: 0, reads: 0, ms: 0 },
        );
      }
    }
    this.#pump();
  }

  #pump() {
    if (this.#cancelled) {
      this.#maybeFinish();
      return;
    }
    for (const worker of this.#workers) {
      if (worker.__busy || this.#next >= this.#queue.length) continue;
      const entry = this.#queue[this.#next];
      this.#next += 1;
      worker.__busy = true;
      worker.__entry = entry;
      this.#active += 1;
      this.#totals.bytes = this.#totals.bytes;
      worker.__currentId = entry.id;
      worker.postMessage({ id: entry.id, type: 'scan', file: entry.file });
    }
    this.#tick(true);
    this.#maybeFinish();
  }

  #maybeFinish() {
    const finished = this.#cancelled || this.#done >= this.#queue.length;
    if (finished && this.#active === 0 && this.#resolveRun) {
      const resolve = this.#resolveRun;
      this.#resolveRun = null;
      resolve(this.totals);
    }
  }

  #tick(force = false) {
    const now = performance.now();
    if (!force && now - this.#progressTimer < 90) return;
    this.#progressTimer = now;
    this.#onProgress({
      done: this.#done,
      total: this.#queue.length,
      active: this.#active,
      bytesRead: this.#totals.bytesRead,
      ms: this.#totals.ms,
    });
  }

  /** Scans every entry, resolving when the queue drains. */
  run(entries) {
    this.cancel();
    this.#cancelled = false;
    this.#queue = entries;
    this.#next = 0;
    this.#done = 0;
    this.#active = 0;
    this.#totals = { bytesRead: 0, reads: 0, ms: 0, bytes: 0, files: entries.length };
    if (!this.#workers.length) {
      for (let i = 0; i < this.concurrency; i += 1) this.#workers.push(this.#spawn());
    }
    this.#tick(true);
    const promise = new Promise((resolve) => {
      this.#resolveRun = resolve;
    });
    this.#pump();
    return promise;
  }

  cancel() {
    this.#cancelled = true;
    this.#queue = [];
    this.#maybeFinish();
  }

  dispose() {
    this.cancel();
    for (const worker of this.#workers) worker.terminate();
    this.#workers = [];
  }
}

/**
 * Re-runs one file with a much larger budget. This is the explicit escape hatch
 * for files whose video header sits in the middle: it is never done implicitly,
 * because it can mean reading a large part of a file.
 */
export async function deepScan(file, options = {}) {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data ?? {};
        if (message.ok) resolve({ result: message.result, stats: message.stats });
        else reject(new Error(message.error ?? 'deep scan failed'));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'worker failed'));
      worker.postMessage({
        id: 1,
        type: 'scan',
        file,
        options: {
          headBytes: options.headBytes ?? 2 * 1024 * 1024,
          tailBytes: options.tailBytes ?? 2 * 1024 * 1024,
          maxHeadBytes: 8 * 1024 * 1024,
          maxTailBytes: 8 * 1024 * 1024,
          maxReads: 24,
          maxBytes: 24 * 1024 * 1024,
        },
      });
    });
  } finally {
    worker.terminate();
  }
}

/** Warms the WASM instance so the first file does not pay for compilation. */
export async function preloadCore() {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  try {
    await new Promise((resolve) => {
      worker.onmessage = resolve;
      worker.onerror = resolve;
      worker.postMessage({ id: 0, type: 'preload' });
    });
  } finally {
    worker.terminate();
  }
}
