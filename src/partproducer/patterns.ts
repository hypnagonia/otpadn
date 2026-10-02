/**
 * Authored rhythm vocabularies (16 steps per bar). Keys: X/x/o = accent/normal/soft hit, "-" holds
 * the previous hit (its length), "." rest. Guitar strum: D/U = down/up stroke, d/u = soft strokes,
 * x = muted chuck. Power: P = open accent, p = palm-muted. Fingerpick: per-8th string roles.
 */

export interface KeysPattern { name: string; steps: string }
export const COMP: KeysPattern[] = [
  { name: "half notes", steps: "X-------x-------" },
  { name: "charleston", steps: "X--x--------x---" },
  { name: "push 4", steps: "X-------x-----x-" },
  { name: "quarter comp", steps: "x---x---x---x---" },
  { name: "dotted", steps: "X--x--x-X--x--x-" },
];
export const STABS: KeysPattern[] = [
  { name: "offbeat 8ths", steps: "..X-..X-..X-..X-" },
  { name: "classic house", steps: "..X..X....X..X.." },
  { name: "3-3-2 stab", steps: "X..X..X...X..X.." },
  { name: "skip push", steps: "..X...x...X..x.x" },
  { name: "downbeat + push", steps: "X.........X..X.." },
];
/** Arp step orders over the voicing (indices into the sorted voicing, extended +12 above). */
export const ARPS: { name: string; order: number[] }[] = [
  { name: "up", order: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: "up-down", order: [0, 1, 2, 3, 4, 3, 2, 1] },
  { name: "broken", order: [0, 2, 1, 3, 2, 4, 3, 5] },
  { name: "pulse", order: [0, 3, 1, 3, 2, 3, 1, 3] },
];

export interface StrumPattern { name: string; steps: string }
export const STRUMS: StrumPattern[] = [
  { name: "pop 8ths", steps: "D...D.U...U.D.U." },
  { name: "ballad", steps: "D.......D...U.U." },
  { name: "folk", steps: "D...D.U.D.U.D.U." },
  { name: "funk 16ths", steps: "D.xU.UxUD.xU.Ux." },
  { name: "island", steps: "..x.D.U...x.D.U." },
];

/** Fingerpicking per 8th: B = bass (root string), A = alternate bass, 1–3 = treble strings (3 = highest). */
export const PICKS: { name: string; roles: string }[] = [
  { name: "travis", roles: "B2A3B2A1" },
  { name: "arpeggio", roles: "B123A321" },
  { name: "pinch", roles: "B2A1B3A2" },
];

export const POWER: { name: string; steps: string }[] = [
  { name: "palm 8ths", steps: "P.p.p.p.P.p.p.p." },
  { name: "push", steps: "P.p.p.P.p.p.P.p." },
  { name: "gallop", steps: "P.ppP.ppP.ppP.pp" },
  { name: "chug 16ths", steps: "Ppppp.ppPpppp.pp" },
];

/**
 * "Song chart" patterns by section energy (low = intro/verse/break, mid = verse/build, high =
 * chorus). Keys: right-hand chord rhythm (left hand adds the bass, see rework). Guitar: strokes.
 * TURN = the last bar of a section going into a different one: the final hit pushes the next chord.
 */
export type Tier = "low" | "mid" | "high";
export const CHART_KEYS: Record<Tier, KeysPattern[]> = {
  low: [
    { name: "whole notes", steps: "X---------------" },
    { name: "half notes", steps: "X-------x-------" },
    { name: "dotted half + push", steps: "X-----------x---" },
  ],
  mid: [
    { name: "pop quarters", steps: "X---x---x---x---" },
    { name: "charleston", steps: "X--x--------x---" },
    { name: "push 4", steps: "X-------x-----x-" },
    { name: "and-of-2", steps: "X-----x-x-------" },
  ],
  high: [
    { name: "driving 8ths", steps: "X-x-x-x-X-x-x-x-" },
    { name: "pop dotted", steps: "X--x--x-X--x--x-" },
    { name: "8ths push", steps: "X-x-x-x-x-x-x-X-" },
  ],
};
export const TURN_KEYS: KeysPattern = { name: "turnaround", steps: "X-------x-----X-" };
export const CHART_STRUMS: Record<Tier, StrumPattern[]> = {
  low: [
    { name: "whole", steps: "D..............." },
    { name: "half notes", steps: "D.......D......." },
    { name: "ballad", steps: "D.......D...U.U." },
  ],
  mid: [
    { name: "pop 8ths", steps: "D...D.U...U.D.U." },
    { name: "folk", steps: "D...D.U.D.U.D.U." },
    { name: "island", steps: "..x.D.U...x.D.U." },
  ],
  high: [
    { name: "driving 8ths", steps: "D.U.D.U.D.U.D.U." },
    { name: "push 8ths", steps: "D.U.D.UUD.U.D.U." },
    { name: "16th folk", steps: "D.DUD.DUD.DUD.DU" },
  ],
};
export const TURN_STRUM: StrumPattern = { name: "turnaround", steps: "D...D.U.D.U.D.UD" };
export const tierOf = (energy: number): Tier => (energy >= 3 ? "high" : energy >= 2 ? "mid" : "low");

export const WEIGHT: Record<string, number> = { X: 1, x: 0.82, o: 0.62, D: 1, U: 0.72, d: 0.6, u: 0.5, x_: 0.3, P: 1, p: 0.62 };

/** Hit steps of a 16-step string (any non-rest, non-hold char). */
export const hitSteps = (s: string) => [...s].map((c, i) => (c !== "." && c !== "-" ? i : -1)).filter((i) => i >= 0);
