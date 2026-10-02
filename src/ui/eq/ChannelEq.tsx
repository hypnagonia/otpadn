import { useEffect, useRef } from "react";
import { bandParams, eqResponse, type EqBandId } from "../../engine/eqResponse";
import { engine } from "../../engine/transport";
import { store, useStoreQuiet } from "../../model/store";
import type { ChannelSettings, Track } from "../../model/types";
import { T } from "../common/theme";

/** Visual 6-band EQ (Logic Channel EQ / Pro-Q style): drag nodes, wheel = Q, double-click = reset. */

const F_MIN = 20, F_MAX = 20000;
const BAND_COLORS: Record<EqBandId, string> = { hpf: "#e05a5a", low: "#e0a43a", mid: "#e2c440", mid2: "#57b26a", high: "#4aa3df", lpf: "#a66cd9" };
const BAND_LABEL: Record<EqBandId, string> = { hpf: "low cut", low: "low shelf", mid: "bell 1", mid2: "bell 2", high: "high shelf", lpf: "high cut" };

const fx = (f: number, w: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
const xf = (x: number, w: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, x / w)));
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

function setCh(trackId: string, patch: Partial<ChannelSettings>) {
  store.update((p) => Object.assign(p.tracks.find((t) => t.id === trackId)!.ch, patch));
}

/** Map a band drag (freq, gain) to ChannelSettings fields. */
function bandPatch(id: EqBandId, f: number, g: number | null): Partial<ChannelSettings> {
  const fr = Math.round(f);
  const gr = g === null ? undefined : Math.round(g * 10) / 10;
  switch (id) {
    case "hpf": return { hpf: Math.max(20, Math.min(1000, fr)) };
    case "lpf": return { lpf: Math.max(1000, Math.min(20000, fr)) };
    case "low": return { eqLowFreq: Math.max(30, Math.min(600, fr)), ...(gr !== undefined && { eqLow: gr }) };
    case "mid": return { eqMidFreq: fr, ...(gr !== undefined && { eqMid: gr }) };
    case "mid2": return { eqMid2Freq: fr, ...(gr !== undefined && { eqMid2: gr }) };
    case "high": return { eqHighFreq: Math.max(1500, Math.min(16000, fr)), ...(gr !== undefined && { eqHigh: gr }) };
  }
}

function resetPatch(id: EqBandId): Partial<ChannelSettings> {
  return { hpf: { hpf: 0 }, lpf: { lpf: 0 }, low: { eqLow: 0 }, mid: { eqMid: 0, eqMidQ: 1 }, mid2: { eqMid2: 0, eqMid2Q: 1 }, high: { eqHigh: 0 } }[id];
}

interface DrawOpts {
  range: number;
  spectrum?: Float32Array | null;
  sampleRate?: number;
  nodes: boolean;
  hot?: EqBandId | null;
}

function drawEq(cv: HTMLCanvasElement, ch: ChannelSettings, color: string, o: DrawOpts) {
  const dpr = devicePixelRatio || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#1c1d21";
  g.fillRect(0, 0, W, H);
  const yOf = (db: number) => H / 2 - (db / o.range) * (H / 2 - 4);

  // Grid
  g.strokeStyle = "#2e3035";
  g.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(fx(f, W)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (const db of [-12, -6, 6, 12]) {
    if (Math.abs(db) > o.range) continue;
    const y = Math.round(yOf(db)) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.strokeStyle = "#3d4047";
  g.beginPath(); g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(W, Math.round(yOf(0)) + 0.5); g.stroke();
  if (o.nodes) {
    g.fillStyle = T.faint;
    g.font = `10px ${T.font}`;
    g.textBaseline = "bottom";
    for (const f of [100, 1000, 10000]) g.fillText(fmtF(f), fx(f, W) + 3, H - 2);
    g.textBaseline = "middle";
    for (const db of [-12, 12]) if (Math.abs(db) <= o.range) g.fillText(`${db > 0 ? "+" : ""}${db}`, 3, yOf(db));
  }

  // Live spectrum (post-fader analyser)
  if (o.spectrum && o.sampleRate) {
    const sp = o.spectrum, bins = sp.length, nyq = o.sampleRate / 2;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) {
      const f = xf(x, W);
      const k = Math.min(bins - 1, Math.max(1, Math.round((f / nyq) * bins)));
      const db = sp[k]; // ~ -100..0 dBFS
      const y = H - Math.max(0, Math.min(1, (db + 96) / 84)) * H;
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = "rgba(160,170,185,0.16)";
    g.fill();
  }

  // Composite curve
  const n = Math.max(64, Math.floor(W / 2));
  const freqs = new Float32Array(n);
  for (let i = 0; i < n; i++) freqs[i] = xf((i / (n - 1)) * W, W);
  const resp = eqResponse(ch, freqs);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W, y = Math.max(0, Math.min(H, yOf(resp[i])));
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.lineTo(W, yOf(0));
  g.lineTo(0, yOf(0));
  g.closePath();
  g.fillStyle = color + "33";
  g.fill();
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W, y = Math.max(0, Math.min(H, yOf(resp[i])));
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.strokeStyle = color;
  g.lineWidth = o.nodes ? 2 : 1.5;
  g.stroke();
  g.lineWidth = 1;

  if (!o.nodes) return;
  for (const b of bandParams(ch)) {
    const x = fx(b.f, W);
    const y = b.id === "hpf" || b.id === "lpf" ? yOf(0) : yOf(b.g);
    const c = BAND_COLORS[b.id];
    g.beginPath();
    g.arc(x, y, o.hot === b.id ? 7 : 5.5, 0, Math.PI * 2);
    g.fillStyle = b.on ? c : "#1c1d21";
    g.fill();
    g.strokeStyle = c;
    g.lineWidth = 1.5;
    g.stroke();
    g.lineWidth = 1;
  }
}

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement | null>, h: number, onResize: () => void) {
  useEffect(() => {
    const cv = ref.current!;
    const ro = new ResizeObserver(() => {
      const dpr = devicePixelRatio || 1;
      const w = cv.parentElement!.clientWidth;
      const hh = h || cv.parentElement!.clientHeight;
      cv.width = w * dpr;
      cv.height = hh * dpr;
      cv.style.width = w + "px";
      cv.style.height = hh + "px";
      onResize();
    });
    ro.observe(cv.parentElement!);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Small read-only curve for channel strips. Click opens the full Channel EQ. */
export function EqThumb({ t }: { t: Track }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = () => ref.current && drawEq(ref.current, t.ch, t.color, { range: 15, nodes: false });
  useCanvasSize(ref, 40, draw);
  useEffect(() => {
    draw();
  });
  return (
    <div className="eq-thumb" data-tip="channel eq · click to edit" onClick={() => store.setUi({ selectedTrackId: t.id, showEditor: true, editorTab: "eq" })}>
      <canvas ref={ref} />
    </div>
  );
}

/** Full Channel EQ editor for the selected track. */
export default function ChannelEq() {
  const s = useStoreQuiet();
  const track = s.project.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const ref = useRef<HTMLCanvasElement>(null);
  const hot = useRef<EqBandId | null>(null);
  const spec = useRef<Float32Array | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  const draw = () => {
    const t = trackRef.current;
    if (!ref.current || !t) return;
    drawEq(ref.current, t.ch, t.color, { range: 18, nodes: true, hot: hot.current, spectrum: spec.current, sampleRate: engine.ctx.sampleRate });
  };
  useCanvasSize(ref, 0, draw);
  useEffect(() => {
    draw();
  });

  // Spectrum animation with peak-ish smoothing.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = trackRef.current;
      const an = t && engine.strips.get(t.id)?.analyser;
      if (an && engine.playing) {
        const cur = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(cur);
        const prev = spec.current;
        if (prev && prev.length === cur.length) for (let i = 0; i < cur.length; i++) cur[i] = Math.max(cur[i], prev[i] - 1.5);
        spec.current = cur;
        draw();
      } else if (spec.current && !engine.playing) {
        spec.current = null;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!track) return <div className="hint">select a track to edit its channel eq</div>;
  const ch = track.ch;

  const geom = () => {
    const cv = ref.current!;
    const r = cv.getBoundingClientRect();
    return { r, W: r.width, H: r.height };
  };
  const yToDb = (y: number, H: number) => ((H / 2 - y) / (H / 2 - 4)) * 18;
  const nearest = (e: { clientX: number; clientY: number }): EqBandId | null => {
    const { r, W, H } = geom();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: EqBandId | null = null, bd = 14;
    for (const b of bandParams(ch)) {
      const bx = fx(b.f, W), by = b.id === "hpf" || b.id === "lpf" ? H / 2 : H / 2 - (b.g / 18) * (H / 2 - 4);
      const d = Math.hypot(bx - x, by - y);
      if (d < bd) { bd = d; best = b.id; }
    }
    return best;
  };

  const onDown = (e: React.MouseEvent) => {
    const id = nearest(e);
    if (!id) return;
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const { r, W, H } = geom();
      const f = xf(ev.clientX - r.left, W);
      const db = Math.max(-18, Math.min(18, yToDb(ev.clientY - r.top, H)));
      setCh(track.id, bandPatch(id, f, id === "hpf" || id === "lpf" ? null : db));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMove = (e: React.MouseEvent) => {
    const id = nearest(e);
    if (id !== hot.current) {
      hot.current = id;
      draw();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const id = nearest(e);
    if (id !== "mid" && id !== "mid2") return;
    const key = id === "mid" ? "eqMidQ" : "eqMid2Q";
    const q = Math.max(0.2, Math.min(12, ch[key] * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setCh(track.id, { [key]: Math.round(q * 100) / 100 });
  };

  return (
    <div className="channel-eq">
      <div className="eq-graph" onMouseDown={onDown} onMouseMove={onMove} onWheel={onWheel} onDoubleClick={(e) => { const id = nearest(e); if (id) setCh(track.id, resetPatch(id)); }}>
        <canvas ref={ref} />
        <div className="eq-title"><span style={{ color: track.color }}>■</span> {track.name} · channel eq</div>
      </div>
      <div className="eq-bands">
        {bandParams(ch).map((b) => (
          <div key={b.id} className={`eq-band ${b.on ? "on" : ""}`} style={{ borderTopColor: BAND_COLORS[b.id] }}>
            <button
              className={`eq-power ${b.on ? "on" : ""}`}
              onClick={() => setCh(track.id, b.on ? resetPatch(b.id) : b.id === "hpf" ? { hpf: 80 } : b.id === "lpf" ? { lpf: 12000 } : bandPatch(b.id, b.f, 3))}
            >
              {BAND_LABEL[b.id]}
            </button>
            <span>{fmtF(b.f)} hz</span>
            {b.id !== "hpf" && b.id !== "lpf" && <span>{b.g > 0 ? "+" : ""}{b.g.toFixed(1)} db</span>}
            {(b.id === "mid" || b.id === "mid2") && <span>q {b.q.toFixed(2)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
