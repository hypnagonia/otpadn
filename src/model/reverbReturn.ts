/**
 * The reverb return: a visible bus channel ("Reverb") that every channel's verb knob feeds —
 * airwindows Galactic 100 % wet, high-passed at 250 Hz by default (and gently low-passed), its
 * fader calibrated to the built-in reverb it replaces (+5 dB ≈ that path's trim). Created for any
 * project with tracks; if the user deletes it, it stays gone (verb falls back to the built-in).
 */
import { defaultParams } from "../plugins/defs";
import { defaultChannel, uid, type Project, type Track } from "./types";

export const REVERB_RETURN_PARAMS = { replace: 0.62, brightness: 0.45, detune: 0.35, bigness: 0.38, mix: 1 };

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
