import { useCallback, useEffect, useRef, useState, memo } from "react";
import { midiTrack } from "../../assist/tracks";
import { engine } from "../../engine/transport";
import { DEFAULT_INSTRUMENT } from "../../instruments/catalog";
import { store, useStoreQuiet } from "../../model/store";
import { type Role } from "../../model/types";
import { clipEnd, createMidiClip, deleteClip, deleteTrack, SNAPS, snapBeat, splitClip, TOOLS, trimClip } from "../../edit/ops";
import { drawArrangement, drawPlayhead } from "./drawArrangement";
import { clipLenBeats, RULER_H, TOP_H } from "./geometry";
import TrackHeader from "./TrackHeader";
import { createBus } from "../../edit/routing";
import Select from "../common/Select";

export const ZOOM_MIN = 0.25, ZOOM_MAX = 200; // px per beat

/** Fit the whole project into the visible width (Logic: Z). */
export function zoomToFit() {
  const el = document.querySelector(".arrange") as HTMLElement | null;
  if (!el) return;
  const w = el.clientWidth - 40;
  store.setUi({ pxPerBeat: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, w / Math.max(16, store.project.lengthBeats))) });
  el.scrollLeft = 0;
}

/** Main window: track headers on the left, arrangement canvas (ruler, markers, lanes) on the right. */
function TracksArea() {
  const s = useStoreQuiet();
  const p = s.project;
  const { pxPerBeat: ppb, trackHeight: rowH } = s.ui;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Width + scroll position cached from resize/scroll events: reading them every frame would force a layout per frame. */
  const view = useRef({ w: 800, sx: 0 });
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const loopDraft = useRef<[number, number] | null>(null);

  const totalW = p.lengthBeats * ppb + 400;
  const totalH = TOP_H + p.tracks.length * rowH + 120;

  const redraw = useCallback(() => {
    const el = scrollRef.current, cv = baseRef.current, ov = overRef.current;
    if (!el || !cv || !ov) return;
    const { pxPerBeat, trackHeight, selectedClipId, selectedTrackId } = store.ui;
    drawArrangement(cv, store.project, { ppb: pxPerBeat, sx: el.scrollLeft, sy: el.scrollTop, rowH: trackHeight, selClip: selectedClipId, selTrack: selectedTrackId, loopDraft: loopDraft.current, range: store.ui.range });
    drawPlayhead(ov, engine.beat, pxPerBeat, el.scrollLeft);
    if (headersRef.current) headersRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
  }, []);

  useEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => {
      view.current.w = el.clientWidth;
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const dpr = devicePixelRatio || 1;
    for (const cv of [baseRef.current!, overRef.current!]) {
      cv.width = size.w * dpr;
      cv.height = size.h * dpr;
      cv.style.width = size.w + "px";
      cv.style.height = size.h + "px";
    }
    redraw();
  }, [size, redraw]);

  useEffect(() => {
    redraw();
  });

  // Playhead animation on the overlay only; base layer redraws just when auto-follow scrolls.
  useEffect(() => {
    let raf = 0;
    let lastBeat = -1;
    const loop = () => {
      const el = scrollRef.current, ov = overRef.current;
      const beat = engine.beat;
      if (el && ov && beat !== lastBeat) {
        lastBeat = beat;
        const v = view.current;
        if (engine.playing && store.ui.follow) {
          const x = beat * store.ui.pxPerBeat;
          if (x > v.sx + v.w - 60 || x < v.sx) el.scrollLeft = v.sx = Math.max(0, x - 80); // write only; the scroll event redraws
        }
        drawPlayhead(ov, beat, store.ui.pxPerBeat, v.sx);
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  // Native wheel listener: React's is passive, so Ctrl/⌘+wheel would zoom the whole page.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const beat = (e.clientX - r.left + el.scrollLeft) / store.ui.pxPerBeat;
        const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, store.ui.pxPerBeat * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        store.setUi({ pxPerBeat: nz });
        requestAnimationFrame(() => (el.scrollLeft = beat * nz - (e.clientX - r.left)));
      } else if (e.altKey) {
        e.preventDefault();
        store.setUi({ trackHeight: Math.max(28, Math.min(160, store.ui.trackHeight + (e.deltaY < 0 ? 8 : -8))) });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const hit = (e: { clientX: number; clientY: number }) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const beat = (x + el.scrollLeft) / store.ui.pxPerBeat;
    const row = Math.floor((y + el.scrollTop - TOP_H) / store.ui.trackHeight);
    const track = y >= TOP_H ? store.project.tracks[row] : undefined;
    const spb = 60 / store.project.bpm;
    const clip = track?.clips.find((c) => beat >= c.start && beat < c.start + clipLenBeats(c, spb));
    return { y, beat, track, clip };
  };

  const drag = (move: (e: MouseEvent) => void, up?: () => void) => {
    const u = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", u);
      up?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", u);
  };

  const EDGE_PX = 6;
  const snapped = (b: number, ev: { altKey: boolean }) => (ev.altKey ? b : snapBeat(b, store.ui.snap));

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    store.ui.contextMenu && store.setUi({ contextMenu: null });
    const h = hit(e);
    if (h.y < RULER_H) {
      if (e.shiftKey) {
        const start = Math.round(h.beat / 4) * 4;
        loopDraft.current = [start, start + 4];
        drag(
          (ev) => {
            const b = Math.round(hit(ev).beat / 4) * 4;
            loopDraft.current = [Math.min(start, b), Math.max(start + 4, b)];
            redraw();
          },
          () => {
            const [a, b] = loopDraft.current!;
            loopDraft.current = null;
            store.update((pp) => (pp.loop = { on: true, start: a, end: b }));
          },
        );
      } else {
        engine.seek(Math.max(0, h.beat));
        drag((ev) => engine.seek(Math.max(0, hit(ev).beat)));
      }
      return;
    }
    if (h.y < TOP_H) {
      const sec = store.project.sections.find((sc) => h.beat >= sc.start && h.beat < sc.start + sc.length);
      if (sec) {
        store.update((pp) => (pp.loop = { on: true, start: sec.start, end: sec.start + sec.length }));
        engine.seek(sec.start);
      }
      return;
    }
    if (!h.track) return store.setUi({ selectedClipId: null, range: null });
    const tool = store.ui.tool;
    if (tool === "range") {
      // Drag a time slice across one or more tracks (snapped; alt = free).
      const tracks = store.project.tracks;
      const row0 = tracks.indexOf(h.track);
      const a = snapped(h.beat, e);
      store.setUi({ selectedTrackId: h.track.id, selectedClipId: null, range: null });
      let moved = false;
      drag((ev) => {
        const hh = hit(ev);
        const b = Math.max(0, snapped(hh.beat, ev));
        const row1 = Math.max(0, Math.min(tracks.length - 1, Math.floor((hh.y + scrollRef.current!.scrollTop - TOP_H) / store.ui.trackHeight)));
        const [r0, r1] = [Math.min(row0, row1), Math.max(row0, row1)];
        if (Math.abs(b - a) < 1e-6) return;
        moved = true;
        store.setUi({ range: { start: Math.min(a, b), end: Math.max(a, b), trackIds: tracks.slice(r0, r1 + 1).map((t) => t.id) } });
      }, () => {
        if (!moved) engine.seek(Math.max(0, a)); // a plain click places the playhead
      });
      return;
    }
    if (store.ui.range) store.setUi({ range: null });
    store.setUi({ selectedTrackId: h.track.id, selectedClipId: h.clip?.id ?? null });

    if (tool === "eraser") return h.clip && deleteClip(h.clip.id);
    if (tool === "scissors") return h.clip && splitClip(h.clip.id, snapped(h.beat, e));
    if (tool === "pencil") {
      if (h.clip) return store.setUi({ showEditor: true, editorTab: h.clip.kind === "midi" ? "piano" : store.ui.editorTab });
      if (h.track.kind !== "midi") return;
      const start = Math.floor(h.beat / Math.max(store.ui.snap, 1)) * Math.max(store.ui.snap, 1);
      const c = createMidiClip(h.track.id, start, 4);
      drag((ev) => trimClip(c.id, "end", Math.max(start + 1, snapBeat(hit(ev).beat, store.ui.snap || 1))));
      return;
    }
    if (!h.clip) return;

    // Pointer: trim edges (Pro Tools trim) or move.
    const clip = h.clip;
    const x0 = clip.start * store.ui.pxPerBeat, x1 = clipEnd(clip) * store.ui.pxPerBeat, xm = h.beat * store.ui.pxPerBeat;
    if (x1 - xm < EDGE_PX || xm - x0 < EDGE_PX) {
      const edge = x1 - xm < EDGE_PX ? "end" : "start";
      drag((ev) => trimClip(clip.id, edge, snapped(hit(ev).beat, ev)));
      return;
    }
    const startBeat = clip.start, grab = h.beat;
    drag((ev) => {
      const next = Math.max(0, snapped(startBeat + hit(ev).beat - grab, ev));
      if (next !== clip.start) store.update(() => (clip.start = next));
    });
  };

  const onHover = (e: React.MouseEvent) => {
    const el = scrollRef.current!;
    const h = hit(e);
    let cursor = "default";
    if (h.y < RULER_H) cursor = "text";
    else if (store.ui.tool === "range" && h.track) cursor = "text";
    else if (h.clip) {
      const tool = store.ui.tool;
      const x0 = h.clip.start * store.ui.pxPerBeat, x1 = clipEnd(h.clip) * store.ui.pxPerBeat, xm = h.beat * store.ui.pxPerBeat;
      cursor = tool === "scissors" ? "col-resize" : tool === "eraser" ? "not-allowed" : tool === "pencil" ? "copy" : x1 - xm < EDGE_PX || xm - x0 < EDGE_PX ? "ew-resize" : "grab";
    } else if (store.ui.tool === "pencil" && h.track?.kind === "midi") cursor = "crosshair";
    if (el.style.cursor !== cursor) el.style.cursor = cursor;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const h = hit(e);
    if (!h.track || h.track.kind !== "midi" || store.ui.tool !== "pointer") return;
    if (h.clip) return store.setUi({ selectedClipId: h.clip.id, showEditor: true, editorTab: "piano" });
    createMidiClip(h.track.id, Math.floor(h.beat / 4) * 4, 16);
    store.setUi({ showEditor: true, editorTab: "piano" });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const h = hit(e);
    if (!h.track) return;
    const r = store.ui.range;
    const inRange = !!r && r.trackIds.includes(h.track.id) && h.beat >= r.start && h.beat <= r.end;
    store.setUi({ selectedTrackId: h.track.id, selectedClipId: inRange ? null : h.clip?.id ?? null, range: inRange ? r : null, contextMenu: { x: e.clientX, y: e.clientY, trackId: h.track.id, clipId: inRange ? null : h.clip?.id ?? null, beat: h.beat } });
  };

  const addTrack = (role: Role) =>
    store.update((pp) => {
      const t = midiTrack(role === "drums" ? "Drums" : `Inst ${pp.tracks.length + 1}`, role, [], DEFAULT_INSTRUMENT[role]);
      pp.tracks.push(t);
      store.ui.selectedTrackId = t.id;
    });

  return (
    <div className="tracks-wrap">
      <div className="tracks-toolbar">
        <div className="tt-group">
          <button className="icon" data-tip="new instrument track" onClick={() => addTrack("keys")}>+ inst</button>
          <button className="icon" data-tip="new drum track" onClick={() => addTrack("drums")}>+ drums</button>
          <button className="icon" data-tip="new reverb bus (send channels to it from the mixer)" onClick={() => createBus("reverb")}>+ bus</button>
          <button className="icon" data-tip="delete selected track" disabled={!s.ui.selectedTrackId} onClick={() => s.ui.selectedTrackId && deleteTrack(s.ui.selectedTrackId)}>−</button>
        </div>
        <div className="tt-group tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`icon ${s.ui.tool === t.id ? "on" : ""}`} data-tip={`${t.tip} (T cycles)`} onClick={() => store.setUi({ tool: t.id })}>{t.label}</button>
          ))}
        </div>
        <div className="tt-group">
          <span className="label">snap</span>
          <Select value={s.ui.snap} width={64} tip="snap · hold alt to bypass" options={SNAPS.map((x) => ({ value: x.beats, label: x.label }))} onChange={(v) => store.setUi({ snap: v })} />
        </div>
        <span className="spacer" />
        <div className="tt-group">
          <button className={`icon ${s.ui.follow ? "on" : ""}`} data-tip="catch: follow the playhead" onClick={() => store.setUi({ follow: !s.ui.follow })}>catch</button>
          <span className="label">zoom</span>
          <button className="icon" data-tip="zoom to fit (Z)" onClick={zoomToFit}>fit</button>
          <input type="range" min={Math.log2(ZOOM_MIN)} max={Math.log2(ZOOM_MAX)} step={0.01} value={Math.log2(ppb)} onChange={(e) => store.setUi({ pxPerBeat: 2 ** +e.target.value })} data-tip="horizontal zoom (⌘ + scroll)" />
          <input type="range" min={28} max={160} value={rowH} style={{ width: 60 }} onChange={(e) => store.setUi({ trackHeight: +e.target.value })} data-tip="track height (alt + scroll)" />
        </div>
      </div>
      <div className="tracks-area">
        <div className="headers">
          <div className="headers-top">
            <span className="global-label">Bars | Beats</span>
            <span className="global-label">Markers</span>
          </div>
          <div className="headers-list" onContextMenu={(e) => { e.preventDefault(); const t = store.project.tracks[Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top + (scrollRef.current?.scrollTop ?? 0)) / store.ui.trackHeight)]; if (t) store.setUi({ selectedTrackId: t.id, contextMenu: { x: e.clientX, y: e.clientY, trackId: t.id, clipId: null, beat: engine.beat } }); }}>
            <div className="headers-inner" ref={headersRef}>
              {p.tracks.map((t, i) => (
                <TrackHeader key={t.id} t={t} index={i} height={rowH} selected={s.ui.selectedTrackId === t.id} />
              ))}
            </div>
          </div>
        </div>
        <div className="arrange" ref={scrollRef} onScroll={() => { view.current.sx = scrollRef.current!.scrollLeft; redraw(); }} onMouseDown={onMouseDown} onMouseMove={onHover} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}>
          <div className="spacer-box" style={{ width: totalW, height: totalH }} />
          <div className="layers">
            <canvas ref={baseRef} />
            <canvas ref={overRef} className="overlay" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoised: re-renders from its own (quiet) store subscription, not on every App render.
export default memo(TracksArea);
