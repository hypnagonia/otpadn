/**
 * Harmony context for a part: key (user / project / notes) and a chord timeline. Chords come from
 * the project's audio-derived chord track when it covers the region (qualities refined from the
 * notes), otherwise from the notes themselves: duration×velocity pitch-class weights, bass cue,
 * 8 chord qualities, diatonic and continuity priors, ranked alternatives for the user to pick.
 */
import { QUALITY_IV, type Chord, type PEvent, type Quality } from "./types";

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const QUALITIES = Object.keys(QUALITY_IV) as Quality[];

export const scalePcs = (k: { tonic: number; minor: boolean }) => {
  const steps = k.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]; // minor also allows the leading tone
  return new Set(steps.map((s) => (s + k.tonic) % 12));
};
export const chordPcs = (c: { root: number; q: Quality }) => QUALITY_IV[c.q].map((i) => (i + c.root) % 12);

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db + 1e-12);
}

export function keyFromNotes(events: PEvent[]): { tonic: number; minor: boolean; r: number } {
  const h = new Array(12).fill(0);
  for (const e of events) h[e.pitch % 12] += e.dur * (0.5 + e.vel / 254);
  let best = { tonic: 0, minor: false, r: -2 };
  if (!events.length) return best;
  for (let t = 0; t < 12; t++) {
    const rot = h.map((_, i) => h[(i + t) % 12]);
    const a = corr(rot, MAJOR), b = corr(rot, MINOR);
    if (a > best.r) best = { tonic: t, minor: false, r: a };
    if (b > best.r) best = { tonic: t, minor: true, r: b };
  }
  return best;
}

interface Win { w: number[]; bass: number[]; total: number }

function windowWeights(events: PEvent[], a: number, b: number, melodic: boolean): Win {
  const w = new Array(12).fill(0), bass = new Array(12).fill(0);
  let total = 0;
  // Lowest sounding note per 1/4 beat slice = bass cue.
  for (let t = a; t < b - 1e-9; t += 0.25) {
    let lo: PEvent | null = null;
    for (const e of events) if (e.start <= t + 1e-9 && e.start + e.dur > t + 1e-9 && (!lo || e.pitch < lo.pitch)) lo = e;
    if (lo) bass[lo.pitch % 12] += 1;
  }
  for (const e of events) {
    const ov = Math.min(b, e.start + e.dur) - Math.max(a, e.start);
    if (ov <= 0) continue;
    const strong = melodic && Math.abs(e.start - Math.round(e.start)) < 0.05 ? 1.5 : 1;
    const x = ov * (0.5 + e.vel / 254) * strong;
    w[e.pitch % 12] += x;
    total += x;
  }
  return { w, bass, total };
}

function scoreAll(win: Win, key: { tonic: number; minor: boolean }, prev: { root: number; q: Quality } | null, melodic: boolean) {
  const sum = win.w.reduce((s, v) => s + v, 0) || 1;
  const w = win.w.map((v) => v / sum);
  const bsum = win.bass.reduce((s, v) => s + v, 0);
  const bn = bsum ? win.bass.map((v) => v / bsum) : null;
  const scale = scalePcs(key);
  const out: { root: number; q: Quality; s: number }[] = [];
  for (let r = 0; r < 12; r++)
    for (const q of QUALITIES) {
      if (melodic && !["maj", "min", "7", "m7"].includes(q)) continue;
      const pcs = new Set(chordPcs({ root: r, q }));
      let s = 0;
      for (let pc = 0; pc < 12; pc++) s += pcs.has(pc) ? w[pc] * (pc === r ? 1.15 : 1) : -0.7 * w[pc];
      const iv = QUALITY_IV[q];
      if (iv.length === 4) {
        const seventh = (r + iv[3]) % 12;
        s -= w[seventh] < 0.08 ? 0.2 : 0.03; // only call a 7th chord when the 7th is really there
      }
      if (q === "sus2" || q === "sus4" || q === "dim") s -= 0.06;
      if (bn && !melodic) s += 0.3 * bn[r];
      if ([...pcs].every((pc) => scale.has(pc))) s += 0.05;
      if (prev && prev.root === r && prev.q === q) s += 0.06;
      out.push({ root: r, q, s });
    }
  return out.sort((a, b) => b.s - a.s);
}

/** Chords from the part's own notes. Line mode uses bar windows and triads/7ths only. */
export function chordsFromNotes(events: PEvent[], length: number, key: { tonic: number; minor: boolean }, melodic: boolean): Chord[] {
  const step = melodic ? 4 : 2;
  const raw: Chord[] = [];
  let prev: { root: number; q: Quality } | null = null;
  for (let a = 0; a < length - 1e-9; a += step) {
    const b = Math.min(length, a + step);
    const win = windowWeights(events, a, b, melodic);
    if (win.total < 0.05) {
      if (prev) raw.push({ start: a, length: b - a, root: prev.root, q: prev.q, fit: 0, alts: [], from: "notes" });
      continue;
    }
    const ranked = scoreAll(win, key, prev, melodic);
    const best = ranked[0];
    const margin = best.s - ranked[1].s;
    const alts: Chord["alts"] = [];
    for (const r of ranked) {
      if (alts.length >= 4) break;
      if (!alts.some((x) => x.root === r.root && x.q === r.q)) alts.push({ root: r.root, q: r.q });
    }
    raw.push({ start: a, length: b - a, root: best.root, q: best.q, fit: Math.max(0, Math.min(1, 0.5 + best.s * 0.5 + margin)), alts, from: "notes" });
    prev = best;
  }
  return mergeChords(raw);
}

function mergeChords(cs: Chord[]): Chord[] {
  const out: Chord[] = [];
  for (const c of cs) {
    const last = out[out.length - 1];
    if (last && last.root === c.root && last.q === c.q && Math.abs(last.start + last.length - c.start) < 1e-6) {
      last.length += c.length;
      last.fit = Math.max(last.fit, c.fit);
    } else out.push({ ...c, alts: [...c.alts] });
  }
  return out;
}

/** Project chord track (triads from audio) clipped to the region, with 7th qualities refined from the notes. */
export function chordsFromProject(spans: { start: number; length: number; root: number; minor: boolean }[], regionStart: number, length: number, events: PEvent[]): Chord[] {
  const out: Chord[] = [];
  for (const s of spans) {
    const a = Math.max(0, s.start - regionStart), b = Math.min(length, s.start + s.length - regionStart);
    if (b <= a + 1e-6) continue;
    const win = windowWeights(events, a, b, false);
    const sum = win.w.reduce((x, y) => x + y, 0) || 1;
    let q: Quality = s.minor ? "min" : "maj";
    if (win.total > 0.05) {
      const m7 = win.w[(s.root + 10) % 12] / sum, M7 = win.w[(s.root + 11) % 12] / sum;
      if (s.minor && m7 > 0.1) q = "m7";
      else if (!s.minor && m7 > 0.1 && m7 > M7) q = "7";
      else if (!s.minor && M7 > 0.1) q = "maj7";
    }
    const triad: Quality = s.minor ? "min" : "maj";
    out.push({ start: a, length: b - a, root: s.root, q, fit: 0.8, alts: [{ root: s.root, q }, { root: s.root, q: q === triad ? (s.minor ? "m7" : "7") : triad }], from: "project" });
  }
  return mergeChords(out);
}

export function applyOverrides(chords: Chord[], ov: Record<string, { root: number; q: Quality }>): Chord[] {
  return chords.map((c) => {
    const o = ov[String(Math.round(c.start * 1000) / 1000)];
    return o ? { ...c, root: o.root, q: o.q, from: "user" as const } : c;
  });
}

export const chordAt = (chords: Chord[], beat: number) => chords.find((c) => beat >= c.start - 1e-9 && beat < c.start + c.length - 1e-9) ?? (chords.length ? chords[chords.length - 1] : null);

/**
 * Chords for a bass line: the bass mostly plays roots, so per half bar the root is the pitch class
 * with the most weight on strong beats; the quality is the key's diatonic triad on that root
 * (I ii iii IV V vi vii° / i ii° III iv v VI VII), so the chord lane is musical, not guessed tones.
 */
export function chordsFromBass(events: PEvent[], length: number, key: { tonic: number; minor: boolean }): Chord[] {
  const MAJ: Quality[] = ["maj", "min", "min", "maj", "maj", "min", "dim"], MIN: Quality[] = ["min", "dim", "maj", "min", "min", "maj", "maj"];
  const steps = key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const qualityOf = (root: number): Quality => {
    const deg = steps.indexOf((root - key.tonic + 12) % 12);
    return deg < 0 ? "maj" : (key.minor ? MIN : MAJ)[deg];
  };
  const raw: Chord[] = [];
  let prev: number | null = null;
  for (let a = 0; a < length - 1e-9; a += 2) {
    const b = Math.min(length, a + 2);
    const w = new Array(12).fill(0);
    for (const e of events) {
      const ov = Math.min(b, e.start + e.dur) - Math.max(a, e.start);
      if (ov <= 0) continue;
      const strong = Math.abs(e.start - Math.round(e.start)) < 0.06 ? (Math.abs(e.start - a) < 0.06 ? 2.5 : 1.5) : 1;
      w[e.pitch % 12] += ov * strong * (0.5 + e.vel / 254);
    }
    const total = w.reduce((x, y) => x + y, 0);
    if (total < 0.05) {
      if (prev !== null) raw.push({ start: a, length: b - a, root: prev, q: qualityOf(prev), fit: 0, alts: [], from: "notes" });
      continue;
    }
    const order = w.map((v, pc) => [v, pc]).sort((x, y) => y[0] - x[0]);
    const root = order[0][1];
    const alts: Chord["alts"] = [{ root, q: qualityOf(root) }, { root, q: qualityOf(root) === "maj" ? "min" : "maj" }, { root, q: qualityOf(root) === "min" ? "m7" : "7" }];
    if (order[1][0] > 0) alts.push({ root: order[1][1], q: qualityOf(order[1][1]) });
    // The second half of a bar playing the previous chord's 5th / 3rd / octave is the same chord
    // (root–fifth bass lines), not a new one.
    const last = raw[raw.length - 1];
    if (last && a % 4 >= 2 - 1e-6 && Math.abs(last.start + last.length - a) < 1e-6 && QUALITY_IV[last.q].map((i) => (last.root + i) % 12).includes(root)) {
      raw.push({ ...last, start: a, length: b - a, alts: [...last.alts] });
      continue;
    }
    raw.push({ start: a, length: b - a, root, q: qualityOf(root), fit: Math.min(1, order[0][0] / total), alts, from: "notes" });
    prev = root;
  }
  const out: Chord[] = [];
  for (const c of raw) {
    const last = out[out.length - 1];
    if (last && last.root === c.root && last.q === c.q && Math.abs(last.start + last.length - c.start) < 1e-6) last.length += c.length;
    else out.push(c);
  }
  return out;
}


/** Song sections relative to the region (from the project's analysis, or synthesized). */
export interface PartSection { start: number; length: number; label: string; group: string; energy: number }

interface Cand { root: number; q: Quality; prior: number }

/** Like windowWeights, but notes ringing in from before the bar line count 35 % — a transcription's
 *  tails and pedalled leftovers mustn't outvote what's struck in the bar (a bass note held from
 *  the downbeat still counts fully in the second half). */
function attackWeights(events: PEvent[], a: number, b: number): Win {
  // Short notes on a 16th off-beat are passing / neighbour tones (melody), not harmony: 40 %.
  events = events.map((e) => (e.dur < 0.5 && Math.abs(((e.start % 0.5) + 0.5) % 0.5 - 0.25) < 0.08 ? { ...e, vel: e.vel * 0.4, dur: e.dur * 0.4 } : e));
  const bar = Math.floor(a / 4 + 1e-9) * 4;
  const win = windowWeights(events.filter((e) => e.start >= bar - 0.06), a, b, false);
  const tail = windowWeights(events.filter((e) => e.start < bar - 0.06), a, b, false);
  const w = win.w.map((v, i) => v + 0.35 * tail.w[i]);
  return { w, bass: win.bass.map((v, i) => v + 0.35 * tail.bass[i]), total: win.total + 0.35 * tail.total };
}

/** The key's chords: diatonic triads + their diatonic 7ths, the minor key's major V, and the two
 *  most common borrowed chords (major key: bVII, iv). */
function keyCandidates(key: { tonic: number; minor: boolean }): Cand[] {
  const steps = key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const quals: Quality[] = key.minor ? ["min", "dim", "maj", "min", "min", "maj", "maj"] : ["maj", "min", "min", "maj", "maj", "min", "dim"];
  const sevenths: (Quality | null)[] = key.minor ? ["m7", null, "maj7", "m7", "m7", "maj7", "7"] : ["maj7", "m7", "m7", "maj7", "7", "m7", null];
  const out: Cand[] = [];
  steps.forEach((s, i) => {
    const root = (key.tonic + s) % 12;
    const prior = quals[i] === "dim" ? -0.08 : i === 0 ? 0.04 : i === 3 || i === 4 ? 0.02 : 0;
    out.push({ root, q: quals[i], prior });
    if (sevenths[i]) out.push({ root, q: sevenths[i]!, prior: prior - 0.01 });
  });
  if (key.minor) out.push({ root: (key.tonic + 7) % 12, q: "maj", prior: -0.02 }, { root: (key.tonic + 7) % 12, q: "7", prior: -0.03 });
  else out.push({ root: (key.tonic + 10) % 12, q: "maj", prior: -0.05 }, { root: (key.tonic + 5) % 12, q: "min", prior: -0.06 });
  // Secondary dominants pop music uses (V/V, V/vi, V/ii; minor: V/iv): only with real evidence
  // (their major third is outside the key, and the prior is low).
  for (const s of key.minor ? [0] : [2, 4, 9]) out.push({ root: (key.tonic + s) % 12, q: "maj", prior: -0.1 }, { root: (key.tonic + s) % 12, q: "7", prior: -0.11 });
  return out;
}

const SLOT = 2; // beats: chords change on bar lines or half bars only

/**
 * A clean chord progression from noisy evidence. The raw chord lane (project analysis or notes)
 * and the notes are scored per half bar against the key's chords; a Viterbi pass picks the path
 * with the fewest, best-placed changes (bar lines cheap, mid-bar changes expensive). Then the loop
 * length (2/4/8 bars) is detected and repeats of the same section group share their evidence, so a
 * repeated progression comes out identical instead of flickering with transcription errors.
 */
export function tidyProgression(raw: Chord[], events: PEvent[], key: { tonic: number; minor: boolean }, length: number, sections: PartSection[], fromProject: boolean): { chords: Chord[]; rhythm: string; loopBars: number | null } {
  const cands = keyCandidates(key);
  const n = Math.ceil(length / SLOT - 1e-9);
  if (!n) return { chords: [], rhythm: "—", loopBars: null };
  const lam = fromProject ? 0.6 : 0.15;
  const emit: number[][] = [];
  for (let s = 0; s < n; s++) {
    const a = s * SLOT, b = Math.min(length, a + SLOT);
    const win = attackWeights(events, a, b);
    const sum = win.w.reduce((x, y) => x + y, 0);
    const bsum = win.bass.reduce((x, y) => x + y, 0);
    const rawHere = raw.map((c) => ({ c, ov: Math.max(0, Math.min(b, c.start + c.length) - Math.max(a, c.start)) / (b - a) })).filter((x) => x.ov > 0);
    if (sum < 0.05 && !rawHere.length) { emit.push(cands.map(() => 0)); continue; }
    const w = win.w.map((v) => v / (sum || 1)), bw = win.bass.map((v) => v / (bsum || 1));
    emit.push(cands.map((cd) => {
      const pcs = new Set(chordPcs(cd));
      let sc = 0;
      if (sum >= 0.05) {
        for (let pc = 0; pc < 12; pc++) sc += pcs.has(pc) ? w[pc] * (pc === cd.root ? 1.15 : 1) : -0.6 * w[pc];
        sc += 0.35 * bw[cd.root];
        // Parsimony: the root must be heard (Dm7 ⊃ F, Am7 ⊃ C — a stray D mustn't turn every F
        // into Dm7), and a 4-note chord costs a little more than the triad it contains.
        if (w[cd.root] < 0.08 && bw[cd.root] < 0.2) sc -= 0.15;
        const iv = QUALITY_IV[cd.q];
        if (iv.length === 4) sc += (w[(cd.root + iv[3]) % 12] < 0.12 ? -0.15 : 0) - 0.08; // a 7th only when it's clearly played
      }
      for (const { c, ov } of rawHere) {
        const sameTriad = c.root === cd.root && (QUALITY_IV[c.q][1] === 3) === (QUALITY_IV[cd.q][1] === 3);
        if (sameTriad) sc += lam * ov * (c.q === cd.q ? 1 : 0.8);
      }
      return sc + cd.prior;
    }));
  }
  const groupOf = (s: number) => {
    const sec = sections.find((x) => s * SLOT >= x.start - 1e-9 && s * SLOT < x.start + x.length - 1e-9);
    return sec ? { g: sec.group || "A", from: Math.round(sec.start / SLOT) } : { g: "A", from: 0 };
  };
  const viterbi = (E: number[][]) => {
    const C = cands.length;
    let score = E[0].slice();
    const back: number[][] = [];
    for (let s = 1; s < n; s++) {
      const bar = (s * SLOT) % 4 === 0;
      const next = new Array(C).fill(-Infinity), bk = new Array(C).fill(0);
      for (let j = 0; j < C; j++)
        for (let i = 0; i < C; i++) {
          let t = 0;
          if (i !== j) {
            t = bar ? -0.15 : -0.6;
            if (cands[i].root === cands[j].root) t -= 0.05; // don't flip 7th ↔ triad
            if (cands[j].root === (cands[i].root + 5) % 12) t += 0.04; // V → I and friends
          }
          const v = score[i] + t;
          if (v > next[j]) { next[j] = v; bk[j] = i; }
        }
      for (let j = 0; j < C; j++) next[j] += E[s][j];
      back.push(bk);
      score = next;
    }
    let j = score.indexOf(Math.max(...score));
    const path = [j];
    for (let s = n - 2; s >= 0; s--) path.unshift((j = back[s][j]));
    return path;
  };
  let path = viterbi(emit);
  // Loop length: the smallest P (2/4/8 bars) whose loop positions — across every section of the
  // same group — agree about as well as any longer one (a 4-bar loop also "agrees" at 8 bars).
  const agreeAt = (P: number) => {
    const L = (P * 4) / SLOT;
    const pos = new Map<string, number[]>();
    for (let s = 0; s < n; s++) {
      const g = groupOf(s);
      const k = `${g.g}:${(((s - g.from) % L) + L) % L}`;
      (pos.get(k) ?? pos.set(k, []).get(k)!).push(path[s]);
    }
    let same = 0, tot = 0;
    for (const xs of pos.values()) {
      if (xs.length < 2) continue;
      const cnt = new Map<number, number>();
      for (const x of xs) cnt.set(x, (cnt.get(x) ?? 0) + 1);
      same += Math.max(...cnt.values());
      tot += xs.length;
    }
    return tot >= n * 0.5 ? same / tot : 0;
  };
  const agrees = [2, 4, 8].map((P) => ({ P, a: agreeAt(P) }));
  const top = Math.max(...agrees.map((x) => x.a));
  let loopBars: number | null = agrees.find((x) => x.a >= top - 0.05 && x.a > 0)?.P ?? null;
  const bestAgree = top;
  if (loopBars && bestAgree >= 0.45) {
    const L = (loopBars * 4) / SLOT;
    // Every loop position pools the evidence of all its repeats (same section group); each slot
    // keeps 35 % of its own, so a real one-off change (a turnaround) can still win.
    const pools = new Map<string, { sum: number[]; n: number }>();
    const keyOf = (s: number) => { const g = groupOf(s); return `${g.g}:${(((s - g.from) % L) + L) % L}`; };
    for (let s = 0; s < n; s++) {
      const k = keyOf(s);
      const pl = pools.get(k) ?? pools.set(k, { sum: cands.map(() => 0), n: 0 }).get(k)!;
      emit[s].forEach((v, i) => (pl.sum[i] += v));
      pl.n++;
    }
    const tied = emit.map((row, s) => {
      const pl = pools.get(keyOf(s))!;
      const tie = bestAgree >= 0.7 ? 0.75 : 0.65; // a clear loop ties its repeats harder
      return row.map((v, i) => (1 - tie) * v + tie * (pl.sum[i] / pl.n));
    });
    path = viterbi(tied);
  } else loopBars = null;
  // Spans + ranked alternatives
  const out: Chord[] = [];
  for (let s = 0; s < n; s++) {
    const cd = cands[path[s]], a = s * SLOT;
    const last = out[out.length - 1];
    if (last && last.root === cd.root && last.q === cd.q) { last.length = Math.min(length, a + SLOT) - last.start; continue; }
    out.push({ start: a, length: Math.min(length, a + SLOT) - a, root: cd.root, q: cd.q, fit: 0, alts: [], from: fromProject ? "project" : "notes" });
  }
  for (const c of out) {
    const s0 = Math.round(c.start / SLOT), s1 = Math.round((c.start + c.length) / SLOT);
    const tot = cands.map((_, i) => { let x = 0; for (let s = s0; s < s1 && s < n; s++) x += emit[s][i]; return x; });
    const order = tot.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]);
    c.alts = order.slice(0, 4).map(([, i]) => ({ root: cands[i].root, q: cands[i].q }));
    const best = order[0][0] / Math.max(1, s1 - s0);
    c.fit = Math.max(0, Math.min(1, 0.45 + best * 0.6));
  }
  const changesMid = out.filter((c) => c.start % 4 !== 0).length;
  const meanBars = length / 4 / Math.max(1, out.length);
  const rhythm = changesMid > out.length * 0.3 ? "half-bar changes" : meanBars >= 1.75 ? "2-bar changes" : "1 chord per bar";
  return { chords: out, rhythm, loopBars };
}
