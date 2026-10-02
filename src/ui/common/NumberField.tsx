import { useEffect, useState } from "react";

/** Numeric input that commits on Enter/blur, so partial values ("8" while typing "87") aren't clamped mid-typing. */
export default function NumberField({ value, min, max, step = 1, width = 64, onCommit, title }: { value: number; min: number; max: number; step?: number; width?: number; onCommit: (v: number) => void; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      data-tip={title}
      value={text}
      style={{ width }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setText(String(value)); (e.target as HTMLInputElement).blur(); }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(Math.max(min, Math.min(max, +(value + (e.key === "ArrowUp" ? step : -step)).toFixed(2))));
        }
      }}
    />
  );
}
