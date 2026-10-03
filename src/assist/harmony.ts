/**
 * Harmony writer for vocal / lead MIDI lines — a real harmony voice, not parallel intervals.
 *  - key, mode, chords: the harmony layer (analysis/harmonyLayer — every real part + the mix)
 *  - the band: a harmony note rubbing against what guitar / keys / bass play right then is out
 *  - the line: per phrase, a Viterbi search over candidate notes — in key (or a tone of the
 *    current chord), chord tones on strong beats / long notes, 3rds & 6ths preferred, 4ths & 5ths
 *    allowed, no 2nds / 7ths / tritones against the melody, smooth voice leading, no parallel
 *    5ths / octaves, kept inside C3–C5 (a phrase that can't fit on the asked side moves to the
 *    other side as a whole). So the interval moves with the melody (3rd, 4th, 6th, 5th…).
 * One new track per voice: same rhythm, instrument and role, a little softer, panned apart.
 */
import type { MidiClip, Note, Project, Track } from "../model/types";
import { store } from "../model/store";
import { midiTrack } from "./tracks";
import { uid } from "../model/types";
import { harmonyOf, type Harmony } from "../analysis/harmonyLayer";

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

/** Notes the harmony must agree with the chord on: half-bar downbeats and long notes. */
const strong = (e: Ev) => e.dur >= 1 || Math.abs(e.start / 2 - Math.round(e.start / 2)) < 0.03;

/** Interval preference (semitones between melody and harmony, mod 12) per voice kind. */
const IV_COST: Record<"smart" | "3rd" | "5th", Record<number, number>> = {
  smart: { 3: 0, 4: 0, 8: 0.15, 9: 0.15, 5: 0.7, 7: 0.6, 0: 3, 6: 4, 1: 9, 2: 9, 10: 9, 11: 9 },
  "3rd": { 3: 0, 4: 0, 8: 1.4, 9: 1.4, 5: 2, 7: 2.5, 0: 6, 6: 9, 1: 9, 2: 9, 10: 9, 11: 9 },
  "5th": { 7: 0, 5: 1.6, 8: 1.8, 9: 1.8, 3: 2.2, 4: 2.2, 0: 5, 6: 9, 1: 9, 2: 9, 10: 9, 11: 9 },
};

/** Best line for one phrase on one side (+1 above, −1 below) by Viterbi; returns pitches and cost per note. */
function solve(ph: Ev[], side: 1 | -1, kind: "smart" | "3rd" | "5th", scale: number[], chordAt: (b: number) => number[], key: Key, band: (pitch: number, e: Ev) => number = () => 0): { line: number[]; cost: number } {
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
      let cost = (IV_COST[kind][d % 12] ?? 9) + band(c, e);
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

/**
 * Song-wide key + chords for generators: every pitched MIDI track (bass weighted), the analysed
 * chord track where nothing else is known. `parts` = names starting "Gen ·" are ignored (earlier
 * generated parts must not feed the next one).
 */
export function songContext(p: Project, end: number): HarmonyAnalysis {
  const h = harmonyOf(p, { end });
  return { key: h.key, chords: h.chords.map((c) => ({ start: c.start, end: c.end, tones: c.tones })) };
}

/** Key + chords for a harmony: the harmony layer (all real parts + the mix), the source line included. */
export function analyse(p: Project, src: Track): HarmonyAnalysis & { mel: Ev[]; h: Harmony } {
  const mel = melodyOf(src);
  const h = harmonyOf(p);
  return { mel, h, key: h.key, chords: h.chords.map((c) => ({ start: c.start, end: c.end, tones: c.tones })) };
}

export function writeHarmony(p: Project, src: Track, voice: HarmonyVoice, keepSide = false): Note[] {
  const { mel, key, h } = analyse(p, src);
  const chordAt = (b: number) => h.chordAt(b).tones;
  const out: Note[] = [];
  const vel = (e: Ev) => Math.max(1, Math.round(e.vel * 0.88));
  // the rest of the band: a harmony note rubbing (semitone / tritone / major 7th) against what the
  // guitar, keys or bass play at that moment costs as much as a clash with the melody itself
  const band = h.heard.filter((x) => x.track !== src.id).map((x) => ({ start: x.s, dur: x.e - x.s, pitch: x.p, vel: 100 }));
  const bandCost = (pitch: number, e: Ev) => {
    const need = Math.min(0.2, e.dur * 0.4);
    let c = 0;
    for (const o of band) {
      if (o.start >= e.start + e.dur) break;
      if (Math.min(e.start + e.dur, o.start + o.dur) - Math.max(e.start, o.start) > need && [1, 6, 11].includes(pcOf(pitch - o.pitch))) c = 4;
    }
    return c;
  };
  for (const ph of phrases(mel)) {
    let line: number[];
    if (voice === "oct-up" || voice === "oct-down") line = ph.map((e) => e.pitch + (voice === "oct-up" ? 12 : -12));
    else {
      const kind = voice.startsWith("smart") ? "smart" : voice.startsWith("3rd") ? "3rd" : "5th";
      const side: 1 | -1 = voice.endsWith("up") ? 1 : -1;
      // The asked side, unless the phrase sits so high/low that the other side is clearly better.
      const sc = h.scaleAt(ph[0].start); // the section's own scale (modulations)
      const a = solve(ph, side, kind, sc, chordAt, key, bandCost), b = solve(ph, side === 1 ? -1 : 1, kind, sc, chordAt, key, bandCost);
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
