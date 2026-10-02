/** Clip → audio-node scheduling shared by live playback and offline bounce. */
import { buffers, store } from "../model/store";
import type { Note, NoteSlide } from "../model/types";
import type { AudioClip, Project, Track } from "../model/types";

const FADE = 0.004;

/** A kit track's sample layers with their decoded audio (layers whose audio is missing are skipped). */
export function kitLayersOf(t: Track): Partial<Record<string, { buffer: AudioBuffer; level: number }>> {
  const out: Partial<Record<string, { buffer: AudioBuffer; level: number }>> = {};
  for (const [slot, l] of Object.entries(t.kitLayers ?? {})) {
    const buffer = l && buffers.get(l.bufferId);
    if (l && buffer) out[slot] = { buffer, level: l.level };
  }
  return out;
}

/**
 * Mute/solo with routing in mind: a kit's mic (aux) tracks flow through their owner's strip
 * (the drum bus). Soloing a mic keeps its bus open; soloing the bus keeps its mics open.
 * Mute always wins for the track it is on (a muted bus silences all its mics).
 */
export const isAudible = (p: Project, t: Track): boolean => {
  if (t.ch.mute) return false;
  // A kit mic of a muted kit is silent too — its sends (reverb, buses) bypass the kit's bus fader.
  if (t.kind === "aux" && p.tracks.find((o) => o.id === t.auxOf)?.ch.mute) return false;
  if (!p.tracks.some((x) => x.ch.solo)) return true;
  if (t.ch.solo) return true;
  if (t.kind === "aux") return !!p.tracks.find((o) => o.id === t.auxOf)?.ch.solo;
  // An FX bus stays open while anything audible sends to it (a soloed vocal keeps its reverb).
  if (t.kind === "bus") return p.tracks.some((x) => x.kind !== "bus" && (x.ch.sends?.some((sd) => sd.bus === t.id) || (t.reverbReturn && x.ch.reverbSend > 0) || (t.delayReturn && (x.ch.delaySend ?? 0) > 0)) && isAudible(p, x));
  return p.tracks.some((a) => a.kind === "aux" && a.auxOf === t.id && a.ch.solo);
};

/** Schedule every audio clip of a track that overlaps [fromBeat, toBeat). */
export function scheduleAudio(
  ctx: BaseAudioContext,
  track: Track,
  dest: AudioNode,
  fromBeat: number,
  toBeat: number,
  ctxStart: number,
  spb: number,
  sources: AudioScheduledSourceNode[],
) {
  const posSec = fromBeat * spb;
  const endSec = toBeat * spb;
  const clips = track.clips.filter((c): c is AudioClip => c.kind === "audio").sort((x, y) => x.start - y.start);
  clips.forEach((c, k) => {
    const buf = buffers.get(c.bufferId);
    if (!buf) return;
    const cs = c.start * spb;
    const ce = Math.min(cs + c.duration, endSec);
    if (ce <= posSec || cs >= endSec) return;
    const from = Math.max(posSec, cs);
    const when = ctxStart + (from - posSec);
    const offset = c.offset + (from - cs);
    const dur = ce - from;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    scheduleClipEnvelope(g.gain, c, clips[k - 1], clips[k + 1], spb, from - cs, ce - cs, when);
    src.connect(g).connect(dest);
    src.start(when, offset, dur);
    src.onended = () => ((src as AudioBufferSourceNode & { _done?: boolean })._done = true);
    sources.push(src);
  });
}

/** A frozen track as an audio track: its render as one clip from beat 0. */
export function frozenAsAudio(t: Track): Track | null {
  const buf = t.frozen && buffers.get(t.frozen.bufferId);
  if (!buf) return null;
  return { ...t, kind: "audio", clips: [{ id: `frozen_${t.id}`, kind: "audio", start: 0, bufferId: t.frozen!.bufferId, offset: 0, duration: buf.duration }] };
}

/** Whether a track's sound comes from a frozen render (itself, or its kit owner for a mic). */
export const isFrozen = (p: Project, t: Track) => !!(t.frozen || (t.kind === "aux" && p.tracks.find((o) => o.id === t.auxOf)?.frozen));

/** A clip's fades (seconds) after automatic crossfades with overlapping neighbours. */
export function clipFades(c: AudioClip, prev: AudioClip | undefined, next: AudioClip | undefined, spb: number) {
  const cs = c.start * spb;
  const oIn = prev ? Math.max(0, prev.start * spb + prev.duration - cs) : 0;
  const oOut = next ? Math.max(0, cs + c.duration - next.start * spb) : 0;
  let fi = Math.max(FADE, c.fadeIn ?? 0, oIn), fo = Math.max(FADE, c.fadeOut ?? 0, oOut);
  if (fi + fo > c.duration) {
    const k = c.duration / (fi + fo);
    fi *= k;
    fo *= k;
  }
  return { fi, fo };
}

/**
 * Gain envelope of one clip on the timeline: equal-power fades (sin in, cos out — a crossfade
 * keeps its loudness), clip gain, and a click-free start/stop when playback begins mid-clip or a
 * loop end cuts it. ls / le: the clip-local seconds actually played; `when` = context time of ls.
 */
function scheduleClipEnvelope(p: AudioParam, c: AudioClip, prev: AudioClip | undefined, next: AudioClip | undefined, spb: number, ls: number, le: number, when: number) {
  const G = Math.pow(10, (c.gain ?? 0) / 20), D = c.duration;
  const { fi, fo } = clipFades(c, prev, next, spb);
  const env = (t: number) => G * (t < fi ? Math.sin((Math.PI / 2) * Math.max(0, t) / fi) : 1) * (t > D - fo ? Math.cos((Math.PI / 2) * Math.min(1, (t - (D - fo)) / fo)) : 1);
  const at = (t: number) => when + (t - ls);
  const curve = (a: number, b: number) => {
    const n = Math.max(2, Math.ceil((b - a) / 0.004));
    return Float32Array.from({ length: n }, (_, i) => env(a + ((b - a) * i) / (n - 1)));
  };
  let t1: number; // clip-local time where the start segment ends
  if (ls < fi) {
    t1 = Math.min(fi, le);
    if (t1 - ls > 1e-4) p.setValueCurveAtTime(curve(ls, t1), at(ls), t1 - ls);
    else p.setValueAtTime(env(ls), at(ls));
  } else {
    p.setValueAtTime(0, at(ls));
    t1 = Math.min(le, ls + FADE);
    p.linearRampToValueAtTime(env(t1), at(t1));
  }
  const foStart = D - fo;
  if (le > foStart && le >= D - 1e-6) {
    // the clip's own fade-out is reached
    const s = Math.max(foStart, t1);
    if (le - s > 1e-4) {
      p.setValueAtTime(env(s), at(s));
      p.setValueCurveAtTime(curve(s, le), at(s), le - s);
    }
  } else if (le - t1 > FADE) {
    // cut short (loop end / bounce end): quick fade at the cut
    if (le > foStart) {
      const s = Math.max(foStart, t1);
      p.setValueAtTime(env(s), at(s));
      if (le - FADE - s > 1e-4) p.setValueCurveAtTime(curve(s, le - FADE), at(s), le - FADE - s);
    } else p.setValueAtTime(env(le - FADE), at(le - FADE));
    p.linearRampToValueAtTime(0, at(le));
  }
}

/** Visit every MIDI note whose start lies in [b0, b1) (absolute beats). */
/**
 * Notes sorted by start, for big clips (transcribed full songs): the scheduler asks for a 25 ms
 * window every tick, so a binary search beats scanning thousands of notes. Notes are edited in
 * place, so the index is rebuilt whenever the project version or the note count changes.
 */
const sortedIdx = new WeakMap<Note[], { v: number; n: number; notes: Note[] }>();
function sortedNotes(notes: Note[]): Note[] {
  const v = store.projectVersion;
  const hit = sortedIdx.get(notes);
  if (hit && hit.v === v && hit.n === notes.length) return hit.notes;
  const sorted = notes.slice().sort((a, b) => a.start - b.start);
  sortedIdx.set(notes, { v, n: notes.length, notes: sorted });
  return sorted;
}

export function forNotes(track: Track, b0: number, b1: number, fn: (beat: number, pitch: number, durBeats: number, vel: number, slide?: NoteSlide) => void) {
  for (const c of track.clips) {
    if (c.kind !== "midi") continue;
    if (c.start >= b1 || c.start + c.length <= b0) continue;
    const big = c.notes.length > 256;
    const notes = big ? sortedNotes(c.notes) : c.notes;
    let i = 0;
    if (big) {
      // First note at or after the window start (clip-relative).
      let lo = 0, hi = notes.length;
      const s0 = b0 - c.start;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (notes[m].start < s0) lo = m + 1;
        else hi = m;
      }
      i = lo;
    }
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.start >= c.length) {
        if (big) break;
        continue;
      }
      const beat = c.start + n.start;
      if (big && beat >= b1) break;
      if (beat >= b0 && beat < b1) fn(beat, n.pitch, Math.min(n.dur, c.length - n.start), n.vel, n.slide);
    }
  }
}
