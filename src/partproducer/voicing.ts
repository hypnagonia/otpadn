/**
 * Voicings. Keys: enumerate every placement of the chord tones inside a register, reject muddy
 * low clusters, pick the one with the least voice movement from the previous chord (plus register
 * and top-note continuity). Guitar: a six-string fretboard model (standard tuning) that only
 * produces playable shapes — ≤ 4-fret stretch, ≤ 4 fingers (barre counts as one), contiguous
 * strings, root and third present — chosen to stay close on the neck.
 */
import { rand } from "../drumproducer/rng";
import { QUALITY_IV, type Quality } from "./types";

export interface KeyOpts {
  lo: number;
  hi: number;
  /** Tone colour: plain chord tones, add the 9th, or rootless 9th voicings (house stabs). */
  color: "plain" | "add9" | "rootless9";
  maxSpan: number;
  /** Extra note: double the top or root (pads). */
  double?: boolean;
  /** Key scale (pitch classes): added 7ths/9ths must be diatonic. */
  scale?: Set<number>;
}

/**
 * Intervals for a chord at a given colour. Added colour tones follow the key: a major triad
 * takes maj7 only if it's diatonic (I, IV) and the b7 otherwise (V → V9); a 9th is added only
 * when it's in the key (no F# over Em in C major), else the root stays.
 */
function tones(root: number, q: Quality, color: KeyOpts["color"], scale?: Set<number>): number[] {
  const iv = QUALITY_IV[q];
  if (color === "plain") return iv;
  const inKey = (i: number) => !scale || scale.has((root + i) % 12);
  const third = iv[1], fifth = iv[2];
  const seventh = iv[3] ?? (q === "min" ? (inKey(10) ? 10 : undefined) : q === "maj" ? (inKey(11) ? 11 : inKey(10) ? 10 : undefined) : undefined);
  const nine = inKey(2);
  if (color === "add9") return q === "dim" || q === "sus2" || !nine ? iv : [...iv, 14];
  // rootless: 3rd, 5th, 7th, 9th (classic house minor 9 / major 9 stab)
  if (q === "dim" || q === "sus2" || q === "sus4") return iv;
  const out = [third, fifth];
  if (seventh !== undefined) out.push(seventh);
  out.push(nine ? 14 : 12); // no diatonic 9th → keep the root on top instead
  return out.filter((x, i, a) => a.indexOf(x) === i);
}

export function keyVoicings(root: number, q: Quality, o: KeyOpts): number[][] {
  const pcs = tones(root, q, o.color, o.scale).map((i) => (root + i) % 12);
  const options = pcs.map((pc) => {
    const xs: number[] = [];
    for (let p = o.lo; p <= o.hi; p++) if (p % 12 === pc) xs.push(p);
    return xs;
  });
  const out: number[][] = [];
  const valid = (v: number[]) => {
    if (new Set(v).size !== v.length || v[v.length - 1] - v[0] > o.maxSpan) return false;
    for (let k = 1; k < v.length; k++) {
      const gap = v[k] - v[k - 1];
      if (v[k - 1] < 52 && gap < 3) return false; // low clusters are mud
      if (v[k - 1] < 60 && gap < 2) return false; // no semitone rub below middle C
      if (v[k - 1] < 45 && gap < 7) return false;
    }
    return true;
  };
  const rec = (i: number, acc: number[]) => {
    if (i === options.length) {
      const v = [...acc].sort((a, b) => a - b);
      if (!valid(v)) return;
      out.push(v);
      if (o.double) {
        const top = v[v.length - 1];
        const r = v.find((p) => p % 12 === root);
        for (const extra of [top - 12, r !== undefined ? r + 12 : -1]) {
          if (extra < o.lo || extra > o.hi || v.includes(extra)) continue;
          const d = [...v, extra].sort((a, b) => a - b);
          if (valid(d)) out.push(d);
        }
      }
      return;
    }
    for (const p of options[i]) rec(i + 1, [...acc, p]);
  };
  rec(0, []);
  return out;
}

/** Voice-movement cost between two sorted voicings (nearest-neighbour matching both ways). */
export function moveCost(a: number[], b: number[]): number {
  const near = (x: number, ys: number[]) => Math.min(...ys.map((y) => Math.abs(x - y)));
  return (a.reduce((s, x) => s + near(x, b), 0) + b.reduce((s, y) => s + near(y, a), 0)) / 2;
}

export function pickVoicing(cands: number[][], prev: number[] | null, target: { center: number; top?: number }, seed: number, key: string, jitter = 0): number[] | null {
  let best: number[] | null = null, bs = Infinity;
  for (const v of cands) {
    const center = v.reduce((s, x) => s + x, 0) / v.length;
    let s = 0.35 * Math.abs(center - target.center) + 0.04 * (v[v.length - 1] - v[0]);
    if (prev) s += moveCost(prev, v);
    if (target.top !== undefined) s += 0.6 * Math.abs(v[v.length - 1] - target.top);
    if (jitter) s += jitter * rand(seed, key, v.join(","));
    if (s < bs - 1e-9) { bs = s; best = v; }
  }
  return best;
}

/* ───────────── guitar ───────────── */

export const TUNING = [40, 45, 50, 55, 59, 64];

export interface Shape {
  frets: (number | null)[]; // per string, null = muted
  pitches: (number | null)[];
  pos: number; // mean fretted position
  score: number;
}

const shapeCache = new Map<string, Shape[]>();

export function guitarShapes(root: number, q: Quality): Shape[] {
  const key = `${root}:${q}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const iv = QUALITY_IV[q];
  const pcs = new Set(iv.map((i) => (root + i) % 12));
  const third = (root + iv[1]) % 12;
  const seventh = iv.length === 4 ? (root + iv[3]) % 12 : null;
  const seen = new Set<string>();
  const out: Shape[] = [];
  for (let w = 0; w <= 9; w++) {
    const opts: (number | null)[][] = TUNING.map((open) => {
      const o: (number | null)[] = [null];
      if (pcs.has(open % 12)) o.push(0);
      for (let f = Math.max(1, w); f <= w + 3; f++) if (pcs.has((open + f) % 12)) o.push(f);
      return o;
    });
    const rec = (s: number, acc: (number | null)[]) => {
      if (s === 6) {
        const sounding = acc.map((f, i) => (f === null ? -1 : i)).filter((i) => i >= 0);
        if (sounding.length < 3) return;
        const lo = sounding[0], hi = sounding[sounding.length - 1];
        if (hi - lo + 1 !== sounding.length) return; // no muted string inside the shape
        const fretted = acc.filter((f): f is number => f !== null && f > 0);
        if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > 3) return;
        const minF = fretted.length ? Math.min(...fretted) : 0;
        const atMin = fretted.filter((f) => f === minF).length;
        const fingers = fretted.length - (atMin > 1 ? atMin - 1 : 0);
        if (fingers > 4) return;
        const pitches = acc.map((f, i) => (f === null ? null : TUNING[i] + f));
        const pcsIn = new Set(pitches.filter((p): p is number => p !== null).map((p) => p % 12));
        if (!pcsIn.has(root) || !pcsIn.has(third)) return;
        if (seventh !== null && !pcsIn.has(seventh)) return;
        const k = acc.join(",");
        if (seen.has(k)) return;
        seen.add(k);
        const bass = pitches[lo]! % 12;
        let score = sounding.length * 1.2 + (bass === root ? 3 : bass === (root + iv[2]) % 12 ? 0.5 : -1);
        score += acc.filter((f) => f === 0).length * 0.4; // ringing open strings
        score -= fingers > 3 ? 0.5 : 0;
        const pos = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : 0;
        out.push({ frets: [...acc], pitches, pos, score });
        return;
      }
      for (const f of opts[s]) rec(s + 1, [...acc, f]);
    };
    rec(0, []);
  }
  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, 24);
  shapeCache.set(key, top);
  return top;
}

export function pickShape(shapes: Shape[], prev: Shape | null, preferOpen: boolean, seed: number, key: string, jitter = 0): Shape | null {
  let best: Shape | null = null, bs = -Infinity;
  for (const s of shapes) {
    let v = s.score - (preferOpen ? 0.25 * s.pos : 0.05 * s.pos);
    if (prev) v -= 0.6 * Math.abs(s.pos - prev.pos);
    if (jitter) v += jitter * rand(seed, key, s.frets.join(","));
    if (v > bs) { bs = v; best = s; }
  }
  return best;
}

/** Power chord (root, fifth, octave) on the low E or A string, near the previous position. */
export function powerShape(root: number, prevPos: number | null): Shape {
  let best: Shape | null = null, bs = Infinity;
  for (const s of [0, 1]) {
    for (let f = 0; f <= 12; f++) {
      if ((TUNING[s] + f) % 12 !== root) continue;
      const frets: (number | null)[] = [null, null, null, null, null, null];
      frets[s] = f;
      frets[s + 1] = f + 2;
      frets[s + 2] = f + 2;
      const cost = Math.abs(f - (prevPos ?? 3)) + (f > 9 ? 2 : 0);
      if (cost < bs) {
        bs = cost;
        best = { frets, pitches: frets.map((x, i) => (x === null ? null : TUNING[i] + x)), pos: f + 1, score: 0 };
      }
    }
  }
  return best!;
}
