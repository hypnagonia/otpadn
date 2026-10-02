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

export type PartKind = "pad" | "arp" | "strum" | "metal" | "power";
export const PART_KINDS: { id: PartKind; label: string; hint: string; role: Role; instrument: string }[] = [
  { id: "pad", label: "pad · chords", hint: "voice-led sustained chords", role: "pad", instrument: "synth:string-pad" },
  { id: "arp", label: "arpeggio", hint: "broken chords · 8ths / 16ths by section", role: "keys", instrument: "synth:glass-pad" },
  { id: "strum", label: "acoustic strum", hint: "guitar shapes · down/up strokes", role: "guitar", instrument: "sampled:acoustic-martin" },
  { id: "metal", label: "metal riff · double-tracked", hint: "drop tuning · chugs on the kick · power chords", role: "guitar", instrument: "sampled:egtr-highgain" },
  { id: "power", label: "rock power chords", hint: "driving 8ths", role: "guitar", instrument: "sampled:egtr-highgain" },
];

interface ChordAt { start: number; end: number; root: number; minor: boolean; tones: number[] }
interface Ctx { key: { tonic: number; minor: boolean }; chords: ChordAt[]; sections: Section[]; kicks: number[]; end: number; bpm: number; scale: number[] }

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
  const end = Math.max(16, p.lengthBeats);
  const { key, chords } = songContext(p, end);
  const ch: ChordAt[] = chords.filter((c) => c.tones.length).map((c) => ({ start: c.start, end: Math.min(c.end, end), root: c.tones[0], minor: pcOf(c.tones[1] - c.tones[0]) === 3, tones: c.tones }));
  // kick hits from drum MIDI (GM 35/36), absolute beats
  const kicks: number[] = [];
  for (const t of p.tracks) if (t.kind === "midi" && t.role === "drums") for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if ((n.pitch === 35 || n.pitch === 36) && n.start < c.length) kicks.push(c.start + n.start);
  kicks.sort((a, b) => a - b);
  const sections = p.sections.length ? p.sections : [{ start: 0, length: end, label: "Song", group: "A", energy: 2 } as Section];
  return { key, chords: ch, sections, kicks, end, bpm: p.bpm, scale: (key.minor ? MINOR : MAJOR).map((s) => (s + key.tonic) % 12) };
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
  const r = rng(seed);
  for (const s of spans(c)) {
    const v = voiceLead(s.tones, prev, 52, 72, 67);
    prev = v;
    const e = s.sec.energy, step = e >= 3 || c.bpm < 100 ? 0.25 : 0.5;
    const shape = e <= 1 ? [...v, v[0] + 12] : e === 2 ? [...v, v[0] + 12, ...[...v].reverse().slice(1, -1)] : [v[0], v[1], v[2], v[0] + 12, v[2], v[1]];
    let i = Math.floor(r() * 0); // phrase starts on the root
    for (let b = s.start; b < s.end - 1e-6; b += step, i++) {
      const onBeat = Math.abs(b - Math.round(b)) < 1e-6;
      out.push({ pitch: shape[i % shape.length], start: b, dur: step * 0.92, vel: velFor(s.sec, onBeat ? 84 : 70) });
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
    const shape = guitarShape(s.root, s.minor);
    const pats = STRUMS[Math.max(0, Math.min(3, Math.round(s.sec.energy)))];
    const pat = pats[Math.floor(r() * pats.length) % pats.length];
    for (let b = Math.ceil(s.start * 2) / 2; b < s.end - 1e-6; b += 0.5) {
      const ch = pat[Math.round((b % 4) * 2) % 8];
      if (ch === ".") continue;
      const down = ch === "D", strings = down ? shape : shape.slice(-4).reverse();
      const spread = (down ? 0.012 : 0.008) / spb; // stroke speed (s → beats)
      const len = Math.max(0.2, Math.min(s.end, b + 0.5 * (pat.slice(Math.round((b % 4) * 2) % 8 + 1).search(/[DU]/) + 1 || 2)) - b);
      strings.forEach((p, k) => out.push({ pitch: p, start: b + k * spread, dur: len - k * spread, vel: velFor(s.sec, (down ? 88 : 66) - k * 2 + (Math.abs(b - Math.round(b)) < 1e-6 ? 6 : 0)) }));
    }
  }
  return out;
}

/** Drop tuning whose low string is the key's tonic (A1…E2), else drop B. Returns the low string pitch. */
function dropTuning(tonic: number): number {
  for (const low of [33, 34, 35, 36, 37, 38, 40]) if (pcOf(low) === tonic) return low;
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
      const ch = chordAt(h), root = rootLow(ch.root);
      const isChange = c.chords.some((x) => Math.abs(x.start - h) < 0.13) || i === 0 && bar % 4 === 0;
      const next = hits[i + 1] ?? b0 + 4;
      if (isChange) {
        // power chord on the change: root + 5th + octave, ringing to the next hit
        for (const iv of [0, 7, 12]) out.push({ pitch: root + iv, start: h, dur: Math.max(0.2, next - h - 0.02), vel: velFor(sec, 116) });
      } else out.push({ pitch: root, start: h, dur: 0.11, vel: velFor(sec, 104) + (Math.abs(h - Math.round(h)) < 1e-6 ? 6 : 0) }); // palm-muted chug
    });
    // phrase-end pickup (every 4th bar, loud sections): phrygian ♭2 or ♭5 — the menace notes
    if (bar % 4 === 3 && sec.energy >= 2) {
      const t = rootLow(c.key.tonic), pick = r() < 0.5 ? [t + 1, t] : [t + 6, t + 7];
      out.push({ pitch: pick[0] + 12, start: b0 + 3.5, dur: 0.22, vel: velFor(sec, 112) }, { pitch: pick[1] + 12, start: b0 + 3.75, dur: 0.22, vel: velFor(sec, 112) });
    }
  }
  return out.filter((n) => n.start < c.end);
}

function genPower(c: Ctx): Note[] {
  const out: Note[] = [];
  for (const s of spans(c)) {
    const root = 40 + pcOf(s.root - 40);
    const step = s.sec.energy >= 2 ? 0.5 : 1;
    for (let b = Math.ceil(s.start / step) * step; b < s.end - 1e-6; b += step) {
      const onBeat = Math.abs(b - Math.round(b)) < 1e-6;
      for (const iv of [0, 7, 12]) out.push({ pitch: root + iv, start: b, dur: step * 0.9, vel: velFor(s.sec, onBeat ? 108 : 96) });
    }
  }
  return out;
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
    : (() => {
        const riff = genMetal(c, seed);
        return [{ name: "Gen · Riff L", notes: humanize(riff, seed + 1, spb), pan: -0.85 }, { name: "Gen · Riff R", notes: humanize(riff, seed + 2, spb), pan: 0.85 }];
      })();
  if (!takes[0].notes.length) throw new Error("nothing to generate (no chords found in the song)");
  store.update((p) => {
    for (const tk of takes) {
      const end = Math.ceil(Math.max(...tk.notes.map((n) => n.start + n.dur)) / 4) * 4;
      const clip: MidiClip = { id: uid("clip"), kind: "midi", start: 0, length: end, notes: tk.notes, anchored: false };
      const t: Track = midiTrack(tk.name, def.role, [clip], def.instrument);
      t.ch.pan = tk.pan;
      t.ch.volumeDb = kind === "pad" ? -6 : -3;
      p.tracks.push(t);
    }
  });
  const tuning = kind === "metal" ? ` · drop ${NAMES[pcOf(dropTuning(c.key.tonic))]} tuning${c.kicks.length ? " · chugs locked to the kick" : ""}` : "";
  store.log(`Generated ${def.label} in ${NAMES[c.key.tonic]} ${c.key.minor ? "minor" : "major"} from ${c.chords.length} chord changes${tuning}.`);
}
