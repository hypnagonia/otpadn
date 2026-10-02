/**
 * Integration boundary between the Drum Producer and the DAW model. All project changes go
 * through store.update (one undo step each); the source clips are never modified.
 */
import { ACOUSTIC_KIT, fitVelocities, isAcoustic } from "./acoustic";
import { midiTrack } from "../assist/tracks";
import { store } from "../model/store";
import { defaultChannel, uid, type MidiClip, type Note, type Project, type Track } from "../model/types";
import { defaultParams, type Insert } from "../plugins/defs";
import { defaultSession } from "./defaults";
import { OUTPUT_LABEL, OUTPUTS, VOICE_INFO, type DEvent, type DrumSession, type Output, type OutputProc, type PipelineResult, type SrcNote } from "./types";

export const OUTPUT_COLOR: Record<Output, string> = { kick: "#e0a43a", backbeat: "#d9534f", hats: "#4aa3df", perc: "#a66cd9" };

export const sessions = (p: Project = store.project) => (p.drumSessions ??= {});
export const getSession = (id: string | null | undefined) => (id ? store.project.drumSessions?.[id] : undefined);

/** Session to show for the current selection: explicit, or one whose source/applied tracks contain the selection. */
export function sessionForSelection(): DrumSession | undefined {
  const ui = store.ui;
  const all = Object.values(store.project.drumSessions ?? {});
  const explicit = getSession(ui.dpSession);
  const byClip = all.find((s) => ui.selectedClipId && s.source.clipIds.includes(ui.selectedClipId));
  const track = store.project.tracks.find((t) => t.id === ui.selectedTrackId);
  const byTrack = track?.dp ? getSession(track.dp.sessionId) : undefined;
  return byClip ?? byTrack ?? explicit;
}

/** Notes of the given tracks inside [start, start+length), relative to start. */
export function captureNotes(trackIds: string[], start: number, length: number): { notes: SrcNote[]; clipIds: string[] } {
  const notes: SrcNote[] = [];
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
        notes.push({ pitch: n.pitch, start: at, dur: n.dur, vel: n.vel, conf: n.conf, trackId: t.id, clipId: c.id });
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, clipIds };
}

/** Drum-ish MIDI tracks (role drums or a drum instrument), for the "merge several drum tracks" option. */
export const drumTracks = () => store.project.tracks.filter((t) => t.kind === "midi" && !t.dp && (t.role === "drums" || /^(drums|abuse|kit|dpkit):/.test(t.instrument ?? "")));

export function createSession(opts: { trackIds: string[]; start: number; length: number; name: string }): string {
  const { notes, clipIds } = captureNotes(opts.trackIds, opts.start, opts.length);
  const id = uid("dps");
  const s = defaultSession(id, { name: opts.name, trackIds: opts.trackIds, clipIds, start: opts.start, length: opts.length, bpm: store.project.bpm, notes }, { seed: Math.floor(Date.now() % 100000) + 1 });
  store.update((p) => {
    sessions(p)[id] = s;
  });
  store.setUi({ dpSession: id, showEditor: true, editorTab: "drums" });
  store.log(`Drum Producer: captured ${notes.length} notes from ${opts.trackIds.length} track(s), ${opts.length / 4} bars`);
  return id;
}

export function updateSession(id: string, fn: (s: DrumSession) => void) {
  store.update((p) => {
    const s = p.drumSessions?.[id];
    if (s) fn(s);
  });
}

/** Back to defaults (source, mapping review state and applied tracks are kept). */
export function resetSession(id: string) {
  updateSession(id, (s) => {
    const d = defaultSession(s.id, s.source, { style: s.rework.style, seed: s.seed });
    Object.assign(s, { ...d, applied: s.applied, mapping: d.mapping, created: s.created });
  });
}

export function deleteSession(id: string) {
  store.update((p) => {
    delete p.drumSessions?.[id];
  });
  if (store.ui.dpSession === id) store.setUi({ dpSession: null });
}

export function toNotes(events: DEvent[], lengthBeats: number): Note[] {
  return events
    .map((e) => ({ pitch: VOICE_INFO[e.voice].gm, start: Math.max(0, Math.min(lengthBeats - 1e-3, e.start + e.micro)), dur: e.dur, vel: Math.max(1, Math.min(127, Math.round(e.vel))) }))
    .sort((a, b) => a.start - b.start);
}

/** Channel settings + inserts for one output's processing plan (each stage switchable). */
function procInto(t: Track, proc: OutputProc | undefined, keyBase: string) {
  const ch = t.ch;
  const eqOn = !!proc?.eq.on;
  ch.hpf = eqOn ? proc!.eq.hpf : 0;
  ch.eqLow = eqOn ? proc!.eq.low : 0;
  ch.eqLowFreq = 100;
  ch.eqHigh = eqOn ? proc!.eq.high : 0;
  ch.eqHighFreq = 8000;
  ch.volumeDb = proc?.level ?? 0;
  ch.reverbSend = proc?.send.on ? proc.send.amount : 0;
  const own = (t.inserts ?? []).filter((i) => !i.id.startsWith("dp-"));
  const ins: Insert[] = [];
  if (proc) {
    ins.push({ id: `dp-sat-${keyBase}`, type: "saturator", on: proc.sat.on, params: { ...defaultParams("saturator"), drive: Math.round(proc.sat.drive * 18 * 2) / 2, tone: 14000 } });
    ins.push({ id: `dp-comp-${keyBase}`, type: "compressor", on: proc.comp.on, params: { ...defaultParams("compressor"), threshold: proc.comp.threshold, ratio: proc.comp.ratio, attack: proc.comp.attack, release: 120, knee: 6 } });
  }
  t.inserts = [...ins, ...own];
}

/** The sound actually in effect: the automatic pick for this result, or the user's settings. */
export const effectiveSound = (s: DrumSession, r: PipelineResult | null): DrumSession => (s.sound.auto && r ? { ...s, sound: { ...s.sound, kit: r.sound.kit, outputs: r.sound.outputs } } : s);

/** Ephemeral per-output tracks for auditioning (not in the project, stable ids → instruments reused). */
export function previewTracks(s: DrumSession, r: PipelineResult): Track[] {
  if (s.rework.on && isAcoustic(s.rework.style)) {
    const clip: MidiClip = { id: "dp-preview-clip-kit", kind: "midi", start: s.source.start, length: r.lengthBeats, notes: fitVelocities(toNotes(r.final, r.lengthBeats), s.seed) };
    return [{ id: "dp-preview-kit", name: "preview kit", kind: "midi", role: "drums", color: OUTPUT_COLOR.kick, instrument: ACOUSTIC_KIT, clips: [clip], ch: { ...defaultChannel(), volumeDb: -3 }, inserts: [] }];
  }
  const out: Track[] = [];
  for (const o of OUTPUTS) {
    const evs = r.final.filter((e) => VOICE_INFO[e.voice].out === o);
    if (!evs.length) continue;
    const clip: MidiClip = { id: `dp-preview-clip-${o}`, kind: "midi", start: s.source.start, length: r.lengthBeats, notes: toNotes(evs, r.lengthBeats) };
    const t: Track = { id: `dp-preview-${o}`, name: `preview ${OUTPUT_LABEL[o]}`, kind: "midi", role: "drums", color: OUTPUT_COLOR[o], instrument: `dpkit:${s.sound.kit.kitId}`, drumKit: s.sound.kit, clips: [clip], ch: defaultChannel(), inserts: [] };
    if (s.sound.on) procInto(t, s.sound.outputs[o], `preview-${o}`);
    else t.ch.volumeDb = -4;
    out.push(t);
  }
  return out;
}

/** Write the chosen result as editable per-output MIDI tracks (updates them if already applied). */
export function applySession(id: string, r: PipelineResult, sound?: Pick<DrumSession["sound"], "kit" | "outputs">) {
  const before = getSession(id);
  if (!before) return;
  store.update((p) => {
    const s = p.drumSessions![id];
    // Store exactly what gets applied (an automatic kit pick becomes concrete settings).
    if (sound) {
      s.sound.kit = structuredClone(sound.kit);
      s.sound.outputs = structuredClone(sound.outputs);
    }
    const tracks = { ...(s.applied?.tracks ?? {}) };
    const srcIdx = Math.max(-1, ...s.source.trackIds.map((tid) => p.tracks.findIndex((t) => t.id === tid)));
    let insertAt = srcIdx >= 0 ? srcIdx + 1 : p.tracks.length;
    if (s.rework.on && isAcoustic(s.rework.style)) {
      // Acoustic kit: one drum track on the multitrack kit (its mic tracks appear under it).
      for (const [o, tid] of Object.entries(tracks)) if (o !== "kick") { p.tracks = p.tracks.filter((x) => x.id !== tid); delete tracks[o as keyof typeof tracks]; }
      let t = tracks.kick ? p.tracks.find((x) => x.id === tracks.kick) : undefined;
      if (!t) {
        t = midiTrack(`DP drums · ${s.rework.style}`, "drums", []);
        p.tracks.splice(insertAt, 0, t);
        tracks.kick = t.id;
      }
      t.instrument = ACOUSTIC_KIT;
      delete t.drumKit;
      t.dp = { sessionId: id, output: "kick" };
      t.clips = [{ id: uid("clip"), kind: "midi", start: s.source.start, length: r.lengthBeats, notes: fitVelocities(toNotes(r.final, r.lengthBeats), s.seed) }];
    } else
    for (const o of OUTPUTS) {
      const evs = r.final.filter((e) => VOICE_INFO[e.voice].out === o);
      let t = tracks[o] ? p.tracks.find((x) => x.id === tracks[o]) : undefined;
      if (!evs.length && !t) continue;
      if (!t) {
        t = midiTrack(`DP ${OUTPUT_LABEL[o]} · ${s.rework.on ? s.rework.style : "clean"}`, "drums", []);
        t.color = OUTPUT_COLOR[o];
        p.tracks.splice(insertAt, 0, t);
        tracks[o] = t.id;
      }
      insertAt = p.tracks.indexOf(t) + 1;
      t.instrument = `dpkit:${s.sound.kit.kitId}`;
      t.drumKit = structuredClone(s.sound.kit);
      t.dp = { sessionId: id, output: o };
      t.clips = [{ id: uid("clip"), kind: "midi", start: s.source.start, length: r.lengthBeats, notes: toNotes(evs, r.lengthBeats) }];
      if (s.sound.on) procInto(t, s.sound.outputs[o], t.id);
    }
    const muted = [...(s.applied?.mutedSource ?? [])];
    if (s.muteSourceOnApply)
      for (const tid of s.source.trackIds) {
        const t = p.tracks.find((x) => x.id === tid);
        if (t && !t.ch.mute) {
          t.ch.mute = true;
          muted.push(tid);
        }
      }
    s.applied = { tracks, at: Date.now(), variant: r.chosen, seed: s.seed, layerSeeds: { ...s.layerSeeds }, algo: r.algo, mutedSource: muted };
  });
  const n = r.final.length;
  store.log(`Drum Producer: applied ${n} hits (${r.variants[r.chosen]?.name ?? "result"}, seed ${before.seed}, ${r.algo}) to ${Object.keys(getSession(id)!.applied!.tracks).length} tracks`);
}

/** Remove applied tracks and unmute the source: back to the original part (one undo step). */
export function revertApplied(id: string) {
  store.update((p) => {
    const s = p.drumSessions?.[id];
    if (!s?.applied) return;
    const ids = new Set(Object.values(s.applied.tracks));
    p.tracks = p.tracks.filter((t) => !ids.has(t.id));
    for (const tid of s.applied.mutedSource) {
      const t = p.tracks.find((x) => x.id === tid);
      if (t) t.ch.mute = false;
    }
    delete s.applied;
  });
}
