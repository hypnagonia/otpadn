/**
 * Authored style knowledge for house, techno and acoustic rock/metal. Patterns are 16-step strings:
 * X = accent, x = normal, o = soft, g = ghost, . = rest. The profiles differ in rhythm
 * (patterns), accents (role velocities, polymetric accent cycles), density (pattern sets),
 * micro-timing (per-voice offsets, swing) and development (fill / variation vocabulary).
 */
import type { Layer, Style, Voice } from "./types";

export const SYMBOL_WEIGHT: Record<string, number> = { X: 1, x: 0.8, o: 0.6, g: 0.35 };

export interface LayerPattern {
  name: string;
  energy: number; // 0..1 where this pattern sits
  voices: Partial<Record<Voice, string>>;
}

/** A fill / variation on one bar: clear some voices from a step on, add new hits. */
export interface PhraseMove {
  name: string;
  weight: number;
  clearFrom: number; // step
  clear: Voice[];
  add: { voice: Voice; step: number; w: number }[];
}

export type Role = "down" | "back" | "quarter" | "off8" | "s16" | "ghost";

export interface StyleProfile {
  name: Style;
  desc: string;
  swing: number; // default GrooveParams.swing
  /** ms offsets per voice: [on-8th, off-16th]. Kick stays strict in both styles. */
  micro: Partial<Record<Voice, [number, number]>>;
  /** ms of per-bar drift per voice (one value per bar/voice, correlated across its notes). */
  drift: Partial<Record<Voice, number>>;
  roleVel: Record<Role, number>;
  /** Polymetric accent multipliers over running 16ths for some voices (shifts every bar). */
  accentCycle?: { voices: Voice[]; cycle: number[] };
  layers: Record<Exclude<Layer, "phrase">, LayerPattern[]>;
  /** Optional hits, used only when the user raises density. */
  extra: Partial<Record<Voice, string>>;
  fills: PhraseMove[];
  variations: PhraseMove[];
}

const ramp = (voice: Voice, steps: number[], from: number, to: number) =>
  steps.map((step, i) => ({ voice, step, w: from + ((to - from) * i) / Math.max(1, steps.length - 1) }));

export const STYLES: Record<Style, StyleProfile> = {
  house: {
    name: "house",
    desc: "four-on-the-floor, clap on 2 & 4, swung 16th hats, offbeat open hats, conga/rim answers, clap-roll & lift fills",
    swing: 0.32,
    micro: {
      kick: [0, 0], clap: [4, 4], snare: [3, 5], hhc: [-2, 6], hhp: [0, 5], hho: [5, 5], shaker: [4, 8],
      ride: [3, 6], perc: [6, 6], rim: [4, 4], tomL: [3, 3], tomM: [3, 3], tomH: [3, 3], crash: [0, 0],
    },
    drift: { clap: 2, snare: 2, hhc: 3, hho: 3, shaker: 4, perc: 4, rim: 3, ride: 2 },
    roleVel: { down: 1, back: 0.95, quarter: 0.85, off8: 0.82, s16: 0.55, ghost: 0.3 },
    layers: {
      foundation: [
        { name: "four on the floor", energy: 0.5, voices: { kick: "X...X...X...X...", clap: "....X.......X..." } },
        { name: "four + snare layer", energy: 0.75, voices: { kick: "X...X...X...X...", clap: "....X.......X...", snare: "....x.......x..." } },
        { name: "four + ghost snares", energy: 0.9, voices: { kick: "X...X...X...X...", clap: "....X.......X...", snare: ".......g.g.....g" } },
        { name: "deep broken", energy: 0.2, voices: { kick: "X.....x...X.....", clap: "....X.......X..." } },
        { name: "garage skip", energy: 0.4, voices: { kick: "X......x..X.....", clap: "....X.......X...", snare: "..............g." } },
      ],
      motion: [
        { name: "offbeat open hats", energy: 0.35, voices: { hho: "..X...X...X...X." } },
        { name: "open hats + swung 16ths", energy: 0.7, voices: { hho: "..X...X...X...X.", hhc: "og.gog.gog.gog.g" } },
        { name: "shaker groove", energy: 0.55, voices: { hho: "..x...x...x...x.", shaker: "xgoxxgoxxgoxxgox" } },
        { name: "ride drive", energy: 0.85, voices: { ride: "..x...x...x...x.", hhc: "x.g.x.g.x.g.x.g." } },
      ],
      perc: [
        { name: "conga answers", energy: 0.5, voices: { perc: "......x..x....x." } },
        { name: "rim syncopation", energy: 0.6, voices: { rim: "...x......x..x.." } },
        { name: "bongo chatter", energy: 0.85, voices: { perc: "..x.g.x...x.g.xg" } },
        { name: "sparse rim", energy: 0.3, voices: { rim: "..........x....." } },
      ],
    },
    extra: { kick: ".............o..", snare: "..g.......g.....", hhc: "g.g.g.g.g.g.g.g.", shaker: "gggggggggggggggg", perc: "..g...g...g...g." },
    fills: [
      { name: "snare roll", weight: 3, clearFrom: 12, clear: ["snare", "clap"], add: ramp("snare", [12, 13, 14, 15], 0.45, 0.9) },
      { name: "kick drop + lift", weight: 2, clearFrom: 12, clear: ["kick"], add: [{ voice: "hho", step: 14, w: 0.85 }, { voice: "clap", step: 15, w: 0.6 }] },
      { name: "open-hat lift", weight: 2, clearFrom: 13, clear: ["hhc", "hho"], add: [{ voice: "hho", step: 14, w: 0.8 }, { voice: "hho", step: 15, w: 0.7 }] },
      { name: "half-bar build", weight: 1, clearFrom: 8, clear: ["snare", "clap"], add: ramp("snare", [8, 10, 12, 13, 14, 15], 0.4, 0.95) },
    ],
    variations: [
      { name: "kick pickup", weight: 2, clearFrom: 16, clear: [], add: [{ voice: "kick", step: 15, w: 0.5 }] },
      { name: "conga answer", weight: 2, clearFrom: 16, clear: [], add: [{ voice: "perc", step: 13, w: 0.6 }, { voice: "perc", step: 14, w: 0.5 }] },
      { name: "hat breath", weight: 1, clearFrom: 12, clear: ["hhc"], add: [] },
    ],
  },
  techno: {
    name: "techno",
    desc: "strict 4/4 kick, sparse clap, straight 16th hats with rolling 3-step accents, rumble ghost kicks, 3-3-2 rims, subtractive drops",
    swing: 0.04,
    micro: {
      kick: [0, 0], clap: [2, 2], snare: [2, 2], hhc: [-1, 2], hhp: [0, 1], hho: [2, 2], ride: [3, 3], shaker: [1, 3],
      rim: [3, 1], perc: [0, 3], tomL: [0, 0], tomM: [0, 0], tomH: [0, 0], crash: [0, 0],
    },
    drift: { hhc: 1.5, hho: 1, ride: 1.5, rim: 1, perc: 1.5 },
    roleVel: { down: 1, back: 0.9, quarter: 0.9, off8: 0.88, s16: 0.62, ghost: 0.3 },
    accentCycle: { voices: ["hhc", "ride", "rim", "perc"], cycle: [1, 0.76, 0.86] },
    layers: {
      foundation: [
        { name: "4/4 strict", energy: 0.3, voices: { kick: "X...X...X...X..." } },
        { name: "4/4 + clap", energy: 0.55, voices: { kick: "X...X...X...X...", clap: "....x.......x..." } },
        { name: "4/4 rumble", energy: 0.75, voices: { kick: "X...X...X...X..g", clap: "....x.......x..." } },
        { name: "4/4 + offbeat snare", energy: 0.9, voices: { kick: "X...X...X...X...", clap: "....x.......x...", snare: "......g.......g." } },
        { name: "broken techno", energy: 0.5, voices: { kick: "X..x..x...X.....", clap: "....x.......x..." } },
      ],
      motion: [
        { name: "offbeat open hat", energy: 0.35, voices: { hho: "..X...X...X...X." } },
        { name: "16ths + open", energy: 0.7, voices: { hho: "..X...X...X...X.", hhc: "xo.oxo.oxo.oxo.o" } },
        { name: "ride offbeats", energy: 0.85, voices: { ride: "..x...x...x...x.", hhc: "x.o.x.o.x.o.x.o." } },
        { name: "dotted 8ths", energy: 0.6, voices: { hhc: "x..x..x..x..x..x", hho: "..x.........x..." } },
      ],
      perc: [
        { name: "3-3-2 rim", energy: 0.6, voices: { rim: "x..x..x.x..x..x." } },
        { name: "tom stabs", energy: 0.5, voices: { tomL: "...x.......x....", tomM: "..........x....." } },
        { name: "perc in threes", energy: 0.75, voices: { perc: "..x..x..x..x..x." } },
        { name: "sparse perc", energy: 0.3, voices: { perc: "...........x...." } },
      ],
    },
    extra: { kick: "..............g.", hhc: "gggggggggggggggg", rim: "..g..g..g..g..g.", perc: ".g...g...g...g.." },
    fills: [
      { name: "kick drop", weight: 3, clearFrom: 8, clear: ["kick"], add: [{ voice: "hho", step: 14, w: 0.8 }] },
      { name: "rim stutter", weight: 2, clearFrom: 12, clear: ["rim"], add: ramp("rim", [12, 13, 14, 15], 0.35, 0.75) },
      { name: "snare 16th build", weight: 1, clearFrom: 8, clear: ["clap", "snare"], add: ramp("snare", [8, 9, 10, 11, 12, 13, 14, 15], 0.25, 0.7) },
      { name: "full stop", weight: 1, clearFrom: 14, clear: ["kick", "clap", "snare", "rim", "perc", "tomL", "tomM"], add: [] },
    ],
    variations: [
      { name: "rumble kick", weight: 2, clearFrom: 16, clear: [], add: [{ voice: "kick", step: 15, w: 0.35 }] },
      { name: "tom stab", weight: 1, clearFrom: 16, clear: [], add: [{ voice: "tomL", step: 11, w: 0.6 }] },
      { name: "kick gap", weight: 1, clearFrom: 12, clear: ["kick"], add: [] },
    ],
  },
  rock: {
    name: "rock",
    desc: "acoustic rock / metal for the CrocellKit: backbeat on 2 & 4, real ghost notes, hat & ride accents on the beat, crashes on downbeats, tom fills, double kick at full energy",
    swing: 0,
    micro: {
      kick: [0, 0], snare: [6, 5], clap: [6, 5], rim: [4, 4], hhc: [-2, 3], hhp: [0, 2], hho: [-1, 2], ride: [-1, 3], shaker: [0, 3],
      crash: [0, 0], tomL: [2, 3], tomM: [2, 3], tomH: [2, 3], perc: [0, 2],
    },
    drift: { hhc: 2.5, hho: 2, ride: 2.5, snare: 2, tomL: 1.5, tomM: 1.5, tomH: 1.5 },
    roleVel: { down: 1, back: 0.97, quarter: 0.8, off8: 0.62, s16: 0.45, ghost: 0.22 },
    accentCycle: { voices: ["hhc", "ride"], cycle: [1, 0.68, 0.84, 0.68] },
    layers: {
      foundation: [
        { name: "half-time", energy: 0.25, voices: { kick: "X.........x.....", snare: "........X......." } },
        { name: "straight rock", energy: 0.45, voices: { kick: "X.......X.x.....", snare: "....X.......X..." } },
        { name: "rock push + ghosts", energy: 0.65, voices: { kick: "X.....x.X.x.....", snare: "....X..g.g..X..g" } },
        { name: "four-on-floor rock", energy: 0.75, voices: { kick: "X...X...X...X...", snare: "....X.......X..." } },
        { name: "double-kick 16ths", energy: 0.95, voices: { kick: "XxxxXxxxXxxxXxxx", snare: "....X.......X..." } },
      ],
      motion: [
        { name: "8th hats", energy: 0.4, voices: { hhc: "X.x.X.x.X.x.X.x." } },
        { name: "16th hats", energy: 0.6, voices: { hhc: "XoxoXoxoXoxoXoxo" } },
        { name: "open-hat 8ths", energy: 0.8, voices: { hho: "X.x.X.x.X.x.X.x." } },
        { name: "ride quarters + pedal", energy: 0.7, voices: { ride: "X...X...X...X...", hhp: "....x.......x..." } },
        { name: "ride 8ths", energy: 0.9, voices: { ride: "X.x.X.x.X.x.X.x.", hhp: "x...x...x...x..." } },
      ],
      perc: [
        { name: "crash on the one", energy: 0.7, voices: { crash: "X..............." } },
        { name: "floor-tom pulse", energy: 0.5, voices: { tomL: "X...X...X...X..." } },
        { name: "tom accents", energy: 0.6, voices: { tomH: "......x.........", tomL: "..............x." } },
        { name: "sparse crash", energy: 0.35, voices: { crash: "X..............." } },
      ],
    },
    extra: { snare: "..g..g.g..g..g..", kick: ".......g......g.", hhc: "..g...g...g...g." },
    fills: [
      { name: "tom run", weight: 3, clearFrom: 12, clear: ["hhc", "hho", "ride", "snare"], add: [...ramp("tomH", [12, 13], 0.75, 0.85), ...ramp("tomM", [14], 0.9, 0.9), ...ramp("tomL", [15], 1, 1)] },
      { name: "snare 16ths", weight: 2, clearFrom: 12, clear: ["hhc", "hho", "ride", "snare"], add: ramp("snare", [12, 13, 14, 15], 0.55, 1) },
      { name: "half-bar fill", weight: 1, clearFrom: 8, clear: ["hhc", "hho", "ride", "snare", "kick"], add: [...ramp("snare", [8, 9], 0.7, 0.8), ...ramp("tomH", [10, 11], 0.8, 0.85), ...ramp("tomM", [12, 13], 0.85, 0.9), ...ramp("tomL", [14, 15], 0.95, 1)] },
      { name: "flam & crash", weight: 1, clearFrom: 14, clear: ["hhc", "hho", "ride"], add: [{ voice: "snare", step: 14, w: 0.95 }, { voice: "tomL", step: 15, w: 1 }] },
    ],
    variations: [
      { name: "crash accent", weight: 2, clearFrom: 16, clear: [], add: [{ voice: "crash", step: 0, w: 1 }] },
      { name: "kick push", weight: 2, clearFrom: 16, clear: [], add: [{ voice: "kick", step: 14, w: 0.75 }] },
      { name: "open hat lift", weight: 1, clearFrom: 14, clear: ["hhc"], add: [{ voice: "hho", step: 14, w: 0.85 }] },
      { name: "ghost pickup", weight: 1, clearFrom: 16, clear: [], add: [{ voice: "snare", step: 15, w: 0.3 }] },
    ],
  },
};

export const VOICE_DUR: Partial<Record<Voice, number>> = { hho: 0.5, ride: 1, crash: 2 };
