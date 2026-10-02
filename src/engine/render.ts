/** Offline bounce (OfflineAudioContext → native audio thread). Used by export and auto-mix. */
import { isPluginLane, lanesOf, pluginAutomation, scheduleLane } from "./automation";
import { createInstrument } from "../instruments/factory";
import type { Playable } from "../instruments/types";
import type { Project, Track, NoteSlide } from "../model/types";
import { createMaster, createStrip } from "./graph";
import { forNotes, isAudible, scheduleAudio, kitLayersOf, frozenAsAudio, isFrozen } from "./schedule";
import { ensureWorklets } from "../plugins/nodes";

export interface RenderOptions {
  fromBeat?: number;
  toBeat?: number;
  /** Render only these tracks, with neutral channel strips and a bypassed master (for measuring). */
  rawTracks?: string[];
  /** Render only these tracks through their full channel strips (stems, A/B measuring); mute/solo ignored. */
  onlyTracks?: string[];
  /** Skip master processing (glue/limiter/clip) — stems and loudness matching. */
  bypassMaster?: boolean;
  sampleRate?: number;
  /** 0..1 while the offline render runs. */
  onProgress?: (fraction: number) => void;
}

/** Offline renders create note voices one slice ahead (see below), not all up front. */
const SLICE = 1; // seconds
const AHEAD = 0.25; // voices are created this far before they sound

/**
 * Bounce the project with an OfflineAudioContext (rendered on the browser's
 * native audio thread, not the JS main thread).
 */
export async function renderProject(p: Project, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const spb = 60 / p.bpm;
  const from = opts.fromBeat ?? 0;
  const to = opts.toBeat ?? p.lengthBeats;
  // Effect tails: plate inserts can ring much longer than the send reverb.
  const longVerb = [...p.tracks.flatMap((t) => t.inserts ?? []), ...(p.masterInserts ?? [])].some((i) => i.on && (i.type === "reverb" || i.type === "delay"));
  const tail = opts.rawTracks ? 0.1 : longVerb ? 5 : 2.5;
  const sr = opts.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(((to - from) * spb + tail) * sr), sr);
  await ensureWorklets(ctx);
  const master = createMaster(ctx);
  const raw = !!opts.rawTracks;
  const bypass = raw || !!opts.bypassMaster;
  master.apply(bypass ? 0 : p.masterDb, bypass);
  const wiring: Promise<void>[] = [];
  if (!bypass) wiring.push(master.inserts.apply(p.masterInserts ?? [], p.bpm));
  const tracks = p.tracks.filter((t) => (raw ? opts.rawTracks!.includes(t.id) : opts.onlyTracks ? opts.onlyTracks.includes(t.id) : isAudible(p, t)));
  const sources: AudioScheduledSourceNode[] = [];
  const pending: { t: Track; inst: Playable }[] = [];
  const strips = new Map<string, ReturnType<typeof createStrip>>();
  // Rendering an instrument track includes ALL its aux outputs (kit mics): a muted mic must get a
  // silent strip — leaving it out would route that mic to the instrument's fallback (the bus).
  const withAux = tracks.concat(p.tracks.filter((a) => a.kind === "aux" && tracks.some((t) => t.id === a.auxOf) && !tracks.includes(a)));
  for (const t of withAux) {
    const busIn = t.kind === "aux" ? strips.get(t.auxOf!)?.input : undefined;
    const strip = createStrip(ctx, busIn ?? master.input, master.reverbIn);
    strips.set(t.id, strip);
    if (!raw) strip.setAutomated(new Set(lanesOf(t).filter((l) => !isPluginLane(l.param)).map((l) => l.param)));
    if (t.kind === "aux" && !raw && !isAudible(p, t)) {
      strip.apply(t.ch, false, false);
      continue;
    }
    strip.apply(t.ch, true, raw);
    strip.setFrozen(!!t.frozen);
    if (t.frozen) {
      const fa = frozenAsAudio(t);
      if (fa) scheduleAudio(ctx, fa, strip.input, from, to, 0, spb, sources);
    } else if (t.kind === "audio") scheduleAudio(ctx, t, strip.input, from, to, 0, spb, sources);
    else if (t.instrument) {
      const inst = createInstrument(ctx, t.instrument, strip.input);
      if (t.drumKit) inst.configure?.(t.drumKit);
      inst.setLayers?.(kitLayersOf(t));
      inst.setCymbalBleed?.(t.kitCymbalBleed ?? 0);
      pending.push({ t, inst });
    }
  }
  // Inserts (sidechains need every strip) and sends; bus tracks render whenever something sends to them.
  if (!raw) {
    const buses = p.tracks.filter((b) => b.kind === "bus" && !strips.has(b.id) && isAudible(p, b) && withAux.some((t) => t.ch.sends?.some((sd) => sd.bus === b.id) || (b.reverbReturn && t.ch.reverbSend > 0)));
    for (const b of buses) {
      const st = createStrip(ctx, master.input, master.reverbIn);
      st.setAutomated(new Set(lanesOf(b).filter((l) => !isPluginLane(l.param)).map((l) => l.param)));
      st.apply(b.ch, true, false);
      strips.set(b.id, st);
    }
    const all = [...withAux, ...buses];
    // Verb knobs → the reverb return (when it renders), else the built-in reverb.
    const rr = all.find((t) => t.reverbReturn);
    const rrIn = rr ? strips.get(rr.id)?.input : undefined;
    for (const [id, st] of strips) st.setReverbTarget(rrIn && id !== rr!.id ? rrIn : master.reverbIn);
    for (const t of all) {
      const st = strips.get(t.id)!;
      wiring.push(st.setInserts(isFrozen(p, t) ? [] : t.inserts ?? [], p.bpm, (id) => strips.get(id)?.postFader));
      st.setSends(t.kind === "bus" ? [] : t.ch.sends, (id) => (all.find((b) => b.id === id)?.kind === "bus" ? strips.get(id)?.input : undefined), isAudible(p, t));
    }
  }
  for (const { t, inst } of pending) {
    if (!inst.setOutputs) continue;
    const dests: Record<string, AudioNode> = {};
    for (const a of withAux) if (a.kind === "aux" && a.auxOf === t.id && a.auxOut) dests[a.auxOut] = strips.get(a.id)!.input;
    inst.setOutputs(dests, strips.get(t.id)!.input);
  }
  await Promise.all([...wiring, ...pending.map((x) => x.inst.ready.catch(() => undefined))]);
  // Automation: levels / pan / sends sample-accurate over the whole bounce; plug-in params per slice.
  const autoTracks = raw ? [] : p.tracks.filter((t) => strips.has(t.id) && lanesOf(t).length);
  for (const t of autoTracks) for (const l of lanesOf(t)) if (!isPluginLane(l.param)) scheduleLane(l, strips.get(t.id)!.autoTargets(l.param), from, to, 0, spb);
  const pluginTracks = autoTracks.filter((t) => lanesOf(t).some((l) => isPluginLane(l.param)));
  const applyPlugins = (sec: number) => {
    for (const t of pluginTracks)
      for (const [id, vals] of pluginAutomation(t, from + sec / spb)) {
        const ins = t.inserts.find((i) => i.id === id);
        if (ins?.on) strips.get(t.id)!.inserts.setLive(id, { ...ins.params, ...vals }, p.bpm);
      }
  };
  applyPlugins(0);
  // Time order matters for chokes and voice stealing: clips/notes aren't stored sorted.
  const evs: { inst: Playable; time: number; note: number; dur: number; vel: number; slide?: NoteSlide }[] = [];
  for (const { t, inst } of pending) forNotes(t, from, to, (beat, pitch, dur, vel, slide) => evs.push({ inst, time: (beat - from) * spb, note: pitch, dur: dur * spb, vel, slide }));
  evs.sort((a, b) => a.time - b.time);
  // Voices are created slice by slice while the render runs (suspend → schedule → resume), so only
  // the notes that are actually sounding exist in the graph. Creating every note up front made
  // the browser process thousands of idle nodes on every block: render time grew with
  // notes × song length and a full-song bounce looked stuck.
  let next = 0;
  const scheduleUntil = (sec: number) => {
    for (; next < evs.length && evs[next].time < sec; next++) {
      const e = evs[next];
      e.inst.start({ note: e.note, time: e.time, duration: e.dur, velocity: e.vel, slide: e.slide });
    }
  };
  const total = ctx.length / sr;
  scheduleUntil(SLICE + AHEAD);
  // Suspend points: voice slices, plus 50 ms steps when plug-in parameters are automated (times on
  // the render quantum, deduplicated — two suspends at one time is an error).
  const q = 128 / sr, times = new Set<number>();
  for (let k = 1; k * SLICE < total - 1e-3; k++) times.add(Math.round((k * SLICE) / q));
  if (pluginTracks.length) for (let k = 1; k * 0.05 < total - 1e-3; k++) times.add(Math.round((k * 0.05) / q));
  for (const qi of [...times].sort((a, b) => a - b)) {
    const at = qi * q;
    ctx.suspend(at).then(() => {
      scheduleUntil(at + SLICE + AHEAD);
      if (pluginTracks.length) applyPlugins(at);
      opts.onProgress?.(at / total);
      return ctx.resume();
    });
  }
  return ctx.startRendering();
}
