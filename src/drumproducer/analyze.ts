/**
 * Rhythm analysis of mapped events: bars, straight vs triplet grid (per beat), swing, density,
 * step occupancy and phrase length. Short or incomplete material is reported as such instead
 * of guessed at.
 */
import type { Analysis, DEvent, GridChoice, GridDecision, Layer, Voice } from "./types";
import { VOICE_INFO } from "./types";

export const BEATS_PER_BAR = 4; // the DAW is 4/4-only (no meter in the project model)
export const STEPS = 16;
export const STEP = BEATS_PER_BAR / STEPS;

export const frac = (x: number) => x - Math.floor(x);
export const barOf = (beat: number) => Math.floor(beat / BEATS_PER_BAR + 1e-9);
export const inBar = (beat: number) => beat - barOf(beat) * BEATS_PER_BAR;
/** 16th step index (0..15) if the position is close to the straight grid, else −1. */
export function stepOf(beat: number, tol = 0.3): number {
  const x = inBar(beat) / STEP;
  const r = Math.round(x);
  return Math.abs(x - r) <= tol ? r % STEPS : -1;
}

/** Tolerance in beats for "this hit is on that grid line": ~18 ms, clamped. */
export const gridTol = (spb: number) => Math.min(0.05, Math.max(0.025, 0.018 / spb));

interface BeatVotes { s: number; t: number; w: number }

export function detectGrid(events: DEvent[], spb: number): Analysis["grid"] & { beats: Map<number, "s" | "t" | "w" | "m"> } {
  const tol = gridTol(spb);
  const votes = new Map<number, BeatVotes>();
  for (const e of events) {
    const pos = e.src?.start ?? e.start;
    const f = frac(pos);
    const d8 = Math.abs(f * 2 - Math.round(f * 2)) / 2;
    if (d8 < tol) continue; // on an 8th: both grids agree
    const dS = Math.abs(f * 4 - Math.round(f * 4)) / 4;
    const dT = Math.abs(f * 6 - Math.round(f * 6)) / 6;
    const b = Math.floor(pos + 1e-9);
    const v = votes.get(b) ?? { s: 0, t: 0, w: 0 };
    if (dS < tol && dS <= dT) v.s++;
    else if (dT < tol) {
      const k = Math.round(f * 6) % 6;
      // 1/6 and 2/3 only occur in real triplet figures; 1/3 and 5/6 are also where heavy swing lands.
      if (k === 1 || k === 4) v.t++;
      else v.w++;
    } else continue;
    votes.set(b, v);
  }
  const beats = new Map<number, "s" | "t" | "w" | "m">();
  let S = 0, Tt = 0, W = 0, M = 0, sv = 0, tv = 0, wv = 0;
  const tripletBeats: number[] = [];
  for (const [b, v] of votes) {
    sv += v.s; tv += v.t; wv += v.w;
    let c: "s" | "t" | "w" | "m";
    if (v.t > 0 && v.s === 0) c = "t";
    else if (v.t > 0) c = "m";
    else if (v.w > 0 && v.s === 0) c = "w";
    else if (v.w > 0) c = "m";
    else c = "s";
    beats.set(b, c);
    if (c === "t") { Tt++; tripletBeats.push(b); }
    else if (c === "s") S++;
    else if (c === "w") W++;
    else M++;
  }
  tripletBeats.sort((a, b) => a - b);
  let decision: GridDecision;
  let note: string;
  const total = S + Tt + W + M;
  if (!events.length) {
    decision = "none";
    note = "no events";
  } else if (total === 0) {
    decision = "straight";
    note = "every hit sits on an 8th — straight and triplet grids agree";
  } else if (Tt === 0 && W === 0 && M === 0) {
    decision = "straight";
    note = `${S} beats with 16th figures, no triplet evidence`;
  } else if (S === 0 && W === 0 && M === 0 && Tt >= 2) {
    decision = "triplet";
    note = `${Tt} beats with triplet figures, no straight 16ths`;
  } else if (Tt > 0 && W === 0 && M <= 1 && Tt <= 0.34 * (S + Tt) && S >= 2) {
    decision = "mixed";
    note = `straight groove with triplet figures in ${Tt} beat${Tt > 1 ? "s" : ""} (fills / rolls)`;
  } else if (W > 0 && Tt === 0 && S === 0 && M === 0) {
    decision = "ambiguous";
    note = "off-beats land on 1/3 positions only — reads as heavy swing or as triplets; choose";
  } else {
    decision = "ambiguous";
    note = `conflicting evidence: ${S} straight, ${Tt} triplet, ${W} swing-or-triplet, ${M} mixed beats; choose a grid`;
  }
  if (total > 0 && total < 3 && decision !== "straight") {
    decision = "ambiguous";
    note = `only ${total} beat${total > 1 ? "s" : ""} with off-8th hits — too little to decide`;
  }
  return { decision, straightVotes: sv, tripletVotes: tv, swingOrTripletVotes: wv, tripletBeats, note, beats };
}

/** Median 16th swing ratio (0.5 = straight, 0.667 = triplet shuffle), or null if unmeasurable. */
export function detectSwing(events: DEvent[]): number | null {
  const xs: number[] = [];
  for (const e of events) {
    const f = frac(e.src?.start ?? e.start);
    const q = (f % 0.5) / 0.5; // position inside the 8th pair
    if (q > 0.38 && q < 0.8) xs.push(q);
  }
  if (xs.length < 4) return null;
  xs.sort((a, b) => a - b);
  const m = xs[Math.floor(xs.length / 2)];
  return Math.abs(m - 0.5) < 0.02 ? 0.5 : Math.round(m * 1000) / 1000;
}

/** Grid step (beats) to quantize a position to, per the user's choice and the per-beat analysis. */
export function gridStepAt(beat: number, choice: GridChoice, decision: GridDecision, beats: Map<number, string>): number | null {
  const c = choice === "auto" ? decision : choice;
  if (c === "ambiguous") return null; // wait for the user
  if (c === "triplet") return 1 / 6;
  if (c === "mixed") return beats.get(Math.floor(beat + 1e-9)) === "t" ? 1 / 6 : 0.25;
  return 0.25;
}

export function analyze(events: DEvent[], lengthBeats: number, spb: number): Omit<Analysis, "mapping" | "mappingStatus"> {
  const bars = Math.max(1, Math.ceil(lengthBeats / BEATS_PER_BAR - 1e-9));
  const completeBars = Math.floor(lengthBeats / BEATS_PER_BAR + 1e-9);
  const partialBeats = Math.round((lengthBeats - completeBars * BEATS_PER_BAR) * 1000) / 1000;
  const g = detectGrid(events, spb);
  const { beats: _beats, ...grid } = g;
  void _beats;
  const density: Record<Exclude<Layer, "phrase">, number> = { foundation: 0, motion: 0, perc: 0 };
  for (const e of events) if (barOf(e.start) < completeBars) density[VOICE_INFO[e.voice].layer] += 1;
  for (const k of Object.keys(density) as (keyof typeof density)[]) density[k] = completeBars ? density[k] / completeBars : 0;
  const phraseBars = completeBars >= 16 ? 16 : completeBars >= 8 ? 8 : completeBars >= 4 ? 4 : 0;
  const warnings: string[] = [];
  if (!events.length) warnings.push("the region has no mapped drum events");
  if (completeBars < 2) warnings.push("shorter than 2 full bars: no cross-bar statistics, no phrase structure");
  else if (completeBars < 4) warnings.push("fewer than 4 bars: no phrase development (fills) inferred");
  if (partialBeats > 0) warnings.push(`last bar is incomplete (${partialBeats} beats): excluded from pattern statistics`);
  return {
    bars,
    completeBars,
    partialBeats,
    events: events.length,
    grid,
    swing: detectSwing(events),
    density,
    phraseBars,
    structure: completeBars >= 2,
    warnings,
  };
}

/** Per-voice hit frequency and mean velocity per straight 16th step over complete bars. */
export function occupancy(events: DEvent[], completeBars: number) {
  const occ = new Map<Voice, { freq: Float32Array; vel: Float32Array }>();
  if (!completeBars) return occ;
  const seen = new Map<Voice, Set<string>>();
  for (const e of events) {
    const b = barOf(e.start);
    if (b >= completeBars) continue;
    const s = stepOf(e.start, 0.25);
    if (s < 0) continue;
    let o = occ.get(e.voice);
    if (!o) occ.set(e.voice, (o = { freq: new Float32Array(STEPS), vel: new Float32Array(STEPS) }));
    const key = `${b}:${s}`;
    const sv = seen.get(e.voice) ?? seen.set(e.voice, new Set()).get(e.voice)!;
    if (sv.has(key)) continue;
    sv.add(key);
    o.freq[s] += 1;
    o.vel[s] += e.vel;
  }
  for (const o of occ.values())
    for (let s = 0; s < STEPS; s++) {
      if (o.freq[s]) o.vel[s] /= o.freq[s];
      o.freq[s] /= completeBars;
    }
  return occ;
}
