/** Multitrack kit sample layers (kick / snare reinforcement): load, set level, clear. */
import { engine } from "../engine/transport";
import { saveFile } from "../io/persist";
import { bufferSources, store } from "../model/store";
import type { KitLayerSlot } from "../model/types";
import { registerBuffer } from "../assist/tracks";
import { est, memory } from "../system/memory";

/** Starting levels, fitted to the reference: the snare layer carries more of the sound. */
const LAYER_DEFAULT_DB: Record<KitLayerSlot, number> = { kick: -6, snare: 0 };

export async function loadKitLayer(trackId: string, slot: KitLayerSlot, file: File) {
  await memory.ensure(est.decodedFromFile(file, engine.ctx.sampleRate) * 1.3, `loading the ${slot} layer`);
  const data = await file.arrayBuffer();
  const bytes = data.slice(0); // decodeAudioData detaches its input
  const buf = await engine.ctx.decodeAudioData(data);
  if (buf.duration > 4) throw new Error(`${file.name} is ${buf.duration.toFixed(1)} s long — a layer must be a one-shot (under 4 s).`);
  const id = await registerBuffer(buf);
  bufferSources.set(id, { type: "file", name: file.name });
  if (await memory.ensureDisk(bytes.byteLength, "the sample layer")) await saveFile(id, bytes, file.name);
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (t) t.kitLayers = { ...t.kitLayers, [slot]: { bufferId: id, name: file.name, level: t.kitLayers?.[slot]?.level ?? LAYER_DEFAULT_DB[slot] } };
  });
  store.log(`Loaded ${file.name} as the ${slot} layer`);
}

export function setKitLayerLevel(trackId: string, slot: KitLayerSlot, level: number) {
  store.update((p) => {
    const l = p.tracks.find((x) => x.id === trackId)?.kitLayers?.[slot];
    if (l) l.level = level;
  });
}

export function clearKitLayer(trackId: string, slot: KitLayerSlot) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (t?.kitLayers) delete t.kitLayers[slot];
  });
}
