/**
 * A/B listening on the project's own transport: "source" plays the original tracks, "result"
 * plays preview tracks of the current result. Loudness compensation renders both offline
 * (OfflineAudioContext), measures LUFS in the DSP worker and trims the louder side, so the
 * comparison isn't won by level. Nothing here touches the project or its undo history.
 */
import { dspPool } from "../dsp/pool";
import { renderProject } from "../engine/render";
import { engine } from "../engine/transport";
import { store } from "../model/store";
import { previewTracks } from "./session";
import type { DrumSession, Output, PipelineResult } from "./types";

export type AbMode = "off" | "source" | "result";

interface State {
  mode: AbMode;
  solo: Output | null;
  match: boolean;
  trims: { source: number; result: number } | null;
  lufs: { source: number; result: number } | null;
  measuring: boolean;
  measuredKey: string;
  error: string | null;
}

let state: State = { mode: "off", solo: null, match: true, trims: null, lufs: null, measuring: false, measuredKey: "", error: null };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const audition = {
  get: () => state,
  subscribe: (f: () => void) => {
    subs.add(f);
    return () => subs.delete(f);
  },
  set,
};

let current: { s: DrumSession; r: PipelineResult } | null = null;

/** Push the current mode / result into the engine. Call whenever session, result or mode change. */
export function refreshAudition(s: DrumSession | null, r: PipelineResult | null) {
  current = s && r ? { s, r } : null;
  if (!s || !r || state.mode === "off") {
    if (engine.audition) engine.setAudition(null);
    return;
  }
  const preview = previewTracks(s, r);
  const previewIds = preview.map((t) => t.id);
  const applied = Object.values(s.applied?.tracks ?? {});
  const mute = new Set<string>(applied);
  const unmute = new Set<string>();
  if (state.mode === "result") {
    s.source.trackIds.forEach((id) => mute.add(id));
    if (state.solo) previewIds.filter((id) => id !== `dp-preview-${state.solo}`).forEach((id) => mute.add(id));
  } else {
    previewIds.forEach((id) => mute.add(id));
    s.source.trackIds.forEach((id) => unmute.add(id));
  }
  const trimDb = new Map<string, number>();
  if (state.match && state.trims && state.measuredKey === keyOf(s, r)) {
    s.source.trackIds.forEach((id) => trimDb.set(id, state.trims!.source));
    previewIds.forEach((id) => trimDb.set(id, state.trims!.result));
  }
  engine.setAudition({ tracks: preview, mute, unmute, trimDb });
}

const keyOf = (s: DrumSession, r: PipelineResult) => JSON.stringify([s.source.trackIds, s.sound, r.final.length, r.final.slice(0, 64).map((e) => [e.voice, e.start, e.vel])]);

export function setMode(mode: AbMode) {
  set({ mode });
  if (current) refreshAudition(current.s, current.r);
  else if (mode === "off") engine.setAudition(null);
}

export function setSolo(solo: Output | null) {
  set({ solo });
  if (current) refreshAudition(current.s, current.r);
}

/** Render ≤ 16 bars of source and result, measure integrated loudness, trim the louder one. */
export async function measureLoudness(s: DrumSession, r: PipelineResult) {
  if (state.measuring) return;
  const key = keyOf(s, r);
  set({ measuring: true, error: null });
  try {
    const p = store.project;
    const from = s.source.start;
    const to = from + Math.min(64, Math.max(s.source.length, 4));
    const srcProject = { ...p, tracks: p.tracks.filter((t) => s.source.trackIds.includes(t.id)).map((t) => ({ ...t, ch: { ...t.ch, mute: false, solo: false } })) };
    const preview = previewTracks(s, r);
    const resProject = { ...p, tracks: preview };
    const [a, b] = await Promise.all([
      renderProject(srcProject, { fromBeat: from, toBeat: to, onlyTracks: s.source.trackIds, bypassMaster: true }),
      renderProject(resProject, { fromBeat: from, toBeat: to, onlyTracks: preview.map((t) => t.id), bypassMaster: true }),
    ]);
    const [la, lb] = await Promise.all([dspPool.lufs(a), dspPool.lufs(b)]);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) throw new Error(`could not measure (${Number.isFinite(la) ? "result" : "source"} is silent)`);
    const d = Math.max(-12, Math.min(12, la - lb));
    set({ lufs: { source: la, result: lb }, trims: d > 0 ? { source: -d, result: 0 } : { source: 0, result: d }, measuredKey: key, measuring: false });
    store.log(`Drum Producer A/B: source ${la.toFixed(1)} LUFS, result ${lb.toFixed(1)} LUFS → louder side trimmed ${Math.abs(d).toFixed(1)} dB`);
    if (current) refreshAudition(current.s, current.r);
  } catch (e) {
    set({ measuring: false, error: (e as Error).message });
  }
}

/** Leaving the panel ends any audition (the engine returns to the plain project). */
export function endAudition() {
  set({ mode: "off" });
  current = null;
  if (engine.audition) engine.setAudition(null);
}
