import { useSyncExternalStore } from "react";

/** In-app confirm dialog (replaces window.confirm). `await confirmDialog({...})` → boolean. */
type Req = { title: string; body?: string; ok: string; danger?: boolean; input?: string; resolve: (v: boolean) => void };
let inputValue = "";
let current: Req | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function confirmDialog(o: { title: string; body?: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    current = { ok: "ok", ...o, resolve };
    emit();
  });
}

/** In-app text prompt (replaces window.prompt). Resolves the entered text, or null on cancel. */
export function promptDialog(o: { title: string; value?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    inputValue = o.value ?? "";
    current = { title: o.title, ok: o.ok ?? "ok", input: inputValue, resolve: (v) => resolve(v ? inputValue : null) };
    emit();
  });
}

function close(v: boolean) {
  current?.resolve(v);
  current = null;
  emit();
}

export function DialogHost() {
  const req = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => current);
  if (!req) return null;
  return (
    <div className="dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)} onKeyDown={(e) => { if (e.key === "Escape") close(false); if (e.key === "Enter") close(true); }}>
      <div className="dlg" role="dialog">
        <h3>{req.title}</h3>
        {req.body && <p>{req.body}</p>}
        {req.input !== undefined && <input className="dlg-input" type="text" autoFocus defaultValue={req.input} onChange={(e) => (inputValue = e.target.value)} />}
        <div className="dlg-actions">
          <button onClick={() => close(false)}>cancel</button>
          <button className={req.danger ? "danger" : "primary"} autoFocus={req.input === undefined} onClick={() => close(true)}>{req.ok}</button>
        </div>
      </div>
    </div>
  );
}
