/** Buses (FX returns), sends and sidechains. */
import { store } from "../model/store";
import { defaultChannel, uid, type Send, type Track } from "../model/types";
import { defaultParams } from "../plugins/defs";

export type BusPreset = "reverb" | "delay" | "empty";

/** New bus track (100 % wet effect) at the end of the track list. */
export function createBus(preset: BusPreset = "reverb", name?: string): Track {
  const t: Track = {
    id: uid("bus"),
    name: name ?? (preset === "reverb" ? "Reverb bus" : preset === "delay" ? "Delay bus" : "Bus"),
    kind: "bus",
    role: "other",
    color: preset === "delay" ? "#57b26a" : "#7d8fb3",
    clips: [],
    ch: defaultChannel(),
    inserts:
      preset === "reverb"
        ? [{ id: uid("ins"), type: "reverb", on: true, params: { ...defaultParams("reverb"), mix: 100 } }]
        : preset === "delay"
          ? [{ id: uid("ins"), type: "delay", on: true, params: { ...defaultParams("delay"), mix: 100 } }]
          : [],
  };
  store.update((p) => p.tracks.push(t));
  return t;
}

export function addSend(trackId: string, busId: string, level = -12, pre = false) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || t.kind === "bus" || t.id === busId) return;
    t.ch.sends ??= [];
    if (!t.ch.sends.some((s) => s.bus === busId)) t.ch.sends.push({ id: uid("snd"), bus: busId, level, pre });
  });
}

export function updateSend(trackId: string, sendId: string, patch: Partial<Send>) {
  store.update((p) => {
    const s = p.tracks.find((x) => x.id === trackId)?.ch.sends?.find((x) => x.id === sendId);
    if (s) Object.assign(s, patch);
  });
}

export function removeSend(trackId: string, sendId: string) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (t?.ch.sends) t.ch.sends = t.ch.sends.filter((s) => s.id !== sendId);
  });
}

export function setSidechain(owner: string, insertId: string, source: string | null) {
  store.update((p) => {
    const list = owner === "master" ? p.masterInserts : p.tracks.find((t) => t.id === owner)?.inserts;
    const ins = list?.find((i) => i.id === insertId);
    if (!ins) return;
    if (source) ins.sidechain = source;
    else delete ins.sidechain;
  });
}
