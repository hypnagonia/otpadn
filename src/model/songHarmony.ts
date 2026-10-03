/**
 * The harmony layer for the current project, cached for UI drawing (chord lane, piano roll /
 * tab chord names). Recomputed when the project changes, at most every 400 ms — while notes are
 * being dragged the previous picture is shown, then the fresh one triggers a redraw.
 */
import { harmonyOf, type Harmony } from "../analysis/harmonyLayer";
import { store } from "./store";

let cache: { v: number; h: Harmony | null; t: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function compute(): Harmony | null {
  let h: Harmony | null = null;
  try {
    const p = store.project;
    const anything = p.tracks.some((t) => t.kind === "midi" && t.role !== "drums") || !!p.harmonyAudio || p.chords.length > 0;
    h = anything ? harmonyOf(p) : null;
  } catch (e) {
    console.warn("harmony layer:", e);
  }
  cache = { v: store.projectVersion, h, t: performance.now() };
  return h;
}

export function songHarmony(): Harmony | null {
  if (cache && cache.v === store.projectVersion) return cache.h;
  if (cache && performance.now() - cache.t < 400) {
    timer ??= setTimeout(() => {
      timer = null;
      compute();
      store.setUi({}); // redraw with the fresh chords
    }, 400);
    return cache.h;
  }
  return compute();
}
