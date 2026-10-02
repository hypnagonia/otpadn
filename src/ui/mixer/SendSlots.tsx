import { useEffect, useRef, useState } from "react";
import { addSend, createBus, removeSend, updateSend } from "../../edit/routing";
import { useStoreQuiet } from "../../model/store";
import type { Track } from "../../model/types";
import MiniKnob from "../common/MiniKnob";

/**
 * "Sends" slots, Logic style: bus name + level knob per send, a pre/post toggle, an empty slot
 * that opens the bus menu (existing buses or a new reverb/delay bus). Right-click removes.
 */
export default function SendSlots({ t }: { t: Track }) {
  const s = useStoreQuiet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (t.kind === "bus") return null;
  const buses = s.project.tracks.filter((b) => b.kind === "bus");
  const sends = t.ch.sends ?? [];
  return (
    <div className="slot-sec" ref={ref}>
      <div className="slot-head">sends</div>
      {sends.map((sd) => {
        const bus = buses.find((b) => b.id === sd.bus);
        return (
          <div key={sd.id} className={`snd ${bus ? "" : "missing"}`} onContextMenu={(e) => { e.preventDefault(); removeSend(t.id, sd.id); }}>
            <span className="snd-name" data-tip={`${bus?.name ?? "missing bus"} · right-click to remove`}>{bus?.name ?? "?"}</span>
            <button className={`snd-pre ${sd.pre ? "on" : ""}`} data-tip={sd.pre ? "pre-fader (click for post)" : "post-fader (click for pre)"} onClick={() => updateSend(t.id, sd.id, { pre: !sd.pre })}>{sd.pre ? "pre" : ""}</button>
            <MiniKnob value={sd.level} min={-60} max={6} def={-12} onChange={(v) => updateSend(t.id, sd.id, { level: v })} tip={`${sd.level > 0 ? "+" : ""}${sd.level.toFixed(1)} dB · drag / wheel · double-click −12`} color={sd.pre ? "var(--solo)" : "var(--accent)"} />
          </div>
        );
      })}
      <button className="fx empty" onClick={() => setOpen(!open)} data-tip="add a send" />
      {open && (
        <div className="popover menu ins-menu">
          <div className="menu-title">send to bus</div>
          {buses.filter((b) => !sends.some((sd) => sd.bus === b.id)).map((b) => (
            <button key={b.id} onClick={() => { setOpen(false); addSend(t.id, b.id); }}><span>{b.name}</span></button>
          ))}
          <button onClick={() => { setOpen(false); addSend(t.id, createBus("reverb").id); }}><span>+ new reverb bus</span><small>plate, 100% wet</small></button>
          <button onClick={() => { setOpen(false); addSend(t.id, createBus("delay").id); }}><span>+ new delay bus</span><small>tempo-synced, 100% wet</small></button>
        </div>
      )}
    </div>
  );
}
