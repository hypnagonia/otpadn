import type { DEMUCS_SOURCES as SourcesT } from "./demucs.worker";

/** Hugging Face-hosted ONNX export (MIT). fp16-stored weights: 136 MB, cached after first use. */
export const DEMUCS_MODEL_URL = "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx";
export const DEMUCS_MODEL_MB = 136;
export const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals", "guitar", "piano"] as const satisfies typeof SourcesT;
export type DemucsStem = (typeof DEMUCS_SOURCES)[number];

export let demucsBackend = "";

const SR = 44100;
const N = Math.floor(7.8 * SR);
const STRIDE = N - Math.floor(N / 4);
// v2: browsers locked to "cpu" by the old WebGPU loader bug retry the GPU once.
const EP_KEY = "otpadn-demucs-ep-v2";
const GPU_INIT_TIMEOUT_MS = 90_000;

import { est, memory } from "../system/memory";

const spawn = () => new Worker(new URL("./demucs.worker.ts", import.meta.url), { type: "module" });

/** Is the model already in the browser cache (no download needed)? */
export async function demucsCached(): Promise<boolean> {
  try {
    return !!(await (await caches.open("stemdaw-models")).match(`${DEMUCS_MODEL_URL}?otpadn=f32-v1`));
  } catch {
    return false;
  }
}

/** Resample any buffer to 44.1 kHz stereo on the native audio thread. */
async function to44kStereo(buf: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(buf.duration * sr), sr);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

export interface DemucsProgress {
  phase: "download" | "init" | "separate";
  progress: number;
  detail?: string;
}

type Part = { stems: Float32Array[][]; weight: Float32Array; base: number; backend: string };

/** Run one worker over chunks [c0, c1). Rejects on error, crash, or (WebGPU) a stalled init. */
function runWorker(w: Worker, left: Float32Array, right: Float32Array, ep: "webgpu" | "wasm", c0: number, c1: number, on: (m: { type: string; [k: string]: unknown }) => void): Promise<Part> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    // The clock starts when the model starts initialising on the GPU (not during its download).
    const arm = () => {
      if (ep === "webgpu" && timer === undefined) timer = window.setTimeout(() => reject(new Error("webgpu-timeout")), GPU_INIT_TIMEOUT_MS);
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "status" && String(m.status).startsWith("initialising")) arm();
      if (m.type === "backend") clearTimeout(timer);
      if (m.type === "done") resolve(m as Part);
      else if (m.type === "error") reject(new Error(m.error));
      else on(m);
    };
    w.onerror = (e) => {
      e.preventDefault();
      reject(new Error(`AI stem worker crashed: ${e.message || "out of memory?"}`));
    };
    w.postMessage({ type: "separate", jobId: 1, modelUrl: DEMUCS_MODEL_URL, left, right, ep, c0, c1 });
  });
}

/** How many parallel WASM sessions this machine can afford (~1.2 GB each). */
function wasmWorkers(base: number): number {
  const forced = Number(localStorage.getItem("otpadn-demucs-workers"));
  if (forced >= 1) return Math.min(8, forced);
  const cores = navigator.hardwareConcurrency || 4;
  // As many ~1.3 GB sessions as fit in the free budget after the song's own buffers, max 3.
  return memory.fit(est.demucsSession, base, 1, Math.min(3, Math.max(1, Math.floor(cores / 2))));
}

/**
 * Separate into 6 stems (44.1 kHz AudioBuffers). WebGPU first (one worker); if it errors or
 * doesn't initialise within 90 s, fall back to several parallel WASM workers and remember that.
 */
export async function demucsSeparate(buf: AudioBuffer, onProgress: (p: DemucsProgress) => void): Promise<Record<DemucsStem, AudioBuffer>> {
  // Peak: song at 44.1 kHz stereo + per-worker partials (6 stems) + final AudioBuffers (6 stems).
  const songBytes = est.pcm(buf.duration, SR, 2);
  const base = songBytes * (1 + 6 * 2);
  await memory.ensure(base + est.demucsSession, "AI stem split");
  memory.track("demucs:run", base, "transient", "AI stem split in progress");
  try {
    return await demucsInner(buf, onProgress, base);
  } finally {
    memory.untrack("demucs:run");
    memory.untrack("demucs:sessions");
  }
}

async function demucsInner(buf: AudioBuffer, onProgress: (p: DemucsProgress) => void, base: number): Promise<Record<DemucsStem, AudioBuffer>> {
  const [left, right] = await to44kStereo(buf);
  const total = left.length;
  const nChunks = Math.max(1, Math.ceil(total / STRIDE));
  const status = (m: { type: string; [k: string]: unknown }, done: () => number) => {
    if (m.type === "download") onProgress({ phase: "download", progress: m.progress as number, detail: `${(m.mb as number).toFixed(0)} / ${(m.totalMb as number).toFixed(0)} MB` });
    else if (m.type === "status") onProgress({ phase: "init", progress: 1, detail: m.status as string });
    else if (m.type === "backend") demucsBackend = m.backend as string;
    else if (m.type === "progress") onProgress({ phase: "separate", progress: done() / nChunks, detail: (m.eta as number) > 1 ? `~${Math.ceil(m.eta as number)} s left` : undefined });
  };

  let parts: Part[] | null = null;
  const preferGpu = "gpu" in navigator && localStorage.getItem(EP_KEY) !== "wasm";
  if (preferGpu) {
    const w = spawn();
    let done = 0;
    try {
      parts = [await runWorker(w, left, right, "webgpu", 0, nChunks, (m) => {
        if (m.type === "progress") done = m.done as number;
        status(m, () => done);
      })];
      localStorage.setItem(EP_KEY, "webgpu");
    } catch (e) {
      const msg = (e as Error).message;
      // Remember "CPU only" just for real WebGPU problems — not for download/network errors.
      if (!/download|network|fetch|HTTP/i.test(msg)) localStorage.setItem(EP_KEY, "wasm");
      onProgress({ phase: "init", progress: 1, detail: `webgpu unavailable (${(e as Error).message}), using cpu workers…` });
    } finally {
      w.terminate();
    }
  }
  if (!parts) {
    // Make sure the (patched) model is in the cache before fanning out.
    const prep = spawn();
    await new Promise<void>((resolve, reject) => {
      const w = prep;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "prepared") resolve();
        else if (m.type === "error") reject(new Error(m.error));
        else status(m, () => 0);
      };
      w.onerror = (e) => reject(new Error(e.message || "worker crashed"));
      w.postMessage({ type: "prepare", jobId: 1, modelUrl: DEMUCS_MODEL_URL });
    }).finally(() => prep.terminate());
    const per = Math.ceil(nChunks / Math.min(wasmWorkers(base), nChunks));
    const n = Math.ceil(nChunks / per); // never a worker with an empty chunk range (short audio)
    memory.track("demucs:sessions", n * est.demucsSession, "model", `HTDemucs ×${n}`);
    const done = new Array(n).fill(0);
    const workers = Array.from({ length: n }, spawn);
    try {
      parts = await Promise.all(
        workers.map((w, i) =>
          runWorker(w, left.slice(), right.slice(), "wasm", i * per, Math.min(nChunks, (i + 1) * per), (m) => {
            if (m.type === "progress") done[i] = m.done as number;
            status(m, () => done.reduce((a, b) => a + b, 0));
          }),
        ),
      );
      demucsBackend = `wasm ×${n}`;
    } finally {
      workers.forEach((w) => w.terminate());
    }
  }

  // Overlap-add the partial results straight into the final AudioBuffers (no extra full-size
  // copies), then normalise by the summed cross-fade weights.
  const stems = {} as Record<DemucsStem, AudioBuffer>;
  const outBufs = DEMUCS_SOURCES.map((name) => (stems[name] = new AudioBuffer({ numberOfChannels: 2, length: total, sampleRate: SR })));
  const weight = new Float32Array(total);
  for (const p of parts) for (let i = 0; i < p.weight.length; i++) weight[p.base + i] += p.weight[i];
  for (let k = 0; k < outBufs.length; k++)
    for (let ch = 0; ch < 2; ch++) {
      const dst = outBufs[k].getChannelData(ch);
      for (const p of parts) {
        const src = p.stems[k][ch];
        for (let i = 0; i < src.length; i++) dst[p.base + i] += src[i];
        p.stems[k][ch] = new Float32Array(0); // release this partial as soon as it's merged
      }
      for (let i = 0; i < total; i++) dst[i] /= Math.max(weight[i], 1e-8);
    }
  return stems;
}
