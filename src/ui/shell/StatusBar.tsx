import { useEffect, useState } from "react";
import { dspPool } from "../../dsp/pool";
import { engine } from "../../engine/transport";
import { bufferPref, setBufferPref } from "../../engine/audioPrefs";
import { confirmDialog } from "../common/Dialog";
import { muscriptorGpu } from "../../ml/muscriptor";
import { useStore } from "../../model/store";
import { formatTime } from "../common/format";
import { fmt, memory } from "../../system/memory";

/** Bottom status line: selection, project facts, engine/compute info, last log message. */
export default function StatusBar() {
  const s = useStore();
  const p = s.project;
  const track = p.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const last = s.ui.log[s.ui.log.length - 1]?.replace(/^\[[^\]]+\]\s*/, "") ?? "ready";
  return (
    <footer className="statusbar">
      <span>{track ? track.name : "no selection"}</span>
      <span>{p.tracks.length} tracks</span>
      <span>{formatTime(p.lengthBeats * (60 / p.bpm))}</span>
      <span className="spacer" />
      <span className={last.startsWith("Error") ? "err" : ""} data-tip={last}>{last.slice(0, 120)}</span>
      <span className="spacer" />
      <MemoryMeter />
      <span>{engine.ctx.sampleRate / 1000} khz</span>
      <button
        className="link sb-buf"
        data-tip={`audio buffer: ${bufferPref() === "safe" ? "safe (no crackle on heavy projects)" : "low latency (for recording / live playing; may crackle on heavy projects)"} · ${Math.round(((engine.ctx.baseLatency || 0) + ((engine.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)) * 1000)} ms · click to switch`}
        onClick={() => {
          const next = bufferPref() === "safe" ? "low" : "safe";
          void confirmDialog({ title: `switch to ${next === "safe" ? "safe" : "low-latency"} audio buffer?`, body: next === "safe" ? "a larger buffer: steady playback without crackle on heavy projects. keyboard and recording latency go up slightly. the page reloads; your project is autosaved." : "the smallest buffer: best for recording and playing live, but heavy projects can crackle. the page reloads; your project is autosaved.", ok: "switch & reload" }).then((ok) => {
            if (!ok) return;
            setBufferPref(next);
            dispatchEvent(new Event("pagehide")); // flush autosave
            setTimeout(() => location.reload(), 400);
          });
        }}
      >
        buf {bufferPref() === "safe" ? "safe" : "low"}
      </button>
      <span>dsp {dspPool.size} workers</span>
      <span>→ midi {muscriptorGpu || "idle"}</span>
    </footer>
  );
}

/** Used / budget, coloured like a level meter; hover for the breakdown. */
function MemoryMeter() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);
  const used = memory.used(), budget = memory.budget(), k = memory.byKind(), heap = memory.heap();
  const r = used / budget;
  const color = r > 0.85 ? "var(--danger)" : r > 0.65 ? "var(--solo)" : "var(--muted)";
  const tip = `audio ${fmt(k.audio)} · models ${fmt(k.model)} · undo ${fmt(k.history)} · in progress ${fmt(k.transient)}${heap ? ` · js heap ${fmt(heap.used)} / ${fmt(heap.limit)}` : ""} · budget ${fmt(budget)} (idle models and old undo steps are freed automatically)`;
  return (
    <span className="mem" data-tip={tip} style={{ color }}>
      <span className="mem-bar"><span style={{ width: `${Math.min(100, r * 100)}%`, background: color }} /></span>
      mem {fmt(used)} / {fmt(budget)}
    </span>
  );
}
