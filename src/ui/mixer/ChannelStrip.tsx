import { engine } from "../../engine/transport";
import { controlChanged } from "../../edit/automation";
import { changeChannel, groupOf, selectTrack } from "../../edit/groups";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store } from "../../model/store";
import type { ChannelSettings, Track } from "../../model/types";
import { fmtDb, fmtPan } from "../common/format";
import { EqThumb } from "../eq/ChannelEq";
import Meter from "./Meter";
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

/** One channel: insert/EQ section, sends, pan, fader + meter, M/S/C. Used in Mixer and Inspector. */
export default function ChannelStrip({ t, selected, wide }: { t: Track; selected?: boolean; wide?: boolean }) {
  const set = (patch: Partial<ChannelSettings>) => {
    // volume / pan / mute / solo go through the channel group (members follow; ⌥ = this one only)
    const { volumeDb, pan, mute, solo, ...rest } = patch;
    if (volumeDb !== undefined || pan !== undefined || mute !== undefined || solo !== undefined) changeChannel(t.id, { volumeDb, pan, mute, solo });
    if (Object.keys(rest).length) store.update((p) => Object.assign(p.tracks.find((x) => x.id === t.id)!.ch, rest));
    if (patch.reverbSend !== undefined) controlChanged(t.id, "verb", patch.reverbSend);
  };
  const grp = groupOf(store.project, t);
  const ch = t.ch;
  const inst = t.kind === "midi" ? INSTRUMENTS.find((i) => i.id === t.instrument)?.name : t.kind === "aux" ? `${t.auxOut} mic → bus` : t.kind === "bus" ? "bus (return)" : "audio";
  return (
    <div className={`strip ${selected ? "sel" : ""} ${wide ? "wide" : ""}`} onMouseDown={(e) => (e.shiftKey || e.metaKey || e.ctrlKey || store.ui.selectedTrackId !== t.id) && selectTrack(t.id, e)}>
      <div className="slot" data-tip={inst}>{inst}</div>
      <EqThumb t={t} />
      <InsertSlots owner={t.id} inserts={t.inserts ?? []} />
      <SendSlots t={t} />
      <Param label="verb" value={ch.reverbSend} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ reverbSend: v })} />
      <Param label="pan" value={ch.pan} min={-1} max={1} step={0.01} fmt={fmtPan} onChange={(v) => set({ pan: v })} />
      <div className="readout">
        <span>{fmtDb(ch.volumeDb)}</span>
        <span>{fmtPan(ch.pan)}</span>
      </div>
      <div className="fader-row">
        <input className="fader" type="range" min={-40} max={12} step={0.1} value={ch.volumeDb} onChange={(e) => set({ volumeDb: +e.target.value })} onDoubleClick={() => set({ volumeDb: 0 })} />
        <Meter getAnalyser={() => engine.strips.get(t.id)?.meter} />
      </div>
      <div className="btns">
        <button className={`ms m ${ch.mute ? "on" : ""}`} onClick={() => set({ mute: !ch.mute })}>m</button>
        <button className={`ms s ${ch.solo ? "on" : ""}`} onClick={() => set({ solo: !ch.solo })}>s</button>
      </div>
      {grp && <div className="strip-grp" style={{ background: grp.color }} data-tip={`group ${grp.name} · ⌥ moves this channel alone`}>{grp.name}</div>}
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
      <div className="readout">
        <span>{fmtDb(p.masterDb)}</span>
      </div>
      <div className="fader-row">
        <input className="fader" type="range" min={-24} max={18} step={0.1} value={p.masterDb} onChange={(e) => store.update((x) => (x.masterDb = +e.target.value))} onDoubleClick={() => store.update((x) => (x.masterDb = 0))} />
        <Meter getAnalyser={() => engine.master.analyser} />
      </div>
      <div className="name" style={{ borderTopColor: "var(--text)" }}>master</div>
    </div>
  );
}
