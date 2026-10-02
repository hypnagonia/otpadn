import { clipFades } from "../../engine/schedule";
import type { AudioClip } from "../../model/types";
import { automatableParams, laneValue, toPos } from "../../engine/automation";
import { isAudible } from "../../engine/schedule";
import { buffers, PEAK_BLOCK, peaksCache } from "../../model/store";
import type { Project } from "../../model/types";
import { SECTION_COLORS, T } from "../common/theme";
import { clipLenBeats, MARKER_H, RULER_H, TOP_H } from "./geometry";

export interface View {
  ppb: number;
  sx: number;
  sy: number;
  rowH: number;
  /** Selected regions (group or single). */
  selClips: string[];
  /** Rubber-band selection box being dragged, in canvas px. */
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  selTrack: string | null;
  loopDraft: [number, number] | null;
  /** Range-tool selection (time slice on some tracks). */
  range?: { start: number; end: number; trackIds: string[] } | null;
  /** Automation view: draw each track's shown lane over its row. */
  auto?: boolean;
}

export const AUTO_COLOR = "#f4c95d";
/** Vertical extent of the automation curve inside a track row (also used for hit testing). */
export const autoBand = (rowTop: number, rowH: number) => ({ top: rowTop + 5, bottom: rowTop + rowH - 5 });

/** Static layer: lanes, grid, clips (waveforms / note thumbnails), ruler, markers, cycle range. */
export function drawArrangement(cv: HTMLCanvasElement, p: Project, v: View) {
  const { ppb, sx, sy, rowH: ROW_H, loopDraft } = v;
  const sel = new Set(v.selClips);
  const dpr = devicePixelRatio || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = T.bg;
  g.fillRect(0, 0, W, H);
  const spb = 60 / p.bpm;
  const b0 = Math.floor(sx / ppb), b1 = Math.ceil((sx + W) / ppb);
  const X = (beat: number) => beat * ppb - sx;

  // Lanes
  p.tracks.forEach((t, i) => {
    const y = TOP_H + i * ROW_H - sy;
    if (y + ROW_H < TOP_H || y > H) return;
    g.fillStyle = t.id === v.selTrack ? T.laneSel : i % 2 ? T.laneA : T.laneB;
    g.fillRect(0, y, W, ROW_H);
    g.fillStyle = T.grid;
    g.fillRect(0, y + ROW_H - 1, W, 1);
  });
  // Grid
  // Adaptive density: labelled bars ≥ 56 px apart, grid lines ≥ 8 px apart, at any zoom.
  const pxPerBar = ppb * 4;
  const labelBars = [1, 2, 4, 8, 16, 32, 64, 128].find((n) => n * pxPerBar >= 56) ?? 256;
  const gridBeats = ppb >= 40 ? 1 : ([1, 2, 4, 8, 16, 32].find((n) => n * pxPerBar >= 8) ?? 64) * 4;
  for (let b = Math.floor(b0 / gridBeats) * gridBeats; b <= b1; b += gridBeats) {
    const x = Math.round(X(b)) + 0.5;
    g.strokeStyle = b % (labelBars * 4) === 0 ? T.gridStrong : b % 4 === 0 ? T.grid : T.gridFaint;
    g.beginPath();
    g.moveTo(x, TOP_H);
    g.lineTo(x, H);
    g.stroke();
  }

  // Clips
  p.tracks.forEach((t, i) => {
    const y = TOP_H + i * ROW_H - sy;
    if (y + ROW_H < TOP_H || y > H) return;
    const dim = !isAudible(p, t);
    for (const c of t.clips) {
      const len = clipLenBeats(c, spb);
      const x0 = X(c.start), x1 = X(c.start + len);
      if (x1 < 0 || x0 > W) continue;
      const cy = y + 3, ch = ROW_H - 6;
      const col = dim ? "#6a6d73" : t.color;
      const nameH = ROW_H >= 40 ? 13 : 0;
      g.globalAlpha = dim ? 0.55 : 1;
      g.fillStyle = col + "c8";
      g.fillRect(x0, cy, x1 - x0, ch);
      if (nameH) {
        g.fillStyle = col;
        g.fillRect(x0, cy, x1 - x0, nameH);
        if (x1 - x0 > 30) {
          g.fillStyle = T.regionText;
          g.font = `bold 10px ${T.font}`;
          g.textBaseline = "middle";
          g.fillText(t.name, Math.max(x0, 0) + 4, cy + nameH / 2 + 0.5);
        }
      }
      g.strokeStyle = "rgba(0,0,0,0.5)";
      g.strokeRect(x0 + 0.5, cy + 0.5, x1 - x0 - 1, ch - 1);
      g.save();
      g.beginPath();
      g.rect(Math.max(0, x0), cy, Math.min(W, x1) - Math.max(0, x0), ch);
      g.clip();
      if (c.kind === "audio") {
        const pk = peaksCache.get(c.bufferId);
        const buf = buffers.get(c.bufferId);
        if (pk && buf) {
          const top = cy + nameH, hh = ch - nameH;
          const mid = top + hh / 2, amp = Math.min(hh / 2, (hh / 2 - 2) * Math.pow(10, (c.gain ?? 0) / 20)); // clip gain is visible
          g.fillStyle = T.regionInk;
          const secPerPx = spb / ppb;
          for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, x1); px++) {
            const tSec = c.offset + (px - x0) * secPerPx;
            const a = Math.floor((tSec * buf.sampleRate) / PEAK_BLOCK);
            const b = Math.max(a + 1, Math.floor(((tSec + secPerPx) * buf.sampleRate) / PEAK_BLOCK));
            let mn = 0, mx = 0;
            for (let k = a; k < b && k * 2 + 1 < pk.length; k++) {
              if (pk[k * 2] < mn) mn = pk[k * 2];
              if (pk[k * 2 + 1] > mx) mx = pk[k * 2 + 1];
            }
            g.fillRect(px, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
          }
        }
        // Fades (incl. automatic crossfades): shade above the equal-power curve, handles at the top.
        const ac = t.clips.filter((x): x is AudioClip => x.kind === "audio").sort((x, y) => x.start - y.start);
        const k = ac.indexOf(c);
        const { fi, fo } = clipFades(c, ac[k - 1], ac[k + 1], spb);
        const fiPx = (fi / spb) * ppb, foPx = (fo / spb) * ppb;
        const ftop = cy + nameH, fbot = cy + ch;
        g.fillStyle = "rgba(10,11,14,0.38)";
        for (const [startX, len, rising] of [[x0, fiPx, true], [x1 - foPx, foPx, false]] as const) {
          if (len < 2) continue;
          g.beginPath();
          g.moveTo(startX, ftop);
          for (let i = 0; i <= 24; i++) {
            const u = i / 24, e = rising ? Math.sin((Math.PI / 2) * u) : Math.cos((Math.PI / 2) * u);
            g.lineTo(startX + u * len, fbot - e * (fbot - ftop));
          }
          g.lineTo(startX + len, ftop);
          g.closePath();
          g.fill();
        }
        if (x1 - x0 > 24 && ROW_H >= 30) {
          g.fillStyle = "rgba(255,255,255,0.85)";
          g.fillRect(x0 + fiPx - 3, ftop, 6, 5);
          g.fillRect(x1 - foPx - 3, ftop, 6, 5);
        }
        if (c.gain && nameH && x1 - x0 > 90) {
          g.fillStyle = T.regionText;
          g.font = `10px ${T.font}`;
          g.textAlign = "right";
          g.fillText(`${c.gain > 0 ? "+" : ""}${c.gain.toFixed(1)} dB`, x1 - 5, cy + nameH / 2 + 0.5);
          g.textAlign = "left";
        }
      } else if (c.notes.length) {
        let lo = 127, hi = 0;
        for (const n of c.notes) {
          lo = Math.min(lo, n.pitch);
          hi = Math.max(hi, n.pitch);
        }
        const range = Math.max(12, hi - lo + 1);
        const top = cy + nameH + 3, hh = ch - nameH - 6;
        const nh = Math.max(2, Math.min(7, hh / range));
        g.fillStyle = T.regionInk;
        for (const n of c.notes) {
          if (n.start >= c.length) continue;
          const nx = X(c.start + n.start);
          if (nx > W || nx + n.dur * ppb < 0) continue;
          const ny = top + (hi - n.pitch) * ((hh - nh) / Math.max(1, range - 1));
          g.fillRect(nx, ny, Math.max(1, Math.min(n.dur, c.length - n.start) * ppb - 1), nh);
        }
      }
      g.restore();
      g.globalAlpha = 1;
      if (sel.has(c.id)) {
        g.strokeStyle = T.ink;
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, cy + 1, x1 - x0 - 2, ch - 2);
        g.lineWidth = 1;
      }
    }
  });

  // Automation view: the shown lane of each track over its regions.
  if (v.auto) {
    const busName = (id: string) => p.tracks.find((x) => x.id === id)?.name ?? "bus";
    p.tracks.forEach((t, i) => {
      const y = TOP_H + i * ROW_H - sy;
      if (y + ROW_H < TOP_H || y > H) return;
      const param = t.autoView ?? "volume";
      const info = automatableParams(t, busName).find((x) => x.param === param);
      if (!info) return;
      g.fillStyle = "rgba(12,13,16,0.42)"; // regions recede; the curve is what's edited
      g.fillRect(0, y + 1, W, ROW_H - 2);
      const { top, bottom } = autoBand(y, ROW_H);
      const Y = (val: number) => bottom - toPos(info, val) * (bottom - top);
      const pts = t.automation?.find((l) => l.param === param)?.points ?? [];
      g.font = `10px ${T.font}`;
      g.fillStyle = AUTO_COLOR;
      g.fillText(info.label, 6, y + ROW_H - 7);
      if (!pts.length) {
        g.strokeStyle = AUTO_COLOR;
        g.globalAlpha = 0.55;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(0, Math.round(Y(info.def)) + 0.5);
        g.lineTo(W, Math.round(Y(info.def)) + 0.5);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        return;
      }
      const path = new Path2D();
      path.moveTo(0, Y(laneValue(pts, b0)));
      for (const pt of pts) path.lineTo(X(pt.beat), Y(pt.value));
      path.lineTo(W, Y(pts[pts.length - 1].value));
      const fill = new Path2D(path);
      fill.lineTo(W, bottom);
      fill.lineTo(0, bottom);
      fill.closePath();
      g.fillStyle = "rgba(244,201,93,0.13)";
      g.fill(fill);
      g.strokeStyle = AUTO_COLOR;
      g.lineWidth = 1.6;
      g.stroke(path);
      g.lineWidth = 1;
      for (const pt of pts) {
        const px = X(pt.beat), py = Y(pt.value);
        if (px < -6 || px > W + 6) continue;
        g.fillStyle = "#16171a";
        g.fillRect(px - 3.5, py - 3.5, 7, 7);
        g.fillStyle = AUTO_COLOR;
        g.fillRect(px - 2.5, py - 2.5, 5, 5);
      }
    });
  }

  // Range selection: a translucent band on each selected track
  if (v.range) {
    const a = Math.min(v.range.start, v.range.end), b = Math.max(v.range.start, v.range.end);
    const x0 = X(a), x1 = X(b);
    p.tracks.forEach((t, i) => {
      if (!v.range!.trackIds.includes(t.id)) return;
      const y = TOP_H + i * ROW_H - sy;
      if (y + ROW_H < TOP_H || y > H) return;
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(x0, y + 1, x1 - x0, ROW_H - 2);
      g.strokeStyle = "#ffffff";
      g.strokeRect(Math.round(x0) + 0.5, y + 1.5, Math.round(x1 - x0), ROW_H - 3);
    });
  }

  if (v.marquee) {
    const { x0, y0, x1, y1 } = v.marquee;
    const x = Math.min(x0, x1), y = Math.max(TOP_H, Math.min(y0, y1));
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(x, y, Math.abs(x1 - x0), Math.max(y0, y1) - y);
    g.strokeStyle = "rgba(255,255,255,0.75)";
    g.setLineDash([4, 3]);
    g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(x1 - x0)), Math.round(Math.max(y0, y1) - y));
    g.setLineDash([]);
  }

  // Ruler + sections (fixed on top)
  g.fillStyle = T.header;
  g.fillRect(0, 0, W, TOP_H);
  if (p.loop.on || loopDraft) {
    const [ls, le] = loopDraft ?? [p.loop.start, p.loop.end];
    g.fillStyle = p.loop.on ? T.cycle : T.cycleOff;
    g.fillRect(X(ls), 3, X(le) - X(ls), RULER_H - 9);
    g.fillStyle = T.cycleWash;
    if (p.loop.on) g.fillRect(X(ls), TOP_H, X(le) - X(ls), H);
  }
  g.font = `11px ${T.font}`;
  g.textBaseline = "middle";
  const tickBeats = Math.max(4, gridBeats);
  for (let b = Math.floor(b0 / tickBeats) * tickBeats; b <= b1; b += tickBeats) {
    const bar = b / 4;
    const x = Math.round(X(b)) + 0.5;
    const major = bar % labelBars === 0;
    g.strokeStyle = T.tick;
    g.beginPath();
    g.moveTo(x, major ? 4 : 16);
    g.lineTo(x, RULER_H);
    g.stroke();
    if (major) {
      g.fillStyle = T.muted;
      g.fillText(String(bar + 1), x + 3, 10);
    }
  }
  for (const sec of p.sections) {
    const x0 = X(sec.start), x1 = X(sec.start + sec.length);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = SECTION_COLORS[sec.label] ?? T.gridStrong;
    g.fillRect(x0 + 1, RULER_H + 2, x1 - x0 - 2, MARKER_H - 4);
    g.fillStyle = "#ffffff";
    g.font = `bold 12px ${T.font}`;
    g.fillText(`${sec.label} ${sec.group}`, Math.max(x0, 0) + 6, RULER_H + MARKER_H / 2);
    g.fillStyle = "rgba(255,255,255,0.6)";
    for (let e = 0; e < sec.energy; e++) g.fillRect(x1 - 8 - e * 5, RULER_H + 8, 3, 8);
  }
  g.strokeStyle = T.hairline;
  g.beginPath();
  g.moveTo(0, TOP_H - 0.5);
  g.lineTo(W, TOP_H - 0.5);
  g.stroke();
}

const lastHead = new WeakMap<HTMLCanvasElement, { px: number; w: number; h: number }>();

/** Overlay layer: just the playhead. Repaints only the strip it leaves and the strip it enters. */
export function drawPlayhead(cv: HTMLCanvasElement, beat: number, ppb: number, sx: number) {
  const dpr = devicePixelRatio || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const px = Math.round(beat * ppb - sx) + 0.5;
  const last = lastHead.get(cv);
  const sameSize = last && last.w === cv.width && last.h === cv.height;
  if (sameSize && last.px === px) return; // nothing moved
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (sameSize) g.clearRect(last.px - 7, 0, 14, H);
  else g.clearRect(0, 0, W, H);
  lastHead.set(cv, { px, w: cv.width, h: cv.height });
  if (px < 0 || px > W) return;
  g.strokeStyle = T.ink;
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, H);
  g.stroke();
  g.fillStyle = T.ink;
  g.beginPath();
  g.moveTo(px - 5, 0);
  g.lineTo(px + 5, 0);
  g.lineTo(px, 7);
  g.fill();
}
