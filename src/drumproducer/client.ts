/** Main-thread side of the worker: request/response by id, result cache by input, cancel = terminate. */
import type { PipelineInput } from "./pipeline";
import type { PipelineResult } from "./types";

type Pending = { resolve: (r: PipelineResult) => void; reject: (e: Error) => void };

class DpClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private next = 1;
  private cache = new Map<string, PipelineResult>();
  lastMs = 0;

  private ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./dp.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else {
        this.lastMs = e.data.ms;
        p.resolve(e.data.result);
      }
    };
    w.onerror = (e) => {
      e.preventDefault();
      this.fail(new Error(`drum producer worker crashed: ${e.message}`));
    };
    return (this.worker = w);
  }

  private fail(err: Error) {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  get busy() {
    return this.pending.size > 0;
  }

  cached(input: PipelineInput) {
    return this.cache.get(JSON.stringify(input));
  }

  run(input: PipelineInput): Promise<PipelineResult> {
    const key = JSON.stringify(input);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const id = this.next++;
    const w = this.ensure();
    return new Promise<PipelineResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => {
          this.cache.set(key, r);
          if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
          resolve(r);
        },
        reject,
      });
      w.postMessage({ id, input });
    });
  }

  /** Abort whatever is running (the worker is restarted on the next request). */
  cancel() {
    this.fail(new Error("cancelled"));
  }
}

export const dpClient = new DpClient();
