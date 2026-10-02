import { useEffect } from "react";
import { convertToMidi } from "../../assist/convert";
import { splitStems } from "../../assist/separate";
import { cleanAudio } from "../../assist/clean";
import { deleteClip, deleteClips, deleteTrack, duplicateClip, duplicateClips, duplicateTrack, findClip, selectedClips, splitClip, splitClips, editRange, insertSilence } from "../../edit/ops";
import { engine } from "../../engine/transport";
import { store, useStore } from "../../model/store";
import { runTask } from "../common/runTask";
import { applyProMix, chainFor } from "../../model/chains";
import { isMultiKit } from "../../instruments/multikit";

/** Right-click menu for regions and tracks (Logic / Ableton conventions). */
export default function ContextMenu() {
  const s = useStore();
  const m = s.ui.contextMenu;
  useEffect(() => {
    if (!m) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".ctx") && store.setUi({ contextMenu: null });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && store.setUi({ contextMenu: null });
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [m]);
  if (!m) return null;
  const track = s.project.tracks.find((t) => t.id === m.trackId);
  const clip = m.clipId ? findClip(m.clipId)?.clip : undefined;
  const group = clip ? selectedClips() : [];
  const busy = !!s.ui.busy;
  const range = s.ui.range;
  const loop = s.project.loop;
  const fmtBars = (a: number, b: number) => `bars ${+(a / 4 + 1).toFixed(2)}–${+(b / 4 + 1).toFixed(2)}`;
  const act = (fn: () => void) => () => {
    store.setUi({ contextMenu: null });
    fn();
  };
  const left = Math.min(m.x, window.innerWidth - 280), top = Math.max(8, Math.min(m.y, window.innerHeight - 520));

  return (
    <div className="ctx popover menu" style={{ position: "fixed", left, top }}>
      {range && (
        <>
          <div className="menu-title">selection · {fmtBars(range.start, range.end)} · {range.trackIds.length} track{range.trackIds.length > 1 ? "s" : ""}</div>
          <button onClick={act(() => { editRange(range, "delete"); store.setUi({ range: null }); })}>delete slice (leave gap) <kbd>⌫</kbd></button>
          <button onClick={act(() => { editRange(range, "ripple"); store.setUi({ range: null }); })}>delete slice &amp; close gap <kbd>⇧⌫</kbd></button>
          <button onClick={act(() => editRange(range, "split"))}>split regions at edges <kbd>⌘T</kbd></button>
          <button onClick={act(() => store.update((pp) => { pp.loop = { on: true, start: range.start, end: range.end }; }))}>set cycle to selection</button>
          <div className="menu-sep" />
        </>
      )}
      {clip && group.length > 1 && (
        <>
          <div className="menu-title">{group.length} regions selected</div>
          <button onClick={act(() => splitClips(group, engine.beat))}>split all at playhead <kbd>⌘T</kbd></button>
          <button onClick={act(() => duplicateClips(group))}>duplicate group <kbd>⌘D</kbd></button>
          <button onClick={act(() => deleteClips(group))}>delete group <kbd>⌫</kbd></button>
          <div className="menu-sep" />
        </>
      )}
      {clip && group.length <= 1 && (
        <>
          <div className="menu-title">region</div>
          {clip.kind === "midi" && (
            <>
              <button onClick={act(() => store.setUi({ selectedClipId: clip.id, selectedTrackId: m.trackId, showEditor: true, editorTab: "piano" }))}>piano roll <kbd>P</kbd></button>
              <button onClick={act(() => store.setUi({ selectedClipId: clip.id, selectedTrackId: m.trackId, showEditor: true, editorTab: "drums" }))}>drum producer…</button>
              <button onClick={act(() => store.setUi({ selectedClipId: clip.id, selectedTrackId: m.trackId, showEditor: true, editorTab: "parts" }))}>part producer (keys · vocal · guitar)…</button>
              <div className="menu-sep" />
            </>
          )}
          <button onClick={act(() => splitClip(clip.id, engine.beat))}>split at playhead <kbd>⌘T</kbd></button>
          <button onClick={act(() => duplicateClip(clip.id))}>duplicate <kbd>⌘D</kbd></button>
          <button onClick={act(() => deleteClip(clip.id))}>delete <kbd>⌫</kbd></button>
        </>
      )}
      {track && (
        <>
          <div className="menu-title">track · {track.name}</div>
          {track.kind === "audio" && (
            <>
              <button disabled={busy} onClick={act(() => runTask(() => splitStems(track.id, "ai")))}>split into stems (6, ai)</button>
              <button disabled={busy} onClick={act(() => runTask(() => cleanAudio(track.id, 1)))}>clean: dereverb + denoise</button>
              <button disabled={busy} onClick={act(() => runTask(() => convertToMidi(track.id)))}>to midi</button>
              <button disabled={busy} onClick={act(() => runTask(() => convertToMidi(track.id, { model: "medium" })))}>to midi · accurate model</button>
              <div className="menu-sep" />
            </>
          )}
          {track.kind === "midi" && <button onClick={act(() => store.setUi({ showLibrary: true }))}>choose instrument… <kbd>Y</kbd></button>}
          {track.kind === "midi" && !track.pp && (chainFor(track.instrument) || isMultiKit(track.instrument)) && (
            <button onClick={act(() => { store.update((pp) => void applyProMix(pp, track.id)); store.log(`Pro mix applied to "${track.name}"${isMultiKit(track.instrument) ? " (all mic channels + drum bus)" : ""}`); })}>
              reset to pro mix<small>{isMultiKit(track.instrument) ? "mic eq · comp · drum bus" : "eq · comp · saturation"}</small>
            </button>
          )}
          <button onClick={act(() => store.setUi({ showEditor: true, editorTab: "eq" }))}>channel eq</button>
          <button onClick={act(() => duplicateTrack(track.id))}>duplicate track</button>
          <button onClick={act(() => deleteTrack(track.id))}>delete track</button>
        </>
      )}
      {loop.on && loop.end > loop.start && (
        <>
          <div className="menu-title">cycle · {fmtBars(loop.start, loop.end)} · all tracks</div>
          <button onClick={act(() => editRange({ start: loop.start, end: loop.end, trackIds: null }, "delete"))}>delete inside cycle (leave gap)</button>
          <button onClick={act(() => editRange({ start: loop.start, end: loop.end, trackIds: null }, "ripple"))}>cut cycle section &amp; close gap</button>
          <button onClick={act(() => insertSilence(loop.start, loop.end))}>insert silence at cycle</button>
        </>
      )}
    </div>
  );
}
