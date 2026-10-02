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
  return notes.map((n) => {
    const r = RANGE[n.pitch];
    if (!r) return n;
    const t = Math.max(0, Math.min(1, (n.vel - 1) / 126));
    const shaped = Math.pow(t, 0.85); // lift mid dynamics into the middle layers
    const vel = Math.round(r[0] + shaped * (r[1] - r[0]) + rnd() * 6);
    return { ...n, vel: Math.max(1, Math.min(127, vel)) };
  });
}
