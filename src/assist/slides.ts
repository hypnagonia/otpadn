/**
 * Natural bass slides, the way a player does them (deterministic, re-runnable):
 *  - glide-in on some note changes: legato moves of 2–7 semitones on a beat / 8th (~1 in 5),
 *    sliding from the previous note's pitch in 45–90 ms (shorter for small steps)
 *  - grace slide into a phrase start (after a rest) from 2 semitones below, now and then
 *  - finger fall before a rest (or at the end): 5–12 semitones down over ≤ 0.25 s, fading
 */
import { store } from "../model/store";
import type { Note } from "../model/types";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function addNaturalSlides(trackId: string) {
  let glides = 0, falls = 0;
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const spb = 60 / p.bpm;
    const r = rng(t.id.length * 7919 + 17);
    // one line across clips, in time order
    const all: { n: Note; abs: number }[] = [];
    for (const c of t.clips) if (c.kind === "midi") for (const n of c.notes) if (n.start < c.length) all.push({ n, abs: c.start + n.start });
    all.sort((a, b) => a.abs - b.abs);
    all.forEach(({ n, abs }, i) => {
      delete n.slide;
      const prev = all[i - 1], next = all[i + 1];
      const slide: NonNullable<Note["slide"]> = {};
      const onGrid = Math.abs(abs * 2 - Math.round(abs * 2)) < 0.02;
      if (prev) {
        const gap = abs - (prev.abs + prev.n.dur), iv = n.pitch - prev.n.pitch;
        if (gap < 0.06 && Math.abs(iv) >= 2 && Math.abs(iv) <= 7 && onGrid && r() < 0.22) {
          slide.from = -iv; // start at the previous pitch, slide to this one
          slide.fromTime = 0.045 + 0.007 * Math.abs(iv);
          glides++;
        } else if (gap >= 1 && r() < 0.15) {
          slide.from = -2; // grace slide into a phrase start
          slide.fromTime = 0.05;
          glides++;
        }
      }
      const restAfter = next ? next.abs - (abs + n.dur) : Infinity;
      if (restAfter >= 1 && n.dur >= 0.4 && r() < 0.35) {
        slide.fall = -(5 + Math.floor(r() * 8));
        slide.fallTime = Math.min(0.25, n.dur * spb * 0.5);
        falls++;
      }
      if (slide.from || slide.fall) n.slide = slide;
    });
  });
  store.log(`Natural slides: ${glides} glide${glides === 1 ? "" : "s"} into notes, ${falls} fall${falls === 1 ? "" : "s"} before rests.`);
}

export function removeSlides(trackId: string) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    for (const c of t?.clips ?? []) if (c.kind === "midi") for (const n of c.notes) delete n.slide;
  });
}
