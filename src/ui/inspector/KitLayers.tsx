import { useRef } from "react";
import { clearKitLayer, loadKitLayer, setKitLayerLevel } from "../../edit/kitLayers";
import type { KitLayerSlot, Track } from "../../model/types";
import NumberField from "../common/NumberField";
import { runTask } from "../common/runTask";

const SLOTS: KitLayerSlot[] = ["kick", "snare"];

/**
 * Sample layers for a multitrack kit (sample reinforcement, like a trigger plug-in): a one-shot
 * plays with every kick / snare hit, into that drum's mic channel, so it gets the same EQ,
 * compression and bus.
 */
export default function KitLayers({ t }: { t: Track }) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<KitLayerSlot>("kick");
  const pick = (slot: KitLayerSlot) => {
    pending.current = slot;
    input.current!.value = "";
    input.current!.click();
  };
  return (
    <div className="kit-layers">
      <input ref={input} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) runTask(() => loadKitLayer(t.id, pending.current, f)); }} />
      {SLOTS.map((slot) => {
        const l = t.kitLayers?.[slot];
        return (
          <div key={slot} className="kv kl-row">
            <span className="k">{slot}</span>
            <span className="v kl-v">
              <button className="link kl-name" onClick={() => pick(slot)} data-tip={l ? `${l.name} · click to replace` : "load a one-shot to layer with every hit"}>{l ? l.name.replace(/\.[^.]+$/, "") : "load…"}</button>
              {l && (
                <>
                  <NumberField value={l.level} min={-40} max={12} step={0.5} width={46} onCommit={(v) => setKitLayerLevel(t.id, slot, v)} />
                  <span className="muted">dB</span>
                  <button className="kl-x" onClick={() => clearKitLayer(t.id, slot)} data-tip="remove the layer">×</button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
