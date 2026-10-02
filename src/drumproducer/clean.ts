/**
 * "Clean": fix probable transcription errors without changing the pattern on purpose.
 * Every change is a reviewable proposal with a reason and a heuristic score (not a probability).
 * Protected by design: ghost notes (never auto-removed), flams, rolls, repeated short figures,
 * triplet figures (per-beat grid), locked events.
 */
import { barOf, BEATS_PER_BAR, gridStepAt, inBar, stepOf, STEP, STEPS } from "./analyze";
import { VOICE_INFO, type Analysis, type CleanParams, type DEvent, type Proposal, type Voice } from "./types";

const FAMILY: Record<Voice, "kick" | "back" | "tom" | "hat" | "cym" | "perc"> = {
  kick: "kick", snare: "back", clap: "back", rim: "back", hhc: "hat", hhp: "hat", hho: "hat", ride: "hat", shaker: "hat",
  crash: "cym", tomL: "tom", tomM: "tom", tomH: "tom", perc: "perc",
};
/** Retrigger window (s) inside which two hits of one voice are suspicious. */
const WINDOW: Record<string, number> = { kick: 0.05, back: 0.035, tom: 0.035, hat: 0.03, cym: 0.09, perc: 0.03 };
const HARD_DUP = 0.01;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const tag = (e: DEvent, t: string) => {
  e.tags ??= [];
  if (!e.tags.includes(t)) e.tags.push(t);
};
const ms = (sec: number) => `${Math.round(sec * 1000)} ms`;

export interface CleanInput {
  events: DEvent[]; // mapped source events (start = source position, micro 0)
  analysis: Omit<Analysis, "mapping" | "mappingStatus">;
  gridBeats: Map<number, string>;
  params: CleanParams;
  spb: number;
  lengthBeats: number;
}

export function clean({ events, analysis, gridBeats, params, spb, lengthBeats }: CleanInput) {
  const ev = events.map((e) => ({ ...e, tags: e.tags ? [...e.tags] : undefined }));
  const byId = new Map(ev.map((e) => [e.id, e]));
  const proposals: Proposal[] = [];
  const nBars = analysis.completeBars;
  const accepted = (id: string, def: boolean) => params.decisions[id] ?? def;
  const push = (p: Omit<Proposal, "accepted">) => proposals.push({ ...p, accepted: accepted(p.id, p.def) });

  const byVoice = new Map<Voice, DEvent[]>();
  for (const e of ev) (byVoice.get(e.voice) ?? byVoice.set(e.voice, []).get(e.voice)!).push(e);
  for (const list of byVoice.values()) list.sort((a, b) => a.start - b.start);

  // ── protection tags: ghosts, rolls
  for (const [, list] of byVoice) {
    if (list.length >= 4) {
      const med = median(list.map((e) => e.vel));
      for (const e of list) if (e.vel < Math.min(70, med * 0.55)) tag(e, "ghost");
    }
    let i = 0;
    while (i < list.length) {
      let j = i;
      const iois: number[] = [];
      while (j + 1 < list.length) {
        const d = (list[j + 1].start - list[j].start) * spb;
        if (d > 0.14 || d < 0.012) break;
        iois.push(d);
        j++;
      }
      if (j - i >= 2 && Math.max(...iois) / Math.min(...iois) <= 1.6) for (let k = i; k <= j; k++) tag(list[k], "roll");
      i = Math.max(j, i + 1);
    }
  }

  // Does a short two-hit figure recur in other bars (then it's intentional)?
  const recurs = (v: Voice, a: number, b: number) => {
    if (nBars < 3) return false;
    const list = byVoice.get(v)!;
    const ia = inBar(a), ib = inBar(b), bar = barOf(a);
    let hits = 0;
    for (let k = 0; k < nBars; k++) {
      if (k === bar) continue;
      const base = k * BEATS_PER_BAR;
      const has = (x: number) => list.some((e) => Math.abs(e.start - (base + x)) < 0.04);
      if (has(ia) && has(ib)) hits++;
    }
    return hits >= (nBars - 1) * 0.5;
  };

  // ── duplicates / ultra-short retriggers
  const removed = new Set<string>();
  for (const [v, list] of byVoice) {
    const fam = FAMILY[v];
    let prev: DEvent | null = null;
    for (const cur of list) {
      if (!prev) { prev = cur; continue; }
      const a: DEvent = prev, b = cur;
      const dt = (b.start - a.start) * spb;
      const win = WINDOW[fam];
      if (dt >= win) { prev = b; continue; }
      if (a.locked && b.locked) { prev = b; continue; }
      const weaker = a.locked ? b : b.locked ? a : a.vel < b.vel ? a : b.vel < a.vel ? b : b;
      const keeper = weaker === a ? b : a;
      if (dt < HARD_DUP) {
        push({ id: `dup:${weaker.id}`, kind: "remove", voice: v, eventIds: [weaker.id, keeper.id], at: weaker.start, reason: `double trigger: two ${v} hits ${ms(dt)} apart (keeps the louder, velocity ${Math.max(a.vel, b.vel)})`, heur: 0.92, def: true });
        removed.add(weaker.id);
        prev = keeper;
        continue;
      }
      if (a.tags?.includes("roll") && b.tags?.includes("roll")) { prev = b; continue; }
      if ((fam === "back" || fam === "tom") && a.vel <= b.vel * 0.85 && dt >= 0.012) {
        tag(a, "flam");
        prev = b;
        continue;
      }
      if (recurs(v, a.start, b.start)) {
        tag(a, "figure");
        tag(b, "figure");
        prev = b;
        continue;
      }
      const heur = Math.round((0.5 + 0.4 * (1 - dt / win)) * 100) / 100;
      push({ id: `dup:${weaker.id}`, kind: "remove", voice: v, eventIds: [weaker.id, keeper.id], at: weaker.start, reason: `${v} retrigger ${ms(dt)} after the previous hit, not a flam/roll and not repeated in other bars`, heur, def: heur >= 0.6 });
      removed.add(weaker.id);
      prev = keeper;
    }
  }

  // ── very quiet one-offs: suggested, never applied by default (could be ghost notes)
  for (const e of ev) {
    if (removed.has(e.id) || e.locked || e.vel >= 22 || !(e.voice === "kick" || e.voice === "snare" || e.voice === "clap") || nBars < 2) continue;
    const s = stepOf(e.start, 0.2);
    const list = byVoice.get(e.voice)!;
    const repeats = s >= 0 && list.some((o) => o !== e && stepOf(o.start, 0.2) === s && barOf(o.start) !== barOf(e.start) && o.vel < 60);
    if (repeats) continue;
    push({ id: `bleed:${e.id}`, kind: "remove", voice: e.voice, eventIds: [e.id], at: e.start, reason: `very quiet ${e.voice} (velocity ${e.vel}) that never repeats — possibly bleed; kept by default because it may be a ghost note`, heur: 0.35, def: false });
  }

  // ── velocity outliers per voice + step position across bars
  if (nBars >= 3) {
    for (const [v, list] of byVoice) {
      const bySlot = new Map<number, DEvent[]>();
      for (const e of list) {
        if (removed.has(e.id) || barOf(e.start) >= nBars) continue;
        const s = stepOf(e.start, 0.2);
        if (s >= 0) (bySlot.get(s) ?? bySlot.set(s, []).get(s)!).push(e);
      }
      for (const [, slot] of bySlot) {
        if (slot.length < 3) continue;
        for (const e of slot) {
          if (e.locked || e.tags?.includes("ghost") || e.tags?.includes("flam")) continue;
          const others = slot.filter((o) => o !== e).map((o) => o.vel);
          const m = median(others);
          const mad = Math.max(6, median(others.map((x) => Math.abs(x - m))));
          const d = e.vel - m;
          if (d > Math.max(3 * mad, 30)) push({ id: `vel:${e.id}`, kind: "velocity", voice: v, eventIds: [e.id], at: e.start, vel: Math.round(m), reason: `${v} velocity ${e.vel} spikes above the same position in other bars (median ${Math.round(m)})`, heur: 0.7, def: true });
          else if (-d > Math.max(3 * mad, 35)) push({ id: `vel:${e.id}`, kind: "velocity", voice: v, eventIds: [e.id], at: e.start, vel: Math.round(m), reason: `${v} velocity ${e.vel} far below other bars (median ${Math.round(m)}) — could be intended dynamics`, heur: 0.45, def: false });
        }
      }
    }
  }

  // ── probable missed hits (only with enough bars to call something a pattern)
  if (nBars >= 4) {
    const barCount = new Array(nBars).fill(0);
    for (const e of ev) if (barOf(e.start) < nBars) barCount[barOf(e.start)]++;
    const phrase = analysis.phraseBars;
    for (const v of ["kick", "snare", "clap", "hhc", "hho"] as Voice[]) {
      const list = (byVoice.get(v) ?? []).filter((e) => !removed.has(e.id));
      if (!list.length) continue;
      for (let s = 0; s < STEPS; s++) {
        const barsWith = new Set<number>();
        const vels: number[] = [];
        for (const e of list) if (barOf(e.start) < nBars && stepOf(e.start, 0.2) === s) { barsWith.add(barOf(e.start)); vels.push(e.vel); }
        const f = barsWith.size / nBars;
        if (f < 0.85 || barsWith.size === nBars) continue;
        for (let b = 0; b < nBars; b++) {
          if (barsWith.has(b) || barCount[b] < 2) continue; // empty bars are breaks, not errors
          if ((phrase && (b + 1) % phrase === 0) || b === nBars - 1) continue; // could be a fill / ending
          const at = b * BEATS_PER_BAR + s * STEP;
          if (list.some((e) => Math.abs(e.start - at) < 0.12)) continue; // present, just late/early
          const def = f >= 0.9 && nBars >= 6 && (v === "kick" || v === "snare" || v === "clap");
          push({ id: `add:${v}:${b}:${s}`, kind: "add", voice: v, eventIds: [], at, vel: Math.round(median(vels)), reason: `${v} at this position in ${barsWith.size}/${nBars} bars but missing here — probably not detected`, heur: Math.round(f * 0.8 * 100) / 100, def });
        }
      }
    }
  }

  // ── apply accepted removals / velocity / adds
  const pmap = new Map(proposals.map((p) => [p.id, p]));
  const dropped: DEvent[] = [];
  const isOn = (id: string) => pmap.get(id)?.accepted ?? false;
  let out: DEvent[] = [];
  for (const e of ev) {
    const rm = isOn(`dup:${e.id}`) || isOn(`bleed:${e.id}`);
    if (rm && !e.locked) {
      dropped.push(e);
      continue;
    }
    if (isOn(`vel:${e.id}`) && !e.locked) {
      e.vel = pmap.get(`vel:${e.id}`)!.vel!;
      e.origin = "velocity";
    }
    out.push(e);
  }
  // A removed duplicate hands its velocity to the keeper (the hit was one, louder event).
  for (const p of proposals)
    if (p.kind === "remove" && p.accepted && p.eventIds.length === 2) {
      const gone = byId.get(p.eventIds[0]), keep = out.find((e) => e.id === p.eventIds[1]);
      if (gone && keep && !keep.locked && gone.vel > keep.vel) keep.vel = gone.vel;
    }
  for (const p of proposals)
    if (p.kind === "add" && p.accepted && p.voice)
      out.push({ id: `a:${p.voice}:${Math.round(p.at * 48)}`, voice: p.voice, start: p.at, micro: 0, vel: p.vel ?? 90, dur: 0.25, origin: "added", layer: VOICE_INFO[p.voice].layer, heur: p.heur, tags: ["added"] });

  // ── soft quantize (musical position = grid, residual = micro-timing)
  const strength = Math.max(0, Math.min(1, params.strength));
  const choiceStep = (b: number) => gridStepAt(b, params.grid, analysis.grid.decision, gridBeats);
  const ambiguous = params.grid === "auto" && analysis.grid.decision === "ambiguous";
  let moved = 0, shift = 0;
  const qOn = !ambiguous && strength > 0 && out.length > 0;
  const qId = "quantize";
  const qAccepted = accepted(qId, true);
  const snapped = new Map<string, number>();
  for (const e of out) {
    if (e.origin === "added") { snapped.set(e.id, e.start); continue; }
    let step = choiceStep(e.start);
    if (step === null) continue;
    if (e.tags?.includes("roll")) step /= 2;
    const g = Math.round(e.start / step) * step;
    snapped.set(e.id, g >= lengthBeats ? e.start : Math.max(0, g));
  }
  // Flam grace notes keep their distance to the main stroke.
  const sorted = [...out].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (!e.tags?.includes("flam")) continue;
    const main = sorted.slice(i + 1).find((o) => o.voice === e.voice);
    const mg = main && snapped.get(main.id);
    if (main && mg !== undefined) snapped.set(e.id, mg - (main.start - e.start));
  }
  for (const e of out) {
    const g = snapped.get(e.id);
    if (g === undefined || e.locked) {
      // Unknown grid (ambiguous) or locked: musical position = played position.
      continue;
    }
    const orig = e.start;
    const apply = qOn && qAccepted;
    e.start = g;
    e.micro = (orig - g) * (apply ? 1 - strength : 1);
    if (apply && Math.abs(orig - g) * strength > 0.004) {
      moved++;
      shift += Math.abs(orig - g) * strength * spb;
      if (e.origin === "source") e.origin = "moved";
    }
  }
  if (qOn) {
    const grid = params.grid === "auto" ? analysis.grid.decision : params.grid;
    proposals.push({ id: qId, kind: "quantize", voice: null, eventIds: [], at: 0, reason: `soft-quantize ${moved} hits ${Math.round(strength * 100)}% toward the ${grid === "mixed" ? "per-beat straight/triplet" : grid} grid (mean shift ${moved ? ms(shift / moved) : "0 ms"}); rolls use half steps, flams keep their spacing`, heur: 0.8, def: true, accepted: qAccepted });
    // Hits that collapse onto the same grid slot after quantizing.
    if (qAccepted && strength >= 0.5) {
      const slots = new Map<string, DEvent>();
      for (const e of [...out].sort((a, b) => b.vel - a.vel)) {
        if (e.tags?.includes("flam") || e.tags?.includes("roll")) continue;
        const k = `${e.voice}@${Math.round(e.start * 48)}`;
        const keep = slots.get(k);
        if (!keep) { slots.set(k, e); continue; }
        if (e.locked) continue;
        const id = `col:${e.id}`;
        const def = true;
        proposals.push({ id, kind: "remove", voice: e.voice, eventIds: [e.id, keep.id], at: e.start, reason: `${e.voice} lands on the same grid slot as a louder hit after quantizing`, heur: 0.6, def, accepted: accepted(id, def) });
        if (accepted(id, def)) {
          dropped.push(e);
          out = out.filter((x) => x !== e);
        }
      }
    }
  }
  out.sort((a, b) => a.start + a.micro - (b.start + b.micro));
  return { proposals, events: out, dropped, ambiguous };
}
