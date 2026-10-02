export function formatPos(beat: number) {
  const bar = Math.floor(beat / 4) + 1;
  const b = Math.floor(beat % 4) + 1;
  const tick = Math.floor((beat % 1) * 100);
  return `${bar}.${b}.${tick.toString().padStart(2, "0")}`;
}

export function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
export const fmtPan = (v: number) => (Math.abs(v) < 0.005 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
