import { useEffect } from "react";
import { convertToMidi } from "../../assist/convert";
import { splitStems } from "../../assist/separate";
import { cleanAudio } from "../../assist/clean";
import { deleteClip, deleteClips, deleteTrack, duplicateClip, duplicateClips, duplicateTrack, findClip, selectedClips, splitClip, splitClips, editRange, insertSilence } from "../../edit/ops";
import { engine } from "../../engine/transport";
import { store, useStore } from "../../model/store";
import { runTask } from "../common/runTask";
import { canProMix, proMixStyle } from "../../model/chains";
import { applyProMixCmd } from "../../edit/proMix";
import { MIX_STYLE_LABEL } from "../../model/mixStyles";
import { addHarmonyTracks, HARMONY_PRESETS } from "../../assist/harmony";
import { canFreeze, freezeTrack, unfreezeTrack } from "../../edit/freeze";
import { addNaturalSlides, removeSlides } from "../../assist/slides";

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
          {canProMix(s.project, track) && (
            <>
              {(["metal", "rock"] as const).map((st) => (
                <button key={st} onClick={act(() => applyProMixCmd(track.id, st))}>
                  {proMixStyle(s.project, track) === st ? "✓ " : ""}pro mix · {MIX_STYLE_LABEL[st]}<small>{st === "metal" ? "stabbing the drama-style" : "eq · comp · saturation"}</small>
                </button>
              ))}
            </>
          )}
          {track.kind === "midi" && track.role !== "drums" && !track.dp && (
            <>
              <div className="menu-sep" />
              <div className="menu-title">write harmony<small>chord-aware · C3–C5</small></div>
              {HARMONY_PRESETS.map((h) => (
                <button key={h.id} onClick={act(() => addHarmonyTracks(track.id, h.id))}>{h.label}</button>
              ))}
              <div className="menu-sep" />
            </>
          )}
          {track.kind === "midi" && track.role === "bass" && (
            <>
              <button onClick={act(() => addNaturalSlides(track.id))}>natural slides<small>glides into notes · falls before rests</small></button>
              {track.clips.some((c) => c.kind === "midi" && c.notes.some((n) => n.slide)) && <button onClick={act(() => removeSlides(track.id))}>remove slides</button>}
            </>
          )}
          {track.kind === "audio" && (track.role === "vocals" || track.role === "lead") && (
            <button disabled data-tip="harmonies are written as MIDI: use “to midi” on this track first, then write harmony on the MIDI track">write harmony<small>convert to midi first</small></button>
          )}
          {canFreeze(track) && (track.frozen ? (
            <button onClick={act(() => unfreezeTrack(track.id))}>unfreeze track<small>instrument + plug-ins live again</small></button>
          ) : (
            <button disabled={busy} onClick={act(() => runTask(() => freezeTrack(track.id)))}>freeze track<small>render to audio · frees the cpu</small></button>
          ))}
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
