import { useCallback, useRef, useState } from "react";
import { useStore, useStoreQuiet } from "../../model/store";
import EditorPane from "../editors/EditorPane";
import Inspector from "../inspector/Inspector";
import Library from "../library/Library";
import TracksArea from "../tracks/TracksArea";
import { DialogHost } from "../common/Dialog";
import ContextMenu from "./ContextMenu";
import ControlBar from "./ControlBar";
import { openFileWith, useShortcuts } from "./shortcuts";
import Splitter from "./Splitter";
import StatusBar from "./StatusBar";

/**
 * Window layout (Logic / Reaper style):
 *   control bar
 *   library | inspector | tracks area (local toolbar: tools · snap · catch · zoom)
 *   ─ splitter ─
 *   editor pane (mixer / piano roll / console)
 *   status bar
 */
export default function App() {
  const s = useStoreQuiet(); // busy progress / log lines don't re-render the whole window
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const openFile = useCallback(() => fileRef.current?.click(), []);
  useShortcuts(openFile);

  const { showInspector, showLibrary, showEditor } = s.ui;
  const empty = !s.project.tracks.length;

  return (
    <div
      className={`app ${dropping ? "dropping" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={(e) => { e.preventDefault(); setDropping(false); const f = e.dataTransfer.files?.[0]; if (f) openFileWith(f); }}
    >
      <input ref={fileRef} type="file" accept="audio/*,.otpadn" hidden onChange={(e) => e.target.files?.[0] && openFileWith(e.target.files[0])} />
      <ControlBar />
      <div className="workspace" style={{ gridTemplateColumns: `${showLibrary ? "250px " : ""}${showInspector ? "250px " : ""}1fr` }}>
        {showLibrary && <Library />}
        {showInspector && <Inspector />}
        <main className="main">
          <TracksArea />
          {empty && (
            <div className="empty">
              <div className="card">
                <h2>drop a song here</h2>
                <p>Otpadn splits it into bass, vocals, drums and guitar/synth stems, turns them into midi, finds tempo, key, chords and sections, then arranges and mixes it semi-automatically.</p>
                <p className="muted">everything runs in your browser. nothing is uploaded.</p>
                <button className="primary" onClick={openFile}>choose audio file</button>
                <div className="foot"><span>// wav · mp3 · flac · m4a</span><span>⌘O</span></div>
              </div>
            </div>
          )}
          <BusyOverlay />
        </main>
      </div>
      {showEditor && <Splitter />}
      {showEditor && <EditorPane />}
      <StatusBar />
      <ContextMenu />
      <DialogHost />
    </div>
  );
}

/** Progress overlay: the only part of the window that follows busy updates (~12/s). */
function BusyOverlay() {
  const busy = useStore().ui.busy;
  if (!busy) return null;
  return (
    <div className="busy">
      <div>{busy.label}</div>
      <div className="track"><div className="fill" style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
    </div>
  );
}
