/** Song sections: novelty at 4-bar boundaries, grouping by chroma, energy-based labels. */
import type { Features } from "../dsp/pool";
import type { Section } from "../model/types";
import { beatToFrame, chromaRange, cos, energyDb, type Grid } from "./grid";

export function estimateSections(f: Features, g: Grid): Section[] {
  const endBeat = g.clipStartBeat + g.durationSec / g.spb;
  const nBars = Math.ceil(endBeat / 4);
  const barE: number[] = [];
  const barC: number[][] = [];
  for (let b = 0; b < nBars; b++) {
    const a = beatToFrame(g, f, b * 4), z = beatToFrame(g, f, b * 4 + 4);
    barE.push(energyDb(f, a, z));
    barC.push(chromaRange(f, a, z));
  }
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const meanVec = (vs: number[][]) => vs.reduce((acc, v) => acc.map((x, i) => x + v[i]), new Array(12).fill(0));

  // Novelty at every 4-bar boundary.
  const cand: { bar: number; nov: number }[] = [];
  for (let b = 4; b < nBars - 2; b += 4) {
    const A = { e: mean(barE.slice(b - 4, b)), c: meanVec(barC.slice(b - 4, b)) };
    const B = { e: mean(barE.slice(b, b + 4)), c: meanVec(barC.slice(b, b + 4)) };
    cand.push({ bar: b, nov: Math.abs(A.e - B.e) / 6 + (1 - cos(A.c, B.c)) * 4 });
  }
  const novs = cand.map((c) => c.nov).sort((a, b) => a - b);
  const thresh = novs.length ? novs[Math.floor(novs.length * 0.55)] : 0;
  const bounds = [0];
  for (const c of cand) {
    const last = bounds[bounds.length - 1];
    if ((c.nov >= thresh && c.bar - last >= 8) || c.bar - last >= 16) bounds.push(c.bar);
  }
  bounds.push(nBars);

  const secs = [] as (Section & { db: number; chroma: number[] })[];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b <= a) continue;
    secs.push({ start: a * 4, length: (b - a) * 4, label: "", group: "", energy: 0, db: mean(barE.slice(a, b)), chroma: meanVec(barC.slice(a, b)) });
  }
  const maxDb = Math.max(...secs.map((s) => s.db));
  for (const s of secs) {
    const d = maxDb - s.db;
    s.energy = d <= 1.5 ? 3 : d <= 4 ? 2 : d <= 8 ? 1 : 0;
  }
  // Group similar material.
  const groups: { letter: string; chroma: number[]; db: number }[] = [];
  for (const s of secs) {
    let gp = groups.find((gr) => cos(gr.chroma, s.chroma) > 0.93 && Math.abs(gr.db - s.db) < 4);
    if (!gp) {
      gp = { letter: String.fromCharCode(65 + groups.length), chroma: s.chroma, db: s.db };
      groups.push(gp);
    }
    s.group = gp.letter;
  }
  // Chorus group: highest average energy among groups that repeat (or the loudest overall).
  const groupStats = groups.map((gr) => {
    const members = secs.filter((s) => s.group === gr.letter);
    return { letter: gr.letter, count: members.length, db: mean(members.map((m) => m.db)) };
  });
  const repeating = groupStats.filter((g2) => g2.count > 1);
  let chorus: string | undefined = (repeating.length ? repeating : groupStats).sort((a, b) => b.db - a.db)[0]?.letter;
  // Strophic songs (e.g. 12-bar blues) repeat one progression throughout: the loudest
  // passes are the "choruses" only if there is real dynamic contrast.
  const single = groups.length === 1;
  if (single && !secs.some((s) => s.energy <= 1)) chorus = undefined;

  secs.forEach((s, i) => {
    if (s.group === chorus && (single ? s.energy >= 3 : s.energy >= 2)) s.label = "Chorus";
    else if (i === 0 && s.energy <= 1) s.label = "Intro";
    else if (i === secs.length - 1 && s.energy <= 1) s.label = "Outro";
    else if (s.energy <= 1) s.label = "Break";
    else s.label = "Verse";
  });
  // Too many "choruses" means little contrast: keep Chorus only for the peak-energy ones.
  const choruses = secs.filter((s) => s.label === "Chorus");
  if (choruses.length > secs.length * 0.5) {
    const peak = Math.max(...choruses.map((s) => s.db));
    for (const s of choruses)
      if (s.db < peak - 1.5 || choruses.every((c) => c.energy === s.energy)) {
        s.label = "Verse";
        s.energy = Math.min(s.energy, 2); // give the arrangement somewhere to build from
      }
    if (secs.every((s) => s.label !== "Chorus")) {
      // No contrast at all: name the loudest third Chorus so arrangement still builds.
      const sorted = [...secs].filter((s) => s.label === "Verse").sort((a, b) => b.db - a.db);
      sorted.slice(0, Math.max(1, Math.floor(sorted.length / 3))).forEach((s) => {
        s.label = "Chorus";
        s.energy = 3;
      });
    }
  }
  secs.forEach((s, i) => {
    const next = secs[i + 1];
    if (next && next.label === "Chorus" && s.label === "Verse" && s.db < next.db - 1 && s.length <= 32) s.label = "Build";
  });
  return secs.map(({ db: _db, chroma: _c, ...s }) => s);
}
