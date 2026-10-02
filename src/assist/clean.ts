/**
 * "Dereverb + denoise": one DPDFNet pass over an audio track (src/ml/dpdfnet.ts). The track's
 * clips are switched to the cleaned audio in place — undo brings the original back.
 */
import { savePcm } from "../io/persist";
import { dereverbDenoise } from "../ml/dpdfnet";
import { bufferSources, pendingBuffers, store } from "../model/store";
import { audioSource } from "./separate";
import { registerBuffer } from "./tracks";

export async function cleanAudio(trackId: string | null | undefined, mix = 1) {
  const { track, clip, buffer } = audioSource(trackId);
  const t0 = performance.now();
  const label = `Dereverb + denoise “${track.name}”`;
  store.busy(`${label}…`, 0);
  const out = await dereverbDenoise(buffer, mix, (p) =>
    store.busy(p.phase === "model" ? `Loading dereverb model (once)${p.detail ? " · " + p.detail : ""}` : `${label} (${buffer.numberOfChannels} ch in parallel)`, p.progress),
  );
  const id = await registerBuffer(out);
  bufferSources.set(id, { type: "processed", parent: clip.bufferId, op: "dpdfnet", mix });
  savePcm(id, out).catch((e) => store.log(`Error: couldn't store cleaned audio for restore: ${e}`));
  const oldId = clip.bufferId;
  store.update((p) => {
    // Every clip of this track that plays the same audio switches over (offsets/durations are
    // in seconds and the result is sample-aligned, so nothing moves).
    for (const c of p.tracks.find((t) => t.id === track.id)!.clips) if (c.kind === "audio" && c.bufferId === oldId) c.bufferId = id;
    const t = p.tracks.find((x) => x.id === track.id)!;
    if (!/· clean/.test(t.name)) t.name = `${t.name} · clean`;
  });
  pendingBuffers.clear();
  store.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s, mix ${Math.round(mix * 100)}% [DPDFNet-8, WASM ×${buffer.numberOfChannels}]`);
  store.busy(null);
}
