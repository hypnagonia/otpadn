/**
 * "Rework": develop the (cleaned) part toward house or techno. Hybrid engine:
 *  1. authored layer patterns (styles.ts), chosen by similarity to the source + style/energy fit;
 *  2. anchors: source events kept by "preserve" (repetition, velocity, metric weight, character);
 *  3. density held at the source level (× user density), never raised automatically;
 *  4. phrase development: bounded fills / variations at 4/8/16-bar phrase ends, never on every repeat.
 * Three variants (close / moderate / free). Every random choice is keyed on its layer seed, so one
 * layer can be regenerated without touching the others.
 */
import { barOf, BEATS_PER_BAR, occupancy, STEP, stepOf, STEPS } from "./analyze";
import { pick, rand, rand2 } from "./rng";
import { STYLES, SYMBOL_WEIGHT, VOICE_DUR, type LayerPattern, type PhraseMove } from "./styles";
import { VOICE_INFO, type Analysis, type DEvent, type GrooveParams, type Layer, type ReworkParams, type Variant, type Voice } from "./types";

export const VARIANTS = [
  { name: "close", preserve: (p: number) => Math.max(p, 0.8), alpha: 0.2, fillScale: 0.5, jitter: 0.08 },
  { name: "moderate", preserve: (p: number) => p, alpha: 0.5, fillScale: 1, jitter: 0.2 },
  { name: "free", preserve: (p: number) => p * 0.45, alpha: 0.85, fillScale: 1.25, jitter: 0.3 },
] as const;

const FAM: Record<Voice, string> = {
  kick: "kick", snare: "back", clap: "back", rim: "rim", hhc: "ch", hhp: "ch", hho: "oh", ride: "ride", shaker: "shaker",
  crash: "crash", tomL: "tom", tomM: "tom", tomH: "tom", perc: "perc",
};

const SUBSTITUTE: Partial<Record<Voice, Voice[]>> = {
  snare: ["clap", "rim"], clap: ["snare", "rim"], rim: ["perc", "snare"], hho: ["hhc", "ride", "shaker"], hhc: ["hhp", "shaker", "hho"],
  perc: ["rim", "tomM", "tomL"], tomL: ["tomM", "perc"], tomM: ["tomL", "perc"], ride: ["hho", "hhc"],
};

type Ext = DEvent & { prio?: number; score?: number };

export interface ReworkInput {
  base: DEvent[];
  analysis: Omit<Analysis, "mapping" | "mappingStatus">;
  params: ReworkParams;
  groove: GrooveParams;
  layerSeeds: Record<Layer, number>;
  locks: { voices: Voice[]; events: DEvent[] };
  lengthBeats: number;
}

function similarity(c: LayerPattern, occ: ReturnType<typeof occupancy>): number {
  const P = new Map<string, Float32Array>(), S = new Map<string, Float32Array>();
  const vec = (m: Map<string, Float32Array>, k: string) => m.get(k) ?? m.set(k, new Float32Array(STEPS)).get(k)!;
  for (const [v, str] of Object.entries(c.voices) as [Voice, string][])
    for (let s = 0; s < STEPS; s++) if (str[s] !== ".") vec(P, FAM[v])[s] = Math.max(vec(P, FAM[v])[s], SYMBOL_WEIGHT[str[s]]);
  for (const [v, o] of occ) for (let s = 0; s < STEPS; s++) vec(S, FAM[v])[s] = Math.max(vec(S, FAM[v])[s], o.freq[s]);
  if (!S.size) return 0.5;
  let dot = 0, na = 0, nb = 0;
  for (const k of new Set([...P.keys(), ...S.keys()])) {
    const a = P.get(k), b = S.get(k);
    for (let s = 0; s < STEPS; s++) {
      const x = a?.[s] ?? 0, y = b?.[s] ?? 0;
      dot += x * y; na += x * x; nb += y * y;
    }
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Bars of the source that differ strongly from its typical bar (likely the source's own fills). */
function sourceFillBars(base: DEvent[], completeBars: number): Set<number> {
  const out = new Set<number>();
  if (completeBars < 4) return out;
  const sets: Set<string>[] = Array.from({ length: completeBars }, () => new Set());
  for (const e of base) {
    const b = barOf(e.start), s = stepOf(e.start, 0.25);
    if (b < completeBars) sets[b].add(`${FAM[e.voice]}:${s}`);
  }
  const count = new Map<string, number>();
  for (const s of sets) for (const k of s) count.set(k, (count.get(k) ?? 0) + 1);
  const mode = new Set([...count].filter(([, c]) => c / completeBars >= 0.5).map(([k]) => k));
  sets.forEach((s, b) => {
    if (!s.size) return;
    let inter = 0;
    for (const k of s) if (mode.has(k)) inter++;
    const union = s.size + mode.size - inter;
    if (union && 1 - inter / union > 0.45) out.add(b);
  });
  return out;
}

/** Repeat complete source bars to an explicitly requested longer length (or cut to a shorter one). */
function tile(base: DEvent[], srcLen: number, outLen: number, completeBars: number): DEvent[] {
  if (outLen <= srcLen + 1e-9) return base.filter((e) => e.start < outLen);
  const period = completeBars > 0 ? completeBars * BEATS_PER_BAR : srcLen;
  const first = base.filter((e) => e.start < period);
  const out: DEvent[] = [...first];
  for (let r = 1; r * period < outLen; r++)
    for (const e of first) {
      const at = e.start + r * period;
      if (at < outLen) out.push({ ...e, id: `${e.id}@${r}`, start: at, tags: [...(e.tags ?? []), "tiled"] });
    }
  return out;
}

export function rework(inp: ReworkInput): { variants: Variant[]; lengthBeats: number } {
  const { base, analysis, params, groove, layerSeeds, locks } = inp;
  const style = STYLES[params.style];
  const srcLen = inp.lengthBeats;
  const outLen = params.length === "source" ? srcLen : params.length * BEATS_PER_BAR;
  const completeSrc = analysis.completeBars;
  const tiled = tile(base, srcLen, outLen, completeSrc);
  const outBars = Math.ceil(outLen / BEATS_PER_BAR - 1e-9);
  const outComplete = Math.floor(outLen / BEATS_PER_BAR + 1e-9);
  const lockedVoices = new Set(locks.voices);
  const pins = locks.events.filter((e) => !e.id.startsWith("s") && e.start < outLen).map((e) => ({ ...e, locked: true }));
  const factor = Math.pow(2, Math.max(-1, Math.min(1, groove.density)));
  const energy = params.energy;
  const srcFills = sourceFillBars(base, completeSrc);
  const isFixed = (e: DEvent) => !!e.locked || lockedVoices.has(e.voice);

  const variants = VARIANTS.map((conf, k): Variant => {
    const P = Math.max(0, Math.min(1, conf.preserve(params.preserve)));
    const patterns: Partial<Record<Layer, string>> = {};
    let out: Ext[] = [];

    for (const L of ["foundation", "motion", "perc"] as const) {
      const seedL = layerSeeds[L];
      const src = tiled.filter((e) => VOICE_INFO[e.voice].layer === L);
      if (!src.length && !params.addLayers[L]) continue;
      const fixed = src.filter(isFixed);
      const free = src.filter((e) => !isFixed(e));
      const occ = occupancy(base.filter((e) => VOICE_INFO[e.voice].layer === L), completeSrc);

      // 1. pattern choice: similarity to the source vs. style/energy fit, + seeded variety
      let best = style.layers[L][0], bestScore = -Infinity;
      for (const c of style.layers[L]) {
        const sc = (1 - conf.alpha) * similarity(c, occ) + conf.alpha * (1 - Math.abs(c.energy - energy)) + conf.jitter * rand(seedL, k, L, c.name);
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      patterns[L] = best.name;

      // 2. anchors
      const scoreOf = (e: DEvent) => {
        const s = stepOf(e.start, 0.25);
        const f = s >= 0 ? occ.get(e.voice)?.freq[s] ?? 0 : 0;
        const metric = (e.voice === "kick" && s % 4 === 0) || ((e.voice === "snare" || e.voice === "clap") && (s === 4 || s === 12)) ? 0.25 : 0;
        const character = e.tags?.some((t) => t === "flam" || t === "roll" || t === "figure") || s < 0 ? 0.15 : 0;
        return 0.55 * f + 0.3 * (e.vel / 127) + metric + character;
      };
      const scored: Ext[] = free.map((e) => ({ ...e, score: scoreOf(e) }));
      const kept = P >= 0.999 ? scored : scored.filter((e) => e.score! + 0.1 * rand2(seedL, k, "keep", e.id) >= 1 - P);
      const keptSet = new Set(kept);

      // 3. template hits not already covered by an anchor of the same family
      const anchorsNear = (v: Voice, at: number) => fixed.some((e) => FAM[e.voice] === FAM[v] && Math.abs(e.start - at) < 0.13) || kept.some((e) => FAM[e.voice] === FAM[v] && Math.abs(e.start - at) < 0.13);
      const tmpl: Ext[] = [];
      const patternHits = Object.values(best.voices).reduce((a, s) => a + [...s!].filter((c) => c !== ".").length, 0);
      for (let b = 0; b < outBars; b++)
        for (const [v, str] of Object.entries(best.voices) as [Voice, string][]) {
          if (lockedVoices.has(v)) continue;
          for (let s = 0; s < STEPS; s++) {
            const w = SYMBOL_WEIGHT[str[s]];
            if (!w) continue;
            const at = b * BEATS_PER_BAR + s * STEP;
            if (at >= outLen - 1e-9 || anchorsNear(v, at)) continue;
            tmpl.push({ id: `g:${v}:${b}:${s}`, voice: v, start: at, micro: 0, vel: Math.round(127 * w * (0.85 + 0.15 * energy)), dur: VOICE_DUR[v] ?? 0.25, origin: "generated", layer: L, prio: w, tags: w <= 0.35 ? ["ghost"] : undefined });
          }
        }

      // 4. density: per bar, stay at the source count (× the user's density factor)
      const avg = analysis.density[L] || patternHits;
      for (let b = 0; b < outBars; b++) {
        const lo = b * BEATS_PER_BAR, hi = lo + BEATS_PER_BAR;
        const inB = (e: DEvent) => e.start >= lo - 1e-9 && e.start < hi - 1e-9;
        const barFrac = Math.min(1, (outLen - lo) / BEATS_PER_BAR);
        const fixedB = fixed.filter(inB);
        const srcB = src.filter(inB).length;
        const basis = src.length ? srcB + (avg * barFrac - srcB) * (1 - P) : avg * barFrac;
        const target = Math.max(fixedB.length, Math.round(basis * factor));
        let items: Ext[] = [...fixedB, ...kept.filter(inB), ...tmpl.filter(inB)];
        if (items.length > target) {
          const removable = items
            .filter((e) => !isFixed(e))
            .sort((a, b2) => {
              const ka = a.origin === "generated" ? a.prio! : 2 + a.score!;
              const kb = b2.origin === "generated" ? b2.prio! : 2 + b2.score!;
              return ka - kb || rand(seedL, k, "trim", a.id) - rand(seedL, k, "trim", b2.id);
            });
          const drop = new Set(removable.slice(0, items.length - target));
          items = items.filter((e) => !drop.has(e));
        } else if (items.length < target) {
          const free2: Ext[] = scored.filter((e) => inB(e) && !keptSet.has(e)).sort((a, b2) => b2.score! - a.score!);
          const extras: Ext[] = [];
          const voicesHere = new Set([...items, ...src].map((e) => e.voice));
          for (const [v, str] of Object.entries(style.extra) as [Voice, string][]) {
            if (VOICE_INFO[v].layer !== L || lockedVoices.has(v) || (!voicesHere.has(v) && !best.voices[v])) continue;
            for (let s = 0; s < STEPS; s++) {
              const w = SYMBOL_WEIGHT[str[s]];
              const at = lo + s * STEP;
              if (!w || at >= outLen - 1e-9) continue;
              extras.push({ id: `x:${v}:${b}:${s}`, voice: v, start: at, micro: 0, vel: Math.round(127 * w * (0.85 + 0.15 * energy)), dur: VOICE_DUR[v] ?? 0.25, origin: "generated", layer: L, prio: w, tags: w <= 0.35 ? ["ghost"] : undefined });
            }
          }
          extras.sort((a, b2) => b2.prio! - a.prio! || rand(seedL, k, "extra", a.id) - rand(seedL, k, "extra", b2.id));
          for (const e of [...free2, ...extras]) {
            if (items.length >= target) break;
            if (items.some((o) => o.voice === e.voice && Math.abs(o.start - e.start) < 0.06)) continue;
            items.push(e);
          }
        }
        out.push(...items);
      }
    }

    // 5. phrase development
    let fills = 0;
    const seedP = layerSeeds.phrase;
    const present = () => new Set(out.map((e) => e.voice));
    const sub = (v: Voice, pres: Set<Voice>): Voice | null => {
      if (pres.has(v)) return v;
      return SUBSTITUTE[v]?.find((x) => pres.has(x)) ?? null;
    };
    const applyMove = (m: PhraseMove, bar: number) => {
      const bs = bar * BEATS_PER_BAR;
      const from = bs + m.clearFrom * STEP, end = bs + BEATS_PER_BAR;
      const pres = present();
      out = out.filter((e) => !(m.clear.includes(e.voice) && e.start >= from - 1e-9 && e.start < end && !isFixed(e)));
      let added = 0;
      for (const a of m.add) {
        const v = sub(a.voice, pres);
        if (!v || lockedVoices.has(v)) continue;
        const at = bs + a.step * STEP;
        if (at >= outLen || out.some((e) => e.voice === v && Math.abs(e.start - at) < 0.06)) continue;
        out.push({ id: `f:${v}:${bar}:${a.step}`, voice: v, start: at, micro: 0, vel: Math.max(1, Math.min(127, Math.round(127 * a.w * (0.8 + 0.2 * energy)))), dur: VOICE_DUR[v] ?? 0.25, origin: "fill", layer: "phrase", tags: ["fill", m.name] });
        added++;
      }
      return added > 0 || m.clear.length > 0;
    };
    const phraseLen = outComplete >= 8 ? 8 : outComplete >= 4 ? 4 : 0;
    if (phraseLen) {
      let prevHad = false;
      for (let b = phraseLen - 1; b < outComplete; b += phraseLen) {
        const srcBar = completeSrc ? b % completeSrc : b;
        if (srcFills.has(srcBar) && P >= 0.4) {
          // The source has its own fill here: restore it instead of writing one.
          const lo = b * BEATS_PER_BAR, hi = lo + BEATS_PER_BAR;
          out = out.filter((e) => isFixed(e) || !(e.start >= lo && e.start < hi));
          for (const e of tiled) if (e.start >= lo && e.start < hi && !out.some((o) => o.id === e.id)) out.push({ ...e, tags: [...(e.tags ?? []), "source fill"] });
          prevHad = true;
          continue;
        }
        const big = outComplete >= 16 && (b + 1) % 16 === 0;
        let p = groove.fills * conf.fillScale * (outComplete >= 16 ? (big ? 1.3 : 0.75) : 1);
        if (prevHad) p *= 0.35;
        if (b > 0 && rand(seedP, k, "fill", b) < p) {
          const m = pick(style.fills, style.fills.map((f) => f.weight), rand(seedP, k, "type", b));
          prevHad = applyMove(m, b);
          if (prevHad) fills++;
        } else prevHad = false;
        if (phraseLen >= 8) {
          const vb = b - phraseLen / 2;
          if (vb > 0 && rand(seedP, k, "var", vb) < groove.fills * 0.5 * conf.fillScale) {
            const m = pick(style.variations, style.variations.map((f) => f.weight), rand(seedP, k, "vtype", vb));
            if (applyMove(m, vb)) fills++;
          }
        }
      }
    }

    // 6. pinned (locked) generated events win over anything at their spot
    for (const pin of pins) {
      out = out.filter((e) => isFixed(e) || !(e.voice === pin.voice && Math.abs(e.start - pin.start) < 0.06));
      if (!out.some((e) => e.id === pin.id)) out.push(pin);
    }

    const events: DEvent[] = out
      .map(({ prio: _p, score: _s, ...e }) => e)
      .sort((a, b) => a.start + a.micro - (b.start + b.micro) || a.voice.localeCompare(b.voice));
    const ids = new Set(events.map((e) => e.id));
    const dropped = tiled.filter((e) => !ids.has(e.id));
    const kept = events.filter((e) => e.src).length;
    return {
      name: conf.name,
      events,
      dropped,
      stats: { events: events.length, kept, generated: events.length - kept, fills, perBar: Math.round((events.length / Math.max(1, outLen / BEATS_PER_BAR)) * 10) / 10, patterns },
    };
  });
  return { variants, lengthBeats: outLen };
}
