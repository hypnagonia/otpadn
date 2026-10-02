/**
 * The reverb return: a visible bus channel ("Reverb") that every channel's verb knob feeds —
 * airwindows Galactic 100 % wet, high-passed at 250 Hz by default (and gently low-passed), its
 * fader calibrated to the built-in reverb it replaces (+5 dB ≈ that path's trim). Created for any
 * project with tracks; if the user deletes it, it stays gone (verb falls back to the built-in).
 */
import { defaultParams } from "../plugins/defs";
import { defaultChannel, uid, type Project, type Track } from "./types";

export const REVERB_RETURN_PARAMS = { replace: 0.62, brightness: 0.45, detune: 0.35, bigness: 0.38, mix: 1 };

/**
 * The delay return: a "Delay" bus fed by every channel's dly knob — tempo-synced ping-pong delay,
 * 100 % wet, high-passed at 300 Hz and low-passed at 7 kHz so echoes stay out of the low end.
 */
export function syncDelayReturn(p: Project): boolean {
  if (p.noDelayReturn || p.tracks.some((t) => t.delayReturn)) return false;
  if (!p.tracks.some((t) => t.kind !== "bus")) return false;
  const t: Track = {
    id: uid("trk"),
    name: "Delay",
    kind: "bus",
    role: "other",
    color: "#7cc68a",
    clips: [],
    ch: { ...defaultChannel(), volumeDb: 0, hpf: 300, lpf: 7000, reverbSend: 0.15, delaySend: 0 },
    inserts: [{ id: uid("ins"), type: "delay", on: true, params: { ...defaultParams("delay"), div: 2, mix: 100, feedback: 32, pingpong: 1 } }], // 1/8 dotted
    delayReturn: true,
  };
  p.tracks.push(t);
  return true;
}

export function syncReverbReturn(p: Project): boolean {
  if (p.noReverbReturn || p.tracks.some((t) => t.reverbReturn)) return false;
  if (!p.tracks.some((t) => t.kind !== "bus")) return false;
  const t: Track = {
    id: uid("trk"),
    name: "Reverb",
    kind: "bus",
    role: "other",
    color: "#8fa3d6",
    clips: [],
    ch: { ...defaultChannel(), volumeDb: 5, hpf: 250, lpf: 12000, reverbSend: 0 },
    inserts: [{ id: uid("ins"), type: "galactic", on: true, params: { ...defaultParams("galactic"), ...REVERB_RETURN_PARAMS } }],
    reverbReturn: true,
  };
  p.tracks.push(t);
  return true;
}
