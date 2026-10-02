/**
 * "Pick sound": coherent synthesized kits (no samples → no licence or CDN risk, deterministic
 * renders) and per-output processing. Never touches notes. Decay lengths follow the part's
 * density and tempo so attacks stay readable; levels leave headroom (no limiter is added).
 */
import { VOICES, VOICE_INFO, type DEvent, type KitConfig, type Output, type OutputProc, type Style, type Voice, type VoiceSettings } from "./types";

const V = (level: number, o: Partial<VoiceSettings> = {}): VoiceSettings => ({ on: true, level, pan: 0, tune: 0, attack: 0.5, decay: 1, tone: 0.5, ...o });

const baseVoices = (o: Partial<Record<Voice, Partial<VoiceSettings>>> = {}): Record<Voice, VoiceSettings> => {
  const lv: Record<Voice, number> = { kick: 0, snare: -4, clap: -3, rim: -8, hhc: -9, hhp: -11, hho: -10, ride: -12, shaker: -12, crash: -15, tomL: -6, tomM: -6, tomH: -6, perc: -8 };
  const pan: Partial<Record<Voice, number>> = { hhc: 0.12, hhp: 0.12, hho: 0.15, ride: 0.25, shaker: -0.3, perc: 0.3, rim: -0.2, tomL: -0.3, tomH: 0.3, crash: -0.2 };
  return Object.fromEntries(VOICES.map((v) => [v, V(lv[v], { pan: pan[v] ?? 0, ...o[v] })])) as Record<Voice, VoiceSettings>;
};

export interface KitDef {
  name: string;
  desc: string;
  styles: Style[];
  make: () => KitConfig;
}

export const KITS: Record<string, KitDef> = {
  "house-909": {
    name: "house 909",
    desc: "punchy 909-style kick, bright clap, noisy hats, congas",
    styles: ["house"],
    make: () => ({ kitId: "house-909", kick: "909", percModel: "conga", metal: 0.35, drive: 0.1, voices: baseVoices({ clap: { tone: 0.6 }, hho: { decay: 0.9 } }) }),
  },
  "deep-808": {
    name: "deep 808",
    desc: "round long 808 kick, soft clap, metallic 808 hats, congas",
    styles: ["house"],
    make: () => ({ kitId: "deep-808", kick: "808", percModel: "conga", metal: 0.85, drive: 0, voices: baseVoices({ kick: { decay: 1.1, attack: 0.3 }, clap: { tone: 0.35, decay: 1.2 }, hhc: { tone: 0.4 }, snare: { tone: 0.4 } }) }),
  },
  "techno-909": {
    name: "techno 909",
    desc: "low, driven kick, dark clap, metallic hats, wood-block perc",
    styles: ["techno"],
    make: () => ({ kitId: "techno-909", kick: "909", percModel: "block", metal: 0.6, drive: 0.45, voices: baseVoices({ kick: { tune: -2, decay: 1.15, attack: 0.65 }, clap: { tone: 0.4 }, hho: { decay: 0.8, tone: 0.45 }, rim: { level: -7 } }) }),
  },
  "minimal-tight": {
    name: "minimal tight",
    desc: "short clicky kick, rim-forward, tight hats, cowbell perc",
    styles: ["techno"],
    make: () => ({ kitId: "minimal-tight", kick: "tight", percModel: "cowbell", metal: 0.2, drive: 0.15, voices: baseVoices({ kick: { decay: 0.8, attack: 0.75 }, rim: { level: -5 }, hhc: { decay: 0.75 }, hho: { decay: 0.6 }, perc: { level: -11 } }) }),
  },
};

/** Base decay (s) at decay ×1 for each voice model, mirrored by the synth. */
export const BASE_DECAY: Record<Voice, number> & { kick808: number; kickTight: number } = {
  kick: 0.45, kick808: 0.9, kickTight: 0.28, snare: 0.2, clap: 0.25, rim: 0.04, hhc: 0.06, hhp: 0.04, hho: 0.45, ride: 1.2, shaker: 0.07, crash: 1.8, tomL: 0.35, tomM: 0.3, tomH: 0.26, perc: 0.18,
};

const medianGap = (xs: number[]) => {
  if (!xs.length) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Fader levels leave ≈ 6 dB pre-master headroom for a full kit at high velocity. */
export const defaultOutputs = (style: Style): Record<Output, OutputProc> => ({
  kick: { level: -5, eq: { on: true, hpf: 28, low: 1, high: 0 }, sat: { on: style === "techno", drive: 0.3 }, comp: { on: false, threshold: -12, ratio: 2, attack: 20 }, send: { on: false, amount: 0 } },
  backbeat: { level: -7, eq: { on: true, hpf: 120, low: -1, high: 1 }, sat: { on: false, drive: 0.2 }, comp: { on: true, threshold: -16, ratio: 3, attack: 15 }, send: { on: true, amount: style === "house" ? 0.12 : 0.08 } },
  hats: { level: -11, eq: { on: true, hpf: 350, low: 0, high: 1.5 }, sat: { on: false, drive: 0.2 }, comp: { on: false, threshold: -18, ratio: 2, attack: 5 }, send: { on: true, amount: 0.06 } },
  perc: { level: -12, eq: { on: true, hpf: 150, low: 0, high: 0.5 }, sat: { on: false, drive: 0.2 }, comp: { on: false, threshold: -18, ratio: 2, attack: 10 }, send: { on: true, amount: 0.14 } },
});

/** Choose a kit + processing for this part. Pure: same events/tempo/style → same choice. */
export function autoSound(events: DEvent[], style: Style, bpm: number, energy: number, lengthBeats: number) {
  const spb = 60 / bpm;
  const notes: string[] = [];
  const bars = Math.max(1, lengthBeats / 4);
  const perBar = events.length / bars;
  const has = (v: Voice) => events.some((e) => e.voice === v);
  let kitId: string;
  if (style === "techno") kitId = perBar < 12 && !has("hho") ? "minimal-tight" : "techno-909";
  else kitId = energy < 0.4 ? "deep-808" : "house-909";
  const kit = KITS[kitId].make();
  notes.push(`kit "${KITS[kitId].name}" for ${style}${style === "house" ? `, energy ${Math.round(energy * 100)}%` : `, ${perBar.toFixed(1)} hits/bar`}`);

  const times = (pred: (e: DEvent) => boolean) => events.filter(pred).map((e) => (e.start + e.micro) * spb).sort((a, b) => a - b);
  const gaps = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]).filter((d) => d > 0.02);
  const limit = (v: Voice, base: number, maxSec: number, why: string) => {
    if (!Number.isFinite(maxSec)) return;
    const cap = Math.max(0.3, Math.min(2, maxSec / base));
    if (cap < kit.voices[v].decay) {
      kit.voices[v].decay = Math.round(cap * 100) / 100;
      notes.push(`${VOICE_INFO[v].label} decay ×${kit.voices[v].decay} (${why})`);
    }
  };
  const kickBase = kit.kick === "808" ? BASE_DECAY.kick808 : kit.kick === "tight" ? BASE_DECAY.kickTight : BASE_DECAY.kick;
  limit("kick", kickBase, 0.85 * medianGap(gaps(times((e) => e.voice === "kick"))), "shorter than the kick spacing");
  const hatT = times((e) => VOICE_INFO[e.voice].out === "hats");
  limit("hhc", BASE_DECAY.hhc, 0.7 * medianGap(gaps(hatT)), "hat density");
  // Open hat: up to the next hat event (the choke cuts it anyway; this keeps the tail clean).
  const oh = times((e) => e.voice === "hho");
  const ohGaps = oh.map((t) => (hatT.find((x) => x > t + 0.02) ?? Infinity) - t).filter(Number.isFinite);
  limit("hho", BASE_DECAY.hho, 0.95 * medianGap(ohGaps), "space to the next hat");
  limit("clap", BASE_DECAY.clap, 0.6 * medianGap(gaps(times((e) => e.voice === "clap" || e.voice === "snare"))), "backbeat spacing");
  const outputs = defaultOutputs(style);
  if (perBar > 24) {
    for (const v of VOICES) kit.voices[v].decay = Math.round(kit.voices[v].decay * 0.85 * 100) / 100;
    for (const o of Object.values(outputs)) o.send.amount *= 0.7;
    notes.push("dense part: all decays −15 %, reverb sends −30 %");
  }
  if (bpm >= 132) {
    outputs.kick.eq.low = 0;
    notes.push("fast tempo: no low-shelf boost on the kick");
  }
  return { kit, outputs, notes };
}
