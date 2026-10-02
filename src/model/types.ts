import type { DrumSession, KitConfig, Output } from "../drumproducer/types";
import type { PartSession } from "../partproducer/types";
import type { Insert } from "../plugins/defs";

export type Role =
  | "mix"
  | "drums"
  | "bass"
  | "vocals"
  | "other"
  | "guitar"
  | "piano"
  | "lead"
  | "keys"
  | "pad";

export interface Note {
  pitch: number; // MIDI note number
  start: number; // beats, relative to clip start
  dur: number; // beats
  vel: number; // 1..127
  /** Recognition confidence 0..1 — only set when a transcriber measured one. */
  conf?: number;
  /** Player slides: glide in from `from` semitones away over `fromTime` s; fall `fall` semitones over the last `fallTime` s. */
  slide?: NoteSlide;
}

export interface NoteSlide { from?: number; fromTime?: number; fall?: number; fallTime?: number }

export interface AudioClip {
  id: string;
  kind: "audio";
  start: number; // beats (timeline position)
  bufferId: string;
  offset: number; // seconds into the buffer
  duration: number; // seconds
  /** Fades (seconds, equal-power) and clip gain (dB). Overlapping clips crossfade automatically. */
  fadeIn?: number;
  fadeOut?: number;
  gain?: number;
}

export interface MidiClip {
  id: string;
  kind: "midi";
  start: number; // beats
  length: number; // beats
  notes: Note[];
  /** Transcribed from audio: keeps its position in *seconds* when the tempo changes (like the audio). */
  anchored?: boolean;
}

export type Clip = AudioClip | MidiClip;

/** A send from a channel to a bus track (FX return). */
export interface Send {
  id: string;
  bus: string; // bus track id
  level: number; // dB, -60..+6
  pre: boolean; // tap before the fader
}

export interface ChannelSettings {
  volumeDb: number;
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  /* 6-band channel EQ: HPF · low shelf · bell 1 · bell 2 · high shelf · LPF */
  hpf: number; // Hz, 0 = off
  eqLow: number; // dB
  eqLowFreq: number;
  eqMid: number; // dB
  eqMidFreq: number;
  eqMidQ: number;
  eqMid2: number; // dB
  eqMid2Freq: number;
  eqMid2Q: number;
  eqHigh: number; // dB
  eqHighFreq: number;
  lpf: number; // Hz, 0 = off
  compOn: boolean;
  compThreshold: number; // dB
  compRatio: number;
  reverbSend: number; // 0..1
  /** Sends to bus (return) tracks. */
  sends?: Send[];
}

export type KitLayerSlot = "kick" | "snare";

/** One automation breakpoint: position in beats, value in the parameter's own units. */
export interface AutoPoint { beat: number; value: number }
/**
 * An automation lane. param: "volume" (dB) | "pan" (−1…1) | "verb" (0…1 reverb send) |
 * "send:<sendId>" (dB) | "ins:<insertId>:<paramKey>" (the plug-in parameter's units).
 */
export interface AutoLane { param: string; points: AutoPoint[] }

/** A channel group (Logic / Pro Tools style): members' linked controls move together. */
export interface ChannelGroup {
  id: string;
  name: string;
  color: string;
  /** What moves together: volume is relative (dB offsets kept), mute / solo absolute, pan relative. */
  link: { volume: boolean; mute: boolean; solo: boolean; pan: boolean };
}

export interface Track {
  id: string;
  name: string;
  /** "aux": an output of a multi-out instrument (e.g. a kit's Kick/Snare/OH mics); no clips. */
  kind: "audio" | "midi" | "aux" | "bus";
  role: Role;
  /** aux tracks: the instrument track they belong to, and which of its outputs they carry. */
  auxOf?: string;
  auxOut?: string;
  color: string;
  instrument?: string; // instrument catalog id, MIDI tracks only
  clips: Clip[];
  ch: ChannelSettings;
  /** Insert plugins, top → bottom (after the channel EQ, before the fader). */
  inserts: Insert[];
  /** Drum synth settings (dpkit instruments), applied to the instrument on every sync. */
  drumKit?: KitConfig;
  /** Track produced by a Drum Producer session. */
  dp?: { sessionId: string; output: Output };
  /** Track produced by a Part Producer session. */
  pp?: { sessionId: string };
  /** Instrument id whose pro-mix chain (model/chains.ts) this channel was set up for. */
  chain?: string;
  /**
   * Multitrack kit sample layers (sample reinforcement, like a trigger plug-in): a one-shot played
   * with every kick / snare hit into that mic group's channel. `level` in dB; audio via buffers.
   */
  kitLayers?: Partial<Record<KitLayerSlot, { bufferId: string; name: string; level: number }>>;
  /** Multitrack kits: drum hits in the cymbal mics, dB (unset = 0, natural bleed). */
  kitCymbalBleed?: number;
  /**
   * Frozen (Logic-style): instrument + EQ + inserts (+ kit mics and bus) rendered to audio; the
   * track plays that buffer from beat 0 straight into its fader. `sig` detects later edits.
   */
  frozen?: { bufferId: string; sig: string };
  /** Channel group id (project.groups). */
  group?: string;
  /** The project's reverb return (a bus): every channel's "verb" knob sends here. */
  reverbReturn?: boolean;
  /** Automation lanes (engine/automation.ts). */
  automation?: AutoLane[];
  /** Which lane the arrange view shows/edits in automation view. */
  autoView?: string;
  /** MIX_VERSION of the style when the chain was applied (older → the inspector offers an update). */
  mixVersion?: number;
  /** Mix style of that chain (model/mixStyles.ts); unset on older tracks = "rock". */
  mixStyle?: import("./mixStyles").MixStyle;
}

export interface Section {
  start: number; // beats
  length: number; // beats
  label: string; // Intro / Verse / Chorus ...
  group: string; // A, B, C... (same material)
  energy: number; // 0..3
}

export interface ChordSpan {
  start: number; // beats
  length: number;
  root: number; // pitch class 0..11
  minor: boolean;
}

export interface Project {
  name: string;
  bpm: number;
  key: { tonic: number; minor: boolean } | null;
  sections: Section[];
  chords: ChordSpan[];
  tracks: Track[];
  /** The user deleted the reverb return: don't recreate it (verb knobs use the built-in reverb). */
  noReverbReturn?: boolean;
  /** Channel groups (edit/groups.ts). */
  groups?: ChannelGroup[];
  masterDb: number;
  /** Master bus inserts (before glue comp + limiter). */
  masterInserts: Insert[];
  loop: { on: boolean; start: number; end: number };
  lengthBeats: number;
  /** Drum Producer sessions (inputs, seeds, locks; results are re-derived deterministically). */
  drumSessions?: Record<string, DrumSession>;
  /** Part Producer sessions (keys / vocal line / guitar). */
  partSessions?: Record<string, PartSession>;
}

export const defaultChannel = (): ChannelSettings => ({
  volumeDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  hpf: 0,
  eqLow: 0,
  eqLowFreq: 100,
  eqMid: 0,
  eqMidFreq: 400,
  eqMidQ: 1,
  eqMid2: 0,
  eqMid2Freq: 2500,
  eqMid2Q: 1,
  eqHigh: 0,
  eqHighFreq: 8000,
  lpf: 0,
  compOn: false,
  compThreshold: -18,
  compRatio: 3,
  reverbSend: 0,
});

/** Track colours: mid-light, softly saturated (regions draw dark ink on them), distinct on charcoal. */
export const ROLE_COLORS: Record<Role, string> = {
  mix: "#9aa3b2",
  drums: "#f2b84b",
  bass: "#ef6f6c",
  vocals: "#6cb7f5",
  other: "#7cc68a",
  guitar: "#f5925c",
  piano: "#e8dcc2",
  lead: "#b48cf2",
  keys: "#f28cc2",
  pad: "#5cc9c0",
};
/** Previous default palette → current (sessions saved with the old defaults pick up the new ones). */
export const OLD_ROLE_COLORS: Record<string, string> = {
  "#8a8f98": "#9aa3b2", "#e0a43a": "#f2b84b", "#d9534f": "#ef6f6c", "#4aa3df": "#6cb7f5", "#57b26a": "#7cc68a",
  "#e07b39": "#f5925c", "#d7d2c4": "#e8dcc2", "#a66cd9": "#b48cf2", "#e2c440": "#f28cc2", "#3fbfb4": "#5cc9c0", "#7d8fb3": "#8fa3d6",
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let idCounter = 0;
export const uid = (p = "id") => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
