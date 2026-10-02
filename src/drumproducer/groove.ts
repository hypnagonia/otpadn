/**
 * Groove profile: swing, per-voice/per-position micro-timing, one correlated drift value per
 * voice and bar (variation between repeats — not independent per-note jitter), role-based
 * velocity with an accent-depth control. Each parameter touches one dimension only:
 * swing/micro → timing, accent → velocity.
 */
import { barOf, stepOf } from "./analyze";
import { rand2 } from "./rng";
import { STYLES, type Role } from "./styles";
import type { DEvent, GrooveParams, Style } from "./types";

function roleOf(e: DEvent, step: number): Role {
  if (e.tags?.includes("ghost")) return "ghost";
  if (step < 0 || step % 2 === 1) return "s16";
  if ((e.voice === "snare" || e.voice === "clap") && (step === 4 || step === 12)) return "back";
  if (step === 0 || step === 8) return "down";
  if (step % 4 === 0) return "quarter";
  return "off8";
}

export interface GrooveInput {
  events: DEvent[];
  groove: GrooveParams;
  style: Style;
  energy: number;
  seed: number;
  spb: number;
  lengthBeats: number;
  /** Swing measured in the source (0.5 = straight), removed from residual timing before re-swinging. */
  sourceSwing: number | null;
}

export function applyGroove({ events, groove, style, energy, seed, spb, lengthBeats, sourceSwing }: GrooveInput): DEvent[] {
  const st = STYLES[style];
  const sw = 0.5 + Math.max(0, Math.min(1, groove.swing)) * 0.25;
  const microAmt = Math.max(0, Math.min(1, groove.micro)) * 2; // 0.5 → style default
  const accent = Math.max(0, Math.min(1, groove.accent));
  const srcSwingDelay = sourceSwing && sourceSwing > 0.5 ? (sourceSwing - 0.5) * 0.5 : 0;

  // Shape toward the style's role velocities: fully for generated hits, lightly for source hits.
  const shaped = events.map((e) => {
    if (e.locked) return e.vel;
    const s = stepOf(e.start, 0.02);
    let target = st.roleVel[roleOf(e, s)];
    if (st.accentCycle?.voices.includes(e.voice) && s >= 0) target *= st.accentCycle.cycle[(barOf(e.start) + s) % st.accentCycle.cycle.length];
    target *= 0.88 + 0.12 * energy;
    const w = e.src ? 0.35 : 1;
    return e.vel + (target * 127 - e.vel) * w;
  });
  // Accent depth: expand/compress around each voice's mean.
  const mean = new Map<string, { s: number; n: number }>();
  events.forEach((e, i) => {
    if (e.locked || e.tags?.includes("ghost")) return;
    const m = mean.get(e.voice) ?? { s: 0, n: 0 };
    m.s += shaped[i];
    m.n++;
    mean.set(e.voice, m);
  });

  return events.map((e, i) => {
    if (e.locked) return e;
    const s = stepOf(e.start, 0.02);
    const bar = barOf(e.start);
    const off = s >= 0 && s % 2 === 1;
    const swing = off ? (sw - 0.5) * 0.5 : 0;
    const [on16, off16] = st.micro[e.voice] ?? [0, 0];
    const ms = (off ? off16 : on16) * microAmt + rand2(seed, "drift", e.voice, bar) * (st.drift[e.voice] ?? 0) * microAmt;
    const human = e.src ? (e.micro - (off ? srcSwingDelay : 0)) * 0.5 : 0;
    let micro = swing + ms / 1000 / spb + human;
    if (e.start + micro < 0) micro = -e.start;
    if (e.start + micro >= lengthBeats) micro = Math.min(micro, lengthBeats - e.start - 1e-3);
    const m = mean.get(e.voice);
    const mu = m ? m.s / m.n : shaped[i];
    let vel = e.tags?.includes("ghost") ? Math.min(55, shaped[i]) : mu + (shaped[i] - mu) * (0.3 + 1.4 * accent);
    vel = Math.max(1, Math.min(127, Math.round(vel)));
    return { ...e, micro, vel };
  });
}
