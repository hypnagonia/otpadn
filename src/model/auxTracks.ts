/**
 * Keeps multi-out instruments' output tracks in sync with the project: every MIDI track playing
 * a multitrack kit gets one aux track per mic group right below it (reused if it exists); aux
 * tracks whose owner is gone or changed instrument disappear. Runs after every project change.
 */
import { isMultiKit, KIT_GROUP_LABEL, KIT_GROUPS, type KitGroup } from "../instruments/multikit";
import { defaultParams, type Insert, type PluginType } from "../plugins/defs";
import { defaultChannel, uid, type ChannelSettings, type Project, type Track } from "./types";
import { CYMBAL_BLEED, MIX_VERSION, DEFAULT_STYLE, METAL_BUS_CH, METAL_KIT, metalBusInserts, type MixStyle } from "./mixStyles";

/** Starting pans for the mono mic groups (drummer's perspective); stereo groups are pre-panned. */
export const PAN: Partial<Record<KitGroup, number>> = { hihat: -0.55, ride: 0.55 };

/** Inserts made for a pro-mix chain carry a "chain" id, so re-applying replaces only them. */
const fx = (type: PluginType, p: Partial<Record<string, number>>): Insert => ({ id: uid("chain"), type, on: true, params: { ...defaultParams(type), ...p } as Record<string, number> });
const comp = (p: Partial<Record<string, number>>) => fx("compressor", p);
const sat = (p: Partial<Record<string, number>>) => fx("saturator", p);

/**
 * Rock mix for the multitrack kit, the way an engineer would set up the session: per mic
 * subtractive EQ (box / mud / bleed), compression for punch (slow attack lets the stick through),
 * parallel saturation for density, a crushed + driven room, and on the drum bus a slow glue comp,
 * a parallel "smash" comp and light tape. Faders are calibrated so each mic keeps the measured
 * rock balance of the plain multitrack (kick/snare/toms/cymbals ratios). Toms get EQ but no
 * compression: their mics carry the whole kit, compression would pull the bleed up.
 */
export const KIT_MIX: Record<KitGroup, { ch: Partial<ChannelSettings>; inserts: () => Insert[] }> = {
  kick: {
    ch: { volumeDb: -5.5, hpf: 30, eqLow: 2, eqLowFreq: 60, eqMid: -5, eqMidFreq: 330, eqMidQ: 0.9, eqMid2: 4, eqMid2Freq: 3800, eqMid2Q: 1.1, eqHigh: -2, eqHighFreq: 10000 },
    inserts: () => [comp({ threshold: -20, ratio: 4, attack: 12, release: 60, makeup: 2.5, knee: 4 }), sat({ mode: 1, drive: 5, tone: 9000, mix: 40 })],
  },
  snare: {
    ch: { volumeDb: 2.1, hpf: 90, eqLow: 1.5, eqLowFreq: 200, eqMid: -3, eqMidFreq: 520, eqMidQ: 1.4, eqMid2: 4, eqMid2Freq: 5000, eqMid2Q: 0.9, eqHigh: 2, eqHighFreq: 10000, reverbSend: 0.16 },
    inserts: () => [comp({ threshold: -24, ratio: 4, attack: 5, release: 90, makeup: 3, knee: 4 }), sat({ mode: 2, drive: 8, tone: 9000, mix: 30 })],
  },
  toms: { ch: { volumeDb: -12.5, hpf: 70, eqMid: -4, eqMidFreq: 420, eqMidQ: 0.9, eqMid2: 3, eqMid2Freq: 4000, eqMid2Q: 1, reverbSend: 0.12 }, inserts: () => [] },
  hihat: { ch: { volumeDb: -7.8, hpf: 350, eqHigh: 1.5, eqHighFreq: 10000 }, inserts: () => [] },
  // The ride mic hears the whole kit (its bleed was half the 250–500 Hz mud): low and high-passed.
  ride: { ch: { volumeDb: -9, hpf: 500, eqHigh: 1.5, eqHighFreq: 9000 }, inserts: () => [] },
  overheads: {
    ch: { volumeDb: -8.6, hpf: 200, eqMid: -3, eqMidFreq: 420, eqMidQ: 1, eqHigh: 2.5, eqHighFreq: 11000 },
    inserts: () => [comp({ threshold: -16, ratio: 2, attack: 25, release: 150, makeup: 1, knee: 6 })],
  },
  room: {
    ch: { volumeDb: -12.6, hpf: 120, eqMid: -3, eqMidFreq: 300, eqMidQ: 1, eqHigh: -2, eqHighFreq: 7000 },
    inserts: () => [comp({ threshold: -30, ratio: 10, attack: 1, release: 50, makeup: 8, knee: 2 }), sat({ mode: 1, drive: 6, tone: 7000, mix: 100 })],
  },
};

/** Drum bus: slow glue → parallel smash (22 % wet) → light tape. */
export const busInserts = (): Insert[] => [
  comp({ threshold: -16, ratio: 2, attack: 30, release: 150, makeup: 1, knee: 6, detector: 1 }),
  comp({ threshold: -32, ratio: 10, attack: 1, release: 70, makeup: 10, knee: 2, mix: 22 }),
  sat({ mode: 1, drive: 3, tone: 16000, mix: 100 }),
];
/** Drum bus channel: gentle low-mid scoop; fader calibrated so the processed kit keeps the plain kit's loudness. */
export const BUS_CH: Partial<ChannelSettings> = { volumeDb: -7.3, eqMid: -3.5, eqMidFreq: 230, eqMidQ: 0.7, eqMid2: 2, eqMid2Freq: 4000, eqMid2Q: 0.8, eqHigh: 1.5, eqHighFreq: 10000 };

/** The kit's mic channels + drum bus for a mix style. */
export function kitStyle(style: MixStyle) {
  return style === "metal" ? { mics: METAL_KIT, bus: metalBusInserts, busCh: METAL_BUS_CH } : { mics: KIT_MIX, bus: busInserts, busCh: BUS_CH };
}

export function syncAuxTracks(p: Project): boolean {
  const owners = new Set(p.tracks.filter((t) => t.kind === "midi" && isMultiKit(t.instrument)).map((t) => t.id));
  const aux = p.tracks.filter((t) => t.kind === "aux");
  if (!owners.size && !aux.length) return false;
  const out: Track[] = [];
  for (const t of p.tracks) {
    if (t.kind === "aux") continue;
    out.push(t);
    if (!owners.has(t.id)) continue;
    const fresh = !aux.some((a) => a.auxOf === t.id);
    const style = kitStyle(t.mixStyle ?? (fresh ? DEFAULT_STYLE : "rock"));
    if (fresh && !(t.inserts ?? []).length) {
      t.mixStyle ??= DEFAULT_STYLE;
      t.mixVersion = MIX_VERSION[t.mixStyle];
      t.kitCymbalBleed = CYMBAL_BLEED[t.mixStyle];
      t.inserts = style.bus();
      Object.assign(t.ch, style.busCh);
      t.chain = t.instrument;
    }
    for (const g of KIT_GROUPS) {
      const existing = aux.find((a) => a.auxOf === t.id && a.auxOut === g);
      out.push(
        existing ?? {
          id: uid("aux"),
          name: `↳ ${KIT_GROUP_LABEL[g]}`,
          kind: "aux",
          role: "drums",
          color: t.color,
          clips: [],
          ch: { ...defaultChannel(), pan: PAN[g] ?? 0, ...style.mics[g].ch },
          inserts: style.mics[g].inserts(),
          auxOf: t.id,
          auxOut: g,
        },
      );
    }
  }
  const changed = out.length !== p.tracks.length || out.some((t, i) => t !== p.tracks[i]);
  if (changed) p.tracks = out;
  return changed;
}
