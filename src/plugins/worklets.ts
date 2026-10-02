/**
 * AudioWorklet DSP for Otpadn's insert plugins (MIT, our own code):
 *  - otpadn-comp:     soft-knee feed-forward compressor, peak/RMS, stereo-linked, parallel mix
 *  - otpadn-mbcomp:   3-band compressor on Linkwitz-Riley LR4 crossovers with all-pass phase compensation
 *  - otpadn-plate:    Dattorro plate reverb (1997 "Effect Design" topology), modulated tank
 * Parameters arrive over the MessagePort; meters (gain reduction) go back the same way.
 */
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
  constructor() {
    super();
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
  constructor() {
    super();
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
  constructor() {
    super();
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
  constructor() {
    super();
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

registerProcessor("otpadn-comp", Comp);
registerProcessor("otpadn-recorder", Recorder);
registerProcessor("otpadn-limiter", Limiter);
registerProcessor("otpadn-mbcomp", MBComp);
registerProcessor("otpadn-plate", Plate);
