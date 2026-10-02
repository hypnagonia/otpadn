/**
 * Pro-mix chains: an instrument can come with the channel an engineer would set up for it
 * (EQ + inserts + calibrated fader). Applied once when the instrument lands on a track
 * (`track.chain` remembers which instrument the channel was set up for), re-applied on request.
 * The multitrack kit's chain is its mic channels + drum bus (model/auxTracks.ts).
 */
import { isMultiKit } from "../instruments/multikit";
import { defaultParams, type Insert, type PluginType } from "../plugins/defs";
import { BUS_CH, busInserts, KIT_MIX, PAN } from "./auxTracks";
import { defaultChannel, uid, type ChannelSettings, type Project, type Track } from "./types";
import type { KitGroup } from "../instruments/multikit";

export interface Chain {
  ch: Partial<ChannelSettings>;
  inserts: () => Insert[];
}

const fx = (type: PluginType, p: Partial<Record<string, number>>): Insert => ({ id: uid("chain"), type, on: true, params: { ...defaultParams(type), ...p } as Record<string, number> });

/**
 * Fingered DI bass, the classic rock chain: HPF + low shelf for weight, mud cut at 250, growl at
 * 900, top rolled off (string noise); a fast peak comp for the attack, parallel tube grit filtered
 * to 4.5 kHz (audible on small speakers, no fizz), then a slow RMS leveller so every note sits
 * at the same loudness under the kick. Fader keeps the plain instrument's loudness.
 */
export const CHAINS: Record<string, Chain> = {
  "sampled:bass-fingered": {
    ch: { volumeDb: 0, hpf: 35, eqLow: 1.5, eqLowFreq: 90, eqMid: -3, eqMidFreq: 250, eqMidQ: 1, eqMid2: 2.5, eqMid2Freq: 900, eqMid2Q: 1.2, eqHigh: 0, lpf: 9000 },
    inserts: () => [
      fx("compressor", { threshold: -22, ratio: 4, attack: 3, release: 80, makeup: 3, knee: 4 }),
      fx("saturator", { mode: 2, drive: 9, tone: 4500, mix: 30 }),
      fx("compressor", { threshold: -16, ratio: 2.5, attack: 25, release: 200, makeup: 1, knee: 6, detector: 1 }),
    ],
  },
};

export const chainFor = (instrument?: string) => (instrument ? CHAINS[instrument] : undefined);
/** Whether a track's channel is (still) the pro-mix chain of its instrument. */
export const hasChain = (t: Track) => !!t.instrument && t.chain === t.instrument && (!!chainFor(t.instrument) || isMultiKit(t.instrument));

const EQ_KEYS = ["hpf", "eqLow", "eqLowFreq", "eqMid", "eqMidFreq", "eqMidQ", "eqMid2", "eqMid2Freq", "eqMid2Q", "eqHigh", "eqHighFreq", "lpf"] as const;

function setChannel(t: Track, c: Chain, replaceAll: boolean) {
  const d = defaultChannel();
  for (const k of EQ_KEYS) (t.ch as unknown as Record<string, number>)[k] = d[k];
  Object.assign(t.ch, c.ch);
  t.inserts = [...c.inserts(), ...(replaceAll ? [] : (t.inserts ?? []).filter((i) => !i.id.startsWith("chain")))];
  t.chain = t.instrument;
}

/** After every project change: a MIDI track whose instrument changed gets that instrument's chain. */
export function syncChains(p: Project) {
  for (const t of p.tracks) {
    if (t.kind !== "midi" || t.pp || isMultiKit(t.instrument) || t.chain === t.instrument) continue;
    const c = chainFor(t.instrument), prev = chainFor(t.chain);
    if (c) setChannel(t, c, false);
    else {
      // Leaving a chained instrument: its EQ and inserts don't fit the new sound.
      if (prev) setChannel(t, { ch: { volumeDb: t.ch.volumeDb }, inserts: () => [] }, false);
      t.chain = t.instrument;
    }
  }
}

/** "Reset to pro mix": the instrument's chain (kit: every mic channel + the drum bus), replacing all inserts. */
export function applyProMix(p: Project, trackId: string): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== "midi") return false;
  if (isMultiKit(t.instrument)) {
    setChannel(t, { ch: BUS_CH, inserts: busInserts }, true);
    for (const a of p.tracks) {
      if (a.kind !== "aux" || a.auxOf !== t.id) continue;
      const g = a.auxOut as KitGroup;
      const keep = { mute: a.ch.mute, solo: a.ch.solo, sends: a.ch.sends };
      a.ch = { ...defaultChannel(), pan: PAN[g] ?? 0, ...KIT_MIX[g].ch, ...keep };
      a.inserts = KIT_MIX[g].inserts();
    }
    return true;
  }
  const c = chainFor(t.instrument);
  if (!c) return false;
  setChannel(t, c, true);
  return true;
}

/** Legacy sessions: mark tracks so existing mixes aren't rewritten; a bare channel still gets its chain. */
export function migrateChains(p: Project) {
  for (const t of p.tracks) if (t.kind === "midi" && t.chain === undefined && (isMultiKit(t.instrument) || t.inserts.length)) t.chain = t.instrument;
}
