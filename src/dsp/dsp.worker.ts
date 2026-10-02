/// <reference lib="webworker" />
/**
 * Heavy DSP that runs off the main thread:
 *  - "sep":   STFT stem separation for one time-chunk (HPSS + stereo-coherence masks)
 *             plus per-frame features (onset flux, low-band flux, energy, chroma).
 *  - "peaks": waveform min/max peaks for drawing.
 *  - "lufs":  ITU-R BS.1770 integrated loudness.
 *
 * Separation runs chunked across a worker pool; each chunk receives enough
 * surrounding audio (MARGIN frames) that stitched results equal a single pass.
 */
import { FFT, medianInPlace } from "./fft";

declare const self: DedicatedWorkerGlobalScope;

export const MARGIN = 8; // frames of context each side (= half the HPSS time kernel)
const KERNEL = 2 * MARGIN + 1;

export interface SepRequest {
  type: "sep";
  jobId: number;
  sr: number;
  N: number;
  hop: number;
  totalLen: number;
  t0: number;
  t1: number;
  sampleStart: number;
  left: Float32Array;
  right: Float32Array;
  /** Only compute analysis features (tempo/key/chords/sections), skip stem resynthesis. */
  featuresOnly?: boolean;
}

export interface SepResult {
  type: "sep";
  jobId: number;
  t0: number;
  t1: number;
  outStart: number;
  stems: { drums: [Float32Array, Float32Array]; bass: [Float32Array, Float32Array]; vocals: [Float32Array, Float32Array]; other: [Float32Array, Float32Array] };
  onset: Float32Array;
  lowOnset: Float32Array;
  energy: Float32Array;
  chroma: Float32Array; // 12 per frame
  bassChroma: Float32Array; // 12 per frame, 30-250 Hz harmonic content
}

const fftCache = new Map<number, FFT>();
const getFFT = (n: number) => {
  let f = fftCache.get(n);
  if (!f) fftCache.set(n, (f = new FFT(n)));
  return f;
};

export function separate(req: SepRequest): SepResult {
  const { sr, N, hop, totalLen, t0, t1, sampleStart, left, right } = req;
  const K = N / 2 + 1;
  const T = Math.ceil(totalLen / hop) + 1;
  const fa = Math.max(0, t0 - MARGIN);
  const fb = Math.min(T, t1 + MARGIN);
  const F = fb - fa;
  const fft = getFFT(N);

  const win = new Float64Array(N);
  for (let n = 0; n < N; n++) win[n] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));

  // Per-bin static weights.
  const binHz = sr / N;
  const bassW = new Float32Array(K);
  const band = new Float32Array(K);
  const pcBin = new Int8Array(K).fill(-1);
  const bassPc = new Int8Array(K).fill(-1);
  for (let k = 0; k < K; k++) {
    const f = k * binHz;
    bassW[k] = f < 110 ? 1 : f > 220 ? 0 : 1 - (f - 110) / 110;
    band[k] = f < 120 ? 0 : f < 220 ? (f - 120) / 100 : f < 7000 ? 1 : f < 12000 ? 1 - (0.7 * (f - 7000)) / 5000 : 0.3;
    if (f >= 30 && f <= 250) bassPc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
    if (f >= 80 && f <= 2100) pcBin[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
  }

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float32Array(F * K);
  const coh = new Float32Array(F * K);

  const loadFrame = (t: number) => {
    const g0 = t * hop - N / 2;
    for (let n = 0; n < N; n++) {
      const g = g0 + n;
      const l = g - sampleStart;
      if (g >= 0 && g < totalLen && l >= 0 && l < left.length) {
        re[n] = left[l] * win[n];
        im[n] = right[l] * win[n];
      } else {
        re[n] = 0;
        im[n] = 0;
      }
    }
    fft.transform(re, im);
  };

  // Pass 1: mid magnitude + L/R coherence for all frames incl. margins.
  for (let t = fa; t < fb; t++) {
    loadFrame(t);
    const row = (t - fa) * K;
    for (let k = 0; k < K; k++) {
      const nk = (N - k) % N;
      const a = re[k], b = im[k], c = re[nk], d = im[nk];
      const lr = (a + c) / 2, li = (b - d) / 2;
      const rr = (b + d) / 2, ri = -(a - c) / 2;
      const mr = (lr + rr) / 2, mi = (li + ri) / 2;
      mag[row + k] = Math.sqrt(mr * mr + mi * mi);
      const pl = lr * lr + li * li;
      const pr = rr * rr + ri * ri;
      const cross = lr * rr + li * ri; // Re(L * conj(R))
      const cc = (2 * cross) / (pl + pr + 1e-12);
      coh[row + k] = cc > 0 ? cc : 0;
    }
  }

  // Pass 2: masks + resynthesis + features for the chunk's own frames.
  const outStart = t0 * hop - N / 2;
  const outLen = req.featuresOnly ? 0 : (t1 - 1 - t0) * hop + N;
  const mk = () => [new Float32Array(outLen), new Float32Array(outLen)] as [Float32Array, Float32Array];
  const stems = { drums: mk(), bass: mk(), vocals: mk(), other: mk() };
  const masks = { drums: new Float32Array(K), bass: new Float32Array(K), vocals: new Float32Array(K), other: new Float32Array(K) };
  const names = ["drums", "bass", "vocals", "other"] as const;
  const zr = new Float64Array(N);
  const zi = new Float64Array(N);
  const scratch = new Float32Array(KERNEL);
  const nOwn = t1 - t0;
  const onset = new Float32Array(nOwn);
  const lowOnset = new Float32Array(nOwn);
  const energy = new Float32Array(nOwn);
  const chroma = new Float32Array(nOwn * 12);
  const bassChroma = new Float32Array(nOwn * 12);
  const lowBins = Math.ceil(200 / binHz);
  const olaScale = 1 / (N * 2); // unscaled IFFT (1/N) and sqrt-hann^2 overlap sum of 2 at hop N/4

  for (let t = t0; t < t1; t++) {
    const row = (t - fa) * K;
    const ti = t - t0;
    for (let k = 0; k < K; k++) {
      // Percussive: median across frequency. Harmonic: median across time.
      let n = 0;
      for (let j = k - MARGIN; j <= k + MARGIN; j++) scratch[n++] = j < 0 || j >= K ? 0 : mag[row + j];
      const P = medianInPlace(scratch, n);
      n = 0;
      for (let j = t - MARGIN; j <= t + MARGIN; j++) scratch[n++] = j < fa || j >= fb ? 0 : mag[(j - fa) * K + k];
      const H = medianInPlace(scratch, n);
      // Harmonic bias (margin 2): dense sustained spectra (saw pads, distorted guitars)
      // would otherwise leak into drums; real transients still have P >> H.
      const p = (P * P) / (P * P + 4 * H * H + 1e-12);
      const h = 1 - p;
      let c = coh[row + k];
      c = c * c;
      c = c * c;
      c = c * c; // ^8: only near-centre content counts as "vocal"
      const v = c * band[k];
      masks.drums[k] = p;
      masks.bass[k] = h * bassW[k];
      masks.vocals[k] = h * (1 - bassW[k]) * v;
      masks.other[k] = h * (1 - bassW[k]) * (1 - v);

      // Features.
      const m = mag[row + k];
      energy[ti] += m * m;
      if (t > fa) {
        const prev = mag[row - K + k];
        const d = Math.log1p(100 * m) - Math.log1p(100 * prev);
        if (d > 0) {
          onset[ti] += d;
          if (k < lowBins) lowOnset[ti] += d;
        }
      }
      const pc = pcBin[k];
      if (pc >= 0) chroma[ti * 12 + pc] += h * m;
      const bpc = bassPc[k];
      if (bpc >= 0) bassChroma[ti * 12 + bpc] += h * m;
    }

    if (req.featuresOnly) continue;
    loadFrame(t);
    const g0 = t * hop - N / 2 - outStart;
    for (const name of names) {
      const msk = masks[name];
      for (let k = 0; k < N; k++) {
        const w = msk[k <= N / 2 ? k : N - k];
        zr[k] = re[k] * w;
        zi[k] = im[k] * w;
      }
      fft.transform(zr, zi, true);
      const [oL, oR] = stems[name];
      for (let n = 0; n < N; n++) {
        const s = win[n] * olaScale;
        oL[g0 + n] += zr[n] * s;
        oR[g0 + n] += zi[n] * s;
      }
    }
    if ((t - t0) % 200 === 0) self.postMessage({ type: "progress", jobId: req.jobId, done: t - t0, total: nOwn });
  }

  return { type: "sep", jobId: req.jobId, t0, t1, outStart, stems, onset, lowOnset, energy, chroma, bassChroma };
}

function peaks(data: Float32Array[], block: number): Float32Array {
  const len = data[0].length;
  const nb = Math.ceil(len / block);
  const out = new Float32Array(nb * 2);
  for (let b = 0; b < nb; b++) {
    let mn = 0, mx = 0;
    const end = Math.min(len, (b + 1) * block);
    for (let i = b * block; i < end; i++) {
      let s = 0;
      for (const ch of data) s += ch[i];
      s /= data.length;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

/** RBJ biquad, direct form I, applied in place on a copy. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function kWeight(x: Float32Array, sr: number): Float32Array {
  // Stage 1: high shelf +4 dB @ 1500 Hz (pyloudnorm parametrisation).
  {
    const G = 4, Q = 1 / Math.SQRT2, fc = 1500;
    const A = Math.pow(10, G / 40);
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cw = Math.cos(w0);
    const sA = 2 * Math.sqrt(A) * alpha;
    const b0 = A * (A + 1 + (A - 1) * cw + sA);
    const b1 = -2 * A * (A - 1 + (A + 1) * cw);
    const b2 = A * (A + 1 + (A - 1) * cw - sA);
    const a0 = A + 1 - (A - 1) * cw + sA;
    const a1 = 2 * (A - 1 - (A + 1) * cw);
    const a2 = A + 1 - (A - 1) * cw - sA;
    x = biquad(x, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }
  // Stage 2: high pass @ 38 Hz, Q 0.5.
  {
    const Q = 0.5, fc = 38;
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    x = biquad(x, (1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - alpha) / a0);
  }
  return x;
}

export function lufs(channels: Float32Array[], sr: number): number {
  const kw = channels.map((c) => kWeight(c, sr));
  const block = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const z: number[] = [];
  for (let s = 0; s + block <= kw[0].length; s += step) {
    let sum = 0;
    for (const ch of kw) {
      let acc = 0;
      for (let i = s; i < s + block; i++) acc += ch[i] * ch[i];
      sum += acc / block;
    }
    z.push(sum);
  }
  const L = (v: number) => -0.691 + 10 * Math.log10(v + 1e-20);
  const abs = z.filter((v) => L(v) > -70);
  if (!abs.length) return -Infinity;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((v) => L(v) > L(meanAbs) - 10);
  if (!rel.length) return -Infinity;
  return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** 24-bit PCM WAV. */
export function encodeWav(chans: Float32Array[], sr: number): ArrayBuffer {
  const ch = chans.length, len = chans[0].length;
  const bytes = 3;
  const data = new DataView(new ArrayBuffer(44 + len * ch * bytes));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + len * ch * bytes, true);
  str(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, sr, true);
  data.setUint32(28, sr * ch * bytes, true);
  data.setUint16(32, ch * bytes, true);
  data.setUint16(34, 24, true);
  str(36, "data");
  data.setUint32(40, len * ch * bytes, true);
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      const x = Math.round(v * 8388607);
      data.setUint8(o, x & 0xff);
      data.setUint8(o + 1, (x >> 8) & 0xff);
      data.setUint8(o + 2, (x >> 16) & 0xff);
      o += 3;
    }
  return data.buffer;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "sep") {
    const res = separate(msg as SepRequest);
    const s = res.stems;
    self.postMessage(res, [
      ...s.drums, ...s.bass, ...s.vocals, ...s.other,
      res.onset.buffer, res.lowOnset.buffer, res.energy.buffer, res.chroma.buffer, res.bassChroma.buffer,
    ].map((a) => (a instanceof Float32Array ? a.buffer : a)) as ArrayBuffer[]);
  } else if (msg.type === "peaks") {
    const out = peaks(msg.data, msg.block);
    self.postMessage({ type: "peaks", jobId: msg.jobId, peaks: out }, [out.buffer]);
  } else if (msg.type === "wav") {
    const out = encodeWav(msg.channels, msg.sr);
    self.postMessage({ type: "wav", jobId: msg.jobId, data: out }, [out]);
  } else if (msg.type === "lufs") {
    self.postMessage({ type: "lufs", jobId: msg.jobId, lufs: lufs(msg.channels, msg.sr) });
  }
};
