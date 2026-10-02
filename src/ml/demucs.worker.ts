/// <reference lib="webworker" />
/**
 * AI stem separation: Meta HTDemucs v4, 6-stem variant (drums, bass, other, vocals, guitar, piano),
 * ONNX export run with onnxruntime-web — WebGPU first, WASM fallback. Mirrors the reference
 * infer.py: 7.8 s segments at 44.1 kHz, 25% overlap, linear cross-fade overlap-add.
 */
import type * as OrtNS from "onnxruntime-web";
// WASM binaries served from our own origin by Vite (hashed, version-locked to the npm package).
// The JSEP build is only valid with the WebGPU EP: used CPU-only it calls uninitialised WebGPU hooks
// and the session never resolves. CPU inference therefore uses the plain WASM build.
// onnxruntime-web ≥ 1.2x: the WebGPU EP runs on the asyncify build (JSEP is legacy). Handing it the
// JSEP wasm crashed every WebGPU session ("reading 'Xe'") → silent fallback to the slow CPU path.
import gpuWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import plainWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { patchDoublesToFloat } from "./onnxPatch";

declare const self: DedicatedWorkerGlobalScope;

export const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals", "guitar", "piano"] as const;
export const DEMUCS_SR = 44100;
const N = Math.floor(7.8 * DEMUCS_SR); // 343,980 samples per segment
const OVERLAP = Math.floor(N / 4);
const STRIDE = N - OVERLAP;
const MODEL_CACHE = "stemdaw-models";
const PATCH_VERSION = "f32-v1"; // bump when the in-browser model patch changes

let ort: typeof OrtNS;
async function loadOrt(ep: "webgpu" | "wasm") {
  if (ort) return ort;
  ort = ep === "webgpu" ? ((await import("onnxruntime-web/webgpu")) as unknown as typeof OrtNS) : ((await import("onnxruntime-web/wasm")) as unknown as typeof OrtNS);
  ort.env.wasm.wasmPaths = { wasm: new URL(ep === "webgpu" ? gpuWasmUrl : plainWasmUrl, self.location.href).href };
  // No COOP/COEP headers → no SharedArrayBuffer; WASM runs single-threaded per worker.
  ort.env.wasm.numThreads = 1;
  return ort;
}

let session: Promise<{ s: OrtNS.InferenceSession; backend: string }> | null = null;

/**
 * Download once, patch float64 → float32 once (browser runtime lacks double kernels), and keep the
 * patched model in the Cache API so later sessions skip both steps.
 */
async function fetchModel(url: string, jobId: number): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  // Query string, not #fragment: the Cache API ignores fragments, which would collide with the raw URL.
  const patchedKey = `${url}?otpadn=${PATCH_VERSION}`;
  const ready = await cache.match(patchedKey);
  if (ready) return ready.arrayBuffer();
  const raw = await fetchRaw(url, jobId, cache);
  self.postMessage({ type: "status", jobId, status: "preparing model for the browser (one time)…" });
  const { bytes, patched } = patchDoublesToFloat(new Uint8Array(raw));
  self.postMessage({ type: "status", jobId, status: `model prepared (${patched} tensors converted)` });
  try {
    await cache.put(patchedKey, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    // Storage full: still usable this session, just downloaded again next time.
    self.postMessage({ type: "status", jobId, status: "browser storage full — model not cached" });
  }
  await cache.delete(url).catch(() => false); // the unpatched copy is no longer needed
  return bytes.buffer as ArrayBuffer;
}

async function fetchRaw(url: string, jobId: number, cache: Cache): Promise<ArrayBuffer> {
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 3 && !res?.ok; attempt++) {
    res = await fetch(url).catch(() => null);
    if (!res?.ok && attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  if (!res?.ok || !res.body) throw new Error(`model download failed${res ? `: HTTP ${res.status}` : " (network)"}`);
  const total = Number(res.headers.get("content-length")) || 136_428_532;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    self.postMessage({ type: "download", jobId, progress: got / total, mb: got / 1e6, totalMb: total / 1e6 });
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return buf.buffer;
}

async function getSession(url: string, jobId: number, ep: "webgpu" | "wasm") {
  session ??= (async () => {
    await loadOrt(ep);
    const bytes = await fetchModel(url, jobId);
    self.postMessage({ type: "status", jobId, status: `initialising model (${ep})…` });
    const tries: string[] = ep === "webgpu" && "gpu" in navigator ? ["webgpu"] : ["wasm"];
    let lastErr: unknown;
    for (const ep of tries) {
      try {
        // Optimisation must stay off: ORT-web's fusions blow this graph up (std::bad_alloc on WASM,
        // stalled WebGPU session creation). Unoptimised it runs fine.
        const s = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "disabled" });
        return { s, backend: ep };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  })();
  try {
    return await session;
  } catch (e) {
    session = null; // allow retry
    throw e;
  }
}

export interface DemucsRequest {
  type: "separate";
  jobId: number;
  modelUrl: string;
  left: Float32Array; // 44.1 kHz
  right: Float32Array;
  ep: "webgpu" | "wasm";
  /** Process only chunks [c0, c1) — lets several WASM workers share one song. */
  c0: number;
  c1: number;
}

// Anything uncaught (e.g. inside the WASM runtime) must fail the job, never leave it hanging.
let currentJob = 0;
const fail = (msg: string) => self.postMessage({ type: "error", jobId: currentJob, error: msg });
self.addEventListener("error", (e) => fail(e.message || "worker error"));
self.addEventListener("unhandledrejection", (e) => fail(String((e.reason as Error)?.message ?? e.reason)));

self.onmessage = async (e: MessageEvent<DemucsRequest | { type: "prepare"; jobId: number; modelUrl: string }>) => {
  currentJob = e.data.jobId;
  if (e.data.type === "prepare") {
    // Download + patch + cache only, so parallel workers don't each fetch 136 MB.
    try {
      await fetchModel(e.data.modelUrl, e.data.jobId);
      self.postMessage({ type: "prepared", jobId: e.data.jobId });
    } catch (err) {
      fail(String((err as Error)?.message ?? err));
    }
    return;
  }
  const { jobId, modelUrl, left, right, ep } = e.data;
  try {
    const { s, backend } = await getSession(modelUrl, jobId, ep);
    self.postMessage({ type: "backend", jobId, backend });
    const total = left.length;
    const nChunks = Math.max(1, Math.ceil(total / STRIDE));
    const c0 = Math.max(0, e.data.c0 ?? 0), c1 = Math.min(nChunks, e.data.c1 ?? nChunks);
    // This worker's output covers samples [base, base + span).
    const base = c0 * STRIDE;
    const span = Math.min(total, (c1 - 1) * STRIDE + N) - base;
    const win = new Float32Array(N).fill(1);
    for (let i = 0; i < OVERLAP; i++) {
      const v = i / (OVERLAP - 1);
      win[i] = v;
      win[N - 1 - i] = v;
    }
    const out = DEMUCS_SOURCES.map(() => [new Float32Array(span), new Float32Array(span)]);
    const weight = new Float32Array(span);
    const input = new Float32Array(2 * N);
    const t0 = performance.now();
    for (let c = c0; c < c1; c++) {
      const start = c * STRIDE;
      const end = Math.min(start + N, total);
      const len = end - start;
      input.fill(0);
      input.set(left.subarray(start, end), 0);
      input.set(right.subarray(start, end), N);
      const feeds = { mix: new ort.Tensor("float32", input, [1, 2, N]) };
      const res = await s.run(feeds);
      const stems = res.stems.data as Float32Array; // [1, 6, 2, N]
      for (let k = 0; k < DEMUCS_SOURCES.length; k++)
        for (let ch = 0; ch < 2; ch++) {
          const off = (k * 2 + ch) * N;
          const dst = out[k][ch];
          for (let i = 0; i < len; i++) dst[start - base + i] += stems[off + i] * win[i];
        }
      for (let i = 0; i < len; i++) weight[start - base + i] += win[i];
      res.stems.dispose?.();
      const elapsed = (performance.now() - t0) / 1000;
      const doneN = c - c0 + 1;
      self.postMessage({ type: "progress", jobId, done: doneN, total: c1 - c0, eta: (elapsed / doneN) * (c1 - c - 1) });
    }
    // Partial sums + weights: the client adds all workers' ranges, then normalises once.
    const transfer = [...out.flatMap((st) => st.map((ch) => ch.buffer)), weight.buffer];
    self.postMessage({ type: "done", jobId, stems: out, weight, base, backend }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", jobId, error: String((err as Error)?.message ?? err) });
  }
};
