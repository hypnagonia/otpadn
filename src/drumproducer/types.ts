/**
 * Drum Producer: data model. Everything a session needs to be re-derived deterministically
 * (source snapshot, mapping, parameters, seeds, locks) lives in the project, so undo/redo,
 * autosave and reload work through the normal store. Derived results (proposals, variants)
 * are recomputed in a worker from these inputs and never stored as the source of truth.
 */

/** Bumped whenever the pipeline output for identical inputs could change. Stored with every result. */
export const DP_ALGO_VERSION = "dp-1.0.0";

export type Voice =
  | "kick" | "snare" | "clap" | "rim"
  | "hhc" | "hhp" | "hho" | "ride" | "shaker"
  | "crash" | "tomL" | "tomM" | "tomH" | "perc";

/** Generation layers. "phrase" = fills / variations / drops on top of the other three. */
export type Layer = "foundation" | "motion" | "perc" | "phrase";
export const LAYERS: Layer[] = ["foundation", "motion", "perc", "phrase"];
export const LAYER_LABEL: Record<Layer, string> = { foundation: "foundation", motion: "motion", perc: "accents/perc", phrase: "phrase/fills" };

/** Output tracks after apply (separate mixer channels ≈ separate instrument outputs). */
export type Output = "kick" | "backbeat" | "hats" | "perc";
export const OUTPUTS: Output[] = ["kick", "backbeat", "hats", "perc"];
export const OUTPUT_LABEL: Record<Output, string> = { kick: "kick", backbeat: "snare/clap", hats: "hats/ride", perc: "perc/toms" };

export interface VoiceInfo {
  label: string;
  gm: number; // MIDI pitch written to output clips
  layer: Exclude<Layer, "phrase">;
  out: Output;
  color: string;
}

export const VOICE_INFO: Record<Voice, VoiceInfo> = {
  kick: { label: "kick", gm: 36, layer: "foundation", out: "kick", color: "#e0a43a" },
  snare: { label: "snare", gm: 38, layer: "foundation", out: "backbeat", color: "#d9534f" },
  clap: { label: "clap", gm: 39, layer: "foundation", out: "backbeat", color: "#e07b39" },
  rim: { label: "rim", gm: 37, layer: "perc", out: "perc", color: "#a66cd9" },
  hhc: { label: "hat closed", gm: 42, layer: "motion", out: "hats", color: "#4aa3df" },
  hhp: { label: "hat pedal", gm: 44, layer: "motion", out: "hats", color: "#3f8fc4" },
  hho: { label: "hat open", gm: 46, layer: "motion", out: "hats", color: "#3fbfb4" },
  ride: { label: "ride", gm: 51, layer: "motion", out: "hats", color: "#57b26a" },
  shaker: { label: "shaker", gm: 70, layer: "motion", out: "hats", color: "#8fc46a" },
  crash: { label: "crash", gm: 49, layer: "perc", out: "perc", color: "#e2c440" },
  tomL: { label: "tom low", gm: 45, layer: "perc", out: "perc", color: "#b0856a" },
  tomM: { label: "tom mid", gm: 47, layer: "perc", out: "perc", color: "#c0956a" },
  tomH: { label: "tom high", gm: 50, layer: "perc", out: "perc", color: "#d0a56a" },
  perc: { label: "perc", gm: 63, layer: "perc", out: "perc", color: "#c46aa8" },
};
export const VOICES = Object.keys(VOICE_INFO) as Voice[];
export const voicesOfLayer = (l: Layer) => VOICES.filter((v) => VOICE_INFO[v].layer === l);

export type Style = "house" | "techno" | "rock";

/** Where an event came from / what changed it. Shown in the UI and kept on the event. */
export type Origin =
  | "source" // untouched source event (may still carry micro-timing)
  | "moved" // source event, position quantized
  | "velocity" // source event, velocity corrected
  | "added" // cleanup: probable missed hit
  | "generated" // rework: from the style pattern
  | "fill"; // rework: phrase development (fill / variation / drop)

export interface DEvent {
  id: string;
  voice: Voice;
  /** Musical (grid) position, beats from region start. */
  start: number;
  /** Micro-timing offset, beats. Played time = start + micro. */
  micro: number;
  vel: number;
  dur: number;
  origin: Origin;
  layer: Layer;
  /** Original values of a source event (position in beats, MIDI pitch, velocity, index into source.notes). */
  src?: { start: number; pitch: number; vel: number; idx: number };
  locked?: boolean;
  /** Recognition confidence 0..1, only when the source provided a measured value. */
  conf?: number;
  /** Our own plausibility heuristic 0..1 — NOT a probability; labelled "heuristic" in the UI. */
  heur?: number;
  tags?: string[];
}

export interface SrcNote {
  pitch: number;
  start: number; // beats from region start
  dur: number;
  vel: number;
  conf?: number;
  trackId: string;
  clipId: string;
}

export type GridChoice = "auto" | "straight" | "triplet" | "mixed";

export interface CleanParams {
  on: boolean;
  /** Soft-quantize strength 0..1. */
  strength: number;
  grid: GridChoice;
  /** User overrides of proposal defaults, by proposal id. */
  decisions: Record<string, boolean>;
}

export interface ReworkParams {
  on: boolean;
  style: Style;
  /** 0 = free, 1 = keep every source event. */
  preserve: number;
  /** 0..1: pattern intensity / accent level / fill intensity (not density). */
  energy: number;
  variant: 0 | 1 | 2;
  /** Output length: the source region, or an explicit extension. */
  length: "source" | 8 | 16;
  /** Allow generating a layer that is empty in the source (explicit user choice). */
  addLayers: Partial<Record<Layer, boolean>>;
}

export interface GrooveParams {
  on: boolean;
  /** −1..1 → ×0.5..×2 of the source event count per layer. 0 = keep source density. */
  density: number;
  /** 0..1 → 16th swing 50%..75%. */
  swing: number;
  /** 0..1 accent depth. */
  accent: number;
  /** 0..1 micro-timing amount (0.5 = style default). */
  micro: number;
  /** 0..1 how often phrase ends get a fill / drop. */
  fills: number;
}

export interface VoiceSettings {
  on: boolean;
  level: number; // dB
  pan: number; // −1..1
  tune: number; // semitones
  attack: number; // 0..1 transient / click amount
  decay: number; // ×, 0.2..2
  tone: number; // 0..1 brightness
}

export type KickModel = "909" | "808" | "tight";
export type PercModel = "conga" | "cowbell" | "block";

export interface KitConfig {
  kitId: string;
  kick: KickModel;
  percModel: PercModel;
  /** 0..1 metallic (oscillator) vs noise hats. */
  metal: number;
  /** Kick waveshaper drive 0..1. */
  drive: number;
  voices: Record<Voice, VoiceSettings>;
}

export interface OutputProc {
  level: number; // fader dB
  eq: { on: boolean; hpf: number; low: number; high: number };
  sat: { on: boolean; drive: number };
  comp: { on: boolean; threshold: number; ratio: number; attack: number };
  send: { on: boolean; amount: number };
}

export interface SoundParams {
  on: boolean;
  kit: KitConfig;
  outputs: Record<Output, OutputProc>;
  /** Re-pick kit + processing automatically when the result changes. */
  auto: boolean;
}

export interface DrumSession {
  id: string;
  algo: string;
  created: number;
  source: {
    name: string;
    trackIds: string[];
    clipIds: string[];
    start: number; // absolute beats
    length: number; // beats
    bpm: number;
    notes: SrcNote[];
  };
  /** Source pitch → voice ("ignore" drops it). Keys are stringified pitches. */
  mapping: Record<string, Voice | "ignore">;
  mappingConfirmed: boolean;
  clean: CleanParams;
  rework: ReworkParams;
  groove: GrooveParams;
  sound: SoundParams;
  seed: number;
  layerSeeds: Record<Layer, number>;
  locks: { voices: Voice[]; events: DEvent[] };
  muteSourceOnApply: boolean;
  applied?: {
    tracks: Partial<Record<Output, string>>;
    at: number;
    variant: number;
    seed: number;
    layerSeeds: Record<Layer, number>;
    algo: string;
    mutedSource: string[];
  };
}

/* ── pipeline results (derived, not persisted) ── */

export type GridDecision = "straight" | "triplet" | "mixed" | "ambiguous" | "none";

export interface MappingRow {
  pitch: number;
  count: number;
  gmVoice: Voice | null;
  profile: "kick-like" | "backbeat-like" | "dense" | "sparse" | "unknown";
  status: "gm-ok" | "check" | "guess" | "ignored";
  note: string;
}

export interface Analysis {
  bars: number;
  completeBars: number;
  partialBeats: number;
  events: number;
  grid: {
    decision: GridDecision;
    straightVotes: number;
    tripletVotes: number;
    swingOrTripletVotes: number;
    tripletBeats: number[];
    note: string;
  };
  /** Detected 16th swing (0.5 = straight), null if not measurable. */
  swing: number | null;
  density: Record<Exclude<Layer, "phrase">, number>; // events per complete bar
  phraseBars: 0 | 4 | 8 | 16;
  structure: boolean;
  mapping: MappingRow[];
  mappingStatus: "gm-consistent" | "needs-review" | "empty";
  warnings: string[];
}

export type ProposalKind = "remove" | "move" | "velocity" | "add" | "quantize";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  voice: Voice | null;
  eventIds: string[];
  at: number; // beats
  to?: number;
  vel?: number;
  reason: string;
  /** Heuristic plausibility 0..1 (not a probability). */
  heur: number;
  def: boolean;
  accepted: boolean;
}

export interface Variant {
  name: string;
  events: DEvent[];
  /** Source events that are not in this variant (for display). */
  dropped: DEvent[];
  stats: { events: number; kept: number; generated: number; fills: number; perBar: number; patterns: Partial<Record<Layer, string>> };
}

export interface PipelineResult {
  algo: string;
  analysis: Analysis;
  sourceEvents: DEvent[];
  proposals: Proposal[];
  cleaned: DEvent[];
  cleanedDropped: DEvent[];
  variants: Variant[];
  chosen: number;
  /** Chosen variant with groove applied: what gets auditioned and applied. */
  final: DEvent[];
  lengthBeats: number;
  sound: { kit: KitConfig; outputs: Record<Output, OutputProc>; notes: string[] };
}
