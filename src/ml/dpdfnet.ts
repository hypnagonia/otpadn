/**
 * Dereverb + denoise (one DPDFNet pass, removes noise and room together) on any AudioBuffer.
 * Runs at 48 kHz, one worker per channel in parallel; result is sample-aligned with the input.
 */
import { est, memory } from "../system/memory";

export const DPDFNET_SR = 48000;
export const DPDFNET_MB = 15;

const spawn = () => new Worker(new URL("./dpdfnet/dpdfnet.worker.ts", import.meta.url), { type: "module" });

async function resample(buf: AudioBuffer, sr: number): Promise<AudioBuffer> {
  if (buf.sampleRate === sr) return buf;
  const ctx = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * sr), sr);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export interface CleanProgress {
  phase: "model" | "process";
  progress: number;
  detail?: string;
}

/** `mix` 0..1: 1 = fully processed, lower blends the original back in (aligned, no combing). */
export async function dereverbDenoise(buf: AudioBuffer, mix: number, onProgress: (p: CleanProgress) => void): Promise<AudioBuffer> {
  const ch = buf.numberOfChannels;
  // Input at 48 kHz + per-channel copies sent to workers + results + output buffer, plus ~60 MB per engine.
  const pcm = est.pcm(buf.duration, DPDFNET_SR, ch);
  await memory.ensure(pcm * 4 + ch * 60 * 1024 * 1024, "dereverb + denoise");
  memory.track("dpdfnet:run", pcm * 4, "transient", "dereverb + denoise in progress");
  const workers = Array.from({ length: ch }, spawn);
  try {
    const src = await resample(buf, DPDFNET_SR);
    const progress = new Array(ch).fill(0);
    const wets = await Promise.all(
      workers.map(
        (w, c) =>
          new Promise<Float32Array>((resolve, reject) => {
            w.onmessage = (e) => {
              const m = e.data;
              if (m.type === "model") onProgress({ phase: "model", progress: m.total ? m.loaded / m.total : 0, detail: `${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB` });
              else if (m.type === "progress") {
                progress[c] = m.progress;
                onProgress({ phase: "process", progress: progress.reduce((a, b) => a + b, 0) / ch });
              } else if (m.type === "done") resolve(m.wet);
              else if (m.type === "error") reject(new Error(m.error));
            };
            w.onerror = (e) => reject(new Error(e.message || "dereverb worker crashed"));
            const channel = src.getChannelData(c).slice();
            w.postMessage({ job: 1, channel }, [channel.buffer]);
          }),
      ),
    );
    const out = new AudioBuffer({ numberOfChannels: ch, length: src.length, sampleRate: DPDFNET_SR });
    for (let c = 0; c < ch; c++) {
      const dry = src.getChannelData(c), wet = wets[c], dst = out.getChannelData(c);
      const m = Math.max(0, Math.min(1, mix));
      for (let i = 0; i < dst.length; i++) dst[i] = wet[i] * m + dry[i] * (1 - m);
    }
    return out;
  } finally {
    workers.forEach((w) => w.terminate());
    memory.untrack("dpdfnet:run");
  }
}
