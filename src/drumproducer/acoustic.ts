/**
 * Acoustic-kit mode (style "rock"): output goes to ONE drum track playing the multitrack
 * CrocellKit (its mic tracks appear automatically), and velocities are fitted to how a drummer
 * plays a real kit so they walk the kit's 8 sampled layers instead of sitting at "machine" values.
 */
import type { Note } from "../model/types";
import type { Style } from "./types";

export const ACOUSTIC_KIT = "multikit:crocell";
export const isAcoustic = (style: Style | undefined) => style === "rock";

/** Per GM note: velocity range a drummer uses on that piece (min for ghosts → max for accents). */
const RANGE: Record<number, [number, number]> = {
  36: [70, 124], 35: [70, 124], // kick: never feather-light in rock, heavy accents
  38: [24, 127], 40: [24, 127], // snare: real ghosts (24–45) up to rimshot-hard backbeats
  37: [40, 90], 39: [40, 110],
  42: [38, 104], 44: [30, 70], 46: [55, 112], // hats: wide accent pattern, pedal soft
  51: [45, 108], 59: [45, 108], 53: [70, 120], // ride bow / bell
  49: [92, 127], 57: [92, 127], 52: [92, 127], 55: [80, 120], // crashes are hit
  45: [70, 122], 47: [70, 122], 48: [70, 122], 50: [70, 122], 41: [70, 122], 43: [70, 122], // toms
};

/**
 * Map each note's velocity (shape kept: accents stay accents, ghosts stay ghosts) into that piece's
 * playing range, with a touch of human variation, so every layer of the kit gets used.
 */
export function fitVelocities(notes: Note[], seed = 1): Note[] {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280 - 0.5);
  const riding = ridingCymbals(notes);
  return notes.map((n) => {
    const r = RANGE[n.pitch];
    if (!r) return n;
    const t = Math.max(0, Math.min(1, (n.vel - 1) / 126));
    const ride = riding.get(n);
    if (ride) {
      // A cymbal used to keep time (crash ridden like a ride / hats): real dynamics, accents by
      // position in the bar — downbeat strongest, beat 3, other beats, off-beats softest.
      const pos = ((n.start % 4) + 4) % 4, frac = pos - Math.floor(pos + 1e-6);
      const accent = Math.abs(pos) < 0.05 || Math.abs(pos - 4) < 0.05 ? 1 : Math.abs(pos - 2) < 0.05 ? 0.84 : frac < 0.05 || frac > 0.95 ? 0.7 : Math.abs(frac - 0.5) < 0.05 ? 0.48 : 0.38;
      const w = accent * (0.75 + 0.25 * t);
      const vel = Math.round(ride[0] + w * (ride[1] - ride[0]) + rnd() * 5);
      return { ...n, vel: Math.max(1, Math.min(127, vel)) };
    }
    const shaped = Math.pow(t, 0.85); // lift mid dynamics into the middle layers
    const vel = Math.round(r[0] + shaped * (r[1] - r[0]) + rnd() * 6);
    return { ...n, vel: Math.max(1, Math.min(127, vel)) };
  });
}

const CRASH = new Set([49, 57, 52, 55]), RIDE = new Set([51, 59]);
/** Ranges when a cymbal is ridden (keeping time) instead of struck as a single accent. */
const RIDING_RANGE = { crash: [56, 120] as [number, number], ride: [42, 112] as [number, number] };

/** Cymbal notes that are part of a time-keeping run: ≥ 3 hits of one cymbal family at most a beat apart. */
function ridingCymbals(notes: Note[]): Map<Note, [number, number]> {
  const out = new Map<Note, [number, number]>();
  for (const [fam, set] of [["crash", CRASH], ["ride", RIDE]] as const) {
    const list = notes.filter((n) => set.has(n.pitch)).sort((a, b) => a.start - b.start);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].start - list[j].start <= 1.01) j++;
      if (j - i >= 2) for (let k = i; k <= j; k++) out.set(list[k], RIDING_RANGE[fam]);
      i = j + 1;
    }
  }
  return out;
}
