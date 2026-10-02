/**
 * "Rework" for pitched parts, three variants (close / moderate / free):
 *  keys   — comp (your rhythm, voice-led re-voicing), house stabs (anticipated rootless 9ths),
 *           pad (sustained voice-led chords), arp (pattern over the voicing);
 *  line   — faithful / tight / hook: legato, ornament merging, unified repeated phrases, in-key;
 *  guitar — faithful (made playable on six strings), strum, fingerpick, power.
 * Rhythm patterns are chosen by similarity to the source; anchors keep the source's strongest hits
 * by "preserve"; every random choice is keyed on its layer seed (rhythm / voicing / phrase).
 */
import { rand, pick } from "../drumproducer/rng";
import { chordAt, chordPcs, scalePcs, type PartSection } from "./harmony";
import { ARPS, CHART_KEYS, CHART_STRUMS, COMP, hitSteps, PICKS, POWER, STABS, STRUMS, tierOf, TURN_KEYS, TURN_STRUM, WEIGHT, type Tier } from "./patterns";
import { guitarShapes, keyVoicings, pickShape, pickVoicing, powerShape, TUNING, type KeyOpts, type Shape } from "./voicing";
import type { Chord, Mode, PEvent, Style, Variant } from "./types";
import { detectStrums, type StrumDir } from "./strum";

export const VARIANTS = [
  { name: "close", P: (p: number) => Math.max(p, 0.85), alpha: 0.2, jitter: 0.05, fill: 0.5, k: 0.5 },
  { name: "moderate", P: (p: number) => p, alpha: 0.5, jitter: 0.15, fill: 1, k: 1 },
  { name: "free", P: (p: number) => p * 0.4, alpha: 0.85, jitter: 0.35, fill: 1.25, k: 1.3 },
] as const;

export interface ReworkIn {
  base: PEvent[];
  mode: Mode;
  style: Style;
  preserve: number;
  chords: Chord[];
  key: { tonic: number; minor: boolean };
  length: number;
  completeBars: number; // of the source, for rhythm statistics
  seeds: { rhythm: number; voicing: number; phrase: number };
  variation: number;
  locks: PEvent[];
  spb: number;
  /** Prefer open shapes (acoustic sounds). */
  openShapes: boolean;
  /** Bass: kick-drum onsets in the region (beats). */
  kicks?: number[];
  /** Song sections (relative beats) — the "song chart" styles pick patterns per section. */
  sections?: PartSection[];
}

interface Hit { start: number; dur: number; vel: number; src?: PEvent[]; c?: string; dir?: StrumDir; spreadMs?: number }

const STEP = 0.25;
const stepIn = (b: number) => Math.round((b - Math.floor(b / 4 + 1e-9) * 4) / STEP) % 16;

function clusters(evs: PEvent[]): Hit[] {
  const s = [...evs].sort((a, b) => a.start - b.start);
  const out: Hit[] = [];
  for (const e of s) {
    const last = out[out.length - 1];
    if (last && e.start - last.start < 0.06) {
      last.src!.push(e);
      last.dur = Math.max(last.dur, e.dur);
      last.vel = Math.max(last.vel, e.vel);
    } else out.push({ start: e.start, dur: e.dur, vel: e.vel, src: [e] });
  }
  return out;
}

function occupancy(hits: Hit[], bars: number) {
  const occ = new Float32Array(16);
  if (!bars) return occ;
  const seen = new Set<string>();
  for (const h of hits) {
    const b = Math.floor(h.start / 4 + 1e-9);
    if (b >= bars) continue;
    const s = stepIn(h.start), k = `${b}:${s}`;
    if (seen.has(k)) continue;
    seen.add(k);
    occ[s] += 1 / bars;
  }
  return occ;
}

function similarity(steps: string, occ: Float32Array) {
  let dot = 0, na = 0, nb = 0;
  for (let s = 0; s < 16; s++) {
    const a = steps[s] !== "." && steps[s] !== "-" ? 1 : 0, b = occ[s];
    dot += a * b; na += a * a; nb += b * b;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0.4;
}

function choose<T extends { name: string; steps?: string }>(list: T[], occ: Float32Array, alpha: number, jitter: number, seed: number, k: number, tag: string): T {
  let best = list[0], bs = -Infinity;
  for (const p of list) {
    const sim = p.steps ? similarity(p.steps, occ) : 0.5;
    const sc = (1 - alpha) * sim + alpha * 0.5 + jitter * 2 * rand(seed, k, tag, p.name);
    if (sc > bs) { bs = sc; best = p; }
  }
  return best;
}

const KEY_OPTS: Record<string, KeyOpts & { center: number }> = {
  chart: { lo: 55, hi: 79, color: "plain", maxSpan: 14, center: 66 }, // right hand; the left hand plays the bass
  comp: { lo: 48, hi: 79, color: "plain", maxSpan: 16, center: 62 },
  stabs: { lo: 55, hi: 84, color: "rootless9", maxSpan: 13, center: 69 },
  pad: { lo: 48, hi: 79, color: "add9", maxSpan: 24, double: true, center: 62 },
  arp: { lo: 52, hi: 76, color: "plain", maxSpan: 14, center: 62 },
};

export function reworkPart(inp: ReworkIn): Variant[] {
  const { base, mode, style, chords, spb } = inp;
  const free = base.filter((e) => !e.locked);
  const fixed = base.filter((e) => e.locked);
  // Guitar: a strum is one hit, with its direction and spread (see strum.ts); other modes: onset clusters.
  const srcHits: Hit[] = mode === "guitar"
    ? detectStrums(free, spb).strums.map((st) => ({ start: Math.min(...st.events.map((e) => e.start)), dur: Math.max(...st.events.map((e) => e.dur)), vel: st.vel, src: st.events, dir: st.dir, spreadMs: st.spreadMs }))
    : clusters(free);
  const occ = occupancy(srcHits, inp.completeBars);
  const bars = Math.ceil(inp.length / 4 - 1e-9);
  const completeOut = Math.floor(inp.length / 4 + 1e-9);
  const hitScore = (h: Hit) => 0.6 * occ[stepIn(h.start)] + 0.4 * (h.vel / 127);
  const pins = inp.locks.filter((e) => !e.id.startsWith("s") && e.start < inp.length).map((e) => ({ ...e, locked: true }));
  const voicingCache = new Map<string, number[][]>();

  return VARIANTS.map((conf, k): Variant => {
    const P = Math.max(0, Math.min(1, conf.P(inp.preserve)));
    let out: PEvent[] = [];
    let pattern: string | undefined;
    const patHits = (steps: string, holdDefault: (s: number) => number): Hit[] => {
      const hs: Hit[] = [];
      for (let b = 0; b < bars; b++)
        for (const s of hitSteps(steps)) {
          const at = b * 4 + s * STEP;
          if (at >= inp.length - 1e-9) continue;
          let hold = 1;
          while (steps[s + hold] === "-") hold++;
          const dur = steps[s + 1] === "-" ? hold * STEP - 0.03 : holdDefault(s);
          hs.push({ start: at, dur, vel: Math.round(110 * (WEIGHT[steps[s]] ?? 0.8)), c: steps[s] });
        }
      return hs;
    };
    /**
     * Song chart: one pattern per section energy tier — chosen to resemble the source's rhythm —
     * identical across repeats ("close": one per tier for the whole part; "moderate"/"free": per
     * section group; "free" also varies every 4th bar). The last bar of a section that leads into
     * a different one plays a turnaround whose final hit pushes the next chord.
     */
    const secs: PartSection[] = inp.sections?.length ? inp.sections : [{ start: 0, length: inp.length, label: "part", group: "A", energy: 2 }];
    const secAt = (beat: number) => secs.find((x) => beat >= x.start - 1e-9 && beat < x.start + x.length - 1e-9) ?? secs[secs.length - 1];
    const chartBars = <T extends { name: string; steps: string }>(lib: Record<Tier, T[]>, turn: T) => {
      const memo = new Map<string, T>();
      return (b: number) => {
        const at = b * 4, sec = secAt(at), tier = tierOf(sec.energy);
        const key = k === 0 ? tier : `${tier}:${sec.group}`;
        let p = memo.get(key) ?? memo.set(key, choose(lib[tier], occ, conf.alpha, conf.jitter, inp.seeds.rhythm, k, `chart:${key}`)).get(key)!;
        const inSec = Math.floor((at - sec.start) / 4 + 1e-9);
        if (k === 2 && inSec % 4 === 3) p = lib[tier][(lib[tier].indexOf(p) + 1) % lib[tier].length];
        const end = sec.start + sec.length, next = secs.find((x) => Math.abs(x.start - end) < 1e-6);
        if (k >= 1 && next && (next.group !== sec.group || next.energy !== sec.energy) && at < end - 1e-6 && at + 4 >= end - 1e-6) p = turn;
        return { p, scale: 0.82 + 0.07 * Math.min(3, sec.energy), first: Math.abs(at - sec.start) < 1e-6 };
      };
    };
    const anchors = (hits: Hit[], need: number) => srcHits.filter((h) => hitScore(h) + 0.1 * rand(inp.seeds.rhythm, k, "a", h.start) >= need && !hits.some((x) => Math.abs(x.start - h.start) < 0.13));

    /* ───── keys ───── */
    if (mode === "keys") {
      const o = { ...(KEY_OPTS[style] ?? KEY_OPTS.comp), scale: scalePcs(inp.key) };
      let hits: Hit[];
      if (style === "pad" || style === "arp") {
        pattern = style === "pad" ? "sustained" : undefined;
        hits = [];
        for (const c of chords) for (let a = c.start; a < c.start + c.length - 1e-9; a += 8) hits.push({ start: a, dur: Math.min(8, c.start + c.length - a) - 0.03, vel: 92 });
      } else if (style === "chart") {
        const plan = chartBars(CHART_KEYS, TURN_KEYS);
        const names = new Set<string>();
        hits = [];
        for (let b = 0; b < bars; b++) {
          const { p, scale, first } = plan(b);
          names.add(p.name);
          for (const s of hitSteps(p.steps)) {
            const at = b * 4 + s * STEP;
            if (at >= inp.length - 1e-9) continue;
            let hold = 1;
            while (p.steps[s + hold] === "-") hold++;
            const dur = p.steps[s + 1] === "-" ? hold * STEP - 0.03 : 0.9;
            hits.push({ start: at, dur, vel: Math.round(Math.min(124, 108 * (WEIGHT[p.steps[s]] ?? 0.8) * scale + (first && s === 0 ? 8 : 0))), c: p.steps[s] });
          }
        }
        // A held chord never rings over a chord change: it's re-struck (softer) on the change.
        for (const c of chords) {
          const h = hits.find((x) => x.start < c.start - 1e-6 && x.start + x.dur > c.start + 0.05);
          if (h && !hits.some((x) => Math.abs(x.start - c.start) < 1e-6)) {
            hits.push({ start: c.start, dur: h.start + h.dur - c.start, vel: Math.round(h.vel * 0.88), c: "x" });
            h.dur = c.start - h.start - 0.03;
          }
        }
        pattern = [...names].join(" / ");
      } else if (srcHits.length && ((style === "comp" && k < 2) || (style === "stabs" && k === 0))) {
        // comp keeps your rhythm (close + moderate); stabs "close" = your rhythm, played as short stabs
        hits = srcHits.map((h) => ({ ...h, dur: style === "stabs" ? Math.min(h.dur, 0.3) : h.dur }));
        pattern = "your rhythm";
      } else {
        const list = style === "stabs" ? STABS : COMP;
        const pat = choose(list, occ, conf.alpha, conf.jitter, inp.seeds.rhythm, k, style);
        pattern = pat.name;
        hits = patHits(pat.steps, () => (style === "stabs" ? 0.22 : 0.9));
        hits.push(...anchors(hits, 1 - P + (style === "stabs" ? 0.25 : 0)).map((h) => ({ ...h, dur: style === "stabs" ? 0.22 : h.dur })));
      }
      hits.sort((a, b) => a.start - b.start);
      // comp: durations run to the next hit (legato hands), clipped
      if (style === "comp" || style === "chart") hits.forEach((h, i) => { const n = hits[i + 1]; if (n) h.dur = Math.min(h.dur, n.start - h.start - 0.03); });
      let prev: number[] | null = null;
      for (const h of hits) {
        // Off-beat hits within half a beat before a chord change anticipate the next chord (house push).
        const next = chordAt(chords, h.start + 0.5);
        const cur = chordAt(chords, h.start);
        const c = next && cur && next !== cur && h.start % 1 >= 0.5 - 1e-9 && (style === "stabs" || style === "comp" || style === "chart") ? next : cur;
        if (!c) continue;
        if (style === "arp") {
          const vk = `arp:${c.root}:${c.q}`;
          const cands = voicingCache.get(vk) ?? voicingCache.set(vk, keyVoicings(c.root, c.q, o)).get(vk)!;
          const v = pickVoicing(cands, prev, { center: o.center }, inp.seeds.voicing, `${k}:${h.start}`, conf.jitter * 2);
          if (!v) continue;
          prev = v;
          const ext = [...v, ...v.map((p) => p + 12)];
          const arp = pick(ARPS, ARPS.map(() => 1), rand(inp.seeds.rhythm, k, "arp", Math.floor(h.start / 16)));
          pattern = `arp ${arp.name}`;
          let i = 0;
          for (let t = h.start; t < h.start + h.dur - 1e-9; t += STEP, i++) {
            const p = ext[arp.order[i % arp.order.length] % ext.length];
            const onBeat = Math.abs(t - Math.round(t)) < 1e-6;
            out.push({ id: `g:${Math.round(t * 48)}:${p}`, pitch: p, start: t, micro: 0, dur: 0.22, vel: onBeat ? 96 : 78, origin: "generated", tags: ["arp"] });
          }
          continue;
        }
        if (h.src && k === 0) {
          // close: keep the source chord if it already fits the harmony (9ths count as fitting)
          const ok = [...chordPcs(c), (c.root + 2) % 12];
          const fit = h.src.filter((e) => ok.includes(e.pitch % 12)).length / h.src.length;
          if (fit >= 1 - P * 0.5) {
            out.push(...h.src.map((e) => ({ ...e, tags: e.tags ? [...e.tags] : undefined })));
            prev = h.src.map((e) => e.pitch).sort((a, b) => a - b);
            continue;
          }
        }
        const vk = `${style}:${c.root}:${c.q}`;
        const cands = voicingCache.get(vk) ?? voicingCache.set(vk, keyVoicings(c.root, c.q, o)).get(vk)!;
        const top = h.src && k < 2 ? Math.max(...h.src.map((e) => e.pitch)) : undefined;
        const v = pickVoicing(cands, prev, { center: o.center, top }, inp.seeds.voicing, `${k}:${h.start}`, conf.jitter * 2);
        if (!v) continue;
        prev = v;
        v.forEach((p, i) => out.push({ id: `g:${Math.round(h.start * 48)}:${p}`, pitch: p, start: h.start, micro: 0, dur: Math.max(0.1, h.dur), vel: Math.max(1, Math.min(127, h.vel + (i === v.length - 1 ? 4 : -6))), origin: h.src ? "edited" : "generated", tags: h.src ? ["re-voiced"] : undefined }));
      }
      // Song chart: the left hand plays the root low (bar 1, plus beat 3 in busier sections, and on
      // every chord change), held until the next bass note.
      if (style === "chart") {
        const plan = chartBars(CHART_KEYS, TURN_KEYS);
        const at: number[] = [];
        for (let b = 0; b < bars; b++) {
          const tier = tierOf(secAt(b * 4).energy);
          at.push(b * 4);
          if (tier !== "low") at.push(b * 4 + 2);
        }
        for (const c of chords) at.push(c.start);
        const ts = [...new Set(at.map((x) => Math.round(x * 1000) / 1000))].filter((x) => x < inp.length - 1e-9).sort((a, b) => a - b);
        ts.forEach((t, i) => {
          const c = chordAt(chords, t);
          if (!c) return;
          const end = Math.min(ts[i + 1] ?? inp.length, inp.length);
          const pitch = 36 + ((c.root - 36 + 120) % 12);
          const { scale } = plan(Math.floor(t / 4 + 1e-9));
          out.push({ id: `g:${Math.round(t * 48)}:${pitch}`, pitch, start: t, micro: 0, dur: Math.max(0.1, end - t - 0.05), vel: Math.round((t % 4 === 0 ? 92 : 80) * scale), origin: "generated", tags: ["left hand"] });
        });
      }
    }

    /* ───── guitar ───── */
    if (mode === "guitar") {
      const spread = (ms: number) => ms / 1000 / spb;
      if (style === "faithful") {
        pattern = "your part";
        let prevFret = 3;
        for (const h of srcHits) {
          const notes = [...h.src!].sort((a, b) => a.pitch - b.pitch);
          const used = new Set<number>();
          const placed: PEvent[] = [];
          for (const e of notes) {
            let pitch = e.pitch;
            while (pitch > TUNING[5] + 15) pitch -= 12;
            while (pitch < TUNING[0]) pitch += 12;
            let best = -1, bc = Infinity;
            for (let s = 0; s < 6; s++) {
              const f = pitch - TUNING[s];
              if (used.has(s) || f < 0 || f > 15) continue;
              const cost = notes.length === 1 ? Math.abs(f - prevFret) + (f > 12 ? 2 : 0) : s; // chords: lowest free string; lines: stay in position
              if (cost < bc) { bc = cost; best = s; }
            }
            if (best < 0) continue;
            used.add(best);
            placed.push({ ...e, pitch, string: best, origin: pitch !== e.pitch ? "edited" : e.origin });
          }
          const fr = placed.map((e) => e.pitch - TUNING[e.string!]).filter((f) => f > 0);
          if (fr.length) prevFret = fr.reduce((a, b) => a + b, 0) / fr.length;
          // Hand-span check: drop the note farthest from the shape's centre until it fits 4 frets.
          while (placed.length > 1) {
            const fs = placed.map((e) => e.pitch - TUNING[e.string!]).filter((f) => f > 0);
            if (!fs.length || Math.max(...fs) - Math.min(...fs) <= 4) break;
            const mid = (Math.max(...fs) + Math.min(...fs)) / 2;
            placed.sort((a, b) => Math.abs(b.pitch - TUNING[b.string!] - mid) - Math.abs(a.pitch - TUNING[a.string!] - mid));
            placed.shift();
          }
          out.push(...placed);
        }
      } else {
        const list = style === "power" ? POWER : style === "strum" || style === "chart" ? STRUMS : PICKS.map((p) => ({ name: p.name, steps: p.roles.split("").map((c) => c + ".").join("") }));
        const plan = style === "chart" ? chartBars(CHART_STRUMS, TURN_STRUM) : null;
        const chartNames = new Set<string>();
        const pat = choose(list as { name: string; steps: string }[], occ, conf.alpha, conf.jitter, inp.seeds.rhythm, k, style);
        pattern = pat.name;
        let prevShape: Shape | null = null;
        const shapeAt = (beat: number) => {
          const c = chordAt(chords, beat);
          if (!c) return null;
          const s = style === "power" ? powerShape(c.root, prevShape?.pos ?? null) : pickShape(guitarShapes(c.root, c.q), prevShape, inp.openShapes, inp.seeds.voicing, `${k}:${c.start}`, conf.jitter * 3);
          if (s) prevShape = s;
          return s;
        };
        const emit = (start: number, strings: number[], shape: Shape, dur: number, vel: number, gapMs: number, tag: string) =>
          strings.forEach((s, i) => {
            const p = shape.pitches[s];
            if (p === null) return;
            out.push({ id: `g:${Math.round(start * 48)}:${s}`, pitch: p, start, micro: spread(gapMs * i), dur, vel: Math.max(1, Math.min(127, Math.round(vel * (1 - i * 0.03)))), origin: "generated", string: s, tags: [tag] });
          });
        const sounding = (sh: Shape) => sh.pitches.map((p, i) => (p === null ? -1 : i)).filter((i) => i >= 0);
        const anchorHits = style === "fingerpick" || plan ? [] : anchors([], 1 - P + 0.3).filter((h) => !hitSteps(pat.steps).includes(stepIn(h.start)));
        // "close" strum/power follows your rhythm: strokes on your onsets (down on 8ths, up between; accents by velocity)
        const own = k === 0 && style !== "fingerpick" && !plan && srcHits.length > 0;
        if (own) pattern = "your rhythm";
        if (plan) {
          for (let b = 0; b < bars; b++) chartNames.add(plan(b).p.name);
          pattern = [...chartNames].join(" / ");
        }
        const medV = srcHits.length ? [...srcHits].map((h) => h.vel).sort((a, b) => a - b)[Math.floor(srcHits.length / 2)] : 90;
        for (let b = 0; b < bars; b++) {
          const evs: { at: number; c: string; spread?: number; scale?: number }[] = [];
          if (own) {
            // your strokes: the detected direction (or beat position when the source is a block chord)
            for (const h of srcHits) if (Math.floor(h.start / 4 + 1e-9) === b) evs.push({ at: h.start, c: style === "power" ? (h.vel > medV ? "P" : "p") : h.dir === "up" ? "U" : h.dir === "down" ? (h.vel >= medV * 0.8 ? "D" : "d") : stepIn(h.start) % 2 === 0 ? (h.vel >= medV * 0.8 ? "D" : "d") : "U", spread: h.spreadMs });
          } else if (plan) {
            const { p, scale, first } = plan(b);
            for (const s of hitSteps(p.steps)) evs.push({ at: b * 4 + s * STEP, c: p.steps[s], scale: scale + (first && s === 0 ? 0.08 : 0) });
          } else {
            for (const s of hitSteps(pat.steps)) evs.push({ at: b * 4 + s * STEP, c: pat.steps[s] });
            for (const h of anchorHits) if (Math.floor(h.start / 4 + 1e-9) === b) evs.push({ at: h.start, c: style === "power" ? "p" : "d" });
          }
          evs.sort((a, b2) => a.at - b2.at);
          evs.forEach((e, i) => {
            if (e.at >= inp.length - 1e-9) return;
            // Song chart: an off-beat stroke just before a chord change already plays the next chord (push).
            const push = plan && e.at % 1 >= 0.5 - 1e-9 && chordAt(chords, e.at + 0.5) !== chordAt(chords, e.at);
            const sh = shapeAt(push ? e.at + 0.5 : e.at);
            if (!sh) return;
            const nextAt = evs[i + 1]?.at ?? Math.min(inp.length, b * 4 + 4);
            const ss = sounding(sh);
            const v = Math.round(Math.min(124, 105 * (WEIGHT[e.c] ?? 0.7) * (e.scale ?? 1)));
            if (style === "power") emit(e.at, ss, sh, e.c === "P" ? Math.min(0.45, nextAt - e.at - 0.02) : 0.14, e.c === "P" ? 112 : 74, 3, e.c === "P" ? "open" : "palm-mute");
            else if (style === "strum" || style === "chart") {
              const ring = Math.max(0.1, nextAt - e.at - 0.02);
              if (e.c === "x") emit(e.at, ss.slice(1, 4), sh, 0.06, 38, 4, "mute");
              // per-string gap: your measured spread when known, else harder = faster
              else if (e.c === "D" || e.c === "d") emit(e.at, ss, sh, ring, v, e.spread && e.spread >= 8 ? Math.max(4, Math.min(18, e.spread / Math.max(1, ss.length - 1))) : 9 + (1 - v / 127) * 6, "down");
              else emit(e.at, ss.slice(-4).reverse(), sh, ring, v, e.spread && e.spread >= 8 ? Math.max(3, Math.min(14, e.spread / 3)) : 7, "up");
            } else {
              // fingerpick roles
              const role = e.c;
              const bass = ss[0], alt = ss.find((s) => s > bass && s <= bass + 2 && s !== bass) ?? ss[1];
              const treble = ss.slice(-3);
              const s = role === "B" ? bass : role === "A" ? alt : treble[Math.min(treble.length - 1, Number(role) - 1)];
              if (s === undefined) return;
              emit(e.at, [s], sh, Math.min(2, Math.max(0.2, nextAt - e.at + 0.25)), role === "B" || role === "A" ? 92 : 76, 0, "pick");
            }
          });
        }
      }
    }

    /* ───── bass ───── */
    if (mode === "bass") {
      const r = bassVariant(inp, free, k, P, conf.fill);
      out = r.notes;
      pattern = r.pattern;
    }

    /* ───── line ───── */
    if (mode === "line") {
      const styleI = style === "faithful" ? 0 : style === "tight" ? 0.6 : 1;
      const I = Math.min(1.3, styleI * conf.k * (1.2 - 0.6 * P));
      pattern = style;
      let line = free.map((e) => ({ ...e })).sort((a, b) => a.start - b.start);
      // ornaments: short notes between two others, close in pitch to the previous, off the beat → merged
      if (I > 0.6)
        for (let i = 1; i < line.length - 1; i++) {
          const p = line[i - 1], e = line[i];
          if (e.dur < 0.5 * Math.min(1, I) && Math.abs(e.pitch - p.pitch) <= 2 && Math.abs(e.start - Math.round(e.start)) > 0.05 && Math.abs(e.start - (p.start + p.dur)) < 0.1) {
            p.dur = e.start + e.dur - p.start;
            p.origin = "edited";
            line.splice(i, 1);
            i--;
          }
        }
      // repeated phrases → one consistent version (bar units, majority per step)
      if (I >= 0.5 && inp.completeBars >= 2) {
        const units = new Map<number, PEvent[]>();
        for (const e of line) {
          const b = Math.floor(e.start / 4 + 1e-9);
          (units.get(b) ?? units.set(b, []).get(b)!).push(e);
        }
        const sig = (es: PEvent[]) => es.map((e) => `${stepIn(e.start)}:${e.pitch}`);
        const sim = (a: string[], b: string[]) => {
          const A = new Set(a), B = new Set(b);
          let i = 0;
          for (const x of A) if (B.has(x)) i++;
          return i / Math.max(1, A.size + B.size - i);
        };
        const barsL = [...units.keys()];
        const done = new Set<number>();
        for (const b of barsL) {
          if (done.has(b)) continue;
          const group = barsL.filter((o) => !done.has(o) && sim(sig(units.get(b)!), sig(units.get(o)!)) >= 0.55);
          if (group.length < 2 || (group.length === 2 && sim(sig(units.get(group[0])!), sig(units.get(group[1])!)) < 0.75)) continue;
          group.forEach((g) => done.add(g));
          // consensus: steps present in ≥ half of the repeats, majority pitch, median length/velocity
          const vote = new Map<number, PEvent[]>();
          for (const g of group) for (const e of units.get(g)!) { const s = stepIn(e.start); (vote.get(s) ?? vote.set(s, []).get(s)!).push(e); }
          const cons = [...vote].filter(([, es]) => es.length * 2 >= group.length).map(([s, es]) => {
            const count = new Map<number, number>();
            es.forEach((e) => count.set(e.pitch, (count.get(e.pitch) ?? 0) + 1));
            const pitch = [...count].sort((a, b2) => b2[1] - a[1] || a[0] - b2[0])[0][0];
            const med = (xs: number[]) => [...xs].sort((a, b2) => a - b2)[Math.floor(xs.length / 2)];
            return { s, pitch, dur: med(es.map((e) => e.dur)), vel: med(es.map((e) => e.vel)) };
          });
          for (const g of group) {
            const old = units.get(g)!;
            const rebuilt: PEvent[] = cons.map((c) => {
              const was = old.find((e) => stepIn(e.start) === c.s);
              const same = was && was.pitch === c.pitch && Math.abs(was.dur - c.dur) < 0.13;
              return same ? was! : { ...(was ?? {}), id: was?.id ?? `u:${g}:${c.s}`, pitch: c.pitch, start: g * 4 + c.s * STEP, micro: was?.micro ?? 0, dur: c.dur, vel: was?.vel ?? c.vel, origin: was ? "edited" : "added", tags: ["unified repeat"] } as PEvent;
            });
            line = line.filter((e) => !old.includes(e)).concat(rebuilt);
          }
        }
        line.sort((a, b) => a.start - b.start);
      }
      // in key (hook): remaining out-of-key notes snap to the nearest chord/scale tone
      if (I >= 0.9) {
        const scale = scalePcs(inp.key);
        for (const e of line) {
          if (scale.has(e.pitch % 12)) continue;
          const c = chordAt(chords, e.start);
          const tgt = c ? chordPcs(c) : [...scale];
          for (const d of [-1, 1, -2, 2]) if (tgt.includes((e.pitch + d + 120) % 12)) { e.pitch += d; e.origin = "edited"; break; }
        }
      }
      // legato: close small gaps so the line sings (rests ≥ the threshold stay)
      if (I > 0) {
        const thr = 0.25 + 0.5 * Math.min(1, I);
        for (let i = 0; i < line.length - 1; i++) {
          const e = line[i], n = line[i + 1];
          const gap = n.start - (e.start + e.dur);
          if (gap > 0.01 && gap < thr) { e.dur = n.start - e.start - 0.02; if (e.origin === "source") e.origin = "edited"; }
        }
      }
      // a line is one note at a time: every note ends before the next begins
      line.sort((a, b) => a.start - b.start);
      for (let i = 0; i < line.length - 1; i++) if (!line[i].locked && line[i].start + line[i].dur > line[i + 1].start - 0.02) line[i].dur = Math.max(0.05, line[i + 1].start - line[i].start - 0.02);
      out = line;
    }

    /* ───── phrase development (keys / guitar): bounded, never on every repeat ───── */
    let fills = 0;
    const phraseLen = completeOut >= 8 ? 8 : completeOut >= 4 ? 4 : 0;
    // (song chart: its turnarounds are the development; random fills would break identical repeats)
    if (phraseLen && mode !== "line" && mode !== "bass" && style !== "chart" && !(mode === "guitar" && style === "faithful") && !(mode === "keys" && k === 0 && style === "comp")) {
      let prevHad = false;
      for (let b = phraseLen - 1; b < completeOut - 1; b += phraseLen) {
        let p = inp.variation * conf.fill;
        if (prevHad) p *= 0.35;
        if (rand(inp.seeds.phrase, k, "fill", b) >= p) { prevHad = false; continue; }
        prevHad = true;
        fills++;
        const end = (b + 1) * 4;
        if (mode === "keys" && style !== "arp" && style !== "pad") {
          // anticipation: the next bar's first chord arrives an 8th early
          const first = out.filter((e) => Math.abs(e.start - end) < 1e-6 && !e.locked);
          out = out.filter((e) => !(e.start >= end - 0.5 && e.start < end && !e.locked));
          for (const e of first) { e.start = end - 0.5; e.dur += 0.5; e.tags = [...(e.tags ?? []), "push"]; e.origin = "fill"; }
        } else if (mode === "guitar") {
          const sh = (() => { const c = chordAt(chords, end - 1); return c ? (style === "power" ? powerShape(c.root, null) : pickShape(guitarShapes(c.root, c.q), null, inp.openShapes, 0, "f")) : null; })();
          out = out.filter((e) => !(e.start >= end - 1 && e.start < end && !e.locked));
          if (sh) {
            const ss = sh.pitches.map((p, i) => (p === null ? -1 : i)).filter((i) => i >= 0);
            if (style === "power") ss.forEach((s) => out.push({ id: `f:${b}:${s}`, pitch: sh.pitches[s]!, start: end - 1, micro: 0, dur: 0.95, vel: 118, origin: "fill", string: s, tags: ["fill", "accent"] }));
            else for (let t = 0; t < 4; t++) {
              const strings = t % 2 ? ss.slice(-4).reverse() : ss;
              strings.forEach((s, i) => out.push({ id: `f:${b}:${t}:${s}`, pitch: sh.pitches[s]!, start: end - 1 + t * 0.25, micro: (i * (t % 2 ? 7 : 9)) / 1000 / spb, dur: 0.22, vel: t % 2 ? 80 : 104, origin: "fill", string: s, tags: ["fill"] }));
            }
          }
        } else if (mode === "keys" && style === "arp") {
          const bar = out.filter((e) => e.start >= end - 4 && e.start < end && !e.locked).sort((a, c) => a.start - c.start);
          const pitches = bar.map((e) => e.pitch).reverse();
          bar.forEach((e, i) => { e.pitch = pitches[i]; e.origin = "fill"; e.tags = ["arp", "reversed"]; });
        }
      }
    }

    // locked notes and pinned results win
    out.push(...fixed);
    for (const pin of pins) {
      out = out.filter((e) => e.locked || !(e.pitch === pin.pitch && Math.abs(e.start - pin.start) < 0.06));
      if (!out.some((e) => e.id === pin.id)) out.push(pin);
    }
    // unique ids (two generators can meet on one slot)
    const seen = new Map<string, number>();
    out = out.filter((e) => e.start < inp.length - 1e-9).map((e) => {
      const n = seen.get(e.id) ?? 0;
      seen.set(e.id, n + 1);
      return n ? { ...e, id: `${e.id}#${n}` } : e;
    });
    out.sort((a, b) => a.start + a.micro - (b.start + b.micro) || a.pitch - b.pitch);
    const ids = new Set(out.map((e) => e.id));
    const dropped = base.filter((e) => !ids.has(e.id));
    const kept = out.filter((e) => e.src && e.origin !== "edited").length;
    return { name: conf.name, events: out, dropped, stats: { notes: out.length, kept, generated: out.filter((e) => !e.src).length, changed: out.filter((e) => e.src && e.origin !== "source" && e.origin !== "moved").length + fills, pattern } };
  });
}

/* ───────────── bass ───────────── */

const BASS_LO = 28, BASS_HI = 52; // E1 … E3: where a bass line sits

/** The octave of a pitch class closest to the previous note (or the centre), inside the bass register. */
function bassPitch(pc: number, prev: number | null, center = 38) {
  const ref = prev ?? center;
  let best = BASS_LO, bd = Infinity;
  for (let p = BASS_LO - 4; p <= BASS_HI + 4; p++) {
    if (((p % 12) + 12) % 12 !== pc) continue;
    const d = Math.abs(p - ref) + (p < BASS_LO || p > BASS_HI ? 6 : 0);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

interface RestCtx { chords: Chord[]; kicks: number[]; srcRests: { bar: number; pos: number }[]; completeBars: number; staccato: boolean }

/**
 * A bass rests only for a musical reason. Returns the reason, or null (→ the previous note sustains):
 * the rest repeats in other bars (it's the groove), it closes a phrase (breathing), the kick drum
 * rests there too (bass breathes with the kick), it's a pickup into a chord change, or the whole
 * part is played staccato.
 */
function restReason(a: number, b: number, next: number, c: RestCtx): string | null {
  if (c.staccato) return "staccato part";
  const bar = Math.floor(a / 4 + 1e-9), pos = a - bar * 4;
  if ((bar + 1) % 4 === 0 && pos >= 2 - 1e-6) return "phrase end";
  if (c.completeBars >= 3) {
    const same = c.srcRests.filter((r) => r.bar !== bar && Math.abs(r.pos - pos) < 0.13).length;
    if (same >= Math.max(1, (c.completeBars - 1) * 0.5)) return "repeats in other bars";
  }
  if (c.kicks.length && !c.kicks.some((x) => x > a + 0.05 && x < b - 0.05) && c.kicks.some((x) => Math.abs(x - next) < 0.06)) return "breathes with the kick";
  const change = c.chords.find((ch) => ch.start > next + 1e-6 && ch.start <= next + 1 + 1e-6);
  if (change && next % 1 >= 0.25 && b - a <= 1 + 1e-6) return "pickup into the chord change";
  return null;
}

function bassVariant(inp: ReworkIn, free: PEvent[], k: number, P: number, fillScale: number): { notes: PEvent[]; pattern: string } {
  const { chords, length, style } = inp;
  const kicks = inp.kicks ?? [];
  const src = [...free].sort((a, b) => a.start - b.start);
  // Rests in the source line, for "repeats in other bars".
  const srcRests: { bar: number; pos: number }[] = [];
  for (let i = 0; i < src.length - 1; i++) {
    const end = src[i].start + src[i].dur, gap = src[i + 1].start - end;
    if (gap >= 0.25) srcRests.push({ bar: Math.floor(end / 4 + 1e-9), pos: end - Math.floor(end / 4 + 1e-9) * 4 });
  }
  const durs = src.map((e) => e.dur).sort((a, b) => a - b);
  const iois = src.slice(1).map((e, i) => e.start - src[i].start).filter((x) => x > 0.05).sort((a, b) => a - b);
  const staccato = src.length >= 8 && durs[Math.floor(durs.length / 2)] < 0.55 * (iois[Math.floor(iois.length / 2)] ?? 1) && durs[Math.floor(durs.length / 2)] <= 0.35;
  const ctx: RestCtx = { chords, kicks, srcRests, completeBars: inp.completeBars, staccato };
  const chordAtB = (b: number) => chordAt(chords, b);
  let prev: number | null = null;
  const note = (start: number, pc: number | null, dur: number, vel: number, id: string, base?: PEvent): PEvent => {
    const pitch = pc === null ? base!.pitch : bassPitch(pc, prev, base?.pitch ?? 38);
    prev = pitch;
    return base ? { ...base, pitch, start, dur, vel, origin: pitch !== base.pitch || Math.abs(start - base.start) > 1e-3 ? "edited" : base.origin } : { id, pitch, start, micro: 0, dur, vel, origin: "generated" };
  };
  let line: PEvent[] = [];
  let pattern = style as string;
  const rhythmFromSource = k === 0 || !src.length;

  if (style === "faithful" || (rhythmFromSource && style !== "kick")) {
    // Your line; roots enforced on chord changes (moderate / free), pitches otherwise kept.
    pattern = style === "faithful" ? "your line" : "your rhythm";
    for (const e of src) {
      const c = chordAtB(e.start);
      const onChange = c && Math.abs(e.start - c.start) < 0.13;
      const fits = c ? chordPcs(c).includes(e.pitch % 12) : true;
      const snapRoot = c && ((style !== "faithful") || (onChange && !fits && k > 0));
      line.push(note(e.start, snapRoot ? c!.root : null, e.dur, e.vel, e.id, e));
    }
  } else if (style === "kick") {
    const hits = kicks.length ? kicks : src.map((e) => e.start);
    pattern = kicks.length ? "on the kicks" : "your rhythm (no kick found)";
    hits.forEach((h, i) => {
      const c = chordAtB(h);
      const nextHit = hits[i + 1] ?? length;
      const change = chords.find((ch) => ch.start > h + 1e-6 && ch.start < nextHit - 1e-6);
      const end = Math.min(nextHit, change ? change.start : nextHit, h + (k === 2 ? 1 : 2));
      line.push(note(h, c ? c.root : null, Math.max(0.2, end - h - 0.03), 105, `g:k:${Math.round(h * 48)}`, c ? undefined : src[0]));
      // free: an octave pop on the off-beat inside long kick gaps
      if (k === 2 && nextHit - h >= 1.5 && c) line.push(note(h + 0.5 + Math.floor((nextHit - h - 0.5) / 2), c.root, 0.22, 82, `g:k:o:${Math.round(h * 48)}`));
    });
  } else if (style === "roots") {
    pattern = k === 2 ? "root-fifth-octave" : "root 8ths";
    for (const c of chords) {
      for (let t = c.start; t < c.start + c.length - 1e-9; t += 0.5) {
        if (t >= length - 1e-9) break;
        const last = t + 0.5 >= c.start + c.length - 1e-9;
        const next = chords.find((x) => x.start >= c.start + c.length - 1e-9);
        let pc = c.root;
        if (k === 2) {
          const i = Math.round((t - c.start) / 0.5) % 4;
          pc = [c.root, c.root, (c.root + 7) % 12, c.root][i];
        }
        if (last && next && next.root !== c.root) {
          // approach note into the chord change: a step below the next root (in key when possible)
          const below = (next.root + 11) % 12, above = (next.root + 1) % 12, scale = scalePcs(inp.key);
          pc = scale.has((next.root + 10) % 12) && k < 2 ? (next.root + 10) % 12 : scale.has(below) ? below : above;
        }
        const n = note(t, pc, 0.46, t % 1 === 0 ? 108 : 92, `g:r:${Math.round(t * 48)}`);
        if (k === 2 && Math.round((t - c.start) / 0.5) % 4 === 3 && !last) n.pitch = Math.min(BASS_HI + 7, n.pitch + 12); // octave pop
        line.push(n);
      }
    }
  } else if (style === "octaves") {
    pattern = k === 2 ? "house off-beats" : "disco octaves";
    for (const c of chords) {
      for (let t = c.start; t < c.start + c.length - 1e-9; t += 0.5) {
        if (t >= length - 1e-9) break;
        const off = t % 1 >= 0.5 - 1e-9;
        if (k === 2 && !off) continue; // house: off-beats only
        const low = bassPitch(c.root, prev, 36);
        const pitch = off ? low + 12 : low;
        line.push({ id: `g:o:${Math.round(t * 48)}`, pitch, start: t, micro: 0, dur: 0.38, vel: off ? 104 : 94, origin: "generated" });
        prev = low;
      }
    }
  }

  // Rests need a reason: an unjustified gap is filled (the previous note sustains), up to a limit by variant.
  line.sort((a, b) => a.start - b.start);
  const maxFill = [0.5, 1, 2][k];
  for (let i = 0; i < line.length - 1; i++) {
    const e = line[i], n = line[i + 1];
    const end = e.start + e.dur, gap = n.start - end;
    if (gap <= 0.02) continue;
    if (style === "octaves" || (style === "roots" && k > 0)) continue; // short notes are the style there
    const why = restReason(end, n.start, n.start, ctx);
    if (why) {
      e.tags = [...(e.tags ?? []), `rest: ${why}`];
      continue;
    }
    if (gap <= maxFill + 1e-9 && !e.locked) {
      e.dur = n.start - e.start - 0.02;
      if (e.origin === "source" || e.origin === "moved") e.origin = "edited";
      e.tags = [...(e.tags ?? []), "sustained (no reason to rest)"];
    }
  }
  // Phrase-end walk-up into the next phrase (bounded, never on consecutive phrases).
  const completeOut = Math.floor(length / 4 + 1e-9);
  const phraseLen = completeOut >= 8 ? 8 : completeOut >= 4 ? 4 : 0;
  if (phraseLen && style !== "faithful") {
    let prevHad = false;
    for (let b = phraseLen - 1; b < completeOut - 1; b += phraseLen) {
      let p = inp.variation * fillScale;
      if (prevHad) p *= 0.35;
      if (rand(inp.seeds.phrase, k, "walk", b) >= p) { prevHad = false; continue; }
      prevHad = true;
      const end = (b + 1) * 4, next = chordAt(chords, end);
      if (!next) continue;
      line = line.filter((e) => e.locked || !(e.start >= end - 1 && e.start < end));
      const target = bassPitch(next.root, prev, 38);
      [-3, -2, -1].forEach((d, i) => line.push({ id: `f:w:${b}:${i}`, pitch: target + d, start: end - 1 + (i + 1) * 0.25, micro: 0, dur: 0.23, vel: 88 + i * 6, origin: "fill", tags: ["fill", "walk-up"] }));
      line.push({ id: `f:w:${b}:0`, pitch: target - 5 >= BASS_LO ? target - 5 : target + 7, start: end - 1, micro: 0, dur: 0.23, vel: 96, origin: "fill", tags: ["fill", "walk-up"] });
    }
  }
  // One note at a time, always.
  line.sort((a, b) => a.start - b.start);
  for (let i = 0; i < line.length - 1; i++) if (!line[i].locked && line[i].start + line[i].dur > line[i + 1].start - 0.02) line[i].dur = Math.max(0.05, line[i + 1].start - line[i].start - 0.02);
  return { notes: line.filter((e) => e.start < length - 1e-9), pattern };
}

