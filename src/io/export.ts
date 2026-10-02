import { Midi } from "@tonejs/midi";
import { renderProject } from "../engine/render";
import { isDrumInstrument } from "../instruments/catalog";
import { dspPool } from "../dsp/pool";
import { store } from "../model/store";
import { est, memory } from "../system/memory";

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Bounce range: the cycle (yellow) range when cycle is on, else the whole project. */
export function bounceRange(p = store.project): { from: number; to: number; cycle: boolean } {
  if (p.loop.on && p.loop.end > p.loop.start) return { from: p.loop.start, to: p.loop.end, cycle: true };
  return { from: 0, to: p.lengthBeats, cycle: false };
}
const barsLabel = (r: { from: number; to: number }) => `bars ${Math.floor(r.from / 4) + 1}-${Math.ceil(r.to / 4)}`;

export async function exportWav() {
  const p = store.project;
  const range = bounceRange(p);
  const label = `Rendering mixdown${range.cycle ? ` (cycle, ${barsLabel(range)})` : ""}…`;
  store.busy(label, 0);
  try {
    // Offline render target + WAV copy in the worker + encoded file.
    await memory.ensure(est.pcm((range.to - range.from) * (60 / p.bpm) + 3, 48000, 2) * 3, "bouncing the mix");
    const buf = await renderProject(p, { sampleRate: 48000, fromBeat: range.from, toBeat: range.to, onProgress: (f) => store.busy(label, f * 0.95) });
    store.busy("Encoding WAV…", 0.97);
    const name = `${p.name || "mix"}${range.cycle ? ` (${barsLabel(range)})` : ""}.wav`;
    download(await dspPool.wav(buf), name);
    store.log(`Exported ${name} (${buf.duration.toFixed(1)} s incl. tail, 48 kHz / 24-bit${range.cycle ? ", cycle range only" : ""})`);
  } finally {
    store.busy(null);
  }
}

/**
 * Bounce each track (or the given ones) on its own through its channel strip, with effect
 * tails and without master processing, so the stems sum to the pre-master mix.
 */
export async function exportStems(trackIds?: string[]) {
  const p = store.project;
  const ids = trackIds ?? p.tracks.filter((t) => t.clips.length && !t.ch.mute).map((t) => t.id);
  const range = bounceRange(p);
  try {
    for (let i = 0; i < ids.length; i++) {
      const t = p.tracks.find((x) => x.id === ids[i]);
      if (!t) continue;
      const label = `Rendering stem ${i + 1}/${ids.length}: ${t.name}${range.cycle ? ` (cycle, ${barsLabel(range)})` : ""}…`;
      store.busy(label, i / ids.length);
      const buf = await renderProject(p, { sampleRate: 48000, onlyTracks: [t.id], bypassMaster: true, fromBeat: range.from, toBeat: range.to, onProgress: (f) => store.busy(label, (i + f) / ids.length) });
      download(await dspPool.wav(buf), `${p.name || "mix"} - ${String(i + 1).padStart(2, "0")} ${t.name.replace(/[\\/:*?"<>|]/g, "_")}.wav`);
    }
    store.log(`Exported ${ids.length} stems (48 kHz / 24-bit, pre-master, with effect tails)`);
  } finally {
    store.busy(null);
  }
}

export function exportMidi() {
  const p = store.project;
  const midi = new Midi();
  midi.header.setTempo(p.bpm);
  midi.header.name = p.name;
  const spb = 60 / p.bpm;
  for (const t of p.tracks) {
    if (t.kind !== "midi") continue;
    const tr = midi.addTrack();
    tr.name = t.name;
    if (isDrumInstrument(t.instrument)) tr.channel = 9;
    for (const c of t.clips) {
      if (c.kind !== "midi") continue;
      for (const n of c.notes) {
        if (n.start >= c.length) continue;
        tr.addNote({ midi: n.pitch, time: (c.start + n.start) * spb, duration: Math.min(n.dur, c.length - n.start) * spb, velocity: n.vel / 127 });
      }
    }
  }
  download(new Blob([midi.toArray() as Uint8Array<ArrayBuffer>], { type: "audio/midi" }), `${p.name || "project"}.mid`);
  store.log(`Exported ${p.name}.mid (${midi.tracks.length} tracks)`);
}
