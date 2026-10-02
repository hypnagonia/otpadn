/** Pattern generators: drums by section energy, chord pads, piano comping, root basslines. */
import type { ChordSpan, Note, Section } from "../../model/types";

export const K = 36, SN = 38, CLAP = 39, CH = 42, OH = 46, CRASH = 49, TL = 45, TM = 47, TH = 50, SHAKER = 70;

function drumBar(level: number, barIdx: number, rng: () => number): Note[] {
  const n: Note[] = [];
  const hit = (step: number, pitch: number, vel: number) => n.push({ pitch, start: step / 4, dur: 0.25, vel: Math.min(127, Math.round(vel + (rng() - 0.5) * 10)) });
  if (level <= 0) {
    for (let s = 0; s < 16; s += 4) hit(s + 2, SHAKER, 55);
    return n;
  }
  // Kicks
  hit(0, K, 115);
  hit(8, K, 105);
  if (level >= 2 && rng() < 0.5) hit(10, K, 90);
  if (level >= 3) {
    hit(6, K, 85);
    if (barIdx % 2 === 1) hit(14, K, 80);
  }
  // Backbeat
  if (level >= 2) {
    hit(4, SN, 110);
    hit(12, SN, 112);
    if (level >= 3) {
      hit(4, CLAP, 85);
      hit(12, CLAP, 85);
    }
  }
  // Hats
  const div = level >= 3 ? 1 : 2;
  for (let s = 0; s < 16; s += div) {
    if (level >= 3 && s === 14) continue;
    hit(s, CH, s % 4 === 0 ? 90 : s % 2 === 0 ? 72 : 55);
  }
  if (level >= 3) hit(14, OH, 80);
  return n;
}

function fillBar(kind: "roll" | "toms", rng: () => number): Note[] {
  const n: Note[] = [];
  if (kind === "roll") {
    for (let s = 0; s < 16; s++) n.push({ pitch: SN, start: s / 4, dur: 0.25, vel: Math.round(45 + (s / 15) * 75) });
    n.push({ pitch: K, start: 0, dur: 0.25, vel: 110 }, { pitch: K, start: 2, dur: 0.25, vel: 100 });
  } else {
    n.push(...drumBar(2, 0, rng).filter((x) => x.start < 2.5));
    [TH, TH, TM, TM, TL, TL].forEach((p, i) => n.push({ pitch: p, start: 2.5 + i * 0.25, dur: 0.25, vel: 95 + i * 4 }));
  }
  return n;
}

export function generateDrums(sections: Section[], rngSeed = 7): Note[] {
  let seed = rngSeed;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: Note[] = [];
  sections.forEach((sec, si) => {
    const bars = sec.length / 4;
    const next = sections[si + 1];
    for (let b = 0; b < bars; b++) {
      const at = sec.start + b * 4;
      const isLast = b === bars - 1 && !!next;
      let notes: Note[];
      if (isLast && next.energy > sec.energy && sec.label === "Build") notes = fillBar("roll", rng);
      else if (isLast && next.energy >= sec.energy && sec.energy >= 2) notes = fillBar("toms", rng);
      else notes = drumBar(sec.energy, b, rng);
      for (const x of notes) out.push({ ...x, start: x.start + at });
      if (b === 0 && sec.energy >= 3) out.push({ pitch: CRASH, start: at, dur: 1, vel: 100 });
    }
  });
  return out;
}

function voiceChord(root: number, minor: boolean, center = 60): number[] {
  const pcs = [root, (root + (minor ? 3 : 4)) % 12, (root + 7) % 12];
  return pcs
    .map((pc) => {
      let n = pc + 12 * Math.floor(center / 12);
      while (n < center - 6) n += 12;
      while (n > center + 6) n -= 12;
      return n;
    })
    .sort((a, b) => a - b);
}

export function generatePad(chords: ChordSpan[]): Note[] {
  const out: Note[] = [];
  for (const c of chords) {
    for (const p of voiceChord(c.root, c.minor, 62)) out.push({ pitch: p, start: c.start, dur: c.length, vel: 80 });
    out.push({ pitch: 48 + c.root, start: c.start, dur: c.length, vel: 70 });
  }
  return out;
}

export function generatePianoChords(chords: ChordSpan[], sections: Section[]): Note[] {
  const out: Note[] = [];
  const energyAt = (b: number) => sections.find((s) => b >= s.start && b < s.start + s.length)?.energy ?? 1;
  for (const c of chords) {
    const v = voiceChord(c.root, c.minor, 64);
    for (let b = c.start; b < c.start + c.length; b += 1) {
      const e = energyAt(b);
      const every = e >= 2 ? 1 : 2;
      if ((b - c.start) % every !== 0) continue;
      for (const p of v) out.push({ pitch: p, start: b, dur: every * 0.9, vel: 60 + e * 10 });
    }
  }
  return out;
}

export function generateBassFromChords(chords: ChordSpan[], sections: Section[]): Note[] {
  const out: Note[] = [];
  const energyAt = (b: number) => sections.find((s) => b >= s.start && b < s.start + s.length)?.energy ?? 1;
  for (const c of chords) {
    const root = 36 + c.root;
    for (let b = c.start; b < c.start + c.length; b += 0.5) {
      const e = energyAt(b);
      if (e <= 0) continue;
      const step = (b - c.start) * 2;
      if (e === 1 && step % 4 !== 0) continue;
      if (e === 2 && step % 2 !== 0) continue;
      const octave = e >= 3 && step % 4 === 3 ? 12 : 0;
      out.push({ pitch: root + octave, start: b, dur: e === 1 ? 1.8 : e === 2 ? 0.9 : 0.45, vel: 95 + (step % 2 === 0 ? 10 : 0) });
    }
  }
  return out;
}
