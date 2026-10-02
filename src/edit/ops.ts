/** Region (clip) editing commands. UI calls these; they mutate the project through the store. */
import { buffers, store } from "../model/store";
import { uid, type Clip, type Project } from "../model/types";

export type Tool = "pointer" | "range" | "pencil" | "scissors" | "eraser";
export const TOOLS: { id: Tool; label: string; key: string; tip: string }[] = [
  { id: "pointer", label: "↖", key: "pointer", tip: "pointer: select, move, trim edges" },
  { id: "range", label: "⌶", key: "range", tip: "range: drag across tracks to select a time slice · ⌫ delete · ⇧⌫ delete & close gap · ⌘T split at edges" },
  { id: "pencil", label: "✎", key: "pencil", tip: "pencil: draw a midi region" },
  { id: "scissors", label: "✂", key: "scissors", tip: "scissors: split region at click" },
  { id: "eraser", label: "⌫", key: "eraser", tip: "eraser: delete region" },
];

/** Snap grid in beats; 0 = off. */
export const SNAPS: { label: string; beats: number }[] = [
  { label: "bar", beats: 4 },
  { label: "beat", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "off", beats: 0 },
];

export const snapBeat = (b: number, snap: number) => (snap > 0 ? Math.round(b / snap) * snap : b);
const spb = () => 60 / store.project.bpm;
export const clipEnd = (c: Clip) => c.start + (c.kind === "midi" ? c.length : c.duration / spb());

export function findClip(id: string) {
  for (const t of store.project.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return { track: t, clip: c };
  }
  return null;
}

export function deleteClip(id: string) {
  store.update((p) => p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.id !== id))));
  if (store.ui.selectedClipId === id) store.setUi({ selectedClipId: null });
}

export function duplicateClip(id: string) {
  const hit = findClip(id);
  if (!hit) return;
  const { clip } = hit;
  const len = clipEnd(clip) - clip.start;
  const copy = structuredClone(clip);
  copy.id = uid("clip");
  copy.start = clip.start + Math.ceil(len / 4) * 4;
  store.update(() => hit.track.clips.push(copy));
  store.setUi({ selectedClipId: copy.id });
}

/** Split a region at an absolute beat (Logic ⌘T at playhead, or scissors). */
export function splitClip(id: string, atBeat: number) {
  const hit = findClip(id);
  if (!hit) return;
  const { clip, track } = hit;
  if (atBeat <= clip.start + 1e-6 || atBeat >= clipEnd(clip) - 1e-6) return;
  const cut = atBeat - clip.start;
  let right: Clip;
  if (clip.kind === "audio") {
    const cutSec = cut * spb();
    right = { ...clip, id: uid("clip"), start: atBeat, offset: clip.offset + cutSec, duration: clip.duration - cutSec };
    store.update(() => {
      clip.duration = cutSec;
      track.clips.push(right);
    });
  } else {
    right = {
      ...clip,
      id: uid("clip"),
      start: atBeat,
      length: clip.length - cut,
      notes: clip.notes.filter((n) => n.start >= cut).map((n) => ({ ...n, start: n.start - cut })),
    };
    store.update(() => {
      clip.notes = clip.notes.filter((n) => n.start < cut);
      clip.length = cut;
      track.clips.push(right);
    });
  }
  store.setUi({ selectedClipId: right.id });
}

/* ── multi-region selection: the group is ui.selectedClipIds while it contains the primary
   ui.selectedClipId (editors open the primary); code that sets only selectedClipId gets a single
   selection automatically. ── */

/** Ids of the selected regions (group or single), existing ones only. */
export function selectedClips(): string[] {
  const { selectedClipId: primary, selectedClipIds: ids } = store.ui;
  if (!primary) return [];
  const all = ids.includes(primary) ? ids : [primary];
  return all.filter((id) => findClip(id));
}

export function selectClips(ids: string[], primary: string | null = ids[ids.length - 1] ?? null) {
  store.setUi({ selectedClipIds: ids, selectedClipId: primary });
}

/** Shift/⌘-click: add the region to the group, or take it out. */
export function toggleClipSelection(id: string) {
  const cur = selectedClips();
  if (cur.includes(id)) {
    const rest = cur.filter((x) => x !== id);
    selectClips(rest, rest[rest.length - 1] ?? null);
  } else selectClips([...cur, id], id);
}

export function selectAllClips() {
  const ids = store.project.tracks.flatMap((t) => t.clips.map((c) => c.id));
  selectClips(ids, ids[0] ?? null);
}

export function deleteClips(ids: string[]) {
  const set = new Set(ids);
  store.checkpoint(); // a command is its own undo step, never merged with a preceding drag/nudge
  store.update((p) => p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => !set.has(c.id)))));
  selectClips([], null);
}

/** Move a group by the same offset (kept ≥ 0 for every region); `from` = start beats at grab time. */
export function moveClips(from: Map<string, number>, delta: number) {
  const d = Math.max(delta, -Math.min(...from.values()));
  store.update((p) => {
    for (const t of p.tracks) for (const c of t.clips) if (from.has(c.id)) c.start = from.get(c.id)! + d;
  });
}

/** ⌘D on a group: one copy of the whole block, right after it (bar-aligned), selected. */
export function duplicateClips(ids: string[]) {
  const hits = ids.map(findClip).filter((h): h is NonNullable<ReturnType<typeof findClip>> => !!h);
  if (!hits.length) return;
  const a = Math.min(...hits.map((h) => h.clip.start)), b = Math.max(...hits.map((h) => clipEnd(h.clip)));
  const off = Math.ceil((b - a) / 4 - 1e-9) * 4 || 4;
  const copies: string[] = [];
  store.checkpoint();
  store.update((p) => {
    for (const h of hits) {
      const t = p.tracks.find((x) => x.id === h.track.id);
      if (!t) continue;
      const copy = structuredClone(h.clip);
      copy.id = uid("clip");
      copy.start = h.clip.start + off;
      t.clips.push(copy);
      copies.push(copy.id);
    }
  });
  selectClips(copies, copies[0]);
}

/** Split every region of the group that spans the beat; both halves stay selected. */
export function splitClips(ids: string[], atBeat: number) {
  const out: string[] = [];
  store.checkpoint();
  for (const id of ids) {
    const prev = store.ui.selectedClipId;
    splitClip(id, atBeat);
    out.push(id);
    const right = store.ui.selectedClipId; // splitClip selects the new right half
    if (right && right !== prev && right !== id) out.push(right);
  }
  selectClips(out, out[0] ?? null);
}

/** Trim the same edge of every region in the group by the same amount. */
export function trimClips(from: Map<string, number>, edge: "start" | "end", delta: number) {
  for (const [id, at] of from) trimClip(id, edge, at + delta);
}

/** Trim a region edge (Pro Tools trim tool). Audio can't extend past its buffer. */
export function trimClip(id: string, edge: "start" | "end", toBeat: number) {
  const hit = findClip(id);
  if (!hit) return;
  const { clip } = hit;
  const s = spb();
  store.update(() => {
    if (clip.kind === "midi") {
      if (edge === "end") clip.length = Math.max(0.25, toBeat - clip.start);
      else {
        const end = clip.start + clip.length;
        const ns = Math.min(end - 0.25, Math.max(0, toBeat));
        const d = ns - clip.start;
        clip.notes = clip.notes.map((n) => ({ ...n, start: n.start - d })).filter((n) => n.start + n.dur > 0);
        clip.start = ns;
        clip.length = end - ns;
      }
    } else {
      const bufDur = buffers.get(clip.bufferId)?.duration ?? clip.offset + clip.duration;
      if (edge === "end") clip.duration = Math.max(0.05, Math.min(bufDur - clip.offset, (toBeat - clip.start) * s));
      else {
        const endSec = clip.offset + clip.duration;
        const dSec = Math.max(-clip.offset, Math.min(clip.duration - 0.05, (toBeat - clip.start) * s));
        clip.start += dSec / s;
        clip.offset += dSec;
        clip.duration = endSec - clip.offset;
      }
    }
  });
}

export function createMidiClip(trackId: string, atBeat: number, lengthBeats = 4) {
  const c: Clip = { id: uid("clip"), kind: "midi", start: atBeat, length: lengthBeats, notes: [] };
  store.update((p) => p.tracks.find((t) => t.id === trackId)?.clips.push(c));
  store.setUi({ selectedClipId: c.id });
  return c;
}

export function deleteTrack(id: string) {
  const t = store.project.tracks.find((x) => x.id === id);
  if (t?.kind === "aux") {
    store.log("That track is one of a kit's outputs: change or remove the kit's main track instead (or just mute it).");
    return;
  }
  store.update((p) => {
    if (t?.reverbReturn) p.noReverbReturn = true; // deleted on purpose: verb knobs use the built-in reverb
    if (t?.delayReturn) p.noDelayReturn = true; // dly knobs then send nowhere
    p.tracks = p.tracks.filter((x) => x.id !== id);
  });
  if (store.ui.selectedTrackId === id) store.setUi({ selectedTrackId: null, selectedClipId: null });
}

/**
 * Change tempo without moving anything that lives in real time: audio clips, MIDI transcribed
 * from audio (anchored), and the analysed sections/chords keep their positions in seconds.
 * MIDI you wrote yourself keeps its beats (it follows the new tempo), as in any DAW.
 * Mutates `p`; call inside store.update.
 */
export function retempo(p: Project, bpm: number) {
  const r = bpm / p.bpm;
  if (!Number.isFinite(r) || Math.abs(r - 1) < 1e-9) return;
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.kind === "audio") c.start *= r;
      else if (c.anchored) {
        c.start *= r;
        c.length *= r;
        for (const n of c.notes) {
          n.start *= r;
          n.dur *= r;
        }
      }
    }
  for (const s of p.sections) {
    s.start *= r;
    s.length *= r;
  }
  for (const c of p.chords) {
    c.start *= r;
    c.length *= r;
  }
  p.bpm = bpm;
}

/**
 * Duplicate a track right below itself: clips, notes, mixer settings and inserts are deep-copied
 * with new ids (audio clips keep sharing their decoded audio). A multitrack kit's mic tracks come
 * along with their settings; an aux track duplicates its owner.
 */
export function duplicateTrack(id: string) {
  const p = store.project;
  let src = p.tracks.find((t) => t.id === id);
  if (!src) return;
  if (src.kind === "aux") src = p.tracks.find((t) => t.id === src!.auxOf) ?? src;
  const copy = structuredClone(src);
  copy.id = uid("trk");
  copy.name = `${src.name} copy`;
  for (const c of copy.clips) c.id = uid("clip");
  for (const i of copy.inserts ?? []) i.id = uid("ins");
  delete copy.dp; // a copy is no longer the output of a producer session
  const auxCopies = p.tracks
    .filter((t) => t.kind === "aux" && t.auxOf === src!.id)
    .map((a) => {
      const c = structuredClone(a);
      c.id = uid("aux");
      c.auxOf = copy.id;
      for (const i of c.inserts ?? []) i.id = uid("ins");
      return c;
    });
  store.update((pp) => {
    const owned = pp.tracks.filter((t) => t.auxOf === src!.id).length;
    const at = pp.tracks.findIndex((t) => t.id === src!.id) + 1 + owned;
    pp.tracks.splice(at, 0, copy, ...auxCopies);
  });
  store.setUi({ selectedTrackId: copy.id, selectedClipId: null });
}

/* ───────────── range editing (montage) ───────────── */

export interface TimeRange {
  start: number; // beats
  end: number;
  /** null = every track (cycle-range commands). */
  trackIds: string[] | null;
}

/** The part of a clip from `from` beats (relative to its start) to `to`; null if empty. Notes crossing the start are dropped, notes crossing the end are shortened. */
function piece(c: Clip, from: number, to: number, s: number, keepId: boolean): Clip | null {
  const len = to - from;
  if (len <= 1e-6) return null;
  const id = keepId ? c.id : uid("clip");
  if (c.kind === "audio") return { ...c, id, start: c.start + from, offset: c.offset + from * s, duration: len * s };
  return {
    ...c,
    id,
    start: c.start + from,
    length: len,
    notes: c.notes.filter((n) => n.start >= from - 1e-9 && n.start < to - 1e-9).map((n) => ({ ...n, start: n.start - from, dur: Math.min(n.dur, to - n.start) })),
  };
}

/** Cut [a, b) out of a list of beat spans (sections, chords): drop what's inside, trim overlaps, optionally shift what follows. */
function cutSpans<T extends { start: number; length: number }>(spans: T[], a: number, b: number, ripple: boolean): T[] {
  const d = b - a;
  const out: T[] = [];
  for (const x of spans) {
    const e = x.start + x.length;
    if (e <= a) out.push(x);
    else if (x.start >= b) out.push(ripple ? { ...x, start: x.start - d } : x);
    else {
      // overlaps the cut: keep the outside parts (joined when rippling)
      const left = Math.max(0, a - x.start), right = Math.max(0, e - b);
      if (ripple && left + right > 1e-6) out.push({ ...x, start: Math.min(x.start, a), length: left + right });
      else {
        if (left > 1e-6) out.push({ ...x, length: left });
        if (right > 1e-6) out.push({ ...x, start: b, length: right });
      }
    }
  }
  return out;
}

/**
 * Montage edits on a time range: "delete" removes what's inside and leaves a gap, "ripple" also
 * pulls everything after it left to close the gap, "split" cuts regions at both edges. With
 * trackIds = null it applies to every track, and a ripple also moves sections, chords and the
 * cycle range so the song structure follows. Audio edges get the usual 4 ms fades (no clicks).
 */
export function editRange(r: TimeRange, mode: "delete" | "ripple" | "split") {
  const a = Math.min(r.start, r.end), b = Math.max(r.start, r.end);
  if (b - a < 1e-6) return;
  store.update((p) => {
    const s = 60 / p.bpm, d = b - a;
    const all = r.trackIds === null;
    for (const t of p.tracks) {
      if (!all && !r.trackIds!.includes(t.id)) continue;
      const next: Clip[] = [];
      for (const c of t.clips) {
        const len = c.kind === "midi" ? c.length : c.duration / s;
        const cs = c.start, ce = cs + len;
        if (ce <= a + 1e-9 || cs >= b - 1e-9) {
          next.push(mode === "ripple" && cs >= b - 1e-9 ? { ...c, start: cs - d } : c);
          continue;
        }
        const left = piece(c, 0, a - cs, s, true);
        const mid = mode === "split" ? piece(c, Math.max(0, a - cs), Math.min(len, b - cs), s, !left) : null;
        const right = piece(c, b - cs, len, s, !left && !mid);
        for (const x of [left, mid, right]) if (x) next.push(mode === "ripple" && x === right ? { ...x, start: x.start - d } : x);
      }
      t.clips = next;
    }
    if (all && mode !== "split") {
      p.sections = cutSpans(p.sections, a, b, mode === "ripple");
      p.chords = cutSpans(p.chords, a, b, mode === "ripple");
      if (mode === "ripple") {
        if (p.loop.start >= b) p.loop.start -= d;
        else if (p.loop.start > a) p.loop.start = a;
        if (p.loop.end >= b) p.loop.end -= d;
        else if (p.loop.end > a) p.loop.end = a;
        if (p.loop.end - p.loop.start < 1) p.loop = { ...p.loop, on: false, end: p.loop.start + 4 };
      }
    }
  });
}

/** Insert silence of [a, b) on every track: regions crossing a are split, everything from a moves right. */
export function insertSilence(a: number, b: number) {
  const d = b - a;
  if (d <= 1e-6) return;
  store.update((p) => {
    const s = 60 / p.bpm;
    for (const t of p.tracks) {
      const next: Clip[] = [];
      for (const c of t.clips) {
        const len = c.kind === "midi" ? c.length : c.duration / s;
        if (c.start >= a - 1e-9) next.push({ ...c, start: c.start + d });
        else if (c.start + len <= a + 1e-9) next.push(c);
        else {
          const left = piece(c, 0, a - c.start, s, true), right = piece(c, a - c.start, len, s, false);
          if (left) next.push(left);
          if (right) next.push({ ...right, start: right.start + d });
        }
      }
      t.clips = next;
    }
    const shift = <T extends { start: number; length: number }>(xs: T[]) =>
      xs.flatMap((x) => (x.start >= a ? [{ ...x, start: x.start + d }] : x.start + x.length <= a ? [x] : [{ ...x, length: a - x.start }, { ...x, start: b, length: x.start + x.length - a }]));
    p.sections = shift(p.sections);
    p.chords = shift(p.chords);
    if (p.loop.start >= a) p.loop.start += d;
    if (p.loop.end > a) p.loop.end += d;
  });
}


/* ───────────── clipboard (⌘C / ⌘X / ⌘V) ───────────── */

/** Copied regions, positioned relative to the copy's start and its topmost track. */
let clipboard: { items: { row: number; trackId: string; clip: Clip }[]; length: number } | null = null;
export const hasClipboard = () => !!clipboard?.items.length;

/** Copy the range selection (just the slice inside it) or else the selected regions. */
export function copySelection(): boolean {
  const p = store.project, s = 60 / p.bpm, r = store.ui.range;
  const rows = new Map(p.tracks.map((t, i) => [t.id, i]));
  const items: { row: number; trackId: string; clip: Clip }[] = [];
  let a: number, b: number;
  if (r && Math.abs(r.end - r.start) > 1e-6) {
    a = Math.min(r.start, r.end);
    b = Math.max(r.start, r.end);
    for (const t of p.tracks) {
      if (r.trackIds && !r.trackIds.includes(t.id)) continue;
      for (const c of t.clips) {
        const len = c.kind === "midi" ? c.length : c.duration / s;
        if (c.start + len <= a + 1e-9 || c.start >= b - 1e-9) continue;
        const x = piece(c, Math.max(0, a - c.start), Math.min(len, b - c.start), s, false);
        if (x) items.push({ row: rows.get(t.id)!, trackId: t.id, clip: x });
      }
    }
  } else {
    const hits = selectedClips().map(findClip).filter((h): h is NonNullable<ReturnType<typeof findClip>> => !!h);
    if (!hits.length) return false;
    a = Math.min(...hits.map((h) => h.clip.start));
    b = Math.max(...hits.map((h) => clipEnd(h.clip)));
    for (const h of hits) items.push({ row: rows.get(h.track.id)!, trackId: h.track.id, clip: structuredClone(h.clip) });
  }
  if (!items.length) return false;
  const top = Math.min(...items.map((x) => x.row));
  clipboard = { items: items.map((x) => ({ ...x, row: x.row - top, clip: { ...x.clip, start: x.clip.start - a } })), length: b - a };
  return true;
}

/** Cut = copy, then remove: the slice (leaving a gap) or the selected regions. */
export function cutSelection() {
  const r = store.ui.range;
  if (!copySelection()) return;
  store.checkpoint();
  if (r && Math.abs(r.end - r.start) > 1e-6) {
    editRange(r, "delete");
    store.setUi({ range: null });
  } else deleteClips(selectedClips());
}

/**
 * Paste at `atBeat` (the playhead) onto the selected track; a multi-track copy keeps its layout
 * downwards from there. A region that can't live on the target (audio ↔ midi) goes back to the
 * track it came from. The pasted regions end up selected.
 */
export function pasteClipboard(atBeat: number) {
  if (!clipboard?.items.length) return;
  const p = store.project;
  const sel = p.tracks.findIndex((t) => t.id === store.ui.selectedTrackId);
  const base = sel >= 0 ? sel : p.tracks.findIndex((t) => t.id === clipboard!.items[0].trackId);
  const made: string[] = [];
  store.checkpoint();
  store.update((pp) => {
    for (const it of clipboard!.items) {
      const kind = it.clip.kind;
      const fits = (t?: (typeof pp.tracks)[number]) => !!t && t.kind === kind && !t.auxOf;
      let t: (typeof pp.tracks)[number] | undefined = pp.tracks[base + it.row];
      if (!fits(t)) t = pp.tracks.find((x) => x.id === it.trackId);
      if (!fits(t)) continue;
      const c = structuredClone(it.clip);
      c.id = uid("clip");
      c.start = Math.max(0, atBeat + it.clip.start);
      t!.clips.push(c);
      made.push(c.id);
    }
  });
  if (made.length) selectClips(made, made[0]);
  else store.log("Paste: no track here takes these regions (audio regions go on audio tracks, midi on midi)");
}
