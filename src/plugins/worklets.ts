/**
 * AudioWorklet DSP for Otpadn's insert plugins (MIT, our own code):
 *  - otpadn-comp:     soft-knee feed-forward compressor, peak/RMS, stereo-linked, parallel mix
 *  - otpadn-mbcomp:   3-band compressor on Linkwitz-Riley LR4 crossovers with all-pass phase compensation
 *  - otpadn-plate:    Dattorro plate reverb (1997 "Effect Design" topology), modulated tank
 * Initial parameters come with the node (processorOptions.params) so the very first block already
 * uses them — an offline render can finish before a MessagePort message is ever delivered, which
 * made bounces randomly run on default settings. Later changes arrive over the MessagePort;
 * meters (gain reduction) go back the same way.
 */
type Init = { processorOptions?: { params?: Record<string, number> } };
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (x: number) => 20 * Math.log10(x + 1e-12);
const coef = (ms: number) => Math.exp(-1 / Math.max(1e-6, (ms / 1000) * sampleRate));

/** Static gain computer with soft knee (Giannoulis/Massberg/Reiss 2012). Returns gain change in dB (≤ 0). */
function gainComputer(x: number, T: number, R: number, W: number): number {
  const d = x - T;
  if (2 * d < -W) return 0;
  if (W > 0 && 2 * Math.abs(d) <= W) return ((1 / R - 1) * (d + W / 2) ** 2) / (2 * W);
  return d / R - d;
}

class Comp extends AudioWorkletProcessor {
  p = { threshold: -18, ratio: 3, knee: 6, attack: 10, release: 150, makeup: 0, mix: 100, detector: 0, sc: 0 };
  env = 0; // smoothed gain reduction, dB (≤ 0)
  private z = new Float32Array(128);
  zero(n: number) {
    if (this.z.length < n) this.z = new Float32Array(n);
    return this.z;
  }
  rms = 0;
  minGr = 0;
  blocks = 0;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const L = inp[0], R = inp[1] ?? inp[0];
    const oL = out[0], oR = out[1] ?? out[0];
    // Sidechain: when something is connected to input 1, the detector listens to it.
    const sc = inputs[1];
    // Wired sidechain whose source is idle → the detector hears silence (never the own signal).
    const scOn = this.p.sc >= 1;
    const dL = sc && sc.length ? sc[0] : scOn ? this.zero(L.length) : L;
    const dR = sc && sc.length ? sc[1] ?? sc[0] : scOn ? this.zero(L.length) : R;
    const p = this.p, aA = coef(p.attack), aR = coef(p.release), aRms = coef(10);
    const mk = p.makeup, wet = p.mix / 100, dry = 1 - wet;
    for (let i = 0; i < L.length; i++) {
      const pk = Math.max(Math.abs(dL[i]), Math.abs(dR[i]));
      let lvl: number;
      if (p.detector >= 1) {
        this.rms = aRms * this.rms + (1 - aRms) * pk * pk;
        lvl = linToDb(Math.sqrt(this.rms));
      } else lvl = linToDb(pk);
      const gr = gainComputer(lvl, p.threshold, p.ratio, p.knee);
      this.env = gr < this.env ? aA * this.env + (1 - aA) * gr : aR * this.env + (1 - aR) * gr;
      const g = dbToLin(this.env + mk);
      oL[i] = L[i] * (dry + wet * g);
      oR[i] = R[i] * (dry + wet * g);
      if (this.env < this.minGr) this.minGr = this.env;
    }
    if (++this.blocks >= 12) {
      this.port.postMessage({ gr: [this.minGr] });
      this.blocks = 0;
      this.minGr = 0;
    }
    return true;
  }
}

/** Transposed direct-form II biquad. */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  set(type: "lp" | "hp", f: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === "lp") { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** LR4 = two cascaded Butterworth sections. */
class LR4 {
  a = new Biquad(); b = new Biquad();
  set(t: "lp" | "hp", f: number) { this.a.set(t, f); this.b.set(t, f); }
  run(x: number) { return this.b.run(this.a.run(x)); }
}

class MBComp extends AudioWorkletProcessor {
  p: Record<string, number> = { xLow: 180, xHigh: 3000, thrL: -20, thrM: -20, thrH: -20, ratioL: 3, ratioM: 2.5, ratioH: 2.5, gainL: 0, gainM: 0, gainH: 0, attack: 15, release: 200 };
  // per channel: lp1, hp1, lp2, hp2, and the all-pass (lp2+hp2) applied to the low band
  f = [0, 1].map(() => ({ lp1: new LR4(), hp1: new LR4(), lp2: new LR4(), hp2: new LR4(), apL: new LR4(), apH: new LR4() }));
  env = [0, 0, 0];
  minGr = [0, 0, 0];
  blocks = 0;
  lastX = [0, 0];
  bands: Float32Array[][] | null = null;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
    this.tune();
  }
  tune() {
    const { xLow, xHigh } = this.p;
    if (xLow === this.lastX[0] && xHigh === this.lastX[1]) return;
    this.lastX = [xLow, xHigh];
    for (const c of this.f) {
      c.lp1.set("lp", xLow); c.hp1.set("hp", xLow);
      c.lp2.set("lp", xHigh); c.hp2.set("hp", xHigh);
      c.apL.set("lp", xHigh); c.apH.set("hp", xHigh);
    }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    this.tune();
    const p = this.p, aA = coef(p.attack), aR = coef(p.release);
    const T = [p.thrL, p.thrM, p.thrH], Rt = [p.ratioL, p.ratioM, p.ratioH], G = [p.gainL, p.gainM, p.gainH];
    const n = inp[0].length, nCh = Math.min(2, inp.length);
    if (!this.bands || this.bands[0][0].length !== n) this.bands = [0, 1].map(() => [new Float32Array(n), new Float32Array(n), new Float32Array(n)]);
    const bands = this.bands;
    for (let ch = 0; ch < nCh; ch++) {
      const x = inp[ch], c = this.f[ch];
      for (let i = 0; i < n; i++) {
        const low = c.lp1.run(x[i]);
        const rest = c.hp1.run(x[i]);
        bands[ch][0][i] = c.apL.run(low) + c.apH.run(low); // all-pass at xHigh keeps phase coherent
        bands[ch][1][i] = c.lp2.run(rest);
        bands[ch][2][i] = c.hp2.run(rest);
      }
    }
    for (let i = 0; i < n; i++) {
      let sL = 0, sR = 0;
      for (let b = 0; b < 3; b++) {
        const l = bands[0][b][i], r = nCh > 1 ? bands[1][b][i] : l;
        const gr = gainComputer(linToDb(Math.max(Math.abs(l), Math.abs(r))), T[b], Rt[b], 6);
        this.env[b] = gr < this.env[b] ? aA * this.env[b] + (1 - aA) * gr : aR * this.env[b] + (1 - aR) * gr;
        if (this.env[b] < this.minGr[b]) this.minGr[b] = this.env[b];
        const g = dbToLin(this.env[b] + G[b]);
        sL += l * g;
        sR += r * g;
      }
      out[0][i] = sL;
      if (out[1]) out[1][i] = sR;
    }
    if (++this.blocks >= 12) {
      this.port.postMessage({ gr: this.minGr.slice() });
      this.blocks = 0;
      this.minGr = [0, 0, 0];
    }
    return true;
  }
}

/** Fractional delay line with linear interpolation. */
class Line {
  buf: Float32Array; w = 0;
  constructor(n: number) { this.buf = new Float32Array(Math.max(2, Math.ceil(n) + 2)); }
  write(x: number) { this.buf[this.w] = x; this.w = (this.w + 1) % this.buf.length; }
  tap(d: number) {
    const n = this.buf.length;
    let r = this.w - 1 - d;
    while (r < 0) r += n;
    const i = Math.floor(r), f = r - i;
    return this.buf[i] * (1 - f) + this.buf[(i + 1) % n] * f;
  }
}

/** Lattice all-pass on a delay line (Dattorro's diffusers). */
class AP {
  line: Line;
  constructor(public len: number, public g: number, extra = 0) { this.line = new Line(len + extra); }
  run(x: number, len = this.len) {
    const d = this.line.tap(len - 1);
    const v = x + this.g * d;
    this.line.write(v);
    return d - this.g * v;
  }
}

class Plate extends AudioWorkletProcessor {
  p = { predelay: 20, decay: 65, size: 100, damping: 35, lowcut: 150, width: 100, mix: 25 };
  k = sampleRate / 29761; // Dattorro's reference rate
  pre = new Line(0.25 * sampleRate);
  bw = 0;
  hp = 0; hpPrev = 0;
  inAP: AP[];
  // tank (allocated for size 150%)
  mA = new AP(0, 0); mB = new AP(0, 0);
  d1 = new Line(0); d2 = new Line(0); d3 = new Line(0); d4 = new Line(0);
  apA = new AP(0, 0); apB = new AP(0, 0);
  dampA = 0; dampB = 0;
  fbA = 0; fbB = 0;
  lfo = 0;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
    const k = this.k, M = 1.5 * k;
    this.inAP = [new AP(142 * k, 0.75), new AP(107 * k, 0.75), new AP(379 * k, 0.625), new AP(277 * k, 0.625)];
    this.mA = new AP(672 * M, -0.7, 32 * k);
    this.mB = new AP(908 * M, -0.7, 32 * k);
    this.d1 = new Line(4453 * M); this.d2 = new Line(3720 * M);
    this.d3 = new Line(4217 * M); this.d4 = new Line(3163 * M);
    this.apA = new AP(1800 * M, 0.5); this.apB = new AP(2656 * M, 0.5);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const L = inp[0], R = inp[1] ?? inp[0];
    const p = this.p, k = this.k, s = (p.size / 100) * k;
    const decay = Math.min(0.99, p.decay / 100), damp = p.damping / 100;
    const wet = p.mix / 100, dry = 1 - wet, width = p.width / 100;
    const preS = (p.predelay / 1000) * sampleRate;
    const hpA = Math.exp((-2 * Math.PI * p.lowcut) / sampleRate);
    const exc = 16 * k, lfoInc = (2 * Math.PI * 1.0) / sampleRate;
    for (let i = 0; i < n; i++) {
      const l = L ? L[i] : 0, r = R ? R[i] : 0;
      this.pre.write((l + r) * 0.5);
      let x = this.pre.tap(preS);
      // one-pole high-pass (low cut) then input bandwidth
      const hpo = hpA * (this.hp + x - this.hpPrev);
      this.hpPrev = x;
      this.hp = hpo;
      this.bw += 0.9995 * (hpo - this.bw);
      x = this.bw;
      for (const a of this.inAP) x = a.run(x);
      this.lfo += lfoInc;
      const m1 = Math.sin(this.lfo) * exc, m2 = Math.cos(this.lfo) * exc;
      // left branch
      let a = this.mA.run(x + this.fbB * decay, 672 * s + m1);
      this.d1.write(a);
      a = this.d1.tap(4453 * s);
      this.dampA = a * (1 - damp) + this.dampA * damp;
      a = this.apA.run(this.dampA * decay, 1800 * s);
      this.d2.write(a);
      this.fbA = this.d2.tap(3720 * s);
      // right branch
      let b = this.mB.run(x + this.fbA * decay, 908 * s + m2);
      this.d3.write(b);
      b = this.d3.tap(4217 * s);
      this.dampB = b * (1 - damp) + this.dampB * damp;
      b = this.apB.run(this.dampB * decay, 2656 * s);
      this.d4.write(b);
      this.fbB = this.d4.tap(3163 * s);
      // output taps (Dattorro table 2)
      const yl = 0.6 * (this.d3.tap(266 * s) + this.d3.tap(2974 * s) - this.apB.line.tap(1913 * s) + this.d4.tap(1996 * s) - this.d1.tap(1990 * s) - this.apA.line.tap(187 * s) - this.d2.tap(1066 * s));
      const yr = 0.6 * (this.d1.tap(353 * s) + this.d1.tap(3627 * s) - this.apA.line.tap(1228 * s) + this.d2.tap(2673 * s) - this.d3.tap(2111 * s) - this.apB.line.tap(335 * s) - this.d4.tap(121 * s));
      const mid = (yl + yr) / 2, side = ((yl - yr) / 2) * width;
      out[0][i] = l * dry + (mid + side) * wet;
      if (out[1]) out[1][i] = r * dry + (mid - side) * wet;
    }
    return true;
  }
}

/**
 * Look-ahead brickwall limiter. Required gain = min(1, ceiling / |x|) over the look-ahead window
 * (monotonic-deque sliding minimum), then a box average over the same window so gain reaches
 * its target exactly when the peak arrives (no hard steps), then a smooth release. The signal
 * is delayed by the look-ahead, so the output never exceeds the ceiling.
 */
class Limiter extends AudioWorkletProcessor {
  p = { gain: 0, ceiling: -1, release: 120, lookahead: 5, link: 1 };
  L = 0;
  delay: Float32Array[] = [];
  req: Float32Array[] = []; // required gain ring (per channel or shared)
  dq: Float64Array[] = []; // deque of sample positions (Float64: never wraps)
  dqHead = [0, 0];
  dqTail = [0, 0];
  sum = [0, 0]; // box average of the windowed minimum
  minRing: Float32Array[] = [];
  env = [1, 1];
  pos = 0;
  minGr = 0;
  blocks = 0;
  xs = [0, 0];
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => {
      Object.assign(this.p, e.data);
      this.alloc();
    };
    this.alloc();
  }
  alloc() {
    const L = Math.max(16, Math.round((this.p.lookahead / 1000) * sampleRate));
    if (L === this.L) return;
    this.L = L;
    this.delay = [new Float32Array(L), new Float32Array(L)];
    this.req = [new Float32Array(L).fill(1), new Float32Array(L).fill(1)];
    this.minRing = [new Float32Array(L).fill(1), new Float32Array(L).fill(1)];
    this.dq = [new Float64Array(2 * L + 2), new Float64Array(2 * L + 2)];
    this.dqHead = [0, 0];
    this.dqTail = [0, 0];
    this.sum = [L, L];
    this.env = [1, 1];
    this.pos = 0;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const nCh = Math.min(2, out.length);
    const L = this.L, p = this.p;
    const g = dbToLin(p.gain), ceil = dbToLin(p.ceiling);
    const rel = coef(p.release);
    const linked = p.link >= 1;
    for (let i = 0; i < n; i++) {
      const idx = this.pos % L;
      const xs = this.xs;
      const i0 = inp[0], i1 = inp[1] ?? inp[0];
      xs[0] = i0 ? i0[i] * g : 0;
      xs[1] = i1 ? i1[i] * g : 0;
      const pk = linked ? Math.max(Math.abs(xs[0]), Math.abs(xs[1])) : 0;
      for (let c = 0; c < (linked ? 1 : nCh); c++) {
        const a = linked ? pk : Math.abs(xs[c]);
        const need = a > ceil ? ceil / a : 1;
        // Sliding minimum of the last L required gains (monotonic deque of sample positions).
        // Order matters: expire first (the ring slot about to be overwritten belongs to an
        // expired position), then drop larger values from the back, then push.
        const dq = this.dq[c], cap = dq.length;
        while (this.dqTail[c] > this.dqHead[c] && this.pos - dq[this.dqHead[c] % cap] >= L) this.dqHead[c]++;
        this.req[c][idx] = need;
        while (this.dqTail[c] > this.dqHead[c] && this.req[c][dq[(this.dqTail[c] - 1) % cap] % L] >= need) this.dqTail[c]--;
        dq[this.dqTail[c]++ % cap] = this.pos;
        const wmin = this.req[c][dq[this.dqHead[c] % cap] % L];
        // box average of the windowed minimum → gain glides to its target within L samples
        this.sum[c] += wmin - this.minRing[c][idx];
        this.minRing[c][idx] = wmin;
        const target = Math.min(wmin, this.sum[c] / L);
        this.env[c] = target < this.env[c] ? target : rel * this.env[c] + (1 - rel) * target;
        if (linked) this.env[1] = this.env[0];
      }
      for (let c = 0; c < nCh; c++) {
        const d = this.delay[c][idx];
        this.delay[c][idx] = xs[c];
        out[c][i] = Math.max(-ceil, Math.min(ceil, d * this.env[linked ? 0 : c])); // final safety clip at the ceiling
      }
      const grDb = linToDb(Math.min(this.env[0], this.env[1]));
      if (grDb < this.minGr) this.minGr = grDb;
      this.pos++;
    }
    if (++this.blocks >= 6) {
      this.port.postMessage({ gr: [this.minGr] });
      this.blocks = 0;
      this.minGr = 0;
    }
    return true;
  }
}

/** Recorder: forwards raw input PCM (batched ~85 ms) with the context frame it started at. */
class Recorder extends AudioWorkletProcessor {
  bufL = new Float32Array(4096);
  bufR = new Float32Array(4096);
  n = 0;
  start = -1;
  constructor() {
    super();
    this.port.onmessage = () => this.n && this.flush(); // "flush" on stop: deliver the tail
  }
  process(inputs: Float32Array[][]) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] ?? inp[0];
    if (this.start < 0) this.start = currentFrame;
    for (let i = 0; i < L.length; i++) {
      this.bufL[this.n] = L[i];
      this.bufR[this.n] = R[i];
      if (++this.n === this.bufL.length) this.flush();
    }
    return true;
  }
  flush() {
    const l = this.bufL.slice(0, this.n), r = this.bufR.slice(0, this.n);
    this.port.postMessage({ frame: this.start, l, r }, [l.buffer, r.buffer]);
    this.start += this.n;
    this.n = 0;
  }
}

/**
 * Transient designer (SPL-style, level independent): attack = where a fast envelope leads a slow
 * one (the first ~20 ms of a hit), sustain = where a long-release envelope leads a short-release
 * one (the decay). gain(dB) = attack% × lead + sustain% × lag, stereo-linked, smoothed.
 */
class Transient extends AudioWorkletProcessor {
  p = { attack: 0, sustain: 0, output: 0 };
  fast = 0; slow = 0; susLong = 0; susShort = 0; g = 0; minGr = 0; maxGr = 0; blocks = 0;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    if (!inp.length) {
      for (const o of out) o.fill(0);
      return true;
    }
    const L = inp[0], R = inp[1] ?? inp[0];
    const fa = coef(0.3), fr = coef(20), sa = coef(20), sr = coef(20);
    const la = coef(0.3), lr = coef(250), ha = coef(0.3), hr = coef(25), gs = coef(1);
    const ka = this.p.attack / 100, ks = this.p.sustain / 100, outG = dbToLin(this.p.output);
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.fast = x > this.fast ? fa * this.fast + (1 - fa) * x : fr * this.fast + (1 - fr) * x;
      this.slow = x > this.slow ? sa * this.slow + (1 - sa) * x : sr * this.slow + (1 - sr) * x;
      this.susLong = x > this.susLong ? la * this.susLong + (1 - la) * x : lr * this.susLong + (1 - lr) * x;
      this.susShort = x > this.susShort ? ha * this.susShort + (1 - ha) * x : hr * this.susShort + (1 - hr) * x;
      let gt = 0;
      if (this.susLong > 1e-5) {
        const lead = Math.min(20, Math.max(0, linToDb(this.fast) - linToDb(this.slow)));
        const lag = Math.min(24, Math.max(0, linToDb(this.susLong) - linToDb(this.susShort)));
        gt = Math.max(-24, Math.min(18, ka * lead + ks * lag * 0.8));
      }
      this.g = gs * this.g + (1 - gs) * gt;
      if (this.g < this.minGr) this.minGr = this.g;
      if (this.g > this.maxGr) this.maxGr = this.g;
      const gl = dbToLin(this.g) * outG;
      out[0][i] = L[i] * gl;
      if (out[1]) out[1][i] = R[i] * gl;
    }
    if (++this.blocks >= 12) {
      this.port.postMessage({ gr: [Math.abs(this.minGr) > this.maxGr ? this.minGr : this.maxGr] });
      this.blocks = 0;
      this.minGr = 0;
      this.maxGr = 0;
    }
    return true;
  }
}

/* ── Airwindows ports (MIT, © Chris Johnson — github.com/airwindows/airwindows) ──────────────
 * Line-for-line from the float processReplacing paths; Airwindows' denormal noise and 32-bit
 * dither are left out (not needed in Web Audio's float pipeline). Parameters are Airwindows'
 * own 0…1 controls. */
const awIn = (inputs: Float32Array[][]) => {
  const i = inputs[0];
  return i.length ? [i[0], i[1] ?? i[0]] : null;
};

/** ButterComp2: program-dependent "bi-polar, interleaved" compressor. A compress · B output · C dry/wet. */
class ButterComp2 extends AudioWorkletProcessor {
  p = { compress: 0.3, output: 0.5, mix: 1 };
  s = [0, 1].map(() => ({ cAp: 1, cAn: 1, cBp: 1, cBn: 1, tp: 1, tn: 1, last: 0 }));
  flip = false;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = awIn(inputs), out = outputs[0];
    if (!inp) { for (const o of out) o.fill(0); return true; }
    const overallscale = sampleRate / 44100, A = this.p.compress;
    const inputgain = Math.pow(10, (A * 14) / 20), compfactor = 0.012 * (A / 135), output = this.p.output * 2, wet = this.p.mix;
    const outputgain = (inputgain - 1) / 1.5 + 1;
    for (let i = 0; i < out[0].length; i++) {
      for (let c = 0; c < 2; c++) {
        const st = this.s[c], dry = inp[c][i];
        let x = dry * inputgain;
        let divisor = compfactor / (1 + Math.abs(st.last)) / overallscale;
        const remainder = divisor;
        divisor = 1 - divisor;
        let inputpos = x + 1; if (inputpos < 0) inputpos = 0;
        let outputpos = inputpos / 2; if (outputpos > 1) outputpos = 1;
        inputpos *= inputpos;
        st.tp = st.tp * divisor + inputpos * remainder;
        const calcpos = Math.pow(1 / st.tp, 2);
        let inputneg = -x + 1; if (inputneg < 0) inputneg = 0;
        let outputneg = inputneg / 2; if (outputneg > 1) outputneg = 1;
        inputneg *= inputneg;
        st.tn = st.tn * divisor + inputneg * remainder;
        const calcneg = Math.pow(1 / st.tn, 2);
        if (x > 0) {
          if (this.flip) st.cAp = st.cAp * divisor + calcpos * remainder;
          else st.cBp = st.cBp * divisor + calcpos * remainder;
        } else if (this.flip) st.cAn = st.cAn * divisor + calcneg * remainder;
        else st.cBn = st.cBn * divisor + calcneg * remainder;
        const total = this.flip ? st.cAp * outputpos + st.cAn * outputneg : st.cBp * outputpos + st.cBn * outputneg;
        x = (x * total) / outputgain;
        if (output !== 1) x *= output;
        if (wet !== 1) x = x * wet + dry * (1 - wet);
        st.last = x;
        if (out[c]) out[c][i] = x;
      }
      this.flip = !this.flip;
    }
    return true;
  }
}

/** Density2: density/drive (negative = "starved"), highpass, output, dry/wet. */
class Density2 extends AudioWorkletProcessor {
  p = { density: 0.2, highpass: 0, output: 1, mix: 1 };
  s = [0, 1].map(() => ({ ataA: 0, ataB: 0, ataC: 0, lastDiff: 0, iirA: 0, iirB: 0, l1: 0, l2: 0, l3: 0 }));
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = awIn(inputs), out = outputs[0];
    if (!inp) { for (const o of out) o.fill(0); return true; }
    const overallscale = sampleRate / 44100;
    let density = this.p.density * 5 - 1;
    let o = Math.abs(density);
    while (o > 1) o -= 1;
    density = density * Math.abs(density);
    const iirAmount = Math.pow(this.p.highpass, 3) / overallscale, output = this.p.output, wet = this.p.mix;
    const shape = (v: number) => {
      let count = density;
      while (count > 1) {
        let b = Math.abs(v) * 1.57079633; if (b > 1.57079633) b = 1.57079633;
        b = Math.sin(b);
        v = v > 0 ? b : -b;
        count -= 1;
      }
      let b = Math.abs(v) * 1.57079633; if (b > 1.57079633) b = 1.57079633;
      b = density > 0 ? Math.sin(b) : 1 - Math.cos(b);
      return v > 0 ? v * (1 - o) + b * o : v * (1 - o) - b * o;
    };
    for (let i = 0; i < out[0].length; i++)
      for (let c = 0; c < 2; c++) {
        const st = this.s[c], dry = inp[c][i];
        let x = dry;
        let half = (x + st.l1 + (-st.l2 + st.l3) * 0.0414213562373095) / 2;
        const halfDry = half;
        st.l3 = st.l2; st.l2 = st.l1; st.l1 = x;
        st.iirB = st.iirB * (1 - iirAmount) + half * iirAmount; half -= st.iirB;
        half = shape(half);
        st.ataC = half - halfDry;
        st.ataA *= 0.915965594177219; st.ataB *= 0.915965594177219;
        st.ataB += st.ataC; st.ataA -= st.ataC; st.ataC = st.ataB;
        const halfDiff = st.ataC * 0.915965594177219;
        st.iirA = st.iirA * (1 - iirAmount) + x * iirAmount; x -= st.iirA;
        x = shape(x);
        st.ataC = x - dry;
        st.ataA *= 0.915965594177219; st.ataB *= 0.915965594177219;
        st.ataA += st.ataC; st.ataB -= st.ataC; st.ataC = st.ataA;
        const diff = st.ataC * 0.915965594177219;
        x = dry + (diff + halfDiff + st.lastDiff) / 1.187;
        st.lastDiff = diff / 2;
        x *= output;
        x = dry * (1 - wet) + x * wet;
        if (out[c]) out[c][i] = x;
      }
    return true;
  }
}

/** Galactic: huge lush reverb (3 × 4-line FDN, vibrato pre-delay). A replace · B brightness · C detune · D bigness · E dry/wet. */
class Galactic extends AudioWorkletProcessor {
  p = { replace: 0.5, brightness: 0.5, detune: 0.5, bigness: 1, mix: 1 };
  bufs = [6480, 3660, 1720, 680, 9700, 6000, 2320, 940, 15220, 8460, 4540, 3200].map((n) => [new Float64Array(n), new Float64Array(n)]); // I J K L A B C D E F G H
  cnt = new Int32Array(12).fill(1);
  aM = [new Float64Array(3111), new Float64Array(3111)];
  countM = 1;
  fb = [new Float64Array(4), new Float64Array(4)];
  iirA = [0, 0]; iirB = [0, 0];
  lastRef = [new Float64Array(7), new Float64Array(7)];
  cycle = 0; vibM = 3; oldfpd = 429496.7295; fpd = 17;
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0], n = out[0].length;
    const inp = awIn(inputs);
    const overallscale = sampleRate / 44100;
    const cycleEnd = Math.max(1, Math.min(4, Math.floor(overallscale)));
    if (this.cycle > cycleEnd - 1) this.cycle = cycleEnd - 1;
    const P = this.p, regen = 0.0625 + (1 - P.replace) * 0.0625, attenuate = (1 - regen / 0.125) * 1.333;
    const lowpass = Math.pow(1.00001 - (1 - P.brightness), 2) / Math.sqrt(overallscale);
    const drift = Math.pow(P.detune, 3) * 0.001, size = P.bigness * 1.77 + 0.1, wet = 1 - Math.pow(1 - P.mix, 3);
    const D = [3407, 1823, 859, 331, 4801, 2909, 1153, 461, 7607, 4217, 2269, 1597].map((d) => Math.floor(d * size));
    const delayM = 256;
    const read = (k: number, ch: number) => { const c = this.cnt[k]; return this.bufs[k][ch][c - (c > D[k] ? D[k] + 1 : 0)]; };
    const adv = (k: number) => { this.cnt[k]++; if (this.cnt[k] < 0 || this.cnt[k] > D[k]) this.cnt[k] = 0; };
    for (let i = 0; i < n; i++) {
      const dryL = inp ? inp[0][i] : 0, dryR = inp ? inp[1][i] : 0;
      this.vibM += this.oldfpd * drift;
      if (this.vibM > Math.PI * 2) {
        this.vibM = 0;
        this.fpd ^= this.fpd << 13; this.fpd ^= this.fpd >>> 17; this.fpd ^= this.fpd << 5; this.fpd >>>= 0;
        this.oldfpd = 0.4294967295 + this.fpd * 0.0000000000618;
      }
      this.aM[0][this.countM] = dryL * attenuate;
      this.aM[1][this.countM] = dryR * attenuate;
      this.countM++; if (this.countM < 0 || this.countM > delayM) this.countM = 0;
      const xs = [0, 0];
      for (let ch = 0; ch < 2; ch++) {
        const off = (Math.sin(this.vibM + (ch ? Math.PI / 2 : 0)) + 1) * 127;
        const w = this.countM + Math.floor(off), fr = off - Math.floor(off), a = this.aM[ch];
        let v = a[w - (w > delayM ? delayM + 1 : 0)] * (1 - fr) + a[w + 1 - (w + 1 > delayM ? delayM + 1 : 0)] * fr;
        this.iirA[ch] = this.iirA[ch] * (1 - lowpass) + v * lowpass; v = this.iirA[ch];
        xs[ch] = v;
      }
      this.cycle++;
      if (this.cycle === cycleEnd) {
        for (let ch = 0; ch < 2; ch++) {
          const o = 1 - ch, fbo = this.fb[o]; // cross-fed: L block takes the R feedback
          for (let k = 0; k < 4; k++) this.bufs[k][ch][this.cnt[k]] = xs[ch] + fbo[k] * regen;
        }
        for (let k = 0; k < 4; k++) adv(k);
        for (let ch = 0; ch < 2; ch++) {
          const I = read(0, ch), J = read(1, ch), K = read(2, ch), L = read(3, ch);
          this.bufs[4][ch][this.cnt[4]] = I - (J + K + L);
          this.bufs[5][ch][this.cnt[5]] = J - (I + K + L);
          this.bufs[6][ch][this.cnt[6]] = K - (I + J + L);
          this.bufs[7][ch][this.cnt[7]] = L - (I + J + K);
        }
        for (let k = 4; k < 8; k++) adv(k);
        for (let ch = 0; ch < 2; ch++) {
          const A = read(4, ch), B = read(5, ch), C = read(6, ch), Dd = read(7, ch);
          this.bufs[8][ch][this.cnt[8]] = A - (B + C + Dd);
          this.bufs[9][ch][this.cnt[9]] = B - (A + C + Dd);
          this.bufs[10][ch][this.cnt[10]] = C - (A + B + Dd);
          this.bufs[11][ch][this.cnt[11]] = Dd - (A + B + C);
        }
        for (let k = 8; k < 12; k++) adv(k);
        for (let ch = 0; ch < 2; ch++) {
          const E = read(8, ch), F = read(9, ch), G = read(10, ch), H = read(11, ch);
          const f = this.fb[ch];
          f[0] = E - (F + G + H); f[1] = F - (E + G + H); f[2] = G - (E + F + H); f[3] = H - (E + F + G);
          const v = (E + F + G + H) / 8, r = this.lastRef[ch];
          if (cycleEnd === 4) { r[0] = r[4]; r[2] = (r[0] + v) / 2; r[1] = (r[0] + r[2]) / 2; r[3] = (r[2] + v) / 2; r[4] = v; }
          else if (cycleEnd === 3) { r[0] = r[3]; r[2] = (r[0] + r[0] + v) / 3; r[1] = (r[0] + v + v) / 3; r[3] = v; }
          else if (cycleEnd === 2) { r[0] = r[2]; r[1] = (r[0] + v) / 2; r[2] = v; }
          else r[0] = v;
        }
        this.cycle = 0;
      }
      for (let ch = 0; ch < 2; ch++) {
        let v = this.lastRef[ch][this.cycle];
        this.iirB[ch] = this.iirB[ch] * (1 - lowpass) + v * lowpass; v = this.iirB[ch];
        const dry = ch ? dryR : dryL;
        if (wet < 1) v = v * wet + dry * (1 - wet);
        if (out[ch]) out[ch][i] = v;
      }
    }
    return true;
  }
}

/** ClipOnly2: transparent soft clipper at −0.2 dB (only acts on overs). Input drive + output added. */
class ClipOnly2 extends AudioWorkletProcessor {
  p = { drive: 0, output: 0 };
  s = [0, 1].map(() => ({ last: 0, pos: false, neg: false, im: new Float64Array(17) }));
  constructor(o?: Init) {
    super();
    if (o?.processorOptions?.params) Object.assign(this.p, o.processorOptions.params);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = awIn(inputs), out = outputs[0];
    if (!inp) { for (const o of out) o.fill(0); return true; }
    const spacing = Math.max(1, Math.min(16, Math.floor(sampleRate / 44100)));
    const gin = dbToLin(this.p.drive), gout = dbToLin(this.p.output);
    for (let i = 0; i < out[0].length; i++)
      for (let c = 0; c < 2; c++) {
        const st = this.s[c];
        let x = inp[c][i] * gin;
        if (x > 4) x = 4; if (x < -4) x = -4;
        if (st.pos) st.last = x < st.last ? 0.7058208 + x * 0.2609148 : 0.2491717 + st.last * 0.7390851;
        st.pos = false;
        if (x > 0.9549925859) { st.pos = true; x = 0.7058208 + st.last * 0.2609148; }
        if (st.neg) st.last = x > st.last ? -0.7058208 + x * 0.2609148 : -0.2491717 + st.last * 0.7390851;
        st.neg = false;
        if (x < -0.9549925859) { st.neg = true; x = -0.7058208 + st.last * 0.2609148; }
        st.im[spacing] = x;
        x = st.last;
        for (let k = spacing; k > 0; k--) st.im[k - 1] = st.im[k];
        st.last = st.im[0];
        if (out[c]) out[c][i] = x * gout;
      }
    return true;
  }
}

registerProcessor("aw-buttercomp2", ButterComp2);
registerProcessor("aw-density2", Density2);
registerProcessor("aw-galactic", Galactic);
registerProcessor("aw-cliponly2", ClipOnly2);
registerProcessor("otpadn-transient", Transient);
registerProcessor("otpadn-comp", Comp);
registerProcessor("otpadn-recorder", Recorder);
registerProcessor("otpadn-limiter", Limiter);
registerProcessor("otpadn-mbcomp", MBComp);
registerProcessor("otpadn-plate", Plate);
