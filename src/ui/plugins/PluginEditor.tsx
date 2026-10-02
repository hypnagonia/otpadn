import { MATCH_BANDS, MATCH_FC, matchGainAt } from "../../plugins/matchEq";
import { memo, useEffect, useRef } from "react";
import { engine } from "../../engine/transport";
import { useStoreQuiet } from "../../model/store";
import type { Track } from "../../model/types";
import { DELAY_DIV_BEATS, PLUGINS, type Insert } from "../../plugins/defs";
import { findInsert, removeInsert, setParam, toggleInsert, type InsertOwner } from "../../plugins/ops";
import Knob from "../common/Knob";
import Select from "../common/Select";
import { setSidechain } from "../../edit/routing";
import { T } from "../common/theme";

/** Live gain-reduction values of an insert (dB per band). */
const grOf = (owner: InsertOwner, id: string) => (owner === "master" ? engine.master.inserts : engine.strips.get(owner)?.inserts)?.instances.get(id)?.gr ?? [];

function useCanvas(draw: (g: CanvasRenderingContext2D, W: number, H: number) => void, animate: boolean) {
  const ref = useRef<HTMLCanvasElement>(null);
  const d = useRef(draw);
  d.current = draw;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cv = ref.current;
      if (cv) {
        const dpr = devicePixelRatio || 1;
        const W = cv.parentElement!.clientWidth, H = cv.parentElement!.clientHeight;
        if (cv.width !== W * dpr || cv.height !== H * dpr) {
          cv.width = W * dpr;
          cv.height = H * dpr;
          cv.style.width = W + "px";
          cv.style.height = H + "px";
        }
        const g = cv.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        d.current(g, W, H);
      }
      if (animate) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  });
  return ref;
}

const bg = (g: CanvasRenderingContext2D, W: number, H: number) => {
  g.fillStyle = "#1c1d21";
  g.fillRect(0, 0, W, H);
};

/** Compressor: static transfer curve with the live operating point + GR meter. */
function CompView({ ins, owner }: { ins: Insert; owner: InsertOwner }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const p = ins.params, S = Math.min(W - 40, H) - 16, ox = 12, oy = 8;
    const X = (db: number) => ox + ((db + 60) / 60) * S, Y = (db: number) => oy + S - ((db + 60) / 60) * S;
    g.strokeStyle = "#2e3035";
    for (let d = -60; d <= 0; d += 12) {
      g.beginPath(); g.moveTo(X(d), Y(-60)); g.lineTo(X(d), Y(0)); g.stroke();
      g.beginPath(); g.moveTo(X(-60), Y(d)); g.lineTo(X(0), Y(d)); g.stroke();
    }
    g.strokeStyle = "#4a4d54";
    g.beginPath(); g.moveTo(X(-60), Y(-60)); g.lineTo(X(0), Y(0)); g.stroke();
    g.strokeStyle = T.accent;
    g.lineWidth = 2;
    g.beginPath();
    for (let x = -60; x <= 0; x += 0.5) {
      const d = x - p.threshold, W2 = p.knee;
      const y = 2 * d < -W2 ? x : W2 > 0 && 2 * Math.abs(d) <= W2 ? x + ((1 / p.ratio - 1) * (d + W2 / 2) ** 2) / (2 * W2) : p.threshold + d / p.ratio;
      const yy = Math.min(0, y + p.makeup);
      if (x === -60) g.moveTo(X(x), Y(yy)); else g.lineTo(X(x), Y(yy));
    }
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = T.faint;
    g.font = `10px ${T.font}`;
    g.fillText("in →", X(-12), Y(-60) - 4);
    g.fillText("out", X(-60) + 3, Y(0) + 10);
    // GR meter
    const gr = Math.max(-24, grOf(owner, ins.id)[0] ?? 0);
    const mx = W - 22, mh = S;
    g.fillStyle = "#111214";
    g.fillRect(mx, oy, 12, mh);
    g.fillStyle = "#e8a33a";
    g.fillRect(mx, oy, 12, (-gr / 24) * mh);
    g.fillStyle = T.muted;
    g.fillText(`${gr.toFixed(1)}`, mx - 8, oy + mh + 12);
  }, true);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Multiband: three band regions with crossovers + per-band GR meters. */
function MbView({ ins, owner }: { ins: Insert; owner: InsertOwner }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const fx = (f: number) => (Math.log(f / 20) / Math.log(1000)) * W;
    const p = ins.params, gr = grOf(owner, ins.id);
    const cols = ["#d9534f", "#e2c440", "#4aa3df"];
    const xs = [0, fx(p.xLow), fx(p.xHigh), W];
    for (let b = 0; b < 3; b++) {
      g.fillStyle = cols[b] + "22";
      g.fillRect(xs[b], 0, xs[b + 1] - xs[b], H);
      const r = Math.max(-24, gr[b] ?? 0);
      g.fillStyle = cols[b] + "aa";
      g.fillRect(xs[b] + 6, 6, xs[b + 1] - xs[b] - 12, (-r / 24) * (H - 30));
      g.fillStyle = T.body;
      g.font = `11px ${T.font}`;
      g.fillText(`${["low", "mid", "high"][b]} ${r.toFixed(1)} dB`, xs[b] + 8, H - 8);
    }
    g.strokeStyle = "#f2f2f2";
    for (const x of [xs[1], xs[2]]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  }, true);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Delay: echo train for both channels. */
function DelayView({ ins, bpm }: { ins: Insert; bpm: number }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const p = ins.params, t = (DELAY_DIV_BEATS[p.div] ?? 1) * (60 / bpm), tr = t * (1 + p.offset / 100);
    const span = 4; // seconds shown
    const X = (s: number) => 10 + (s / span) * (W - 20);
    g.fillStyle = "#f2f2f2";
    g.fillRect(X(0), 10, 3, H - 20);
    const fb = p.feedback / 100;
    for (let k = 1, a = p.mix / 100; k < 40 && a > 0.01; k++, a *= fb) {
      const pp = p.pingpong >= 1;
      const isR = pp ? k % 2 === 0 : false;
      const time = pp ? k * t : k * t;
      const hh = (H / 2 - 14) * Math.min(1, a * 1.6);
      g.fillStyle = T.accent;
      if (!pp || !isR) g.fillRect(X(time), H / 2 - hh, 3, hh);
      g.fillStyle = "#57b26a";
      if (!pp) g.fillRect(X(k * tr), H / 2, 3, hh);
      else if (isR) g.fillRect(X(time), H / 2, 3, hh);
    }
    g.fillStyle = T.faint;
    g.font = `10px ${T.font}`;
    g.fillText("L", 2, 16);
    g.fillText("R", 2, H - 6);
    g.fillText(`${(t * 1000).toFixed(0)} ms`, W - 60, 14);
  }, false);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Reverb: decay envelope (RT60-ish) with predelay and damping tint. */
function ReverbView({ ins }: { ins: Insert }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const p = ins.params;
    const decay = Math.min(0.99, p.decay / 100), size = p.size / 100;
    const loopSec = 0.15 * size; // approx tank loop time
    const rt60 = decay > 0 ? (-3 * loopSec) / Math.log10(decay) : 0.05;
    const span = Math.max(1, Math.min(12, rt60 * 1.3));
    const X = (s: number) => 10 + (s / span) * (W - 20);
    const pre = p.predelay / 1000;
    g.beginPath();
    g.moveTo(X(0), H - 10);
    g.lineTo(X(pre), H - 10);
    for (let s = pre; s <= span; s += span / 200) {
      const env = Math.pow(10, (-3 * (s - pre)) / Math.max(0.05, rt60));
      g.lineTo(X(s), H - 10 - env * (H - 30));
    }
    g.lineTo(X(span), H - 10);
    g.closePath();
    const damp = p.damping / 100;
    g.fillStyle = `rgba(${Math.round(74 + 120 * damp)}, ${Math.round(163 - 40 * damp)}, ${Math.round(223 - 120 * damp)}, 0.45)`;
    g.fill();
    g.fillStyle = T.body;
    g.font = `11px ${T.font}`;
    g.fillText(`≈ ${rt60.toFixed(1)} s decay`, W - 130, 16);
  }, false);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Saturator: transfer curve at the current drive. */
function SatView({ ins }: { ins: Insert }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const S = Math.min(W, H) - 20, ox = (W - S) / 2, oy = 10;
    const drive = Math.pow(10, ins.params.drive / 20);
    g.strokeStyle = "#4a4d54";
    g.beginPath(); g.moveTo(ox, oy + S); g.lineTo(ox + S, oy); g.stroke();
    g.strokeStyle = T.accent;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = i / 100 - 1;
      const y = (Math.tanh(x * drive) / Math.tanh(3)) / Math.sqrt(drive) * 1.1;
      const px = ox + ((x + 1) / 2) * S, py = oy + S - ((Math.max(-1, Math.min(1, y)) + 1) / 2) * S;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    g.lineWidth = 1;
  }, false);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Airwindows plug-ins: like the originals, no graph — the controls are the interface. */
function AwView({ ins }: { ins: Insert }) {
  const def = PLUGINS[ins.type];
  return (
    <div className="pl-graph aw-panel">
      <div className="aw-name">{def.name.replace(" (airwindows)", "")}</div>
      <div className="aw-by">airwindows · MIT · Chris Johnson</div>
    </div>
  );
}

/** Transient designer: a drum hit's envelope, original (grey) and shaped by attack/sustain (accent). */
function TransientView({ ins }: { ins: Insert }) {
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const ka = (ins.params.attack ?? 0) / 100, ks = (ins.params.sustain ?? 0) / 100;
    const env = (t: number) => (t < 0.004 ? t / 0.004 : Math.exp(-(t - 0.004) / 0.06)); // 0..1
    const shaped = (t: number) => {
      const lead = t < 0.025 ? Math.max(0, 1 - t / 0.025) * 12 : 0; // dB the attack detector sees
      const lag = t > 0.02 ? Math.min(24, (t - 0.02) * 60) : 0; // dB the sustain detector sees
      return env(t) * Math.pow(10, Math.max(-24, Math.min(18, ka * lead + ks * lag * 0.8)) / 20);
    };
    const SPAN = 0.4, y = (v: number) => H - 8 - Math.min(1.4, v) / 1.4 * (H - 16);
    for (const [fn, col, lw] of [[env, "#5a5d64", 1], [shaped, T.accent, 2]] as const) {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      for (let x = 0; x <= W; x++) {
        const v = fn((x / W) * SPAN);
        if (x === 0) g.moveTo(x, y(v)); else g.lineTo(x, y(v));
      }
      g.stroke();
    }
    g.lineWidth = 1;
  }, false);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/** Match EQ: the fitted curve (× amount) over a log-frequency grid; drag a band to redraw it. */
function MatchView({ ins, owner }: { ins: Insert; owner: InsertOwner }) {
  const gains = MATCH_FC.map((_, k) => ins.params[`b${k}`] ?? 0);
  const amt = (ins.params.amount ?? 100) / 100;
  const R = 18; // ±dB shown
  const xOf = (f: number, W: number) => (Math.log10(f / 20) / 3) * W;
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    g.strokeStyle = "#34373d";
    g.fillStyle = T.faint;
    g.font = `9px ${T.font}`;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = xOf(f, W);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, H - 3);
    }
    for (const d of [-12, -6, 0, 6, 12]) {
      const y = H / 2 - (d / R) * (H / 2);
      g.strokeStyle = d === 0 ? "#4a4d54" : "#2c2e33";
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.strokeStyle = T.accent;
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const f = 20 * Math.pow(10, (x / W) * 3);
      const y = H / 2 - ((matchGainAt(gains, f) * amt) / R) * (H / 2);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = T.accent;
    MATCH_FC.forEach((f, k) => { const y = H / 2 - ((gains[k] * amt) / R) * (H / 2); g.fillRect(xOf(f, W) - 1.5, y - 1.5, 3, 3); });
  }, false);
  const drag = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget, r = el.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const f = 20 * Math.pow(10, ((ev.clientX - r.left) / r.width) * 3);
      const k = Math.max(0, Math.min(MATCH_BANDS - 1, Math.round(Math.log2(f / 1000) * 3 + 17)));
      const db = Math.max(-24, Math.min(24, ((r.height / 2 - (ev.clientY - r.top)) / (r.height / 2)) * R / Math.max(0.01, amt)));
      setParam(owner, ins.id, `b${k}`, Math.round(db * 10) / 10);
    };
    move(e.nativeEvent);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className="pl-graph" onMouseDown={drag} data-tip="fitted curve · drag to redraw bands"><canvas ref={ref} /></div>;
}

/** Limiter: scrolling gain-reduction trace (last ~6 s) with the ceiling. */
function LimiterView({ ins, owner }: { ins: Insert; owner: InsertOwner }) {
  const hist = useRef<number[]>([]);
  const ref = useCanvas((g, W, H) => {
    bg(g, W, H);
    const gr = Math.max(-24, grOf(owner, ins.id)[0] ?? 0);
    hist.current.push(gr);
    if (hist.current.length > 360) hist.current.shift();
    const Y = (db: number) => 10 + (-db / 24) * (H - 26);
    g.strokeStyle = "#2e3035";
    for (const db of [-3, -6, -12, -18]) {
      g.beginPath(); g.moveTo(0, Y(db)); g.lineTo(W, Y(db)); g.stroke();
      g.fillStyle = T.faint;
      g.font = `10px ${T.font}`;
      g.fillText(`${db}`, 4, Y(db) - 2);
    }
    g.beginPath();
    g.moveTo(W, Y(0));
    hist.current.forEach((v, i) => g.lineTo(W - (hist.current.length - 1 - i) * (W / 360), Y(v)));
    g.lineTo(W - (hist.current.length - 1) * (W / 360), Y(0));
    g.closePath();
    g.fillStyle = "rgba(232,163,58,0.35)";
    g.fill();
    g.fillStyle = T.body;
    g.font = `11px ${T.font}`;
    g.fillText(`gr ${gr.toFixed(1)} dB · ceiling ${(ins.params.ceiling ?? -1).toFixed(1)} dBFS`, W - 230, H - 6);
  }, true);
  return <div className="pl-graph"><canvas ref={ref} /></div>;
}

/**
 * Tracks that may key a compressor on `owner` without creating a feedback loop (Web Audio mutes
 * cycles): not itself, not the bus it feeds (its kit owner), not its own kit mics, and not a
 * track that is itself keyed by `owner`.
 */
function sidechainCandidates(tracks: Track[], owner: string): Track[] {
  const me = tracks.find((t) => t.id === owner);
  return tracks.filter(
    (t) =>
      t.id !== owner &&
      t.id !== me?.auxOf &&
      t.auxOf !== owner &&
      !(t.inserts ?? []).some((i) => i.sidechain === owner) &&
      !(me?.ch.sends ?? []).some((sd) => sd.bus === t.id),
  );
}

/** Plugin editor pane: visual + knobs for the selected insert. */
function PluginEditor() {
  const s = useStoreQuiet();
  const sel = s.ui.selectedInsert;
  const ins = sel ? findInsert(sel.owner, sel.id) : undefined;
  if (!sel || !ins) return <div className="hint">click an insert slot on a channel strip (or add one with “+”) to edit it</div>;
  const def = PLUGINS[ins.type];
  const ownerName = sel.owner === "master" ? "master" : s.project.tracks.find((t) => t.id === sel.owner)?.name ?? "";
  const view = ins.type === "compressor" ? <CompView ins={ins} owner={sel.owner} /> : ins.type === "multiband" ? <MbView ins={ins} owner={sel.owner} /> : ins.type === "delay" ? <DelayView ins={ins} bpm={s.project.bpm} /> : ins.type === "saturator" ? <SatView ins={ins} /> : ins.type === "amp" ? <SatView ins={{ ...ins, params: { ...ins.params, drive: (ins.params.gain ?? 6) * 4.5 } }} /> : ins.type === "limiter" ? <LimiterView ins={ins} owner={sel.owner} /> : ins.type === "match" ? <MatchView ins={ins} owner={sel.owner} /> : ins.type === "transient" ? <TransientView ins={ins} /> : ins.type === "reverb" ? <ReverbView ins={ins} /> : <AwView ins={ins} />;
  return (
    <div className={`plugin-editor ${ins.on ? "" : "bypassed"}`}>
      <div className="pl-head">
        <button className={`pwr ${ins.on ? "on" : ""}`} onClick={() => toggleInsert(sel.owner, ins.id)} data-tip="bypass">⏻</button>
        <b>{def.name}</b>
        <span className="muted">on {ownerName} · {def.desc}</span>
        {ins.type === "compressor" && (
          <>
            <span className="label">sidechain</span>
            <Select
              value={ins.sidechain ?? ""}
              width={170}
              tip="detector listens to this track (post-fader), e.g. kick → bass ducking"
              options={[{ value: "", label: "off (own signal)" }, ...sidechainCandidates(s.project.tracks, sel.owner).map((t) => ({ value: t.id, label: t.name }))]}
              onChange={(v) => setSidechain(sel.owner, ins.id, v || null)}
            />
          </>
        )}
        <span className="spacer" />
        <button onClick={() => removeInsert(sel.owner, ins.id)}>remove</button>
      </div>
      <div className="pl-body">
        {view}
        <div className="pl-knobs">
          {def.params.filter((ps) => !ps.hidden).map((ps) => (
            <Knob key={ps.key} spec={ps} value={ins.params[ps.key] ?? ps.def} onChange={(v) => setParam(sel.owner, ins.id, ps.key, v)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** memo: a prop-less panel only re-renders through its own store subscription. */
export default memo(PluginEditor);
