/**
 * Keeps multi-out instruments' output tracks in sync with the project: every MIDI track playing
 * a multitrack kit gets one aux track per mic group right below it (reused if it exists); aux
 * tracks whose owner is gone or changed instrument disappear. Runs after every project change.
 */
import { isMultiKit, KIT_GROUP_LABEL, KIT_GROUPS, type KitGroup } from "../instruments/multikit";
import { defaultParams, type Insert } from "../plugins/defs";
import { defaultChannel, uid, type ChannelSettings, type Project, type Track } from "./types";

/** Starting pans for the mono mic groups (drummer's perspective); stereo groups are pre-panned. */
const PAN: Partial<Record<KitGroup, number>> = { hihat: -0.3, ride: 0.35 };

const comp = (p: Partial<Record<string, number>>): Insert => ({ id: uid("ins"), type: "compressor", on: true, params: { ...defaultParams("compressor"), ...p } as Record<string, number> });

/**
 * "Almost mixed" starting point for the multitrack kit. Fader levels come from measuring each mic
 * group's loudness in the actual samples (balanced to typical rock ratios against the snare close
 * mic); compressor makeup matches its typical reduction. Toms are left untouched on purpose.
 */
const KIT_MIX: Record<KitGroup, { ch: Partial<ChannelSettings>; inserts: () => Insert[] }> = {
  kick: {
    ch: { volumeDb: -4.5, hpf: 35, eqLow: -1.5, eqLowFreq: 45, eqMid: -6, eqMidFreq: 260, eqMidQ: 0.7, eqMid2: 4, eqMid2Freq: 4000, eqMid2Q: 1 },
    inserts: () => [comp({ threshold: -20, ratio: 4, attack: 8, release: 70, makeup: 2, knee: 4 })],
  },
  snare: {
    ch: { volumeDb: 1, hpf: 100, eqLow: -2, eqLowFreq: 150, eqMid: -3, eqMidFreq: 450, eqMidQ: 1.2, eqMid2: 4, eqMid2Freq: 4500, eqMid2Q: 0.9, eqHigh: 2, eqHighFreq: 10000, reverbSend: 0.14 },
    inserts: () => [comp({ threshold: -22, ratio: 3.5, attack: 4, release: 90, makeup: 1.5, knee: 4 })],
  },
  toms: { ch: { volumeDb: -11.6 }, inserts: () => [] }, // untouched on purpose (no EQ / gate / comp)
  hihat: { ch: { volumeDb: -5, hpf: 400, eqHigh: 2, eqHighFreq: 9000 }, inserts: () => [] },
  // The ride mic hears the whole kit (its bleed was half the 250–500 Hz mud): low and high-passed.
  ride: { ch: { volumeDb: -6, hpf: 500, eqHigh: 1.5, eqHighFreq: 9000 }, inserts: () => [] },
  overheads: {
    ch: { volumeDb: -8, hpf: 250, eqMid: -3, eqMidFreq: 400, eqMidQ: 1, eqHigh: 3, eqHighFreq: 10000 },
    inserts: () => [comp({ threshold: -16, ratio: 2, attack: 20, release: 150, makeup: 1, knee: 6 })],
  },
  room: {
    ch: { volumeDb: -10, hpf: 150, eqMid: -3, eqMidFreq: 300, eqMidQ: 1, eqHigh: -1, eqHighFreq: 8000 },
    inserts: () => [comp({ threshold: -28, ratio: 8, attack: 2, release: 60, makeup: 6, knee: 2 })],
  },
};

/** Drum bus glue, added to the kit's main track the first time its outputs are created. */
const busInserts = (): Insert[] => [comp({ threshold: -16, ratio: 2, attack: 30, release: 200, makeup: 0, knee: 6, detector: 1 })];
/** Drum bus channel: headroom for the rest of the mix (peaks ≈ −5 dBTP) and a gentle low-mid scoop. */
const BUS_CH: Partial<ChannelSettings> = { volumeDb: -5, eqMid: -3.5, eqMidFreq: 230, eqMidQ: 0.7, eqMid2: 2, eqMid2Freq: 4000, eqMid2Q: 0.8, eqHigh: 1.5, eqHighFreq: 10000 };

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
    if (fresh && !(t.inserts ?? []).length) {
      t.inserts = busInserts();
      Object.assign(t.ch, BUS_CH);
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
          ch: { ...defaultChannel(), pan: PAN[g] ?? 0, ...KIT_MIX[g].ch },
          inserts: KIT_MIX[g].inserts(),
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
