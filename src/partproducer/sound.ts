/** "Pick sound" for pitched parts: an instrument from the DAW's catalog + channel processing. Never touches notes. */
import type { Mode, PEvent, Proc, Style } from "./types";

const proc = (o: Partial<Proc> & { level: number }): Proc => ({
  eq: { on: true, hpf: 100, low: 0, high: 0, lpf: 0 },
  comp: { on: false, threshold: -18, ratio: 2.5, attack: 10 },
  delay: { on: false, div: 2, feedback: 30, mix: 15 },
  send: { on: true, amount: 0.12 },
  ...o,
});

export const PICK: Record<string, { instrument: string; proc: Proc; why: string }> = {
  "keys:comp": { instrument: "piano:splendid", why: "grand piano for comping", proc: proc({ level: -4, eq: { on: true, hpf: 90, low: -1, high: 1, lpf: 0 }, comp: { on: true, threshold: -20, ratio: 2, attack: 15 }, send: { on: true, amount: 0.16 } }) },
  "keys:stabs": { instrument: "piano:splendid", why: "bright piano: the classic house stab", proc: proc({ level: -5, eq: { on: true, hpf: 180, low: -2, high: 2.5, lpf: 0 }, comp: { on: true, threshold: -16, ratio: 3, attack: 5 }, send: { on: true, amount: 0.2 } }) },
  "keys:pad": { instrument: "synth:string-pad", why: "analog string pad for sustained chords", proc: proc({ level: -2, eq: { on: true, hpf: 200, low: -2, high: 0, lpf: 9000 }, send: { on: true, amount: 0.3 } }) },
  "keys:arp": { instrument: "synth:pluck", why: "short synth pluck so 16ths stay articulate", proc: proc({ level: -4, eq: { on: true, hpf: 220, low: 0, high: 1, lpf: 0 }, delay: { on: true, div: 2, feedback: 28, mix: 18 }, send: { on: true, amount: 0.15 } }) },
  "line:faithful": { instrument: "synth:saw-lead", why: "plain saw lead follows a sung line closely", proc: proc({ level: 2, eq: { on: true, hpf: 160, low: 0, high: 0.5, lpf: 0 }, comp: { on: true, threshold: -20, ratio: 3, attack: 8 }, delay: { on: true, div: 2, feedback: 25, mix: 12 }, send: { on: true, amount: 0.15 } }) },
  "line:tight": { instrument: "synth:square-lead", why: "square lead with vibrato: vocal-like, cuts through", proc: proc({ level: 2, eq: { on: true, hpf: 180, low: 0, high: 1, lpf: 0 }, comp: { on: true, threshold: -20, ratio: 3, attack: 8 }, delay: { on: true, div: 2, feedback: 30, mix: 15 }, send: { on: true, amount: 0.18 } }) },
  "line:hook": { instrument: "synth:supersaw", why: "wide supersaw for a held, simplified hook", proc: proc({ level: 1, eq: { on: true, hpf: 200, low: -1, high: 1, lpf: 0 }, comp: { on: true, threshold: -18, ratio: 2.5, attack: 10 }, delay: { on: true, div: 4, feedback: 30, mix: 14 }, send: { on: true, amount: 0.22 } }) },
  "guitar:faithful": { instrument: "pluck:acoustic", why: "modelled acoustic guitar", proc: proc({ level: -12, eq: { on: true, hpf: 90, low: -1, high: 1, lpf: 0 }, comp: { on: true, threshold: -20, ratio: 2.5, attack: 12 }, send: { on: true, amount: 0.12 } }) },
  "guitar:strum": { instrument: "pluck:acoustic", why: "modelled acoustic guitar for strumming", proc: proc({ level: -13, eq: { on: true, hpf: 100, low: -1.5, high: 1.5, lpf: 0 }, comp: { on: true, threshold: -20, ratio: 3, attack: 15 }, send: { on: true, amount: 0.12 } }) },
  "guitar:fingerpick": { instrument: "sf:acoustic_guitar_nylon", why: "nylon guitar: soft, clear single notes", proc: proc({ level: -8, eq: { on: true, hpf: 80, low: -1, high: 1, lpf: 0 }, comp: { on: true, threshold: -22, ratio: 2, attack: 15 }, send: { on: true, amount: 0.14 } }) },
  "guitar:power": { instrument: "pluck:distortion", why: "amp-modelled distortion guitar", proc: proc({ level: -13, eq: { on: true, hpf: 90, low: 0, high: -1, lpf: 8000 }, comp: { on: false, threshold: -18, ratio: 2, attack: 10 }, send: { on: true, amount: 0.06 } }) },
};

export function autoSound(mode: Mode, style: Style, events: PEvent[], bpm: number, sourceInstrument?: string) {
  const key = `${mode}:${style}`;
  const p = PICK[key] ?? PICK[`${mode}:${mode === "keys" ? "comp" : mode === "line" ? "tight" : "strum"}`];
  const out = { instrument: p.instrument, proc: structuredClone(p.proc), notes: [`${p.why}`] };
  // Faithful guitar keeps a guitar the source already used.
  if (key === "guitar:faithful" && sourceInstrument && /guitar|pluck/.test(sourceInstrument)) {
    out.instrument = sourceInstrument;
    out.notes = ["keeps the source's guitar sound"];
  }
  const lo = events.length ? Math.min(...events.map((e) => e.pitch)) : 60;
  if (mode !== "guitar" && lo < 50 && out.proc.eq.hpf > 120) {
    out.proc.eq.hpf = 100;
    out.notes.push("low notes in the part: high-pass lowered to 100 Hz");
  }
  if (out.proc.delay.on && bpm > 140) {
    out.proc.delay.div = 1;
    out.notes.push("fast tempo: delay set to 1/8");
  }
  return out;
}
