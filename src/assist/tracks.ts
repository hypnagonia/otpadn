/** Track/clip factories and buffer registration shared by import, analysis and arrange. */
import { DEFAULT_INSTRUMENT } from "../instruments/catalog";
import { dspPool } from "../dsp/pool";
import { memory } from "../system/memory";
import { buffers, PEAK_BLOCK, peaksCache, pendingBuffers } from "../model/store";
import { defaultChannel, ROLE_COLORS, uid, type AudioClip, type MidiClip, type Role, type Track } from "../model/types";

/** Store decoded audio + compute waveform peaks (worker). Protected from GC until a clip uses it. */
export async function registerBuffer(buf: AudioBuffer, id = uid("buf")): Promise<string> {
  buffers.set(id, buf);
  pendingBuffers.add(id); // protect from GC until a clip references it
  const peaks = await dspPool.peaks(buf, PEAK_BLOCK);
  peaksCache.set(id, peaks);
  memory.track(`buf:${id}`, buf.length * buf.numberOfChannels * 4 + peaks.byteLength, "audio", "decoded audio");
  return id;
}

export function audioTrack(name: string, role: Role, bufferId: string, startBeat: number): Track {
  const buf = buffers.get(bufferId)!;
  const clip: AudioClip = { id: uid("clip"), kind: "audio", start: startBeat, bufferId, offset: 0, duration: buf.duration };
  return { id: uid("trk"), name, kind: "audio", role, color: ROLE_COLORS[role], clips: [clip], ch: defaultChannel(), inserts: [] };
}

export function midiTrack(name: string, role: Role, clips: MidiClip[], instrument = DEFAULT_INSTRUMENT[role]): Track {
  return { id: uid("trk"), name, kind: "midi", role, color: ROLE_COLORS[role], instrument, clips, ch: defaultChannel(), inserts: [] };
}
