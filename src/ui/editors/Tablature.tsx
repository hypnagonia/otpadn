import { songHarmony } from "../../model/songHarmony";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultTuningFor, layoutTab, TUNINGS, type TabNote } from "../../analysis/tab";
import { engine } from "../../engine/transport";
import { store } from "../../model/store";
import { NOTE_NAMES, type MidiClip, type Track } from "../../model/types";
import { T } from "../common/theme";
import Select from "../common/Select";

const LINE = 18; // px between strings
const TOP = 30;
const LEFT = 44;

/** Tablature view of a MIDI region (guitar / bass), with automatic fingering. */
export default function Tablature({ track, clip, ppb }: { track: Track; clip: MidiClip; ppb: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [tuningId, setTuningId] = useState(() => defaultTuningFor(track.role, clip.notes).id);
  const tuning = TUNINGS.find((t) => t.id === tuningId) ?? TUNINGS[0];
  const tab = useMemo(() => layoutTab(clip.notes.filter((n) => n.start < clip.length), tuning), [clip.notes, clip.notes.length, clip.length, tuning]);
  const H = TOP + (tuning.strings.length - 1) * LINE + 34;
  const totalW = LEFT + clip.length * ppb + 80;
  const dropped = clip.notes.length - tab.length;

  const draw = () => {
    const c = cv.current, el = wrap.current;
    if (!c || !el) return;
    const dpr = devicePixelRatio || 1;
    const W = el.clientWidth;
    if (c.width !== W * dpr || c.height !== H * dpr) {
      c.width = W * dpr;
      c.height = H * dpr;
      c.style.width = W + "px";
      c.style.height = H + "px";
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = el.scrollLeft;
    const X = (b: number) => LEFT + b * ppb - sx;
    g.fillStyle = "#26272b";
    g.fillRect(0, 0, W, H);
    // bar lines + bar numbers
    g.font = `10px ${T.font}`;
    g.textBaseline = "middle";
    for (let b = 0; b <= clip.length; b += 4) {
      const x = Math.round(X(b)) + 0.5;
      if (x < LEFT - 1 || x > W) continue;
      g.strokeStyle = "#6b6e75";
      g.beginPath(); g.moveTo(x, TOP); g.lineTo(x, TOP + (tuning.strings.length - 1) * LINE); g.stroke();
      g.fillStyle = T.faint;
      g.fillText(String(Math.floor((clip.start + b) / 4) + 1), x + 3, TOP - 18);
    }
    // chord names
    g.fillStyle = T.cycle;
    for (const ch of songHarmony()?.chords ?? []) {
      const rel = ch.start - clip.start;
      if (ch.silent || rel < 0 || rel > clip.length) continue;
      g.fillText(ch.name, X(rel) + 3, TOP - 8);
    }
    // strings
    tuning.strings.forEach((p, s) => {
      const y = TOP + s * LINE + 0.5;
      g.strokeStyle = "#8a8d94";
      g.beginPath(); g.moveTo(LEFT, y); g.lineTo(W, y); g.stroke();
    });
    // note sustain hints + fret numbers
    g.font = `bold 12px ${T.font}`;
    g.textAlign = "center";
    for (const tn of tab) {
      const x = X(tn.note.start), y = TOP + tn.string * LINE;
      if (x < LEFT - 20 || x > W + 20) continue;
      const label = String(tn.fret);
      const w = label.length * 8 + 4;
      g.fillStyle = track.color + "55";
      g.fillRect(x + w / 2, y - 1, Math.max(0, tn.note.dur * ppb - w / 2 - 2), 2);
      g.fillStyle = "#26272b";
      g.fillRect(x - w / 2, y - 7, w, 14);
      g.fillStyle = "#f2f2f2";
      g.fillText(label, x, y + 1);
    }
    g.textAlign = "left";
    // playhead
    const ph = X(engine.beat - clip.start);
    if (ph >= LEFT && ph <= W) {
      g.fillStyle = T.ink;
      g.fillRect(Math.round(ph), 0, 1.5, H);
      g.beginPath();
      g.moveTo(ph - 5, 0);
      g.lineTo(ph + 5, 0);
      g.lineTo(ph, 7);
      g.fill();
    }
    // string names (sticky left column)
    g.fillStyle = "#26272b";
    g.fillRect(0, 0, LEFT - 4, H);
    g.font = `bold 12px ${T.font}`;
    g.fillStyle = T.body;
    tuning.strings.forEach((p, s) => g.fillText(NOTE_NAMES[p % 12], 12, TOP + s * LINE));
    g.fillStyle = T.faint;
    g.font = `10px ${T.font}`;
    g.fillText("TAB", 8, H - 12);
  };

  useEffect(() => {
    draw();
  });
  // Playhead: redraw on any position change; follow while playing.
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      const beat = engine.beat, el = wrap.current;
      if (beat !== last && el) {
        last = beat;
        if (engine.playing && store.ui.follow) {
          const x = LEFT + (beat - clip.start) * ppb;
          if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + LEFT) el.scrollLeft = Math.max(0, x - LEFT - 60);
        }
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  });

  const hitNote = (e: React.MouseEvent): TabNote | undefined => {
    const el = wrap.current!;
    const r = el.getBoundingClientRect();
    const beat = (e.clientX - r.left - LEFT + el.scrollLeft) / ppb;
    const s = Math.round((e.clientY - r.top - TOP) / LINE);
    return tab.find((tn) => tn.string === s && Math.abs(tn.note.start - beat) * ppb < 9);
  };

  return (
    <div className="tab-view">
      <div className="tab-opts">
        <Select value={tuning.id} width={180} options={TUNINGS.map((t) => ({ value: t.id, label: t.label }))} onChange={setTuningId} />
        <span className="label">{tab.length} notes{dropped > 0 ? ` · ${dropped} out of range / too dense` : ""} · click: play · right-click: delete</span>
      </div>
      <div
        className="tab-scroll"
        ref={wrap}
        onScroll={draw}
        onMouseDown={(e) => {
          const tn = hitNote(e);
          if (!tn) return;
          if (e.button === 2) store.update(() => clip.notes.splice(clip.notes.indexOf(tn.note), 1));
          else engine.previewNote(track.id, tn.note.pitch);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div style={{ position: "absolute", top: 0, left: 0, width: totalW, height: H, pointerEvents: "none" }} />
        <canvas ref={cv} />
      </div>
    </div>
  );
}
