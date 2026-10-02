/** Integration boundary between the Part Producer and the DAW model (all edits via store.update, source never modified). */
import { midiTrack } from "../assist/tracks";
import { store } from "../model/store";
import { defaultChannel, ROLE_COLORS, uid, type Note, type Role, type Track } from "../model/types";
import { defaultParams, type Insert } from "../plugins/defs";
import { chainFor } from "../model/chains";
import { defaultPartSession, modeForRole } from "./defaults";
import type { PartInput } from "./pipeline";
import type { Mode, PartSession, PEvent, PipelineResult, Proc } from "./types";

export const partSessions = () => (store.project.partSessions ??= {});
export const getPart = (id: string | null | undefined) => (id ? store.project.partSessions?.[id] : undefined);

export function partForSelection(): PartSession | undefined {
  const ui = store.ui;
  const all = Object.values(store.project.partSessions ?? {});
  const byClip = all.find((s) => ui.selectedClipId && s.source.clipIds.includes(ui.selectedClipId));
  const t = store.project.tracks.find((x) => x.id === ui.selectedTrackId);
  const byTrack = t?.pp ? getPart(t.pp.sessionId) : undefined;
  return byClip ?? byTrack ?? getPart(ui.ppSession);
}

export function partInput(s: PartSession): PartInput {
  const p = store.project;
  const inst = s.sound.auto ? undefined : s.sound.instrument;
  return {
    mode: s.mode, source: s.source, harmony: s.harmony, clean: s.clean, rework: s.rework, groove: s.groove, seed: s.seed, layerSeeds: s.layerSeeds, locks: s.locks,
    bpm: p.bpm, projectKey: p.key, projectChords: p.chords ?? [],
    kicks: s.mode === "bass" ? kickBeats(s.source.start, s.source.length) : [],
    sections: (p.sections ?? [])
      .map((x) => ({ start: Math.max(0, x.start - s.source.start), end: Math.min(s.source.length, x.start + x.length - s.source.start), label: x.label, group: x.group, energy: x.energy }))
      .filter((x) => x.end > x.start + 1e-6)
      .map((x) => ({ start: x.start, length: x.end - x.start, label: x.label, group: x.group, energy: x.energy })),
    openShapes: !/distortion|power/.test(inst ?? "") && s.rework.style !== "power",
  };
}

/** Kick-drum onsets (GM 35/36) from the project's drum tracks inside a region, relative to its start. */
function kickBeats(start: number, length: number): number[] {
  const out: number[] = [];
  for (const t of store.project.tracks) {
    if (t.kind !== "midi" || t.pp || !(t.role === "drums" || /^(drums|abuse|kit|dpkit|multikit):/.test(t.instrument ?? ""))) continue;
    for (const c of t.clips) {
      if (c.kind !== "midi") continue;
      for (const n of c.notes) {
        if (n.pitch !== 35 && n.pitch !== 36) continue;
        const at = c.start + n.start - start;
        if (at >= 0 && at < length && n.start < c.length) out.push(Math.round(at * 1000) / 1000);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function captureNotes(trackIds: string[], start: number, length: number) {
  const notes: PartSession["source"]["notes"] = [];
  const clipIds: string[] = [];
  for (const tid of trackIds) {
    const t = store.project.tracks.find((x) => x.id === tid);
    if (!t) continue;
    for (const c of t.clips) {
      if (c.kind !== "midi" || c.start >= start + length || c.start + c.length <= start) continue;
      clipIds.push(c.id);
      for (const n of c.notes) {
        if (n.start >= c.length) continue;
        const at = c.start + n.start - start;
        if (at < 0 || at >= length) continue;
        notes.push({ pitch: n.pitch, start: at, dur: Math.min(n.dur, c.length - n.start), vel: n.vel, conf: n.conf, trackId: t.id, clipId: c.id });
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, clipIds };
}

export function createPart(opts: { trackId: string; start: number; length: number; mode?: Mode }): string {
  const t = store.project.tracks.find((x) => x.id === opts.trackId)!;
  const { notes, clipIds } = captureNotes([t.id], opts.start, opts.length);
  const id = uid("pps");
  const mode = opts.mode ?? modeForRole(t.role);
  const s = defaultPartSession(id, mode, { name: t.name, trackIds: [t.id], clipIds, start: opts.start, length: opts.length, bpm: store.project.bpm, notes, role: t.role, instrument: t.instrument }, Math.floor(Date.now() % 100000) + 1);
  store.update((p) => {
    (p.partSessions ??= {})[id] = s;
  });
  store.setUi({ ppSession: id, showEditor: true, editorTab: "parts" });
  store.log(`Part Producer: captured ${notes.length} notes from "${t.name}" as ${mode}, ${opts.length / 4} bars`);
  return id;
}

export function updatePart(id: string, fn: (s: PartSession) => void) {
  store.update((p) => {
    const s = p.partSessions?.[id];
    if (s) fn(s);
  });
}

export function resetPart(id: string) {
  updatePart(id, (s) => {
    const d = defaultPartSession(s.id, s.mode, s.source, s.seed);
    Object.assign(s, { ...d, applied: s.applied, created: s.created });
  });
}

export function setMode(id: string, mode: Mode) {
  updatePart(id, (s) => {
    const d = defaultPartSession(s.id, mode, s.source, s.seed);
    Object.assign(s, { ...d, applied: s.applied, created: s.created, harmony: s.harmony, locks: { events: [] } });
  });
}

export function deletePart(id: string) {
  store.update((p) => {
    delete p.partSessions?.[id];
  });
  if (store.ui.ppSession === id) store.setUi({ ppSession: null });
}

export const effectiveSound = (s: PartSession, r: PipelineResult | null) => (s.sound.auto && r ? { instrument: r.sound.instrument, proc: r.sound.proc } : { instrument: s.sound.instrument, proc: s.sound.proc });

export function toNotes(events: PEvent[], lengthBeats: number): Note[] {
  return events
    .map((e) => {
      const start = Math.max(0, Math.min(lengthBeats - 1e-3, e.start + e.micro));
      return { pitch: e.pitch, start, dur: Math.max(0.02, Math.min(e.dur, lengthBeats - start)), vel: Math.max(1, Math.min(127, Math.round(e.vel))) };
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

const ROLE_OF: Record<Mode, Role> = { keys: "keys", line: "lead", guitar: "guitar", bass: "bass" };

function procInto(t: Track, proc: Proc, keyBase: string) {
  const ch = t.ch;
  ch.hpf = proc.eq.on ? proc.eq.hpf : 0;
  ch.eqLow = proc.eq.on ? proc.eq.low : 0;
  ch.eqLowFreq = 150;
  ch.eqHigh = proc.eq.on ? proc.eq.high : 0;
  ch.eqHighFreq = 6000;
  ch.lpf = proc.eq.on ? proc.eq.lpf : 0;
  ch.volumeDb = proc.level;
  ch.reverbSend = proc.send.on ? proc.send.amount : 0;
  const own = (t.inserts ?? []).filter((i) => !i.id.startsWith("pp-"));
  // An instrument with a pro-mix chain (e.g. the sampled bass) brings its own EQ + dynamics;
  // the part's level, delay and send still apply on top.
  const chain = chainFor(t.instrument);
  if (chain && proc.eq.on) {
    Object.assign(ch, { hpf: 0, eqLow: 0, eqHigh: 0, lpf: 0, ...chain.ch, volumeDb: proc.level });
  }
  const ins: Insert[] = [
    ...(chain ? chain.inserts().map((i, k) => ({ ...i, id: `pp-chain${k}-${keyBase}` })) : [{ id: `pp-comp-${keyBase}`, type: "compressor" as const, on: proc.comp.on, params: { ...defaultParams("compressor"), threshold: proc.comp.threshold, ratio: proc.comp.ratio, attack: proc.comp.attack, release: 150 } }]),
    { id: `pp-delay-${keyBase}`, type: "delay", on: proc.delay.on, params: { ...defaultParams("delay"), div: proc.delay.div, feedback: proc.delay.feedback, mix: proc.delay.mix } },
  ];
  t.inserts = [...ins, ...own];
}

/** One ephemeral preview track for auditioning (stable id → the instrument is reused). */
export function previewTrack(s: PartSession, r: PipelineResult): Track {
  const snd = effectiveSound(s, r);
  const t: Track = { id: "pp-preview", name: "preview", kind: "midi", role: ROLE_OF[s.mode], color: ROLE_COLORS[ROLE_OF[s.mode]], instrument: snd.instrument, clips: [{ id: "pp-preview-clip", kind: "midi", start: s.source.start, length: r.lengthBeats, notes: toNotes(r.final, r.lengthBeats) }], ch: defaultChannel(), inserts: [] };
  if (s.sound.on) procInto(t, snd.proc, "preview");
  else t.instrument = s.source.instrument ?? snd.instrument;
  return t;
}

export function applyPart(id: string, r: PipelineResult) {
  const s0 = getPart(id);
  if (!s0) return;
  const snd = effectiveSound(s0, r);
  store.update((p) => {
    const s = p.partSessions![id];
    if (s.sound.auto) { s.sound.instrument = snd.instrument; s.sound.proc = structuredClone(snd.proc); }
    let t = s.applied ? p.tracks.find((x) => x.id === s.applied!.trackId) : undefined;
    if (!t) {
      const style = s.rework.on ? s.rework.style : "clean";
      t = midiTrack(`PP ${s.source.name} · ${style}`, ROLE_OF[s.mode], []);
      const at = Math.max(...s.source.trackIds.map((tid) => p.tracks.findIndex((x) => x.id === tid)));
      p.tracks.splice(at >= 0 ? at + 1 : p.tracks.length, 0, t);
    }
    t.instrument = s.sound.on ? snd.instrument : s.source.instrument ?? snd.instrument;
    t.pp = { sessionId: id };
    t.clips = [{ id: uid("clip"), kind: "midi", start: s.source.start, length: r.lengthBeats, notes: toNotes(r.final, r.lengthBeats) }];
    if (s.sound.on) procInto(t, snd.proc, t.id);
    const muted = [...(s.applied?.mutedSource ?? [])];
    if (s.muteSourceOnApply)
      for (const tid of s.source.trackIds) {
        const src = p.tracks.find((x) => x.id === tid);
        if (src && !src.ch.mute) { src.ch.mute = true; muted.push(tid); }
      }
    s.applied = { trackId: t.id, at: Date.now(), variant: r.chosen, seed: s.seed, algo: r.algo, mutedSource: muted };
  });
  store.log(`Part Producer: applied ${r.final.length} notes (${r.variants[r.chosen]?.name ?? "result"}, seed ${s0.seed}, ${r.algo})`);
}

export function revertPart(id: string) {
  store.update((p) => {
    const s = p.partSessions?.[id];
    if (!s?.applied) return;
    p.tracks = p.tracks.filter((t) => t.id !== s.applied!.trackId);
    for (const tid of s.applied.mutedSource) {
      const t = p.tracks.find((x) => x.id === tid);
      if (t) t.ch.mute = false;
    }
    delete s.applied;
  });
}
