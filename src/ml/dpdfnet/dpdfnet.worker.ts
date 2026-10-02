/// <reference lib="webworker" />
/** One DPDFNet engine per worker; processes one channel per request (channels run in parallel workers). */
import wasmBinaryUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { DereverbEngine } from "./dereverb";

declare const self: DedicatedWorkerGlobalScope;

let engine: Promise<DereverbEngine> | null = null;
const base = `${import.meta.env.BASE_URL}models/dpdfnet8_48khz_hr`;

self.onmessage = async (e: MessageEvent<{ job: number; channel: Float32Array }>) => {
  const { job, channel } = e.data;
  try {
    engine ??= DereverbEngine.load({
      modelUrl: new URL(`${base}.onnx`, self.location.origin).href,
      metadataUrl: new URL(`${base}.meta.json`, self.location.origin).href,
      wasmBinaryUrl: new URL(wasmBinaryUrl, self.location.href).href,
      numThreads: 1, // no cross-origin isolation → single-threaded WASM; channels run in parallel workers instead
      onModelProgress: (loaded, total) => self.postMessage({ type: "model", job, loaded, total }),
    });
    const eng = await engine;
    let last = 0;
    const res = await eng.processChannel(channel, {
      onProgress: ({ frame, totalFrames }) => {
        const now = performance.now();
        if (now - last > 150) {
          last = now;
          self.postMessage({ type: "progress", job, progress: frame / totalFrames });
        }
      },
    });
    const wet = res.wet.slice();
    self.postMessage({ type: "done", job, wet }, [wet.buffer]);
  } catch (err) {
    engine = null;
    self.postMessage({ type: "error", job, error: String((err as Error)?.message ?? err) });
  }
};
