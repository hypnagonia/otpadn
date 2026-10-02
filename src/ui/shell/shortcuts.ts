import { useEffect } from "react";
import { importAudio } from "../../assist/import";
import { deleteClips, duplicateClips, editRange, moveClips, selectAllClips, selectClips, selectedClips, splitClips, findClip, TOOLS } from "../../edit/ops";
import { engine } from "../../engine/transport";
import { isRecording, stopRecording, toggleRecording } from "../../engine/recorder";
import { exportWav } from "../../io/export";
import { store } from "../../model/store";
import { runTask } from "../common/runTask";
import { zoomToFit } from "../tracks/TracksArea";
import { enableMidiInput, handleTypingKey, toggleTyping } from "../../engine/liveInput";

const TYPING = new Set(["text", "number", "search", "email", "password"]);

/** Global key commands, mapped like Logic Pro where an equivalent exists. */
export function useShortcuts(openFile: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && TYPING.has((el as HTMLInputElement).type))) return;
      if (e.code === "CapsLock") {
        toggleTyping();
        return;
      }
      if (handleTypingKey(e, true)) return e.preventDefault();
      const mod = e.metaKey || e.ctrlKey;
      const ui = store.ui;
      const tabToggle = (tab: typeof ui.editorTab) =>
        store.setUi(ui.showEditor && ui.editorTab === tab ? { showEditor: false } : { showEditor: true, editorTab: tab });
      let handled = true;
      switch (e.code) {
        case "Space":
          // Blur first so a focused button doesn't also receive the key and toggle twice.
          (document.activeElement as HTMLElement | null)?.blur();
          if (isRecording()) runTask(stopRecording); // stopping the transport ends the take
          else if (engine.playing) engine.stop();
          else engine.play();
          break;
        case "Enter":
        case "Home":
          engine.seek(store.project.loop.on ? store.project.loop.start : 0);
          break;
        case "Comma":
          engine.seek(Math.ceil(engine.beat / 4) * 4 - 4);
          break;
        case "Period":
          engine.seek(Math.floor(engine.beat / 4) * 4 + 4);
          break;
        case "KeyC":
        case "KeyL":
          if (mod) handled = false;
          else store.update((p) => (p.loop.on = !p.loop.on));
          break;
        case "KeyT":
          if (mod) {
            if (ui.range) editRange(ui.range, "split");
            else if (ui.selectedClipId) splitClips(selectedClips(), engine.beat);
          } else {
            const i = TOOLS.findIndex((t) => t.id === ui.tool);
            store.setUi({ tool: TOOLS[(i + 1) % TOOLS.length].id });
          }
          break;
        case "KeyZ":
          if (mod && e.shiftKey) store.redo();
          else if (mod) store.undo();
          else zoomToFit();
          break;
        case "KeyY":
          if (mod) {
            store.redo();
            break;
          }
          store.setUi({ showLibrary: !ui.showLibrary });
          break;
        case "Escape":
          if (ui.range) store.setUi({ range: null, contextMenu: null });
          else if (selectedClips().length > 1) selectClips([], null);
          else store.setUi({ tool: "pointer", contextMenu: null });
          break;
        case "KeyR":
          if (mod) handled = false;
          else runTask(toggleRecording);
          break;
        case "KeyK":
          if (mod) handled = false;
          else {
            engine.metronome = !engine.metronome;
            store.setUi({});
          }
          break;
        case "KeyI":
          store.setUi({ showInspector: !ui.showInspector });
          break;
        case "KeyE":
          store.setUi({ showEditor: !ui.showEditor });
          break;
        case "KeyX":
          tabToggle("mixer");
          break;
        case "KeyP":
          tabToggle("piano");
          break;
        case "KeyO":
          if (mod) openFile();
          else handled = false;
          break;
        case "KeyB":
          if (mod) runTask(exportWav);
          else handled = false;
          break;
        case "Delete":
        case "Backspace":
          if (ui.range) {
            // range tool: ⌫ = delete the slice (gap stays), ⇧⌫ = delete and close the gap
            editRange(ui.range, e.shiftKey ? "ripple" : "delete");
            store.setUi({ range: null });
          } else if (ui.selectedClipId) deleteClips(selectedClips());
          else handled = false;
          break;
        case "KeyD":
          if (mod && ui.selectedClipId) duplicateClips(selectedClips());
          else handled = false;
          break;
        case "KeyA":
          if (mod) selectAllClips();
          else handled = false;
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          // nudge the selected regions by the snap value (a beat when snap is off)
          const ids = selectedClips();
          if (!ids.length) {
            handled = false;
            break;
          }
          const step = (ui.snap > 0 ? ui.snap : 1) * (e.code === "ArrowLeft" ? -1 : 1);
          store.checkpoint();
          moveClips(new Map(ids.map((id) => [id, findClip(id)!.clip.start] as [string, number])), step);
          break;
        }
          break;
        case "ArrowUp":
        case "ArrowDown": {
          const ts = store.project.tracks;
          const i = ts.findIndex((t) => t.id === ui.selectedTrackId);
          const next = ts[Math.max(0, Math.min(ts.length - 1, i + (e.code === "ArrowUp" ? -1 : 1)))];
          if (next) store.setUi({ selectedTrackId: next.id });
          break;
        }
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => handleTypingKey(e, false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    enableMidiInput();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [openFile]);
}

/** Import a file, then fit the whole song on screen. */
export const openFileWith = (f: File) => runTask(() => importAudio(f)).then(() => requestAnimationFrame(zoomToFit));
