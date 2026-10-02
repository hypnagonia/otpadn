/**
 * Automation: lanes of breakpoints (beats → value) per track.
 *  - volume / pan / reverb send / bus sends: scheduled sample-accurately on the strip's AudioParams
 *    (live from the play position, offline over the whole bounce), interpolated in the
 *    parameter's own units (dB for levels → even-sounding fades) by ≤ 30 ms ramp steps
 *  - plug-in parameters: control rate (scheduler tick live, ~50 ms slices offline)
 */
import type { AutoLane, AutoPoint, Track } from "../model/types";
import { PLUGINS, type Insert, type ParamSpec } from "../plugins/defs";

export interface AutoTarget { param: AudioParam; map: (v: number) => number }

/** Value of a lane at a beat: linear between points, held before the first / after the last. */
export function laneValue(points: AutoPoint[], beat: number): number {
  if (!points.length) return 0;
  if (beat <= points[0].beat) return points[0].value;
  const last = points[points.length - 1];
  if (beat >= last.beat) return last.value;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (points[m].beat <= beat) lo = m;
    else hi = m;
  }
  const a = points[lo], b = points[hi];
  return a.value + ((b.value - a.value) * (beat - a.beat)) / Math.max(1e-9, b.beat - a.beat);
}

/**
 * Schedule a lane on its targets: value at `fromBeat` at context time `t0`, then the curve until
 * `toBeat`. Anything already scheduled after t0 is replaced.
 */
export function scheduleLane(lane: AutoLane, targets: AutoTarget[], fromBeat: number, toBeat: number, t0: number, spb: number) {
  const pts = lane.points;
  for (const { param, map } of targets) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(map(laneValue(pts, fromBeat)), t0);
  }
  if (!pts.length) return;
  const STEP = 0.03; // s
  let b = fromBeat;
  for (const p of pts) {
    if (p.beat <= b) continue;
    const end = Math.min(p.beat, toBeat);
    const v0 = laneValue(pts, b), v1 = laneValue(pts, end);
    const n = v0 === v1 ? 1 : Math.max(1, Math.ceil(((end - b) * spb) / STEP));
    for (let i = 1; i <= n; i++) {
      const bb = b + ((end - b) * i) / n, v = v0 + ((v1 - v0) * i) / n;
      for (const { param, map } of targets) param.linearRampToValueAtTime(map(v), t0 + (bb - fromBeat) * spb);
    }
    b = end;
    if (b >= toBeat) break;
  }
}

/** Set targets to the lane's value at a beat (transport stopped / seek). */
export function holdLane(lane: AutoLane, targets: AutoTarget[], beat: number, now: number) {
  const v = laneValue(lane.points, beat);
  for (const { param, map } of targets) {
    param.cancelScheduledValues(now);
    param.setTargetAtTime(map(v), now, 0.01);
  }
}

export const isPluginLane = (param: string) => param.startsWith("ins:");
export const lanesOf = (t: Track) => (t.automation ?? []).filter((l) => l.points.length);

/** Plug-in parameter values from automation at a beat: insertId → partial params. */
export function pluginAutomation(t: Track, beat: number): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const l of lanesOf(t)) {
    if (!isPluginLane(l.param)) continue;
    const [, id, key] = l.param.split(":");
    const o = out.get(id) ?? {};
    o[key] = laneValue(l.points, beat);
    out.set(id, o);
  }
  return out;
}

/* ── parameter catalogue (UI: names, ranges, value ↔ 0…1 position) ────────────────────────── */

export interface AutoParamInfo { param: string; label: string; min: number; max: number; unit: string; log?: boolean; def: number }

export function automatableParams(t: Track, busName: (id: string) => string): AutoParamInfo[] {
  const out: AutoParamInfo[] = [
    { param: "volume", label: "volume", min: -60, max: 6, unit: "dB", def: t.ch.volumeDb },
    { param: "pan", label: "pan", min: -1, max: 1, unit: "", def: t.ch.pan },
  ];
  if (t.kind !== "bus") {
    out.push({ param: "verb", label: "reverb send", min: 0, max: 1, unit: "", def: t.ch.reverbSend });
    out.push({ param: "dly", label: "delay send", min: 0, max: 1, unit: "", def: t.ch.delaySend ?? 0 });
    for (const sd of t.ch.sends ?? []) out.push({ param: `send:${sd.id}`, label: `send · ${busName(sd.bus)}`, min: -60, max: 6, unit: "dB", def: sd.level });
  }
  for (const ins of t.inserts ?? []) {
    const def = PLUGINS[ins.type];
    for (const ps of def.params as ParamSpec[]) {
      if (ps.hidden || ps.options) continue;
      out.push({ param: `ins:${ins.id}:${ps.key}`, label: `${def.short} · ${ps.label}`, min: ps.min, max: ps.max, unit: ps.unit ?? "", log: ps.log, def: ins.params[ps.key] ?? ps.def });
    }
  }
  return out;
}

/** Value ↔ vertical position (0 bottom … 1 top). Levels use a fader-like curve, log params log. */
export function toPos(info: AutoParamInfo, v: number): number {
  if (info.unit === "dB" && info.min <= -40) return Math.pow(Math.max(0, (v - info.min) / (info.max - info.min)), 2.2);
  if (info.log && info.min > 0) return Math.log(v / info.min) / Math.log(info.max / info.min);
  return (v - info.min) / (info.max - info.min);
}
export function fromPos(info: AutoParamInfo, pos: number): number {
  const q = Math.max(0, Math.min(1, pos));
  if (info.unit === "dB" && info.min <= -40) return info.min + Math.pow(q, 1 / 2.2) * (info.max - info.min);
  if (info.log && info.min > 0) return info.min * Math.pow(info.max / info.min, q);
  return info.min + q * (info.max - info.min);
}

export const insertOfLane = (param: string, inserts: Insert[]) => inserts.find((i) => i.id === param.split(":")[1]);
