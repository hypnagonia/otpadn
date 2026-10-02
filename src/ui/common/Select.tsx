import { useEffect, useRef, useState } from "react";

export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Custom HTML/CSS dropdown (no native <select>): keyboard + click, closes on outside click / Esc. */
export default function Select<T extends string | number>({ value, options, onChange, width, tip }: { value: T; options: Option<T>[]; onChange: (v: T) => void; width?: number; tip?: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div
      className={`dd ${open ? "open" : ""}`}
      ref={ref}
      style={width ? { width } : undefined}
      tabIndex={0}
      data-tip={open ? undefined : tip}
      onKeyDown={(e) => {
        if (e.key === "Escape") return setOpen(false);
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (open) pick(options[hi].value);
          else setOpen(true);
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (!open) setOpen(true);
          setHi((h) => Math.max(0, Math.min(options.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
        }
      }}
    >
      <button type="button" className="dd-btn" onClick={() => setOpen(!open)}>
        <span>{cur?.label ?? "—"}</span>
        <span className="dd-caret">▾</span>
      </button>
      {open && (
        <div className="dd-menu">
          {options.map((o, i) => (
            <button type="button" key={String(o.value)} className={`${o.value === value ? "cur" : ""} ${i === hi ? "hi" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => pick(o.value)}>
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
