/** Auto-arrange: choose layers per style, play each layer only in sections its rule allows. */
import { store } from "../../model/store";
import type { MidiClip, Note, Project, Role, Section, Track } from "../../model/types";
import { midiTrack } from "../tracks";
import { allNotes, audioClipsForSections, mergeAdjacent, midiClipsForSections } from "./clips";
import { CH, generateBassFromChords, generateDrums, generatePad, generatePianoChords, K, SHAKER } from "./generators";

export type ArrangeStyle = "remix" | "enhance" | "minimal";

export const STYLE_INFO: Record<ArrangeStyle, string> = {
  remix: "Re-produce: keep the vocal stem, replace everything else with MIDI instruments + generated drums/pad",
  enhance: "Keep all stems, layer generated drums, pad and MIDI doubles underneath",
  minimal: "Stripped: vocals + piano chords + pad, light percussion only in choruses",
};

/** Which sections a layer plays in, as a function of section energy. */
type Rule = (s: Section) => boolean;
const always: Rule = () => true;
const minE = (e: number): Rule => (s) => s.energy >= e;
const labels = (...ls: string[]): Rule => (s) => ls.includes(s.label);

interface Layer {
  role: Role;
  name: string;
  source: Track | null; // existing track to re-use (null = generated)
  notes?: Note[];
  instrument?: string;
  rule: Rule;
}

export function autoArrange(style: ArrangeStyle) {
  const p = store.project;
  if (!p.sections.length) throw new Error("Split stems of the full mix first (sections and chords come from that analysis)");
  const spb = 60 / p.bpm;
  // Source material: stems, and any MIDI conversions the user made (not previously generated "Gen" tracks).
  const own = (t: Track) => !t.name.startsWith("Gen");
  const byRole = (r: Role, kind: "audio" | "midi") => p.tracks.find((t) => t.role === r && t.kind === kind && own(t));
  const mix = p.tracks.find((t) => t.role === "mix") ?? null;
  const stem = { drums: byRole("drums", "audio"), bass: byRole("bass", "audio"), vocals: byRole("vocals", "audio"), other: byRole("other", "audio") };
  const midi = { bass: byRole("bass", "midi"), lead: byRole("lead", "midi"), keys: byRole("keys", "midi"), drums: byRole("drums", "midi") };

  // Converted drums replace the generated groove when there's enough of them.
  const drums = midi.drums && allNotes(midi.drums).length > 32 ? allNotes(midi.drums) : generateDrums(p.sections);
  const pad = generatePad(p.chords);
  const transcribedBass = midi.bass ? allNotes(midi.bass) : [];
  const bassNotes = transcribedBass.length > 16 ? transcribedBass : generateBassFromChords(p.chords, p.sections);
  const keysNotes = midi.keys && allNotes(midi.keys).length > 16 ? allNotes(midi.keys) : generatePianoChords(p.chords, p.sections);

  const layers: Layer[] = [];
  if (style === "remix") {
    layers.push(
      { role: "vocals", name: "Vocals (stem)", source: stem.vocals ?? null, rule: always },
      { role: "drums", name: "Gen Drums", source: null, notes: drums, instrument: "kit:acoustic", rule: minE(0) },
      { role: "bass", name: "Gen Bass", source: null, notes: bassNotes, instrument: "synth:moog-bass", rule: minE(1) },
      { role: "keys", name: "Gen Keys", source: null, notes: keysNotes, instrument: "piano:splendid", rule: always },
      { role: "pad", name: "Gen Pad", source: null, notes: pad, instrument: "synth:string-pad", rule: (s) => s.energy !== 2 || s.label === "Build" },
    );
    if (midi.lead) layers.push({ role: "lead", name: "Gen Lead (vocal double)", source: null, notes: allNotes(midi.lead), instrument: "synth:pluck", rule: labels("Chorus") });
  } else if (style === "enhance") {
    layers.push(
      { role: "drums", name: "Drums (stem)", source: stem.drums ?? null, rule: always },
      { role: "bass", name: "Bass (stem)", source: stem.bass ?? null, rule: always },
      { role: "vocals", name: "Vocals (stem)", source: stem.vocals ?? null, rule: always },
      { role: "other", name: "Other (stem)", source: stem.other ?? null, rule: always },
      ...p.tracks.filter((t) => t.kind === "audio" && own(t) && (t.role === "guitar" || t.role === "piano")).map((t) => ({ role: t.role, name: t.name, source: t, rule: always })),
      { role: "drums", name: "Gen Drums (layer)", source: null, notes: drums, instrument: "abuse:roland-tr-909", rule: minE(2) },
      { role: "bass", name: "Gen Sub (layer)", source: null, notes: bassNotes, instrument: "synth:sub-bass", rule: minE(2) },
      { role: "pad", name: "Gen Pad", source: null, notes: pad, instrument: "synth:glass-pad", rule: always },
    );
  } else {
    layers.push(
      { role: "vocals", name: "Vocals (stem)", source: stem.vocals ?? null, rule: always },
      { role: "keys", name: "Gen Piano", source: null, notes: generatePianoChords(p.chords, p.sections), instrument: "piano:splendid", rule: always },
      { role: "pad", name: "Gen Strings", source: null, notes: pad, instrument: "sf:string_ensemble_1", rule: minE(2) },
      { role: "drums", name: "Gen Perc", source: null, notes: drums.filter((n) => [K, SHAKER, CH].includes(n.pitch)), instrument: "drums:LM-2", rule: labels("Chorus") },
    );
  }

  const newTracks: Track[] = [];
  if (mix) newTracks.push({ ...mix, ch: { ...mix.ch, mute: true, solo: false } });
  for (const L of layers) {
    const secs = p.sections.filter(L.rule);
    if (L.source && L.source.kind === "audio") {
      newTracks.push({ ...L.source, ch: { ...L.source.ch, mute: false }, clips: mergeAdjacent(audioClipsForSections(L.source, secs, spb), spb) });
    } else if (L.notes) {
      newTracks.push(midiTrack(L.name, L.role, mergeAdjacent(midiClipsForSections(L.notes, secs), spb) as MidiClip[], L.instrument));
    }
  }
  // Nothing the user made is dropped: every other track stays — buses and kit mics untouched
  // (they're routing), other source tracks muted. Previous "Gen" layers are replaced.
  for (const t of p.tracks) {
    if (newTracks.some((n) => n.id === t.id) || (own(t) === false && t.kind === "midi")) continue;
    if (t.kind === "bus") newTracks.push(t);
    else if (t.kind === "aux") continue; // re-attached below to their (kept) owners by syncAuxTracks
    else newTracks.push({ ...t, ch: { ...t.ch, mute: true } });
  }
  for (const t of p.tracks) if (t.kind === "aux" && newTracks.some((n) => n.id === t.auxOf)) newTracks.push(t);

  store.update((pp: Project) => {
    pp.tracks = newTracks;
  });
  store.log(`Auto-arranged (${style}): ${layers.length} layers across ${p.sections.length} sections`);
}
