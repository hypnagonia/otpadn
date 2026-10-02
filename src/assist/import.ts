/** Step 0: decode a dropped file into a fresh project with one "Original Mix" track. */
import { engine } from "../engine/transport";
import { saveFile } from "../io/persist";
import { bufferSources, emptyProject, pendingBuffers, store } from "../model/store";
import { audioTrack, registerBuffer } from "./tracks";
import { est, memory } from "../system/memory";

export async function importAudio(file: File) {
  store.busy(`Decoding ${file.name}…`);
  try {
    await memory.ensure(est.decodedFromFile(file, engine.ctx.sampleRate) * 1.3, `importing ${file.name}`);
    memory.persistStorage();
    const data = await file.arrayBuffer();
    const bytes = data.slice(0); // decodeAudioData detaches its input
    const buf = await engine.ctx.decodeAudioData(data);
    const id = await registerBuffer(buf);
    bufferSources.clear();
    bufferSources.set(id, { type: "file", name: file.name });
    await saveFile(id, bytes, file.name);
    const p = emptyProject();
    p.name = file.name.replace(/\.[^.]+$/, "");
    p.tracks.push(audioTrack("Original Mix", "mix", id, 0));
    engine.stop();
    engine.seek(0);
    store.setProject(p);
    pendingBuffers.clear();
    store.log(`Imported ${file.name}: ${buf.duration.toFixed(1)} s, ${buf.sampleRate} Hz, ${buf.numberOfChannels} ch`);
  } finally {
    store.busy(null);
  }
}
