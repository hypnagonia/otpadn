/**
 * A/B for the Part Producer on the project's transport (engine.setAudition): source tracks vs one
 * preview track, with offline-measured loudness matching. Nothing here touches the project.
 */
import { dspPool } from "../dsp/pool";
import { renderProject } from "../engine/render";
import { engine } from "../engine/transport";
import { store } from "../model/store";
import { previewTrack } from "./session";
import type { PartSession, PipelineResult } from "./types";

export type AbMode = "off" | "source" | "result";

interface State { mode: AbMode; match: boolean; trims: { source: number; result: number } | null; lufs: { source: number; result: number } | null; measuring: boolean; key: string; error: string | null }
let state: State = { mode: "off", match: true, trims: null, lufs: null, measuring: false, key: "", error: null };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
export const ppAudition = { get: () => state, subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)), set };

const keyOf = (s: PartSession, r: PipelineResult) => JSON.stringify([s.source.trackIds, s.sound, r.final.length, r.final.slice(0, 48).map((e) => [e.pitch, e.start, e.vel])]);

export function refreshPartAudition(s: PartSession | null, r: PipelineResult | null) {
  if (!s || !r || state.mode === "off") {
    if (engine.audition?.tracks.some((t) => t.id === "pp-preview")) engine.setAudition(null);
    return;
  }
  const t = previewTrack(s, r);
  const mute = new Set<string>(s.applied ? [s.applied.trackId] : []);
  const unmute = new Set<string>();
  if (state.mode === "result") s.source.trackIds.forEach((id) => mute.add(id));
  else {
    mute.add(t.id);
    s.source.trackIds.forEach((id) => unmute.add(id));
  }
  const trimDb = new Map<string, number>();
  if (state.match && state.trims && state.key === keyOf(s, r)) {
    s.source.trackIds.forEach((id) => trimDb.set(id, state.trims!.source));
    trimDb.set(t.id, state.trims.result);
  }
  engine.setAudition({ tracks: [t], mute, unmute, trimDb });
}

export async function measurePart(s: PartSession, r: PipelineResult) {
  if (state.measuring) return;
  set({ measuring: true, error: null });
  try {
    const p = store.project;
    const from = s.source.start, to = from + Math.min(64, Math.max(4, s.source.length));
    const src = { ...p, tracks: p.tracks.filter((t) => s.source.trackIds.includes(t.id)).map((t) => ({ ...t, ch: { ...t.ch, mute: false, solo: false } })) };
    const pv = previewTrack(s, r);
    const [a, b] = await Promise.all([
      renderProject(src, { fromBeat: from, toBeat: to, onlyTracks: s.source.trackIds, bypassMaster: true }),
      renderProject({ ...p, tracks: [pv] }, { fromBeat: from, toBeat: to, onlyTracks: [pv.id], bypassMaster: true }),
    ]);
    const [la, lb] = await Promise.all([dspPool.lufs(a), dspPool.lufs(b)]);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) throw new Error(`could not measure (${Number.isFinite(la) ? "result" : "source"} is silent)`);
    const d = Math.max(-12, Math.min(12, la - lb));
    set({ lufs: { source: la, result: lb }, trims: d > 0 ? { source: -d, result: 0 } : { source: 0, result: d }, key: keyOf(s, r), measuring: false });
    refreshPartAudition(s, r);
  } catch (e) {
    set({ measuring: false, error: (e as Error).message });
  }
}

export function setPartMode(mode: AbMode, s: PartSession | null, r: PipelineResult | null) {
  set({ mode });
  refreshPartAudition(s, r);
}

export function endPartAudition() {
  set({ mode: "off" });
  if (engine.audition?.tracks.some((t) => t.id === "pp-preview")) engine.setAudition(null);
}
