/**
 * Shared meter plumbing: one requestAnimationFrame loop for every meter on screen, and one
 * analyser read per source per frame (the mixer, inspector and track-header meters of a track
 * reuse the same reading).
 */
const subs = new Set<() => void>();
let raf = 0;
let frame = 0;
const tick = () => {
  frame++;
  subs.forEach((f) => f());
  raf = subs.size ? requestAnimationFrame(tick) : 0;
};

/** Run `fn` once per animation frame until the returned function is called. */
export function onFrame(fn: () => void): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    subs.delete(fn);
  };
}

const buf = new Float32Array(4096);
const cache = new WeakMap<AnalyserNode, { f: number; rmsDb: number; peakDb: number }>();

/** RMS and peak (dBFS) of the analyser's current window — computed at most once per frame. */
export function readLevel(an: AnalyserNode): { rmsDb: number; peakDb: number } {
  const c = cache.get(an);
  if (c && c.f === frame) return c;
  const b = buf.subarray(0, Math.min(an.fftSize, buf.length));
  an.getFloatTimeDomainData(b);
  let sum = 0, pk = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    sum += x * x;
    const a = x < 0 ? -x : x;
    if (a > pk) pk = a;
  }
  const r = { f: frame, rmsDb: 20 * Math.log10(Math.sqrt(sum / b.length) + 1e-9), peakDb: 20 * Math.log10(pk + 1e-9) };
  cache.set(an, r);
  return r;
}
