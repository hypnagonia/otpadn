/**
 * Canvas palette. Mirrors the CSS tokens in styles.css: studio charcoal
 * (Logic/Pro Tools conventions) with jenyadoesapps typography.
 */
export const T = {
  bg: "#232428",
  laneA: "#2a2b2f",
  laneB: "#2d2e33",
  laneSel: "#363c48",
  header: "#2f3035",
  gridFaint: "#303237",
  grid: "#383a40",
  gridStrong: "#474a51",
  hairline: "#18191b",
  tick: "#62656c",
  text: "#ececec",
  body: "#c9cbcf",
  muted: "#9a9da3",
  faint: "#6c6f76",
  ink: "#ffffff", // playhead
  accent: "#4a9eff",
  cycle: "rgba(217,180,58,0.85)",
  cycleOff: "rgba(217,180,58,0.3)",
  cycleWash: "rgba(217,180,58,0.06)",
  regionInk: "rgba(0,0,0,0.62)", // waveform / note colour drawn on a region
  regionText: "#101114",
  meterGreen: "#3ccf6e",
  meterYellow: "#e8d23c",
  meterRed: "#ff4d3d",
  clip: "#ff4d3d",
  keyWhite: "#dcdcdc",
  keyBlack: "#25262a",
  rowWhite: "#2d2e33",
  rowBlack: "#27282c",
  noteSel: "#ffffff",
  font: "'Courier New', Courier, monospace",
};

/** Arrangement-marker colours (Logic-style). */
export const SECTION_COLORS: Record<string, string> = {
  Intro: "#5d6b7b",
  Verse: "#3d7bbf",
  Build: "#c08a2e",
  Chorus: "#c4513b",
  Break: "#7d5bb3",
  Outro: "#5d6b7b",
};
