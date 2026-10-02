/** Clean up raw transcriptions: range filter, monophony, quantize, seconds → beats. */
import type { Note } from "../model/types";
import type { Grid } from "./grid";

export interface SecNote {
  startSec: number;
  durSec: number;
  pitch: number;
  amp: number;
}

export function notesToBeats(
  notes: SecNote[],
  g: Grid,
  opts: { min: number; max: number; mono: boolean; quantize: number; minDurBeats: number },
): Note[] {
  let ns = notes
    .filter((n) => n.pitch >= opts.min && n.pitch <= opts.max)
    .map((n) => ({
      pitch: n.pitch,
      start: g.clipStartBeat + n.startSec / g.spb,
      dur: n.durSec / g.spb,
      vel: Math.max(30, Math.min(127, Math.round(40 + n.amp * 90))),
    }))
    .filter((n) => n.dur >= opts.minDurBeats)
    .sort((a, b) => a.start - b.start);

  if (opts.mono) {
    const out: Note[] = [];
    for (const n of ns) {
      const prev = out[out.length - 1];
      if (prev && n.start < prev.start + prev.dur - 0.05) {
        // Overlap: keep the stronger/longer, truncate the earlier one.
        if (n.vel * n.dur > prev.vel * prev.dur * 1.2 && n.start - prev.start > 0.1) {
          prev.dur = n.start - prev.start;
          out.push(n);
        }
        continue;
      }
      out.push(n);
    }
    ns = out;
  }
  if (opts.quantize > 0) {
    const q = opts.quantize;
    for (const n of ns) {
      const s = Math.round(n.start / q) * q;
      const e = Math.max(s + q, Math.round((n.start + n.dur) / q) * q);
      n.start = s;
      n.dur = e - s;
    }
    if (opts.mono) for (let i = 0; i < ns.length - 1; i++) ns[i].dur = Math.min(ns[i].dur, Math.max(q, ns[i + 1].start - ns[i].start));
    // Remove exact duplicates created by quantisation.
    const seen = new Set<string>();
    ns = ns.filter((n) => {
      const k = `${n.pitch}@${n.start}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return ns;
}
