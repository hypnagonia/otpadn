/** The instrument browser catalog and per-role defaults. Add new sounds here + in factory.ts. */
import type { Role } from "../model/types";
import type { InstrumentDef } from "./types";

const SF = (id: string, name: string, category: string): InstrumentDef => ({ id: `sf:${id}`, name, category, size: "~1–3 MB" });

export const INSTRUMENTS: InstrumentDef[] = [
  // ★ Essentials: hand-picked high-quality, thin, lazy-loaded tones
  { id: "multikit:crocell", name: "CrocellKit · multitrack (rock/metal)", category: "Essentials", size: "~17 MB" },
  { id: "kit:acoustic", name: "Studio Drums (acoustic)", category: "Essentials", size: "~8 MB" },
  { id: "abuse:roland-tr-909", name: "TR-909 (electronic)", category: "Essentials", size: "~2 MB" },
  { id: "synth:moog-bass", name: "Moog Bass", category: "Essentials", size: "0" },
  { id: "synth:acid-bass", name: "Acid Bass 303", category: "Essentials", size: "0" },
  { id: "synth:reese-bass", name: "Reese Bass", category: "Essentials", size: "0" },
  { id: "synth:string-pad", name: "Analog String Pad", category: "Essentials", size: "0" },
  { id: "synth:glass-pad", name: "Glass Pad", category: "Essentials", size: "0" },
  { id: "synth:supersaw", name: "Supersaw Lead", category: "Essentials", size: "0" },
  { id: "synth:square-lead", name: "Square Lead", category: "Essentials", size: "0" },
  { id: "pluck:acoustic", name: "Acoustic Guitar (modelled)", category: "Essentials", size: "0" },
  { id: "pluck:distortion", name: "Distortion Guitar (modelled)", category: "Essentials", size: "0" },

  { id: "dpkit:house-909", name: "DP house 909 (synth)", category: "Drums", size: "0" },
  { id: "dpkit:deep-808", name: "DP deep 808 (synth)", category: "Drums", size: "0" },
  { id: "dpkit:techno-909", name: "DP techno 909 (synth)", category: "Drums", size: "0" },
  { id: "dpkit:minimal-tight", name: "DP minimal tight (synth)", category: "Drums", size: "0" },
  { id: "drums:TR-808", name: "TR-808", category: "Drums", size: "~2 MB" },
  { id: "drums:LM-2", name: "LinnDrum LM-2", category: "Drums", size: "~1 MB" },
  { id: "drums:MFB-512", name: "MFB-512", category: "Drums", size: "<1 MB" },
  { id: "drums:Casio-RZ1", name: "Casio RZ-1", category: "Drums", size: "<1 MB" },
  { id: "drums:Roland CR-8000", name: "Roland CR-8000", category: "Drums", size: "<1 MB" },

  { id: "synth:sub-bass", name: "Sub Bass (synth)", category: "Bass", size: "0" },
  SF("electric_bass_finger", "Electric Bass (finger)", "Bass"),
  SF("electric_bass_pick", "Electric Bass (pick)", "Bass"),
  SF("fretless_bass", "Fretless Bass", "Bass"),
  SF("synth_bass_1", "Synth Bass 1", "Bass"),
  SF("acoustic_bass", "Upright Bass", "Bass"),
  { id: "smolken:Pizzicato", name: "Double Bass Pizz. (Smolken)", category: "Bass", size: "~6 MB" },

  { id: "piano:splendid", name: "Splendid Grand Piano", category: "Keys", size: "~15 MB (lazy)" },
  { id: "ep:CP80", name: "Yamaha CP80", category: "Keys", size: "~4 MB" },
  { id: "ep:WurlitzerEP200", name: "Wurlitzer EP200", category: "Keys", size: "~4 MB" },
  { id: "ep:PianetT", name: "Pianet T", category: "Keys", size: "~3 MB" },
  { id: "ep:TX81Z", name: "TX81Z FM Piano", category: "Keys", size: "~3 MB" },
  SF("drawbar_organ", "Drawbar Organ", "Keys"),
  SF("vibraphone", "Vibraphone", "Keys"),
  SF("marimba", "Marimba", "Keys"),

  SF("electric_guitar_clean", "Clean Electric Guitar", "Guitar"),
  SF("electric_guitar_jazz", "Jazz Guitar", "Guitar"),
  SF("overdriven_guitar", "Overdriven Guitar", "Guitar"),
  SF("distortion_guitar", "Distortion Guitar", "Guitar"),
  SF("acoustic_guitar_steel", "Acoustic Guitar (steel)", "Guitar"),
  SF("acoustic_guitar_nylon", "Acoustic Guitar (nylon)", "Guitar"),

  { id: "synth:warm-pad", name: "Warm Pad (synth)", category: "Pads & Strings", size: "0" },
  SF("string_ensemble_1", "String Ensemble", "Pads & Strings"),
  SF("synth_strings_1", "Synth Strings", "Pads & Strings"),
  SF("pad_2_warm", "GM Warm Pad", "Pads & Strings"),
  SF("pad_3_polysynth", "Polysynth Pad", "Pads & Strings"),
  SF("choir_aahs", "Choir Aahs", "Pads & Strings"),
  { id: "mellotron:300 STRINGS CELLO", name: "Mellotron Strings", category: "Pads & Strings", size: "~3 MB" },
  { id: "mellotron:8VOICE CHOIR", name: "Mellotron Choir", category: "Pads & Strings", size: "~3 MB" },

  { id: "synth:saw-lead", name: "Saw Lead (synth)", category: "Lead", size: "0" },
  { id: "synth:square-lead", name: "Square Lead (synth)", category: "Lead", size: "0" },
  { id: "synth:pluck", name: "Pluck (synth)", category: "Lead", size: "0" },
  SF("lead_2_sawtooth", "GM Saw Lead", "Lead"),
  SF("flute", "Flute", "Lead"),
  SF("alto_sax", "Alto Sax", "Lead"),
  SF("trumpet", "Trumpet", "Lead"),
  SF("violin", "Violin", "Lead"),
  SF("brass_section", "Brass Section", "Lead"),
];

export const DEFAULT_INSTRUMENT: Partial<Record<Role, string>> = {
  drums: "kit:acoustic",
  bass: "sf:electric_bass_finger",
  vocals: "synth:saw-lead",
  lead: "synth:saw-lead",
  keys: "piano:splendid",
  other: "piano:splendid",
  guitar: "pluck:acoustic",
  piano: "piano:splendid",
  pad: "synth:string-pad",
};

export const isDrumInstrument = (id?: string) => !!id && /^(drums|abuse|kit|dpkit):/.test(id);
