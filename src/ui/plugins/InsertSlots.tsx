import { useEffect, useRef, useState } from "react";
import { useStoreQuiet } from "../../model/store";
import { PLUGINS, type Insert, type PluginType } from "../../plugins/defs";
import { addInsert, openInsert, removeInsert, toggleInsert, type InsertOwner } from "../../plugins/ops";

/**
 * "Audio FX" slots, Logic / Nuendo style: one slot per insert (power button + name; blue when
 * active, grey when bypassed, outlined when open in the editor) and an empty slot that opens the
 * plugin menu. Right-click a slot to remove it.
 */
export default function InsertSlots({ owner, inserts }: { owner: InsertOwner; inserts: Insert[] }) {
  const s = useStoreQuiet();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; maxH: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // The menu is position: fixed, placed from the slot's screen position and kept inside the window,
  // so strips inside clipped panels (mixer edge, narrow inspector) can still use it.
  const toggleMenu = () => {
    if (open) return setOpen(false);
    const r = addRef.current!.getBoundingClientRect();
    const W = 340, below = innerHeight - r.bottom - 8, above = r.top - 8;
    const left = Math.max(8, Math.min(r.left, innerWidth - W - 8));
    setAt(below >= 220 || below >= above ? { left, top: r.bottom + 2, maxH: below } : { left, bottom: innerHeight - r.top + 2, maxH: above });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const sel = s.ui.selectedInsert;
  return (
    <div className="slot-sec" ref={ref}>
      <div className="slot-head">inserts</div>
      {inserts.map((ins) => (
        <div
          key={ins.id}
          className={`fx ${ins.on ? "on" : "off"} ${sel?.id === ins.id ? "sel" : ""}`}
          onContextMenu={(e) => {
            e.preventDefault();
            removeInsert(owner, ins.id);
          }}
        >
          <button className="fx-pwr" onClick={() => toggleInsert(owner, ins.id)} data-tip={ins.on ? "bypass" : "enable"}>⏻</button>
          <button className="fx-name" onClick={() => openInsert(owner, ins.id)} data-tip={`${PLUGINS[ins.type].name}${ins.sidechain ? " · sidechain" : ""} · click to edit, right-click to remove`}>
            {PLUGINS[ins.type].name}
            {ins.sidechain && <span className="fx-sc">sc</span>}
          </button>
        </div>
      ))}
      <button ref={addRef} className="fx empty" onClick={toggleMenu} data-tip="add an insert plugin" />
      {open && at && (
        <div className="popover menu ins-menu" style={{ position: "fixed", left: at.left, top: at.top, bottom: at.bottom, maxHeight: at.maxH, overflowY: "auto" }}>
          <div className="menu-title">insert plugin</div>
          {(Object.keys(PLUGINS) as PluginType[]).map((t) => (
            <button key={t} onClick={() => { setOpen(false); addInsert(owner, t); }}>
              <span>{PLUGINS[t].name}</span>
              <small>{PLUGINS[t].desc}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
