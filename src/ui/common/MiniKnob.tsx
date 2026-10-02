/** Small rotary knob (Logic send-knob size): drag up/down, wheel, double-click resets. */
export default function MiniKnob({ value, min, max, def, onChange, tip, size = 16, color = "var(--accent)", step = 0.5, bipolar = false }: { value: number; min: number; max: number; def: number; onChange: (v: number) => void; tip?: string; size?: number; color?: string; step?: number; bipolar?: boolean }) {
  const n = (value - min) / (max - min);
  const a = -135 + Math.max(0, Math.min(1, n)) * 270;
  const r = size / 2 - 2, c = size / 2;
  const pt = (deg: number) => [c + r * Math.sin((deg * Math.PI) / 180), c - r * Math.cos((deg * Math.PI) / 180)];
  const arc = (from: number, to: number) => {
    const [x0, y0] = pt(from), [x1, y1] = pt(to);
    return `M${x0} ${y0} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  return (
    <svg
      className="mini-knob"
      width={size}
      height={size}
      data-tip={tip}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const y0 = e.clientY, v0 = value;
        const move = (ev: MouseEvent) => onChange(clamp(v0 + ((y0 - ev.clientY) / (ev.shiftKey ? 400 : 100)) * (max - min)));
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      onWheel={(e) => onChange(clamp(value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? step : step * 4)))}
      onDoubleClick={() => onChange(def)}
    >
      <path d={arc(-135, 135)} stroke="#17181a" strokeWidth="2.5" fill="none" />
      {/* bipolar (pan): the arc grows from the top centre */}
      {bipolar ? Math.abs(a) > 1 && <path d={a > 0 ? arc(0, a) : arc(a, 0)} stroke={color} strokeWidth="2.5" fill="none" /> : n > 0.005 && <path d={arc(-135, a)} stroke={color} strokeWidth="2.5" fill="none" />}
      <line x1={c} y1={c} x2={pt(a)[0]} y2={pt(a)[1]} stroke="#f2f2f2" strokeWidth="1.5" />
    </svg>
  );
}
