import type { SepResult } from "./dsp.worker";
import { memory } from "../system/memory";

const MARGIN = 8; // must match dsp.worker.ts
export const STFT_N = 2048;
export const STFT_HOP = 512;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; worker: Worker; onProgress?: (done: number, total: number) => void };

class DspPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextJob = 1;
  private rr = 0;

  get size() {
    return Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  }

  private idleTimer: number | undefined;
  /** Terminate all workers when nothing is running (they respawn lazily). Returns true if done. */
  shutdown(): boolean {
    if (this.pending.size) return false;
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    return true;
  }
  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.shutdown(), 60_000); // idle a minute → free them
  }

  private ensure() {
    this.touch();
    if (this.workers.length) return;
    for (let i = 0; i < this.size; i++) this.workers.push(this.spawnReplacement());
  }

  private spawnReplacement(): Worker {
    {
      const w = new Worker(new URL("./dsp.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const m = e.data;
        const p = this.pending.get(m.jobId);
        if (!p) return;
        if (m.type === "progress") p.onProgress?.(m.done, m.total);
        else {
          this.pending.delete(m.jobId);
          p.resolve(m);
        }
      };
      // A crashed worker (e.g. out of memory) fails its jobs instead of hanging the UI forever.
      w.onerror = (e) => {
        e.preventDefault();
        for (const [id, p] of this.pending)
          if (p.worker === w) {
            this.pending.delete(id);
            p.reject(new Error(`DSP worker crashed: ${e.message || "unknown error (out of memory?)"}`));
          }
        this.workers[this.workers.indexOf(w)] = this.spawnReplacement();
      };
      return w;
    }
  }

  private run<T>(msg: any, transfer: Transferable[] = [], onProgress?: Pending["onProgress"], worker?: number): Promise<T> {
    this.ensure();
    const jobId = this.nextJob++;
    const w = this.workers[worker ?? this.rr++ % this.workers.length];
    return new Promise<T>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject, worker: w, onProgress });
      w.postMessage({ ...msg, jobId }, transfer);
    });
  }

  async peaks(buf: AudioBuffer, block: number): Promise<Float32Array> {
    const data = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
    const r = await this.run<{ peaks: Float32Array }>({ type: "peaks", data, block }, data.map((d) => d.buffer));
    return r.peaks;
  }

  async lufs(buf: AudioBuffer): Promise<number> {
    const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
    const r = await this.run<{ lufs: number }>({ type: "lufs", channels, sr: buf.sampleRate }, channels.map((d) => d.buffer));
    return r.lufs;
  }

  /** 24-bit WAV encoding off the main thread. */
  async wav(buf: AudioBuffer): Promise<Blob> {
    const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
    const r = await this.run<{ data: ArrayBuffer }>({ type: "wav", channels, sr: buf.sampleRate }, channels.map((d) => d.buffer));
    return new Blob([r.data], { type: "audio/wav" });
  }

  /** Split the song across all workers, separate stems + extract features, stitch. */
  async separate(buf: AudioBuffer, onProgress: (p: number) => void, featuresOnly = false): Promise<SeparationOutput> {
    this.ensure();
    // Chunk copies in flight + 4 stereo stems being stitched (none for features-only).
    const pcm = buf.length * 2 * 4;
    const need = featuresOnly ? pcm * 1.2 : pcm * 10;
    await memory.ensure(need, featuresOnly ? "song analysis" : "quick stem split");
    memory.track("dsp:separate", need, "transient", "stem split in progress");
    try {
      return await this.separateInner(buf, onProgress, featuresOnly);
    } finally {
      memory.untrack("dsp:separate");
    }
  }

  private async separateInner(buf: AudioBuffer, onProgress: (p: number) => void, featuresOnly: boolean): Promise<SeparationOutput> {
    this.ensure(); // the memory guard may have reclaimed idle workers a moment ago
    const sr = buf.sampleRate;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const totalLen = L.length;
    const N = STFT_N, hop = STFT_HOP;
    const T = Math.ceil(totalLen / hop) + 1;
    const nChunks = Math.min(T, this.workers.length * 2);
    const per = Math.ceil(T / nChunks);
    const progress = new Array(nChunks).fill(0);
    const report = () => onProgress(progress.reduce((a, b) => a + b, 0) / T);

    const jobs: Promise<SepResult>[] = [];
    for (let c = 0; c < nChunks; c++) {
      const t0 = c * per;
      const t1 = Math.min(T, t0 + per);
      if (t0 >= t1) break;
      const s0 = Math.max(0, (t0 - MARGIN) * hop - N / 2);
      const s1 = Math.min(totalLen, (t1 + MARGIN) * hop + N / 2);
      const left = L.slice(s0, s1);
      const right = R.slice(s0, s1);
      jobs.push(
        this.run<SepResult>(
          { type: "sep", sr, N, hop, totalLen, t0, t1, sampleStart: s0, left, right, featuresOnly },
          [left.buffer, right.buffer],
          (done) => {
            progress[c] = done;
            report();
          },
          c % this.workers.length,
        ).then((r) => {
          progress[c] = t1 - t0;
          report();
          return r;
        }),
      );
    }
    const results = await Promise.all(jobs);

    const stemNames = ["drums", "bass", "vocals", "other"] as const;
    const stems = {} as Record<(typeof stemNames)[number], [Float32Array, Float32Array]>;
    const outLen = featuresOnly ? 0 : totalLen;
    for (const name of stemNames) stems[name] = [new Float32Array(outLen), new Float32Array(outLen)];
    const onset = new Float32Array(T);
    const lowOnset = new Float32Array(T);
    const energy = new Float32Array(T);
    const chroma = new Float32Array(T * 12);
    const bassChroma = new Float32Array(T * 12);
    for (const r of results) {
      for (const name of featuresOnly ? [] : stemNames) {
        for (let ch = 0; ch < 2; ch++) {
          const src = r.stems[name][ch];
          const dst = stems[name][ch];
          const a = Math.max(0, -r.outStart);
          const b = Math.min(src.length, totalLen - r.outStart);
          for (let i = a; i < b; i++) dst[r.outStart + i] += src[i];
        }
      }
      onset.set(r.onset, r.t0);
      lowOnset.set(r.lowOnset, r.t0);
      energy.set(r.energy, r.t0);
      chroma.set(r.chroma, r.t0 * 12);
      bassChroma.set(r.bassChroma, r.t0 * 12);
    }
    return { stems, features: { fps: sr / hop, onset, lowOnset, energy, chroma, bassChroma } };
  }
}

export interface Features {
  fps: number;
  onset: Float32Array;
  lowOnset: Float32Array;
  energy: Float32Array;
  chroma: Float32Array;
  bassChroma: Float32Array;
}

export interface SeparationOutput {
  stems: Record<"drums" | "bass" | "vocals" | "other", [Float32Array, Float32Array]>;
  features: Features;
}

export const dspPool = new DspPool();
memory.reclaimer("idle DSP workers", 20, () => (dspPool.shutdown() ? 32 * 1024 * 1024 : 0));
