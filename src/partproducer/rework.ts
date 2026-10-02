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
import { chordAt, chordPcs, scalePcs } from "./harmony";
import { ARPS, COMP, hitSteps, PICKS, POWER, STABS, STRUMS, WEIGHT } from "./patterns";
import { guitarShapes, keyVoicings, pickShape, pickVoicing, powerShape, TUNING, type KeyOpts, type Shape } from "./voicing";
import type { Chord, Mode, PEvent, Style, Variant } from "./types";

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
}

interface Hit { start: number; dur: number; vel: number; src?: PEvent[]; c?: string }

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
  comp: { lo: 48, hi: 79, color: "plain", maxSpan: 16, center: 62 },
  stabs: { lo: 55, hi: 84, color: "rootless9", maxSpan: 13, center: 69 },
  pad: { lo: 48, hi: 79, color: "add9", maxSpan: 24, double: true, center: 62 },
  arp: { lo: 52, hi: 76, color: "plain", maxSpan: 14, center: 62 },
};

export function reworkPart(inp: ReworkIn): Variant[] {
  const { base, mode, style, chords, spb } = inp;
  const free = base.filter((e) => !e.locked);
  const fixed = base.filter((e) => e.locked);
  const srcHits = clusters(free);
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
    const anchors = (hits: Hit[], need: number) => srcHits.filter((h) => hitScore(h) + 0.1 * rand(inp.seeds.rhythm, k, "a", h.start) >= need && !hits.some((x) => Math.abs(x.start - h.start) < 0.13));

    /* ───── keys ───── */
    if (mode === "keys") {
      const o = { ...(KEY_OPTS[style] ?? KEY_OPTS.comp), scale: scalePcs(inp.key) };
      let hits: Hit[];
      if (style === "pad" || style === "arp") {
        pattern = style === "pad" ? "sustained" : undefined;
        hits = [];
        for (const c of chords) for (let a = c.start; a < c.start + c.length - 1e-9; a += 8) hits.push({ start: a, dur: Math.min(8, c.start + c.length - a) - 0.03, vel: 92 });
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
      if (style === "comp") hits.forEach((h, i) => { const n = hits[i + 1]; if (n) h.dur = Math.min(h.dur, n.start - h.start - 0.03); });
      let prev: number[] | null = null;
      for (const h of hits) {
        // Off-beat hits within half a beat before a chord change anticipate the next chord (house push).
        const next = chordAt(chords, h.start + 0.5);
        const cur = chordAt(chords, h.start);
        const c = next && cur && next !== cur && h.start % 1 >= 0.5 - 1e-9 && (style === "stabs" || style === "comp") ? next : cur;
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
        const list = style === "power" ? POWER : style === "strum" ? STRUMS : PICKS.map((p) => ({ name: p.name, steps: p.roles.split("").map((c) => c + ".").join("") }));
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
        const anchorHits = style === "fingerpick" ? [] : anchors([], 1 - P + 0.3).filter((h) => !hitSteps(pat.steps).includes(stepIn(h.start)));
        // "close" strum/power follows your rhythm: strokes on your onsets (down on 8ths, up between; accents by velocity)
        const own = k === 0 && style !== "fingerpick" && srcHits.length > 0;
        if (own) pattern = "your rhythm";
        const medV = srcHits.length ? [...srcHits].map((h) => h.vel).sort((a, b) => a - b)[Math.floor(srcHits.length / 2)] : 90;
        for (let b = 0; b < bars; b++) {
          const evs: { at: number; c: string }[] = [];
          if (own) {
            for (const h of srcHits) if (Math.floor(h.start / 4 + 1e-9) === b) evs.push({ at: h.start, c: style === "power" ? (h.vel > medV ? "P" : "p") : stepIn(h.start) % 2 === 0 ? (h.vel >= medV * 0.8 ? "D" : "d") : "U" });
          } else {
            for (const s of hitSteps(pat.steps)) evs.push({ at: b * 4 + s * STEP, c: pat.steps[s] });
            for (const h of anchorHits) if (Math.floor(h.start / 4 + 1e-9) === b) evs.push({ at: h.start, c: style === "power" ? "p" : "d" });
          }
          evs.sort((a, b2) => a.at - b2.at);
          evs.forEach((e, i) => {
            if (e.at >= inp.length - 1e-9) return;
            const sh = shapeAt(e.at);
            if (!sh) return;
            const nextAt = evs[i + 1]?.at ?? Math.min(inp.length, b * 4 + 4);
            const ss = sounding(sh);
            const v = Math.round(105 * (WEIGHT[e.c] ?? 0.7));
            if (style === "power") emit(e.at, ss, sh, e.c === "P" ? Math.min(0.45, nextAt - e.at - 0.02) : 0.14, e.c === "P" ? 112 : 74, 3, e.c === "P" ? "open" : "palm-mute");
            else if (style === "strum") {
              const ring = Math.max(0.1, nextAt - e.at - 0.02);
              if (e.c === "x") emit(e.at, ss.slice(1, 4), sh, 0.06, 38, 4, "mute");
              else if (e.c === "D" || e.c === "d") emit(e.at, ss, sh, ring, v, 9 + (1 - v / 127) * 6, "down");
              else emit(e.at, ss.slice(-4).reverse(), sh, ring, v, 7, "up");
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
    if (phraseLen && mode !== "line" && !(mode === "guitar" && style === "faithful") && !(mode === "keys" && k === 0 && style === "comp")) {
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
