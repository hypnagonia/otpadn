/**
 * Freeze / unfreeze (Logic-style): render a track's instrument + EQ + inserts (+ a kit's mics and
 * bus, + plug-in automation) to audio, pre-fader. The frozen track plays that render; fader, pan,
 * sends and volume/pan/send automation stay live. Its instrument and plug-ins are released.
 */
import { engine } from "../engine/transport";
import { isPluginLane } from "../engine/automation";
import { renderProject } from "../engine/render";
import { savePcm } from "../io/persist";
import { bufferSources, store } from "../model/store";
import type { Project, Track } from "../model/types";
import { registerBuffer } from "../assist/tracks";
import { memory } from "../system/memory";

const EQ_KEYS = ["hpf", "eqLow", "eqLowFreq", "eqMid", "eqMidFreq", "eqMidQ", "eqMid2", "eqMid2Freq", "eqMid2Q", "eqHigh", "eqHighFreq", "lpf"] as const;

/** Everything a freeze bakes in: if this changes later, the frozen audio is outdated. */
export function freezeSig(p: Project, t: Track): string {
  const eq = Object.fromEntries(EQ_KEYS.map((k) => [k, t.ch[k]]));
  const aux = p.tracks.filter((a) => a.auxOf === t.id).map((a) => ({ ch: a.ch, ins: a.inserts }));
  return JSON.stringify({ clips: t.clips, inst: t.instrument, ins: t.inserts, eq, kit: t.drumKit, layers: t.kitLayers, bleed: t.kitCymbalBleed, lanes: (t.automation ?? []).filter((l) => isPluginLane(l.param)), aux, bpm: p.bpm });
}

export const canFreeze = (t: Track) => t.kind === "midi" || (t.kind === "audio" && (t.inserts ?? []).some((i) => i.on));

export async function freezeTrack(id: string) {
  const p = store.project, t = p.tracks.find((x) => x.id === id);
  if (!t || !canFreeze(t)) return;
  const spb = 60 / p.bpm, end = Math.max(4, p.lengthBeats);
  await memory.ensure((end * spb + 4) * engine.ctx.sampleRate * 2 * 4 * 1.6, `freezing "${t.name}"`);
  store.busy(`Freezing "${t.name}"…`, 0);
  try {
    // Pre-fader render of this track (and a kit's mics): fader / pan / sends stay live afterwards.
    const clone = structuredClone(p);
    const ct = clone.tracks.find((x) => x.id === id)!;
    delete ct.frozen;
    ct.ch = { ...ct.ch, volumeDb: 0, pan: 0, mute: false, solo: false, reverbSend: 0, sends: [] };
    ct.automation = (ct.automation ?? []).filter((l) => isPluginLane(l.param));
    const ids = [id, ...clone.tracks.filter((a) => a.auxOf === id).map((a) => a.id)];
    const buf = await renderProject(clone, { onlyTracks: ids, bypassMaster: true, toBeat: end, sampleRate: engine.ctx.sampleRate, onProgress: (x) => store.busy(`Freezing "${t.name}"…`, x) });
    const bufferId = await registerBuffer(buf);
    bufferSources.set(bufferId, { type: "frozen" });
    await savePcm(bufferId, buf);
    store.update((pp) => {
      const tt = pp.tracks.find((x) => x.id === id);
      if (tt) tt.frozen = { bufferId, sig: freezeSig(pp, tt) };
    });
    store.log(`Froze "${t.name}" — its instrument and plug-ins are released (fader, pan and sends stay live)`);
  } finally {
    store.busy(null);
  }
}

export function unfreezeTrack(id: string) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === id);
    if (t) delete t.frozen;
  });
}
