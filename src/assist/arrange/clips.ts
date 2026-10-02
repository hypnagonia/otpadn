/** Cut/merge clips along section boundaries. */
import { buffers } from "../../model/store";
import { uid, type AudioClip, type Clip, type MidiClip, type Note, type Section, type Track } from "../../model/types";

export function allNotes(t: Track): Note[] {
  const out: Note[] = [];
  for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) out.push({ ...n, start: n.start + c.start });
  return out;
}

export function midiClipsForSections(notes: Note[], secs: Section[]): MidiClip[] {
  return secs.map((s) => ({
    id: uid("clip"),
    kind: "midi" as const,
    start: s.start,
    length: s.length,
    notes: notes.filter((n) => n.start >= s.start && n.start < s.start + s.length).map((n) => ({ ...n, start: n.start - s.start })),
  }));
}

export function audioClipsForSections(t: Track, secs: Section[], spb: number): AudioClip[] {
  const src = t.clips.find((c): c is AudioClip => c.kind === "audio");
  if (!src) return [];
  const buf = buffers.get(src.bufferId);
  if (!buf) return [];
  // Timeline beat where the buffer's sample 0 sits; identical for every clip of this buffer.
  const origin = src.start - src.offset / spb;
  const out: AudioClip[] = [];
  for (const s of secs) {
    const startSec = (s.start - origin) * spb;
    const endSec = Math.min(buf.duration, startSec + s.length * spb);
    const from = Math.max(0, startSec);
    if (endSec <= from) continue;
    out.push({ id: uid("clip"), kind: "audio", start: origin + from / spb, bufferId: src.bufferId, offset: from, duration: endSec - from });
  }
  return out;
}

/** Merge adjacent section clips back into continuous ones for a cleaner view. */
export function mergeAdjacent(clips: Clip[], spb: number): Clip[] {
  const out: Clip[] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "audio" && c.kind === "audio" && prev.bufferId === c.bufferId) {
      const prevEnd = prev.start + prev.duration / spb;
      if (Math.abs(prevEnd - c.start) < 1e-6 && Math.abs(prev.offset + prev.duration - c.offset) < 1e-4) {
        prev.duration += c.duration;
        continue;
      }
    }
    if (prev && prev.kind === "midi" && c.kind === "midi" && Math.abs(prev.start + prev.length - c.start) < 1e-6) {
      prev.notes.push(...c.notes.map((n) => ({ ...n, start: n.start + prev.length })));
      prev.length += c.length;
      continue;
    }
    out.push(c);
  }
  return out;
}
