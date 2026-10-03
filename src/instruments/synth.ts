import type { NoteSlide } from "../model/types";
/**
 * Zero-download subtractive synth. Band-limited WebAudio oscillators with unison + stereo spread,
 * 12/24 dB low-pass with envelope, oversampled drive, vibrato and filter LFOs.
 */
import type { Playable } from "./types";

interface Osc {
  type: OscillatorType;
  detune: number; // cents
  gain: number;
  octave?: number;
  unison?: number; // voices
  spread?: number; // total detune spread across unison, cents
  width?: number; // stereo spread 0..1
}

export interface SynthPreset {
  oscs: Osc[];
  cutoff: number;
  envAmt: number; // Hz added at attack peak
  q: number;
  slope?: 12 | 24;
  a: number; d: number; s: number; r: number; // amp ADSR (s)
  fd: number; // filter decay (s)
  gain: number;
  drive?: number; // 0 = clean
  vib?: { rate: number; depth: number; delay: number }; // cents
  flfo?: { rate: number; depth: number }; // Hz
}

export const SYNTHS: Record<string, SynthPreset> = {
  // ── basses
  "sub-bass": { oscs: [{ type: "sine", detune: 0, gain: 1 }, { type: "triangle", detune: 0, gain: 0.35 }], cutoff: 500, envAmt: 300, q: 0.7, a: 0.004, d: 0.25, s: 0.85, r: 0.08, fd: 0.2, gain: 0.55 },
  "moog-bass": { oscs: [{ type: "sawtooth", detune: 0, gain: 0.6 }, { type: "square", detune: 0, gain: 0.45, octave: -1 }], cutoff: 260, envAmt: 2200, q: 1.6, slope: 24, a: 0.003, d: 0.32, s: 0.55, r: 0.07, fd: 0.16, gain: 0.42, drive: 0.35 },
  "acid-bass": { oscs: [{ type: "sawtooth", detune: 0, gain: 0.8 }], cutoff: 220, envAmt: 3600, q: 11, slope: 24, a: 0.002, d: 0.2, s: 0.25, r: 0.05, fd: 0.13, gain: 0.32, drive: 0.6 },
  "reese-bass": { oscs: [{ type: "sawtooth", detune: 0, gain: 0.45, unison: 4, spread: 34, width: 0.25 }, { type: "sine", detune: 0, gain: 0.6, octave: -1 }], cutoff: 480, envAmt: 700, q: 1.8, slope: 24, a: 0.005, d: 0.3, s: 0.85, r: 0.1, fd: 0.3, gain: 0.3, drive: 0.25, flfo: { rate: 0.35, depth: 220 } },
  // ── pads
  "warm-pad": { oscs: [{ type: "sawtooth", detune: -9, gain: 0.4 }, { type: "sawtooth", detune: 9, gain: 0.4 }, { type: "triangle", detune: 0, gain: 0.5, octave: -1 }], cutoff: 1400, envAmt: 600, q: 0.8, a: 0.7, d: 1.0, s: 0.8, r: 1.4, fd: 1.5, gain: 0.16 },
  "string-pad": { oscs: [{ type: "sawtooth", detune: 0, gain: 0.32, unison: 6, spread: 26, width: 0.9 }, { type: "sawtooth", detune: 0, gain: 0.18, octave: 1, unison: 2, spread: 14, width: 0.9 }], cutoff: 1900, envAmt: 900, q: 0.6, slope: 24, a: 0.9, d: 1.4, s: 0.85, r: 1.8, fd: 2.2, gain: 0.12, vib: { rate: 4.8, depth: 6, delay: 0.6 } },
  "glass-pad": { oscs: [{ type: "triangle", detune: 0, gain: 0.5, unison: 3, spread: 12, width: 1 }, { type: "sine", detune: 0, gain: 0.35, octave: 1, unison: 2, spread: 8, width: 1 }, { type: "sine", detune: 702, gain: 0.08, octave: 1 }], cutoff: 5200, envAmt: 1800, q: 0.7, a: 0.45, d: 2.0, s: 0.7, r: 2.4, fd: 2.5, gain: 0.2, flfo: { rate: 0.12, depth: 900 } },
  // arpeggios: no detune / unison, quick attack, short release — every note in tune and separate
  "arp-pluck": { oscs: [{ type: "triangle", detune: 0, gain: 0.6 }, { type: "sine", detune: 0, gain: 0.3, octave: 1 }, { type: "sawtooth", detune: 0, gain: 0.08 }], cutoff: 1400, envAmt: 3200, q: 0.8, a: 0.003, d: 0.4, s: 0.25, r: 0.22, fd: 0.25, gain: 0.3 },
  // ── leads
  pluck: { oscs: [{ type: "sawtooth", detune: -7, gain: 0.5 }, { type: "square", detune: 7, gain: 0.3 }], cutoff: 500, envAmt: 4500, q: 1.5, a: 0.002, d: 0.35, s: 0.0, r: 0.25, fd: 0.18, gain: 0.3 },
  "saw-lead": { oscs: [{ type: "sawtooth", detune: -6, gain: 0.5 }, { type: "sawtooth", detune: 6, gain: 0.5 }], cutoff: 2200, envAmt: 2500, q: 1.2, a: 0.008, d: 0.2, s: 0.7, r: 0.15, fd: 0.3, gain: 0.22 },
  supersaw: { oscs: [{ type: "sawtooth", detune: 0, gain: 0.26, unison: 7, spread: 38, width: 0.85 }, { type: "sawtooth", detune: 0, gain: 0.18, octave: -1 }], cutoff: 3800, envAmt: 2600, q: 0.9, slope: 24, a: 0.01, d: 0.35, s: 0.75, r: 0.25, fd: 0.4, gain: 0.16, vib: { rate: 5.5, depth: 9, delay: 0.35 } },
  "square-lead": { oscs: [{ type: "square", detune: 0, gain: 0.55 }, { type: "square", detune: 1203, gain: 0.12 }, { type: "sawtooth", detune: -5, gain: 0.15 }], cutoff: 2400, envAmt: 2000, q: 1.4, slope: 24, a: 0.006, d: 0.2, s: 0.7, r: 0.14, fd: 0.25, gain: 0.2, drive: 0.2, vib: { rate: 5.8, depth: 14, delay: 0.25 } },
};

const driveCurves = new Map<number, Float32Array>();
function driveCurve(amount: number) {
  const k = Math.round(amount * 20) / 20;
  let c = driveCurves.get(k);
  if (!c) {
    c = new Float32Array(2048);
    const g = 1 + k * 6;
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(g * x) / Math.tanh(g);
    }
    driveCurves.set(k, c);
  }
  return c;
}

/** Pseudo-random 0..1 from note, time and voice index: varies like analog drift, identical on every render. */
function drift(note: number, time: number, u: number) {
  let h = Math.imul(note + 1, 0x9e3779b1) ^ Math.imul(Math.round(time * 1000) + 7, 0x85ebca6b) ^ Math.imul(u + 3, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

interface Voice {
  note: number;
  start: number;
  end: number; // when the release tail is over
  stop: (t: number) => void;
}

/**
 * Polyphony per instrument, like a hardware synth: beyond it the oldest voice is stolen (10 ms
 * fade). Transcribed parts stack dozens of overlapping notes, and an unlimited supersaw pad
 * overloaded the audio thread (playback went silent, bounces ran slower than realtime).
 */
const MAX_VOICES = 16;
const MAX_PAD_VOICES = 12;

export class Synth implements Playable {
  ready = Promise.resolve();
  private voices = new Set<Voice>();
  private maxVoices: number;
  constructor(private ctx: BaseAudioContext, private dest: AudioNode, private p: SynthPreset) {
    this.maxVoices = p.a >= 0.3 ? MAX_PAD_VOICES : MAX_VOICES;
  }

  /** Make room for a note at `time`: retrigger the same pitch, then steal the oldest beyond the cap. */
  private allocate(note: number, time: number) {
    const live = [...this.voices].filter((v) => v.end > time && v.start <= time + 1e-6);
    for (const v of live)
      if (v.note === note) {
        v.stop(time);
        v.end = time + 0.02;
      }
    const sounding = live.filter((v) => v.end > time + 0.02).sort((a, b) => a.start - b.start);
    for (let i = 0; i <= sounding.length - this.maxVoices; i++) {
      sounding[i].stop(time);
      sounding[i].end = time + 0.02;
    }
  }

  start({ note, time, duration, velocity, slide }: { note: number; time: number; duration: number; velocity: number; slide?: NoteSlide }) {
    const { ctx, p } = this;
    this.allocate(note, time);
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const vel = velocity / 127;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.dest);

    // Filter (1 or 2 stages) → optional drive → amp
    const f1 = ctx.createBiquadFilter();
    f1.type = "lowpass";
    // Filter sweeps are slow (envelopes, LFO): coefficients once per 128-sample block instead of
    // per sample — the biggest CPU cost of a voice otherwise.
    f1.frequency.automationRate = "k-rate";
    f1.Q.value = p.slope === 24 ? 0.54 : p.q;
    let tail: AudioNode = f1;
    const filters = [f1];
    if (p.slope === 24) {
      const f2 = ctx.createBiquadFilter();
      f2.type = "lowpass";
      f2.frequency.automationRate = "k-rate";
      f2.Q.value = p.q;
      f1.connect(f2);
      filters.push(f2);
      tail = f2;
    }
    if (p.drive) {
      const sh = ctx.createWaveShaper();
      sh.curve = driveCurve(p.drive) as Float32Array<ArrayBuffer>;
      sh.oversample = "4x";
      tail.connect(sh);
      tail = sh;
    }
    tail.connect(out);

    const sources: OscillatorNode[] = [];
    let vibGain: GainNode | null = null;
    if (p.vib) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vib.rate;
      vibGain = ctx.createGain();
      vibGain.gain.setValueAtTime(0, time);
      vibGain.gain.linearRampToValueAtTime(p.vib.depth, time + p.vib.delay + 0.3);
      lfo.connect(vibGain);
      lfo.start(time);
      sources.push(lfo);
    }
    for (const o of p.oscs) {
      const n = Math.max(1, o.unison ?? 1);
      // Unison voices share one gain per stereo side (left / centre / right) and one panner per side
      // instead of a gain + panner each: same level and width, about half the nodes per note.
      const wide = n > 1 && !!o.width;
      const sides = new Map<number, GainNode>();
      const side = (pos: number) => {
        const k = wide ? Math.sign(pos) : 0;
        let g = sides.get(k);
        if (!g) {
          g = ctx.createGain();
          g.gain.value = o.gain / Math.sqrt(n);
          if (k !== 0) {
            // average |position| of the voices on this side (positions run −0.5 … 0.5)
            const ps = Array.from({ length: n }, (_, u) => u / (n - 1) - 0.5).filter((x) => x > 1e-9);
            const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
            const pan = ctx.createStereoPanner();
            pan.pan.value = k * Math.min(1, 2 * mean * o.width!);
            g.connect(pan).connect(f1);
          } else g.connect(f1);
          sides.set(k, g);
        }
        return g;
      };
      for (let u = 0; u < n; u++) {
        const pos = n === 1 ? 0 : u / (n - 1) - 0.5; // -0.5..0.5
        const osc = ctx.createOscillator();
        osc.type = o.type;
        osc.frequency.value = freq * Math.pow(2, o.octave ?? 0);
        osc.detune.value = o.detune + pos * (o.spread ?? 0) + (drift(note, time, u + 16 * p.oscs.indexOf(o)) - 0.5) * 3; // analog drift (seeded: renders are reproducible)
        if (vibGain) {
          osc.detune.automationRate = "k-rate"; // vibrato is a few Hz: block rate keeps the oscillator on its fast path
          vibGain.connect(osc.detune);
        }
        osc.connect(side(pos));
        osc.start(time);
        sources.push(osc);
      }
    }

    if (p.flfo) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.flfo.rate;
      const lg = ctx.createGain();
      lg.gain.value = p.flfo.depth;
      lfo.connect(lg);
      filters.forEach((f) => lg.connect(f.frequency));
      lfo.start(time);
      sources.push(lfo);
    }

    // Player slides on every oscillator's detune (on top of its unison spread).
    if (slide?.from || slide?.fall) {
      const endT = time + Math.max(duration, p.a);
      for (const s of sources) {
        if (!(s instanceof OscillatorNode) || s.frequency.value < 20) continue; // skip LFOs
        const base = s.detune.value;
        if (slide.from) {
          s.detune.setValueAtTime(base + slide.from * 100, time);
          s.detune.linearRampToValueAtTime(base, time + Math.max(0.02, Math.min(slide.fromTime ?? 0.06, duration * 0.6)));
        }
        if (slide.fall) {
          const ft = Math.max(0.04, Math.min(slide.fallTime ?? 0.18, duration * 0.7));
          s.detune.setValueAtTime(base, endT - ft);
          s.detune.linearRampToValueAtTime(base + slide.fall * 100, endT);
        }
      }
    }
    // Envelopes
    const peak = p.gain * (0.35 + 0.65 * vel);
    const g = out.gain;
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(peak, time + p.a);
    g.setTargetAtTime(peak * p.s, time + p.a, p.d / 3 + 1e-4);
    const base = p.cutoff * (0.6 + 0.4 * vel);
    for (const f of filters) {
      f.frequency.setValueAtTime(base, time);
      f.frequency.linearRampToValueAtTime(base + p.envAmt * vel, time + Math.max(0.003, p.a * 0.5));
      f.frequency.setTargetAtTime(base, time + p.a, p.fd / 3 + 1e-4);
    }
    const end = time + Math.max(duration, p.a);
    g.setTargetAtTime(0, end, p.r / 3 + 1e-4);
    // 1.6 × release ≈ 4.8 time constants ≈ −42 dB: inaudible, and voices free up sooner.
    const stopAt = end + p.r * 1.6 + 0.05;
    sources.forEach((s) => s.stop(stopAt));
    const voice: Voice = {
      note,
      start: time,
      end: stopAt,
      stop: (t: number) => {
        g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, 0.01);
        sources.forEach((s) => { try { s.stop(t + 0.1); } catch { /* already stopped */ } });
      },
    };
    sources[sources.length - 1].onended = () => {
      out.disconnect();
      this.voices.delete(voice);
    };
    this.voices.add(voice);
    // Live release: start the amp release now instead of at the scheduled end.
    return (at = ctx.currentTime) => {
      g.cancelScheduledValues(at);
      g.setValueAtTime(g.value, at);
      g.setTargetAtTime(0, at, p.r / 3 + 1e-4);
      sources.forEach((s) => { try { s.stop(at + p.r * 1.6 + 0.05); } catch { /* already stopped */ } });
      voice.end = Math.min(voice.end, at + p.r * 1.6 + 0.05);
    };
  }
  stopAll() {
    const t = this.ctx.currentTime;
    this.voices.forEach((v) => v.stop(t));
    this.voices.clear();
  }
  dispose() {
    this.stopAll();
  }
}
