/**
 * Match EQ: a 31-band (1/3-octave, 20 Hz–20 kHz) target curve turned into one minimum-phase FIR,
 * run by a native ConvolverNode. Minimum phase (via the real cepstrum) keeps kick/snare
 * transients free of the pre-ringing a linear-phase match would add. Curves are fitted offline
 * against a reference (see model/mixStyles.ts), or drawn by hand.
 */
import { FFT } from "../dsp/fft";

export const MATCH_BANDS = 31;
export const MATCH_FC = Array.from({ length: MATCH_BANDS }, (_, k) => 1000 * Math.pow(2, (k - 17) / 3));

/** Gain (dB) at frequency f, interpolated over log-frequency between band centres. */
export function matchGainAt(gains: number[], f: number): number {
  const x = Math.log2(Math.max(1, f) / 1000) * 3 + 17;
  if (x <= 0) return gains[0];
  if (x >= MATCH_BANDS - 1) return gains[MATCH_BANDS - 1];
  const i = Math.floor(x), t = x - i;
  return gains[i] * (1 - t) + gains[i + 1] * t;
}

const N = 16384; // 170 ms impulse at 48 kHz: resolves single low bands (a 1/3 octave at 100 Hz is 23 Hz wide)
let fft: FFT | null = null;

/** Minimum-phase impulse response for the curve (gains in dB per band). */
export function matchImpulse(sampleRate: number, gains: number[]): Float32Array {
  fft ??= new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  // log-magnitude on the full (symmetric) spectrum
  for (let k = 0; k <= N / 2; k++) {
    const g = matchGainAt(gains, (k * sampleRate) / N);
    re[k] = (g / 20) * Math.LN10;
    if (k > 0 && k < N / 2) re[N - k] = re[k];
  }
  // real cepstrum → fold to the causal (minimum-phase) cepstrum
  fft.transform(re, im, true);
  for (let n = 0; n < N; n++) {
    re[n] /= N;
    im[n] = 0;
  }
  for (let n = 1; n < N / 2; n++) re[n] *= 2;
  for (let n = N / 2 + 1; n < N; n++) re[n] = 0;
  // back to the spectrum, exponentiate, inverse → impulse
  fft.transform(re, im);
  for (let k = 0; k < N; k++) {
    const mag = Math.exp(re[k]), ph = im[k];
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
  }
  fft.transform(re, im, true);
  const L = N / 2, out = new Float32Array(L);
  const fade = L / 4;
  for (let n = 0; n < L; n++) out[n] = (re[n] / N) * (n > L - fade ? 0.5 + 0.5 * Math.cos((Math.PI * (n - (L - fade))) / fade) : 1);
  return out;
}
