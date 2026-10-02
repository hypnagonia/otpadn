/**
 * Keyed deterministic randomness. Every random decision is `rand(seed, ...keys)`, a pure hash, so
 * changing one parameter (or regenerating one layer) never shifts the random stream of another,
 * and the same inputs always give the same part. No Math.random anywhere in the pipeline.
 */

function mix(h: number, x: number) {
  h ^= x;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function keyHash(k: string | number): number {
  if (typeof k === "number") return Number.isInteger(k) ? k | 0 : Math.round(k * 1e6) | 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Uniform [0, 1) from a seed and any number of keys. */
export function rand(seed: number, ...keys: (string | number)[]): number {
  let h = mix(0x9e3779b9, seed | 0);
  for (const k of keys) h = mix(h, keyHash(k));
  return h / 4294967296;
}

/** Uniform [-1, 1). */
export const rand2 = (seed: number, ...keys: (string | number)[]) => rand(seed, ...keys) * 2 - 1;

/** Pick from a weighted list. */
export function pick<T>(items: T[], weights: number[], r: number): T {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return items[0];
  let x = r * total;
  for (let i = 0; i < items.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

/** Seeded PRNG stream (mulberry32) for bulk data like noise buffers. */
export function stream(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
