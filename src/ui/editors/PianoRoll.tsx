import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../../engine/transport";
import { store, useStoreQuiet } from "../../model/store";
import { NOTE_NAMES, type MidiClip, type Note, type Track } from "../../model/types";
import { T } from "../common/theme";
import Tablature from "./Tablature";
import Select from "../common/Select";
import NumberField from "../common/NumberField";

const KEYS_W = 46;
const ROW = 10;
const LO = 21, HI = 108;
const ROWS = HI - LO + 1;
const BLACK = new Set([1, 3, 6, 8, 10]);
const VEL_H = 64;
const EDGE = 6; // px from a note's end that grabs the resize handle

function findClip(): { track: Track; clip: MidiClip } | null {
  const id = store.ui.selectedClipId;
  for (const t of store.project.tracks)
    for (const c of t.clips) if (c.id === id && c.kind === "midi") return { track: t, clip: c };
  return null;
}

/** Notes copied with ⌘C / ⌘X, positions relative to the earliest one. Shared across clips. */
let clipboard: Note[] = [];

type Drag =
  | { kind: "move" | "end" | "start"; x0: number; beat0: number; pitch0: number; orig: Map<Note, Note>; moved: boolean; hit: Note; wasSelected: boolean; shift: boolean; copy: boolean }
  | { kind: "marquee"; b0: number; p0: number; b1: number; p1: number; base: Set<Note> }
  | { kind: "vel"; y0: number; orig: Map<Note, number>; hit: Note };

export default function PianoRoll() {
  const s = useStoreQuiet();
  const mode = s.ui.rollMode;
  const sel = findClip();
  const pianoRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const velRef = useRef<HTMLCanvasElement>(null);
  const [grid, setGrid] = useState(0.25);
  const [ppb, setPpb] = useState(40);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [selected, setSelected] = useState<Set<Note>>(new Set());
  const [active, setActive] = useState(false);
  const drag = useRef<Drag | null>(null);
  const lastLen = useRef(0.25);
  const lastVel = useRef(100);
  const selRef = useRef(selected);
  selRef.current = selected;

  /** Selection limited to notes still in the clip (undo replaces note objects → selection empties). */
  const liveSel = useCallback((clip: MidiClip) => clip.notes.filter((n) => selRef.current.has(n)), []);

  const redraw = useCallback(() => {
    const cv = cvRef.current, el = wrapRef.current;
    const cur = findClip();
    if (!cv || !el || !cur) return;
    const { clip, track } = cur;
    const dpr = devicePixelRatio || 1;
    const W = cv.width / dpr, H = cv.height / dpr;
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = el.scrollLeft, sy = el.scrollTop;
    const X = (b: number) => KEYS_W + b * ppb - sx;
    const Y = (pitch: number) => (HI - pitch) * ROW - sy;
    g.fillStyle = T.bg;
    g.fillRect(0, 0, W, H);
    for (let p = LO; p <= HI; p++) {
      const y = Y(p);
      if (y < -ROW || y > H) continue;
      g.fillStyle = BLACK.has(p % 12) ? T.rowBlack : T.rowWhite;
      g.fillRect(KEYS_W, y, W, ROW);
      if (p % 12 === 0) {
        g.fillStyle = T.grid;
        g.fillRect(KEYS_W, y + ROW - 1, W, 1);
      }
    }
    for (let b = 0; b <= clip.length; b += grid) {
      const x = Math.round(X(b)) + 0.5;
      if (x < KEYS_W || x > W) continue;
      g.strokeStyle = b % 4 === 0 ? T.tick : b % 1 === 0 ? T.gridStrong : T.gridFaint;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
    // Chord labels from analysis, for reference.
    g.font = `11px ${T.font}`;
    for (const ch of store.project.chords) {
      const rel = ch.start - clip.start;
      if (rel + ch.length < 0 || rel > clip.length) continue;
      g.fillStyle = T.cycle;
      g.fillText(`${NOTE_NAMES[ch.root]}${ch.minor ? "m" : ""}`, X(rel) + 3, 11);
    }
    const selSet = selRef.current;
    for (const n of clip.notes) {
      const x = X(n.start), y = Y(n.pitch);
      const w = Math.max(2, n.dur * ppb - 1);
      if (x > W || x + w < KEYS_W || y < -ROW || y > H) continue;
      const on = selSet.has(n);
      g.fillStyle = on ? "#ffffff" : track.color;
      g.globalAlpha = on ? 0.92 : 0.45 + (n.vel / 127) * 0.55;
      g.fillRect(x + 0.5, y + 1, w, ROW - 2);
      g.globalAlpha = 1;
      if (on) {
        g.fillStyle = track.color;
        g.fillRect(x + 1.5, y + 2, Math.max(1, w - 2), ROW - 4);
        g.strokeStyle = "#ffffff";
        g.strokeRect(x + 0.5, y + 1.5, w - 1, ROW - 3);
      } else {
        g.strokeStyle = "rgba(0,0,0,0.6)";
        g.strokeRect(x + 0.5, y + 1.5, w - 1, ROW - 3);
      }
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(x + n.dur * ppb - 3, y + 1, 2, ROW - 2);
    }
    // Rubber band
    const d = drag.current;
    if (d?.kind === "marquee") {
      const x0 = X(Math.min(d.b0, d.b1)), x1 = X(Math.max(d.b0, d.b1));
      const y0 = Y(Math.max(d.p0, d.p1)), y1 = Y(Math.min(d.p0, d.p1)) + ROW;
      g.fillStyle = "rgba(74,158,255,0.12)";
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = T.accent;
      g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    }
    // End-of-clip shade.
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(X(clip.length), 0, W, H);
    // Playhead
    const ph = X(engine.beat - clip.start);
    if (ph >= KEYS_W && ph <= W) {
      g.fillStyle = T.ink;
      g.fillRect(Math.round(ph), 0, 1.5, H);
      g.beginPath();
      g.moveTo(ph - 5, 0);
      g.lineTo(ph + 5, 0);
      g.lineTo(ph, 7);
      g.fill();
    }
    // Keyboard
    for (let p = LO; p <= HI; p++) {
      const y = Y(p);
      if (y < -ROW || y > H) continue;
      const black = BLACK.has(p % 12);
      g.fillStyle = black ? T.keyBlack : T.keyWhite;
      g.fillRect(0, y, KEYS_W - 1, ROW - 1);
      if (p % 12 === 0) {
        g.fillStyle = T.bg;
        g.font = `9px ${T.font}`;
        g.fillText(`C${p / 12 - 1}`, 26, y + ROW - 2);
      }
    }

    // Velocity lane (same horizontal scroll)
    const vc = velRef.current;
    if (vc) {
      const vw = vc.width / dpr, vh = vc.height / dpr;
      const v = vc.getContext("2d")!;
      v.setTransform(dpr, 0, 0, dpr, 0, 0);
      v.fillStyle = T.bg;
      v.fillRect(0, 0, vw, vh);
      v.fillStyle = T.header;
      v.fillRect(0, 0, KEYS_W - 1, vh);
      v.fillStyle = T.muted;
      v.font = `10px ${T.font}`;
      v.fillText("vel", 8, 14);
      v.strokeStyle = T.gridFaint;
      for (const f of [0.25, 0.5, 0.75]) {
        v.beginPath();
        v.moveTo(KEYS_W, Math.round(vh - 4 - f * (vh - 8)) + 0.5);
        v.lineTo(vw, Math.round(vh - 4 - f * (vh - 8)) + 0.5);
        v.stroke();
      }
      const draw = (n: Note, on: boolean) => {
        const x = X(n.start);
        if (x < KEYS_W - 2 || x > vw) return;
        const h = (n.vel / 127) * (vh - 8);
        v.fillStyle = on ? "#ffffff" : track.color;
        v.fillRect(Math.round(x), vh - 4 - h, 2, h);
        v.fillRect(Math.round(x) - 2, vh - 4 - h, 6, 2);
      };
      for (const n of clip.notes) if (!selSet.has(n)) draw(n, false);
      for (const n of clip.notes) if (selSet.has(n)) draw(n, true);
      v.fillStyle = "rgba(0,0,0,0.5)";
      v.fillRect(X(clip.length), 0, vw, vh);
    }
  }, [ppb, grid]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [sel?.clip.id, mode]);

  useEffect(() => {
    const dpr = devicePixelRatio || 1;
    const cv = cvRef.current;
    if (cv) {
      cv.width = size.w * dpr;
      cv.height = size.h * dpr;
      cv.style.width = size.w + "px";
      cv.style.height = size.h + "px";
    }
    const vc = velRef.current;
    if (vc) {
      vc.width = size.w * dpr;
      vc.height = VEL_H * dpr;
      vc.style.width = size.w + "px";
      vc.style.height = VEL_H + "px";
    }
    redraw();
  }, [size, redraw, mode]);

  // Centre the view on the clip's notes when a new clip opens; a new clip starts with no selection.
  useEffect(() => {
    setSelected(new Set());
    const el = wrapRef.current;
    const cur = findClip();
    if (!el || !cur) return;
    const ps = cur.clip.notes.map((n) => n.pitch);
    const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
    el.scrollTop = (HI - mid) * ROW - el.clientHeight / 2;
    el.scrollLeft = 0;
  }, [sel?.clip.id]);

  useEffect(() => {
    redraw();
  });
  // Playhead: redraw whenever the position moves (playing or seeking); follow it while playing.
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      const beat = engine.beat;
      const el = wrapRef.current, cur = findClip();
      if (beat !== last && el && cur) {
        last = beat;
        if (engine.playing && store.ui.follow) {
          const x = KEYS_W + (beat - cur.clip.start) * ppb;
          if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + KEYS_W) el.scrollLeft = Math.max(0, x - KEYS_W - 60);
        }
        redraw();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [redraw]);

  // Key focus: the piano roll owns the keyboard after a click inside it (until a click elsewhere).
  useEffect(() => {
    const down = (e: MouseEvent) => setActive(!!pianoRef.current?.contains(e.target as Node));
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, []);

  // Note-editing keys. Capture phase on window, so the global shortcuts (delete clip, track
  // up/down, duplicate clip) never see a key the piano roll handled.
  useEffect(() => {
    if (!active || mode !== "bricks") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      const cur = findClip();
      if (!cur) return;
      const { clip, track } = cur;
      const mod = e.metaKey || e.ctrlKey;
      const selNotes = liveSel(clip);
      const has = selNotes.length > 0;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        store.checkpoint(); // each key edit is its own undo step
      };
      const shiftNotes = (dBeat: number, dPitch: number) => {
        if (!has) return;
        const minStart = Math.min(...selNotes.map((n) => n.start));
        const lo = Math.min(...selNotes.map((n) => n.pitch)), hi = Math.max(...selNotes.map((n) => n.pitch));
        const db = Math.max(-minStart, dBeat);
        const dp = Math.max(LO - lo, Math.min(HI - hi, dPitch));
        if (!db && !dp) return;
        store.update(() => selNotes.forEach((n) => { n.start += db; n.pitch += dp; }));
        if (dp && selNotes.length === 1) engine.previewNote(track.id, selNotes[0].pitch);
      };
      switch (e.code) {
        case "Delete":
        case "Backspace":
          stop(); // never deletes the clip from inside the piano roll
          if (has) {
            store.update(() => { clip.notes = clip.notes.filter((n) => !selRef.current.has(n)); });
            setSelected(new Set());
          }
          return;
        case "ArrowUp":
        case "ArrowDown":
          if (!has || mod) return;
          stop();
          shiftNotes(0, (e.code === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1));
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          if (!has || mod) return;
          stop();
          const dir = e.code === "ArrowRight" ? 1 : -1;
          if (e.altKey) store.update(() => selNotes.forEach((n) => { n.dur = Math.max(grid, n.dur + dir * grid); }));
          else shiftNotes(dir * (e.shiftKey ? 4 : grid), 0);
          return;
        }
        case "Escape":
          if (!has) return;
          stop();
          setSelected(new Set());
          return;
        case "KeyA":
          if (!mod) return;
          stop();
          setSelected(new Set(clip.notes));
          return;
        case "KeyC":
        case "KeyX":
          if (!mod || !has) return;
          stop();
          {
            const t0 = Math.min(...selNotes.map((n) => n.start));
            clipboard = selNotes.map((n) => ({ ...n, start: n.start - t0 }));
          }
          if (e.code === "KeyX") {
            store.update(() => { clip.notes = clip.notes.filter((n) => !selRef.current.has(n)); });
            setSelected(new Set());
          }
          return;
        case "KeyV": {
          if (!mod || !clipboard.length) return;
          stop();
          const rel = engine.beat - clip.start;
          const at = rel >= 0 && rel < clip.length ? Math.round(rel / grid) * grid : has ? Math.max(...selNotes.map((n) => n.start + n.dur)) : 0;
          const pasted = clipboard.map((n) => ({ ...n, start: n.start + at }));
          store.update(() => clip.notes.push(...pasted));
          setSelected(new Set(pasted));
          return;
        }
        case "KeyD": {
          if (!mod || !has) return;
          stop();
          const t0 = Math.min(...selNotes.map((n) => n.start)), t1 = Math.max(...selNotes.map((n) => n.start + n.dur));
          const span = Math.max(grid, Math.ceil((t1 - t0) / grid - 1e-9) * grid);
          const copies = selNotes.map((n) => ({ ...n, start: n.start + span }));
          store.update(() => clip.notes.push(...copies));
          setSelected(new Set(copies));
          return;
        }
        case "KeyQ":
          if (mod || !has) return;
          stop();
          store.update(() => selNotes.forEach((n) => { n.start = Math.round(n.start / grid) * grid; n.dur = Math.max(grid, Math.round(n.dur / grid) * grid); }));
          return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, mode, grid, liveSel]);

  if (!sel) return <div className="hint">Double-click a MIDI clip in the timeline to edit it (double-click an empty spot on a MIDI track to create one).</div>;
  const { clip, track } = sel;
  const selNotes = clip.notes.filter((n) => selected.has(n));

  const pos = (e: { clientX: number; clientY: number }) => {
    const el = wrapRef.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, beat: (x - KEYS_W + el.scrollLeft) / ppb, pitch: HI - Math.floor((y + el.scrollTop) / ROW) };
  };
  const noteAt = (beat: number, pitch: number) => {
    // topmost (last drawn) wins
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      if (n.pitch === pitch && beat >= n.start && beat < n.start + Math.max(n.dur, 3 / ppb)) return n;
    }
    return null;
  };
  const edgeOf = (n: Note, x: number): "end" | "start" | "move" => {
    const sx = wrapRef.current!.scrollLeft;
    const x0 = KEYS_W + n.start * ppb - sx, x1 = KEYS_W + (n.start + n.dur) * ppb - sx;
    if (x1 - x < EDGE && x1 - x0 > 8) return "end";
    if (x - x0 < 4 && x1 - x0 > 16) return "start";
    return "move";
  };
  const snapD = (d: number, free: boolean) => (free ? d : Math.round(d / grid) * grid);

  const onMouseDown = (e: React.MouseEvent) => {
    store.checkpoint(); // every gesture is its own undo step
    const p0 = pos(e);
    if (p0.x < KEYS_W) {
      engine.previewNote(track.id, p0.pitch);
      return;
    }
    const hit = noteAt(p0.beat, p0.pitch);
    if (e.button === 2) {
      // right-click: delete the note (or the whole selection it belongs to)
      if (hit) {
        const kill = selected.has(hit) ? selected : new Set([hit]);
        store.update(() => { clip.notes = clip.notes.filter((n) => !kill.has(n)); });
        setSelected(new Set([...selected].filter((n) => !kill.has(n))));
      }
      return;
    }
    if (hit) {
      const wasSelected = selected.has(hit);
      let next = selected;
      if (e.shiftKey) {
        next = new Set(selected);
        if (wasSelected) next.delete(hit);
        else next.add(hit);
      } else if (!wasSelected) next = new Set([hit]);
      setSelected(next);
      selRef.current = next;
      if (e.shiftKey && wasSelected) return;
      const group = clip.notes.filter((n) => next.has(n));
      drag.current = { kind: e.altKey ? "move" : edgeOf(hit, p0.x), x0: p0.x, beat0: p0.beat, pitch0: p0.pitch, orig: new Map(group.map((n) => [n, { ...n }])), moved: false, hit, wasSelected, shift: e.shiftKey, copy: e.altKey };
      engine.previewNote(track.id, hit.pitch);
    } else if (e.detail >= 2) {
      // double-click on empty space: new note (drag right away to set its length)
      const n: Note = { pitch: p0.pitch, start: Math.max(0, Math.floor(p0.beat / grid) * grid), dur: lastLen.current, vel: lastVel.current };
      if (n.start >= clip.length) return;
      store.update(() => clip.notes.push(n));
      const next = new Set([n]);
      setSelected(next);
      selRef.current = next;
      drag.current = { kind: "end", x0: p0.x, beat0: p0.beat, pitch0: p0.pitch, orig: new Map([[n, { ...n }]]), moved: true, hit: n, wasSelected: true, shift: false, copy: false };
      engine.previewNote(track.id, n.pitch);
    } else {
      const base = e.shiftKey ? new Set(selected) : new Set<Note>();
      if (!e.shiftKey) setSelected(base);
      selRef.current = base;
      drag.current = { kind: "marquee", b0: p0.beat, p0: p0.pitch, b1: p0.beat, p1: p0.pitch, base };
    }
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d || d.kind === "vel") return;
      const p1 = pos(ev);
      if (d.kind === "marquee") {
        d.b1 = p1.beat;
        d.p1 = p1.pitch;
        const b0 = Math.min(d.b0, d.b1), b1 = Math.max(d.b0, d.b1), lo = Math.min(d.p0, d.p1), hi = Math.max(d.p0, d.p1);
        const next = new Set(d.base);
        for (const n of clip.notes) if (n.pitch >= lo && n.pitch <= hi && n.start < b1 && n.start + n.dur > b0) next.add(n);
        selRef.current = next;
        setSelected(next);
        redraw();
        return;
      }
      if (!d.moved && Math.abs(p1.x - d.x0) < 3 && p1.pitch === d.pitch0) return;
      d.moved = true;
      if (d.copy) {
        // ⌥-drag copies once the drag really moves: the originals stay, the copies move
        d.copy = false;
        const copies = [...d.orig.values()].map((o) => ({ ...o }));
        const old = [...d.orig.keys()];
        const hitCopy = copies[old.indexOf(d.hit)];
        store.update(() => clip.notes.push(...copies));
        d.orig = new Map(copies.map((c) => [c, { ...c }]));
        d.hit = hitCopy;
        const moved = new Set(copies);
        selRef.current = moved;
        setSelected(moved);
      }
      const free = ev.metaKey || ev.ctrlKey;
      const db = snapD(p1.beat - d.beat0, free);
      const notes = [...d.orig.keys()];
      store.update(() => {
        if (d.kind === "move") {
          const minStart = Math.min(...notes.map((n) => d.orig.get(n)!.start));
          const lo = Math.min(...notes.map((n) => d.orig.get(n)!.pitch)), hi = Math.max(...notes.map((n) => d.orig.get(n)!.pitch));
          const b = Math.max(-minStart, db);
          const dp = Math.max(LO - lo, Math.min(HI - hi, p1.pitch - d.pitch0));
          const before = d.hit.pitch;
          for (const n of notes) {
            const o = d.orig.get(n)!;
            n.start = o.start + b;
            n.pitch = o.pitch + dp;
          }
          if (d.hit.pitch !== before) engine.previewNote(track.id, d.hit.pitch);
        } else if (d.kind === "end") {
          const minLen = free ? 0.02 : grid;
          for (const n of notes) {
            const o = d.orig.get(n)!;
            n.dur = Math.max(minLen, o.dur + db);
          }
          lastLen.current = d.hit.dur;
        } else {
          for (const n of notes) {
            const o = d.orig.get(n)!;
            const ns = Math.max(0, Math.min(o.start + o.dur - (free ? 0.02 : grid), o.start + db));
            n.dur = o.start + o.dur - ns;
            n.start = ns;
          }
        }
      });
    };
    const up = () => {
      const d = drag.current;
      // plain click on a note of a group: just that note (normal DAW behaviour)
      if (d && d.kind !== "marquee" && d.kind !== "vel" && !d.moved && d.wasSelected && !d.shift) {
        const only = new Set([d.hit]);
        selRef.current = only;
        setSelected(only);
      }
      if (d && d.kind !== "marquee" && d.kind !== "vel") lastVel.current = d.hit.vel;
      drag.current = null;
      redraw();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onHover = (e: React.MouseEvent) => {
    if (drag.current || !wrapRef.current) return;
    const p = pos(e);
    const hit = p.x >= KEYS_W ? noteAt(p.beat, p.pitch) : null;
    const k = hit ? edgeOf(hit, p.x) : null;
    wrapRef.current.style.cursor = !hit ? (p.x < KEYS_W ? "pointer" : "default") : k === "move" ? "grab" : "ew-resize";
  };

  const onVelDown = (e: React.MouseEvent) => {
    store.checkpoint();
    const vc = velRef.current!, el = wrapRef.current!;
    const r = vc.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < KEYS_W) return;
    // nearest stem within 5 px, selected notes first
    let hit: Note | null = null, bd = 6;
    for (const pass of [true, false])
      for (const n of clip.notes) {
        if (selected.has(n) !== pass) continue;
        const d = Math.abs(KEYS_W + n.start * ppb - el.scrollLeft - x);
        if (d < bd) { bd = d; hit = n; }
      }
    if (!hit) return;
    const group = selected.has(hit) ? clip.notes.filter((n) => selected.has(n)) : [hit];
    if (!selected.has(hit)) {
      const only = new Set([hit]);
      selRef.current = only;
      setSelected(only);
    }
    const h = r.height - 8;
    const target = Math.max(1, Math.min(127, Math.round(((r.bottom - 4 - e.clientY) / h) * 127)));
    const d: Drag = { kind: "vel", y0: e.clientY, orig: new Map(group.map((n) => [n, n.vel])), hit };
    const delta0 = target - hit.vel;
    const apply = (dv: number) => store.update(() => { for (const [n, v] of d.orig) n.vel = Math.max(1, Math.min(127, Math.round(v + dv))); });
    apply(delta0);
    const move = (ev: MouseEvent) => apply(delta0 + ((d.y0 - ev.clientY) / h) * 127);
    const up = () => {
      lastVel.current = hit!.vel;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const target = () => (selNotes.length ? selNotes : clip.notes);
  const quantize = () =>
    store.update(() => {
      for (const n of target()) {
        n.start = Math.round(n.start / grid) * grid;
        n.dur = Math.max(grid, Math.round(n.dur / grid) * grid);
      }
    });
  const transpose = (d: number) => store.update(() => target().forEach((n) => (n.pitch = Math.max(LO, Math.min(HI, n.pitch + d)))));
  const avgVel = selNotes.length ? Math.round(selNotes.reduce((a, n) => a + n.vel, 0) / selNotes.length) : 0;

  return (
    <div className={`piano ${mode === "bricks" ? "bricks" : ""} ${active ? "focused" : ""}`} ref={pianoRef}>
      <div className="bar">
        <div className="seg">
          <button className={mode === "bricks" ? "on" : ""} onClick={() => store.setUi({ rollMode: "bricks" })}>midi</button>
          <button className={mode === "tab" ? "on" : ""} onClick={() => store.setUi({ rollMode: "tab" })}>tab</button>
        </div>
        <b style={{ color: track.color }}>{track.name}</b>
        <span className="label">{selNotes.length ? `${selNotes.length}/${clip.notes.length} selected` : `${clip.notes.length} notes`}</span>
        <span className="label">Grid</span>
        <Select value={grid} width={70} options={[{ value: 0.25, label: "1/16" }, { value: 0.5, label: "1/8" }, { value: 1, label: "1/4" }, { value: 2, label: "1/2" }, { value: 4, label: "1 bar" }, { value: 1 / 3, label: "1/4 T" }, { value: 1 / 6, label: "1/8 T" }, { value: 0.125, label: "1/32" }]} onChange={setGrid} />
        <button onClick={quantize} data-tip={selNotes.length ? "quantize selected notes (Q)" : "quantize all notes"}>Quantize</button>
        <button className="icon" onClick={() => transpose(-12)} data-tip="octave down (⇧↓)">−12</button>
        <button className="icon" onClick={() => transpose(-1)} data-tip="semitone down (↓)">−1</button>
        <button className="icon" onClick={() => transpose(1)} data-tip="semitone up (↑)">+1</button>
        <button className="icon" onClick={() => transpose(12)} data-tip="octave up (⇧↑)">+12</button>
        {selNotes.length > 0 && (
          <>
            <span className="label">vel</span>
            <NumberField value={avgVel} min={1} max={127} step={1} width={44} onCommit={(v) => store.update(() => selNotes.forEach((n) => (n.vel = Math.round(v))))} />
            <button onClick={() => { store.update(() => { clip.notes = clip.notes.filter((n) => !selected.has(n)); }); setSelected(new Set()); }} data-tip="delete selected notes (⌫)">Delete notes</button>
          </>
        )}
        <span className="label">Length (bars)</span>
        <NumberField value={clip.length / 4} min={0.25} max={999} step={1} width={48} onCommit={(v) => store.update(() => (clip.length = Math.max(0.25, v) * 4))} />
        <button onClick={() => store.update((p) => { const t = p.tracks.find((x) => x.id === track.id)!; t.clips = t.clips.filter((c) => c.id !== clip.id); })}>Delete clip</button>
        <span className="spacer" />
        <span className="label">Zoom</span>
        <input type="range" min={10} max={160} value={ppb} onChange={(e) => setPpb(+e.target.value)} />
      </div>
      {mode === "tab" ? (
        <Tablature track={track} clip={clip} ppb={ppb} />
      ) : (
        <>
          <div className="canvas-wrap" ref={wrapRef} onScroll={redraw} onMouseDown={onMouseDown} onMouseMove={onHover} onContextMenu={(e) => e.preventDefault()}>
            <div style={{ position: "absolute", top: 0, left: 0, width: KEYS_W + clip.length * ppb + 100, height: ROWS * ROW, pointerEvents: "none" }} />
            <canvas ref={cvRef} />
          </div>
          <div className="vel-lane" onMouseDown={onVelDown} data-tip="drag a stem to set velocity · selected notes move together">
            <canvas ref={velRef} />
          </div>
          <div className="roll-help">
            dbl-click: new note · click/⇧-click: select · drag empty: box select · drag: move (⌥ copy, ⌘ no snap) · edges: resize · ⌫ delete · ↑↓ pitch (⇧ octave) · ←→ move (⇧ bar, ⌥ length) · ⌘A ⌘C ⌘X ⌘V ⌘D · Q quantize · right-click: delete
          </div>
        </>
      )}
    </div>
  );
}
