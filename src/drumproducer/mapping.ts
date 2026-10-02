/**
 * Note → drum voice mapping. GM is only a hypothesis: every pitch gets a rhythmic profile
 * (where it falls in the bar, how dense it is) and the GM reading is flagged when the profile
 * contradicts it. Pitches outside the GM drum range get a profile-based guess instead.
 */
import type { MappingRow, SrcNote, Voice } from "./types";

export const GM_DRUM_VOICE: Record<number, Voice> = {
  35: "kick", 36: "kick",
  37: "rim", 38: "snare", 40: "snare", 39: "clap",
  42: "hhc", 44: "hhp", 46: "hho",
  49: "crash", 52: "crash", 55: "crash", 57: "crash",
  51: "ride", 53: "ride", 59: "ride",
  41: "tomL", 43: "tomL", 45: "tomL", 47: "tomM", 48: "tomH", 50: "tomH",
  54: "shaker", 69: "shaker", 70: "shaker", 82: "shaker",
  56: "perc", 58: "perc", 60: "perc", 61: "perc", 62: "perc", 63: "perc", 64: "perc", 65: "perc", 66: "perc",
  67: "perc", 68: "perc", 71: "perc", 72: "perc", 73: "perc", 74: "perc", 75: "perc", 76: "perc", 77: "perc",
  78: "perc", 79: "perc", 80: "hhc", 81: "hho",
};

export const GM_NAME: Record<number, string> = {
  35: "acoustic bd", 36: "bass drum", 37: "side stick", 38: "snare", 39: "hand clap", 40: "electric snare",
  41: "low floor tom", 42: "closed hh", 43: "high floor tom", 44: "pedal hh", 45: "low tom", 46: "open hh",
  47: "low-mid tom", 48: "hi-mid tom", 49: "crash", 50: "high tom", 51: "ride", 52: "china", 53: "ride bell",
  54: "tambourine", 55: "splash", 56: "cowbell", 57: "crash 2", 59: "ride 2", 62: "mute hi conga", 63: "open hi conga",
  64: "low conga", 69: "cabasa", 70: "maracas", 75: "claves", 76: "hi wood block", 77: "low wood block", 82: "shaker",
};

type Profile = MappingRow["profile"];

interface PitchStats {
  count: number;
  perBar: number;
  onBeat13: number; // fraction on beats 1 & 3
  onBackbeat: number; // fraction on beats 2 & 4
  offGrid8: number; // fraction not on an 8th
}

function stats(notes: SrcNote[], bars: number): Map<number, PitchStats> {
  const by = new Map<number, SrcNote[]>();
  for (const n of notes) (by.get(n.pitch) ?? by.set(n.pitch, []).get(n.pitch)!).push(n);
  const out = new Map<number, PitchStats>();
  const near = (x: number, g: number) => Math.abs(x - Math.round(x / g) * g) < 0.07;
  for (const [p, ns] of by) {
    let b13 = 0, b24 = 0, off8 = 0;
    for (const n of ns) {
      const inBar = ((n.start % 4) + 4) % 4;
      const beat = Math.round(inBar);
      if (near(inBar, 1)) {
        if (beat % 2 === 0) b13++;
        else b24++;
      }
      if (!near(inBar, 0.5)) off8++;
    }
    out.set(p, { count: ns.length, perBar: ns.length / Math.max(1, bars), onBeat13: b13 / ns.length, onBackbeat: b24 / ns.length, offGrid8: off8 / ns.length });
  }
  return out;
}

function profileOf(s: PitchStats): Profile {
  if (s.count < 3) return "unknown";
  if (s.perBar >= 5) return "dense";
  if (s.onBeat13 >= 0.5 && s.onBackbeat < 0.25) return "kick-like";
  if (s.onBackbeat >= 0.55) return "backbeat-like";
  if (s.perBar <= 1.5) return "sparse";
  return "unknown";
}

const FAMILY: Record<Voice, "kick" | "back" | "hat" | "other"> = {
  kick: "kick", snare: "back", clap: "back", rim: "other", hhc: "hat", hhp: "hat", hho: "hat", ride: "hat", shaker: "hat",
  crash: "other", tomL: "other", tomM: "other", tomH: "other", perc: "other",
};

/** Is a GM reading contradicted by the rhythm? (Only strong contradictions count.) */
function contradicts(v: Voice, prof: Profile): boolean {
  const f = FAMILY[v];
  if (prof === "dense") return f === "kick" || f === "back";
  if (prof === "kick-like") return f === "hat" || f === "back";
  if (prof === "backbeat-like") return f === "kick";
  return false;
}

/**
 * Build the default mapping and its review table.
 * Existing user choices (`prev`) are kept; only unseen pitches get defaults.
 */
export function analyzeMapping(notes: SrcNote[], bars: number, prev: Record<string, Voice | "ignore"> = {}) {
  const st = stats(notes, bars);
  const pitches = [...st.keys()].sort((a, b) => a - b);
  const mapping: Record<string, Voice | "ignore"> = {};
  const rows: MappingRow[] = [];
  const nonGm = pitches.filter((p) => !(p in GM_DRUM_VOICE));
  // Profile guesses for pitches GM can't explain: strongest kick-like → kick, backbeat → clap/snare, densest → hat.
  const guess = new Map<number, Voice>();
  if (nonGm.length) {
    const pool = [...nonGm];
    const take = (score: (s: PitchStats) => number, v: Voice, min = 0.0001) => {
      let best = -1, bs = min;
      for (const p of pool) {
        const sc = score(st.get(p)!);
        if (sc > bs) { bs = sc; best = p; }
      }
      if (best >= 0) {
        guess.set(best, v);
        pool.splice(pool.indexOf(best), 1);
      }
    };
    take((s) => s.onBeat13 * (1 - s.onBackbeat) * Math.min(1, s.perBar / 2), "kick", 0.2);
    take((s) => s.onBackbeat * Math.min(1, s.perBar / 1.5), "snare", 0.3);
    take((s) => (s.perBar >= 3 ? s.perBar : 0), "hhc", 0);
    for (const p of pool) guess.set(p, "perc");
  }
  let review = false;
  for (const p of pitches) {
    const s = st.get(p)!;
    const prof = profileOf(s);
    const gm = GM_DRUM_VOICE[p] ?? null;
    let status: MappingRow["status"];
    let note: string;
    let def: Voice | "ignore";
    if (gm) {
      const bad = contradicts(gm, prof);
      status = bad ? "check" : "gm-ok";
      note = bad ? `GM says ${GM_NAME[p] ?? gm}, but the rhythm looks ${prof}` : `GM ${GM_NAME[p] ?? gm}${prof !== "unknown" ? ` · ${prof}` : ""}`;
      def = gm;
    } else {
      status = "guess";
      def = guess.get(p) ?? "perc";
      note = `not a GM drum note — guessed from rhythm (${prof})`;
    }
    const chosen = prev[String(p)] ?? def;
    if (chosen === "ignore") status = "ignored";
    if (status === "check" || status === "guess") review = true;
    mapping[String(p)] = chosen;
    rows.push({ pitch: p, count: s.count, gmVoice: gm, profile: prof, status, note });
  }
  return { mapping, rows, status: (pitches.length === 0 ? "empty" : review ? "needs-review" : "gm-consistent") as "empty" | "needs-review" | "gm-consistent" };
}
