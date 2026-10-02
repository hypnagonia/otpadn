/**
 * Groove for pitched parts: 16th swing, role-based velocity with accent depth, a "feel" amount
 * (laid-back line, one correlated drift value per bar — not per-note jitter) and a chord roll
 * for keys (low → high spread). Each control moves one dimension only.
 */
import { rand2 } from "../drumproducer/rng";
import type { Mode, PEvent, Style } from "./types";

const stepOf = (b: number) => {
  const x = (b - Math.floor(b / 4 + 1e-9) * 4) * 4;
  const r = Math.round(x);
  return Math.abs(x - r) < 0.08 ? r % 16 : -1;
};
const ROLE = (s: number) => (s < 0 || s % 2 ? 0.66 : s % 8 === 0 ? 1 : s % 4 === 0 ? 0.9 : 0.8);

export function groovePart(events: PEvent[], g: { swing: number; accent: number; feel: number; spread: number }, mode: Mode, style: Style, seed: number, spb: number, length: number): PEvent[] {
  const sw = 0.5 + Math.max(0, Math.min(1, g.swing)) * 0.25;
  const accent = Math.max(0, Math.min(1, g.accent));
  const shaped = events.map((e) => {
    if (e.locked) return e.vel;
    const target = ROLE(stepOf(e.start)) * 112;
    return e.vel + (target - e.vel) * (e.src ? 0.3 : 0.6);
  });
  const free = events.filter((e) => !e.locked);
  const mean = free.length ? free.reduce((s, e) => s + shaped[events.indexOf(e)], 0) / free.length : 90;
  // chord roll order: rank within each onset cluster by pitch
  const rank = new Map<PEvent, number>();
  if (mode === "keys" && style !== "stabs" && style !== "arp") {
    const byStart = new Map<number, PEvent[]>();
    for (const e of free) {
      const k = Math.round(e.start * 48);
      (byStart.get(k) ?? byStart.set(k, []).get(k)!).push(e);
    }
    for (const cl of byStart.values()) cl.sort((a, b) => a.pitch - b.pitch).forEach((e, i) => rank.set(e, i));
  }
  return events.map((e, i) => {
    if (e.locked) return e;
    const s = stepOf(e.start);
    const bar = Math.floor(e.start / 4 + 1e-9);
    let ms = 0;
    if (mode === "line") ms += (s % 2 === 1 || s % 4 === 2 ? 6 : 2) * g.feel; // a sung line sits a little behind
    ms += rand2(seed, "drift", bar) * 4 * g.feel;
    ms += (rank.get(e) ?? 0) * 22 * g.spread;
    const swing = s >= 0 && s % 2 === 1 ? (sw - 0.5) * 0.5 : 0;
    let micro = e.micro + swing + ms / 1000 / spb;
    if (e.start + micro < 0) micro = -e.start;
    if (e.start + micro >= length) micro = length - e.start - 1e-3;
    const vel = Math.max(1, Math.min(127, Math.round(mean + (shaped[i] - mean) * (0.3 + 1.4 * accent))));
    return { ...e, micro, vel };
  });
}
