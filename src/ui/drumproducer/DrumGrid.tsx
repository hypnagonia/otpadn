import { useEffect, useRef, useState } from "react";
import { engine } from "../../engine/transport";
import { VOICE_INFO, VOICES, type DEvent, type Voice } from "../../drumproducer/types";
import { T } from "../common/theme";

const LABEL_W = 92;
const ROW_H = 18;

/** Origin colours (also used by the legend). */
export const ORIGIN_COLOR: Record<string, string> = {
  source: "#8a8f98",
  moved: "#4a9eff",
  velocity: "#e8d23c",
  added: "#3ccf6e",
  generated: "#3fbfb4",
  fill: "#e07b39",
  dropped: "#ff4d3d",
};

export interface GridProps {
  events: DEvent[];
  dropped: DEvent[];
  lengthBeats: number;
  regionStart: number;
  lockedVoices: Voice[];
  lockedIds: Set<string>;
  highlight: Set<string>;
  onEvent: (e: DEvent) => void;
  onVoice: (v: Voice) => void;
  onHover: (e: DEvent | null, dropped: boolean) => void;
}

/** Drum grid: one row per voice, events coloured by origin, height = velocity, moved hits show where they came from. */
export default function DrumGrid(props: GridProps) {
  const { events, dropped, lengthBeats } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const pr = useRef(props);
  pr.current = props;
  const voices = VOICES.filter((v) => events.some((e) => e.voice === v) || dropped.some((e) => e.voice === v) || props.lockedVoices.includes(v));
  const ppb = Math.max(12, (w - LABEL_W - 8) / Math.max(4, lengthBeats));
  const width = LABEL_W + lengthBeats * ppb + 8;
  const height = Math.max(1, voices.length) * ROW_H + 16;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = () => {
    const c = cv.current;
    if (!c) return;
    const p = pr.current;
    const dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = width + "px";
      c.style.height = height + "px";
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.bg;
    g.fillRect(0, 0, width, height);
    const X = (b: number) => LABEL_W + b * ppb;
    const Y = (v: Voice) => 14 + voices.indexOf(v) * ROW_H;
    voices.forEach((v, i) => {
      g.fillStyle = i % 2 ? T.laneA : T.laneB;
      g.fillRect(LABEL_W, 14 + i * ROW_H, width, ROW_H);
    });
    for (let b = 0; b <= lengthBeats + 1e-9; b += 0.25) {
      const x = Math.round(X(b)) + 0.5;
      g.strokeStyle = b % 4 === 0 ? T.tick : b % 1 === 0 ? T.gridStrong : T.gridFaint;
      if (b % 1 !== 0 && ppb < 20) continue;
      g.beginPath();
      g.moveTo(x, 12);
      g.lineTo(x, height);
      g.stroke();
      if (b % 4 === 0 && b < lengthBeats) {
        g.fillStyle = T.muted;
        g.font = `10px ${T.font}`;
        g.fillText(String(b / 4 + 1), x + 2, 10);
      }
    }
    // labels
    g.font = `11px ${T.font}`;
    g.textBaseline = "middle";
    for (const v of voices) {
      const y = Y(v);
      const locked = p.lockedVoices.includes(v);
      g.fillStyle = locked ? "#3a4150" : T.header;
      g.fillRect(0, y, LABEL_W - 2, ROW_H - 1);
      g.fillStyle = VOICE_INFO[v].color;
      g.fillRect(0, y, 3, ROW_H - 1);
      g.fillStyle = locked ? T.ink : T.body;
      g.fillText(`${VOICE_INFO[v].label}${locked ? " ⊠" : ""}`, 7, y + ROW_H / 2);
    }
    g.textBaseline = "alphabetic";
    // dropped (removed) hits
    g.strokeStyle = ORIGIN_COLOR.dropped;
    g.lineWidth = 1.5;
    for (const e of p.dropped) {
      if (!voices.includes(e.voice)) continue;
      const x = X(e.src?.start ?? e.start), y = Y(e.voice) + ROW_H / 2;
      g.beginPath();
      g.moveTo(x - 3, y - 4); g.lineTo(x + 3, y + 4);
      g.moveTo(x + 3, y - 4); g.lineTo(x - 3, y + 4);
      g.stroke();
    }
    g.lineWidth = 1;
    const ew = Math.max(3, Math.min(10, ppb * 0.22));
    for (const e of p.events) {
      const at = e.start + e.micro;
      const x = X(at), y0 = Y(e.voice);
      const h = 3 + (ROW_H - 5) * (e.vel / 127);
      const col = ORIGIN_COLOR[e.origin] ?? T.body;
      if (e.src && Math.abs(e.src.start - at) * ppb > 1.5) {
        g.strokeStyle = col;
        g.globalAlpha = 0.55;
        g.beginPath();
        g.moveTo(X(e.src.start), y0 + ROW_H - 3);
        g.lineTo(x, y0 + ROW_H - 3);
        g.stroke();
        g.fillStyle = col;
        g.fillRect(X(e.src.start) - 1, y0 + ROW_H - 5, 2, 4);
        g.globalAlpha = 1;
      }
      g.fillStyle = col;
      g.fillRect(x - ew / 2, y0 + ROW_H - 2 - h, ew, h);
      if (p.lockedIds.has(e.id) || e.locked) {
        g.strokeStyle = T.ink;
        g.strokeRect(x - ew / 2 - 1.5, y0 + ROW_H - 3.5 - h, ew + 3, h + 3);
      }
      if (p.highlight.has(e.id)) {
        g.strokeStyle = T.cycle;
        g.lineWidth = 2;
        g.strokeRect(x - ew / 2 - 3, y0 + 1, ew + 6, ROW_H - 2);
        g.lineWidth = 1;
      }
      if (e.tags?.includes("ghost")) {
        g.fillStyle = T.bg;
        g.fillRect(x - 1, y0 + ROW_H - 2 - h + 1, 2, 2);
      }
    }
    // playhead
    const ph = engine.beat - p.regionStart;
    if (ph >= 0 && ph <= lengthBeats) {
      g.fillStyle = T.ink;
      g.fillRect(Math.round(X(ph)), 12, 1, height);
    }
  };

  useEffect(draw);
  useEffect(() => {
    let raf = 0, last = -1;
    const loop = () => {
      if (engine.beat !== last) {
        last = engine.beat;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const hit = (ev: React.MouseEvent): { e: DEvent | null; dropped: boolean; voice: Voice | null; label: boolean } => {
    const r = cv.current!.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const row = Math.floor((y - 14) / ROW_H);
    const voice = voices[row] ?? null;
    if (!voice) return { e: null, dropped: false, voice: null, label: false };
    if (x < LABEL_W) return { e: null, dropped: false, voice, label: true };
    const beat = (x - LABEL_W) / ppb;
    const tol = 5 / ppb;
    let best: DEvent | null = null, bd = tol;
    for (const e of props.events) if (e.voice === voice && Math.abs(e.start + e.micro - beat) < bd) { bd = Math.abs(e.start + e.micro - beat); best = e; }
    if (best) return { e: best, dropped: false, voice, label: false };
    for (const e of props.dropped) if (e.voice === voice && Math.abs((e.src?.start ?? e.start) - beat) < bd) { bd = Math.abs((e.src?.start ?? e.start) - beat); best = e; }
    return { e: best, dropped: !!best, voice, label: false };
  };

  return (
    <div className="dp-grid" ref={wrap}>
      {!voices.length && <div className="hint">no events</div>}
      <canvas
        ref={cv}
        onMouseDown={(ev) => {
          const h = hit(ev);
          if (h.label && h.voice) props.onVoice(h.voice);
          else if (h.e && !h.dropped) props.onEvent(h.e);
        }}
        onMouseMove={(ev) => {
          const h = hit(ev);
          props.onHover(h.e, h.dropped);
        }}
        onMouseLeave={() => props.onHover(null, false)}
      />
    </div>
  );
}
