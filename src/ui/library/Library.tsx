import { useState, memo } from "react";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store, useStoreQuiet } from "../../model/store";

const CATEGORIES = [...new Set(INSTRUMENTS.map((i) => i.category))];

/** Library (Y): sound browser. Clicking a patch loads it on the selected instrument track. */
function Library() {
  const s = useStoreQuiet();
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const track = s.project.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const canLoad = track?.kind === "midi";
  const match = (name: string, cat: string) => !q || `${name} ${cat}`.toLowerCase().includes(q.toLowerCase());

  return (
    <aside className="library">
      <div className="panel-head">
        <span>library</span>
        <button className="icon" data-tip="close (Y)" onClick={() => store.setUi({ showLibrary: false })}>×</button>
      </div>
      <div className="lib-target">{canLoad ? <>loading onto <b>{track!.name}</b></> : "select an instrument track"}</div>
      <input className="lib-search" placeholder="search sounds" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="lib-list">
        {CATEGORIES.map((cat) => {
          const items = INSTRUMENTS.filter((i) => i.category === cat && match(i.name, cat));
          if (!items.length) return null;
          const open = q !== "" || !closed.has(cat);
          return (
            <div key={cat} className="lib-cat">
              <button className="lib-cat-head" onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}>
                {open ? "▾" : "▸"} {cat.toLowerCase()}
              </button>
              {open &&
                items.map((i) => (
                  <button
                    key={i.id}
                    className={`lib-item ${track?.instrument === i.id ? "on" : ""}`}
                    disabled={!canLoad}
                    onClick={() => store.update((p) => (p.tracks.find((t) => t.id === track!.id)!.instrument = i.id))}
                  >
                    <span>{i.name}</span>
                    <small>{i.size === "0" ? "built-in" : i.size}</small>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      <div className="lib-foot">samples stream from free CDNs on first use, then stay cached in your browser.</div>
    </aside>
  );
}

// Memoised: re-renders from its own (quiet) store subscription, not on every App render.
export default memo(Library);
