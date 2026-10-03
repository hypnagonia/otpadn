import { createRoot } from "react-dom/client";
import { engine } from "./engine/transport";
import { startPersistence } from "./io/persist";
import { bindMemoryUi, startMemoryMonitor } from "./system/memory";
import { buffers, store } from "./model/store";
import App from "./ui/shell/App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

startPersistence((bytes) => engine.ctx.decodeAudioData(bytes));
bindMemoryUi((m) => store.log(m), () => {}); // the status-bar meter polls by itself
startMemoryMonitor();

// ?debug: expose internals for scripted checks (rendering test projects, measuring mixes).
if (new URLSearchParams(location.search).has("debug")) {
  void Promise.all([import("./engine/render"), import("./dsp/pool"), import("./assist/tracks"), import("./model/types"), import("./plugins/defs"), import("./plugins/nodes"), import("./assist/harmony"), import("./io/persist"), import("./assist/import")]).then(([render, pool, tracks, types, defs, nodes, harmony, persist, imp]) => {
    (window as unknown as Record<string, unknown>).__otpadn = { store, engine, renderProject: render.renderProject, dspPool: pool.dspPool, midiTrack: tracks.midiTrack, uid: types.uid, defaultParams: defs.defaultParams, buffers, audioTrack: tracks.audioTrack, createPlugin: nodes.createPlugin, ensureWorklets: nodes.ensureWorklets, harmony, persist, importAudio: imp.importAudio, demucs: () => import("./ml/demucs"), muscriptor: () => import("./ml/muscriptor"), parts: () => import("./assist/parts"), convert: () => import("./assist/convert"), harmonyLayer: () => import("./analysis/harmonyLayer") };
  });
}
