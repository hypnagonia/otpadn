/**
 * Mix styles for the pro-mix chains (kit mic channels + drum bus, bass). One style per track
 * (`track.mixStyle`), picked from the track menu; new kits and basses get DEFAULT_STYLE.
 *  - "metal": matched to Soilwork's "Stabbing the Drama" (2005) by measurement against its drum
 *    and bass stems (per-hit kick/snare spectra, long-term spectrum, crest factor):
 *    drums — mid-forward kick (sub and 120 Hz hump cut, not scooped), snare with 500 Hz body and
 *    tamed 3 kHz, bus with a 190 Hz cut, 900 Hz push, air, glue + parallel punch + converter-style
 *    clipping (~17 dB crest); kit spectrum within ±1.5 dB of the reference (sample layers on).
 *    bass — split bass: deep clean DI with a wide 380 Hz scoop, hard grit high-passed at 2 kHz
 *    before it clips (growl/fizz only on top), heavy levelling + tape density; within ±4 dB.
 *  - "rock": the classic rock chain (model/auxTracks.ts KIT_MIX + model/chains.ts).
 * Faders are calibrated by offline LUFS renders (re-measure if you change a chain).
 */
import type { KitGroup } from "../instruments/multikit";
import { defaultParams, type Insert, type PluginType } from "../plugins/defs";
import { uid, type ChannelSettings } from "./types";

export type MixStyle = "metal" | "rock";
/** Drum hits in the cymbal mics per style (dB): metal = cymbals-only overheads/hat/ride mics. */
export const CYMBAL_BLEED: Record<MixStyle, number> = { metal: -30, rock: 0 };
export const DEFAULT_STYLE: MixStyle = "metal";
export const MIX_STYLE_LABEL: Record<MixStyle, string> = { metal: "modern metal", rock: "classic rock" };
/** Bump when a style's chains change: tracks set up with an older version show "update". */
export const MIX_VERSION: Record<MixStyle, number> = { metal: 10, rock: 0 };

export interface ChannelChain {
  ch: Partial<ChannelSettings>;
  inserts: () => Insert[];
}

const fx = (type: PluginType, p: Partial<Record<string, number>>): Insert => ({ id: uid("chain"), type, on: true, params: { ...defaultParams(type), ...p } as Record<string, number> });
const comp = (p: Partial<Record<string, number>>) => fx("compressor", p);
/** airwindows ports (plugins/worklets.ts): Density2 saturation, ButterComp2 glue, ClipOnly2 clipper. */
const density = (p: Partial<Record<string, number>>) => fx("density", p);
const butter = (p: Partial<Record<string, number>>) => fx("buttercomp", p);
const clip = (p: Partial<Record<string, number>>) => fx("cliponly", p);
/** Match EQ with a fitted 31-band curve (dB per 1/3 octave, 20 Hz–20 kHz). */
const trans = (p: Partial<Record<string, number>>) => fx("transient", p);
const match = (g: number[]) => fx("match", Object.fromEntries(g.map((v, k) => [`b${k}`, v])));
/*
 * Match curves, fitted by measurement against the reference stems (offline: render → compare
 * 1/3-octave spectra → curve += 0.8 × difference → re-render, until it converges).
 */
/** Transient shaping fitted to the reference hit envelopes (body sustain, attack decay). */
export const KICK_TRANS = { attack: -30, sustain: 0 };
export const SNARE_TRANS = { attack: -15, sustain: 0 };
export const KICK_MATCH: number[] = [0.0,  0.0,  0.0,  -0.8,  -2.9,  -2.9,  -1.7,  1.3,  1.4,  1.0,  6.1,  4.0,  -1.0,  -0.0,  0.4,  -2.3,  -2.3,  0.4,  -0.6,  -1.7,  0.7,  1.6,  -0.1,  -0.4,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0];
export const SNARE_MATCH: number[] = [0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.9,  2.1,  -1.1,  -2.5,  -0.7,  -4.2,  -7.2,  -7.0,  -5.4,  -2.6,  -2.5,  -2.6,  -0.0,  2.3,  4.7,  7.3,  8.3,  7.3,  2.9,  0.0,  0.0,  0.0,  0.0];
export const CYM_MATCH: number[] = [0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  -1.1,  1.4,  4.6,  -3.7,  -11.7,  -10.6,  -9.6,  -7.4,  -4.2,  -6.0,  -3.4,  2.0,  4.1,  7.2,  7.0,  7.2,  10.0,  8.5,  4.6,  1.3];
export const BUS_MATCH: number[] = [0.0,  4.6,  6.2,  0.3,  2.3,  4.9,  0.5,  -0.9,  -1.9,  -3.1,  -0.1,  2.4,  0.4,  -1.0,  2.1,  4.6,  3.0,  2.3,  3.8,  3.3,  1.6,  0.8,  -0.6,  -2.5,  -3.6,  -5.5,  -5.5,  -4.1,  -6.0,  -6.2,  -2.3];
export const BASS_MATCH: number[] = [0.4,  -1.1,  2.4,  6.2,  7.1,  5.3,  5.6,  5.5,  0.9,  0.9,  4.8,  4.5,  2.8,  4.3,  5.4,  4.7,  11.8,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0];

export const METAL_KIT: Record<KitGroup, ChannelChain> = {
  kick: {
    ch: { volumeDb: 2, hpf: 64, eqLow: -6, eqLowFreq: 50, eqMid: -8, eqMidFreq: 108, eqMidQ: 2.4, eqMid2: 5, eqMid2Freq: 4500, eqMid2Q: 1.3, eqHigh: 2, eqHighFreq: 9000, lpf: 14000 },
    inserts: () => [trans(KICK_TRANS), comp({ threshold: -24, ratio: 6, attack: 8, release: 50, makeup: 4, knee: 2 }), density({ density: 0.3, output: 0.8, mix: 0.2 }), match(KICK_MATCH)],
  },
  snare: {
    ch: { volumeDb: 1, hpf: 100, eqLow: 0, eqLowFreq: 170, eqMid: 2, eqMidFreq: 500, eqMidQ: 1.4, eqMid2: -4, eqMid2Freq: 4000, eqMid2Q: 0.8, eqHigh: 0, eqHighFreq: 10000, reverbSend: 0.12 },
    inserts: () => [trans(SNARE_TRANS), comp({ threshold: -24, ratio: 5, attack: 1, release: 100, makeup: 4, knee: 2 }), density({ density: 0.35, output: 0.75, mix: 0.25 }), match(SNARE_MATCH)],
  },
  // Toms: EQ only (no compression, no gate: their tracks carry no bleed).
  toms: { ch: { volumeDb: -12.5, hpf: 60, eqLow: 2, eqLowFreq: 100, eqMid: -5, eqMidFreq: 450, eqMidQ: 1, eqMid2: 4, eqMid2Freq: 4000, eqMid2Q: 1, reverbSend: 0.1 }, inserts: () => [] },
  // Cymbal mics: high-passed and scooped hard (no body), sizzle at 6.5 kHz — matched to the
  // reference's cymbal-only spectrum within ±3.5 dB.
  hihat: { ch: { volumeDb: -9, hpf: 800, eqMid: -6, eqMidFreq: 850, eqMidQ: 0.7, eqMid2: 7, eqMid2Freq: 6500, eqMid2Q: 0.9, eqHigh: 2, eqHighFreq: 9000 }, inserts: () => [match(CYM_MATCH)] },
  ride: { ch: { volumeDb: -10, hpf: 700, eqMid: -5, eqMidFreq: 800, eqMidQ: 0.7, eqMid2: 6, eqMid2Freq: 6500, eqMid2Q: 0.9, eqHigh: 2, eqHighFreq: 9000 }, inserts: () => [match(CYM_MATCH)] },
  overheads: {
    ch: { volumeDb: -9, hpf: 600, eqMid: -7, eqMidFreq: 750, eqMidQ: 0.7, eqMid2: 7, eqMid2Freq: 6500, eqMid2Q: 0.9, eqHigh: 2, eqHighFreq: 9000 },
    // 15 ms attack lets the cymbal stick through.
    inserts: () => [comp({ threshold: -18, ratio: 2.5, attack: 15, release: 120, makeup: 1.5, knee: 6 }), match(CYM_MATCH)],
  },
  room: {
    ch: { volumeDb: -16, hpf: 300, eqMid: -6, eqMidFreq: 700, eqMidQ: 0.6, lpf: 12000 },
    inserts: () => [comp({ threshold: -24, ratio: 4, attack: 8, release: 60, makeup: 3, knee: 4 }), match(CYM_MATCH)],
  },
};
export const metalBusInserts = (): Insert[] => [
  butter({ compress: 0.35, output: 0.5, mix: 1 }),
  // parallel punch: 5 ms attack keeps the transients, 18 % wet
  comp({ threshold: -30, ratio: 8, attack: 5, release: 60, makeup: 8, knee: 2, mix: 18 }),
  match(BUS_MATCH),
  // converter-style clipping of the kick/snare peaks (the reference's density: ~17 dB crest)
  clip({ drive: 1.5, output: -1.5 }), // only real overs: harder clipping intermodulated the cymbals
];
export const METAL_BUS_CH: Partial<ChannelSettings> = { volumeDb: -7, eqLow: -2.5, eqLowFreq: 120, eqMid: -2.5, eqMidFreq: 190, eqMidQ: 0.8, eqMid2: 3.5, eqMid2Freq: 1000, eqMid2Q: 0.6, eqHigh: 2, eqHighFreq: 9000 };

/** Metal bass: tight DI low end + amp grit (parallel via the amp's level), growl at 1.1 kHz. */
export const METAL_BASS: ChannelChain = {
  // Dark: no highs / high-mids (user call) — the reference match is kept below 1 kHz only, the grit
  // layer is gone, and a low-pass at 1.8 kHz closes the top. Deep clean lows + the low-mid scoop stay.
  ch: { volumeDb: -5.5, hpf: 42, eqLow: -1, eqLowFreq: 160, eqMid: -14, eqMidFreq: 380, eqMidQ: 0.6, eqMid2: 0, eqMid2Freq: 1200, eqMid2Q: 1, eqHigh: 0, eqHighFreq: 3000, lpf: 1800 },
  inserts: () => [
    comp({ threshold: -24, ratio: 5, attack: 2, release: 60, makeup: 4, knee: 2 }),
    comp({ threshold: -22, ratio: 6, attack: 10, release: 120, makeup: 4, knee: 6, detector: 1 }),
    density({ density: 0.3, output: 0.85, mix: 1 }),
    match(BASS_MATCH),
  ],
};
