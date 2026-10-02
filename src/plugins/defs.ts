/** Insert-plugin catalogue: parameters, ranges, defaults. DSP lives in nodes.ts + worklets.ts. */
export type PluginType = "compressor" | "multiband" | "delay" | "reverb" | "saturator" | "limiter" | "amp";

export interface Insert {
  id: string;
  type: PluginType;
  on: boolean;
  params: Record<string, number>;
  /** Compressor/limiter: detector listens to this track (post-fader) instead of its own input. */
  sidechain?: string;
}

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  log?: boolean; // logarithmic knob travel (frequencies, times)
  options?: string[]; // discrete choice (value = index)
}

export interface PluginDef {
  type: PluginType;
  name: string;
  short: string;
  desc: string;
  params: ParamSpec[];
}

export const DELAY_DIVS = ["1/16", "1/8", "1/8 dotted", "1/4", "1/4 dotted", "1/2", "1/8 triplet", "1/4 triplet"];
export const DELAY_DIV_BEATS = [0.25, 0.5, 0.75, 1, 1.5, 2, 1 / 3, 2 / 3];

export const PLUGINS: Record<PluginType, PluginDef> = {
  compressor: {
    type: "compressor",
    name: "compressor",
    short: "comp",
    desc: "soft-knee feed-forward compressor · peak/rms · parallel mix",
    params: [
      { key: "threshold", label: "threshold", min: -60, max: 0, step: 0.5, def: -18, unit: "dB" },
      { key: "ratio", label: "ratio", min: 1, max: 20, step: 0.1, def: 3, unit: ":1", log: true },
      { key: "knee", label: "knee", min: 0, max: 24, step: 0.5, def: 6, unit: "dB" },
      { key: "attack", label: "attack", min: 0.1, max: 200, step: 0.1, def: 10, unit: "ms", log: true },
      { key: "release", label: "release", min: 10, max: 2000, step: 1, def: 150, unit: "ms", log: true },
      { key: "makeup", label: "makeup", min: -12, max: 24, step: 0.5, def: 0, unit: "dB" },
      { key: "mix", label: "mix", min: 0, max: 100, step: 1, def: 100, unit: "%" },
      { key: "detector", label: "detector", min: 0, max: 1, step: 1, def: 0, options: ["peak", "rms"] },
    ],
  },
  amp: {
    type: "amp",
    name: "guitar amp",
    short: "amp",
    desc: "tube-style preamp · tone stack · 4×12 cab (CC0 IRs) · for guitar DI, bass, anything dirty",
    params: [
      { key: "gain", label: "gain", min: 0, max: 10, step: 0.1, def: 6 },
      { key: "bass", label: "bass", min: 0, max: 10, step: 0.1, def: 5.5 },
      { key: "mid", label: "mid", min: 0, max: 10, step: 0.1, def: 5 },
      { key: "treble", label: "treble", min: 0, max: 10, step: 0.1, def: 6 },
      { key: "presence", label: "presence", min: 0, max: 10, step: 0.1, def: 5.5 },
      { key: "cab", label: "cab", min: 0, max: 3, step: 1, def: 0, options: ["4×12 V30", "4×12 blend", "4×12 DV-77", "no cab"] },
      { key: "level", label: "level", min: -24, max: 12, step: 0.5, def: 0, unit: "dB" },
    ],
  },
  limiter: {
    type: "limiter",
    name: "limiter",
    short: "lim",
    desc: "look-ahead brickwall limiter · smooth attack inside the look-ahead, ceiling never exceeded",
    params: [
      { key: "gain", label: "input gain", min: 0, max: 24, step: 0.1, def: 0, unit: "dB" },
      { key: "ceiling", label: "ceiling", min: -12, max: 0, step: 0.1, def: -1, unit: "dB" },
      { key: "release", label: "release", min: 10, max: 1000, step: 1, def: 120, unit: "ms", log: true },
      { key: "lookahead", label: "look-ahead", min: 1, max: 10, step: 0.1, def: 5, unit: "ms" },
      { key: "link", label: "stereo", min: 0, max: 1, step: 1, def: 1, options: ["unlinked", "linked"] },
    ],
  },
  multiband: {
    type: "multiband",
    name: "multiband",
    short: "mbc",
    desc: "3-band compressor · linkwitz-riley 24 dB/oct crossovers (flat sum)",
    params: [
      { key: "xLow", label: "low x-over", min: 40, max: 800, step: 1, def: 180, unit: "Hz", log: true },
      { key: "xHigh", label: "high x-over", min: 800, max: 12000, step: 10, def: 3000, unit: "Hz", log: true },
      { key: "thrL", label: "low thr", min: -60, max: 0, step: 0.5, def: -20, unit: "dB" },
      { key: "thrM", label: "mid thr", min: -60, max: 0, step: 0.5, def: -20, unit: "dB" },
      { key: "thrH", label: "high thr", min: -60, max: 0, step: 0.5, def: -20, unit: "dB" },
      { key: "ratioL", label: "low ratio", min: 1, max: 20, step: 0.1, def: 3, unit: ":1", log: true },
      { key: "ratioM", label: "mid ratio", min: 1, max: 20, step: 0.1, def: 2.5, unit: ":1", log: true },
      { key: "ratioH", label: "high ratio", min: 1, max: 20, step: 0.1, def: 2.5, unit: ":1", log: true },
      { key: "gainL", label: "low gain", min: -12, max: 12, step: 0.5, def: 0, unit: "dB" },
      { key: "gainM", label: "mid gain", min: -12, max: 12, step: 0.5, def: 0, unit: "dB" },
      { key: "gainH", label: "high gain", min: -12, max: 12, step: 0.5, def: 0, unit: "dB" },
      { key: "attack", label: "attack", min: 0.1, max: 200, step: 0.1, def: 15, unit: "ms", log: true },
      { key: "release", label: "release", min: 10, max: 2000, step: 1, def: 200, unit: "ms", log: true },
    ],
  },
  delay: {
    type: "delay",
    name: "stereo delay",
    short: "dly",
    desc: "tempo-synced stereo / ping-pong delay · filtered feedback",
    params: [
      { key: "div", label: "time", min: 0, max: DELAY_DIVS.length - 1, step: 1, def: 3, options: DELAY_DIVS },
      { key: "feedback", label: "feedback", min: 0, max: 95, step: 1, def: 35, unit: "%" },
      { key: "pingpong", label: "mode", min: 0, max: 1, step: 1, def: 1, options: ["stereo", "ping-pong"] },
      { key: "offset", label: "r offset", min: -50, max: 50, step: 1, def: 0, unit: "%" },
      { key: "lowcut", label: "low cut", min: 20, max: 2000, step: 1, def: 250, unit: "Hz", log: true },
      { key: "highcut", label: "high cut", min: 1000, max: 20000, step: 10, def: 6000, unit: "Hz", log: true },
      { key: "mix", label: "mix", min: 0, max: 100, step: 1, def: 25, unit: "%" },
    ],
  },
  saturator: {
    type: "saturator",
    name: "saturator",
    short: "sat",
    desc: "soft / tape / tube / hard character · 4× oversampled · tone filter · auto gain · parallel mix",
    params: [
      { key: "mode", label: "character", min: 0, max: 3, step: 1, def: 0, options: ["soft", "tape", "tube", "hard"] },
      { key: "drive", label: "drive", min: 0, max: 24, step: 0.5, def: 6, unit: "dB" },
      { key: "tone", label: "tone", min: 1000, max: 20000, step: 10, def: 12000, unit: "Hz", log: true },
      { key: "mix", label: "mix", min: 0, max: 100, step: 1, def: 100, unit: "%" },
      { key: "output", label: "output", min: -12, max: 6, step: 0.5, def: 0, unit: "dB" },
    ],
  },
  reverb: {
    type: "reverb",
    name: "plate reverb",
    short: "verb",
    desc: "dattorro plate · modulated tank · predelay, damping, width",
    params: [
      { key: "predelay", label: "predelay", min: 0, max: 200, step: 1, def: 20, unit: "ms" },
      { key: "decay", label: "decay", min: 0, max: 99, step: 1, def: 65, unit: "%" },
      { key: "size", label: "size", min: 50, max: 150, step: 1, def: 100, unit: "%" },
      { key: "damping", label: "damping", min: 0, max: 100, step: 1, def: 35, unit: "%" },
      { key: "lowcut", label: "low cut", min: 20, max: 1000, step: 1, def: 150, unit: "Hz", log: true },
      { key: "width", label: "width", min: 0, max: 100, step: 1, def: 100, unit: "%" },
      { key: "mix", label: "mix", min: 0, max: 100, step: 1, def: 25, unit: "%" },
    ],
  },
};

export const defaultParams = (t: PluginType) => Object.fromEntries(PLUGINS[t].params.map((p) => [p.key, p.def]));
