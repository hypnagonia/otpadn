/**
 * Canvas palette. Mirrors the CSS tokens in styles.css: console greys (mid-grey rulers and
 * panels over darker playlists), sans labels, Courier for numbers.
 */
export const T = {
  bg: "#242527",
  laneA: "#2c2d30",
  laneB: "#2f3033",
  laneSel: "#383d48",
  header: "#3a3b3e",
  gridFaint: "#323336",
  grid: "#3c3e42",
  gridStrong: "#4d5056",
  hairline: "#19191b",
  tick: "#74777d",
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
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Courier New', Courier, monospace",
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
