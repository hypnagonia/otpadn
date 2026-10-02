/** Pure pipeline: source → harmony → clean → rework (3 variants) → groove → sound pick. Runs in the worker. */
import { applyOverrides, chordsFromBass, chordsFromNotes, chordsFromProject, keyFromNotes, tidyProgression, type PartSection } from "./harmony";
import { cleanPart } from "./clean";
import { groovePart } from "./groove";
import { reworkPart } from "./rework";
import { autoSound } from "./sound";
import { detectStrums } from "./strum";
import { PP_ALGO_VERSION, type Chord, type PartSession, type PEvent, type PipelineResult, type Variant } from "./types";

export type PartInput = Pick<PartSession, "mode" | "source" | "harmony" | "clean" | "rework" | "groove" | "seed" | "layerSeeds" | "locks"> & {
  bpm: number;
  projectKey: { tonic: number; minor: boolean } | null;
  /** Project chord spans in absolute beats (from audio analysis). */
  projectChords: { start: number; length: number; root: number; minor: boolean }[];
  /** Bass mode: kick-drum onsets in the region (beats), from the project's drum tracks. */
  kicks: number[];
  openShapes: boolean;
  /** Song sections overlapping the region, relative to its start (from the project's analysis). */
  sections?: PartSection[];
};

/**
 * Sections for the chart: the project's, or (no analysis) 8-bar phrases whose energy comes from the
 * part's own density — busier phrases get busier patterns.
 */
function sectionsFor(inp: PartInput, events: PEvent[], len: number): PartSection[] {
  if (inp.sections?.length) return inp.sections;
  const out: PartSection[] = [];
  const dens: number[] = [];
  for (let a = 0; a < len - 1e-9; a += 32) {
    const b = Math.min(len, a + 32);
    out.push({ start: a, length: b - a, label: "phrase", group: "A", energy: 2 });
    dens.push(new Set(events.filter((e) => e.start >= a && e.start < b).map((e) => Math.round(e.start * 4))).size / ((b - a) / 4));
  }
  const hi = Math.max(...dens, 0), lo = Math.min(...dens, Infinity);
  if (dens.length > 1 && hi > lo * 1.25)
    out.forEach((s, i) => (s.energy = dens[i] >= hi * 0.88 ? 3 : dens[i] <= lo * 1.12 ? 1 : 2)); // relative to the busiest / calmest phrase
  else if (dens.length) {
    const d = dens.reduce((x, y) => x + y, 0) / dens.length; // onsets per bar
    out.forEach((s) => (s.energy = d >= 6 ? 3 : d >= 3 ? 2 : 1));
  }
  return out;
}

export function sourceEvents(inp: Pick<PartInput, "source" | "locks">): PEvent[] {
  const locked = new Set(inp.locks.events.map((e) => e.id));
  return inp.source.notes
    .map((n, idx): PEvent => ({ id: `s${idx}`, pitch: n.pitch, start: n.start, micro: 0, dur: Math.max(0.02, Math.min(n.dur, inp.source.length - n.start)), vel: n.vel, origin: "source", src: { start: n.start, pitch: n.pitch, dur: n.dur, vel: n.vel, idx }, locked: locked.has(`s${idx}`) || undefined, conf: typeof n.conf === "number" ? n.conf : undefined }))
    .filter((e) => e.start >= 0 && e.start < inp.source.length)
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function polyphony(evs: PEvent[]) {
  if (!evs.length) return 0;
  let groups = 0, i = 0;
  const s = [...evs].sort((a, b) => a.start - b.start);
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].start - s[i].start < 0.06) j++;
    groups++;
    i = j + 1;
  }
  return s.length / groups;
}

export function runPart(inp: PartInput): PipelineResult {
  const spb = 60 / inp.bpm;
  const len = inp.source.length;
  const events = sourceEvents(inp);
  const completeBars = Math.floor(len / 4 + 1e-9);
  const warnings: string[] = [];

  // key
  let keyFrom: "user" | "project" | "notes" = "notes";
  let key = keyFromNotes(events) as { tonic: number; minor: boolean };
  if (inp.harmony.key) { key = inp.harmony.key; keyFrom = "user"; }
  else if (inp.harmony.source !== "notes" && inp.projectKey) { key = inp.projectKey; keyFrom = "project"; }

  // chords
  const covered = inp.projectChords.reduce((s, c) => s + Math.max(0, Math.min(inp.source.start + len, c.start + c.length) - Math.max(inp.source.start, c.start)), 0) / Math.max(1e-6, len);
  const useProject = inp.harmony.source === "project" || (inp.harmony.source === "auto" && covered >= 0.5);
  let chords: Chord[] = useProject ? chordsFromProject(inp.projectChords, inp.source.start, len, events) : inp.mode === "bass" ? chordsFromBass(events.filter((e) => e.dur * spb >= 0.06), len, key) : chordsFromNotes(events.filter((e) => e.dur * spb >= 0.06), len, key, inp.mode === "line");
  if (inp.harmony.source === "project" && covered < 0.5) warnings.push("the project's chord track covers less than half of this region");
  if (inp.mode === "line" && !useProject) warnings.push("chords guessed from the melody alone — check them, or analyse the song for a chord track");
  if (inp.mode === "bass" && !useProject) warnings.push("chord roots taken from the bass line, qualities from the key — click a chord to change it");
  if (inp.mode === "bass" && inp.rework.on && inp.rework.style === "kick" && !inp.kicks.length) warnings.push("no kick drum found in this region — 'lock to kick' uses your bass rhythm instead");
  // Tidy progression (keys / guitar default): key chords, bar-line changes, identical repeats.
  const sections = sectionsFor(inp, events, len);
  let progression: { rhythm: string; loopBars: number | null; sections: number } | undefined;
  if ((inp.harmony.tidy ?? (inp.mode === "keys" || inp.mode === "guitar")) && inp.mode !== "line" && inp.mode !== "bass") {
    const t = tidyProgression(chords, events.filter((e) => e.dur * spb >= 0.06), key, len, sections, useProject);
    if (t.chords.length) { chords = t.chords; progression = { rhythm: t.rhythm, loopBars: t.loopBars, sections: inp.sections?.length ?? 0 }; }
  }
  chords = applyOverrides(chords, inp.harmony.chordOverrides);

  // clean
  let cleaned = events.map((e) => ({ ...e }));
  let cleanedDropped: PEvent[] = [];
  let proposals: PipelineResult["proposals"] = [];
  let grid = { decision: "—", note: "clean is off" };
  if (inp.clean.on) {
    const r = cleanPart({ events, mode: inp.mode, key, chords, params: inp.clean, spb, length: len });
    cleaned = r.events;
    cleanedDropped = r.dropped;
    proposals = r.proposals;
    grid = r.grid;
    if (r.ambiguous) warnings.push("grid ambiguous: quantize is paused until you choose straight, triplet or per beat");
  }

  // rework (explicit extension tiles complete source bars and their chords)
  let lengthBeats = len;
  let variants: Variant[];
  if (inp.rework.on && cleaned.length + inp.locks.events.length > 0) {
    let base = cleaned, ch = chords, secs = sections;
    const out = inp.rework.length === "source" ? len : inp.rework.length * 4;
    if (out > len + 1e-9) {
      const period = completeBars ? completeBars * 4 : len;
      base = []; ch = [];
      for (let r = 0; r * period < out; r++) {
        for (const e of cleaned) if (e.start < period && e.start + r * period < out) base.push(r ? { ...e, id: `${e.id}@${r}`, start: e.start + r * period, tags: [...(e.tags ?? []), "tiled"] } : e);
        for (const c of chords) if (c.start < period && c.start + r * period < out) ch.push({ ...c, start: c.start + r * period, length: Math.min(c.length, period - c.start, out - c.start - r * period) });
      }
      secs = [];
      for (let r = 0; r * period < out; r++) for (const sc of sections) if (sc.start < period && sc.start + r * period < out) secs.push({ ...sc, start: sc.start + r * period, length: Math.min(sc.length, period - sc.start, out - sc.start - r * period) });
    } else if (out < len) {
      base = cleaned.filter((e) => e.start < out);
      ch = chords.filter((c) => c.start < out);
    }
    lengthBeats = out;
    variants = reworkPart({ base, mode: inp.mode, style: inp.rework.style, preserve: inp.rework.preserve, chords: ch, key, length: out, completeBars, seeds: inp.layerSeeds, variation: inp.groove.variation, locks: inp.locks.events, spb, openShapes: inp.openShapes, kicks: inp.kicks, sections: secs });
    if (out > len) chords = ch;
  } else {
    variants = [{ name: inp.clean.on ? "cleaned" : "source", events: cleaned, dropped: cleanedDropped, stats: { notes: cleaned.length, kept: cleaned.filter((e) => e.origin === "source" || e.origin === "moved").length, generated: 0, changed: cleaned.filter((e) => e.origin === "edited").length } }];
  }
  const chosen = inp.rework.on ? Math.min(inp.rework.variant, variants.length - 1) : 0;
  const v = variants[chosen];
  const grooved = inp.groove.on ? groovePart(v.events, inp.groove, inp.mode, inp.rework.style, inp.seed, spb, lengthBeats) : v.events;
  // Timing never pulls a note across a bar line (no doubles at the cycle wrap).
  const final = grooved.map((e) => (!e.locked && e.micro < 0 && Math.abs(e.start - Math.round(e.start / 4) * 4) < 1e-6 ? { ...e, micro: 0 } : e)).sort((a, b) => a.start + a.micro - (b.start + b.micro) || a.pitch - b.pitch);

  const poly = polyphony(events);
  if (completeBars < 2) warnings.push("shorter than 2 full bars: no repeat statistics, no phrase development");
  if (len - completeBars * 4 > 1e-6) warnings.push(`last bar is incomplete (${Math.round((len - completeBars * 4) * 100) / 100} beats)`);
  if (!events.length) warnings.push("the region has no notes");
  if (inp.mode === "line" && poly > 1.3) warnings.push(`the source has chords (≈${poly.toFixed(1)} notes per onset); line mode keeps one note at a time`);
  if (inp.mode === "keys" && events.length > 0 && poly < 1.15) warnings.push("the source is a single line; keys styles build chords from the detected harmony");
  const pitches = events.map((e) => e.pitch);
  const strum = inp.mode === "guitar" && events.length ? detectStrums(events, spb).stats : undefined;
  return {
    algo: PP_ALGO_VERSION,
    analysis: {
      bars: Math.ceil(len / 4 - 1e-9), completeBars, partialBeats: Math.round((len - completeBars * 4) * 1000) / 1000,
      key, keyFrom, chordsFrom: chords.length ? (useProject ? "project" : "notes") : "none", grid,
      range: pitches.length ? [Math.min(...pitches), Math.max(...pitches)] : [60, 60], polyphony: Math.round(poly * 100) / 100, warnings, strum, progression,
    },
    chords, sourceEvents: events, proposals, cleaned, cleanedDropped, variants, chosen, final, lengthBeats,
    sound: autoSound(inp.mode, inp.rework.style, final, inp.bpm, inp.source.instrument),
  };
}
