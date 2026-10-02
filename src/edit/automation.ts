/** Automation editing: points (arrange view) and latch writing from mixer / plug-in controls. */
import { engine } from "../engine/transport";
import { store } from "../model/store";
import type { AutoLane, Project, Track } from "../model/types";

function laneOf(p: Project, trackId: string, param: string, create: boolean): { t: Track; lane: AutoLane } | null {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  t.automation ??= [];
  let lane = t.automation.find((l) => l.param === param);
  if (!lane && create) t.automation.push((lane = { param, points: [] }));
  return lane ? { t, lane } : null;
}
const sortLane = (l: AutoLane) => l.points.sort((a, b) => a.beat - b.beat);

export function addPoint(trackId: string, param: string, beat: number, value: number): number {
  let idx = -1;
  store.update((p) => {
    const r = laneOf(p, trackId, param, true)!;
    r.lane.points.push({ beat: Math.max(0, beat), value });
    sortLane(r.lane);
    idx = r.lane.points.findIndex((pt) => pt.beat === Math.max(0, beat) && pt.value === value);
  });
  return idx;
}

/** Move a point, kept between its neighbours. Returns its (unchanged) index. */
export function movePoint(trackId: string, param: string, index: number, beat: number, value: number) {
  store.update((p) => {
    const pts = laneOf(p, trackId, param, false)?.lane.points;
    if (!pts?.[index]) return;
    const lo = index > 0 ? pts[index - 1].beat : 0, hi = index < pts.length - 1 ? pts[index + 1].beat : Infinity;
    pts[index] = { beat: Math.max(lo, Math.min(hi, beat)), value };
  });
}

export function deletePoint(trackId: string, param: string, index: number) {
  store.update((p) => {
    const r = laneOf(p, trackId, param, false);
    if (!r) return;
    r.lane.points.splice(index, 1);
    if (!r.lane.points.length) r.t.automation = r.t.automation!.filter((l) => l !== r.lane);
  });
}

export function clearLane(trackId: string, param: string) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (t?.automation) t.automation = t.automation.filter((l) => l.param !== param);
  });
}

const lastWrite = new Map<string, number>();

/**
 * A mixer / plug-in control moved. Latch write (write on, playing): record a point at the
 * playhead, replacing what this pass has run over. Stopped, on an automated parameter: set the
 * value at the playhead (otherwise the change would be overridden by the curve).
 */
export function controlChanged(trackId: string, param: string, value: number) {
  const t = store.project.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const hasLane = !!t.automation?.some((l) => l.param === param && l.points.length);
  const writing = store.ui.autoWrite && engine.playing;
  if (!writing && (!hasLane || engine.playing)) return;
  const beat = Math.max(0, engine.playing ? engine.beat : engine.beat);
  const key = `${trackId}|${param}`;
  const from = writing ? lastWrite.get(key) : undefined;
  store.update((p) => {
    const r = laneOf(p, trackId, param, true)!;
    const lo = from !== undefined && from < beat ? from : beat - 0.01;
    r.lane.points = r.lane.points.filter((pt) => pt.beat <= lo || pt.beat > beat + 0.02);
    r.lane.points.push({ beat, value });
    sortLane(r.lane);
  });
  if (writing) lastWrite.set(key, beat);
}
/** New write pass (transport started / stopped). */
export const resetLatch = () => lastWrite.clear();
