import { useEffect, useRef, useState } from "react";
import { engine } from "../../engine/transport";
import { chordName, type Chord, type PEvent } from "../../partproducer/types";
import { T } from "../common/theme";

const KEYS_W = 44;
const CHORD_H = 18;
const RULER_H = 12;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const PP_COLOR: Record<string, string> = {
  source: "#8a8f98",
  moved: "#4a9eff",
  edited: "#e8d23c",
  added: "#3ccf6e",
  generated: "#3fbfb4",
  fill: "#e07b39",
  dropped: "#ff4d3d",
};

export interface PartGridProps {
  events: PEvent[];
  dropped: PEvent[];
  chords: Chord[];
  lengthBeats: number;
  regionStart: number;
  lockedIds: Set<string>;
  highlight: Set<string>;
  onEvent: (e: PEvent) => void;
  onChord: (c: Chord) => void;
  onHover: (e: PEvent | null, dropped: boolean) => void;
}

/** Piano-roll view of a part: chord lane (click to change), notes coloured by origin, removed notes outlined red. */
export default function PartGrid(props: PartGridProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 260 });
  const pr = useRef(props);
  pr.current = props;
  const all = [...props.events, ...props.dropped];
  const lo = all.length ? Math.min(...all.map((e) => e.pitch)) - 2 : 55;
  const hi = all.length ? Math.max(...all.map((e) => e.pitch)) + 2 : 72;
  const rows = hi - lo + 1;
  const rowH = Math.max(4, Math.min(12, (size.h - CHORD_H - RULER_H - 4) / rows));
  const ppb = Math.max(10, (size.w - KEYS_W - 8) / Math.max(4, props.lengthBeats));
  const width = KEYS_W + props.lengthBeats * ppb + 8;
  const height = CHORD_H + RULER_H + rows * rowH + 2;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const X = (b: number) => KEYS_W + b * ppb;
  const Y = (p: number) => CHORD_H + RULER_H + (hi - p) * rowH;

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
    for (let q = lo; q <= hi; q++) {
      g.fillStyle = BLACK.has(q % 12) ? T.rowBlack : T.rowWhite;
      g.fillRect(KEYS_W, Y(q), width, rowH);
    }
    for (let b = 0; b <= p.lengthBeats + 1e-9; b += 0.25) {
      if (b % 1 !== 0 && ppb < 24) continue;
      const x = Math.round(X(b)) + 0.5;
      g.strokeStyle = b % 4 === 0 ? T.tick : b % 1 === 0 ? T.gridStrong : T.gridFaint;
      g.beginPath();
      g.moveTo(x, CHORD_H);
      g.lineTo(x, height);
      g.stroke();
      if (b % 4 === 0 && b < p.lengthBeats) {
        g.fillStyle = T.muted;
        g.font = `10px ${T.font}`;
        g.fillText(String(b / 4 + 1), x + 2, CHORD_H + 10);
      }
    }
    // chord lane
    g.font = `bold 11px ${T.font}`;
    g.textBaseline = "middle";
    for (const ch of p.chords) {
      const x0 = X(ch.start), x1 = X(ch.start + ch.length);
      g.fillStyle = ch.from === "user" ? "#5a4a1c" : ch.from === "project" ? "#24486f" : "#34363b";
      g.fillRect(x0 + 1, 1, x1 - x0 - 2, CHORD_H - 3);
      g.fillStyle = T.text;
      if (x1 - x0 > 16) g.fillText(chordName(ch.root, ch.q), x0 + 4, CHORD_H / 2);
    }
    g.textBaseline = "alphabetic";
    // dropped notes
    g.strokeStyle = PP_COLOR.dropped;
    for (const e of p.dropped) g.strokeRect(X(e.src?.start ?? e.start) + 0.5, Y(e.pitch) + 0.5, Math.max(2, e.dur * ppb - 1), rowH - 1);
    for (const e of p.events) {
      const at = e.start + e.micro, x = X(at), y = Y(e.pitch);
      const col = PP_COLOR[e.origin] ?? T.body;
      if (e.src && (Math.abs(e.src.start - at) * ppb > 1.5 || e.src.pitch !== e.pitch)) {
        g.strokeStyle = col;
        g.globalAlpha = 0.5;
        g.beginPath();
        g.moveTo(X(e.src.start), Y(e.src.pitch) + rowH / 2);
        g.lineTo(x, y + rowH / 2);
        g.stroke();
        g.globalAlpha = 1;
      }
      g.fillStyle = col;
      g.globalAlpha = 0.45 + 0.55 * (e.vel / 127);
      g.fillRect(x + 0.5, y + 0.5, Math.max(2, e.dur * ppb - 1), rowH - 1);
      g.globalAlpha = 1;
      if (p.lockedIds.has(e.id) || e.locked) {
        g.strokeStyle = T.ink;
        g.strokeRect(x - 0.5, y - 0.5, Math.max(3, e.dur * ppb + 1), rowH + 1);
      }
      if (p.highlight.has(e.id)) {
        g.strokeStyle = T.cycle;
        g.lineWidth = 2;
        g.strokeRect(x - 2, y - 2, Math.max(5, e.dur * ppb + 4), rowH + 4);
        g.lineWidth = 1;
      }
    }
    // keyboard
    for (let q = lo; q <= hi; q++) {
      g.fillStyle = BLACK.has(q % 12) ? T.keyBlack : T.keyWhite;
      g.fillRect(0, Y(q), KEYS_W - 1, rowH - 0.5);
      if (q % 12 === 0 && rowH >= 6) {
        g.fillStyle = T.bg;
        g.font = `9px ${T.font}`;
        g.fillText(`C${q / 12 - 1}`, 22, Y(q) + rowH - 1);
      }
    }
    g.fillStyle = T.header;
    g.fillRect(0, 0, KEYS_W, CHORD_H + RULER_H);
    g.fillStyle = T.muted;
    g.font = `10px ${T.font}`;
    g.fillText("chords", 4, 12);
    const ph = engine.beat - p.regionStart;
    if (ph >= 0 && ph <= p.lengthBeats) {
      g.fillStyle = T.ink;
      g.fillRect(Math.round(X(ph)), CHORD_H, 1, height);
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

  const hit = (ev: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const beat = (x - KEYS_W) / ppb;
    if (y < CHORD_H) return { chord: props.chords.find((c) => beat >= c.start && beat < c.start + c.length) ?? null, e: null, dropped: false };
    const pitch = hi - Math.floor((y - CHORD_H - RULER_H) / rowH);
    const e = props.events.find((n) => n.pitch === pitch && beat >= n.start + n.micro - 2 / ppb && beat <= n.start + n.micro + Math.max(n.dur, 4 / ppb));
    if (e) return { chord: null, e, dropped: false };
    const d = props.dropped.find((n) => n.pitch === pitch && beat >= (n.src?.start ?? n.start) && beat <= (n.src?.start ?? n.start) + Math.max(n.dur, 4 / ppb));
    return { chord: null, e: d ?? null, dropped: !!d };
  };

  return (
    <div className="dp-grid pp-grid" ref={wrap}>
      <canvas
        ref={cv}
        onMouseDown={(ev) => {
          const h = hit(ev);
          if (h.chord) props.onChord(h.chord);
          else if (h.e && !h.dropped) props.onEvent(h.e);
        }}
        onMouseMove={(ev) => { const h = hit(ev); props.onHover(h.e, h.dropped); }}
        onMouseLeave={() => props.onHover(null, false)}
      />
    </div>
  );
}

export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
