import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { exportStems } from "../../io/export";
import { INSTRUMENTS } from "../../instruments/catalog";
import { store, useStoreQuiet } from "../../model/store";
import { endPartAudition, measurePart, ppAudition, refreshPartAudition, setPartMode, type AbMode } from "../../partproducer/audition";
import { ppClient } from "../../partproducer/client";
import { modeForRole } from "../../partproducer/defaults";
import { applyPart, createPart, deletePart, effectiveSound, getPart, partForSelection, partInput, resetPart, revertPart, setMode, updatePart } from "../../partproducer/session";
import { MODE_LABEL, NOTE, PP_ALGO_VERSION, QUALITY_IV, STYLES_FOR, chordName, type Chord, type GridChoice, type Mode, type PartSession, type PEvent, type PipelineResult, type Proposal, type Quality, type Style } from "../../partproducer/types";
import { formatPos } from "../common/format";
import NumberField from "../common/NumberField";
import { runTask } from "../common/runTask";
import Select from "../common/Select";
import PartGrid, { PP_COLOR, pitchName } from "./PartGrid";
import { TUNING } from "../../partproducer/voicing";

type View = "source" | "clean" | "result";

function useResult(s: PartSession | undefined) {
  const input = s ? partInput(s) : null;
  const key = input ? JSON.stringify(input) : "";
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<{ result: PipelineResult | null; running: boolean; error: string | null; key: string }>({ result: null, running: false, error: null, key: "" });
  const latest = useRef("");
  useEffect(() => {
    latest.current = key;
    if (!input) return;
    const hit = ppClient.cached(input);
    if (hit) {
      setSt({ result: hit, running: false, error: null, key });
      return;
    }
    setSt((p) => ({ ...p, running: true, error: null }));
    const t = window.setTimeout(() => {
      ppClient.run(input).then(
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
      {options.map((o) => <button key={String(o.value)} className={o.value === value ? "on" : ""} data-tip={o.tip} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </span>
  );
}

const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
const KEYS = [{ value: "auto", label: "detect" }, ...Array.from({ length: 24 }, (_, i) => ({ value: `${i % 12}:${i >= 12 ? "m" : "M"}`, label: `${NOTE[i % 12]} ${i >= 12 ? "minor" : "major"}` }))];
const PITCHED = INSTRUMENTS.filter((i) => !/^(drums|abuse|kit|dpkit):/.test(i.id));

function Start() {
  const s = useStoreQuiet();
  const p = s.project;
  const track = p.tracks.find((t) => t.id === s.ui.selectedTrackId);
  const clip = track?.clips.find((c) => c.id === s.ui.selectedClipId && c.kind === "midi");
  const [useCycle, setUseCycle] = useState(false);
  const [mode, setM] = useState<Mode | null>(null);
  const m = mode ?? (track ? modeForRole(track.role) : "keys");
  const range = useCycle && p.loop.end > p.loop.start ? { start: p.loop.start, length: p.loop.end - p.loop.start } : clip?.kind === "midi" ? { start: clip.start, length: clip.length } : null;
  const existing = Object.values(p.partSessions ?? {});
  return (
    <div className="dp-start">
      <div className="dp-card">
        <h3>part producer</h3>
        <p className="muted">turns a rough transcribed part into a clean, playable one — keys (chords, stabs, pads, arps), a vocal/lead line, or guitar (playable shapes, strums, picking, power chords). harmony-aware; the source clip is never changed.</p>
        {track?.kind === "midi" && (clip || useCycle) ? (
          <>
            <div className="kv"><span className="k">source</span><span className="v">{track.name} · {track.role}</span></div>
            <div className="dp-row"><span className="k">treat as</span><Seg<Mode> value={m} onChange={setM} options={(Object.keys(MODE_LABEL) as Mode[]).map((x) => ({ value: x, label: MODE_LABEL[x] }))} /></div>
            <label className="dp-check"><input type="checkbox" checked={useCycle} disabled={!p.loop.on} onChange={(e) => setUseCycle(e.target.checked)} /> use cycle range{!p.loop.on && <span className="muted"> · cycle is off</span>}</label>
            {range && <div className="kv"><span className="k">region</span><span className="v">{(range.length / 4).toFixed(2).replace(/\.00$/, "")} bars</span></div>}
            <button className="primary" disabled={!range} onClick={() => range && createPart({ trackId: track.id, start: range.start, length: range.length, mode: m })}>start session</button>
          </>
        ) : (
          <p className="hint" style={{ padding: 0 }}>select a midi clip on a keys, vocal/lead or guitar track to start.</p>
        )}
        {existing.length > 0 && (
          <>
            <div className="muted" style={{ marginTop: 12 }}>sessions in this project:</div>
            {existing.map((x) => <button key={x.id} className="link" style={{ display: "block", marginTop: 4 }} onClick={() => store.setUi({ ppSession: x.id })}>{x.source.name} · {MODE_LABEL[x.mode]} · {x.source.length / 4} bars{x.applied ? " · applied" : ""}</button>)}
          </>
        )}
      </div>
    </div>
  );
}

export default function PartProducer() {
  const st = useStoreQuiet();
  const s = partForSelection() ?? getPart(st.ui.ppSession);
  useEffect(() => {
    return () => {
      endPartAudition();
    };
  }, []);
  return s ? <Session key={s.id} s={s} /> : <Start />;
}

function Session({ s }: { s: PartSession }) {
  const st = useStoreQuiet();
  const p = st.project;
  const { result: r, running, error, stale, retry } = useResult(s);
  const ab = useSyncExternalStore(ppAudition.subscribe, ppAudition.get);
  const [view, setView] = useState<View>("result");
  const [hover, setHover] = useState<{ e: PEvent; dropped: boolean } | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const up = (fn: (x: PartSession) => void) => updatePart(s.id, fn);
  const snd = effectiveSound(s, r);

  useEffect(() => {
    if (st.ui.ppSession !== s.id) store.setUi({ ppSession: s.id });
  }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refreshPartAudition(s, r);
    // the store mutates in place: compare content
  }, [r, JSON.stringify(s.sound), ab.mode, JSON.stringify(s.applied ?? null), s.source.trackIds.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const lockedIds = new Set(s.locks.events.map((e) => e.id));
  const setSound = (fn: (x: PartSession["sound"]) => void) =>
    up((x) => {
      if (x.sound.auto && r) {
        x.sound.instrument = r.sound.instrument;
        x.sound.proc = structuredClone(r.sound.proc);
        x.sound.auto = false;
      }
      fn(x.sound);
    });
  const toggleLock = (e: PEvent) =>
    up((x) => {
      const i = x.locks.events.findIndex((l) => l.id === e.id);
      if (i >= 0) x.locks.events.splice(i, 1);
      else if (e.src) x.locks.events.push({ id: e.id, pitch: e.src.pitch, start: e.src.start, micro: 0, dur: e.src.dur, vel: e.src.vel, origin: "source", src: e.src });
      else x.locks.events.push({ ...e, locked: true });
    });
  const cycleChord = (c: Chord) =>
    up((x) => {
      const alts = c.alts.length ? c.alts : [{ root: c.root, q: c.q }];
      const qs = Object.keys(QUALITY_IV) as Quality[];
      const i = alts.findIndex((a) => a.root === c.root && a.q === c.q);
      const next = i >= 0 && i + 1 < alts.length ? alts[i + 1] : i === -1 ? alts[0] : { root: c.root, q: qs[(qs.indexOf(c.q) + 1) % qs.length] };
      x.harmony.chordOverrides[String(Math.round(c.start * 1000) / 1000)] = next;
    });
  const reseed = (k: keyof PartSession["layerSeeds"]) => up((x) => { x.layerSeeds[k] = (x.layerSeeds[k] * 31 + 17) % 1000000007; });

  const shown = !r ? { events: [], dropped: [] } : view === "source" ? { events: r.sourceEvents, dropped: [] } : view === "clean" ? { events: r.cleaned, dropped: r.cleanedDropped } : { events: r.final, dropped: r.variants[r.chosen]?.dropped ?? [] };
  const a = r?.analysis;
  const keyValue = s.harmony.key ? `${s.harmony.key.tonic}:${s.harmony.key.minor ? "m" : "M"}` : "auto";
  const styles = STYLES_FOR[s.mode];

  return (
    <div className="dp">
      <div className="dp-head">
        <b>{s.source.name}</b>
        <Seg<Mode> value={s.mode} onChange={(m) => setMode(s.id, m)} options={(Object.keys(MODE_LABEL) as Mode[]).map((x) => ({ value: x, label: MODE_LABEL[x], tip: "switching mode resets the stage settings" }))} />
        <span className="muted">{(s.source.length / 4).toFixed(2).replace(/\.00$/, "")} bars · {s.source.notes.length} notes · {p.bpm} bpm</span>
        {running || stale ? <span className="dp-status">working (worker)… <button className="link" onClick={() => ppClient.cancel()}>cancel</button></span> : error ? <span className="err">{error === "cancelled" ? "cancelled" : `error: ${error.split("\n")[0]}`} <button className="link" onClick={retry}>run again</button></span> : <span className="muted">{PP_ALGO_VERSION} · {Math.round(ppClient.lastMs)} ms</span>}
        <span className="spacer" />
        <button className="primary" onClick={() => up((x) => { x.clean.on = x.rework.on = x.groove.on = x.sound.on = true; })} data-tip="clean + rework + groove + sound; each stays editable">run all</button>
        <button className="icon" disabled={!st.canUndo} onClick={() => st.undo()} data-tip="undo (⌘Z)">↶</button>
        <button className="icon" disabled={!st.canRedo} onClick={() => st.redo()} data-tip="redo (⇧⌘Z)">↷</button>
        <button onClick={() => resetPart(s.id)} data-tip="reset parameters, decisions and locks (source and applied track stay)">reset</button>
        <button onClick={() => store.setUi({ ppSession: null, selectedClipId: null })}>sessions</button>
        <button onClick={() => deletePart(s.id)} data-tip="delete this session (the applied track stays)">×</button>
      </div>

      <div className="dp-ab">
        <span className="label">listen</span>
        <Seg<AbMode> value={ab.mode} onChange={(m) => setPartMode(m, s, r)} options={[{ value: "off", label: "project" }, { value: "source", label: "A source" }, { value: "result", label: "B result" }]} />
        <label className="dp-check" data-tip="trim the louder side so A/B compares sound, not level"><input type="checkbox" checked={ab.match} onChange={(e) => { ppAudition.set({ match: e.target.checked }); refreshPartAudition(s, r); }} /> match loudness</label>
        <button disabled={!r || ab.measuring} onClick={() => r && measurePart(s, r)}>{ab.measuring ? "measuring…" : "measure"}</button>
        {ab.lufs && <span className="muted">A {ab.lufs.source.toFixed(1)} / B {ab.lufs.result.toFixed(1)} LUFS{ab.trims ? ` · trim ${ab.trims.source ? `A ${db(ab.trims.source)}` : `B ${db(ab.trims.result)}`} dB` : ""}</span>}
        {ab.error && <span className="err">{ab.error}</span>}
        <button onClick={() => store.update((x) => { x.loop = { on: true, start: s.source.start, end: s.source.start + (r?.lengthBeats ?? s.source.length) }; })}>loop region</button>
        <span className="spacer" />
        {s.applied ? (
          <>
            <span className="muted" data-tip={`seed ${s.applied.seed} · ${s.applied.algo}`}>applied {new Date(s.applied.at).toLocaleTimeString()}</span>
            <button className="primary" disabled={!r || stale} onClick={() => r && applyPart(s.id, r)}>update applied</button>
            <button onClick={() => revertPart(s.id)} data-tip="remove the applied track and unmute the source">revert to source</button>
            <button onClick={() => runTask(() => exportStems([s.applied!.trackId]))}>stem…</button>
          </>
        ) : (
          <>
            <label className="dp-check"><input type="checkbox" checked={s.muteSourceOnApply} onChange={(e) => up((x) => { x.muteSourceOnApply = e.target.checked; })} /> mute source</label>
            <button className="primary" disabled={!r || stale || !r.final.length} onClick={() => { if (r) { applyPart(s.id, r); setPartMode("off", s, r); } }}>apply → track</button>
          </>
        )}
      </div>

      <div className="dp-body">
        <div className="dp-steps">
          <details open className="insp-section">
            <summary>1 · harmony {a && <span className="muted" style={{ fontWeight: "normal", fontSize: 11 }}>· {NOTE[a.key.tonic]} {a.key.minor ? "minor" : "major"} ({a.keyFrom}) · chords from {a.chordsFrom}</span>}</summary>
            <div className="dp-row"><span className="k">key</span><Select<string> value={keyValue} width={140} options={KEYS} onChange={(v) => up((x) => { x.harmony.key = v === "auto" ? null : { tonic: +v.split(":")[0], minor: v.endsWith("m") }; })} /></div>
            <div className="dp-row"><span className="k">chords</span><Seg<PartSession["harmony"]["source"]> value={s.harmony.source} onChange={(v) => up((x) => { x.harmony.source = v; x.harmony.chordOverrides = {}; })} options={[{ value: "auto", label: "auto", tip: "the project's chord track when it covers the region, else the notes" }, { value: "project", label: "project", tip: "chord track from the song analysis" }, { value: "notes", label: "from notes" }]} /></div>
            {r && <div className="dp-note">{r.chords.map((c) => chordName(c.root, c.q)).join(" · ") || "no chords"}</div>}
            <div className="dp-note">click a chord above the notes to cycle alternatives{Object.keys(s.harmony.chordOverrides).length > 0 && <> · <button className="link" onClick={() => up((x) => { x.harmony.chordOverrides = {}; })}>reset chord edits</button></>}</div>
          </details>

          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.clean.on} onChange={(e) => up((x) => { x.clean.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 2 · clean</summary>
            <Sl label="quantize" value={s.clean.strength} tip="soft-quantize strength; notes struck together move together" onChange={(v) => up((x) => { x.clean.strength = v; })} />
            <div className="dp-row"><span className="k">grid</span><Seg<GridChoice> value={s.clean.grid} onChange={(v) => up((x) => { x.clean.grid = v; })} options={[{ value: "auto", label: "auto" }, { value: "straight", label: "1/16" }, { value: "triplet", label: "triplet" }, { value: "mixed", label: "per beat" }]} /></div>
            {a && <div className={`dp-note ${a.grid.decision === "ambiguous" ? "warn" : ""}`}>detected: <b>{a.grid.decision}</b> — {a.grid.note}</div>}
            {a?.strum && a.strum.hits > 0 && (
              <div className="dp-note">
                {a.strum.strummed >= 0.3
                  ? <>strummed: <b>{Math.round(a.strum.strummed * 100)}%</b> of {a.strum.hits} chords · {Math.round(a.strum.down * 100)}% down / {Math.round(a.strum.up * 100)}% up · ~{a.strum.spreadMs} ms spread — strums move as one event</>
                  : <>block chords ({a.strum.hits}): no clear strumming detected</>}
              </div>
            )}
            {a?.warnings.map((w) => <div key={w} className="dp-note warn">{w}</div>)}
            {r && s.clean.on && <div className="muted">{r.proposals.filter((x) => x.accepted).length}/{r.proposals.length} proposals on · {r.cleanedDropped.length} removed {Object.keys(s.clean.decisions).length > 0 && <button className="link" onClick={() => up((x) => { x.clean.decisions = {}; })}>reset decisions</button>}</div>}
          </details>

          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.rework.on} onChange={(e) => up((x) => { x.rework.on = e.target.checked; if (e.target.checked) x.groove.on = true; })} onClick={(e) => e.stopPropagation()} /> 3 · rework</summary>
            <div className="dp-row wrap"><span className="k">style</span><Seg<Style> value={s.rework.style} onChange={(v) => up((x) => { x.rework.style = v; })} options={styles.map((x) => ({ value: x.id, label: x.label, tip: x.desc }))} /></div>
            <div className="dp-note">{styles.find((x) => x.id === s.rework.style)?.desc}</div>
            <Sl label="preserve" value={s.rework.preserve} tip="how much of the source (rhythm, top line, voicings) is kept" onChange={(v) => up((x) => { x.rework.preserve = v; })} />
            <div className="dp-row"><span className="k">length</span><Seg<string> value={String(s.rework.length)} onChange={(v) => up((x) => { x.rework.length = v === "source" ? "source" : (+v as 8 | 16); })} options={[{ value: "source", label: "as source" }, { value: "8", label: "8 bars", tip: "explicitly extend by repeating the source" }, { value: "16", label: "16 bars", tip: "explicitly extend by repeating the source" }]} /></div>
            {s.rework.on && r && r.variants.length === 3 && (
              <div className="dp-variants">
                {r.variants.map((v, i) => (
                  <button key={v.name} className={`dp-var ${s.rework.variant === i ? "on" : ""}`} onClick={() => up((x) => { x.rework.variant = i as 0 | 1 | 2; })}>
                    <b>{v.name}</b>
                    <small>{v.stats.notes} notes{v.stats.pattern ? ` · ${v.stats.pattern}` : ""}</small>
                    <small>{v.stats.kept} kept · {v.stats.generated} new · {v.stats.changed} changed</small>
                  </button>
                ))}
              </div>
            )}
            {s.rework.on && (
              <>
                <div className="dp-row wrap">
                  <span className="k">regenerate</span>
                  <button onClick={() => reseed("rhythm")} data-tip="new rhythm pattern / arp order only">↻ rhythm</button>
                  {(s.mode === "keys" || s.mode === "guitar") && <button onClick={() => reseed("voicing")} data-tip="new voicings / guitar shapes only">↻ voicing</button>}
                  {s.mode !== "line" && <button onClick={() => reseed("phrase")} data-tip="new phrase-end variations only">↻ phrase</button>}
                </div>
                <div className="dp-row">
                  <span className="k">seed</span>
                  <NumberField value={s.seed} min={1} max={999999999} width={90} onCommit={(v) => up((x) => { x.seed = Math.round(v); x.layerSeeds = { rhythm: x.seed * 97 + 1, voicing: x.seed * 97 + 2, phrase: x.seed * 97 + 3 }; })} />
                  <button onClick={() => up((x) => { x.seed = 1 + Math.floor(Math.random() * 999999); x.layerSeeds = { rhythm: x.seed * 97 + 1, voicing: x.seed * 97 + 2, phrase: x.seed * 97 + 3 }; })}>new seed</button>
                </div>
              </>
            )}
          </details>

          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.groove.on} onChange={(e) => up((x) => { x.groove.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 4 · groove</summary>
            <Sl label="swing" value={s.groove.swing} fmt={(v) => `${Math.round(50 + v * 25)}%`} tip="16th swing" onChange={(v) => up((x) => { x.groove.swing = v; })} />
            <Sl label="accents" value={s.groove.accent} tip="velocity contrast by beat position" onChange={(v) => up((x) => { x.groove.accent = v; })} />
            <Sl label="feel" value={s.groove.feel} tip={s.mode === "line" ? "how far the line sits behind the beat, + one small drift per bar" : "one small timing drift per bar"} onChange={(v) => up((x) => { x.groove.feel = v; })} />
            {s.mode === "keys" && <Sl label="chord roll" value={s.groove.spread} tip="spread chord notes low → high (0–22 ms per note)" onChange={(v) => up((x) => { x.groove.spread = v; })} />}
            {s.mode !== "line" && <Sl label="variation" value={s.groove.variation} tip="how often phrase ends get a push / fill (never on every repeat)" onChange={(v) => up((x) => { x.groove.variation = v; })} />}
          </details>

          <details open className="insp-section">
            <summary><input type="checkbox" checked={s.sound.on} onChange={(e) => up((x) => { x.sound.on = e.target.checked; })} onClick={(e) => e.stopPropagation()} /> 5 · sound</summary>
            <div className="dp-row">
              <span className="k">sound</span>
              <Select<string> value={snd.instrument} width={170} options={PITCHED.map((i) => ({ value: i.id, label: i.name, hint: i.category.toLowerCase() }))} onChange={(v) => setSound((x) => { x.instrument = v; })} />
              <label className="dp-check" data-tip="pick sound + processing from mode and style automatically"><input type="checkbox" checked={s.sound.auto} onChange={(e) => up((x) => { if (!e.target.checked && r) { x.sound.instrument = r.sound.instrument; x.sound.proc = structuredClone(r.sound.proc); } x.sound.auto = e.target.checked; })} /> auto</label>
            </div>
            {s.sound.auto && r?.sound.notes.map((n) => <div key={n} className="dp-note">{n}</div>)}
            <Sl label="fader" value={snd.proc.level} min={-24} max={6} step={0.5} fmt={(v) => `${db(v)} dB`} onChange={(v) => setSound((x) => { x.proc.level = v; })} />
            <div className="dp-row wrap small" style={{ justifyContent: "flex-start" }}>
              <label className="dp-check" data-tip={`hpf ${snd.proc.eq.hpf} Hz · low ${db(snd.proc.eq.low)} · high ${db(snd.proc.eq.high)} dB${snd.proc.eq.lpf ? ` · lpf ${snd.proc.eq.lpf} Hz` : ""}`}><input type="checkbox" checked={snd.proc.eq.on} onChange={(e) => setSound((x) => { x.proc.eq.on = e.target.checked; })} /> eq</label>
              <label className="dp-check" data-tip={`compressor ${snd.proc.comp.threshold} dB · ${snd.proc.comp.ratio}:1`}><input type="checkbox" checked={snd.proc.comp.on} onChange={(e) => setSound((x) => { x.proc.comp.on = e.target.checked; })} /> comp</label>
              <label className="dp-check" data-tip={`tempo delay · mix ${snd.proc.delay.mix}%`}><input type="checkbox" checked={snd.proc.delay.on} onChange={(e) => setSound((x) => { x.proc.delay.on = e.target.checked; })} /> delay</label>
              <label className="dp-check" data-tip={`reverb send ${Math.round(snd.proc.send.amount * 100)}%`}><input type="checkbox" checked={snd.proc.send.on} onChange={(e) => setSound((x) => { x.proc.send.on = e.target.checked; })} /> verb</label>
            </div>
            <div className="dp-note">no limiter is added; leaves headroom for the mix.</div>
          </details>
        </div>

        <div className="dp-main">
          <div className="dp-viewbar">
            <Seg<View> value={view} onChange={setView} options={[{ value: "source", label: "source" }, { value: "clean", label: "cleaned" }, { value: "result", label: s.rework.on ? `result · ${["close", "moderate", "free"][s.rework.variant]}` : "result" }]} />
            <span className="dp-legend">
              {(["source", "moved", "edited", "added", "generated", "fill", "dropped"] as const).map((k) => <span key={k}><i style={{ background: PP_COLOR[k] }} />{k === "dropped" ? "removed" : k}</span>)}
              <span><i className="lk" />locked</span>
            </span>
          </div>
          <div className="dp-hover">
            {hover ? (
              <>
                <b>{pitchName(hover.e.pitch)}</b> · {hover.dropped ? "removed" : hover.e.origin} · {formatPos(hover.e.start)} · {Math.round(hover.e.dur * 100) / 100} beats · vel {Math.round(hover.e.vel)}
                {!hover.dropped && Math.abs(hover.e.micro) > 1e-4 && ` · ${hover.e.micro > 0 ? "+" : ""}${Math.round(hover.e.micro * (60 / p.bpm) * 1000)} ms`}
                {hover.e.string !== undefined && ` · string ${6 - hover.e.string}, fret ${hover.e.pitch - TUNING[hover.e.string]}`}
                {hover.e.src && (hover.e.src.pitch !== hover.e.pitch || Math.abs(hover.e.src.start - hover.e.start) > 1e-3) && ` · was ${pitchName(hover.e.src.pitch)} @ ${formatPos(hover.e.src.start)}`}
                {hover.e.conf !== undefined && ` · confidence ${hover.e.conf.toFixed(2)} (from source)`}
                {hover.e.tags?.length ? ` · ${hover.e.tags.join(", ")}` : ""}
                {lockedIds.has(hover.e.id) || hover.e.locked ? " · locked" : " · click to lock"}
              </>
            ) : (
              <span className="muted">click a note to lock it (it won't change in any stage) · click a chord to change it</span>
            )}
          </div>
          {r ? (
            <PartGrid events={shown.events} dropped={shown.dropped} chords={r.chords} lengthBeats={view === "result" ? r.lengthBeats : s.source.length} regionStart={s.source.start} lockedIds={lockedIds} highlight={highlight} onEvent={toggleLock} onChord={cycleChord} onHover={(e, d) => setHover(e ? { e, dropped: d } : null)} />
          ) : (
            <div className="hint">{error ? "no result" : "analysing…"}</div>
          )}
          {r && s.clean.on && r.proposals.length > 0 && (
            <div className="dp-props">
              <div className="dp-props-head">cleanup proposals <span className="muted">· heuristic scores, not probabilities · uncheck to keep the original</span></div>
              {r.proposals.map((pp: Proposal) => (
                <label key={pp.id} className={`dp-prop ${pp.accepted ? "" : "off"}`} onMouseEnter={() => setHighlight(new Set(pp.eventIds))} onMouseLeave={() => setHighlight(new Set())}>
                  <input type="checkbox" checked={pp.accepted} onChange={() => up((x) => { x.clean.decisions[pp.id] = !pp.accepted; })} />
                  <span className={`chip ${pp.kind === "merge" || pp.kind === "trim" || pp.kind === "octave" || pp.kind === "pitch" ? "velocity" : pp.kind}`}>{pp.kind}</span>
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
