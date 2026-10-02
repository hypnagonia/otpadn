import type { ParamSpec } from "../../plugins/defs";

const toNorm = (s: ParamSpec, v: number) => (s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min));
const fromNorm = (s: ParamSpec, n: number) => {
  const c = Math.max(0, Math.min(1, n));
  const v = s.log ? s.min * Math.pow(s.max / s.min, c) : s.min + c * (s.max - s.min);
  return Math.round(v / s.step) * s.step;
};
export const fmtParam = (s: ParamSpec, v: number) =>
  s.options ? s.options[Math.round(v)] ?? "" : `${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : Number.isInteger(s.step) ? Math.round(v) : v.toFixed(1)}${s.unit ? (s.unit.startsWith(":") ? s.unit : " " + s.unit) : ""}`;

/** Rotary knob: drag up/down (shift = fine), wheel, double-click resets. Discrete params click-cycle. */
export default function Knob({ spec, value, onChange, color = "var(--accent)" }: { spec: ParamSpec; value: number; onChange: (v: number) => void; color?: string }) {
  const n = toNorm(spec, value);
  const a0 = -135, a = a0 + n * 270;
  const arc = (from: number, to: number) => {
    const r = 15, cx = 20, cy = 20;
    const p = (deg: number) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
    const [x0, y0] = p(from), [x1, y1] = p(to);
    return `M${x0} ${y0} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  if (spec.options) {
    return (
      <div className="knob discrete">
        <button onClick={() => onChange((Math.round(value) + 1) % spec.options!.length)} data-tip="click to change">{fmtParam(spec, value)}</button>
        <span className="knob-label">{spec.label}</span>
      </div>
    );
  }
  return (
    <div
      className="knob"
      onMouseDown={(e) => {
        e.preventDefault();
        const y0 = e.clientY, n0 = n;
        const move = (ev: MouseEvent) => onChange(fromNorm(spec, n0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 150)));
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      onWheel={(e) => onChange(fromNorm(spec, n + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02)))}
      onDoubleClick={() => onChange(spec.def)}
      data-tip={`${spec.label} · drag / wheel · shift = fine · double-click resets`}
    >
      <svg width="40" height="40" viewBox="0 0 40 40">
        <path d={arc(-135, 135)} stroke="#17181a" strokeWidth="4" fill="none" />
        {n > 0.001 && <path d={arc(-135, a)} stroke={color} strokeWidth="4" fill="none" />}
        <circle cx="20" cy="20" r="10" fill="#3a3c42" stroke="#111" />
        <line x1="20" y1="20" x2={20 + 9 * Math.sin((a * Math.PI) / 180)} y2={20 - 9 * Math.cos((a * Math.PI) / 180)} stroke="#f2f2f2" strokeWidth="2" />
      </svg>
      <span className="knob-val">{fmtParam(spec, value)}</span>
      <span className="knob-label">{spec.label}</span>
    </div>
  );
}
