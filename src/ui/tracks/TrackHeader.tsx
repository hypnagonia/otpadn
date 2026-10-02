import { useState } from "react";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store } from "../../model/store";
import TrackMeter from "./TrackMeter";
import type { Track } from "../../model/types";

/** Logic-style track header: number, colour, name (double-click to rename), M/S, source, mini fader. */
const s_count = (busId: string) => store.project.tracks.filter((x) => x.ch.sends?.some((sd) => sd.bus === busId)).length;

export default function TrackHeader({ t, index, selected, height }: { t: Track; index: number; selected: boolean; height: number }) {
  const [editing, setEditing] = useState(false);
  const set = (fn: (t: Track) => void) => store.update((p) => fn(p.tracks.find((x) => x.id === t.id)!));
  const source =
    t.kind === "midi" ? INSTRUMENTS.find((i) => i.id === t.instrument)?.name ?? "no instrument" : t.kind === "aux" ? `kit mic · ${t.auxOut} → bus` : t.kind === "bus" ? `bus · ${s_count(t.id)} sends in` : `audio · ${t.role}`;
  return (
    <div
      className={`trk ${selected ? "sel" : ""} ${t.kind === "aux" ? "aux" : ""}`}
      style={{ height }}
      onMouseDown={() => store.setUi({ selectedTrackId: t.id })}
      onDoubleClick={() => t.kind === "midi" && store.setUi({ showLibrary: true })}
    >
      <div className="num">{index + 1}</div>
      <div className="bar" style={{ background: t.color }} />
      <div className="body">
        <div className="row">
          {editing ? (
            <input
              className="name"
              autoFocus
              defaultValue={t.name}
              onBlur={(e) => {
                set((x) => (x.name = e.target.value || x.name));
                setEditing(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="name" onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} data-tip="double-click to rename">
              {t.name}
            </span>
          )}
          {t.kind === "audio" && (
            <button className={`ms r ${store.ui.armedTrackId === t.id ? "on" : ""}`} data-tip="arm for recording" onClick={() => store.setUi({ armedTrackId: store.ui.armedTrackId === t.id ? null : t.id })}>r</button>
          )}
          <button className={`ms m ${t.ch.mute ? "on" : ""}`} data-tip="mute" onClick={() => set((x) => (x.ch.mute = !x.ch.mute))}>m</button>
          <button className={`ms s ${t.ch.solo ? "on" : ""}`} data-tip="solo" onClick={() => set((x) => (x.ch.solo = !x.ch.solo))}>s</button>
        </div>
        {height >= 44 && (
          <div className="row">
            <span className="src" data-tip={t.kind === "midi" ? "double-click header to open the library" : undefined}>{source}</span>
            <input type="range" className="mini" min={-40} max={12} step={0.5} value={t.ch.volumeDb} data-tip={`${t.ch.volumeDb} dB`} onChange={(e) => set((x) => (x.ch.volumeDb = +e.target.value))} onDoubleClick={() => set((x) => (x.ch.volumeDb = 0))} />
          </div>
        )}
      </div>
      <TrackMeter trackId={t.id} />
    </div>
  );
}
