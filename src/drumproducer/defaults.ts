/** Fresh session state for a captured source region. */
import { BEATS_PER_BAR } from "./analyze";
import { analyzeMapping } from "./mapping";
import { defaultOutputs, KITS } from "./sound";
import { STYLES } from "./styles";
import { DP_ALGO_VERSION, type DrumSession, type Style } from "./types";

export function defaultSession(id: string, source: DrumSession["source"], opts: { style?: Style; seed?: number }): DrumSession {
  const style = opts.style ?? "house";
  const bars = Math.max(1, Math.ceil(source.length / BEATS_PER_BAR));
  const seed = opts.seed ?? 1;
  return {
    id,
    algo: DP_ALGO_VERSION,
    created: Date.now(),
    source,
    mapping: analyzeMapping(source.notes, bars).mapping,
    mappingConfirmed: false,
    clean: { on: true, strength: 0.6, grid: "auto", decisions: {} },
    rework: { on: false, style, preserve: 0.6, energy: 0.5, variant: 1, length: "source", addLayers: {} },
    groove: { on: false, density: 0, swing: STYLES[style].swing, accent: 0.5, micro: 0.5, fills: 0.4 },
    // Rock uses the multitrack acoustic kit (see acoustic.ts); the synth kit stays as the fallback setting.
    sound: { on: style !== "rock", kit: KITS[style === "house" ? "house-909" : "techno-909"].make(), outputs: defaultOutputs(style), auto: true },
    seed,
    layerSeeds: { foundation: seed * 101 + 1, motion: seed * 101 + 2, perc: seed * 101 + 3, phrase: seed * 101 + 4 },
    locks: { voices: [], events: [] },
    muteSourceOnApply: true,
  };
}
