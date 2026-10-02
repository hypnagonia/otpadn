import { clearLane } from "../../edit/automation";
import { changeChannel, groupOf, selectTrack } from "../../edit/groups";
import { canFreeze, freezeSig, freezeTrack, unfreezeTrack } from "../../edit/freeze";
import { runTask } from "../common/runTask";
import { useMemo } from "react";
import { automatableParams } from "../../engine/automation";
import Select from "../common/Select";
import { useState } from "react";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store } from "../../model/store";
import TrackMeter from "./TrackMeter";
import type { Track } from "../../model/types";

/** Logic-style track header: number, colour, name (double-click to rename), M/S, source, mini fader. */
const s_count = (busId: string) => store.project.tracks.filter((x) => x.ch.sends?.some((sd) => sd.bus === busId)).length;

export default function TrackHeader({ t, index, selected, height }: { t: Track; index: number; selected: boolean; height: number }) {
  const grp = groupOf(store.project, t);
  // Frozen but edited since? (signature compare; recomputed only when the project changes)
  const stale = useMemo(() => !!t.frozen && freezeSig(store.project, t) !== t.frozen.sig, [t, store.projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(false);
  const set = (fn: (t: Track) => void) => store.update((p) => fn(p.tracks.find((x) => x.id === t.id)!));
  const source =
    t.kind === "midi" ? INSTRUMENTS.find((i) => i.id === t.instrument)?.name ?? "no instrument" : t.kind === "aux" ? `kit mic · ${t.auxOut} → bus` : t.kind === "bus" ? `bus · ${s_count(t.id)} sends in` : `audio · ${t.role}`;
  return (
    <div
      className={`trk ${selected ? "sel" : ""} ${t.kind === "aux" ? "aux" : ""} ${t.frozen ? "frozen" : ""}`}
      style={{ height }}
      onMouseDown={(e) => selectTrack(t.id, e)}
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
          {canFreeze(t) && (
            <button
              className={`ms fz ${t.frozen ? (stale ? "stale" : "on") : ""}`}
              data-tip={t.frozen ? (stale ? "frozen, but edited since — click to refreeze" : "frozen: plays its render, instrument + plug-ins released · click to unfreeze") : "freeze: render instrument + plug-ins to audio to free the CPU"}
              onClick={() => (t.frozen && !stale ? unfreezeTrack(t.id) : runTask(() => freezeTrack(t.id)))}
            >
              ❄{stale ? "!" : ""}
            </button>
          )}
          {grp && (
            <span className="grp" style={{ background: grp.color }} data-tip={`group ${grp.name}: ${["volume", "mute", "solo", "pan"].filter((k) => grp.link[k as keyof typeof grp.link]).join(" · ")} linked · ⌥ moves one track · right-click for group options`}>{grp.name}</span>
          )}
          <button className={`ms m ${t.ch.mute ? "on" : ""}`} data-tip="mute" onClick={() => changeChannel(t.id, { mute: !t.ch.mute })}>m</button>
          <button className={`ms s ${t.ch.solo ? "on" : ""}`} data-tip="solo" onClick={() => changeChannel(t.id, { solo: !t.ch.solo })}>s</button>
        </div>
        {height >= 44 && store.ui.showAutomation && (
          <div className="row auto-row" onMouseDown={(e) => e.stopPropagation()}>
            <Select
              value={t.autoView ?? "volume"}
              width={150}
              tip="automation lane shown on this track"
              options={automatableParams(t, (id) => store.project.tracks.find((x) => x.id === id)?.name ?? "bus").map((a) => ({ value: a.param, label: `${t.automation?.some((l) => l.param === a.param && l.points.length) ? "• " : ""}${a.label}` }))}
              onChange={(v) => set((x) => (x.autoView = v))}
            />
            {t.automation?.some((l) => l.param === (t.autoView ?? "volume") && l.points.length) && (
              <button className="ms" data-tip="clear this lane" onClick={() => clearLane(t.id, t.autoView ?? "volume")}>×</button>
            )}
          </div>
        )}
        {height >= 44 && !store.ui.showAutomation && (
          <div className="row">
            <span className="src" data-tip={t.kind === "midi" ? "double-click header to open the library" : undefined}>{source}</span>
            <input type="range" className="mini" min={-40} max={12} step={0.5} value={t.ch.volumeDb} data-tip={`${t.ch.volumeDb} dB`} onChange={(e) => changeChannel(t.id, { volumeDb: +e.target.value })} onDoubleClick={() => set((x) => (x.ch.volumeDb = 0))} />
          </div>
        )}
      </div>
      <TrackMeter trackId={t.id} />
    </div>
  );
}
