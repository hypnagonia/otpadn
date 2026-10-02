/** Tempo, beat phase and downbeat from onset envelopes. */
import type { Features } from "../dsp/pool";
import { chromaRange, cos } from "./grid";

export interface TempoResult {
  bpm: number;
  downbeatSec: number; // first downbeat in the audio file
  confidence: number;
}

function normalizedOnset(f: Features, src: Float32Array): Float32Array {
  const n = src.length;
  const w = Math.round(f.fps * 0.5);
  const out = new Float32Array(n);
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    const v = src[i] - mean;
    out[i] = v > 0 ? v : 0;
    acc += out[i];
  }
  const m = acc / n || 1;
  for (let i = 0; i < n; i++) out[i] /= m;
  return out;
}

const interp = (a: Float32Array, x: number) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return 0;
  const fr = x - i;
  return a[i] * (1 - fr) + a[i + 1] * fr;
};

function combScore(env: Float32Array, period: number): { score: number; phase: number } {
  let best = -1, bestPhase = 0;
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0, c = 0;
    for (let x = ph; x < env.length; x += period) {
      s += interp(env, x);
      c++;
    }
    s /= c || 1;
    if (s > best) {
      best = s;
      bestPhase = ph;
    }
  }
  return { score: best, phase: bestPhase };
}

export function estimateTempo(f: Features): TempoResult {
  const env = normalizedOnset(f, f.onset);
  const fps = f.fps;
  // Too short to see two bars at 60 BPM: fall back to a neutral grid.
  if (env.length < fps * 8) return { bpm: 120, downbeatSec: 0, confidence: 0 };
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 60);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }
  let bestLag = minLag, bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    const v = ac[lag] * w;
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }
  // Octave check: kick-on-1-and-3 grooves make half-time look strongest.
  if ((60 * fps) / bestLag < 82) {
    const half = Math.round(bestLag / 2);
    let hv = 0, hl = half;
    for (let l = half - 1; l <= half + 1; l++) if (ac[l] > hv) { hv = ac[l]; hl = l; }
    if (hv > 0.35 * ac[bestLag]) bestLag = hl;
  }
  // Parabolic refinement.
  const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
  const den = y0 - 2 * y1 + y2;
  const lagF = den !== 0 ? bestLag + (0.5 * (y0 - y2)) / den : bestLag;
  const bpm0 = (60 * fps) / lagF;

  // Fine search with comb filter (also finds beat phase).
  let best = { bpm: bpm0, score: -1, phase: 0 };
  for (let bpm = bpm0 * 0.98; bpm <= bpm0 * 1.02; bpm += 0.02) {
    const r = combScore(env, (60 * fps) / bpm);
    if (r.score > best.score) best = { bpm, score: r.score, phase: r.phase };
  }
  const rounded = Math.round(best.bpm);
  if (Math.abs(rounded - best.bpm) < 0.25) {
    const r = combScore(env, (60 * fps) / rounded);
    if (r.score >= best.score * 0.97) best = { bpm: rounded, score: r.score, phase: r.phase };
  }
  const period = (60 * fps) / best.bpm;

  // Downbeat: which of the 4 beat phases has (a) the most low-frequency onset energy
  // (kicks) and (b) the most harmonic change (chords tend to change on the "1").
  const low = normalizedOnset(f, f.lowOnset);
  const kickScore = [0, 0, 0, 0];
  const chordScore = [0, 0, 0, 0];
  const nBeats = Math.floor((low.length - best.phase) / period);
  let prevChroma: number[] | null = null;
  for (let k = 0; k < nBeats; k++) {
    const x = best.phase + k * period;
    let m = 0;
    for (let d = -2; d <= 2; d++) m = Math.max(m, low[Math.round(x) + d] || 0);
    kickScore[k % 4] += m;
    const c = chromaRange(f, x, x + period);
    if (prevChroma) chordScore[k % 4] += 1 - cos(prevChroma, c);
    prevChroma = c;
  }
  const norm = (a: number[]) => {
    const s = a.reduce((x, y) => x + y, 0) || 1;
    return a.map((v) => v / s);
  };
  const ks = norm(kickScore), cs = norm(chordScore);
  const phaseScore = ks.map((v, i) => v + 1.5 * cs[i]);
  const db = phaseScore.indexOf(Math.max(...phaseScore));
  let firstDb = best.phase + db * period;
  firstDb -= Math.floor(firstDb / (4 * period)) * 4 * period;
  return { bpm: Math.round(best.bpm * 100) / 100, downbeatSec: firstDb / fps, confidence: best.score };
}
