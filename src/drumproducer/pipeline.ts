/** Pure end-to-end pipeline: map → analyse → clean → rework (3 variants) → groove → sound pick. Runs in the worker. */
import { analyze, detectGrid, inBar } from "./analyze";
import { clean } from "./clean";
import { applyGroove } from "./groove";
import { analyzeMapping } from "./mapping";
import { rework } from "./rework";
import { autoSound } from "./sound";
import { VOICE_DUR } from "./styles";
import { DP_ALGO_VERSION, VOICE_INFO, type DEvent, type DrumSession, type PipelineResult, type Variant } from "./types";

export type PipelineInput = Pick<DrumSession, "source" | "mapping" | "clean" | "rework" | "groove" | "seed" | "layerSeeds" | "locks"> & { bpm: number };

export const pipelineInput = (s: DrumSession, bpm: number): PipelineInput => ({
  source: s.source, mapping: s.mapping, clean: s.clean, rework: s.rework, groove: s.groove, seed: s.seed, layerSeeds: s.layerSeeds, locks: s.locks, bpm,
});

export function sourceEvents(inp: Pick<PipelineInput, "source" | "mapping" | "locks">): DEvent[] {
  const lockedIds = new Set(inp.locks.events.map((e) => e.id));
  const lockedVoices = new Set(inp.locks.voices);
  const out: DEvent[] = [];
  inp.source.notes.forEach((n, idx) => {
    const v = inp.mapping[String(n.pitch)];
    if (!v || v === "ignore" || n.start < 0 || n.start >= inp.source.length) return;
    const id = `s${idx}`;
    out.push({
      id, voice: v, start: n.start, micro: 0, vel: n.vel, dur: VOICE_DUR[v] ?? Math.min(n.dur, 0.25),
      origin: "source", layer: VOICE_INFO[v].layer, src: { start: n.start, pitch: n.pitch, vel: n.vel, idx },
      locked: lockedIds.has(id) || lockedVoices.has(v) || undefined,
      conf: typeof n.conf === "number" ? n.conf : undefined,
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

export function runPipeline(inp: PipelineInput): PipelineResult {
  const spb = 60 / inp.bpm;
  const len = inp.source.length;
  const events = sourceEvents(inp);
  const base = analyze(events, len, spb);
  const map = analyzeMapping(inp.source.notes, base.bars, inp.mapping);
  const analysis = { ...base, mapping: map.rows, mappingStatus: map.status };
  const { beats } = detectGrid(events, spb);

  let cleaned = events.map((e) => ({ ...e }));
  let cleanedDropped: DEvent[] = [];
  let proposals: PipelineResult["proposals"] = [];
  if (inp.clean.on) {
    const r = clean({ events, analysis: base, gridBeats: beats, params: inp.clean, spb, lengthBeats: len });
    cleaned = r.events;
    cleanedDropped = r.dropped;
    proposals = r.proposals;
    if (r.ambiguous) analysis.warnings = [...analysis.warnings, "grid ambiguous: quantize is paused until you choose straight, triplet or mixed"];
  }

  let variants: Variant[];
  let lengthBeats = len;
  if (inp.rework.on && cleaned.length + inp.locks.events.length > 0) {
    const r = rework({ base: cleaned, analysis: base, params: inp.rework, groove: inp.groove, layerSeeds: inp.layerSeeds, locks: inp.locks, lengthBeats: len });
    variants = r.variants;
    lengthBeats = r.lengthBeats;
  } else {
    const kept = cleaned.filter((e) => e.src).length;
    variants = [{ name: inp.clean.on ? "cleaned" : "source", events: cleaned, dropped: cleanedDropped, stats: { events: cleaned.length, kept, generated: cleaned.length - kept, fills: 0, perBar: Math.round((cleaned.length / Math.max(1, len / 4)) * 10) / 10, patterns: {} } }];
  }
  const chosen = inp.rework.on ? Math.min(inp.rework.variant, variants.length - 1) : 0;
  const v = variants[chosen];
  const grooved = inp.groove.on
    ? applyGroove({ events: v.events, groove: inp.groove, style: inp.rework.style, energy: inp.rework.energy, seed: inp.seed, spb, lengthBeats, sourceSwing: analysis.swing })
    : v.events;
  // Micro-timing never pulls a hit across a bar line: an early downbeat would land in the previous
  // bar and double with the loop start (cycle wrap) or get cut by a region/split boundary.
  const final = grooved.map((e) => (!e.locked && e.micro < 0 && Math.abs(inBar(e.start)) < 1e-6 ? { ...e, micro: 0 } : e));
  final.sort((a, b) => a.start + a.micro - (b.start + b.micro));
  const sound = autoSound(final, inp.rework.style, inp.bpm, inp.rework.energy, lengthBeats);
  return { algo: DP_ALGO_VERSION, analysis, sourceEvents: events, proposals, cleaned, cleanedDropped, variants, chosen, final, lengthBeats, sound };
}
