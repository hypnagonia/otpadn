/**
 * Physical-model guitars (extended Karplus-Strong, zero download):
 *  - acoustic: pick-position comb + bright loop filter + body resonances
 *  - distortion: long-sustain string → 4× oversampled tanh drive → 4×12 cab voicing
 * Each (pitch, velocity layer) is rendered once to a buffer and cached; playback is a plain buffer source.
 */
import { memory } from "../system/memory";
import type { Playable } from "./types";

interface PluckOpts {
  t60: number; // seconds to decay 60 dB (at 110 Hz; higher notes shorter)
  bright: number; // 0..1 loop-filter brightness
  pick: number; // pick position 0..0.5
  len: number; // rendered seconds
}

function renderString(sr: number, f: number, vel: number, o: PluckOpts): Float32Array {
  const n = Math.floor(o.len * sr);
  const out = new Float32Array(n);
  const N = sr / f;
  const L = Math.max(2, Math.floor(N - 0.5));
  const frac = N - 0.5 - L;
  const C = (1 - frac) / (1 + frac); // all-pass tuning coefficient
  const t60 = o.t60 * Math.pow(110 / f, 0.35);
  const g = Math.pow(10, -3 / (t60 * f));
  const S = 0.5 - o.bright * 0.45; // averaging weight: 0.5 = darkest
  // Excitation: lowpassed noise, velocity → brighter + louder, pick-position comb.
  const exc = new Float32Array(L);
  let lp = 0;
  const a = 0.25 + 0.7 * vel;
  let seed = Math.floor(f * 1000) % 2147483647 || 7;
  for (let i = 0; i < L; i++) {
    seed = (seed * 16807) % 2147483647;
    lp += a * ((seed / 2147483647) * 2 - 1 - lp);
    exc[i] = lp;
  }
  const P = Math.max(1, Math.round(o.pick * L));
  for (let i = L - 1; i >= P; i--) exc[i] -= exc[i - P];
  const line = new Float32Array(L);
  line.set(exc);
  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx];
    const filt = (1 - S) * cur + S * prev; // loop low-pass
    prev = cur;
    const y = C * filt + apX - C * apY; // fractional-delay all-pass
    apX = filt;
    apY = y;
    line[idx] = y * g;
    out[i] = cur;
    idx = (idx + 1) % L;
  }
  return out;
}

const tanhCurve = (k: number) => {
  const c = new Float32Array(4096);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
};

/**
 * Rendered strings, shared by every guitar instance and context (AudioBuffers aren't tied to a
 * context), LRU-bounded and reported to the memory manager.
 */
const strings = new Map<string, AudioBuffer>();
let stringBytes = 0;
const STRING_CACHE_MAX = 64 * 1024 * 1024;
const evict = (need: number) => {
  let freed = 0;
  while (strings.size && (stringBytes > STRING_CACHE_MAX - need || freed < need)) {
    const [k, b] = strings.entries().next().value!;
    strings.delete(k);
    stringBytes -= b.length * 4;
    freed += b.length * 4;
    if (stringBytes <= STRING_CACHE_MAX - need && need === 0) break;
  }
  memory.track("guitar-strings", stringBytes, "cache", "modelled guitar notes");
  return freed;
};
memory.reclaimer("modelled guitar cache", 22, (need) => evict(Math.min(need, stringBytes)));

export class PluckGuitar implements Playable {
  ready = Promise.resolve();
  private input: AudioNode;
  private voices = new Set<{ src: AudioBufferSourceNode; g: GainNode }>();
  constructor(private ctx: BaseAudioContext, dest: AudioNode, private kind: "acoustic" | "distortion") {
    const bq = (type: BiquadFilterType, f: number, gain = 0, q = 0.9) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.gain.value = gain;
      b.Q.value = q;
      return b;
    };
    if (kind === "acoustic") {
      // Body: air + top-plate resonances, a little sparkle.
      const chain = [bq("highpass", 70, 0, 0.7), bq("peaking", 105, 5, 2), bq("peaking", 220, 3, 1.5), bq("peaking", 3200, 2, 0.8), bq("highshelf", 9000, -3)];
      chain.reduce((a, b) => (a.connect(b), b)).connect(dest);
      this.input = chain[0];
    } else {
      // Amp: pre-EQ → drive (4× oversampled) → 4×12 cab voicing.
      const pre = bq("highpass", 110, 0, 0.7);
      const tight = bq("peaking", 800, 4, 0.8);
      const drive = ctx.createGain();
      drive.gain.value = 9;
      const shaper = ctx.createWaveShaper();
      shaper.curve = tanhCurve(3);
      shaper.oversample = "4x";
      const post = ctx.createGain();
      post.gain.value = 0.35;
      const cab = [bq("highpass", 85, 0, 0.7), bq("peaking", 120, 3, 1), bq("peaking", 1700, 4, 1), bq("lowpass", 5200, 0, 0.7), bq("lowpass", 6500, 0, 0.7)];
      pre.connect(tight).connect(drive).connect(shaper).connect(post);
      [post, ...cab].reduce((a, b) => (a.connect(b), b)).connect(dest);
      this.input = pre;
    }
  }
  private bufferFor(pitch: number, layer: number): AudioBuffer {
    const key = `${this.ctx.sampleRate}|${this.kind}|${pitch}|${layer}`;
    let b = strings.get(key);
    if (b) {
      strings.delete(key);
      strings.set(key, b); // most recently used
      return b;
    }
    const sr = this.ctx.sampleRate, f = 440 * Math.pow(2, (pitch - 69) / 12);
    const vel = (layer + 1) / 3;
    const o: PluckOpts = this.kind === "acoustic" ? { t60: 3.2, bright: 0.55 + 0.3 * vel, pick: 0.13, len: 4 } : { t60: 9, bright: 0.85, pick: 0.2, len: 5 };
    const data = renderString(sr, f, vel, o);
    b = this.ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    strings.set(key, b);
    stringBytes += b.length * 4;
    if (stringBytes > STRING_CACHE_MAX) evict(0);
    else memory.track("guitar-strings", stringBytes, "cache", "modelled guitar notes");
    return b;
  }
  start({ note, time, duration, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const layer = Math.min(2, Math.floor((velocity / 128) * 3));
    const src = this.ctx.createBufferSource();
    src.buffer = this.bufferFor(note, layer);
    const g = this.ctx.createGain();
    const lvl = (this.kind === "acoustic" ? 0.9 : 0.6) * (0.35 + 0.65 * (velocity / 127));
    g.gain.setValueAtTime(lvl, time);
    const end = time + Math.max(0.08, duration);
    g.gain.setTargetAtTime(0, end, this.kind === "acoustic" ? 0.08 : 0.05); // fret release
    src.connect(g).connect(this.input);
    src.start(time);
    src.stop(end + 0.6);
    const v = { src, g };
    this.voices.add(v);
    src.onended = () => {
      g.disconnect();
      this.voices.delete(v);
    };
    return (at = this.ctx.currentTime) => {
      g.gain.cancelScheduledValues(at);
      g.gain.setTargetAtTime(0, at, 0.06);
    };
  }
  stopAll() {
    this.voices.forEach((v) => { try { v.src.stop(); } catch { /* not started */ } });
    this.voices.clear();
  }
  dispose() {
    this.stopAll();
  }
}
