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
}

export interface AudioClip {
  id: string;
  kind: "audio";
  start: number; // beats (timeline position)
  bufferId: string;
  offset: number; // seconds into the buffer
  duration: number; // seconds
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

export const ROLE_COLORS: Record<Role, string> = {
  mix: "#8a8f98",
  drums: "#e0a43a",
  bass: "#d9534f",
  vocals: "#4aa3df",
  other: "#57b26a",
  guitar: "#e07b39",
  piano: "#d7d2c4",
  lead: "#a66cd9",
  keys: "#e2c440",
  pad: "#3fbfb4",
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let idCounter = 0;
export const uid = (p = "id") => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
