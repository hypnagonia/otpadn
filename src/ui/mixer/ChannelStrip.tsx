import { engine } from "../../engine/transport";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store } from "../../model/store";
import type { ChannelSettings, Track } from "../../model/types";
import { fmtDb, fmtPan } from "../common/format";
import { EqThumb } from "../eq/ChannelEq";
import MiniKnob from "../common/MiniKnob";
import Meter from "./Meter";
import { useLayoutEffect, useRef, useState } from "react";
import SendSlots from "./SendSlots";
import InsertSlots from "../plugins/InsertSlots";

function Param({ label, value, min, max, step, reset = 0, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; reset?: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="param" data-tip={`${label} ${fmt(value)} · double-click resets`}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} onDoubleClick={() => onChange(reset)} />
    </label>
  );
}

/** dB marks beside a fader (positions match the slider's linear dB travel). */
function FaderScale({ min, max }: { min: number; max: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // keep marks ≥ 11 px apart on short faders (priority order: 0, ends, then the rest)
  const shown: number[] = [];
  for (const d of [0, max, min, -10, 6, -20, -5, -30, 12, -40])
    if (d >= min && d <= max && !shown.includes(d) && shown.every((x) => (Math.abs(x - d) / (max - min)) * h >= 11)) shown.push(d);
  const marks = shown;
  return (
    <div className="fader-scale" ref={ref}>
      {marks.map((d) => <span key={d} style={{ top: `${((max - d) / (max - min)) * 100}%` }}>{d > 0 ? `+${d}` : d}</span>)}
    </div>
  );
}

/** One channel: insert/EQ section, sends, pan, fader + meter, M/S/C. Used in Mixer and Inspector. */
export default function ChannelStrip({ t, selected, wide }: { t: Track; selected?: boolean; wide?: boolean }) {
  const set = (patch: Partial<ChannelSettings>) => store.update((p) => Object.assign(p.tracks.find((x) => x.id === t.id)!.ch, patch));
  const ch = t.ch;
  const inst = t.kind === "midi" ? INSTRUMENTS.find((i) => i.id === t.instrument)?.name : t.kind === "aux" ? `${t.auxOut} mic → bus` : t.kind === "bus" ? "bus (return)" : "audio";
  return (
    <div className={`strip ${selected ? "sel" : ""} ${wide ? "wide" : ""}`} onMouseDown={() => store.ui.selectedTrackId !== t.id && store.setUi({ selectedTrackId: t.id })}>
      <div className="slot" data-tip={inst}>{inst}</div>
      <EqThumb t={t} />
      <InsertSlots owner={t.id} inserts={t.inserts ?? []} />
      <SendSlots t={t} />
      <Param label="verb" value={ch.reverbSend} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ reverbSend: v })} />
      <div className="btns">
        <MiniKnob value={ch.pan} min={-1} max={1} def={0} step={0.01} size={22} bipolar onChange={(v) => set({ pan: v })} tip={`pan ${fmtPan(ch.pan)} · drag / wheel · double-click centres`} />
        <button className={`ms s ${ch.solo ? "on" : ""}`} onClick={() => set({ solo: !ch.solo })}>s</button>
        <button className={`ms m ${ch.mute ? "on" : ""}`} onClick={() => set({ mute: !ch.mute })}>m</button>
      </div>
      <div className="fader-row">
        <FaderScale min={-40} max={12} />
        <input className="fader" type="range" min={-40} max={12} step={0.1} value={ch.volumeDb} onChange={(e) => set({ volumeDb: +e.target.value })} onDoubleClick={() => set({ volumeDb: 0 })} />
        <Meter getAnalyser={() => engine.strips.get(t.id)?.meter} />
      </div>
      <div className="readout">
        <span data-tip="volume">{fmtDb(ch.volumeDb)}</span>
        <span data-tip="pan">{fmtPan(ch.pan)}</span>
      </div>
      <div className="name" style={{ borderTopColor: t.color }} data-tip={t.name}>{t.name}</div>
    </div>
  );
}

export function MasterStrip({ wide }: { wide?: boolean }) {
  const p = store.project;
  return (
    <div className={`strip master ${wide ? "wide" : ""}`}>
      <div className="slot">stereo out</div>
      <InsertSlots owner="master" inserts={p.masterInserts ?? []} />
      <div className="chain">→ glue · limiter · clip</div>
      <div className="fader-row">
        <FaderScale min={-24} max={18} />
        <input className="fader" type="range" min={-24} max={18} step={0.1} value={p.masterDb} onChange={(e) => store.update((x) => (x.masterDb = +e.target.value))} onDoubleClick={() => store.update((x) => (x.masterDb = 0))} />
        <Meter getAnalyser={() => engine.master.analyser} />
      </div>
      <div className="readout">
        <span data-tip="master volume">{fmtDb(p.masterDb)}</span>
      </div>
      <div className="name" style={{ borderTopColor: "var(--text)" }}>master</div>
    </div>
  );
}
