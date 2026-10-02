/** Part Producer worker: harmony analysis + generation off the main thread. */
import { runPart, type PartInput } from "./pipeline";

self.onmessage = (e: MessageEvent<{ id: number; input: PartInput }>) => {
  const { id, input } = e.data;
  try {
    const t0 = performance.now();
    const result = runPart(input);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.stack ?? String(err) });
  }
};
