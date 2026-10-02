/** Beat grid + shared helpers over the per-frame Features from the DSP workers. */
import type { Features } from "../dsp/pool";
import type { TempoResult } from "./tempo";

export interface Grid {
  bpm: number;
  spb: number;
  clipStartBeat: number; // where the audio file starts on the timeline
  durationSec: number;
}

export function makeGrid(t: TempoResult, durationSec: number): Grid {
  const spb = 60 / t.bpm;
  const dbBeats = t.downbeatSec / spb;
  const clipStartBeat = (4 - (dbBeats % 4)) % 4;
  return { bpm: t.bpm, spb, clipStartBeat, durationSec };
}

export const beatToFrame = (g: Grid, f: Features, beat: number) => (beat - g.clipStartBeat) * g.spb * f.fps;

export function chromaRange(f: Features, a: number, b: number, src: Float32Array = f.chroma): number[] {
  const out = new Array(12).fill(0);
  const T = src.length / 12;
  for (let t = Math.max(0, Math.floor(a)); t < Math.min(T, Math.ceil(b)); t++)
    for (let p = 0; p < 12; p++) out[p] += src[t * 12 + p];
  return out;
}

export function energyDb(f: Features, a: number, b: number): number {
  let s = 0, c = 0;
  for (let t = Math.max(0, Math.floor(a)); t < Math.min(f.energy.length, Math.ceil(b)); t++) {
    s += f.energy[t];
    c++;
  }
  return 10 * Math.log10(s / (c || 1) + 1e-12);
}

export const cos = (a: number[], b: number[]) => {
  let n = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    n += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return n / Math.sqrt(x * y + 1e-12);
};
