/**
 * Part Producer: dirty pitched MIDI (keys, a vocal/lead line, guitar) → clean, reworked, playable
 * parts. Like the Drum Producer, the project stores only inputs (source snapshot, harmony overrides,
 * parameters, seeds, locks); results are re-derived deterministically in a worker.
 */

export const PP_ALGO_VERSION = "pp-1.0.0";

export type Mode = "keys" | "line" | "guitar" | "bass";
export const MODE_LABEL: Record<Mode, string> = { keys: "keys", line: "vocal / lead line", guitar: "guitar", bass: "bass" };

export type KeysStyle = "comp" | "stabs" | "pad" | "arp";
export type LineStyle = "faithful" | "tight" | "hook";
export type GuitarStyle = "faithful" | "strum" | "fingerpick" | "power";
export type BassStyle = "faithful" | "roots" | "kick" | "octaves";
export type Style = KeysStyle | LineStyle | GuitarStyle | BassStyle;

export const STYLES_FOR: Record<Mode, { id: Style; label: string; desc: string }[]> = {
  keys: [
    { id: "comp", label: "comp", desc: "your rhythm, re-voiced chords with smooth voice leading" },
    { id: "stabs", label: "house stabs", desc: "short syncopated 7th/9th stabs, offbeat pushes" },
    { id: "pad", label: "pad", desc: "sustained voice-led chords, one per chord change" },
    { id: "arp", label: "arp", desc: "16th arpeggios over the chord, pattern by seed" },
  ],
  line: [
    { id: "faithful", label: "faithful", desc: "fix transcription errors only, keep the phrasing" },
    { id: "tight", label: "tight", desc: "tighter timing, legato, in-key, consistent repeats" },
    { id: "hook", label: "hook", desc: "simplified: ornaments merged, repeats unified, held notes" },
  ],
  guitar: [
    { id: "faithful", label: "faithful", desc: "your part, made playable on six strings" },
    { id: "strum", label: "strum", desc: "strummed shapes, down/up strokes with real string spread" },
    { id: "fingerpick", label: "fingerpick", desc: "alternating bass + treble picking (Travis-style)" },
    { id: "power", label: "power", desc: "power chords, palm-muted 8ths with open accents" },
  ],
  bass: [
    { id: "faithful", label: "faithful", desc: "your line: one note at a time, in bass range, rests only where they mean something" },
    { id: "roots", label: "roots", desc: "driving 8ths on the chord roots, approach notes into chord changes" },
    { id: "kick", label: "lock to kick", desc: "notes on your drum track's kicks — the bass breathes with the kick" },
    { id: "octaves", label: "octaves", desc: "house / disco off-beat octaves on the roots" },
  ],
};

export const DEFAULT_STYLE: Record<Mode, Style> = { keys: "comp", line: "tight", guitar: "strum", bass: "faithful" };

export type Quality = "maj" | "min" | "7" | "maj7" | "m7" | "sus2" | "sus4" | "dim";
export const QUALITY_IV: Record<Quality, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6],
};
export const QUALITY_LABEL: Record<Quality, string> = { maj: "", min: "m", "7": "7", maj7: "maj7", m7: "m7", sus2: "sus2", sus4: "sus4", dim: "°" };
export const NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const chordName = (root: number, q: Quality) => `${NOTE[root]}${QUALITY_LABEL[q]}`;

export interface Chord {
  start: number; // beats from region start
  length: number;
  root: number; // pitch class
  q: Quality;
  /** Heuristic fit 0..1 (not a probability). */
  fit: number;
  /** Ranked alternatives (click a chord to cycle). */
  alts: { root: number; q: Quality }[];
  from: "notes" | "project" | "user";
}

export type Origin = "source" | "moved" | "edited" | "added" | "generated" | "fill";

export interface PEvent {
  id: string;
  pitch: number;
  start: number; // musical position, beats from region start
  micro: number; // timing offset, beats
  dur: number;
  vel: number;
  origin: Origin;
  src?: { start: number; pitch: number; dur: number; vel: number; idx: number };
  locked?: boolean;
  conf?: number; // measured, from the source only
  heur?: number; // own heuristic, labelled as such
  tags?: string[];
  /** Guitar: string 0 (low E) … 5 (high E). */
  string?: number;
}

export interface SrcNote {
  pitch: number;
  start: number;
  dur: number;
  vel: number;
  conf?: number;
  trackId: string;
  clipId: string;
}

export type GridChoice = "auto" | "straight" | "triplet" | "mixed";

export interface PartSession {
  id: string;
  algo: string;
  created: number;
  mode: Mode;
  source: { name: string; trackIds: string[]; clipIds: string[]; start: number; length: number; bpm: number; notes: SrcNote[]; role: string; instrument?: string };
  harmony: {
    /** Where chords come from: the project's chord track (from audio analysis) or the notes themselves. */
    source: "auto" | "project" | "notes";
    key: { tonic: number; minor: boolean } | null; // null = detect
    chordOverrides: Record<string, { root: number; q: Quality }>; // key = start beat
  };
  clean: { on: boolean; strength: number; grid: GridChoice; decisions: Record<string, boolean> };
  rework: { on: boolean; style: Style; preserve: number; variant: 0 | 1 | 2; length: "source" | 8 | 16 };
  groove: { on: boolean; swing: number; accent: number; feel: number; spread: number; variation: number };
  sound: { on: boolean; auto: boolean; instrument: string; proc: Proc };
  seed: number;
  layerSeeds: { rhythm: number; voicing: number; phrase: number };
  locks: { events: PEvent[] };
  muteSourceOnApply: boolean;
  applied?: { trackId: string; at: number; variant: number; seed: number; algo: string; mutedSource: string[] };
}

export interface Proc {
  level: number;
  eq: { on: boolean; hpf: number; low: number; high: number; lpf: number };
  comp: { on: boolean; threshold: number; ratio: number; attack: number };
  delay: { on: boolean; div: number; feedback: number; mix: number };
  send: { on: boolean; amount: number };
}

export type ProposalKind = "remove" | "merge" | "pitch" | "trim" | "quantize" | "octave";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  eventIds: string[];
  at: number;
  pitch?: number;
  reason: string;
  heur: number;
  def: boolean;
  accepted: boolean;
}

export interface Variant {
  name: string;
  events: PEvent[];
  dropped: PEvent[];
  stats: { notes: number; kept: number; generated: number; changed: number; pattern?: string };
}

export interface Analysis {
  bars: number;
  completeBars: number;
  partialBeats: number;
  key: { tonic: number; minor: boolean };
  keyFrom: "user" | "project" | "notes";
  chordsFrom: "project" | "notes" | "none";
  grid: { decision: string; note: string };
  range: [number, number];
  polyphony: number; // mean simultaneous notes at onsets
  /** Guitar: how the source is played (strummed share, directions, spread). */
  strum?: { strummed: number; down: number; up: number; spreadMs: number; hits: number };
  warnings: string[];
}

export interface PipelineResult {
  algo: string;
  analysis: Analysis;
  chords: Chord[];
  sourceEvents: PEvent[];
  proposals: Proposal[];
  cleaned: PEvent[];
  cleanedDropped: PEvent[];
  variants: Variant[];
  chosen: number;
  final: PEvent[];
  lengthBeats: number;
  sound: { instrument: string; proc: Proc; notes: string[] };
}
