/** Adapters from smplr sample libraries to Playable, plus GM drum-note mapping. */
import { CacheStorage } from "smplr";
import type { Playable } from "./types";

/** Samples are cached in the browser Cache API, so each is downloaded once. */
export const storage = CacheStorage("stemdaw-samples");

export type SmplrLike = { ready: Promise<void>; start(ev: object): unknown; stop(): void; dispose(): void };

export class SmplrPlayable implements Playable {
  ready: Promise<void>;
  constructor(private inst: SmplrLike, private mapNote?: (n: number) => string | number | undefined) {
    this.ready = inst.ready;
  }
  start({ note, time, duration, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const n = this.mapNote ? this.mapNote(note) : note;
    if (n === undefined) return;
    const stop = this.inst.start({ note: n, time, duration, velocity });
    return typeof stop === "function" ? (at?: number) => (stop as (t?: number) => void)(at) : undefined;
  }
  stopAll() {
    this.inst.stop();
  }
  dispose() {
    this.inst.dispose();
  }
}

/** General-MIDI drum note → candidate sample group names across machines. */
export const GM_DRUMS: Record<number, string[]> = {
  35: ["kick", "kick-alt"],
  36: ["kick"],
  37: ["rimshot", "stick-m", "stick-h", "clave"],
  38: ["snare", "snare-m", "snare-h"],
  39: ["clap"],
  40: ["snare-h", "snare"],
  41: ["tom-low", "tom-ll", "tom-l", "tom-3"],
  42: ["hihat-close", "hihat-closed", "hhclosed", "hhclosed-short"],
  43: ["tom-low", "tom-l", "tom-3"],
  44: ["hihat-close", "hihat-closed", "hhclosed-short"],
  45: ["mid-tom", "tom-mid", "tom-m", "tom-2", "tom-low"],
  46: ["hihat-open", "hhopen"],
  47: ["mid-tom", "tom-mid", "tom-m", "tom-2"],
  48: ["tom-hi", "tom-high", "tom-h", "tom-1"],
  49: ["crash", "cymbal", "cymball"],
  50: ["tom-hi", "tom-high", "tom-hh", "tom-1"],
  51: ["ride", "cymbal", "cymball"],
  56: ["cowbell"],
  70: ["maraca", "cabasa", "tambourine"],
};

/** Keyword patterns per GM drum note, for kits whose sample names differ (e.g. DrumAbuse packs). */
const GM_PATTERNS: Record<number, RegExp[]> = {
  35: [/kick|bd|bass ?drum/], 36: [/kick|bd|bass ?drum/],
  37: [/rim|stick|clave/], 38: [/snare|sd/], 39: [/clap|cp/], 40: [/snare|sd/],
  42: [/(closed|cl|ch|chh)/, /hat|hh/], 44: [/pedal|closed|ch/, /hat|hh/], 46: [/open|oh|ohh/, /hat|hh/],
  41: [/low ?tom|lt|tom ?l|tom ?3|tom/], 43: [/low ?tom|lt|tom ?l|tom/], 45: [/mid ?tom|mt|tom ?m|tom ?2|tom/],
  47: [/mid ?tom|mt|tom ?m|tom/], 48: [/hi(gh)? ?tom|ht|tom ?h|tom ?1|tom/], 50: [/hi(gh)? ?tom|ht|tom ?h|tom/],
  49: [/crash|cy|cymbal/], 51: [/ride|rd|cymbal/], 56: [/cow ?bell|cb/], 70: [/maraca|shaker|cabasa|tamb/],
};

/** Resolve a GM note to one of a kit's group names: exact table first, then keyword match. */
export function resolveDrum(groups: string[], note: number): string | undefined {
  const set = new Set(groups);
  const exact = GM_DRUMS[note]?.find((c) => set.has(c));
  if (exact) return exact;
  const pats = GM_PATTERNS[note];
  if (!pats) return undefined;
  const lower = groups.map((g) => g.toLowerCase());
  const hit = lower.findIndex((g) => pats.every((re) => re.test(g)));
  return hit >= 0 ? groups[hit] : undefined;
}
