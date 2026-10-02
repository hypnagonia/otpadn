/**
 * Pro-mix chains: an instrument can come with the channel an engineer would set up for it
 * (EQ + inserts + calibrated fader). Applied once when the instrument lands on a track
 * (`track.chain` remembers which instrument the channel was set up for), re-applied on request.
 * The multitrack kit's chain is its mic channels + drum bus (model/auxTracks.ts).
 */
import { isMultiKit } from "../instruments/multikit";
import { defaultParams, type Insert, type PluginType } from "../plugins/defs";
import { kitStyle, PAN } from "./auxTracks";
import { CYMBAL_BLEED, DEFAULT_STYLE, METAL_BASS, MIX_VERSION, type MixStyle } from "./mixStyles";
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

/** Style variants of a chain (falls back to the base chain). */
const STYLED: Partial<Record<MixStyle, Record<string, Chain>>> = { metal: { "sampled:bass-fingered": METAL_BASS } };
export const chainFor = (instrument?: string, style: MixStyle = "rock") => (instrument ? STYLED[style]?.[instrument] ?? CHAINS[instrument] : undefined);
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
    const c = chainFor(t.instrument, t.mixStyle ?? DEFAULT_STYLE), prev = chainFor(t.chain);
    if (c) {
      t.mixStyle ??= DEFAULT_STYLE;
      t.mixVersion = MIX_VERSION[t.mixStyle];
      setChannel(t, c, false);
    }
    else {
      // Leaving a chained instrument: its EQ and inserts don't fit the new sound.
      if (prev) setChannel(t, { ch: { volumeDb: t.ch.volumeDb }, inserts: () => [] }, false);
      t.chain = t.instrument;
    }
  }
}

/** The track a pro mix applies to: kit mics act on their kit (owner) track. */
function proMixTarget(p: Project, t: Track | undefined): Track | undefined {
  return t?.kind === "aux" ? p.tracks.find((x) => x.id === t.auxOf) : t;
}
/** A bass chain for any bass track (other bass instruments, bass audio stems), by style. */
const bassChain = (style: MixStyle) => (style === "metal" ? METAL_BASS : CHAINS["sampled:bass-fingered"]);

/** Whether "pro mix" can be applied to this track (or, for a kit mic, to its kit). */
export function canProMix(p: Project, track: Track): boolean {
  const t = proMixTarget(p, track);
  if (!t || t.pp || t.kind === "bus") return false;
  return isMultiKit(t.instrument) || !!chainFor(t.instrument) || t.role === "bass";
}
/** The pro-mix target's current style (✓ in menus), or null when its channel isn't a pro mix. */
export function proMixStyle(p: Project, track: Track): MixStyle | null {
  const t = proMixTarget(p, track);
  return t && t.chain !== undefined && (t.chain === t.instrument || t.chain === "bass") ? t.mixStyle ?? "rock" : null;
}

/** The pro mix on this track (or its kit) is an older version of its style. */
export function proMixOutdated(p: Project, track: Track): boolean {
  const t = proMixTarget(p, track), st = proMixStyle(p, track);
  return !!t && !!st && (t.mixVersion ?? 0) < MIX_VERSION[st];
}

/** "Reset to pro mix": the instrument's chain (kit: every mic channel + the drum bus), replacing all inserts. */
export function applyProMix(p: Project, trackId: string, style?: MixStyle): boolean {
  const t = proMixTarget(p, p.tracks.find((x) => x.id === trackId));
  if (!t || t.pp || t.kind === "bus") return false;
  if (t.kind !== "midi" || (!isMultiKit(t.instrument) && !chainFor(t.instrument))) {
    if (t.role !== "bass") return false;
    t.mixStyle = style ?? t.mixStyle ?? DEFAULT_STYLE;
    t.mixVersion = MIX_VERSION[t.mixStyle];
    setChannel(t, bassChain(t.mixStyle), true);
    t.chain = t.kind === "midi" ? t.instrument : "bass"; // midi: keeps syncChains from re-applying
    return true;
  }
  t.mixStyle = style ?? t.mixStyle ?? DEFAULT_STYLE;
  t.mixVersion = MIX_VERSION[t.mixStyle];
  if (isMultiKit(t.instrument)) {
    const ks = kitStyle(t.mixStyle);
    t.kitCymbalBleed = CYMBAL_BLEED[t.mixStyle];
    setChannel(t, { ch: ks.busCh, inserts: ks.bus }, true);
    for (const a of p.tracks) {
      if (a.kind !== "aux" || a.auxOf !== t.id) continue;
      const g = a.auxOut as KitGroup;
      const keep = { mute: a.ch.mute, solo: a.ch.solo, sends: a.ch.sends };
      a.ch = { ...defaultChannel(), pan: PAN[g] ?? 0, ...ks.mics[g].ch, ...keep };
      a.inserts = ks.mics[g].inserts();
    }
    return true;
  }
  const c = chainFor(t.instrument, t.mixStyle);
  if (!c) return false;
  setChannel(t, c, true);
  return true;
}

/** Legacy sessions: mark tracks so existing mixes aren't rewritten; a bare channel still gets its chain. */
export function migrateChains(p: Project) {
  for (const t of p.tracks) if (t.kind === "midi" && t.chain === undefined && (isMultiKit(t.instrument) || t.inserts.length)) t.chain = t.instrument;
}
