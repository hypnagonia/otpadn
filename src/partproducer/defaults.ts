/** Fresh session state for a captured pitched part. */
import { PICK } from "./sound";
import { DEFAULT_STYLE, PP_ALGO_VERSION, type Mode, type PartSession } from "./types";

export const modeForRole = (role: string): Mode => (role === "bass" ? "bass" : role === "vocals" || role === "lead" ? "line" : role === "guitar" ? "guitar" : "keys");

export function defaultPartSession(id: string, mode: Mode, source: PartSession["source"], seed: number): PartSession {
  const style = DEFAULT_STYLE[mode];
  const pick = PICK[`${mode}:${style}`];
  return {
    id,
    algo: PP_ALGO_VERSION,
    created: Date.now(),
    mode,
    source,
    harmony: { source: "auto", key: null, chordOverrides: {} },
    clean: { on: true, strength: 0.6, grid: "auto", decisions: {} },
    rework: { on: false, style, preserve: 0.6, variant: 1, length: "source" },
    groove: { on: false, swing: 0, accent: 0.5, feel: 0.3, spread: mode === "keys" ? 0.2 : 0, variation: 0.3 },
    sound: { on: true, auto: true, instrument: pick.instrument, proc: structuredClone(pick.proc) },
    seed,
    layerSeeds: { rhythm: seed * 97 + 1, voicing: seed * 97 + 2, phrase: seed * 97 + 3 },
    locks: { events: [] },
    muteSourceOnApply: true,
  };
}
