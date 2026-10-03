/**
 * Part generator: new pad / arpeggio / acoustic strum / metal riff / power-chord tracks written
 * from what the song already knows — key + chords (assist/harmony.songContext: pitched MIDI
 * tracks, bass weighted, else the analysed chord track), sections (energy, group), and the kick
 * pattern from drum MIDI. Deterministic (seeded), so regenerating gives the same part.
 *  - pad: 3–4-note voicings, smooth voice leading (least movement), warm register, add9 colour
 *    when the section is loud, velocity follows section energy
 *  - arpeggio: the pad's voice-led shapes broken into 8ths / up-down / 16ths by energy
 *  - acoustic strum: real guitar shapes (open chords, E/A-shape barres), down/up strokes with
 *    string-by-string spread, strum patterns by energy
 *  - metal riff: drop tuning from the key, palm-muted chugs locked to the kick (16th cells when
 *    there's no drum MIDI), power chords on chord changes, phrygian ♭2 / ♭5 pickups at phrase
 *    ends in loud sections, same riff for the same section type, double-tracked L/R
 *  - power chords: driving 8ths on root + 5th + octave
 */
import type { MidiClip, Note, Project, Role, Section, Track } from "../model/types";
import { store } from "../model/store";
import { uid } from "../model/types";
import { midiTrack } from "./tracks";
import { songContext } from "./harmony";
import { applySlides } from "./slides";

export type PartKind = "pad" | "arp" | "strum" | "metal" | "power" | "bass";
export const PART_KINDS: { id: PartKind; label: string; hint: string; role: Role; instrument: string }[] = [
  { id: "pad", label: "pad · chords", hint: "voice-led sustained chords", role: "pad", instrument: "synth:string-pad" },
  { id: "arp", label: "arpeggio", hint: "broken chords · 8ths / 16ths by section", role: "keys", instrument: "synth:arp-pluck" },
  { id: "strum", label: "acoustic strum", hint: "guitar shapes · down/up strokes", role: "guitar", instrument: "sampled:acoustic-martin" },
  { id: "metal", label: "metal riff · double-tracked", hint: "drop tuning · chugs on the kick · power chords", role: "guitar", instrument: "sampled:egtr-highgain" },
  { id: "power", label: "rock power chords", hint: "driving 8ths", role: "guitar", instrument: "sampled:egtr-highgain" },
  { id: "bass", label: "bass guitar", hint: "roots on the kick · approach notes · natural slides", role: "bass", instrument: "sampled:bass-fingered" },
];

interface ChordAt { start: number; end: number; root: number; minor: boolean; tones: number[] }
/** A note of a real (not generated) pitched part, absolute beats. */
interface Heard { s: number; e: number; p: number; bass: boolean }
interface Ctx { key: { tonic: number; minor: boolean }; chords: ChordAt[]; sections: Section[]; kicks: number[]; end: number; bpm: number; scale: number[]; melody: Note[]; heard: Heard[] }

const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const pcOf = (p: number) => ((p % 12) + 12) % 12;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function context(p: Project): Ctx {
  const hasPitched = p.tracks.some((t) => t.kind === "midi" && t.role !== "drums" && !t.dp && t.clips.some((c) => c.kind === "midi" && c.notes.length));
  if (!hasPitched && !p.chords.length) throw new Error("no chords to follow yet — convert a stem to MIDI (or split stems so the song is analysed) first");
  // where the music actually ends (the project length carries 8 beats of padding after it)
  const spb = 60 / p.bpm;
  let end = 0;
  for (const t of p.tracks) if (!t.name.startsWith("Gen ·")) for (const cl of t.clips) end = Math.max(end, cl.start + (cl.kind === "midi" ? cl.length : cl.duration / spb));
  for (const cs of p.chords) end = Math.max(end, cs.start + cs.length);
  end = Math.max(4, Math.ceil(end / 4) * 4);
  const { key, chords } = songContext(p, end);
  const ch: ChordAt[] = chords.filter((c) => c.tones.length).map((c) => ({ start: c.start, end: Math.min(c.end, end), root: c.tones[0], minor: c.tones.length > 2 && pcOf(c.tones[1] - c.tones[0]) === 3, tones: c.tones }));
  // kick hits from drum MIDI (GM 35/36), absolute beats
  const kicks: number[] = [];
  for (const t of p.tracks) if (t.kind === "midi" && t.role === "drums") for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if ((n.pitch === 35 || n.pitch === 36) && n.start < c.length) kicks.push(c.start + n.start);
  if (kicks.length < 8) {
    kicks.length = 0;
    for (const t of p.tracks) if (t.kind === "midi" && t.role === "bass" && !t.name.startsWith("Gen ·")) for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if (n.start < c.length) kicks.push(Math.round((c.start + n.start) * 4) / 4);
  }
  kicks.sort((a, b) => a - b);
  const sections = p.sections.length ? p.sections : [{ start: 0, length: end, label: "Song", group: "A", energy: 2 } as Section];
  // the melody (vocal / lead MIDI, absolute beats): accompaniment must not rub against it
  const melody: Note[] = [];
  for (const t of p.tracks) if (t.kind === "midi" && (t.role === "vocals" || t.role === "lead") && !t.name.startsWith("Gen ·")) for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if (n.start < c.length) melody.push({ ...n, start: c.start + n.start });
  melody.sort((a, b) => a.start - b.start);
  // everything the real parts play (bass, guitar, keys, vocals…): generated notes must sit with it
  const heard: Heard[] = [];
  for (const t of p.tracks) {
    if (t.kind !== "midi" || t.role === "drums" || t.dp || t.name.startsWith("Gen ·") || t.name.includes("· harmony")) continue;
    for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if (n.start < c.length) heard.push({ s: c.start + n.start, e: c.start + Math.min(c.length, n.start + n.dur), p: n.pitch, bass: t.role === "bass" });
  }
  heard.sort((a, b) => a.s - b.s);
  return { key, chords: ch, sections, kicks, end, bpm: p.bpm, scale: (key.minor ? MINOR : MAJOR).map((s) => (s + key.tonic) % 12), melody, heard };
}

/** Pitch class the real bass plays at a beat (the longest-sounding note there), or null. */
function bassAt(c: Ctx, b: number): number | null {
  let best: Heard | null = null;
  for (const h of c.heard) {
    if (h.s > b + 0.13) break;
    if (h.bass && h.e > b + 0.05 && (!best || h.e - h.s > best.e - best.s)) best = h;
  }
  return best ? pcOf(best.p) : null;
}

const BAD = [1, 6, 11]; // semitone, tritone, major 7th (and their octaves)
/** Real notes overlapping [s, e) by a meaningful amount. */
function heardDuring(c: Ctx, s: number, e: number): number[] {
  const out: number[] = [], need = Math.min(0.2, (e - s) * 0.4);
  for (const h of c.heard) {
    if (h.s >= e) break;
    if (Math.min(e, h.e) - Math.max(s, h.s) > need) out.push(h.p);
  }
  return out;
}

/**
 * Sit with the band: a generated note that rubs (semitone / tritone / major 7th) against a real
 * part sounding at the same time moves to the nearest key / chord note that doesn't (≤ 2
 * semitones); a chord voice that can't is dropped (the rest of the chord still sounds); a single
 * line note that can't keeps its pitch. Notes landing on the same pitch at the same onset merge.
 */
function sitWithBand(c: Ctx, notes: Note[], poly: boolean): Note[] {
  if (!c.heard.length) return notes;
  const chordAt = (b: number) => c.chords.find((x) => b >= x.start - 1e-6 && b < x.end)?.tones ?? [];
  const out: Note[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const real = heardDuring(c, n.start, n.start + n.dur);
    const rubs = (p: number) => real.some((m) => BAD.includes(pcOf(p - m)));
    let pitch = n.pitch;
    if (rubs(pitch)) {
      const ok = new Set([...c.scale, ...chordAt(n.start + 0.01), ...real.map(pcOf)]);
      const alt = [1, -1, 2, -2].map((d) => pitch + d).find((p) => ok.has(pcOf(p)) && !rubs(p));
      if (alt !== undefined) pitch = alt;
      else if (poly) continue;
    }
    const k = `${pitch}@${n.start.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pitch === n.pitch ? n : { ...n, pitch });
  }
  return out;
}

const sectionAt = (c: Ctx, beat: number) => c.sections.find((s) => beat >= s.start && beat < s.start + s.length) ?? c.sections[c.sections.length - 1];
/** Chord spans cut at section boundaries (so patterns can follow section energy). */
function spans(c: Ctx): (ChordAt & { sec: Section })[] {
  const out: (ChordAt & { sec: Section })[] = [];
  for (const ch of c.chords) {
    let s = ch.start;
    while (s < ch.end - 1e-6) {
      const sec = sectionAt(c, s);
      const e = Math.min(ch.end, sec.start + sec.length);
      out.push({ ...ch, start: s, end: Math.max(e, s + 0.25), sec });
      s = Math.max(e, s + 0.25);
    }
  }
  return out;
}

/* ── voicings ──────────────────────────────────────────────────────────────────────────────── */

/** Best 3–4-note voicing of pitch classes in [lo, hi]: least movement from `prev`, open low end. */
function voiceLead(pcs: number[], prev: number[] | null, lo: number, hi: number, topTarget: number): number[] {
  const cands: number[][] = [];
  const place = (i: number, acc: number[]) => {
    if (i === pcs.length) {
      const v = [...acc].sort((a, b) => a - b);
      if (v[v.length - 1] - v[0] > 19) return;
      if (v[0] < 52 && v.length > 1 && v[1] - v[0] < 5) return; // no muddy close intervals down low
      cands.push(v);
      return;
    }
    for (let p = lo; p <= hi; p++) if (pcOf(p) === pcs[i] && !acc.includes(p)) place(i + 1, [...acc, p]);
  };
  place(0, []);
  if (!cands.length) return pcs.map((pc) => lo + pcOf(pc - lo));
  const cost = (v: number[]) => {
    let c = Math.abs(v[v.length - 1] - topTarget) * 0.15;
    if (prev) {
      const a = [...prev].sort((x, y) => x - y);
      for (let i = 0; i < Math.min(a.length, v.length); i++) c += Math.abs(a[i] - v[i]);
    }
    return c;
  };
  return cands.reduce((b, v) => (cost(v) < cost(b) ? v : b));
}

/** Melody notes sounding at a beat (pitches). */
const melodyAt = (c: Ctx, b: number) => c.melody.filter((m) => m.start <= b + 1e-6 && m.start + m.dur > b + 0.02).map((m) => m.pitch);
/** Lowest melody note in a span (accompaniment stays under it), or null. */
const melodyLow = (c: Ctx, a: number, z: number) => {
  const ps = c.melody.filter((m) => m.start < z && m.start + m.dur > a).map((m) => m.pitch);
  return ps.length ? Math.min(...ps) : null;
};
/** A semitone / tritone against a sounding melody note → the nearest chord tone that doesn't. */
function avoidClash(c: Ctx, pitch: number, b: number, chordPcs: number[]): number {
  const mel = melodyAt(c, b);
  const clashes = (p: number) => mel.some((m) => [1, 6, 11].includes(pcOf(p - m)));
  if (!clashes(pitch)) return pitch;
  for (const d of [1, -1, 2, -2, 3, -3, 4, -4]) if (chordPcs.includes(pcOf(pitch + d)) && !clashes(pitch + d)) return pitch + d;
  return pitch;
}
/** Notes per beat that stay musical at this tempo (≈ 4–7 notes a second at most). */
const rateFor = (bpm: number, energy: number) => {
  const wanted = energy >= 3 ? 4 : energy >= 2 ? 2 : 2; // 16ths when loud, 8ths otherwise
  let step = 1 / wanted;
  while ((bpm / 60) / step > 7.5 && step < 1) step *= 2; // too fast → halve the rate
  return step;
};

const velFor = (sec: Section, base: number) => Math.max(30, Math.min(124, Math.round(base + (sec.energy - 1.5) * 12)));

function genPad(c: Ctx): Note[] {
  const out: Note[] = [];
  let prev: number[] | null = null;
  for (const s of spans(c)) {
    const color = s.sec.energy >= 2 && c.scale.includes((s.root + 2) % 12); // add9 when loud and diatonic
    const pcs = color ? [...s.tones, (s.root + 2) % 12] : s.tones;
    const v = voiceLead(pcs, prev, 50, 74, 67);
    prev = v;
    for (const p of v) out.push({ pitch: p, start: s.start, dur: Math.max(0.25, s.end - s.start - 0.02), vel: velFor(s.sec, 72) });
  }
  return out;
}

function genArp(c: Ctx, seed: number): Note[] {
  const out: Note[] = [];
  let prev: number[] | null = null;
  void seed;
  for (const s of spans(c)) {
    const e = Math.round(s.sec.energy);
    // colour from the key: the diatonic 7th (and 9th when loud) on top of the triad
    const seventh = [10, 11].map((iv) => (s.root + iv) % 12).find((pc) => c.scale.includes(pc));
    const ninth = (s.root + 2) % 12;
    const pcs = [...s.tones, ...(e >= 2 && seventh !== undefined ? [seventh] : []), ...(e >= 3 && c.scale.includes(ninth) ? [ninth] : [])];
    // stay under the melody (a 3rd below its lowest note in this span), never above C5
    const ml = melodyLow(c, s.start, s.end);
    const hi = Math.min(72, ml !== null ? ml - 3 : 72), lo = Math.min(52, hi - 14);
    let v = voiceLead(pcs.slice(0, 4), prev, lo, hi, hi - 5);
    prev = v;
    if (v.length < 3) v = [...v, v[0] + 12]; // power chord (root + 5th): the octave completes the shape
    const step = rateFor(c.bpm, e);
    const shape = e <= 1 ? [...v, v[0] + 12] : e === 2 ? [...v, ...[...v].reverse().slice(1, -1)] : [v[0], v[1], v[2], v[0] + 12, v[2], v[1]];
    let i = 0;
    for (let b = s.start; b < s.end - 1e-6; b += step, i++) {
      const onBeat = Math.abs(b - Math.round(b)) < 1e-6;
      const pitch = avoidClash(c, shape[i % shape.length], b, pcs);
      out.push({ pitch, start: b, dur: Math.min(step * 0.92, s.end - b), vel: velFor(s.sec, onBeat ? 84 : 70) });
    }
  }
  return out;
}

/** Guitar chord shape (standard tuning): open chord where one exists, else E- or A-shape barre. */
function guitarShape(root: number, minor: boolean): number[] {
  const OPEN: Record<string, number[]> = {
    "0M": [48, 52, 55, 60, 64], "7M": [43, 47, 50, 55, 59, 67], "2M": [50, 57, 62, 66], "9M": [45, 52, 57, 61, 64], "4M": [40, 47, 52, 56, 59, 64],
    "9m": [45, 52, 57, 60, 64], "4m": [40, 47, 52, 55, 59, 64], "2m": [50, 57, 62, 65],
  };
  const open = OPEN[`${root}${minor ? "m" : "M"}`];
  if (open) return open;
  const e = pcOf(root - 4), a = pcOf(root - 9), third = minor ? 3 : 4;
  if (e <= a && e <= 7) return [40 + e, 47 + e, 52 + e, 52 + e + third, 59 + e, 64 + e].map((x, i) => (i === 3 ? 52 + e + third : x));
  return [45 + a, 52 + a, 57 + a, 57 + a + third, 64 + a];
}

const STRUMS: Record<number, string[]> = {
  0: ["D......."], // one strum per bar (8ths grid)
  1: ["D...D..."],
  2: ["D.DU.UDU", "D.D.DUDU"],
  3: ["DUDUDUDU"],
};

function genStrum(c: Ctx, seed: number): Note[] {
  const out: Note[] = [], r = rng(seed), spb = 60 / c.bpm;
  for (const s of spans(c)) {
    // only strings that sound a chord tone (a power chord's shape drops the 3rd)
    const full = guitarShape(s.root, s.minor), shape = full.filter((p) => s.tones.includes(pcOf(p)));
    // tempo: above ~150 bpm the 8th-note patterns become a blur → one step calmer
    const lvl = Math.max(0, Math.min(3, Math.round(s.sec.energy) - (c.bpm > 150 ? 1 : 0)));
    const pats = STRUMS[lvl];
    const pat = pats[Math.floor(r() * pats.length) % pats.length];
    for (let b = Math.ceil(s.start * 2) / 2; b < s.end - 1e-6; b += 0.5) {
      const ch = pat[Math.round((b % 4) * 2) % 8];
      if (ch === ".") continue;
      const down = ch === "D";
      // strings that would rub (semitone / tritone) against the sung note are left out of this stroke
      const mel = melodyAt(c, b);
      const ok = (p: number) => !mel.some((m) => [1, 6, 11].includes(pcOf(p - m)));
      const strings = (down ? shape : shape.slice(-4).reverse()).filter(ok);
      const spread = (down ? 0.012 : 0.008) / spb; // stroke speed (s → beats)
      const len = Math.max(0.2, Math.min(s.end, b + 0.5 * (pat.slice(Math.round((b % 4) * 2) % 8 + 1).search(/[DU]/) + 1 || 2)) - b);
      strings.forEach((p, k) => out.push({ pitch: p, start: b + k * spread, dur: len - k * spread, vel: velFor(s.sec, (down ? 88 : 66) - k * 2 + (Math.abs(b - Math.round(b)) < 1e-6 ? 6 : 0)) }));
    }
  }
  return out;
}

/** Drop tuning whose low string is the key's tonic (A1…E2), else drop B. Returns the low string pitch. */
function dropTuning(tonic: number): number {
  for (const low of [31, 32, 33, 34, 35, 36, 37, 38, 40]) if (pcOf(low) === tonic) return low; // drop G … E
  return 35;
}

const RIFF_CELLS = ["x.xxx.xxx.xxx.xx", "xxxxx...xxxxx...", "x..x..x.x..x..x.", "x.x.x.x.xxxxx.x.", "xx.xxx.xxx.xxx.x", "x...x...x...xxxx"];

function genMetal(c: Ctx, seed: number): Note[] {
  const out: Note[] = [];
  const low = dropTuning(c.key.tonic);
  const rootLow = (pc: number) => low + pcOf(pc - low);
  const cellFor = new Map<string, string>(), r = rng(seed);
  const chordAt = (b: number) => c.chords.find((x) => b >= x.start - 1e-6 && b < x.end) ?? c.chords[0];
  for (let bar = 0; bar * 4 < c.end; bar++) {
    const b0 = bar * 4, sec = sectionAt(c, b0);
    if (sec.energy <= 0) continue; // intros / breakdowns at energy 0: let it breathe
    // rhythm: the kick (if there's drum MIDI in this bar), else the section group's 16th cell
    let hits = c.kicks.filter((k) => k >= b0 && k < b0 + 4).map((k) => Math.round(k * 4) / 4);
    if (hits.length < 2) {
      if (!cellFor.has(sec.group)) cellFor.set(sec.group, RIFF_CELLS[Math.floor(r() * RIFF_CELLS.length)]);
      const cell = cellFor.get(sec.group)!;
      hits = [...cell].flatMap((x, i) => (x === "x" ? [b0 + i / 4] : []));
      if (sec.energy <= 1) hits = hits.filter((h) => Math.abs(h - Math.round(h * 2) / 2) < 1e-6); // calmer: 8ths only
    }
    hits = [...new Set(hits)].sort((a, x) => a - x);
    hits.forEach((h, i) => {
      const ch = chordAt(h), root = rootLow(bassAt(c, h) ?? ch.root);
      const isChange = c.chords.some((x) => Math.abs(x.start - h) < 0.13) || i === 0 && bar % 4 === 0;
      const next = hits[i + 1] ?? b0 + 4;
      if (isChange) {
        // power chord on the change: root + 5th + octave, ringing to the next hit
        for (const iv of [0, 7, 12]) out.push({ pitch: root + iv, start: h, dur: Math.max(0.2, next - h - 0.02), vel: velFor(sec, 116) });
      } else out.push({ pitch: root, start: h, dur: 0.11, vel: velFor(sec, 104) + (Math.abs(h - Math.round(h)) < 1e-6 ? 6 : 0) }); // palm-muted chug
    });
    // phrase-end pickup (every 4th bar, loud sections): phrygian ♭2 or ♭5 — the menace notes
    if (bar % 4 === 3 && sec.energy >= 2) {
      const t = rootLow(c.key.tonic);
      const deg = (n: number) => { const i = c.scale.indexOf(c.key.tonic); return t + pcOf(c.scale[(i + n + 7) % 7] - c.key.tonic); };
      const pick = r() < 0.5 ? [deg(1), t] : [deg(5) - 12 >= t ? deg(5) - 12 : deg(5), deg(4)]; // 2→1, or 6→5
      out.push({ pitch: pick[0] + 12, start: b0 + 3.5, dur: 0.22, vel: velFor(sec, 112) }, { pitch: pick[1] + 12, start: b0 + 3.75, dur: 0.22, vel: velFor(sec, 112) });
    }
  }
  return out.filter((n) => n.start < c.end);
}

function genPower(c: Ctx): Note[] {
  const out: Note[] = [];
  for (const s of spans(c)) {
    const step = s.sec.energy >= 2 ? 0.5 : 1;
    for (let b = Math.ceil(s.start / step) * step; b < s.end - 1e-6; b += step) {
      const root = 40 + pcOf((bassAt(c, b) ?? s.root) - 40);
      const onBeat = Math.abs(b - Math.round(b)) < 1e-6;
      for (const iv of [0, 7, 12]) out.push({ pitch: root + iv, start: b, dur: step * 0.9, vel: velFor(s.sec, onBeat ? 108 : 96) });
    }
  }
  return out;
}

/**
 * Bass: roots in E1–E2 (octave nearest the previous note), rhythm by section energy — whole
 * notes / half notes on root + 5th / 8ths on the kick with approach notes into chord changes /
 * a root pedal on every kick with octave pops (metal: doubling the guitar chugs).
 */
function genBass(c: Ctx, seed: number): Note[] {
  const out: Note[] = [], r = rng(seed);
  let prev = 33;
  const rootNear = (pc: number) => {
    let best = 28 + pcOf(pc - 28);
    for (const p of [best, best + 12]) if (p <= 43 && Math.abs(p - prev) < Math.abs(best - prev)) best = p;
    return best;
  };
  const chordAt = (b: number) => c.chords.find((x) => b >= x.start - 1e-6 && b < x.end) ?? c.chords[0];
  const nextChange = (b: number) => c.chords.find((x) => x.start > b + 1e-6);
  for (let bar = 0; bar * 4 < c.end; bar++) {
    const b0 = bar * 4, sec = sectionAt(c, b0), e = Math.round(sec.energy);
    let hits: number[];
    if (e <= 0) hits = [b0];
    else if (e === 1) hits = [b0, b0 + 2];
    else {
      const k = c.kicks.filter((x) => x >= b0 && x < b0 + 4).map((x) => Math.round(x * 4) / 4);
      hits = k.length >= 2 ? k : e >= 3 ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((x) => b0 + x) : [0, 1, 1.5, 2.5, 3, 3.5].map((x) => b0 + x);
      if (e === 2 && !hits.includes(b0)) hits.unshift(b0);
    }
    hits = [...new Set(hits)].sort((a, b) => a - b);
    hits.forEach((h, i) => {
      const ch = chordAt(h), nx = hits[i + 1] ?? b0 + 4;
      const real = bassAt(c, h);
      let pitch = rootNear(real ?? ch.root);
      if (i === 0) prev = pitch;
      // half-note feel: the 5th on beat 3 now and then
      if (e === 1 && i === 1 && r() < 0.5) pitch = pitch + 7 > 43 ? pitch - 5 : pitch + 7;
      // octave pop in loud bars (beat 3 / last 8th), on the root
      if (e >= 3 && Math.abs(h - (b0 + 2.5)) < 1e-6 && r() < 0.4) pitch += 12;
      // approach note: the last hit before a chord change walks into the next root
      const nc = nextChange(h);
      if (real === null && e >= 2 && nc && nc.start <= nx + 1e-6 && nc.start - h <= 1 && i > 0) {
        const target = rootNear(nc.root);
        const below = [target - 1, target - 2].find((p) => c.scale.includes(pcOf(p)));
        const above = [target + 1, target + 2].find((p) => c.scale.includes(pcOf(p)) && p <= 43);
        pitch = r() < 0.5 && below !== undefined ? below : above !== undefined && r() < 0.3 ? above : pitch;
      }
      const dur = e <= 1 ? Math.max(0.5, nx - h - 0.05) : e >= 3 ? Math.min(0.42, nx - h - 0.03) : Math.max(0.2, Math.min(0.9, nx - h - 0.04));
      out.push({ pitch, start: h, dur, vel: velFor(sec, Math.abs(h - Math.round(h)) < 1e-6 ? 104 : 92) });
      prev = pitch;
    });
  }
  const line = out.filter((n) => n.start < c.end).sort((a, b) => a.start - b.start);
  applySlides(line.map((n) => ({ n, abs: n.start })), 60 / c.bpm, seed + 3);
  return line;
}

/** Slight timing / velocity differences between double-tracked takes (seeded). */
function humanize(notes: Note[], seed: number, spb: number): Note[] {
  const r = rng(seed);
  return notes.map((n) => ({ ...n, start: Math.max(0, n.start + ((r() - 0.5) * 0.012) / spb), vel: Math.max(1, Math.min(127, Math.round(n.vel + (r() - 0.5) * 10))) }));
}

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Generate a part as new track(s) at the end of the track list (undoable). */
export function generatePart(kind: PartKind) {
  const p0 = store.project, c = context(p0), def = PART_KINDS.find((k) => k.id === kind)!;
  const seed = Math.round(p0.bpm * 1000) + c.chords.length * 7 + kind.length;
  const spb = 60 / p0.bpm;
  const takes: { name: string; notes: Note[]; pan: number }[] =
    kind === "pad" ? [{ name: "Gen · Pad", notes: genPad(c), pan: 0 }]
    : kind === "arp" ? [{ name: "Gen · Arpeggio", notes: genArp(c, seed), pan: 0.2 }]
    : kind === "strum" ? [{ name: "Gen · Acoustic", notes: genStrum(c, seed), pan: -0.3 }]
    : kind === "power" ? [{ name: "Gen · Power chords", notes: genPower(c), pan: 0 }]
    : kind === "bass" ? [{ name: "Gen · Bass", notes: genBass(c, seed), pan: 0 }]
    : (() => {
        const riff = genMetal(c, seed);
        return [{ name: "Gen · Riff L", notes: humanize(riff, seed + 1, spb), pan: -0.85 }, { name: "Gen · Riff R", notes: humanize(riff, seed + 2, spb), pan: 0.85 }];
      })();
  for (const tk of takes) tk.notes = sitWithBand(c, tk.notes, kind !== "bass");
  if (!takes[0].notes.length) throw new Error("nothing to generate (no chords found in the song)");
  store.update((p) => {
    for (const tk of takes) {
      const end = Math.ceil(Math.max(...tk.notes.map((n) => n.start + n.dur)) / 4) * 4;
      const clip: MidiClip = { id: uid("clip"), kind: "midi", start: 0, length: end, notes: tk.notes, anchored: false };
      const t: Track = midiTrack(tk.name, def.role, [clip], def.instrument);
      t.ch.pan = tk.pan;
      t.ch.volumeDb = kind === "pad" ? -6 : kind === "bass" ? 0 : -3;
      p.tracks.push(t);
    }
  });
  const tuning = kind === "metal" ? ` · drop ${NAMES[pcOf(dropTuning(c.key.tonic))]} tuning${c.kicks.length ? " · chugs locked to the kick" : ""}` : "";
  store.log(`Generated ${def.label} in ${NAMES[c.key.tonic]} ${c.key.minor ? "minor" : "major"} from ${c.chords.length} chord changes${tuning}.`);
}
