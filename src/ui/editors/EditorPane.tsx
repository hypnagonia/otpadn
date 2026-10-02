import { memo } from "react";
import { store, useStore, useStoreQuiet, type EditorTab } from "../../model/store";
import ChannelEq from "../eq/ChannelEq";
import Mixer from "../mixer/Mixer";
import PluginEditor from "../plugins/PluginEditor";
import DrumProducer from "../drumproducer/DrumProducer";
import PartProducer from "../partproducer/PartProducer";
import Console from "./Console";
import PianoRoll from "./PianoRoll";

const TABS: [EditorTab, string, string][] = [
  ["mixer", "mixer", "X"],
  ["eq", "channel eq", ""],
  ["plugin", "plugin", ""],
  ["piano", "piano roll", "P"],
  ["drums", "drum producer", ""],
  ["parts", "part producer", ""],
  ["console", "console", ""],
];

/** Bottom pane (E): Mixer / Piano Roll / Console, resizable via the splitter above it. */
function EditorPane() {
  const s = useStoreQuiet();
  const tab = s.ui.editorTab;
  return (
    <section className="editor" style={{ height: s.ui.editorHeight }}>
      <div className="tabs">
        {TABS.map(([id, label, key]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => store.setUi({ editorTab: id })}>
            {label}
            {key && <kbd>{key}</kbd>}
            {id === "console" && <LogCount />}
          </button>
        ))}
        <span className="spacer" />
        <button className="icon" data-tip="hide editor (E)" onClick={() => store.setUi({ showEditor: false })}>×</button>
      </div>
      <div className="tab-body" key={tab}>{tab === "mixer" ? <Mixer /> : tab === "eq" ? <ChannelEq /> : tab === "plugin" ? <PluginEditor /> : tab === "piano" ? <PianoRoll /> : tab === "drums" ? <DrumProducer /> : tab === "parts" ? <PartProducer /> : <Console />}</div>
    </section>
  );
}

/** Only the console's line count follows the log; the pane itself ignores log traffic. */
function LogCount() {
  const s = useStore();
  return <span className="count">{s.ui.log.length}</span>;
}

// Memoised: re-renders from its own (quiet) store subscription, not on every App render.
export default memo(EditorPane);
