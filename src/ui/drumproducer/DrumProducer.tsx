import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audition, endAudition, measureLoudness, refreshAudition, setMode, setSolo, type AbMode } from "../../drumproducer/audition";
import { dpClient } from "../../drumproducer/client";
import { GM_NAME } from "../../drumproducer/mapping";
import { pipelineInput } from "../../drumproducer/pipeline";
import { applySession, captureNotes, createSession, deleteSession, drumTracks, effectiveSound, getSession, resetSession, revertApplied, sessionForSelection, updateSession } from "../../drumproducer/session";
import { KITS } from "../../drumproducer/sound";
import { STYLES } from "../../drumproducer/styles";
import { DP_ALGO_VERSION, LAYER_LABEL, OUTPUT_LABEL, OUTPUTS, VOICE_INFO, VOICES, type DEvent, type DrumSession, type GridChoice, type Layer, type Output, type PipelineResult, type Proposal, type Style, type Voice } from "../../drumproducer/types";
import { exportStems } from "../../io/export";
import { store, useStoreQuiet } from "../../model/store";
import { formatPos } from "../common/format";
import NumberField from "../common/NumberField";
import { runTask } from "../common/runTask";
import Select from "../common/Select";
import DrumGrid, { ORIGIN_COLOR } from "./DrumGrid";

type View = "source" | "clean" | "result";

/** Pipeline result for a session: worker-computed, cached by input, latest request wins. */
function useResult(s: DrumSession | undefined, bpm: number) {
  const input = s ? pipelineInput(s, bpm) : null;
  const key = input ? JSON.stringify(input) : "";
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<{ result: PipelineResult | null; running: boolean; error: string | null; key: string }>({ result: null, running: false, error: null, key: "" });
  const latest = useRef("");
  useEffect(() => {
    latest.current = key;
    if (!input) return;
    const hit = dpClient.cached(input);
    if (hit) {
      setSt({ result: hit, running: false, error: null, key });
      return;
    }
    setSt((p) => ({ ...p, running: true, error: null }));
    const t = window.setTimeout(() => {
      dpClient.run(input).then(
        (r) => latest.current === key && setSt({ result: r, running: false, error: null, key }),
        (e: Error) => latest.current === key && setSt((p) => ({ ...p, running: false, error: e.message })),
      );
    }, 120);
    return () => clearTimeout(t);
  }, [key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, stale: st.key !== key, retry: () => setNonce((n) => n + 1) };
}

function Sl({ label, value, min = 0, max = 1, step = 0.01, fmt = (v: number) => `${Math.round(v * 100)}%`, tip, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; fmt?: (v: number) => string; tip?: string; onChange: (v: number) => void }) {
  return (
    <label className="dp-sl" data-tip={tip}>
      <span className="k">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="v">{fmt(value)}</span>
    </label>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string; tip?: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? "on" : ""} data-tip={o.tip} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </span>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signedPct = (v: number) => `${v > 0 ? "+" : ""}${Math.round((Math.pow(2, v) - 1) * 100)}%`;
const swingPct = (v: number) => `${Math.round(50 + v * 25)}%`;
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

/** Start screen: capture the selected clip (or cycle range), optionally merging other drum tracks. */
function Start() {
  const s = useStoreQuiet();
  const p = s.project;
  const track = p.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const clip = track?.clips.find((c) => c.id === s.ui.selectedClipId && c.kind === "midi");
  const [useCycle, setUseCycle] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const others = drumTracks().filter((t) => t.id !== track?.id);
  const range = useCycle && p.loop.end > p.loop.start ? { start: p.loop.start, length: p.loop.end - p.loop.start } : clip && clip.kind === "midi" ? { start: clip.start, length: clip.length } : null;
  const ids = track ? [track.id, ...extra] : extra;
  const count = range ? captureNotes(ids, range.start, range.length).notes.length : 0;
  const existing = Object.values(p.drumSessions ?? {});
  return (
    <div className="dp-start">
      <div className="dp-card">
        <h3>drum producer</h3>
        <p className="muted">turns a rough drum MIDI part (e.g. from drums → midi) into a clean electronic drum track: clean → rework (house / techno) → groove → kit & processing. the source clip is never changed.</p>
        {track?.kind === "midi" && (clip || useCycle) ? (
          <>
            <div className="kv"><span className="k">source</span><span className="v">{track.name}{clip ? ` · bar ${clip.start / 4 + 1}` : ""}</span></div>
            <label className="dp-check"><input type="checkbox" checked={useCycle} disabled={!p.loop.on} onChange={(e) => setUseCycle(e.target.checked)} /> use cycle range ({formatPos(p.loop.start)} – {formatPos(p.loop.end)}){!p.loop.on && <span className="muted"> · cycle is off</span>}</label>
            {others.length > 0 && <div className="muted" style={{ marginTop: 6 }}>merge other drum tracks:</div>}
            {others.map((t) => (
              <label key={t.id} className="dp-check"><input type="checkbox" checked={extra.includes(t.id)} onChange={(e) => setExtra(e.target.checked ? [...extra, t.id] : extra.filter((x) => x !== t.id))} /> {t.name}</label>
            ))}
            {range && <div className="kv"><span className="k">region</span><span className="v">{(range.length / 4).toFixed(2).replace(/\.00$/, "")} bars · {count} notes</span></div>}
            <button className="primary" disabled={!range} onClick={() => range && createSession({ trackIds: ids, start: range.start, length: range.length, name: track.name })}>start session</button>
          </>
        ) : (
          <p className="hint" style={{ padding: 0 }}>select a midi clip (click a region on a midi track) to start.</p>
        )}
        {existing.length > 0 && (
          <>
            <div className="muted" style={{ marginTop: 12 }}>sessions in this project:</div>
            {existing.map((x) => (
              <button key={x.id} className="link" style={{ display: "block", marginTop: 4 }} onClick={() => store.setUi({ dpSession: x.id })}>{x.source.name} · {x.source.length / 4} bars{x.applied ? " · applied" : ""}</button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default function DrumProducer() {
  const st = useStoreQuiet();
  const sel = sessionForSelection();
  const s = sel ?? getSession(st.ui.dpSession);
  // Leaving the panel ends the audition overlay.
  useEffect(() => {
    return () => {
      endAudition();
    };
  }, []);
  if (!s) return <Start />;
  return <Session key={s.id} s={s} />;
}

function Session({ s }: { s: DrumSession }) {
  const st = useStoreQuiet();
  const p = st.project;
  const { result: r, running, error, stale, retry } = useResult(s, p.bpm);
  const ab = useSyncExternalStore(audition.subscribe, audition.get);
  const [view, setView] = useState<View>("result");
  const [hover, setHover] = useState<{ e: DEvent; dropped: boolean } | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [allVoices, setAllVoices] = useState(false);
  const up = (fn: (x: DrumSession) => void) => updateSession(s.id, fn);
  const eff = r ? effectiveSound(s, r) : s;

  useEffect(() => {
    if (st.ui.dpSession !== s.id) store.setUi({ dpSession: s.id });
  }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refreshAudition(eff, r);
    // The store mutates in place: compare content, not identity.
  }, [r, JSON.stringify(eff.sound), ab.mode, ab.solo, JSON.stringify(s.applied ?? null), s.source.trackIds.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const lockedIds = new Set(s.locks.events.map((e) => e.id));
  const setSound = (fn: (x: DrumSession["sound"]) => void) =>
    up((x) => {
      if (x.sound.auto && r) {
        x.sound.kit = structuredClone(r.sound.kit);
        x.sound.outputs = structuredClone(r.sound.outputs);
        x.sound.auto = false;
      }
      fn(x.sound);
    });
  const toggleEventLock = (e: DEvent) =>
    up((x) => {
      const i = x.locks.events.findIndex((l) => l.id === e.id);
      if (i >= 0) x.locks.events.splice(i, 1);
      else if (e.src) x.locks.events.push({ id: e.id, voice: e.voice, start: e.src.start, micro: 0, vel: e.src.vel, dur: e.dur, origin: "source", layer: e.layer, src: e.src });
      else x.locks.events.push({ ...e, locked: true });
    });
  const toggleVoiceLock = (v: Voice) => up((x) => { x.locks.voices = x.locks.voices.includes(v) ? x.locks.voices.filter((y) => y !== v) : [...x.locks.voices, v]; });
  const reseedLayer = (L: Layer) => up((x) => { x.layerSeeds[L] = (x.layerSeeds[L] * 31 + 17) % 1000000007; });

  const shown = !r ? { events: [], dropped: [] } : view === "source" ? { events: r.sourceEvents, dropped: [] } : view === "clean" ? { events: r.cleaned, dropped: r.cleanedDropped } : { events: r.final, dropped: r.variants[r.chosen]?.dropped ?? [] };
  const length = r ? (view === "result" ? r.lengthBeats : s.source.length) : s.source.length;
  const a = r?.analysis;
  const variantNames = ["close", "moderate", "free"];
  const voicesInResult = new Set(r?.final.map((e) => e.voice));

  return (
    <div className="dp">
      <div className="dp-head">
        <b>{s.source.name}</b>
        <span className="muted">{(s.source.length / 4).toFixed(2).replace(/\.00$/, "")} bars · {s.source.notes.length} notes · {p.bpm} bpm · 4/4</span>
        {running || stale ? <span className="dp-status">working (worker)… <button className="link" onClick={() => dpClient.cancel()}>cancel</button></span> : error ? <span className="err">{error === "cancelled" ? "cancelled" : `error: ${error.split("\n")[0]}`} <button className="link" onClick={retry}>run again</button></span> : <span className="muted">{DP_ALGO_VERSION} · {Math.round(dpClient.lastMs)} ms</span>}
        <span className="spacer" />
        <button className="primary" data-tip="clean + rework + groove + sound, each stage stays separately editable" onClick={() => up((x) => { x.clean.on = x.rework.on = x.groove.on = x.sound.on = true; })}>run all</button>
        <button className="icon" disabled={!st.canUndo} onClick={() => st.undo()} data-tip="undo (⌘Z)">↶</button>
        <button className="icon" disabled={!st.canRedo} onClick={() => st.redo()} data-tip="redo (⇧⌘Z)">↷</button>
        <button onClick={() => resetSession(s.id)} data-tip="reset all parameters, decisions and locks (source and applied tracks stay)">reset</button>
        <button onClick={() => store.setUi({ dpSession: null, selectedClipId: null })} data-tip="back to the session list">sessions</button>
        <button onClick={() => deleteSession(s.id)} data-tip="delete this session (applied tracks stay)">×</button>
      </div>

      <div className="dp-ab">
        <span className="label">listen</span>
        <Seg<AbMode> value={ab.mode} onChange={setMode} options={[{ value: "off", label: "project" }, { value: "source", label: "A source" }, { value: "result", label: "B result" }]} />
        <span className="seg">
          <button className={ab.solo === null ? "on" : ""} onClick={() => setSolo(null)} disabled={ab.mode !== "result"}>all</button>
          {OUTPUTS.map((o) => <button key={o} className={ab.solo === o ? "on" : ""} disabled={ab.mode !== "result" || !r?.final.some((e) => VOICE_INFO[e.voice].out === o)} onClick={() => setSolo(ab.solo === o ? null : o)}>{OUTPUT_LABEL[o]}</button>)}
        </span>
        <label className="dp-check" data-tip="trim the louder side so A/B compares sound, not level"><input type="checkbox" checked={ab.match} onChange={(e) => { audition.set({ match: e.target.checked }); refreshAudition(eff, r); }} /> match loudness</label>
        <button disabled={!r || ab.measuring} onClick={() => r && measureLoudness(eff, r)}>{ab.measuring ? "measuring…" : "measure"}</button>
        {ab.lufs && <span className="muted">A {ab.lufs.source.toFixed(1)} / B {ab.lufs.result.toFixed(1)} LUFS{ab.trims ? ` · trim ${ab.trims.source ? `A ${db(ab.trims.source)}` : `B ${db(ab.trims.result)}`} dB` : ""}</span>}
        {ab.error && <span className="err">{ab.error}</span>}
        <button data-tip="cycle the source region" onClick={() => store.update((x) => { x.loop = { on: true, start: s.source.start, end: s.source.start + (r?.lengthBeats ?? s.source.length) }; })}>loop region</button>
        <span className="spacer" />
        {s.applied ? (
          <>
            <span className="muted" data-tip={`seed ${s.applied.seed} · ${s.applied.algo}`}>applied {new Date(s.applied.at).toLocaleTimeString()} · {variantNames[s.applied.variant] ?? "result"}</span>
            <button className="primary" disabled={!r || stale} onClick={() => r && applySession(s.id, r, eff.sound)}>update applied</button>
            <button onClick={() => revertApplied(s.id)} data-tip="remove the applied tracks and unmute the source">revert to source</button>
            <button onClick={() => runTask(() => exportStems(Object.values(s.applied!.tracks)))} data-tip="bounce each applied track as a wav stem (pre-master, with effect tails)">stems…</button>
          </>
        ) : (
          <>
            <label className="dp-check"><input type="checkbox" checked={s.muteSourceOnApply} onChange={(e) => up((x) => { x.muteSourceOnApply = e.target.checked; })} /> mute source</label>
            <button className="primary" disabled={!r || stale || !r.final.length} onClick={() => { if (r) { applySession(s.id, r, eff.sound); setMode("off"); } }}>apply → tracks</button>
          </>
        )}
      </div>

      <div className="dp-body">
        <div className="dp-steps">
          {/* 1 · mapping */}
          <details open={!s.mappingConfirmed} className="insp-section">
            <summary>1 · mapping {a && (a.mappingStatus === "gm-consistent" ? <span className="ok">✓ gm consistent</span> : a.mappingStatus === "needs-review" ? <span className="warn">check</span> : <span className="muted">empty</span>)}{s.mappingConfirmed && <span className="ok"> · confirmed</span>}</summary>
            {a?.mapping.map((m) => (
              <div key={m.pitch} className="dp-map" data-tip={m.note}>
                <span className={`chip ${m.status}`}>{m.status === "gm-ok" ? "gm" : m.status}</span>
                <span className="pitch">{m.pitch} <small>{GM_NAME[m.pitch] ?? ""}</small></span>
                <span className="muted">×{m.count}</span>
                <Select<string> value={s.mapping[String(m.pitch)] ?? "ignore"} width={110} options={[...VOICES.map((v) => ({ value: v, label: VOICE_INFO[v].label })), { value: "ignore", label: "ignore" }]} onChange={(v) => up((x) => { x.mapping[String(m.pitch)] = v as Voice | "ignore"; x.mappingConfirmed = false; })} />
              </div>
            ))}
            {a && !a.mapping.length && <div className="muted">no notes in the region</div>}
            <div className="insp-actions">
              <button disabled={s.mappingConfirmed} onClick={() => up((x) => { x.mappingConfirmed = true; })}>confirm mapping</button>
            </div>
          </details>

          {/* 2 · clean */}
          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.clean.on} onChange={(e) => up((x) => { x.clean.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 2 · clean</summary>
            <Sl label="quantize" value={s.clean.strength} tip="soft-quantize strength; the rest stays as micro-timing" onChange={(v) => up((x) => { x.clean.strength = v; })} />
            <div className="dp-row">
              <span className="k">grid</span>
              <Seg<GridChoice> value={s.clean.grid} onChange={(v) => up((x) => { x.clean.grid = v; })} options={[{ value: "auto", label: "auto" }, { value: "straight", label: "1/16" }, { value: "triplet", label: "triplet" }, { value: "mixed", label: "per beat", tip: "straight, with triplet figures where the beat has them" }]} />
            </div>
            {a && <div className={`dp-note ${a.grid.decision === "ambiguous" ? "warn" : ""}`}>detected: <b>{a.grid.decision}</b> — {a.grid.note}{a.swing !== null && a.swing > 0.5 ? ` · source swing ≈ ${Math.round(a.swing * 100)}%` : ""}</div>}
            {a?.warnings.map((w) => <div key={w} className="dp-note warn">{w}</div>)}
            {r && s.clean.on && (
              <div className="muted">{r.proposals.filter((x) => x.accepted).length}/{r.proposals.length} proposals on · {r.cleanedDropped.length} removed {Object.keys(s.clean.decisions).length > 0 && <button className="link" onClick={() => up((x) => { x.clean.decisions = {}; })}>reset decisions</button>}</div>
            )}
          </details>

          {/* 3 · rework */}
          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.rework.on} onChange={(e) => up((x) => { x.rework.on = e.target.checked; if (e.target.checked) x.groove.on = true; })} onClick={(e) => e.stopPropagation()} /> 3 · rework</summary>
            <div className="dp-row">
              <span className="k">style</span>
              <Seg<Style> value={s.rework.style} onChange={(v) => up((x) => { x.rework.style = v; })} options={(Object.keys(STYLES) as Style[]).map((k) => ({ value: k, label: k, tip: STYLES[k].desc }))} />
            </div>
            <Sl label="preserve" value={s.rework.preserve} tip="how much of the source pattern is kept as anchors" onChange={(v) => up((x) => { x.rework.preserve = v; })} />
            <Sl label="energy" value={s.rework.energy} tip="pattern intensity, accents and fill strength (density is separate)" onChange={(v) => up((x) => { x.rework.energy = v; })} />
            <div className="dp-row">
              <span className="k">length</span>
              <Seg<string> value={String(s.rework.length)} onChange={(v) => up((x) => { x.rework.length = v === "source" ? "source" : (+v as 8 | 16); })} options={[{ value: "source", label: "as source" }, { value: "8", label: "8 bars", tip: "explicitly extend by repeating the source" }, { value: "16", label: "16 bars", tip: "explicitly extend by repeating the source" }]} />
            </div>
            {s.rework.on && r && r.variants.length === 3 && (
              <div className="dp-variants">
                {r.variants.map((v, i) => (
                  <button key={v.name} className={`dp-var ${s.rework.variant === i ? "on" : ""}`} onClick={() => up((x) => { x.rework.variant = i as 0 | 1 | 2; })} data-tip={Object.entries(v.stats.patterns).map(([k, n]) => `${k}: ${n}`).join(" · ") || "no patterns"}>
                    <b>{v.name}</b>
                    <small>{v.stats.events} hits · {v.stats.perBar}/bar</small>
                    <small>{v.stats.kept} kept · {v.stats.generated} new · {v.stats.fills} fills</small>
                  </button>
                ))}
              </div>
            )}
            {s.rework.on && (
              <>
                <div className="dp-row wrap">
                  <span className="k">regenerate</span>
                  {(["foundation", "motion", "perc", "phrase"] as Layer[]).map((L) => <button key={L} onClick={() => reseedLayer(L)} data-tip={`new variation of ${LAYER_LABEL[L]} only`}>↻ {LAYER_LABEL[L]}</button>)}
                </div>
                <div className="dp-row">
                  <span className="k">seed</span>
                  <NumberField value={s.seed} min={1} max={999999999} width={90} onCommit={(v) => up((x) => { x.seed = Math.round(v); x.layerSeeds = { foundation: x.seed * 101 + 1, motion: x.seed * 101 + 2, perc: x.seed * 101 + 3, phrase: x.seed * 101 + 4 }; })} />
                  <button onClick={() => up((x) => { x.seed = 1 + Math.floor(Math.random() * 999999); x.layerSeeds = { foundation: x.seed * 101 + 1, motion: x.seed * 101 + 2, perc: x.seed * 101 + 3, phrase: x.seed * 101 + 4 }; })}>new seed</button>
                </div>
                {a && (["foundation", "motion", "perc"] as const).filter((L) => !a.density[L]).map((L) => (
                  <label key={L} className="dp-check" data-tip="this layer is empty in the source; nothing is added unless you ask"><input type="checkbox" checked={!!s.rework.addLayers[L]} onChange={(e) => up((x) => { x.rework.addLayers = { ...x.rework.addLayers, [L]: e.target.checked }; })} /> add {LAYER_LABEL[L]} (empty in source)</label>
                ))}
              </>
            )}
          </details>

          {/* 4 · groove */}
          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.groove.on} onChange={(e) => up((x) => { x.groove.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 4 · groove</summary>
            <Sl label="density" value={s.groove.density} min={-1} max={1} fmt={signedPct} tip="hits per layer vs the source (0 = same as source)" onChange={(v) => up((x) => { x.groove.density = v; })} />
            <Sl label="swing" value={s.groove.swing} fmt={swingPct} tip="16th swing" onChange={(v) => up((x) => { x.groove.swing = v; })} />
            <div className="dp-row small">
              <button className="link" onClick={() => up((x) => { x.groove.swing = STYLES[x.rework.style].swing; })}>{s.rework.style} default {swingPct(STYLES[s.rework.style].swing)}</button>
              {a?.swing && a.swing > 0.5 && <button className="link" onClick={() => up((x) => { x.groove.swing = Math.min(1, (a.swing! - 0.5) / 0.25); })}>source {Math.round(a.swing * 100)}%</button>}
            </div>
            <Sl label="accents" value={s.groove.accent} tip="velocity contrast by musical role" onChange={(v) => up((x) => { x.groove.accent = v; })} />
            <Sl label="timing" value={s.groove.micro} tip="per-voice micro-timing (kick stays strict); 50% = style default" onChange={(v) => up((x) => { x.groove.micro = v; })} />
            <Sl label="fills" value={s.groove.fills} tip="how often phrase ends get a fill / drop (never on every repeat)" onChange={(v) => up((x) => { x.groove.fills = v; })} />
          </details>

          {/* 5 · sound */}
          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.sound.on} onChange={(e) => up((x) => { x.sound.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 5 · sound</summary>
            <div className="dp-row">
              <span className="k">kit</span>
              <Select<string> value={eff.sound.kit.kitId} width={150} options={Object.entries(KITS).map(([id, k]) => ({ value: id, label: k.name, hint: k.styles.join("/") }))} onChange={(id) => setSound((x) => { const k = KITS[id].make(); x.kit = k; })} />
              <label className="dp-check" data-tip="re-pick kit and processing from the result automatically"><input type="checkbox" checked={s.sound.auto} onChange={(e) => up((x) => { if (!e.target.checked && r) { x.sound.kit = structuredClone(r.sound.kit); x.sound.outputs = structuredClone(r.sound.outputs); } x.sound.auto = e.target.checked; })} /> auto</label>
            </div>
            {s.sound.auto && r?.sound.notes.map((n) => <div key={n} className="dp-note">{n}</div>)}
            <div className="dp-voices">
              <div className="dp-vh"><span /><span>lvl</span><span>pan</span><span>tune</span><span>atk</span><span>dec</span><span>tone</span></div>
              {VOICES.filter((v) => allVoices || voicesInResult.has(v)).map((v) => {
                const vs = eff.sound.kit.voices[v];
                const setV = (k: keyof typeof vs, val: number | boolean) => setSound((x) => { (x.kit.voices[v] as unknown as Record<string, number | boolean>)[k] = val; });
                return (
                  <div key={v} className="dp-vr">
                    <label className="dp-check"><input type="checkbox" checked={vs.on} onChange={(e) => setV("on", e.target.checked)} /> {VOICE_INFO[v].label}</label>
                    <input type="range" min={-24} max={6} step={0.5} value={vs.level} data-tip={`level ${db(vs.level)} dB`} onChange={(e) => setV("level", +e.target.value)} />
                    <input type="range" min={-1} max={1} step={0.05} value={vs.pan} data-tip={`pan ${vs.pan.toFixed(2)}`} onChange={(e) => setV("pan", +e.target.value)} />
                    <input type="range" min={-12} max={12} step={0.5} value={vs.tune} data-tip={`tune ${vs.tune} st`} onChange={(e) => setV("tune", +e.target.value)} />
                    <input type="range" min={0} max={1} step={0.05} value={vs.attack} data-tip={`attack/click ${pct(vs.attack)}`} onChange={(e) => setV("attack", +e.target.value)} />
                    <input type="range" min={0.2} max={2} step={0.05} value={vs.decay} data-tip={`decay ×${vs.decay}`} onChange={(e) => setV("decay", +e.target.value)} />
                    <input type="range" min={0} max={1} step={0.05} value={vs.tone} data-tip={`tone ${pct(vs.tone)}`} onChange={(e) => setV("tone", +e.target.value)} />
                  </div>
                );
              })}
              <button className="link" onClick={() => setAllVoices(!allVoices)}>{allVoices ? "only voices in use" : "show all voices"}</button>
            </div>
            <div className="dp-procs">
              <div className="dp-ph"><span>output</span><span>fader</span><span>eq</span><span>sat</span><span>comp</span><span>verb</span></div>
              {OUTPUTS.map((o: Output) => {
                const pr = eff.sound.outputs[o];
                return (
                  <div key={o} className="dp-pr">
                    <span>{OUTPUT_LABEL[o]}</span>
                    <input type="range" min={-24} max={6} step={0.5} value={pr.level} data-tip={`fader ${db(pr.level)} dB`} onChange={(e) => setSound((x) => { x.outputs[o].level = +e.target.value; })} />
                    <input type="checkbox" checked={pr.eq.on} data-tip={`hpf ${pr.eq.hpf} Hz · low ${db(pr.eq.low)} · high ${db(pr.eq.high)} dB`} onChange={(e) => setSound((x) => { x.outputs[o].eq.on = e.target.checked; })} />
                    <input type="checkbox" checked={pr.sat.on} data-tip={`saturator drive ${Math.round(pr.sat.drive * 18)} dB`} onChange={(e) => setSound((x) => { x.outputs[o].sat.on = e.target.checked; })} />
                    <input type="checkbox" checked={pr.comp.on} data-tip={`compressor ${pr.comp.threshold} dB · ${pr.comp.ratio}:1 · ${pr.comp.attack} ms attack`} onChange={(e) => setSound((x) => { x.outputs[o].comp.on = e.target.checked; })} />
                    <input type="checkbox" checked={pr.send.on} data-tip={`reverb send ${pct(pr.send.amount)}`} onChange={(e) => setSound((x) => { x.outputs[o].send.on = e.target.checked; })} />
                  </div>
                );
              })}
              <div className="dp-note">no limiter is added. kick gets its own track; this DAW has no sidechain bus yet, so kick→bass ducking has to be routed later.</div>
            </div>
          </details>
        </div>

        <div className="dp-main">
          <div className="dp-viewbar">
            <Seg<View> value={view} onChange={setView} options={[{ value: "source", label: "source" }, { value: "clean", label: "cleaned" }, { value: "result", label: s.rework.on ? `result · ${variantNames[s.rework.variant]}` : "result" }]} />
            <span className="dp-legend">
              {(["source", "moved", "velocity", "added", "generated", "fill", "dropped"] as const).map((k) => <span key={k}><i style={{ background: ORIGIN_COLOR[k] }} />{k === "dropped" ? "removed" : k}</span>)}
              <span><i className="lk" />locked</span>
            </span>
          </div>
          <div className="dp-hover">
            {hover ? (
              <>
                <b>{VOICE_INFO[hover.e.voice].label}</b> · {hover.dropped ? "removed" : hover.e.origin} · bar {formatPos(hover.e.start)} · vel {Math.round(hover.e.vel)}
                {!hover.dropped && Math.abs(hover.e.micro) > 1e-4 && ` · ${hover.e.micro > 0 ? "+" : ""}${Math.round(hover.e.micro * (60 / p.bpm) * 1000)} ms`}
                {hover.e.src && ` · src ${hover.e.src.pitch} @ ${formatPos(hover.e.src.start)} v${hover.e.src.vel}`}
                {hover.e.conf !== undefined && ` · confidence ${hover.e.conf.toFixed(2)} (from source)`}
                {hover.e.heur !== undefined && ` · heuristic ${hover.e.heur.toFixed(2)}`}
                {hover.e.tags?.length ? ` · ${hover.e.tags.join(", ")}` : ""}
                {lockedIds.has(hover.e.id) || hover.e.locked ? " · locked" : " · click to lock"}
              </>
            ) : (
              <span className="muted">click a hit to lock it · click a row name to lock the instrument · locked hits never change in any stage</span>
            )}
          </div>
          {r ? (
            <DrumGrid events={shown.events} dropped={shown.dropped} lengthBeats={length} regionStart={s.source.start} lockedVoices={s.locks.voices} lockedIds={lockedIds} highlight={highlight} onEvent={toggleEventLock} onVoice={toggleVoiceLock} onHover={(e, d) => setHover(e ? { e, dropped: d } : null)} />
          ) : (
            <div className="hint">{error ? "no result" : "analysing…"}</div>
          )}
          {r && s.clean.on && r.proposals.length > 0 && (
            <div className="dp-props">
              <div className="dp-props-head">cleanup proposals <span className="muted">· heuristic scores, not probabilities · uncheck to keep the original</span></div>
              {r.proposals.map((pp: Proposal) => (
                <label key={pp.id} className={`dp-prop ${pp.accepted ? "" : "off"}`} onMouseEnter={() => setHighlight(new Set(pp.eventIds))} onMouseLeave={() => setHighlight(new Set())}>
                  <input type="checkbox" checked={pp.accepted} onChange={() => up((x) => { x.clean.decisions[pp.id] = !pp.accepted; })} />
                  <span className={`chip ${pp.kind}`}>{pp.kind}</span>
                  <span className="pos">{pp.kind === "quantize" ? "all" : formatPos(pp.at)}</span>
                  <span className="why">{pp.reason}</span>
                  <span className="h">{pp.heur.toFixed(2)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
