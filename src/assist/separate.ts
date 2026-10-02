/**
 * "Split stems" (Logic: Stem Splitter). Splits one audio track into drums / bass / vocals / other
 * on the DSP worker pool. When the source is the full mix and the song isn't analysed yet, it also
 * derives tempo, downbeat, key, sections and chords and aligns the song to the bar grid.
 */
import { estimateChords } from "../analysis/chords";
import { makeGrid } from "../analysis/grid";
import { estimateKey } from "../analysis/key";
import { estimateSections } from "../analysis/sections";
import { estimateTempo } from "../analysis/tempo";
import { dspPool } from "../dsp/pool";
import { savePcm } from "../io/persist";
import { DEMUCS_MODEL_MB, demucsBackend, demucsCached, demucsSeparate, type DemucsStem } from "../ml/demucs";
import { engine } from "../engine/transport";
import { bufferSources, buffers, pendingBuffers, store } from "../model/store";
import { NOTE_NAMES, type AudioClip, type Role, type Track } from "../model/types";
import { audioTrack, registerBuffer } from "./tracks";
import { retempo } from "../edit/ops";

export type SplitEngine = "ai" | "dsp";

/** AI (Demucs 6-stem) track layout. "other" = whatever isn't drums/bass/vocals/guitar/piano. */
const AI_STEMS: [DemucsStem, string, Role][] = [
  ["drums", "Drums", "drums"],
  ["bass", "Bass", "bass"],
  ["vocals", "Vocals", "vocals"],
  ["guitar", "Guitar", "guitar"],
  ["piano", "Piano", "piano"],
  ["other", "Other", "other"],
];

/** Quick (DSP) split layout. */
export const STEMS: ["drums" | "bass" | "vocals" | "other", string, Role][] = [
  ["drums", "Drums", "drums"],
  ["bass", "Bass", "bass"],
  ["vocals", "Vocals", "vocals"],
  ["other", "Guitar / Synth", "other"],
];

export function toAudioBuffer(ch: [Float32Array, Float32Array], sr: number): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: 2, length: ch[0].length, sampleRate: sr });
  b.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
  b.copyToChannel(ch[1] as Float32Array<ArrayBuffer>, 1);
  return b;
}

/** The audio track a command should act on: explicit id → selection → the original mix. */
export function audioSource(trackId?: string | null): { track: Track; clip: AudioClip; buffer: AudioBuffer } {
  const p = store.project;
  const track =
    p.tracks.find((t) => t.id === trackId && t.kind === "audio") ??
    p.tracks.find((t) => t.id === store.ui.selectedTrackId && t.kind === "audio") ??
    p.tracks.find((t) => t.role === "mix");
  const clip = track?.clips.find((c): c is AudioClip => c.kind === "audio");
  const buffer = clip && buffers.get(clip.bufferId);
  if (!track || !clip || !buffer) throw new Error("Select an audio track (or import a song) first");
  return { track, clip, buffer };
}

export async function splitStems(trackId?: string | null, engineKind: SplitEngine = "ai") {
  const { track, clip, buffer } = audioSource(trackId);
  const p = store.project;
  engine.stop();
  const spb0 = 60 / p.bpm;
  const origin = clip.start - clip.offset / spb0; // timeline beat of the buffer's first sample
  const analyse = track.role === "mix" && !p.sections.length; // song analysis only for the full mix, once
  const t0 = performance.now();

  // 1) Stems
  let made: { name: string; role: Role; stem: string; buf: AudioBuffer }[];
  let features: Awaited<ReturnType<typeof dspPool.separate>>["features"] | null = null;
  if (engineKind === "ai") {
    const cached = await demucsCached();
    if (!cached) store.log(`Downloading the AI stem model once (${DEMUCS_MODEL_MB} MB), then it's cached in this browser…`);
    // Analysis features come from the DSP pool in parallel with the GPU separation.
    const feat = analyse ? dspPool.separate(buffer, () => {}, true) : null;
    const stems = await demucsSeparate(buffer, (pr) => {
      const label =
        pr.phase === "download" ? `Downloading AI stem model… ${pr.detail ?? ""}` :
        pr.phase === "init" ? `AI stem model: ${pr.detail ?? "starting…"}` :
        `AI stem split of "${track.name}" (Demucs 6-stem, ${demucsBackend || "…"})${pr.detail ? " · " + pr.detail : ""}`;
      store.busy(label, pr.progress);
    });
    features = feat ? (await feat).features : null;
    made = AI_STEMS.map(([stem, name, role]) => ({ name, role, stem, buf: stems[stem] }));
    store.log(`AI stem split of ${track.name}: ${((performance.now() - t0) / 1000).toFixed(1)} s [Demucs 6-stem on ${demucsBackend}]`);
  } else {
    const label = `Quick split of "${track.name}" (${dspPool.size} workers)…`;
    store.busy(label, 0);
    const sep = await dspPool.separate(buffer, (pr) => store.busy(label, pr));
    features = analyse ? sep.features : null;
    made = STEMS.map(([stem, name, role]) => ({ name, role, stem, buf: toAudioBuffer(sep.stems[stem], buffer.sampleRate) }));
    store.log(`Quick stem split of ${track.name}: ${((performance.now() - t0) / 1000).toFixed(1)} s on ${dspPool.size} workers`);
  }

  // 2) Song analysis (full mix only)
  let newOrigin = origin;
  let analysis: Partial<typeof p> = {};
  if (analyse && features) {
    const tempo = estimateTempo(features);
    const grid = makeGrid(tempo, buffer.duration);
    const key = estimateKey(features);
    const sections = estimateSections(features, grid);
    const chords = estimateChords(features, grid, key);
    newOrigin = grid.clipStartBeat;
    analysis = { bpm: grid.bpm, key, sections, chords, loop: { on: false, start: sections[0]?.start ?? 0, end: (sections[0]?.start ?? 0) + 16 } };
    store.log(`Tempo ${tempo.bpm} BPM, first downbeat ${tempo.downbeatSec.toFixed(2)} s · Key ${NOTE_NAMES[key.tonic]} ${key.minor ? "minor" : "major"}`);
    store.log(`Sections: ${sections.map((s) => `${s.label}(${s.length / 4})`).join(" · ")}`);
  }

  // 3) Tracks (+ provenance so the session can be restored after a reload)
  store.busy("Building stem tracks…", 1);
  const ids = await Promise.all(made.map((m) => registerBuffer(m.buf))); // waveform peaks in parallel on the pool
  ids.forEach((id, i) => bufferSources.set(id, { type: "stem", parent: clip.bufferId, stem: made[i].stem, engine: engineKind }));
  if (engineKind === "ai") await Promise.all(ids.map((id, i) => savePcm(id, made[i].buf).catch((e) => store.log(`Error: couldn't store stem for restore: ${e}`))));
  const prefix = track.role === "mix" ? "" : `${track.name} · `;
  const stems = made.map((m, i) => audioTrack(`${prefix}${m.name}`, m.role, ids[i], newOrigin));

  store.update((pp) => {
    // New tempo from analysis: rescale what's already there so it stays put in real time,
    // then align the analysed material to the bar grid.
    const originSec = origin * spb0;
    if (analysis.bpm) retempo(pp, analysis.bpm);
    Object.assign(pp, analysis);
    const src = pp.tracks.find((t) => t.id === track.id)!;
    const shift = newOrigin - originSec / (60 / pp.bpm);
    if (Math.abs(shift) > 1e-9)
      for (const t of pp.tracks)
        for (const c of t.clips) if (c.kind === "audio" ? t.id === src.id : c.anchored) c.start += shift;
    src.ch.mute = true;
    pp.tracks.splice(pp.tracks.indexOf(src) + 1, 0, ...stems);
  });
  pendingBuffers.clear();
  store.setUi({ selectedTrackId: stems.find((t) => t.role === "vocals")?.id ?? stems[0].id, selectedClipId: null });
}
