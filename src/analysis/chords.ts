/** Chord track: harmonic-aware triad templates + bass-root cue, 2-beat resolution. */
import type { Features } from "../dsp/pool";
import type { ChordSpan } from "../model/types";
import { beatToFrame, chromaRange, cos, type Grid } from "./grid";

export function estimateChords(f: Features, g: Grid, key: { tonic: number; minor: boolean }): ChordSpan[] {
  const endBeat = g.clipStartBeat + g.durationSec / g.spb;
  const scale = (key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((s) => (s + key.tonic) % 12);
  const templates: { root: number; minor: boolean; v: number[] }[] = [];
  // Each chord tone contributes its overtone series (partials 1-6 → pc, pc, +7, pc, +4, +7),
  // so chroma skew from bright timbres doesn't turn C into Em.
  const partials: [number, number][] = [[0, 1], [0, 0.6], [7, 0.36], [0, 0.22], [4, 0.13], [7, 0.08]];
  for (let r = 0; r < 12; r++)
    for (const minor of [false, true]) {
      const v = new Array(12).fill(0);
      for (const [iv, w] of [[0, 1], [minor ? 3 : 4, 0.85], [7, 0.85]] as const)
        for (const [off, a] of partials) v[(r + iv + off) % 12] += w * a;
      templates.push({ root: r, minor, v });
    }
  const spans: ChordSpan[] = [];
  const step = 2; // beats
  let prev: ChordSpan | null = null;
  for (let b = Math.floor(g.clipStartBeat / step) * step; b < endBeat; b += step) {
    const fa = beatToFrame(g, f, b), fb = beatToFrame(g, f, b + step);
    const c = chromaRange(f, fa, fb).map(Math.sqrt);
    const bc = chromaRange(f, fa, fb, f.bassChroma);
    const bMax = Math.max(...bc);
    const sum = c.reduce((s, v) => s + v, 0);
    let pick: { root: number; minor: boolean } | null = null;
    if (sum > 1e-6) {
      let best = -1;
      for (const t of templates) {
        const third = (t.root + (t.minor ? 3 : 4)) % 12;
        const diatonic = scale.includes(t.root) && scale.includes(third) && scale.includes((t.root + 7) % 12);
        // Bass note is the strongest root cue.
        const bassBonus = bMax > 0 ? 0.12 * (bc[t.root] / bMax) : 0;
        const s = cos(c, t.v) + (diatonic ? 0.06 : 0) + bassBonus;
        if (s > best) {
          best = s;
          pick = t;
        }
      }
    } else if (prev) pick = prev;
    if (!pick) continue;
    if (prev && prev.root === pick.root && prev.minor === pick.minor && prev.start + prev.length === b) prev.length += step;
    else {
      prev = { start: b, length: step, root: pick.root, minor: pick.minor };
      spans.push(prev);
    }
  }
  // Absorb 2-beat blips into neighbours.
  for (let i = spans.length - 2; i > 0; i--) {
    if (spans[i].length <= 2 && spans[i - 1].start + spans[i - 1].length === spans[i].start) {
      spans[i - 1].length += spans[i].length;
      spans.splice(i, 1);
    }
  }
  return spans;
}
