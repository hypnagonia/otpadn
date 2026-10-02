/**
 * MIDI → fretboard positions for tablature. Chords are spread over distinct strings; between
 * events a dynamic program minimises hand travel, preferring lower positions.
 */
import type { Note } from "../model/types";

export interface Tuning {
  id: string;
  label: string;
  strings: number[]; // MIDI pitch of open strings, highest string first (tab order)
}

export const TUNINGS: Tuning[] = [
  { id: "gtr-std", label: "guitar · standard", strings: [64, 59, 55, 50, 45, 40] },
  { id: "gtr-dropd", label: "guitar · drop d", strings: [64, 59, 55, 50, 45, 38] },
  { id: "gtr-dstd", label: "guitar · d standard", strings: [62, 57, 53, 48, 43, 38] },
  { id: "bass-4", label: "bass · 4-string", strings: [43, 38, 33, 28] },
  { id: "bass-5", label: "bass · 5-string", strings: [43, 38, 33, 28, 23] },
];

export const MAX_FRET = 22;

export interface TabNote {
  note: Note;
  string: number; // index into tuning.strings
  fret: number;
}

type Pos = { string: number; fret: number }[];

/** All ways to place a chord (array of pitches) on distinct strings. Capped for speed. */
function chordOptions(pitches: number[], strings: number[]): Pos[] {
  const out: Pos[] = [];
  const used = new Array(strings.length).fill(false);
  const cur: Pos = [];
  const rec = (i: number) => {
    if (out.length > 200) return;
    if (i === pitches.length) {
      out.push(cur.slice());
      return;
    }
    for (let s = 0; s < strings.length; s++) {
      const f = pitches[i] - strings[s];
      if (used[s] || f < 0 || f > MAX_FRET) continue;
      used[s] = true;
      cur.push({ string: s, fret: f });
      rec(i + 1);
      cur.pop();
      used[s] = false;
    }
  };
  rec(0);
  return out;
}

const span = (p: Pos) => {
  const fr = p.filter((x) => x.fret > 0).map((x) => x.fret);
  return fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
};
const center = (p: Pos) => {
  const fr = p.filter((x) => x.fret > 0).map((x) => x.fret);
  return fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : 0;
};

export function layoutTab(notes: Note[], tuning: Tuning): TabNote[] {
  const strings = tuning.strings;
  const lo = strings[strings.length - 1] ?? 0, hi = (strings[0] ?? 0) + MAX_FRET;
  // Group simultaneous onsets into events; keep only playable pitches (max one per string).
  const sorted = notes.filter((n) => n.pitch >= lo && n.pitch <= hi).sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const events: Note[][] = [];
  for (const n of sorted) {
    const last = events[events.length - 1];
    if (last && Math.abs(last[0].start - n.start) < 0.06 && last.length < strings.length && !last.some((m) => m.pitch === n.pitch)) last.push(n);
    else events.push([n]);
  }
  // Viterbi over events.
  const opts = events.map((ev) => {
    const o = chordOptions(ev.map((n) => n.pitch), strings).filter((p) => span(p) <= 4);
    return o.length ? o : chordOptions(ev.map((n) => n.pitch), strings).slice(0, 1);
  });
  const cost: number[][] = [];
  const back: number[][] = [];
  opts.forEach((o, i) => {
    cost[i] = [];
    back[i] = [];
    o.forEach((p, j) => {
      const local = center(p) * 0.15 + span(p) * 0.5;
      if (i === 0) {
        cost[i][j] = local;
        back[i][j] = -1;
        return;
      }
      let best = Infinity, arg = 0;
      const prev = opts[i - 1];
      for (let k = 0; k < prev.length; k++) {
        const c = cost[i - 1][k] + Math.abs(center(prev[k]) - center(p)) * (center(p) && center(prev[k]) ? 1 : 0.3);
        if (c < best) { best = c; arg = k; }
      }
      cost[i][j] = best + local;
      back[i][j] = arg;
    });
  });
  const out: TabNote[] = [];
  let j = cost.length ? cost[cost.length - 1].indexOf(Math.min(...cost[cost.length - 1])) : -1;
  for (let i = events.length - 1; i >= 0 && j >= 0; i--) {
    const p = opts[i][j];
    if (p) events[i].forEach((n, k) => p[k] && out.push({ note: n, string: p[k].string, fret: p[k].fret }));
    j = back[i][j];
  }
  return out.reverse();
}

export const defaultTuningFor = (role: string, notes: Note[]) =>
  role === "bass" || (notes.length && Math.max(...notes.map((n) => n.pitch)) < 60 && role !== "guitar") ? TUNINGS[3] : TUNINGS[0];
