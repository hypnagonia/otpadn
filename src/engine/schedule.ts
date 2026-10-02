/** Clip → audio-node scheduling shared by live playback and offline bounce. */
import { buffers } from "../model/store";
import type { Project, Track } from "../model/types";

const FADE = 0.004;

/**
 * Mute/solo with routing in mind: a kit's mic (aux) tracks flow through their owner's strip
 * (the drum bus). Soloing a mic keeps its bus open; soloing the bus keeps its mics open.
 * Mute always wins for the track it is on (a muted bus silences all its mics).
 */
export const isAudible = (p: Project, t: Track): boolean => {
  if (t.ch.mute) return false;
  if (!p.tracks.some((x) => x.ch.solo)) return true;
  if (t.ch.solo) return true;
  if (t.kind === "aux") return !!p.tracks.find((o) => o.id === t.auxOf)?.ch.solo;
  // An FX bus stays open while anything audible sends to it (a soloed vocal keeps its reverb).
  if (t.kind === "bus") return p.tracks.some((x) => x.kind !== "bus" && x.ch.sends?.some((sd) => sd.bus === t.id) && isAudible(p, x));
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
  for (const c of track.clips) {
    if (c.kind !== "audio") continue;
    const buf = buffers.get(c.bufferId);
    if (!buf) continue;
    const cs = c.start * spb;
    const ce = Math.min(cs + c.duration, endSec);
    if (ce <= posSec || cs >= endSec) continue;
    const from = Math.max(posSec, cs);
    const when = ctxStart + (from - posSec);
    const offset = c.offset + (from - cs);
    const dur = ce - from;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + FADE);
    g.gain.setValueAtTime(1, when + Math.max(FADE, dur - FADE));
    g.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(g).connect(dest);
    src.start(when, offset, dur);
    src.onended = () => ((src as AudioBufferSourceNode & { _done?: boolean })._done = true);
    sources.push(src);
  }
}

/** Visit every MIDI note whose start lies in [b0, b1) (absolute beats). */
export function forNotes(track: Track, b0: number, b1: number, fn: (beat: number, pitch: number, durBeats: number, vel: number) => void) {
  for (const c of track.clips) {
    if (c.kind !== "midi") continue;
    if (c.start >= b1 || c.start + c.length <= b0) continue;
    for (const n of c.notes) {
      if (n.start >= c.length) continue;
      const beat = c.start + n.start;
      if (beat >= b0 && beat < b1) fn(beat, n.pitch, Math.min(n.dur, c.length - n.start), n.vel);
    }
  }
}
