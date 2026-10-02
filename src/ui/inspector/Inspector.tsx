import { memo } from "react";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store, useStoreQuiet } from "../../model/store";
import { ROLE_COLORS, type Role, type Track } from "../../model/types";
import { trimClip } from "../../edit/ops";
import { formatPos } from "../common/format";
import NumberField from "../common/NumberField";
import Select from "../common/Select";
import ChannelStrip, { MasterStrip } from "../mixer/ChannelStrip";

const ROLES: Role[] = ["drums", "bass", "vocals", "guitar", "piano", "lead", "keys", "pad", "other", "mix"];

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/** Inspector (I): selected region, selected track, then its channel strip next to the master. */
function Inspector() {
  const s = useStoreQuiet();
  const p = s.project;
  const track = p.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const clip = track?.clips.find((c) => c.id === s.ui.selectedClipId);
  const spb = 60 / p.bpm;
  const setTrack = (fn: (t: Track) => void) => track && store.update((pp) => fn(pp.tracks.find((x) => x.id === track.id)!));

  return (
    <aside className="inspector">
      <details open className="insp-section">
        <summary>region</summary>
        {clip ? (
          <>
            <Row k="type">{clip.kind}</Row>
            <Row k="position">
              <NumberField value={+(clip.start / 4 + 1).toFixed(3)} min={1} max={9999} step={1} width={70} data-tip={`bar (${formatPos(clip.start)})`} onCommit={(v) => store.update(() => (clip.start = (v - 1) * 4))} /> <span className="muted">bar</span>
            </Row>
            <Row k="length">
              <NumberField value={+((clip.kind === "midi" ? clip.length : clip.duration / spb) / 4).toFixed(3)} min={0.0625} max={9999} step={1} width={70} data-tip="length in bars" onCommit={(v) => trimClip(clip.id, "end", clip.start + v * 4)} /> <span className="muted">bars</span>
            </Row>
            {clip.kind === "midi" ? <Row k="notes">{clip.notes.length}</Row> : <Row k="offset">{clip.offset.toFixed(2)} s</Row>}
            <div className="insp-actions">
              {clip.kind === "midi" && <button onClick={() => store.setUi({ showEditor: true, editorTab: "piano" })}>edit notes</button>}
              <button onClick={() => { store.update((pp) => pp.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.id !== clip.id)))); store.setUi({ selectedClipId: null }); }}>delete</button>
            </div>
          </>
        ) : (
          <div className="muted">no region selected</div>
        )}
      </details>
      <details open className="insp-section">
        <summary>track</summary>
        {track ? (
          <>
            <Row k="name">{track.name}</Row>
            <Row k="type">{track.kind}</Row>
            <Row k="role">
              <Select value={track.role} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={(r) => setTrack((t) => { t.role = r; t.color = ROLE_COLORS[r]; })} />
            </Row>
            {track.kind === "midi" && (
              <Row k="instrument">
                <button className="link" onClick={() => store.setUi({ showLibrary: true })}>{INSTRUMENTS.find((i) => i.id === track.instrument)?.name ?? "choose…"}</button>
              </Row>
            )}
          </>
        ) : (
          <div className="muted">no track selected</div>
        )}
      </details>
      <div className="insp-strips">
        {track ? <ChannelStrip t={track} wide /> : <div className="strip wide placeholder" />}
        <MasterStrip wide />
      </div>
    </aside>
  );
}

// Memoised: re-renders from its own (quiet) store subscription, not on every App render.
export default memo(Inspector);
