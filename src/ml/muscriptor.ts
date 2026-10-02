/**
 * Audio → MIDI with MuScriptor (Kyutai & Mirelo; weights CC BY-NC 4.0), via the WebGPU engine
 * vendored from byEar (src/ml/muscriptor/). One worker owns the weights and the GPU; we feed it
 * 5 s, 16 kHz mono chunks of a whole track and collect start/end note events per instrument.
 */
import { INSTRUMENT_NAMES, SAMPLE_RATE, SEGMENT_SAMPLES } from "./muscriptor/vocab.js";
import { est, memory } from "../system/memory";

export type MuscriptorModel = "small" | "medium";
export const MUSCRIPTOR_SIZES: Record<MuscriptorModel, { label: string; mb: number }> = {
  small: { label: "fast", mb: 200 },
  medium: { label: "accurate", mb: 600 },
};
export const MUSCRIPTOR_INSTRUMENTS = INSTRUMENT_NAMES as string[];

export interface TranscribedNote {
  instrument: string; // MuScriptor group name, e.g. "electric_bass", "voice", "drums"
  pitch: number;
  start: number; // seconds from the start of the audio
  end: number;
}

export interface MuscriptorProgress {
  phase: "download" | "gpu" | "transcribe";
  progress: number | null;
  detail?: string;
}

let worker: Worker | null = null;
let loaded: { model: MuscriptorModel; promise: Promise<string> } | null = null;
let partSeq = 0;
export let muscriptorGpu = "";

const listeners = new Set<(m: Record<string, unknown>) => void>();
let busyJobs = 0;
let idleTimer: number | undefined;

/** Free the GPU model + worker (reloads from the browser cache on next use). */
export function shutdownMuscriptor(): boolean {
  if (!worker || busyJobs > 0) return false;
  worker.terminate();
  worker = null;
  loaded = null;
  muscriptorGpu = "";
  memory.untrack("model:muscriptor");
  return true;
}
const touchIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(shutdownMuscriptor, 3 * 60_000); // idle 3 min → release GPU memory
};
memory.reclaimer("idle audio → MIDI model", 30, () => (shutdownMuscriptor() ? est.muscriptor("small") : 0));
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./muscriptor/worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => listeners.forEach((l) => l(e.data));
  worker.onerror = (e) => {
    e.preventDefault();
    listeners.forEach((l) => l({ type: "loadError", message: e.message || "audio → MIDI worker crashed" }));
  };
  return worker;
}

function on(fn: (m: Record<string, unknown>) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Load (download once, then cached) and upload weights to the GPU. Resolves with the GPU name. */
function ensureLoaded(model: MuscriptorModel, onProgress: (p: MuscriptorProgress) => void): Promise<string> {
  if (loaded?.model === model) return loaded.promise;
  if (!("gpu" in navigator)) return Promise.reject(new Error("Audio → MIDI needs WebGPU (Chrome 116+, Edge, or Safari 26+)."));
  const w = getWorker();
  const promise = new Promise<string>((resolve, reject) => {
    const off = on((m) => {
      if (m.type === "progress") {
        const phase = m.phase as string;
        const frac = (m.frac as number | null) ?? null;
        if (phase === "gpu") onProgress({ phase: "gpu", progress: frac, detail: "uploading model to the GPU" });
        else if (phase === "download")
          onProgress({ phase: "download", progress: frac, detail: m.total ? `${((m.loaded as number) / 1e6).toFixed(0)} / ${((m.total as number) / 1e6).toFixed(0)} MB` : undefined });
        else onProgress({ phase: "download", progress: null, detail: phase === "cache" ? "from browser cache" : phase });
      } else if (m.type === "ready") {
        off();
        memory.track("model:muscriptor", est.muscriptor(model), "model", `audio → MIDI model (${model})`);
        muscriptorGpu = ((m.info as { gpu?: string })?.gpu ?? "").trim() || "webgpu";
        resolve(muscriptorGpu);
      } else if (m.type === "loadError") {
        off();
        reject(new Error(String(m.message)));
      }
    });
    w.postMessage({ type: "load", model, f16: true, autoLevel: true });
  });
  loaded = { model, promise };
  promise.catch(() => {
    if (loaded?.promise === promise) loaded = null;
  });
  return promise;
}

/** Resample to 16 kHz mono on the native audio thread. */
export async function to16kMono(buf: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

export interface TranscribeOptions {
  model?: MuscriptorModel;
  /** Hard restriction (also conditions the model); null = listen for everything. */
  instruments?: string[] | null;
  /** Extra vocal pass (songs with singing). */
  vocals?: boolean;
  /** Pre-resampled 16 kHz mono audio (skips resampling). */
  samples?: Float32Array;
  /** Start the 5 s chunk grid this many seconds in (a second pass with shifted boundaries). */
  offset?: number;
}

/** Transcribe a whole buffer. Notes come back in seconds, grouped by MuScriptor instrument. */
export async function transcribeMuscriptor(buf: AudioBuffer, opts: TranscribeOptions, onProgress: (p: MuscriptorProgress) => void): Promise<TranscribedNote[]> {
  const model = opts.model ?? "small";
  const audio = est.pcm(buf.duration, SAMPLE_RATE, 1) * 2;
  await memory.ensure((loaded?.model === model ? 0 : est.muscriptor(model)) + audio, "MIDI conversion");
  busyJobs++;
  clearTimeout(idleTimer);
  try {
    return await transcribeInner(buf, { ...opts, model }, onProgress);
  } finally {
    busyJobs--;
    touchIdle();
  }
}

async function transcribeInner(buf: AudioBuffer, opts: TranscribeOptions, onProgress: (p: MuscriptorProgress) => void): Promise<TranscribedNote[]> {
  await ensureLoaded(opts.model ?? "small", onProgress);
  const samples = opts.samples ?? (await to16kMono(buf));
  const w = getWorker();
  const part = `otpadn-${++partSeq}`;
  const chunkSec = SEGMENT_SAMPLES / SAMPLE_RATE;
  const off = Math.round((opts.offset ?? 0) * SAMPLE_RATE);
  const nChunks = Math.max(1, Math.ceil((samples.length - off) / SEGMENT_SAMPLES));
  const starts = new Map<number, { instrument: string; pitch: number; time: number }>();
  const notes: TranscribedNote[] = [];
  let done = 0;
  const t0 = performance.now();

  const result = new Promise<TranscribedNote[]>((resolve, reject) => {
    const off = on((m) => {
      if (m.type === "error" || m.type === "loadError") {
        // A failed chunk still delivers its (partial) events next; only a lost model aborts.
        if (m.type === "loadError" || m.code === "gpu-lost") {
          off();
          worker?.terminate();
          worker = null;
          loaded = null;
          memory.untrack("model:muscriptor");
          reject(new Error(String(m.message)));
        } else console.warn("audio → MIDI chunk error:", m.message);
        return;
      }
      if (m.type !== "events" || m.part !== part) return;
      for (const ev of (m.events as Array<Record<string, unknown>>) ?? []) {
        if (ev.type === "start") starts.set(ev.index as number, { instrument: ev.instrument as string, pitch: ev.pitch as number, time: ev.time as number });
        else if (ev.type === "end") {
          const s = starts.get(ev.index as number);
          if (!s) continue;
          starts.delete(ev.index as number);
          notes.push({ instrument: s.instrument, pitch: s.pitch, start: s.time, end: Math.max(s.time + 0.01, ev.time as number) });
        }
      }
      if (m.final) {
        off();
        resolve(notes);
        return;
      }
      if (m.seek != null) {
        done++;
        const eta = ((performance.now() - t0) / done) * (nChunks - done) / 1000;
        onProgress({ phase: "transcribe", progress: done / nChunks, detail: eta > 1 ? `~${Math.ceil(eta)} s left` : undefined });
      }
    });
  });

  w.postMessage({ type: "instruments", names: opts.instruments ?? null });
  w.postMessage({ type: "part", part });
  w.postMessage({ type: "hint", part, names: opts.vocals ? ["voice"] : [] });
  for (let c = 0; c < nChunks; c++) {
    const a = off + c * SEGMENT_SAMPLES;
    const chunk = new Float32Array(SEGMENT_SAMPLES);
    chunk.set(samples.subarray(a, a + SEGMENT_SAMPLES));
    const seek = a / SAMPLE_RATE;
    w.postMessage({ type: "chunk", part, samples: chunk, seek, next: seek + chunkSec }, [chunk.buffer]);
  }
  w.postMessage({ type: "finish", part });
  return result;
}
