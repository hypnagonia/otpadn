/**
 * Harmony writer for vocal / lead MIDI lines — a real harmony voice, not parallel intervals.
 *  - key: estimated from the actual notes (Krumhansl); the project's analysed key is kept only
 *    when the notes agree with it (a wrong key was what put harmonies out of key)
 *  - chords: from the other pitched MIDI tracks (bass weighted) + the melody; else the analysed
 *    chord track where the melody agrees with it; else fitted to the melody's strong beats
 *  - the line: per phrase, a Viterbi search over candidate notes — in key (or a tone of the
 *    current chord), chord tones on strong beats / long notes, 3rds & 6ths preferred, 4ths & 5ths
 *    allowed, no 2nds / 7ths / tritones against the melody, smooth voice leading, no parallel
 *    5ths / octaves, kept inside C3–C5 (a phrase that can't fit on the asked side moves to the
 *    other side as a whole). So the interval moves with the melody (3rd, 4th, 6th, 5th…).
 * One new track per voice: same rhythm, instrument and role, a little softer, panned apart.
 */
import type { ChordSpan, MidiClip, Note, Project, Track } from "../model/types";
import { store } from "../model/store";
import { midiTrack } from "./tracks";
import { uid } from "../model/types";

export type HarmonyVoice = "smart-up" | "smart-down" | "3rd-up" | "3rd-down" | "5th-up" | "oct-up" | "oct-down";
export const HARMONY_PRESETS: { id: string; label: string; voices: HarmonyVoice[] }[] = [
  { id: "smart-up", label: "harmony above", voices: ["smart-up"] },
  { id: "smart-down", label: "harmony below", voices: ["smart-down"] },
  { id: "smart-both", label: "two voices · above + below", voices: ["smart-up", "smart-down"] },
  { id: "3rd-up", label: "3rds above (in key, chord-aware)", voices: ["3rd-up"] },
  { id: "3rd-down", label: "3rds below (in key, chord-aware)", voices: ["3rd-down"] },
  { id: "5th-up", label: "5ths above (power)", voices: ["5th-up"] },
  { id: "oct-up", label: "octave above", voices: ["oct-up"] },
  { id: "oct-down", label: "octave below", voices: ["oct-down"] },
];
const VOICE_LABEL: Record<HarmonyVoice, string> = { "smart-up": "↑", "smart-down": "↓", "3rd-up": "3rds ↑", "3rd-down": "3rds ↓", "5th-up": "5ths ↑", "oct-up": "oct ↑", "oct-down": "oct ↓" };

const LO = 48, HI = 72; // C3–C5
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const pcOf = (p: number) => ((p % 12) + 12) % 12;

interface Ev { start: number; dur: number; pitch: number; vel: number } // absolute beats
interface Chord { start: number; end: number; tones: number[] } // pitch classes
type Key = { tonic: number; minor: boolean };

/** Monophonic melody of a track (top note wins where notes overlap), in absolute beats. */
function melodyOf(t: Track): Ev[] {
  const evs: Ev[] = [];
  for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if (n.start < c.length) evs.push({ start: c.start + n.start, dur: Math.min(n.dur, c.length - n.start), pitch: n.pitch, vel: n.vel });
  evs.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const out: Ev[] = [];
  for (const e of evs) {
    const prev = out[out.length - 1];
    if (prev && e.start < prev.start + 0.02) continue; // chord in the line: keep the top note
    if (prev && prev.start + prev.dur > e.start) prev.dur = Math.max(0.05, e.start - prev.start);
    out.push({ ...e });
  }
  return out;
}

/** Pitched notes of the other tracks (not drums, not earlier harmony tracks, not the source). */
function otherNotes(p: Project, src: Track): { ev: Ev; w: number }[] {
  const out: { ev: Ev; w: number }[] = [];
  for (const t of p.tracks) {
    if (t.id === src.id || t.kind !== "midi" || t.role === "drums" || t.dp || t.name.includes("· harmony")) continue;
    for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) out.push({ ev: { start: c.start + n.start, dur: n.dur, pitch: n.pitch, vel: n.vel }, w: t.role === "bass" ? 2 : 1 });
  }
  return out;
}

const corr = (h: number[], prof: number[], tonic: number) => {
  const x = prof.map((_, i) => h[(i + tonic) % 12]);
  const mx = x.reduce((a, b) => a + b, 0) / 12, mp = prof.reduce((a, b) => a + b, 0) / 12;
  let n = 0, dx = 0, dp = 0;
  for (let i = 0; i < 12; i++) { n += (x[i] - mx) * (prof[i] - mp); dx += (x[i] - mx) ** 2; dp += (prof[i] - mp) ** 2; }
  return n / Math.sqrt(dx * dp + 1e-12);
};

function estimateKey(p: Project, mel: Ev[], others: { ev: Ev; w: number }[]): Key {
  const h = new Array(12).fill(0);
  for (const { ev, w } of others) h[pcOf(ev.pitch)] += ev.dur * w;
  for (const e of mel) h[pcOf(e.pitch)] += e.dur * 1.5;
  let best = { tonic: 0, minor: false, r: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++)
    for (const minor of [false, true]) {
      const r = corr(h, minor ? KS_MIN : KS_MAJ, tonic);
      if (r > best.r) best = { tonic, minor, r };
    }
  // The analysed key stays only if the notes agree with it (or there are too few notes to tell).
  if (p.key && (mel.length < 12 || corr(h, p.key.minor ? KS_MIN : KS_MAJ, p.key.tonic) >= best.r - 0.05)) return p.key;
  return { tonic: best.tonic, minor: best.minor };
}

/** Diatonic triads of the key (plus the harmonic-minor V), as pitch-class sets. */
function keyTriads(key: Key): number[][] {
  const sc = (key.minor ? MINOR : MAJOR).map((s) => (s + key.tonic) % 12);
  const tri = sc.map((_, d) => [sc[d], sc[(d + 2) % 7], sc[(d + 4) % 7]]);
  if (key.minor) tri.push([(key.tonic + 7) % 12, (key.tonic + 11) % 12, (key.tonic + 2) % 12]);
  return tri.filter((t) => { const a = (t[1] - t[0] + 12) % 12, b = (t[2] - t[0] + 12) % 12; return b === 7 && (a === 3 || a === 4); }); // no diminished
}

/** Notes the harmony must agree with the chord on: half-bar downbeats and long notes. */
const strong = (e: Ev) => e.dur >= 1 || Math.abs(e.start / 2 - Math.round(e.start / 2)) < 0.03;

function chordsFor(p: Project, mel: Ev[], others: { ev: Ev; w: number }[], key: Key, end: number): Chord[] {
  const triads = keyTriads(key);
  const out: Chord[] = [];
  const fit = (tones: number[], from: number, to: number) => {
    // melody notes in the window, weighted by length; the downbeat note counts double
    const ns = mel.filter((e) => e.start >= from - 0.01 && e.start < to);
    let w = 0, hit = 0;
    for (const e of ns) {
      const k = Math.min(2, e.dur) * (Math.abs(e.start - from) < 0.05 ? 2 : 1);
      w += k;
      if (tones.includes(pcOf(e.pitch))) hit += k;
    }
    return w ? hit / w : 1;
  };
  for (let b = 0; b < end; b += 2) {
    let tones: number[] | null = null;
    if (others.length) {
      const h = new Array(12).fill(0);
      for (const { ev, w } of others) { const ov = Math.min(b + 2, ev.start + ev.dur) - Math.max(b, ev.start); if (ov > 0) h[pcOf(ev.pitch)] += ov * w; }
      for (const e of mel) { const ov = Math.min(b + 2, e.start + e.dur) - Math.max(b, e.start); if (ov > 0) h[pcOf(e.pitch)] += ov * 0.5; }
      if (h.some((v) => v > 0)) {
        let bs = -Infinity;
        for (const tri of triads) { const s = tri.reduce((a, pc, i) => a + h[pc] * (i === 0 ? 1.3 : 1), 0) - 0.35 * h.reduce((a, v, pc) => a + (tri.includes(pc) ? 0 : v), 0); if (s > bs) { bs = s; tones = tri; } }
      }
    }
    if (!tones && p.chords.length) {
      const c = p.chords.find((x: ChordSpan) => b + 0.5 >= x.start && b + 0.5 < x.start + x.length);
      const t = c ? [c.root, (c.root + (c.minor ? 3 : 4)) % 12, (c.root + 7) % 12] : null;
      if (t && fit(t, b, b + 2) >= 0.5) tones = t; // analysed chord, kept where the melody agrees
    }
    if (!tones) {
      // From the melody: the diatonic triad holding the most strong-beat / long notes (stay on the
      // previous chord on ties, slight preference for I IV V vi).
      const prev = out[out.length - 1]?.tones;
      let bs = -Infinity;
      const common = [0, 5, 7, key.minor ? 3 : 9].map((d) => (d + key.tonic) % 12);
      for (const tri of triads) {
        const s = fit(tri, b, b + 2) + (prev && prev.join() === tri.join() ? 0.15 : 0) + (common.includes(tri[0]) ? 0.05 : 0);
        if (s > bs) { bs = s; tones = tri; }
      }
    }
    const prev = out[out.length - 1];
    if (prev && prev.tones.join() === tones!.join()) prev.end = b + 2;
    else out.push({ start: b, end: b + 2, tones: tones! });
  }
  return out;
}

/** Interval preference (semitones between melody and harmony, mod 12) per voice kind. */
const IV_COST: Record<"smart" | "3rd" | "5th", Record<number, number>> = {
  smart: { 3: 0, 4: 0, 8: 0.15, 9: 0.15, 5: 0.7, 7: 0.6, 0: 3, 6: 4, 1: 9, 2: 9, 10: 9, 11: 9 },
  "3rd": { 3: 0, 4: 0, 8: 1.4, 9: 1.4, 5: 2, 7: 2.5, 0: 6, 6: 9, 1: 9, 2: 9, 10: 9, 11: 9 },
  "5th": { 7: 0, 5: 1.6, 8: 1.8, 9: 1.8, 3: 2.2, 4: 2.2, 0: 5, 6: 9, 1: 9, 2: 9, 10: 9, 11: 9 },
};

/** Best line for one phrase on one side (+1 above, −1 below) by Viterbi; returns pitches and cost per note. */
function solve(ph: Ev[], side: 1 | -1, kind: "smart" | "3rd" | "5th", scale: number[], chordAt: (b: number) => number[], key: Key): { line: number[]; cost: number } {
  const lead = (key.tonic + 11) % 12, fourth = (key.tonic + 5) % 12, third = (key.tonic + (key.minor ? 3 : 4)) % 12;
  type St = { pitch: number; cost: number; back: number };
  const layers: St[][] = [];
  ph.forEach((e, i) => {
    const chord = chordAt(e.start + 0.01), st = strong(e);
    const cands: St[] = [];
    for (let d = 3; d <= 10; d++) {
      const c = e.pitch + side * d, pc = pcOf(c);
      const inChord = chord.includes(pc);
      if (!scale.includes(pc) && !inChord) continue; // never out of key (unless it's a chord tone)
      let cost = IV_COST[kind][d % 12] ?? 9;
      if (!inChord && chord.length) cost += st ? 2.5 : 0.5;
      cost += 0.6 * Math.max(0, LO - c, c - HI);
      if (i === ph.length - 1) cost += (chord.length && !inChord ? 2 : 0) + (d % 12 === 5 || d % 12 === 7 ? 0.3 : 0); // phrase lands on a chord tone, ideally a 3rd/6th
      cands.push({ pitch: c, cost, back: -1 });
    }
    if (!cands.length) cands.push({ pitch: e.pitch + side * 12, cost: 4, back: -1 }); // fallback: octave
    if (i > 0) {
      const pe = ph[i - 1];
      for (const c of cands) {
        let best = Infinity, bi = 0;
        layers[i - 1].forEach((p, k) => {
          // Singable: steps are free, small skips cheap, leaps expensive.
          const mv = Math.abs(c.pitch - p.pitch);
          let t = p.cost + (mv <= 2 ? 0 : mv <= 4 ? 0.15 : mv <= 7 ? 0.8 : 3);
          // Follow the melody's contour (holding still while it moves sounds like a drone) —
          // except across quick notes (runs, melismas), where a backing voice simply holds.
          const md = Math.sign(e.pitch - pe.pitch), hd = Math.sign(c.pitch - p.pitch);
          const quick = e.dur < 0.3 && e.start - (pe.start + pe.dur) < 0.1;
          if (md !== 0 && hd === 0 && !quick) t += 0.6;
          if (quick && c.pitch !== p.pitch) t += 0.7; // backing voices hold through runs
          else if (md !== 0 && hd === -md) t += 0.25;
          // Tendency tones: the leading tone rises to the tonic, the 4th degree falls to the 3rd.
          const ppc = pcOf(p.pitch), cpc = pcOf(c.pitch);
          if (ppc === lead && !key.minor && cpc !== key.tonic && c.pitch !== p.pitch) t += 0.5;
          if (ppc === fourth && cpc !== third && c.pitch !== p.pitch && c.pitch < p.pitch + 3) t += 0.3;
          const ivp = Math.abs(p.pitch - pe.pitch) % 12, ivc = Math.abs(c.pitch - e.pitch) % 12;
          if ((ivp === 7 || ivp === 0) && ivp === ivc && kind !== "5th" && Math.sign(c.pitch - p.pitch) === Math.sign(e.pitch - pe.pitch) && c.pitch !== p.pitch) t += 2.5;
          if (t < best) { best = t; bi = k; }
        });
        c.cost += best;
        c.back = bi;
      }
    }
    layers.push(cands);
  });
  const last = layers[layers.length - 1];
  let k = last.reduce((bi, s, i) => (s.cost < last[bi].cost ? i : bi), 0);
  const cost = last[k].cost / ph.length, line: number[] = new Array(ph.length);
  for (let i = layers.length - 1; i >= 0; i--) { line[i] = layers[i][k].pitch; k = layers[i][k].back; }
  return { line, cost };
}

/** Phrases: runs of notes separated by rests ≥ 1 beat. */
function phrases(mel: Ev[]): Ev[][] {
  const out: Ev[][] = [];
  for (const e of mel) {
    const cur = out[out.length - 1], last = cur?.[cur.length - 1];
    if (!cur || e.start - (last!.start + last!.dur) >= 1) out.push([e]);
    else cur.push(e);
  }
  return out;
}

export interface HarmonyAnalysis { key: Key; chords: Chord[] }

export function analyse(p: Project, src: Track): HarmonyAnalysis & { mel: Ev[] } {
  const mel = melodyOf(src), others = otherNotes(p, src);
  const key = estimateKey(p, mel, others);
  const end = Math.max(0, ...mel.map((e) => e.start + e.dur));
  return { mel, key, chords: chordsFor(p, mel, others, key, end + 2) };
}

export function writeHarmony(p: Project, src: Track, voice: HarmonyVoice, keepSide = false): Note[] {
  const { mel, key, chords } = analyse(p, src);
  const scale = (key.minor ? MINOR : MAJOR).map((s) => (s + key.tonic) % 12);
  const chordAt = (b: number) => chords.find((c) => b >= c.start - 1e-6 && b < c.end)?.tones ?? [];
  const out: Note[] = [];
  const vel = (e: Ev) => Math.max(1, Math.round(e.vel * 0.88));
  for (const ph of phrases(mel)) {
    let line: number[];
    if (voice === "oct-up" || voice === "oct-down") line = ph.map((e) => e.pitch + (voice === "oct-up" ? 12 : -12));
    else {
      const kind = voice.startsWith("smart") ? "smart" : voice.startsWith("3rd") ? "3rd" : "5th";
      const side: 1 | -1 = voice.endsWith("up") ? 1 : -1;
      // The asked side, unless the phrase sits so high/low that the other side is clearly better.
      const a = solve(ph, side, kind, scale, chordAt, key), b = solve(ph, side === 1 ? -1 : 1, kind, scale, chordAt, key);
      line = !keepSide && b.cost + 1.2 < a.cost ? b.line : a.line;
    }
    // Sung, not mirrored: a held harmony note across quick melody notes becomes one longer note.
    ph.forEach((e, i) => {
      const prev = out[out.length - 1];
      if (i > 0 && prev && prev.pitch === line[i] && e.dur < 0.3 && e.start - (prev.start + prev.dur) < 0.1) prev.dur = e.start + e.dur - prev.start;
      else out.push({ pitch: line[i], start: e.start, dur: e.dur, vel: vel(e) });
    });
  }
  return out;
}

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Adds one harmony track per voice under the source track (undoable). */
export function addHarmonyTracks(trackId: string, presetId: string) {
  const preset = HARMONY_PRESETS.find((x) => x.id === presetId);
  const p0 = store.project, src = p0.tracks.find((t) => t.id === trackId);
  if (!preset || !src || src.kind !== "midi") return;
  // Two voices: each keeps its side (above stays above, below stays below) so they never double.
  const voices = preset.voices.map((v) => ({ v, notes: writeHarmony(p0, src, v, preset.voices.length > 1) }));
  if (!voices[0].notes.length) {
    store.log(`Error: "${src.name}" has no notes to harmonise.`);
    return;
  }
  const { key } = analyse(p0, src);
  store.update((p) => {
    const i = p.tracks.findIndex((t) => t.id === trackId);
    voices.forEach(({ v, notes }, k) => {
      const end = Math.ceil(Math.max(...notes.map((n) => n.start + n.dur)) / 4) * 4;
      const clip: MidiClip = { id: uid("clip"), kind: "midi", start: 0, length: end, notes, anchored: src.clips.some((c) => c.kind === "midi" && c.anchored) };
      const t = midiTrack(`${src.name} · harmony ${VOICE_LABEL[v]}`, src.role, [clip], src.instrument);
      t.ch.volumeDb = (src.ch.volumeDb ?? 0) - 4;
      t.ch.pan = voices.length > 1 ? (k === 0 ? -0.35 : 0.35) : -0.25;
      t.color = src.color;
      p.tracks.splice(i + 1 + k, 0, t);
    });
  });
  const all = voices.flatMap((x) => x.notes);
  const inRange = all.filter((n) => n.pitch >= LO && n.pitch <= HI).length / all.length;
  store.log(`Harmony (${preset.label}) for "${src.name}" in ${NAMES[key.tonic]} ${key.minor ? "minor" : "major"} — ${voices.length} track${voices.length > 1 ? "s" : ""}, ${Math.round(inRange * 100)} % inside C3–C5.`);
}
