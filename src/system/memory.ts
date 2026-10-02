/**
 * Memory manager. Keeps Otpadn inside a budget so the tab never gets killed:
 *  - ledger: big allocations we own (decoded audio, stems, undo history, ML sessions)
 *  - reclaimers: things we can drop when tight (idle workers, GPU model, old undo steps…)
 *  - guards: `ensure(bytes)` before heavy steps → reclaim → still too much? throw a clear error
 *  - monitor: every few seconds; past 80 % of budget it reclaims proactively
 *  - disk: `ensureDisk(bytes)` checks the storage quota before caching models/stems
 * Browsers don't expose exact process memory, so numbers are conservative estimates.
 */
// No imports on purpose: many modules register reclaimers at load time, so this module must
// never be part of an import cycle (it would be undefined when they run). UI hooks are bound
// from main.tsx via bindMemoryUi().
let log: (msg: string) => void = (m) => console.info(m);
let refresh: () => void = () => {};
export function bindMemoryUi(logFn: (msg: string) => void, refreshFn: () => void) {
  log = logFn;
  refresh = refreshFn;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export class MemoryGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryGuardError";
  }
}

type Kind = "audio" | "history" | "model" | "transient" | "cache";
interface Entry {
  bytes: number;
  kind: Kind;
  label: string;
}

interface Reclaimer {
  name: string;
  priority: number; // lower runs first (cheapest to lose)
  /** Free memory; return bytes freed (estimate). */
  run: (need: number) => number | Promise<number>;
}

const ledger = new Map<string, Entry>();
const reclaimers: Reclaimer[] = [];

const nav = navigator as Navigator & { deviceMemory?: number };
const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };

export const memory = {
  /**
   * Budget for everything Otpadn holds. deviceMemory is capped at 8 by browsers, so it is a floor
   * signal; we take half of it (the OS, the browser and other tabs need the rest), at least 1 GB.
   */
  budget(): number {
    // Browsers report deviceMemory rounded and capped at 8 ("8 or more"), so 8 maps to a larger
    // share; smaller devices keep half for the OS, the browser and other tabs.
    const dm = nav.deviceMemory ?? 8;
    const forced = Number(localStorage.getItem("otpadn-memory-budget-gb"));
    if (forced > 0) return forced * GB;
    return dm >= 8 ? 6 * GB : Math.max(1 * GB, dm * 0.5 * GB);
  },

  /** Track an allocation under a key (replaces an existing entry). */
  track(key: string, bytes: number, kind: Kind, label = key) {
    ledger.set(key, { bytes, kind, label });
  },
  untrack(key: string) {
    ledger.delete(key);
  },
  /** Bytes currently tracked under a key (0 if none). */
  byKey(key: string): number {
    return ledger.get(key)?.bytes ?? 0;
  },

  /** Register something that can be freed under pressure. */
  reclaimer(name: string, priority: number, run: Reclaimer["run"]) {
    const i = reclaimers.findIndex((r) => r.name === name);
    if (i >= 0) reclaimers.splice(i, 1);
    reclaimers.push({ name, priority, run });
    reclaimers.sort((a, b) => a.priority - b.priority);
  },

  used(): number {
    let n = 0;
    for (const e of ledger.values()) n += e.bytes;
    return n;
  },

  byKind(): Record<Kind, number> {
    const out: Record<Kind, number> = { audio: 0, history: 0, model: 0, transient: 0, cache: 0 };
    for (const e of ledger.values()) out[e.kind] += e.bytes;
    return out;
  },

  /** JS heap as Chrome reports it (main thread only), when available. */
  heap(): { used: number; limit: number } | null {
    return perf.memory ? { used: perf.memory.usedJSHeapSize, limit: perf.memory.jsHeapSizeLimit } : null;
  },

  free(): number {
    return this.budget() - this.used();
  },

  /** Run reclaimers (cheapest first) until `need` bytes are free. Returns bytes freed. */
  async reclaim(need: number, reason: string): Promise<number> {
    let freed = 0;
    for (const r of reclaimers) {
      if (this.free() >= need) break;
      try {
        const f = await r.run(need - this.free());
        if (f > 0) {
          freed += f;
          log(`Memory: freed ~${fmt(f)} (${r.name}) for ${reason}`);
        }
      } catch {
        /* a failing reclaimer must not block the others */
      }
    }
    return freed;
  },

  /**
   * Guard before a heavy step: make room for `bytes` or throw MemoryGuardError with advice.
   * `label` names the step for the message.
   */
  async ensure(bytes: number, label: string): Promise<void> {
    if (this.free() >= bytes) return;
    await this.reclaim(bytes, label);
    if (this.free() >= bytes) return;
    throw new MemoryGuardError(
      `Not enough memory for ${label}: needs ~${fmt(bytes)}, ~${fmt(Math.max(0, this.free()))} free of a ${fmt(this.budget())} budget. ` +
        `Delete unused tracks or stems, or start a new project, then try again.`,
    );
  },

  /** How many units of `each` bytes fit right now (after `base`), between min and max. */
  fit(each: number, base: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.floor((this.free() - base) / Math.max(1, each))));
  },

  /** Check browser storage quota before writing `bytes` to Cache/IndexedDB. */
  async ensureDisk(bytes: number, label: string): Promise<boolean> {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      if (quota && quota - usage < bytes * 1.1) {
        log(`Error: not enough browser storage for ${label} (${fmt(bytes)} needed, ${fmt(quota - usage)} left). It will work for this session but won't be saved.`);
        return false;
      }
    } catch {
      /* estimate unavailable: assume fine */
    }
    return true;
  },

  /** Ask the browser not to evict our caches under storage pressure (silently ignored if denied). */
  async persistStorage() {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch {
      /* not supported */
    }
  },
};

export const fmt = (b: number) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

/* ── estimates (bytes) ───────────────────────────────────────────────────── */

export const est = {
  /** Float32 PCM. */
  pcm: (seconds: number, sampleRate: number, channels: number) => Math.ceil(seconds * sampleRate) * channels * 4,
  /** Decoded size of a compressed file, before decoding: assumes ≥ 96 kb/s for lossy, 16-bit for PCM files. */
  decodedFromFile(file: File, sampleRate: number): number {
    const lossless = /\.(wav|wave|aif|aiff)$/i.test(file.name) || /wav|aiff/.test(file.type);
    const seconds = lossless ? file.size / (44100 * 2 * 2) : (file.size * 8) / 96_000;
    return this.pcm(seconds, sampleRate, 2);
  },
  /** One HTDemucs WASM session (weights + activations). */
  demucsSession: 1.3 * GB,
  /** MuScriptor small, fp16 on the GPU, plus staging in the worker. */
  muscriptor: (model: "small" | "medium") => (model === "small" ? 450 : 1200) * MB,
};

/* ── monitor ─────────────────────────────────────────────────────────────── */

let started = false;
export function startMemoryMonitor() {
  if (started) return;
  started = true;
  setInterval(async () => {
    const budget = memory.budget();
    const used = memory.used();
    const heap = memory.heap();
    const heapTight = heap && heap.used > heap.limit * 0.8;
    if (used > budget * 0.8 || heapTight) await memory.reclaim(Math.max(used - budget * 0.65, 64 * MB), "background (memory above 80%)");
    refresh(); // status-bar meter
  }, 5000);
  // Out-of-memory while allocating anywhere: try to recover instead of dying.
  window.addEventListener("error", (e) => {
    if (/allocation failed|out of memory|Array buffer allocation/i.test(String(e.message))) {
      memory.reclaim(Infinity, "out-of-memory recovery");
      log("Error: the browser ran out of memory; freed what could be freed. Try again, or remove unused tracks.");
    }
  });
}
