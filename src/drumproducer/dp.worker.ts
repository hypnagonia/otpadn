/** Drum Producer worker: analysis + generation off the main thread (never on the audio thread). */
import { runPipeline, type PipelineInput } from "./pipeline";

self.onmessage = (e: MessageEvent<{ id: number; input: PipelineInput }>) => {
  const { id, input } = e.data;
  try {
    const t0 = performance.now();
    const result = runPipeline(input);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.stack ?? String(err) });
  }
};
