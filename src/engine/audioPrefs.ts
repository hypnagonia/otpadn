/**
 * Audio buffer size (like a DAW's "buffer size" setting), per browser. "safe" = larger output
 * buffer: no crackle/dropouts on heavy projects (multitrack kits, many tracks). "low" = smallest
 * buffer: for recording / live keyboard playing, but can crackle when the project is heavy.
 * An AudioContext's buffer is fixed at creation, so a change applies after a reload.
 */
export type BufferPref = "safe" | "low";
const KEY = "otpadn.audioBuffer";

export function bufferPref(): BufferPref {
  try {
    return localStorage.getItem(KEY) === "low" ? "low" : "safe";
  } catch {
    return "safe";
  }
}

export function setBufferPref(p: BufferPref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* storage blocked: stays at the default */
  }
}

export const latencyHint = (): AudioContextLatencyCategory => (bufferPref() === "low" ? "interactive" : "playback");
