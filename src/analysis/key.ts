/** Global key estimate (Krumhansl-Schmuckler profiles over chroma). */
import type { Features } from "../dsp/pool";

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * dbb + 1e-12);
}

export function estimateKey(f: Features): { tonic: number; minor: boolean } {
  const total = new Array(12).fill(0);
  const T = f.chroma.length / 12;
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let p = 0; p < 12; p++) s += f.chroma[t * 12 + p];
    if (s <= 0) continue;
    for (let p = 0; p < 12; p++) total[p] += f.chroma[t * 12 + p] / s;
  }
  let best = { tonic: 0, minor: false, r: -2 };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = total.map((_, i) => total[(i + tonic) % 12]);
    const rM = corr(rot, MAJOR), rm = corr(rot, MINOR);
    if (rM > best.r) best = { tonic, minor: false, r: rM };
    if (rm > best.r) best = { tonic, minor: true, r: rm };
  }
  return { tonic: best.tonic, minor: best.minor };
}
