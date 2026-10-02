/**
 * Harmony context for a part: key (user / project / notes) and a chord timeline. Chords come from
 * the project's audio-derived chord track when it covers the region (qualities refined from the
 * notes), otherwise from the notes themselves: duration×velocity pitch-class weights, bass cue,
 * 8 chord qualities, diatonic and continuity priors, ranked alternatives for the user to pick.
 */
import { QUALITY_IV, type Chord, type PEvent, type Quality } from "./types";

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const QUALITIES = Object.keys(QUALITY_IV) as Quality[];

export const scalePcs = (k: { tonic: number; minor: boolean }) => {
  const steps = k.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]; // minor also allows the leading tone
  return new Set(steps.map((s) => (s + k.tonic) % 12));
};
export const chordPcs = (c: { root: number; q: Quality }) => QUALITY_IV[c.q].map((i) => (i + c.root) % 12);

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db + 1e-12);
}

export function keyFromNotes(events: PEvent[]): { tonic: number; minor: boolean; r: number } {
  const h = new Array(12).fill(0);
  for (const e of events) h[e.pitch % 12] += e.dur * (0.5 + e.vel / 254);
  let best = { tonic: 0, minor: false, r: -2 };
  if (!events.length) return best;
  for (let t = 0; t < 12; t++) {
    const rot = h.map((_, i) => h[(i + t) % 12]);
    const a = corr(rot, MAJOR), b = corr(rot, MINOR);
    if (a > best.r) best = { tonic: t, minor: false, r: a };
    if (b > best.r) best = { tonic: t, minor: true, r: b };
  }
  return best;
}

interface Win { w: number[]; bass: number[]; total: number }

function windowWeights(events: PEvent[], a: number, b: number, melodic: boolean): Win {
  const w = new Array(12).fill(0), bass = new Array(12).fill(0);
  let total = 0;
  // Lowest sounding note per 1/4 beat slice = bass cue.
  for (let t = a; t < b - 1e-9; t += 0.25) {
    let lo: PEvent | null = null;
    for (const e of events) if (e.start <= t + 1e-9 && e.start + e.dur > t + 1e-9 && (!lo || e.pitch < lo.pitch)) lo = e;
    if (lo) bass[lo.pitch % 12] += 1;
  }
  for (const e of events) {
    const ov = Math.min(b, e.start + e.dur) - Math.max(a, e.start);
    if (ov <= 0) continue;
    const strong = melodic && Math.abs(e.start - Math.round(e.start)) < 0.05 ? 1.5 : 1;
    const x = ov * (0.5 + e.vel / 254) * strong;
    w[e.pitch % 12] += x;
    total += x;
  }
  return { w, bass, total };
}

function scoreAll(win: Win, key: { tonic: number; minor: boolean }, prev: { root: number; q: Quality } | null, melodic: boolean) {
  const sum = win.w.reduce((s, v) => s + v, 0) || 1;
  const w = win.w.map((v) => v / sum);
  const bsum = win.bass.reduce((s, v) => s + v, 0);
  const bn = bsum ? win.bass.map((v) => v / bsum) : null;
  const scale = scalePcs(key);
  const out: { root: number; q: Quality; s: number }[] = [];
  for (let r = 0; r < 12; r++)
    for (const q of QUALITIES) {
      if (melodic && !["maj", "min", "7", "m7"].includes(q)) continue;
      const pcs = new Set(chordPcs({ root: r, q }));
      let s = 0;
      for (let pc = 0; pc < 12; pc++) s += pcs.has(pc) ? w[pc] * (pc === r ? 1.15 : 1) : -0.7 * w[pc];
      const iv = QUALITY_IV[q];
      if (iv.length === 4) {
        const seventh = (r + iv[3]) % 12;
        s -= w[seventh] < 0.08 ? 0.2 : 0.03; // only call a 7th chord when the 7th is really there
      }
      if (q === "sus2" || q === "sus4" || q === "dim") s -= 0.06;
      if (bn && !melodic) s += 0.3 * bn[r];
      if ([...pcs].every((pc) => scale.has(pc))) s += 0.05;
      if (prev && prev.root === r && prev.q === q) s += 0.06;
      out.push({ root: r, q, s });
    }
  return out.sort((a, b) => b.s - a.s);
}

/** Chords from the part's own notes. Line mode uses bar windows and triads/7ths only. */
export function chordsFromNotes(events: PEvent[], length: number, key: { tonic: number; minor: boolean }, melodic: boolean): Chord[] {
  const step = melodic ? 4 : 2;
  const raw: Chord[] = [];
  let prev: { root: number; q: Quality } | null = null;
  for (let a = 0; a < length - 1e-9; a += step) {
    const b = Math.min(length, a + step);
    const win = windowWeights(events, a, b, melodic);
    if (win.total < 0.05) {
      if (prev) raw.push({ start: a, length: b - a, root: prev.root, q: prev.q, fit: 0, alts: [], from: "notes" });
      continue;
    }
    const ranked = scoreAll(win, key, prev, melodic);
    const best = ranked[0];
    const margin = best.s - ranked[1].s;
    const alts: Chord["alts"] = [];
    for (const r of ranked) {
      if (alts.length >= 4) break;
      if (!alts.some((x) => x.root === r.root && x.q === r.q)) alts.push({ root: r.root, q: r.q });
    }
    raw.push({ start: a, length: b - a, root: best.root, q: best.q, fit: Math.max(0, Math.min(1, 0.5 + best.s * 0.5 + margin)), alts, from: "notes" });
    prev = best;
  }
  return mergeChords(raw);
}

function mergeChords(cs: Chord[]): Chord[] {
  const out: Chord[] = [];
  for (const c of cs) {
    const last = out[out.length - 1];
    if (last && last.root === c.root && last.q === c.q && Math.abs(last.start + last.length - c.start) < 1e-6) {
      last.length += c.length;
      last.fit = Math.max(last.fit, c.fit);
    } else out.push({ ...c, alts: [...c.alts] });
  }
  return out;
}

/** Project chord track (triads from audio) clipped to the region, with 7th qualities refined from the notes. */
export function chordsFromProject(spans: { start: number; length: number; root: number; minor: boolean }[], regionStart: number, length: number, events: PEvent[]): Chord[] {
  const out: Chord[] = [];
  for (const s of spans) {
    const a = Math.max(0, s.start - regionStart), b = Math.min(length, s.start + s.length - regionStart);
    if (b <= a + 1e-6) continue;
    const win = windowWeights(events, a, b, false);
    const sum = win.w.reduce((x, y) => x + y, 0) || 1;
    let q: Quality = s.minor ? "min" : "maj";
    if (win.total > 0.05) {
      const m7 = win.w[(s.root + 10) % 12] / sum, M7 = win.w[(s.root + 11) % 12] / sum;
      if (s.minor && m7 > 0.1) q = "m7";
      else if (!s.minor && m7 > 0.1 && m7 > M7) q = "7";
      else if (!s.minor && M7 > 0.1) q = "maj7";
    }
    const triad: Quality = s.minor ? "min" : "maj";
    out.push({ start: a, length: b - a, root: s.root, q, fit: 0.8, alts: [{ root: s.root, q }, { root: s.root, q: q === triad ? (s.minor ? "m7" : "7") : triad }], from: "project" });
  }
  return mergeChords(out);
}

export function applyOverrides(chords: Chord[], ov: Record<string, { root: number; q: Quality }>): Chord[] {
  return chords.map((c) => {
    const o = ov[String(Math.round(c.start * 1000) / 1000)];
    return o ? { ...c, root: o.root, q: o.q, from: "user" as const } : c;
  });
}

export const chordAt = (chords: Chord[], beat: number) => chords.find((c) => beat >= c.start - 1e-9 && beat < c.start + c.length - 1e-9) ?? (chords.length ? chords[chords.length - 1] : null);
