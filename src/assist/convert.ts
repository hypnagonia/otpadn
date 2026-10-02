/**
 * "Convert to MIDI": MuScriptor multi-instrument transcription of any audio track
 * (WebGPU, src/ml/muscriptor.ts). Creates one MIDI track per instrument it hears, placed
 * right under the source track, each with a fitting Otpadn sound.
 */
import type { Grid } from "../analysis/grid";
import { notesToBeats } from "../analysis/notes";
import { muscriptorGpu, to16kMono, transcribeMuscriptor, type MuscriptorModel, type TranscribedNote } from "../ml/muscriptor";
import { store } from "../model/store";
import { uid, type AudioClip, type MidiClip, type Role, type Track } from "../model/types";
import { audioSource } from "./separate";
import { audioTrack, midiTrack, registerBuffer } from "./tracks";
import { bufferSources } from "../model/store";
import { savePcm } from "../io/persist";

/** MuScriptor instrument group → Otpadn role + default sound. */
const GROUPS: Record<string, { role: Role; sound: string; label: string }> = {
  drums: { role: "drums", sound: "kit:acoustic", label: "Drums" },
  electric_bass: { role: "bass", sound: "sampled:bass-fingered", label: "Electric Bass" },
  acoustic_bass: { role: "bass", sound: "sf:acoustic_bass", label: "Acoustic Bass" },
  contrabass: { role: "bass", sound: "smolken:Pizzicato", label: "Contrabass" },
  acoustic_guitar: { role: "guitar", sound: "sampled:acoustic-martin", label: "Acoustic Guitar" },
  clean_electric_guitar: { role: "guitar", sound: "sampled:egtr-clean", label: "Clean Guitar" },
  distorted_electric_guitar: { role: "guitar", sound: "sampled:egtr-highgain", label: "Distorted Guitar" },
  acoustic_piano: { role: "piano", sound: "piano:splendid", label: "Piano" },
  electric_piano: { role: "keys", sound: "ep:WurlitzerEP200", label: "Electric Piano" },
  organ: { role: "keys", sound: "sf:drawbar_organ", label: "Organ" },
  chromatic_percussion: { role: "keys", sound: "sf:vibraphone", label: "Mallets" },
  voice: { role: "lead", sound: "synth:square-lead", label: "Vocal Melody" },
  synth_lead: { role: "lead", sound: "synth:supersaw", label: "Synth Lead" },
  synth_pad: { role: "pad", sound: "synth:glass-pad", label: "Synth Pad" },
  string_ensemble: { role: "pad", sound: "sf:string_ensemble_1", label: "Strings" },
  synth_strings: { role: "pad", sound: "synth:string-pad", label: "Synth Strings" },
  violin: { role: "lead", sound: "sf:violin", label: "Violin" },
  viola: { role: "lead", sound: "sf:violin", label: "Viola" },
  cello: { role: "bass", sound: "sf:cello", label: "Cello" },
  brass_section: { role: "lead", sound: "sf:brass_section", label: "Brass" },
  trumpet: { role: "lead", sound: "sf:trumpet", label: "Trumpet" },
  trombone: { role: "lead", sound: "sf:brass_section", label: "Trombone" },
  tuba: { role: "bass", sound: "sf:brass_section", label: "Tuba" },
  french_horn: { role: "lead", sound: "sf:brass_section", label: "Horn" },
  soprano_and_alto_sax: { role: "lead", sound: "sf:alto_sax", label: "Sax" },
  tenor_sax: { role: "lead", sound: "sf:alto_sax", label: "Tenor Sax" },
  baritone_sax: { role: "lead", sound: "sf:alto_sax", label: "Baritone Sax" },
  flutes: { role: "lead", sound: "sf:flute", label: "Flute" },
  clarinet: { role: "lead", sound: "sf:flute", label: "Clarinet" },
  oboe: { role: "lead", sound: "sf:flute", label: "Oboe" },
  english_horn: { role: "lead", sound: "sf:flute", label: "English Horn" },
  bassoon: { role: "bass", sound: "sf:cello", label: "Bassoon" },
  orchestral_harp: { role: "keys", sound: "sf:vibraphone", label: "Harp" },
  timpani: { role: "drums", sound: "kit:acoustic", label: "Timpani" },
  orchestra_hit: { role: "keys", sound: "sf:string_ensemble_1", label: "Orchestra Hit" },
};

/** What a stem's role should restrict MuScriptor to (null = everything). */
/**
 * What the model listens for on a stem. Exactly ONE instrument where the stem is one: asked for
 * several related classes at once (electric / acoustic bass / contrabass) the model reports the
 * same line once per class, at different octaves — a bass stem came back doubled and polyphonic.
 * Guitar / piano stems really vary, so the family is asked and the dominant class is kept.
 */
const RESTRICT: Partial<Record<Role, string[]>> = {
  drums: ["drums"],
  bass: ["electric_bass"],
  vocals: ["voice"],
  guitar: ["acoustic_guitar", "clean_electric_guitar", "distorted_electric_guitar"],
  piano: ["acoustic_piano", "electric_piano"],
};

export interface ConvertOptions {
  model?: MuscriptorModel;
  /** Second pass with chunk boundaries shifted 2.5 s; notes it finds that pass 1 missed are added. */
  thorough?: boolean;
  /** Listen only for the source stem's instrument family (default true for stems). */
  restrict?: boolean;
  /** Extra vocal pass (default: on for full mixes and vocal stems). */
  vocals?: boolean;
}

export async function convertToMidi(trackId?: string | null, opts: ConvertOptions = {}) {
  const { track, clip, buffer } = audioSource(trackId);
  const p = store.project;
  const spb = 60 / p.bpm;
  const grid: Grid = { bpm: p.bpm, spb, clipStartBeat: clip.start - clip.offset / spb, durationSec: buffer.duration };
  const restrict = opts.restrict ?? track.role !== "mix";
  const instruments = restrict ? RESTRICT[track.role] ?? null : null;
  const vocals = opts.vocals ?? (instruments === null || track.role === "vocals");
  const t0 = performance.now();

  const label = (detail?: string) => `Audio → MIDI · input: "${track.name}" (${track.role === "mix" ? "full mix" : `${track.role} stem`})${muscriptorGpu ? ` · ${muscriptorGpu}` : ""}${detail ? " · " + detail : ""}`;
  const thorough = opts.thorough ?? true;
  const passes = thorough ? 2 : 1;
  const samples = await to16kMono(buffer);
  const run = (offset: number, pass: number) =>
    transcribeMuscriptor(buffer, { model: opts.model ?? "small", instruments, vocals, samples, offset }, (pr) => {
      if (pr.phase === "download") store.busy(`Downloading the audio → MIDI model (once)${pr.detail ? " · " + pr.detail : ""}`, pr.progress ?? 0);
      else if (pr.phase === "gpu") store.busy("Starting audio → MIDI on the GPU…", pr.progress ?? 0);
      else store.busy(label(`${passes > 1 ? `pass ${pass}/${passes} · ` : ""}${pr.detail ?? ""}`), ((pass - 1) + (pr.progress ?? 0)) / passes);
    });
  const first = await run(0, 1);
  // The model's recall depends on where a 5 s chunk starts: a pass on a grid shifted by half a
  // chunk catches notes that straddled boundaries. Only notes pass 1 didn't have are added.
  const extra = thorough ? missingFrom(first, await run(2.5, 2)) : [];
  const env = energyEnvelope(samples);
  const raw: TranscribedNote[] = [...first, ...extra].filter((n) => audible(env, n));
  const gated = first.length + extra.length - raw.length;

  // One MIDI track per instrument, in a stable musical order. A stem is ONE instrument: the model
  // may split a bass line across electric / acoustic / contrabass — merge into a single track
  // (same pitch overlapping → one note), named after the stem.
  const byInst = new Map<string, TranscribedNote[]>();
  // Family-conditioned stems (guitar / piano): keep the instrument the model heard most.
  let merged = raw;
  if (restrict && instruments && instruments.length > 1 && raw.length) {
    const dur = new Map<string, number>();
    for (const n of raw) dur.set(n.instrument, (dur.get(n.instrument) ?? 0) + (n.end - n.start));
    const top = [...dur.entries()].sort((a, b) => b[1] - a[1])[0][0];
    merged = raw.filter((n) => n.instrument === top);
  }
  for (const n of merged) {
    const arr = byInst.get(n.instrument);
    if (arr) arr.push(n);
    else byInst.set(n.instrument, [n]);
  }
  const order = Object.keys(GROUPS);
  const insts = [...byInst.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const end = grid.clipStartBeat + buffer.duration / spb;
  const tracks: Track[] = [];
  for (const inst of insts) {
    const g = GROUPS[inst] ?? { role: "keys" as Role, sound: "piano:splendid", label: inst.replace(/_/g, " ") };
    const drums = inst === "drums";
    const notes = notesToBeats(
      byInst.get(inst)!.map((n) => ({ startSec: n.start, durSec: n.end - n.start, pitch: n.pitch, amp: 0.75 })),
      grid,
      { min: 0, max: 127, mono: false, quantize: 0, minDurBeats: 0 },
    ).map((n) => (drums ? { ...n, dur: 0.25 } : n));
    if (!notes.length) continue;
    const midiClip: MidiClip = { id: uid("clip"), kind: "midi", start: 0, length: Math.ceil(end / 4) * 4, notes, anchored: true };
    tracks.push(midiTrack(insts.length === 1 && track.role !== "mix" ? `${track.name} → MIDI` : g.label, g.role, [midiClip], g.sound));
  }
  if (!tracks.length) {
    store.busy(null);
    store.log(`Audio → MIDI found no notes in ${track.name}`);
    return;
  }
  // Transparency: the exact audio the model transcribed (16 kHz mono, as passed in), as a muted
  // track under the source — solo it to hear precisely what was converted.
  const heard = new AudioBuffer({ numberOfChannels: 1, length: samples.length, sampleRate: 16000 });
  heard.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const heardId = await registerBuffer(heard);
  bufferSources.set(heardId, { type: "recorded" });
  void savePcm(heardId, heard);
  const inputTrack = audioTrack(`${track.name} · model input`, "other", heardId, 0);
  inputTrack.clips[0] = { ...(inputTrack.clips[0] as AudioClip), start: clip.start, offset: clip.offset, duration: Math.min(heard.duration - clip.offset, clip.duration) };
  inputTrack.ch.mute = true;
  inputTrack.color = "#6c6f76";
  let pk = 0, ss = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > pk) pk = a; ss += samples[i] * samples[i]; }
  const inputInfo = `model input = "${track.name}" (${track.role === "mix" ? "full mix" : `${track.role} stem`}) · ${(samples.length / 16000).toFixed(1)} s · peak ${(20 * Math.log10(pk + 1e-9)).toFixed(1)} dBFS · rms ${(10 * Math.log10(ss / Math.max(1, samples.length) + 1e-12)).toFixed(1)} dBFS · listening for ${instruments ? instruments.join(", ") : "all instruments"}`;
  store.update((pp) => {
    const i = pp.tracks.findIndex((x) => x.id === track.id);
    pp.tracks.splice(i + 1, 0, inputTrack, ...tracks);
  });
  store.log(`Audio → MIDI ${inputInfo} — solo the "${inputTrack.name}" track to hear exactly what was transcribed`);
  store.setUi({ selectedTrackId: tracks[0].id, selectedClipId: tracks[0].clips[0].id });
  store.log(
    `Audio → MIDI: ${track.name} → ${tracks.map((t) => `${t.name} (${(t.clips[0] as MidiClip).notes.length})`).join(", ")} in ${((performance.now() - t0) / 1000).toFixed(1)} s [${muscriptorGpu}]` +
      `${thorough ? ` · +${extra.length} from the shifted pass` : ""}${gated ? ` · ${gated} dropped over silence` : ""}`,
  );
  store.busy(null);
}

/* ── quality filters ─────────────────────────────────────────────────────── */


const ENV_HOP = 160; // 10 ms at 16 kHz

/** RMS per 10 ms frame (dBFS) + a song-relative silence threshold. */
function energyEnvelope(x: Float32Array): { db: Float32Array; floor: number } {
  const n = Math.ceil(x.length / ENV_HOP);
  const db = new Float32Array(n);
  let sum = 0, cnt = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    const a = f * ENV_HOP, b = Math.min(x.length, a + ENV_HOP);
    for (let i = a; i < b; i++) e += x[i] * x[i];
    const ms = e / Math.max(1, b - a);
    db[f] = 10 * Math.log10(ms + 1e-12);
    if (ms > 1e-7) { sum += ms; cnt++; }
  }
  const songDb = cnt ? 10 * Math.log10(sum / cnt) : -90;
  // Silence: 40 dB under the song's average loudness, but never above -50 dBFS.
  return { db, floor: Math.min(-50, songDb - 40) };
}

/** Keep a note only if the source has sound where it starts (kills notes over silence). */
function audible(env: { db: Float32Array; floor: number }, n: TranscribedNote): boolean {
  const drums = n.instrument === "drums";
  const a = Math.max(0, Math.floor((n.start - 0.03) * 100));
  const b = Math.min(env.db.length, Math.ceil((n.start + (drums ? 0.08 : Math.min(0.3, Math.max(0.05, n.end - n.start)))) * 100));
  let peak = -120;
  for (let f = a; f < b; f++) if (env.db[f] > peak) peak = env.db[f];
  return peak > env.floor;
}

/** Notes of `b` with no counterpart (same instrument + pitch, overlapping onset) in `a`. */
function missingFrom(a: TranscribedNote[], b: TranscribedNote[]): TranscribedNote[] {
  const idx = new Map<string, TranscribedNote[]>();
  for (const n of a) {
    const k = `${n.instrument}|${n.pitch}`;
    const arr = idx.get(k);
    if (arr) arr.push(n);
    else idx.set(k, [n]);
  }
  // The shifted pass exists to catch notes that straddle pass 1's 5 s chunk boundaries — only fill
  // there, and only where pass 1 of that instrument is silent (mid-chunk it adds octave mistakes
  // and doubled notes on top of a pass that was already right).
  const CHUNK = 5, NEAR = 0.75;
  const nearBoundary = (t: number) => { const r = t % CHUNK; return r < NEAR || r > CHUNK - NEAR; };
  const busy = (n: TranscribedNote) => a.some((m) => m.instrument === n.instrument && n.start < m.end - 0.02 && m.start < n.end - 0.02);
  return b.filter((n) => {
    if (!nearBoundary(n.start) || busy(n)) return false;
    const same = idx.get(`${n.instrument}|${n.pitch}`);
    if (!same) return true;
    return !same.some((m) => Math.abs(m.start - n.start) < 0.08 || (n.start < m.end && m.start < n.end));
  });
}
