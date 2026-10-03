import type { Clip } from "../../model/types";

/** Tracks-area layout constants (px). Row height itself is user-adjustable (ui.trackHeight). */
export const RULER_H = 24;
export const MARKER_H = 22;
/** Chord lane (harmony layer) under the section markers. */
export const CHORD_H = 18;
export const TOP_H = RULER_H + MARKER_H + CHORD_H;
export const HEADER_W = 240;

export const clipLenBeats = (c: Clip, spb: number) => (c.kind === "midi" ? c.length : c.duration / spb);
