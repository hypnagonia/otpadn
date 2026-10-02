/**
 * Every instrument (sampled or synthesised) exposes this minimal interface so
 * the engine and the offline renderer can treat them identically.
 */
export interface Playable {
  ready: Promise<void>;
  /** Schedules a note; returns a release function (for live input) when the source supports it. */
  start(ev: { note: number; time: number; duration: number; velocity: number; slide?: import("../model/types").NoteSlide }): ((at?: number) => void) | void;
  stopAll(): void;
  /** Multi-out instruments: route named outputs (e.g. kit mic groups) to track inputs. */
  setOutputs?(dests: Record<string, AudioNode>, fallback: AudioNode): void;
  /** Optional per-track settings (e.g. a drum kit config stored on the track). */
  configure?(cfg: unknown): void;
  /** Multitrack kits: one-shot layers triggered with a piece (slot → buffer + level in dB). */
  setLayers?(layers: Partial<Record<string, { buffer: AudioBuffer; level: number }>>): void;
  /** Multitrack kits: level (dB) of drum hits (kick/snare/toms) in the cymbal mics; ≤ −60 = none. */
  setCymbalBleed?(db: number): void;
  dispose(): void;
}

export interface InstrumentDef {
  id: string;
  name: string;
  category: string;
  /** Approx. download size hint for the UI. */
  size: string;
}
