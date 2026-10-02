/**
 * Strum detection for guitar parts. A strum is one musical event: its notes arrive within a short
 * window (the hand crossing the strings), ordered low→high on a downstroke and high→low on an
 * upstroke. Transcription gives us those as separate notes with small onset offsets; this groups
 * them back, reads the direction from the pitch order over time and measures the spread.
 */
import type { PEvent } from "./types";

export type StrumDir = "down" | "up" | "block";

export interface Strum {
  start: number; // beats (first string)
  events: PEvent[]; // in time order
  dir: StrumDir;
  spreadMs: number;
  vel: number;
}

export interface StrumStats {
  /** Share of multi-note hits that are strums (spread + clear direction). */
  strummed: number;
  down: number; // share of strums
  up: number;
  spreadMs: number; // median spread of strums
  hits: number; // multi-note hits
}

const played = (e: PEvent) => e.start + e.micro;

/** Group window: up to 85 ms, but never more than 60 % of a 16th note (fast strumming). */
export const strumWindowSec = (spb: number) => Math.min(0.085, 0.6 * 0.25 * spb);

export function detectStrums(evs: PEvent[], spb: number): { strums: Strum[]; stats: StrumStats } {
  const win = strumWindowSec(spb) / spb; // beats
  const s = [...evs].sort((a, b) => played(a) - played(b) || a.pitch - b.pitch);
  const strums: Strum[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && played(s[j + 1]) - played(s[i]) <= win) j++;
    const group = s.slice(i, j + 1);
    const spreadMs = (played(group[group.length - 1]) - played(group[0])) * spb * 1000;
    let dir: StrumDir = "block";
    if (group.length >= 2 && spreadMs >= 8) {
      let upPairs = 0, downPairs = 0;
      for (let k = 1; k < group.length; k++) {
        if (group[k].pitch > group[k - 1].pitch) downPairs++; // rising pitch over time = downstroke
        else if (group[k].pitch < group[k - 1].pitch) upPairs++;
      }
      const n = upPairs + downPairs;
      if (n && downPairs / n >= 0.7) dir = "down";
      else if (n && upPairs / n >= 0.7) dir = "up";
    }
    strums.push({ start: played(group[0]), events: group, dir, spreadMs, vel: Math.max(...group.map((e) => e.vel)) });
    i = j + 1;
  }
  const multi = strums.filter((x) => x.events.length >= 3);
  const real = multi.filter((x) => x.dir !== "block");
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return {
    strums,
    stats: {
      strummed: multi.length ? real.length / multi.length : 0,
      down: real.length ? real.filter((x) => x.dir === "down").length / real.length : 0,
      up: real.length ? real.filter((x) => x.dir === "up").length / real.length : 0,
      spreadMs: Math.round(med(real.map((x) => x.spreadMs))),
      hits: multi.length,
    },
  };
}
