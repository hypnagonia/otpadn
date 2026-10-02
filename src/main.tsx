import { createRoot } from "react-dom/client";
import { engine } from "./engine/transport";
import { startPersistence } from "./io/persist";
import { bindMemoryUi, startMemoryMonitor } from "./system/memory";
import { store } from "./model/store";
import App from "./ui/shell/App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

startPersistence((bytes) => engine.ctx.decodeAudioData(bytes));
bindMemoryUi((m) => store.log(m), () => {}); // the status-bar meter polls by itself
startMemoryMonitor();

// ?debug: expose internals for scripted checks (rendering test projects, measuring mixes).
if (new URLSearchParams(location.search).has("debug")) {
  void Promise.all([import("./engine/render"), import("./dsp/pool"), import("./assist/tracks"), import("./model/types")]).then(([render, pool, tracks, types]) => {
    (window as unknown as Record<string, unknown>).__otpadn = { store, engine, renderProject: render.renderProject, dspPool: pool.dspPool, midiTrack: tracks.midiTrack, uid: types.uid };
  });
}
