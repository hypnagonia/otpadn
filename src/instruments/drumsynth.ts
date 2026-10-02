/**
 * Drum Producer kit: zero-download synthesized drums (our own code, no sample licences).
 * Per voice: level, pan, tune, attack (transient/click), decay, tone; velocity drives level
 * AND timbre (pitch-envelope depth, filter brightness). Choke groups (closed/pedal hat cut the
 * open hat; most voices are mono and cut their own tail) fade over a few ms — never a hard stop.
 * Noise comes from a seeded buffer, so offline renders are bit-identical run to run.
 */
import { GM_DRUM_VOICE } from "../drumproducer/mapping";
import { stream } from "../drumproducer/rng";
import { KITS } from "../drumproducer/sound";
import type { KitConfig, Voice } from "../drumproducer/types";
import type { Playable } from "./types";

const noiseBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext) {
  let b = noiseBufs.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0), r = stream(0x5eed);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    noiseBufs.set(ctx, b);
  }
  return b;
}

const curves = new Map<number, Float32Array>();
function driveCurve(amount: number) {
  const k = Math.round(amount * 20) / 20;
  let c = curves.get(k);
  if (!c) {
    c = new Float32Array(1024);
    const g = 1 + k * 8;
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(g * x) / Math.tanh(g);
    }
    curves.set(k, c);
  }
  return c as Float32Array<ArrayBuffer>;
}

/**
 * Pre-rendered cymbal sources: 6 band-limited square waves (additive odd harmonics, no aliasing)
 * mixed with seeded noise, cached per sample rate × kind × metal amount. One buffer source per hit
 * replaces 6 oscillators + noise + 2 gains (tune = playbackRate).
 */
const metalCache = new Map<string, AudioBuffer>();
function metalBuffer(ctx: BaseAudioContext, kind: "hat" | "ride", metal: number): AudioBuffer {
  const m = Math.round(Math.max(0, Math.min(1, metal)) * 20) / 20;
  const key = `${ctx.sampleRate}:${kind}:${m}`;
  let b = metalCache.get(key);
  if (b) return b;
  const sr = ctx.sampleRate, len = Math.round(sr * 2);
  const out = new Float32Array(len);
  if (m > 0.02) {
    const freqs = (kind === "hat" ? METAL_HAT : METAL_RIDE).map((f) => f * 1.6);
    for (const f of freqs) {
      // square = (4/π) Σ sin(2π k f t)/k over odd k below Nyquist; the 2 s buffer loops, so use whole cycles
      const fr = Math.round(f * 2) / 2;
      for (let k = 1; k * fr < sr * 0.45; k += 2) {
        const w = (2 * Math.PI * k * fr) / sr, a = (4 / Math.PI / k) * 0.35 * m;
        // sin recurrence: cheap and exact enough for 2 s
        let s0 = 0, s1 = Math.sin(w);
        const c = 2 * Math.cos(w);
        for (let i = 0; i < len; i++) {
          out[i] += a * s0;
          const s2 = c * s1 - s0;
          s0 = s1;
          s1 = s2;
        }
      }
    }
  }
  const r = stream(kind === "hat" ? 0x4a7 : 0x91d);
  const ng = 1 - m * 0.7;
  for (let i = 0; i < len; i++) out[i] += (r() * 2 - 1) * ng;
  b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
  b.copyToChannel(out, 0);
  metalCache.set(key, b);
  return b;
}

const METAL_HAT = [205.3, 304.4, 369.6, 522.7, 540, 800];
const METAL_RIDE = [287, 392, 513, 661, 843, 1017];
/** Voices that cut their own previous tail (mono). Ride, crash and shaker ring over each other. */
const MONO = new Set<Voice>(["kick", "snare", "clap", "rim", "hhc", "hhp", "hho", "tomL", "tomM", "tomH", "perc"]);
const CHOKES: Partial<Record<Voice, Voice[]>> = { hhc: ["hho"], hhp: ["hho"] };

interface Active { voice: Voice; start: number; end: number; gain: GainNode; srcs: AudioScheduledSourceNode[] }

export class DrumSynth implements Playable {
  ready = Promise.resolve();
  private cfg: KitConfig;
  private active: Active[] = [];
  constructor(private ctx: BaseAudioContext, private dest: AudioNode, kitId: string) {
    this.cfg = (KITS[kitId] ?? KITS["house-909"]).make();
  }

  configure(cfg: unknown) {
    if (cfg && typeof cfg === "object" && "voices" in cfg) this.cfg = cfg as KitConfig;
  }

  private noise(t: number, dur: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = noiseBuffer(this.ctx);
    // Deterministic start offset per hit time: varied texture, reproducible renders.
    const off = ((Math.floor(t * 1000) * 7919) % 997) / 997;
    s.loop = true; // long tails (crash) outlast the 2 s buffer
    s.start(t, off);
    s.stop(t + dur + 0.05);
    return s;
  }

  private osc(type: OscillatorType, f: number, t: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.start(t);
    return o;
  }

  private filt(type: BiquadFilterType, f: number, q = 0.707) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = Math.min(f, this.ctx.sampleRate * 0.45);
    b.Q.value = q;
    return b;
  }

  /** Attack ramp (avoids a click), then exponential decay. Returns the end time (≈ −50 dB). */
  private env(p: AudioParam, t: number, peak: number, attack: number, decay: number) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setTargetAtTime(0, t + attack, Math.max(0.001, decay / 5));
    return t + attack + decay * 1.25;
  }

  start({ note, time, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const voice = GM_DRUM_VOICE[note];
    if (!voice) return;
    const vs = this.cfg.voices[voice];
    if (!vs?.on) return;
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
    const v = Math.max(0, Math.min(1, velocity / 127));
    const amp = 0.06 + 0.94 * Math.pow(v, 1.6);
    const T = Math.pow(2, vs.tune / 12);
    const tone = vs.tone;

    // choke: earlier voices this hit silences
    this.active = this.active.filter((a) => a.end > ctx.currentTime);
    for (const a of this.active) {
      if (a.start >= t - 1e-4 || a.end <= t) continue;
      if ((MONO.has(voice) && a.voice === voice) || CHOKES[voice]?.includes(a.voice)) {
        a.gain.gain.setTargetAtTime(0, t, a.voice === "kick" ? 0.004 : 0.003);
        a.end = t + 0.03;
        for (const s of a.srcs) {
          try { s.stop(t + 0.03); } catch { /* already stopped */ }
        }
      }
    }

    const out = ctx.createGain(); // level + choke fader
    out.gain.value = Math.pow(10, vs.level / 20);
    let head: AudioNode = out;
    if (Math.abs(vs.pan) > 0.005) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = vs.pan;
      out.connect(pan);
      head = pan;
    }
    head.connect(this.dest);
    const srcs: AudioScheduledSourceNode[] = [];
    let end = t + 0.1;
    const g = () => {
      const x = ctx.createGain();
      x.gain.value = 0;
      return x;
    };

    switch (voice) {
      case "kick": {
        const model = this.cfg.kick;
        const f0 = (model === "808" ? 45 : model === "tight" ? 58 : 52) * T;
        const dec = (model === "808" ? 0.9 : model === "tight" ? 0.28 : 0.45) * vs.decay;
        const o = this.osc("sine", f0 * (2.2 + 3 * vs.attack * (0.5 + 0.5 * v)), t);
        o.frequency.setTargetAtTime(f0, t, model === "808" ? 0.05 : model === "tight" ? 0.014 : 0.028);
        const a = g();
        end = this.env(a.gain, t, 0.9 * amp, 0.0015, dec);
        o.connect(a);
        let tail: AudioNode = a;
        if (this.cfg.drive > 0.01) {
          const sh = ctx.createWaveShaper();
          sh.curve = driveCurve(this.cfg.drive);
          sh.oversample = "2x";
          a.connect(sh);
          tail = sh;
        }
        tail.connect(out);
        srcs.push(o);
        if (vs.attack > 0.02) {
          const n = this.noise(t, 0.03);
          const hp = this.filt("highpass", 1800 + 3000 * tone);
          const ca = g();
          this.env(ca.gain, t, 0.35 * vs.attack * amp * (0.5 + 0.5 * v), 0.0005, 0.012);
          n.connect(hp).connect(ca).connect(out);
          srcs.push(n);
        }
        break;
      }
      case "snare": {
        const dec = 0.2 * vs.decay;
        for (const [type, f, lv] of [["triangle", 185, 0.45], ["sine", 330, 0.25]] as const) {
          const o = this.osc(type, f * T * 1.25, t);
          o.frequency.setTargetAtTime(f * T, t, 0.02);
          const a = g();
          this.env(a.gain, t, lv * amp * (1 - 0.3 * tone), 0.001, dec * 0.5);
          o.connect(a).connect(out);
          srcs.push(o);
        }
        const n = this.noise(t, dec * 1.5 + 0.05);
        const hp = this.filt("highpass", 700 + 900 * tone), lp = this.filt("lowpass", 3500 + 9000 * tone * (0.4 + 0.6 * v));
        const a = g();
        end = this.env(a.gain, t, 0.55 * amp * (0.7 + 0.3 * vs.attack), 0.001, dec);
        n.connect(hp).connect(lp).connect(a).connect(out);
        srcs.push(n);
        break;
      }
      case "clap": {
        const dec = 0.25 * vs.decay;
        const n = this.noise(t, dec * 1.5 + 0.08);
        const bp = this.filt("bandpass", 900 + 700 * tone + 300 * v, 1.1), hp = this.filt("highpass", 400);
        const a = ctx.createGain();
        const pk = 0.8 * amp;
        a.gain.setValueAtTime(0, t);
        for (let k = 0; k < 3; k++) {
          const tk = t + k * 0.011;
          a.gain.linearRampToValueAtTime(pk * (0.8 + 0.2 * vs.attack), tk + 0.001);
          a.gain.setTargetAtTime(pk * 0.08, tk + 0.001, 0.0035);
        }
        const tt = t + 0.034;
        a.gain.linearRampToValueAtTime(pk * 0.75, tt);
        a.gain.setTargetAtTime(0, tt, dec / 5);
        end = tt + dec * 1.25;
        n.connect(bp).connect(hp).connect(a).connect(out);
        srcs.push(n);
        break;
      }
      case "rim": {
        const dec = 0.04 * vs.decay;
        const hp = this.filt("highpass", 300);
        for (const [type, f, lv] of [["triangle", 1700, 0.35], ["sine", 480, 0.3]] as const) {
          const o = this.osc(type, f * T, t);
          const a = g();
          end = this.env(a.gain, t, lv * amp, 0.0005, dec);
          o.connect(a).connect(hp);
          srcs.push(o);
        }
        hp.connect(out);
        break;
      }
      case "hhc": case "hhp": case "hho": case "ride": case "crash": {
        const isHat = voice === "hhc" || voice === "hhp" || voice === "hho";
        const base = { hhc: 0.06, hhp: 0.04, hho: 0.45, ride: 1.2, crash: 1.8 }[voice];
        const dec = base * vs.decay;
        const bp = this.filt("bandpass", isHat ? 10000 : voice === "ride" ? 6000 : 8000, 0.8);
        const hp = this.filt("highpass", (isHat ? 7500 : 4000) - 2500 * v * (0.5 + 0.5 * tone));
        const a = g();
        end = this.env(a.gain, t, (isHat ? 0.5 : 0.35) * amp, voice === "hhp" ? 0.002 : 0.0007, dec);
        bp.connect(hp).connect(a).connect(out);
        const src = ctx.createBufferSource();
        src.buffer = metalBuffer(ctx, isHat ? "hat" : "ride", this.cfg.metal);
        src.loop = true;
        src.playbackRate.value = T;
        src.connect(bp);
        src.start(t, ((Math.floor(t * 1000) * 7919) % 997) / 997);
        srcs.push(src);
        break;
      }
      case "tomL": case "tomM": case "tomH": {
        const f0 = { tomL: 95, tomM: 130, tomH: 175 }[voice] * T;
        const dec = { tomL: 0.35, tomM: 0.3, tomH: 0.26 }[voice] * vs.decay;
        const o = this.osc("sine", f0 * (1.4 + 0.5 * v), t);
        o.frequency.setTargetAtTime(f0, t, 0.05);
        const a = g();
        end = this.env(a.gain, t, 0.7 * amp, 0.001, dec);
        o.connect(a).connect(out);
        srcs.push(o);
        break;
      }
      case "shaker": {
        const dec = 0.07 * vs.decay;
        const n = this.noise(t, dec * 1.5 + 0.05);
        const bp = this.filt("bandpass", 6000 + 2000 * tone, 0.9), hp = this.filt("highpass", 4000);
        const a = g();
        end = this.env(a.gain, t, 0.4 * amp, 0.009 - 0.005 * v * vs.attack, dec);
        n.connect(bp).connect(hp).connect(a).connect(out);
        srcs.push(n);
        break;
      }
      case "perc": {
        const model = this.cfg.percModel;
        const dec = (model === "cowbell" ? 0.12 : model === "block" ? 0.05 : 0.18) * vs.decay;
        if (model === "cowbell") {
          const bp = this.filt("bandpass", 2640 * T, 1);
          for (const f of [540, 800]) {
            const o = this.osc("square", f * T, t);
            o.connect(bp);
            srcs.push(o);
          }
          const a = g();
          end = this.env(a.gain, t, 0.35 * amp, 0.0007, dec);
          bp.connect(a).connect(out);
        } else {
          const f0 = (model === "block" ? 880 : 310) * T;
          const o = this.osc(model === "block" ? "sine" : "sine", f0 * (model === "block" ? 1 : 1.25), t);
          o.frequency.setTargetAtTime(f0, t, 0.012);
          const a = g();
          end = this.env(a.gain, t, 0.6 * amp, 0.0007, dec);
          o.connect(a).connect(out);
          srcs.push(o);
        }
        break;
      }
    }
    const stopAt = end + 0.05;
    for (const s of srcs) {
      try { s.stop(stopAt); } catch { /* noise source already bounded */ }
    }
    const rec: Active = { voice, start: t, end: stopAt, gain: out, srcs };
    this.active.push(rec);
    srcs[srcs.length - 1].onended = () => {
      head.disconnect();
      this.active = this.active.filter((a) => a !== rec);
    };
  }

  /** Transport stop / seek: short fade on everything still sounding or scheduled. */
  stopAll() {
    const now = this.ctx.currentTime;
    for (const a of this.active) {
      const p = a.gain.gain;
      if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(now);
      else p.cancelScheduledValues(now);
      p.setTargetAtTime(0, now, 0.004);
      for (const s of a.srcs) {
        try { s.stop(now + 0.04); } catch { /* already stopped */ }
      }
    }
    this.active = [];
  }

  dispose() {
    this.stopAll();
  }
}
