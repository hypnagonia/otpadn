/**
 * "Clean" for pitched parts: fix probable transcription errors only. Every change is a proposal
 * with a reason and a heuristic score (not a probability). Protected: locked notes, notes that fit
 * the chord/key, chromatic passing tones, real re-attacks, longer out-of-key notes (flagged, not fixed).
 */
import { detectGrid, gridStepAt } from "../drumproducer/analyze";
import { chordAt, chordPcs, scalePcs } from "./harmony";
import { strumWindowSec } from "./strum";
import type { Chord, GridChoice, Mode, PEvent, Proposal } from "./types";

const ms = (s: number) => `${Math.round(s * 1000)} ms`;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const pname = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

export interface CleanIn {
  events: PEvent[];
  mode: Mode;
  key: { tonic: number; minor: boolean };
  chords: Chord[];
  params: { strength: number; grid: GridChoice; decisions: Record<string, boolean> };
  spb: number;
  length: number;
}

export function cleanPart({ events, mode, key, chords, params, spb, length }: CleanIn) {
  const ev = events.map((e) => ({ ...e, tags: e.tags ? [...e.tags] : undefined })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const proposals: Proposal[] = [];
  const acc = (id: string, def: boolean) => params.decisions[id] ?? def;
  const push = (p: Omit<Proposal, "accepted">) => proposals.push({ ...p, accepted: acc(p.id, p.def) });
  const scale = scalePcs(key);
  const inChord = (e: PEvent) => {
    const c = chordAt(chords, e.start);
    return c ? chordPcs(c).includes(e.pitch % 12) : true;
  };
  const sec = (beats: number) => beats * spb;
  const medVel = median(ev.map((e) => e.vel));
  const gone = new Set<string>(); // ids already claimed by an earlier proposal

  // ── A/B: fragmented sustains (same pitch, tiny gap, no stronger re-attack) and same-pitch overlaps
  const byPitch = new Map<number, PEvent[]>();
  for (const e of ev) (byPitch.get(e.pitch) ?? byPitch.set(e.pitch, []).get(e.pitch)!).push(e);
  for (const [, list] of byPitch) {
    let prev: PEvent | null = null;
    for (const e of list) {
      if (!prev) { prev = e; continue; }
      const gap = sec(e.start - (prev.start + prev.dur));
      // A real split: tiny gap, no chord re-attack at the same moment, and the second piece is
      // quieter or off the grid. Re-strummed / re-struck chords on the beat are not merged.
      const reattack = ev.filter((o) => o !== e && o.pitch !== e.pitch && Math.abs(sec(o.start - e.start)) < 0.04).length >= 2;
      const offGrid = Math.abs(e.start * 4 - Math.round(e.start * 4)) / 4 > 0.06;
      if (!prev.locked && !e.locked && gap < 0.03 && !reattack && (e.vel <= prev.vel * 0.85 || offGrid) && sec(e.start - prev.start) > 0.02) {
        push({ id: `frag:${e.id}`, kind: "merge", eventIds: [prev.id, e.id], at: e.start, reason: `${pname(e.pitch)} split into two notes ${gap < 0 ? "overlapping" : ms(gap) + " apart"} without a stronger re-attack — one held note`, heur: 0.8, def: true });
        gone.add(e.id);
        continue; // keep prev as the head of the merged note
      }
      if (!prev.locked && gap < 0 && sec(e.start - prev.start) > 0.02) push({ id: `ovl:${prev.id}`, kind: "trim", eventIds: [prev.id, e.id], at: prev.start, reason: `${pname(prev.pitch)} still sounding when the same key is struck again — end trimmed`, heur: 0.75, def: true });
      prev = e;
    }
  }

  // ── E: monophonic line / bass — overlapping different pitches
  if (mode === "line" || mode === "bass") {
    const live = ev.filter((e) => !gone.has(e.id));
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length && live[j].start < a.start + a.dur; j++) {
        const b = live[j];
        if (gone.has(a.id) || gone.has(b.id) || b.pitch === a.pitch) continue;
        const ov = Math.min(a.start + a.dur, b.start + b.dur) - b.start;
        const shorter = Math.min(a.dur, b.dur);
        if (ov > 0.5 * shorter && sec(ov) > 0.04) {
          // A bass keeps the lower note (transcription adds harmonics above it); a line keeps the stronger.
          const weak = mode === "bass" ? (a.pitch > b.pitch ? a : b) : a.vel * a.dur < b.vel * b.dur ? a : b;
          if (weak.locked) continue;
          const oct = Math.abs(a.pitch - b.pitch) % 12 === 0;
          push({ id: `poly:${weak.id}`, kind: "remove", eventIds: [weak.id, weak === a ? b.id : a.id], at: weak.start, reason: `${mode === "bass" ? "a bass plays" : "a sung line has"} one note at a time: ${pname(weak.pitch)} overlaps ${pname((weak === a ? b : a).pitch)}${oct ? " an octave apart (octave ghost)" : ""}`, heur: oct ? 0.85 : 0.7, def: true });
          gone.add(weak.id);
        } else if (sec(ov) > 0.015 && !a.locked) push({ id: `mono:${a.id}`, kind: "trim", eventIds: [a.id, b.id], at: a.start, reason: `${pname(a.pitch)} overlaps the next note by ${ms(sec(ov))} — ends where the next begins`, heur: 0.7, def: true });
      }
    }
  }

  // ── D: overtone ghosts (keys / guitar): a quieter note an octave/12th/2 octaves above a louder one, same onset
  if (mode === "keys" || mode === "guitar") {
    for (const e of ev) {
      if (gone.has(e.id) || e.locked) continue;
      const base = ev.find((o) => o !== e && !gone.has(o.id) && Math.abs(sec(o.start - e.start)) < 0.04 && [12, 19, 24].includes(e.pitch - o.pitch) && e.vel < o.vel * 0.7);
      if (base) {
        push({ id: `ghost:${e.id}`, kind: "remove", eventIds: [e.id, base.id], at: e.start, reason: `${pname(e.pitch)} is ${e.pitch - base.pitch} semitones above a louder ${pname(base.pitch)} at the same time, much quieter — likely an overtone, not a played note`, heur: 0.7, def: true });
        gone.add(e.id);
      }
    }
  }

  // ── C: blips and (line) scoops
  for (const e of ev) {
    if (gone.has(e.id) || e.locked) continue;
    const d = sec(e.dur);
    if (d >= 0.06) continue;
    if (mode === "line" || mode === "bass") {
      const nb = ev.find((o) => o !== e && !gone.has(o.id) && Math.abs(o.pitch - e.pitch) <= 2 && sec(o.dur) > 0.12 && (Math.abs(sec(o.start - (e.start + e.dur))) < 0.04 || Math.abs(sec(e.start - (o.start + o.dur))) < 0.04));
      if (nb) {
        push({ id: `scoop:${e.id}`, kind: "merge", eventIds: [nb.id, e.id], at: e.start, reason: `${ms(d)} ${pname(e.pitch)} glued to a held ${pname(nb.pitch)} — ${mode === "bass" ? "a slide into the note" : "a scoop/fall of the voice"}, merged into it`, heur: 0.7, def: true });
        gone.add(e.id);
        continue;
      }
    }
    const fits = inChord(e), inKey = scale.has(e.pitch % 12);
    if (!fits && !inKey) push({ id: `blip:${e.id}`, kind: "remove", eventIds: [e.id], at: e.start, reason: `${ms(d)} ${pname(e.pitch)} fits neither the chord nor the key — transcription blip`, heur: 0.8, def: true });
    else if (!fits && e.vel < medVel * 0.7) push({ id: `blip:${e.id}`, kind: "remove", eventIds: [e.id], at: e.start, reason: `${ms(d)} quiet ${pname(e.pitch)} outside the chord — likely a blip`, heur: 0.6, def: true });
    else push({ id: `blip:${e.id}`, kind: "remove", eventIds: [e.id], at: e.start, reason: `very short ${pname(e.pitch)} (${ms(d)}) that fits the harmony — maybe a grace note, kept by default`, heur: 0.35, def: false });
    gone.add(e.id);
  }

  // ── F: octave errors in a line / bass
  if (mode === "line" || mode === "bass") {
    const live = ev.filter((e) => !gone.has(e.id));
    for (let i = 1; i < live.length - 1; i++) {
      const p = live[i - 1], e = live[i], n = live[i + 1];
      if (e.locked || p.start + p.dur < e.start - 0.5 || n.start > e.start + e.dur + 0.5) continue;
      for (const shift of [-12, 12]) {
        const f = e.pitch + shift;
        if (Math.abs(e.pitch - p.pitch) > 9 && Math.abs(e.pitch - n.pitch) > 9 && Math.abs(f - p.pitch) <= 5 && Math.abs(f - n.pitch) <= 5) {
          push({ id: `oct:${e.id}`, kind: "octave", eventIds: [e.id], at: e.start, pitch: f, reason: `${pname(e.pitch)} jumps an octave away and straight back — octave error, moved to ${pname(f)}`, heur: 0.75, def: true });
        }
      }
    }
  }

  // ── G: out-of-key slips (short, off the strong beats) vs. intended colour (long / strong)
  for (const e of ev) {
    if (gone.has(e.id) || e.locked || scale.has(e.pitch % 12) || inChord(e)) continue;
    const prev = ev.filter((o) => !gone.has(o.id) && o.start < e.start).pop(), next = ev.find((o) => !gone.has(o.id) && o.start > e.start);
    const passing = mode === "line" && prev && next && Math.abs(prev.pitch - e.pitch) === 1 && Math.abs(next.pitch - e.pitch) <= 2 && Math.sign(e.pitch - prev.pitch) === Math.sign(next.pitch - e.pitch);
    if (passing) continue;
    const c = chordAt(chords, e.start);
    const targets = c ? chordPcs(c) : [...scale];
    let to = e.pitch, bd = 99;
    for (const d of [-1, 1, -2, 2]) if (targets.includes((e.pitch + d + 120) % 12) && Math.abs(d) < bd) { bd = Math.abs(d); to = e.pitch + d; }
    if (to === e.pitch) continue;
    const strong = Math.abs(e.start - Math.round(e.start)) < 0.06;
    const long = e.dur >= 0.5;
    push({ id: `key:${e.id}`, kind: "pitch", eventIds: [e.id], at: e.start, pitch: to, reason: long || strong ? `${pname(e.pitch)} is outside the key and chord but ${long ? "held" : "on the beat"} — could be intended colour; snap to ${pname(to)}?` : `short ${pname(e.pitch)} outside key and chord, off the beat — probably a mis-detected neighbour; snap to ${pname(to)}`, heur: long || strong ? 0.4 : 0.6, def: !(long || strong) });
  }

  // ── bass register: transcribed bass lines pick up octave-up harmonics and sub-octave errors
  if (mode === "bass") {
    for (const e of ev) {
      if (gone.has(e.id) || e.locked) continue;
      let to = e.pitch;
      while (to > 64) to -= 12;
      while (to < 23) to += 12;
      if (to !== e.pitch && !proposals.some((p) => p.eventIds[0] === e.id && p.kind === "octave"))
        push({ id: `reg:${e.id}`, kind: "octave", eventIds: [e.id], at: e.start, pitch: to, reason: `${pname(e.pitch)} is outside a bass's range — moved to ${pname(to)}`, heur: 0.75, def: true });
    }
  }

  // ── H: guitar playability
  if (mode === "guitar") {
    for (const e of ev) if (!gone.has(e.id) && !e.locked && e.pitch < 40) push({ id: `low:${e.id}`, kind: "octave", eventIds: [e.id], at: e.start, pitch: e.pitch + 12 * Math.ceil((40 - e.pitch) / 12), reason: `${pname(e.pitch)} is below the low E string — moved up an octave`, heur: 0.8, def: true });
    const live = ev.filter((e) => !gone.has(e.id));
    for (let i = 0; i < live.length; ) {
      let j = i;
      while (j + 1 < live.length && sec(live[j + 1].start - live[i].start) < strumWindowSec(spb)) j++;
      const group = live.slice(i, j + 1);
      if (group.length > 6) {
        const extra = [...group].filter((e) => !e.locked).sort((a, b) => a.vel - b.vel).slice(0, group.length - 6);
        for (const e of extra) {
          push({ id: `strings:${e.id}`, kind: "remove", eventIds: [e.id], at: e.start, reason: `${group.length} notes at once — a guitar has six strings; weakest note dropped`, heur: 0.75, def: true });
          gone.add(e.id);
        }
      }
      i = j + 1;
    }
  }

  // ── apply accepted edits
  const byId = new Map(ev.map((e) => [e.id, e]));
  const dropped: PEvent[] = [];
  const removed = new Set<string>();
  for (const p of proposals) {
    if (!p.accepted) continue;
    if (p.kind === "remove") removed.add(p.eventIds[0]);
    if (p.kind === "merge") {
      const head = byId.get(p.eventIds[0])!, tail = byId.get(p.eventIds[1])!;
      if (removed.has(head.id)) continue;
      const end = Math.max(head.start + head.dur, tail.start + tail.dur);
      head.start = Math.min(head.start, tail.start);
      head.dur = end - head.start;
      if (head.origin === "source") head.origin = "edited";
      removed.add(tail.id);
    }
    if (p.kind === "trim") {
      const a = byId.get(p.eventIds[0])!, b = byId.get(p.eventIds[1])!;
      a.dur = Math.max(0.05, b.start - a.start);
      if (a.origin === "source") a.origin = "edited";
    }
    if ((p.kind === "pitch" || p.kind === "octave") && p.pitch !== undefined) {
      const e = byId.get(p.eventIds[0])!;
      e.pitch = p.pitch;
      e.origin = "edited";
    }
  }
  let out = ev.filter((e) => {
    if (removed.has(e.id) && !e.locked) { dropped.push(e); return false; }
    return true;
  });

  // ── J: soft quantize; notes struck together (≤ 40 ms) move together
  const strength = Math.max(0, Math.min(1, params.strength));
  const g = detectGrid(out as never, spb);
  const ambiguous = params.grid === "auto" && g.decision === "ambiguous";
  const qOn = !ambiguous && strength > 0 && out.length > 0;
  const qAcc = acc("quantize", true);
  let moved = 0;
  if (!ambiguous) {
    const sorted = [...out].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      // a guitar strum (notes over 30–80 ms) is one event: it moves as a whole, keeping its spread
      while (j + 1 < sorted.length && sec(sorted[j + 1].start - sorted[i].start) < (mode === "guitar" ? strumWindowSec(spb) : 0.04)) j++;
      const group = sorted.slice(i, j + 1).filter((e) => !e.locked);
      const anchor = sorted[i].start;
      const step = gridStepAt(anchor, params.grid, g.decision as never, g.beats);
      if (step) {
        const target = Math.min(length - 1e-3, Math.max(0, Math.round(anchor / step) * step));
        for (const e of group) {
          const orig = e.start;
          const spread = orig - anchor; // keep strum/roll order
          const apply = qOn && qAcc;
          e.start = target;
          // Guitar keeps its strum spread (real playing); keys/line tighten chord jitter with the strength.
          e.micro = apply ? (mode === "guitar" ? (anchor - target) * (1 - strength) + spread : (orig - target) * (1 - strength)) : orig - target;
          if (apply && Math.abs(orig - target) * strength > 0.004) {
            moved++;
            if (e.origin === "source") e.origin = "moved";
          }
          // Note ends: snap with the same strength when close to a grid line (keys/guitar only).
          if (apply && (mode === "keys" || mode === "guitar")) {
            const end = orig + e.dur, ge = Math.round(end / step) * step;
            if (Math.abs(end - ge) < step * 0.5 && ge > target) e.dur = Math.max(0.05, end + (ge - end) * strength - (target + e.micro));
          }
        }
      }
      i = j + 1;
    }
  }
  if (qOn)
    proposals.push({ id: "quantize", kind: "quantize", eventIds: [], at: 0, reason: `soft-quantize ${moved} notes ${Math.round(strength * 100)}% toward the ${params.grid === "auto" ? g.decision : params.grid} grid; notes struck together move together${mode === "keys" || mode === "guitar" ? ", note ends follow" : ""}`, heur: 0.8, def: true, accepted: qAcc });
  out = out.sort((a, b) => a.start + a.micro - (b.start + b.micro) || a.pitch - b.pitch);
  return { proposals, events: out, dropped, grid: { decision: ambiguous ? "ambiguous" : (params.grid === "auto" ? g.decision : params.grid), note: g.note }, ambiguous };
}
