/**
 * The harmony layer: one picture of the song's harmony that every producer asks (part generator,
 * harmony writer, auto-arrange). Pure and cheap (main thread, a few ms per song).
 *
 * Evidence, per beat
 *  - every real pitched MIDI part (not drums, not generated parts), weighted by role: bass names
 *    the roots, chord instruments the harmony, the melody counts less (passing notes);
 *  - the mix's own chroma (`project.harmonyAudio`, kept from the stem split), so parts that were
 *    never converted to MIDI still count — fully where there's no MIDI, lightly where there is.
 * Key / mode: the 7-note scale that holds the most sounding time (major, natural / harmonic minor
 *   sets), the tonic from the bass (first / last / longest roots) and a tonal profile → dorian,
 *   mixolydian, phrygian… are legit, not "out of key". Sections that clearly use another scale
 *   get their own (modulations).
 * Chords: Viterbi over the beats — 12 roots × maj / min / 5 / sus2 / sus4 / dim / 7 / maj7 / m7,
 *   emissions from the chroma (tones present, outside notes, missing tones), the bass note
 *   (root or inversion), the scale (diatonic chords preferred, borrowed ones allowed when heard),
 *   transitions that prefer changes on bar lines, then half bars.
 * Note judgement (`cost` / `fit`): chord tone 0, available tension cheap, avoid notes (a semitone
 *   above a chord tone) expensive, out of scale more, and a rub against a real part sounding at
 *   that moment (semitone, major 7th, tritone outside a dominant) prohibitive.
 */
import type { Project, Track } from "../model/types";

export type Quality = "maj" | "min" | "5" | "sus2" | "sus4" | "dim" | "7" | "maj7" | "m7";
export interface HChord {
  start: number; // beats
  end: number;
  root: number; // pitch class
  quality: Quality;
  /** Chord tones as pitch classes, root first (then 3rd / sus, 5th, 7th). */
  tones: number[];
  /** Bass pitch class (≠ root for inversions / slash chords). */
  bass: number;
  /** True where nothing harmonic sounds (filled from the neighbours so callers always get a chord). */
  silent: boolean;
  name: string;
}
export interface Heard { s: number; e: number; p: number; role: Track["role"]; track: string }
export interface ScaleSpan { start: number; end: number; tonic: number; pcs: number[]; mode: string }
export interface Harmony {
  key: { tonic: number; minor: boolean };
  mode: string;
  /** The song's main scale (7 pitch classes). */
  scale: number[];
  scales: ScaleSpan[];
  chords: HChord[];
  /** Real notes (absolute beats), sorted by start. */
  heard: Heard[];
  end: number;
  chordAt(beat: number): HChord;
  scaleAt(beat: number): number[];
  /** Pitch class of the real bass at a beat (longest note sounding there), or null. */
  bassAt(beat: number): number | null;
  /** Real notes sounding over [s, e) by a meaningful amount. */
  sounding(s: number, e: number): Heard[];
  /** How wrong a pitch would sound over [s, e): 0 = chord tone … ≥ 10 = rubs against the band. */
  cost(pitch: number, s: number, e: number, o?: { ignoreTrack?: string }): number;
  /** The best pitch within ±maxMove semitones (moving costs a little), or null when nothing is acceptable. */
  fit(pitch: number, s: number, e: number, o?: { maxMove?: number; limit?: number; ignoreTrack?: string }): number | null;
}

const pcOf = (p: number) => ((p % 12) + 12) % 12;
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const QUALITIES: { q: Quality; iv: number[]; w: number[]; penalty: number; suffix: string }[] = [
  { q: "maj", iv: [0, 4, 7], w: [1, 1, 0.8], penalty: 0, suffix: "" },
  { q: "min", iv: [0, 3, 7], w: [1, 1, 0.8], penalty: 0, suffix: "m" },
  { q: "5", iv: [0, 7], w: [1, 0.9], penalty: 0.03, suffix: "5" },
  { q: "sus2", iv: [0, 2, 7], w: [1, 0.8, 0.8], penalty: 0.1, suffix: "sus2" },
  { q: "sus4", iv: [0, 5, 7], w: [1, 0.8, 0.8], penalty: 0.1, suffix: "sus4" },
  { q: "dim", iv: [0, 3, 6], w: [1, 1, 0.9], penalty: 0.1, suffix: "dim" },
  { q: "7", iv: [0, 4, 7, 10], w: [1, 1, 0.7, 0.8], penalty: 0.06, suffix: "7" },
  { q: "maj7", iv: [0, 4, 7, 11], w: [1, 1, 0.7, 0.8], penalty: 0.07, suffix: "maj7" },
  { q: "m7", iv: [0, 3, 7, 10], w: [1, 1, 0.7, 0.8], penalty: 0.06, suffix: "m7" },
];

const MAJOR = [0, 2, 4, 5, 7, 9, 11], HARM_MINOR = [0, 2, 3, 5, 7, 8, 11];
const MODES: { name: string; iv: number[]; minor: boolean }[] = [
  { name: "major", iv: [0, 2, 4, 5, 7, 9, 11], minor: false },
  { name: "dorian", iv: [0, 2, 3, 5, 7, 9, 10], minor: true },
  { name: "phrygian", iv: [0, 1, 3, 5, 7, 8, 10], minor: true },
  { name: "lydian", iv: [0, 2, 4, 6, 7, 9, 11], minor: false },
  { name: "mixolydian", iv: [0, 2, 4, 5, 7, 9, 10], minor: false },
  { name: "minor", iv: [0, 2, 3, 5, 7, 8, 10], minor: true },
  { name: "harmonic minor", iv: HARM_MINOR, minor: true },
];
// Krumhansl–Kessler tonal profiles (tonic emphasis)
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Role weights: how much a part says about the harmony. */
const ROLE_W: Partial<Record<Track["role"], number>> = { bass: 1.3, guitar: 1, keys: 1, piano: 1, pad: 1.1, vocals: 0.55, lead: 0.55, other: 0.8 };

export const isGeneratedTrack = (t: Track) => t.name.startsWith("Gen ·") || t.name.includes("· harmony");

const corr = (h: number[], prof: number[], tonic: number) => {
  const x = prof.map((_, i) => h[(i + tonic) % 12]);
  const mx = x.reduce((a, b) => a + b, 0) / 12, mp = prof.reduce((a, b) => a + b, 0) / 12;
  let n = 0, dx = 0, dp = 0;
  for (let i = 0; i < 12; i++) {
    n += (x[i] - mx) * (prof[i] - mp);
    dx += (x[i] - mx) ** 2;
    dp += (prof[i] - mp) ** 2;
  }
  return n / Math.sqrt(dx * dp + 1e-12);
};

export interface HarmonyOptions {
  /** Last beat to analyse (default: where the music ends). */
  end?: number;
  /** Tracks to leave out (besides drums / generated parts). */
  exclude?: (t: Track) => boolean;
}

export function harmonyOf(p: Project, o: HarmonyOptions = {}): Harmony {
  const spb = 60 / p.bpm;

  /* ── 1. what the real parts play ─────────────────────────────────────────── */
  const heard: Heard[] = [];
  for (const t of p.tracks) {
    if (t.kind !== "midi" || t.role === "drums" || t.dp || isGeneratedTrack(t) || o.exclude?.(t)) continue;
    for (const c of t.clips) {
      if (c.kind !== "midi") continue;
      for (const n of c.notes) if (n.start < c.length && n.dur > 0) heard.push({ s: c.start + n.start, e: c.start + Math.min(c.length, n.start + n.dur), p: n.pitch, role: t.role, track: t.id });
    }
  }
  heard.sort((a, b) => a.s - b.s);

  let end = o.end ?? 0;
  if (!o.end) {
    for (const h of heard) end = Math.max(end, h.e);
    for (const t of p.tracks) if (t.kind === "audio" && !isGeneratedTrack(t)) for (const c of t.clips) if (c.kind === "audio") end = Math.max(end, c.start + c.duration / spb);
    for (const cs of p.chords) end = Math.max(end, cs.start + cs.length);
    const ha0 = p.harmonyAudio;
    if (ha0) end = Math.max(end, (ha0.startSec + (ha0.chroma.length / 12) * ha0.cellSec) / spb);
  }
  const B = Math.max(4, Math.ceil(end / 4) * 4);

  /* ── 2. evidence per beat: harmony chroma + bass chroma ──────────────────── */
  const midi = Array.from({ length: B }, () => new Array(12).fill(0));
  const midiBass = Array.from({ length: B }, () => new Array(12).fill(0));
  const hasBassPart = heard.some((h) => h.role === "bass");
  for (const h of heard) {
    const w = (ROLE_W[h.role] ?? 0.8) * (h.e - h.s < 0.2 ? 0.5 : 1); // very short notes: passing
    for (let b = Math.max(0, Math.floor(h.s)); b < Math.min(B, Math.ceil(h.e)); b++) {
      const ov = Math.min(b + 1, h.e) - Math.max(b, h.s);
      if (ov <= 0) continue;
      midi[b][pcOf(h.p)] += ov * w;
      if (h.role === "bass") midiBass[b][pcOf(h.p)] += ov;
    }
  }
  if (!hasBassPart) {
    // no bass part: the lowest note sounding in each beat (if it's low enough to be a bass note)
    for (let b = 0; b < B; b++) {
      let low: Heard | null = null;
      for (const h of heard) {
        if (h.s >= b + 1) break;
        if (h.e > b + 0.1 && h.p < 55 && (!low || h.p < low.p)) low = h;
      }
      if (low) midiBass[b][pcOf(low.p)] += 1;
    }
  }
  // audio chroma (seconds-based cells → beats with the current tempo)
  const audio = Array.from({ length: B }, () => new Array(12).fill(0));
  const audioBass = Array.from({ length: B }, () => new Array(12).fill(0));
  const ha = p.harmonyAudio;
  if ((!ha || !ha.chroma.length) && p.chords.length) {
    // older sessions: only the analysed chord track is known about the audio — weak evidence
    for (const cs of p.chords)
      for (let b = Math.max(0, Math.floor(cs.start)); b < Math.min(B, Math.ceil(cs.start + cs.length)); b++) {
        audio[b][cs.root] += 1;
        audio[b][(cs.root + (cs.minor ? 3 : 4)) % 12] += 0.8;
        audio[b][(cs.root + 7) % 12] += 0.8;
        audioBass[b][cs.root] += 1;
      }
  }
  if (ha && ha.chroma.length) {
    const cells = ha.chroma.length / 12;
    for (let i = 0; i < cells; i++) {
      const b = Math.floor((ha.startSec + (i + 0.5) * ha.cellSec) / spb);
      if (b < 0 || b >= B) continue;
      for (let k = 0; k < 12; k++) {
        audio[b][k] += ha.chroma[i * 12 + k];
        audioBass[b][k] += ha.bass[i * 12 + k];
      }
    }
  }
  const norm = (v: number[]) => {
    const s = v.reduce((a, x) => a + x, 0);
    return s > 1e-9 ? v.map((x) => x / s) : v.map(() => 0);
  };
  const ev: number[][] = [], bassEv: number[][] = [], energy: number[] = [];
  // audio counts as harmony only at a real level: fade-outs, reverb tails and bleed under −16 dB
  // of the song's typical beat would otherwise invent chords out of noise
  const aSums = audio.map((v) => v.reduce((x, y) => x + y, 0)), aSorted = aSums.filter((x) => x > 0).sort((x, y) => x - y);
  const aGate = 0.16 * (aSorted[Math.floor(aSorted.length / 2)] ?? 0);
  for (let b = 0; b < B; b++) if (aSums[b] < aGate) { audio[b].fill(0); audioBass[b].fill(0); }
  for (let b = 0; b < B; b++) {
    const m = norm(midi[b]), msum = midi[b].reduce((a, x) => a + x, 0);
    // audio: each note's 3rd harmonic lands a 5th above (~⅓ of its level) — take it back out, so a
    // C chord's G-partials don't read as a D and a G chord's B doesn't invent an F#; then sqrt
    // compression (loud fundamentals) and normalise
    const raw = audio[b], a = norm(raw.map((x, k2) => Math.sqrt(Math.max(0, x - 0.3 * raw[(k2 + 5) % 12]))));
    const asum = audio[b].reduce((x, y) => x + y, 0);
    const wa = msum > 0.05 ? 0.3 : 1;
    const v = m.map((x, k) => x + wa * a[k]);
    ev.push(norm(v));
    energy.push(msum + (asum > 0 ? 0.5 : 0));
    const mb = norm(midiBass[b]), ab = norm(audioBass[b]);
    const mbs = midiBass[b].reduce((x, y) => x + y, 0);
    bassEv.push(norm(mb.map((x, k) => x + (mbs > 0.05 ? 0.25 : 1) * ab[k])));
  }

  /* ── 3. key / mode ───────────────────────────────────────────────────────── */
  const hist = new Array(12).fill(0), bassHist = new Array(12).fill(0);
  for (let b = 0; b < B; b++) for (let k = 0; k < 12; k++) {
    hist[k] += ev[b][k] * Math.min(1, energy[b]);
    bassHist[k] += bassEv[b][k] * Math.min(1, energy[b]);
  }
  const firstBass = bassEv.find((v) => v.some((x) => x > 0));
  const lastBass = [...bassEv].reverse().find((v) => v.some((x) => x > 0));
  const keyOf = (h: number[], bh: number[], fb?: number[], lb?: number[]): { tonic: number; mode: (typeof MODES)[number]; pcs: number[]; coverage: number } => {
    const tot = h.reduce((a, x) => a + x, 0) || 1;
    // the 7-note set holding the most sounding time (diatonic sets, harmonic minor a little dearer)
    const sets: { pcs: number[]; cov: number; harm: boolean }[] = [];
    for (let r = 0; r < 12; r++)
      for (const [iv, harm] of [[MAJOR, false], [HARM_MINOR, true]] as const) {
        const pcs = iv.map((x) => (x + r) % 12);
        sets.push({ pcs, cov: pcs.reduce((a, pc) => a + h[pc], 0) / tot - (harm ? 0.02 : 0), harm });
      }
    const top = Math.max(...sets.map((x) => x.cov));
    // sets the notes can't tell apart (a degree that never sounds) are all candidates — the tonic
    // + mode choice decides, preferring plain major / minor
    const cands = sets.filter((x) => x.cov >= top - 0.01);
    const btot = bh.reduce((a, x) => a + x, 0) || 1;
    let best = { tonic: 0, mode: MODES[0], score: -Infinity, set: cands[0] };
    for (const bestSet of cands) for (const t of bestSet.pcs) {
      const ivs = bestSet.pcs.map((pc) => pcOf(pc - t)).sort((a, b) => a - b);
      const mode = MODES.find((m) => m.iv.join() === ivs.join());
      if (!mode) continue;
      const prof = corr(h, mode.minor ? KS_MIN : KS_MAJ, t);
      // the song's first bass note is very often home; its last one a little less
      const score = prof + 1.2 * (bh[t] / btot) + (fb && fb[t] > 0.4 ? 0.2 : 0) + (lb && lb[t] > 0.4 ? 0.08 : 0)
        + (mode.name === "major" || mode.name === "minor" ? 0.06 : mode.name === "harmonic minor" ? 0.03 : 0) + (bestSet.cov - top) * 4; // plain modes first on a tie
      if (score > best.score) best = { tonic: t, mode, score, set: bestSet };
    }
    return { tonic: best.tonic, mode: best.mode, pcs: best.set.pcs, coverage: best.set.cov };
  };
  const enoughNotes = heard.length >= 12 || hist.reduce((a, x) => a + x, 0) > 8;
  let main = keyOf(hist, bassHist, firstBass, lastBass);
  if (!enoughNotes && p.key) {
    const mode = MODES.find((m) => m.name === (p.key!.minor ? "minor" : "major"))!;
    main = { tonic: p.key.tonic, mode, pcs: mode.iv.map((x) => (x + p.key!.tonic) % 12), coverage: 1 };
  }
  const secs = p.sections.length ? p.sections : [{ start: 0, length: B }];
  if (enoughNotes && secs.length > 1) {
    // a modulating song: home is the key that lasts longest (the earlier one on a tie)
    const tally = new Map<string, { k: typeof main; beats: number; first: number }>();
    for (const s of secs) {
      const a = Math.max(0, Math.floor(s.start)), z = Math.min(B, Math.ceil(s.start + s.length));
      const h = new Array(12).fill(0), bh = new Array(12).fill(0);
      for (let b = a; b < z; b++) for (let k2 = 0; k2 < 12; k2++) { h[k2] += ev[b][k2] * Math.min(1, energy[b]); bh[k2] += bassEv[b][k2] * Math.min(1, energy[b]); }
      if (h.reduce((x, y) => x + y, 0) <= 6) continue;
      const loc = keyOf(h, bh, bassEv.slice(a, z).find((v) => v.some((x) => x > 0)));
      const id = `${loc.tonic}|${loc.pcs.join()}`;
      const cur = tally.get(id);
      if (cur) cur.beats += z - a;
      else tally.set(id, { k: loc, beats: z - a, first: a });
    }
    const keys = [...tally.values()].sort((x, y) => y.beats - x.beats || x.first - y.first);
    if (keys.length > 1 && keys[0].k.pcs.join() !== main.pcs.join()) main = keys[0].k;
    else if (keys.length > 1 && keys[0].k.tonic !== main.tonic && keys[0].beats > keys[1].beats * 0.99) main = keys[0].k;
  }
  // sections that clearly live in another scale (modulation): their own
  const scales: ScaleSpan[] = [];
  for (const s of secs) {
    const a = Math.max(0, Math.floor(s.start)), z = Math.min(B, Math.ceil(s.start + s.length));
    const h = new Array(12).fill(0), bh = new Array(12).fill(0);
    for (let b = a; b < z; b++) for (let k = 0; k < 12; k++) { h[k] += ev[b][k] * Math.min(1, energy[b]); bh[k] += bassEv[b][k] * Math.min(1, energy[b]); }
    const tot = h.reduce((x, y) => x + y, 0);
    let span = { start: a, end: z, tonic: main.tonic, pcs: main.pcs, mode: main.mode.name };
    if (tot > 6) {
      const mainCov = main.pcs.reduce((x, pc) => x + h[pc], 0) / tot;
      const loc = keyOf(h, bh);
      if (mainCov < 0.82 && loc.coverage > mainCov + 0.08) span = { start: a, end: z, tonic: loc.tonic, pcs: loc.pcs, mode: loc.mode.name };
      else if (loc.pcs.join() === main.pcs.join()) span = { ...span, tonic: loc.tonic, mode: loc.mode.name }; // same notes, the section's own home
    }
    scales.push(span);
  }
  const scaleAt = (beat: number) => (scales.find((s) => beat >= s.start && beat < s.end) ?? scales[scales.length - 1])?.pcs ?? main.pcs;

  /* ── 4. chords: Viterbi over beats ───────────────────────────────────────── */
  type State = { root: number; q: (typeof QUALITIES)[number]; pcs: number[] };
  const states: State[] = [];
  for (let r = 0; r < 12; r++) for (const q of QUALITIES) states.push({ root: r, q, pcs: q.iv.map((x) => (x + r) % 12) });
  const S = states.length;
  const beatScale = Array.from({ length: B }, (_, b) => scaleAt(b));
  const emit = (b: number, st: State): number => {
    const v = ev[b], bv = bassEv[b];
    let s = 0, out = 0, missing = 0;
    st.pcs.forEach((pc, i) => {
      s += v[pc] * st.q.w[i];
      if (v[pc] < (i === 3 ? 0.08 : 0.03)) missing++; // a 7th must really sound to make it a 7th chord
    });
    for (let k = 0; k < 12; k++) if (!st.pcs.includes(k)) out += v[k];
    s -= 0.65 * out + 0.12 * missing + st.q.penalty;
    // bass: root is the strongest cue; an inversion (bass on another chord tone) is fine
    const bmax = Math.max(...bv);
    if (bmax > 0) {
      const bpc = bv.indexOf(bmax);
      if (bpc === st.root) s += 0.3 * bmax;
      else if (st.pcs.includes(bpc)) s += 0.08 * bmax;
      else s -= 0.25 * bmax;
    }
    // the key: diatonic chords a little likelier, borrowed ones when they're heard
    const sc = beatScale[b];
    const diatonic = st.pcs.every((pc) => sc.includes(pc));
    s += diatonic ? 0.07 : sc.includes(st.root) ? 0.02 : 0;
    return s;
  };
  const silentBeat = (b: number) => energy[b] < 0.05 || ev[b].every((x) => x === 0);
  const changeCost = (b: number) => (b % 4 === 0 ? 0.1 : b % 2 === 0 ? 0.18 : 0.32);
  const score = new Float64Array(S), back: Int16Array[] = [];
  for (let k = 0; k < S; k++) score[k] = silentBeat(0) ? 0 : emit(0, states[k]);
  for (let b = 1; b < B; b++) {
    const bk = new Int16Array(S);
    let bestPrev = 0;
    for (let k = 1; k < S; k++) if (score[k] > score[bestPrev]) bestPrev = k;
    const silent = silentBeat(b), cc = changeCost(b);
    const next = new Float64Array(S);
    for (let k = 0; k < S; k++) {
      const stay = score[k], move = score[bestPrev] - cc;
      if (stay >= move) { next[k] = stay; bk[k] = k; }
      else { next[k] = move; bk[k] = bestPrev; }
      next[k] += silent ? 0 : emit(b, states[k]);
    }
    score.set(next);
    back.push(bk);
  }
  const path = new Array<number>(B);
  let k = 0;
  for (let i = 1; i < S; i++) if (score[i] > score[k]) k = i;
  for (let b = B - 1; b >= 0; b--) {
    path[b] = k;
    if (b > 0) k = back[b - 1][k];
  }
  // Chord function families: flicker inside one (F / Fmaj7 / F7, Am / Am7, a power chord next to
  // either) is one chord whose quality is decided over the whole span; a real change of function
  // on the same root (sus4 → major, minor → major) lasting ≥ 2 beats stays a change.
  const FAMILY: Record<Quality, string> = { maj: "M", maj7: "M", "7": "M", min: "m", m7: "m", "5": "5", sus2: "s2", sus4: "s4", dim: "d" };
  const fam = path.map((k2) => FAMILY[states[k2].q.q]);
  // a power-chord beat takes the family of its neighbours on the same root
  for (let b = 0; b < B; b++) {
    if (fam[b] !== "5") continue;
    const r = states[path[b]].root;
    let j = b;
    while (j < B && fam[j] === "5" && states[path[j]].root === r) j++;
    const nb = (j < B && states[path[j]].root === r ? fam[j] : null) ?? (b > 0 && states[path[b - 1]].root === r ? fam[b - 1] : null);
    if (nb && nb !== "5") for (let x = b; x < j; x++) fam[x] = nb;
  }
  const chords: HChord[] = [];
  for (let b = 0; b < B; b++) {
    const st = states[path[b]], silent = silentBeat(b);
    const prev = chords[chords.length - 1];
    const same = prev && prev.root === st.root && prev.silent === silent;
    if (same && (FAMILY[prev.quality] === fam[b] || fam[b] === "5")) {
      prev.end = b + 1;
      continue;
    }
    chords.push({ start: b, end: b + 1, root: st.root, quality: (Object.keys(FAMILY) as Quality[]).find((q) => FAMILY[q] === fam[b]) ?? st.q.q, tones: st.pcs, bass: st.root, silent, name: "" });
  }
  // a same-root function change shorter than 2 beats is flicker: back into the previous span
  for (let i = 1; i < chords.length; i++) {
    const a = chords[i - 1], c = chords[i];
    if (a.root === c.root && a.silent === c.silent && c.end - c.start < 2) {
      a.end = c.end;
      chords.splice(i--, 1);
    }
  }
  for (const c of chords) {
    if (c.silent) continue;
    const family = FAMILY[c.quality];
    let bq = states[0], bs = -Infinity;
    for (const st of states) {
      if (st.root !== c.root || (FAMILY[st.q.q] !== family && st.q.q !== "5")) continue;
      let sum = 0;
      for (let b = c.start; b < c.end; b++) sum += emit(b, st);
      if (sum > bs) { bs = sum; bq = st; }
    }
    c.quality = bq.q.q;
    c.tones = bq.pcs;
  }
  // bass per span: the inversion the bass mostly plays over the whole span
  for (const c of chords) {
    const tally = new Array(12).fill(0);
    for (let b = c.start; b < c.end; b++) for (let i = 0; i < 12; i++) tally[i] += bassEv[b][i];
    const bpc = tally.indexOf(Math.max(...tally));
    c.bass = tally[bpc] > 0 && c.tones.includes(bpc) ? bpc : c.root;
    const q = QUALITIES.find((x) => x.q === c.quality)!;
    c.name = `${NAMES[c.root]}${q.suffix}${c.bass !== c.root ? "/" + NAMES[c.bass] : ""}`;
  }
  // silent spans keep the harmony of their neighbours (callers that play through them stay in key)
  for (let i = 0; i < chords.length; i++) {
    const c = chords[i];
    if (!c.silent) continue;
    const src = chords.slice(0, i).reverse().find((x) => !x.silent) ?? chords.slice(i + 1).find((x) => !x.silent);
    if (src) Object.assign(c, { root: src.root, quality: src.quality, tones: src.tones, bass: src.bass, name: src.name });
    else {
      const t = main.tonic, minor = main.mode.minor;
      Object.assign(c, { root: t, quality: minor ? "min" : "maj", tones: [t, (t + (minor ? 3 : 4)) % 12, (t + 7) % 12], bass: t, name: NAMES[t] + (minor ? "m" : "") });
    }
  }

  /* ── 5. queries ──────────────────────────────────────────────────────────── */
  const chordAt = (beat: number) => chords.find((c) => beat >= c.start - 1e-6 && beat < c.end) ?? chords[chords.length - 1];
  const sounding = (s: number, e: number, ignore?: string) => {
    const out: Heard[] = [], need = Math.min(0.2, (e - s) * 0.4);
    for (const h of heard) {
      if (h.s >= e) break;
      if (h.track !== ignore && Math.min(e, h.e) - Math.max(s, h.s) > need) out.push(h);
    }
    return out;
  };
  const bassAt = (beat: number) => {
    let best: Heard | null = null;
    for (const h of heard) {
      if (h.s > beat + 0.13) break;
      if (h.role === "bass" && h.e > beat + 0.05 && (!best || h.e - h.s > best.e - best.s)) best = h;
    }
    return best ? pcOf(best.p) : null;
  };
  const cost = (pitch: number, s: number, e: number, co: { ignoreTrack?: string } = {}) => {
    const pc = pcOf(pitch), c = chordAt(s + Math.min(0.05, (e - s) / 2)), sc = scaleAt(s);
    let x = 0;
    // 1) the band: rubs against what really sounds right now
    const real = sounding(s, e, co.ignoreTrack);
    for (const h of real) {
      const iv = pcOf(pitch - h.p);
      if (iv === 1 || iv === 11) x += 10;
      else if (iv === 6 && !(c.quality === "7" || c.quality === "dim") ) x += 6; // a tritone is only home in a dominant / diminished chord
    }
    // 2) the chord
    if (!c.tones.includes(pc)) {
      const rel = pcOf(pc - c.root);
      const third = c.tones.find((t) => [3, 4].includes(pcOf(t - c.root)));
      const avoid = c.tones.some((t) => pcOf(pc - t) === 1); // a semitone above a chord tone (b9, 11 over a major 3rd, b13 over the 5th)
      if (!sc.includes(pc)) x += 4;
      else if (avoid && !(c.quality === "5" && rel === 8)) x += 2.5;
      else if (rel === 2 || rel === 9 || (rel === 5 && third !== undefined && pcOf(third - c.root) === 3) || (c.quality === "5" && [3, 4, 5].includes(rel))) x += 0.6; // 9, 13, 11 over minor, any 3rd/4th over a power chord
      else x += 1.2;
    }
    return x;
  };
  const fit = (pitch: number, s: number, e: number, fo: { maxMove?: number; limit?: number; ignoreTrack?: string } = {}) => {
    const max = fo.maxMove ?? 2, limit = fo.limit ?? 3;
    let best: number | null = null, bc = Infinity;
    for (let d = 0; d <= max; d++)
      for (const sgn of d === 0 ? [0] : [1, -1]) {
        const p = pitch + sgn * d, c = cost(p, s, e, fo) + 0.35 * d;
        if (c < bc) { bc = c; best = p; }
      }
    return bc <= limit + 0.35 * max ? best : null;
  };

  return {
    key: { tonic: main.tonic, minor: main.mode.minor },
    mode: main.mode.name,
    scale: main.pcs,
    scales,
    chords,
    heard,
    end: B,
    chordAt,
    scaleAt,
    bassAt,
    sounding: (s, e) => sounding(s, e),
    cost,
    fit,
  };
}

export const describeKey = (h: Harmony) => `${NAMES[h.key.tonic]} ${h.mode}`;
