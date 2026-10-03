import { songHarmony } from "../../model/songHarmony";
import { generatePart, PART_KINDS } from "../../assist/parts";
import { resetLatch } from "../../edit/automation";
import { saveProjectToDisk } from "../../io/projectFile";
import { useEffect, useRef, useState } from "react";
import { autoArrange, STYLE_INFO, type ArrangeStyle } from "../../assist/arrange/arrange";
import { convertToMidi } from "../../assist/convert";
import { MUSCRIPTOR_SIZES, type MuscriptorModel } from "../../ml/muscriptor";
import { autoMix } from "../../assist/mix";
import { ensureHarmonyAudio, splitStems } from "../../assist/separate";
import { cleanAudio } from "../../assist/clean";
import { DEMUCS_MODEL_MB } from "../../ml/demucs";
import { live, toggleTyping } from "../../engine/liveInput";
import { engine } from "../../engine/transport";
import { isRecording, toggleRecording } from "../../engine/recorder";
import { exportMidi, exportStems, exportWav } from "../../io/export";
import { clearSession } from "../../io/persist";
import { retempo } from "../../edit/ops";
import { store, useStore } from "../../model/store";
import { NOTE_NAMES } from "../../model/types";
import { formatPos, formatTime } from "../common/format";
import NumberField from "../common/NumberField";
import { confirmDialog } from "../common/Dialog";
import { runTask } from "../common/runTask";
import { openFileWith } from "./shortcuts";

/** Big transport LCD (bars.beats.ticks + clock), updated per animation frame without React renders. */
function Lcd() {
  const pos = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (pos.current) pos.current.textContent = formatPos(engine.beat);
      if (clock.current) clock.current.textContent = formatTime(engine.beat * engine.spb);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="lcd-cell">
      <span className="lcd-big" ref={pos} />
      <span className="lcd-small" ref={clock} />
    </div>
  );
}

type Menu = "file" | "midi" | "clean" | "produce" | "arrange" | null;

/** Last audio track the user selected (module scope: survives re-renders, not reloads). */
let lastAudioId: string | null = null;

export default function ControlBar() {
  const s = useStore();
  const p = s.project;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [style, setStyle] = useState<ArrangeStyle>("remix");
  const hasAudio = p.tracks.some((t) => t.role === "mix");
  const sel = p.tracks.find((t) => t.id === s.ui.selectedTrackId);
  // The audio track the assist buttons work on: the selected one, else the audio track selected
  // last (so after "to midi" selects the new MIDI track, midi ▾ still means that stem). The full
  // mix is only the default before there are stems — never a silent fallback.
  if (sel?.kind === "audio") lastAudioId = sel.id;
  const hasStemTracks = p.tracks.some((t) => t.kind === "audio" && t.role !== "mix");
  // stems: the selected audio track, else the full mix (you split the song, not the last stem)
  const splitSel = sel?.kind === "audio" ? sel : p.tracks.find((t) => t.role === "mix");
  const audioSel = sel?.kind === "audio" ? sel : p.tracks.find((t) => t.id === lastAudioId && t.kind === "audio") ?? (hasStemTracks ? undefined : p.tracks.find((t) => t.role === "mix"));
  const hasStems = p.tracks.some((t) => t.kind === "audio" && t.role !== "mix");
  const analyzed = p.sections.length > 0;
  const midiClip = sel?.clips.find((c) => c.id === s.ui.selectedClipId && c.kind === "midi");
  const openProduce = (tab: "piano" | "drums" | "parts") => { setMenu(null); store.setUi({ showEditor: true, editorTab: tab }); };
  const busy = !!s.ui.busy;
  const toggle = (m: Menu) => setMenu(menu === m ? null : m);

  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".rel") && setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  return (
    <header className="controlbar">
      <div className="cb-left">
        <span className="brand"><img src="/icon.svg" alt="" width={20} height={20} />Otpadn</span>
        <input ref={fileRef} type="file" accept="audio/*,.otpadn" hidden onChange={(e) => e.target.files?.[0] && openFileWith(e.target.files[0])} />
        <div className="rel">
          <button onClick={() => toggle("file")}>file ▾</button>
          {menu === "file" && (
            <div className="popover menu">
              <button onClick={() => { setMenu(null); void (async () => { if (!p.tracks.length || (await confirmDialog({ title: "start a new project?", body: "the current session will be discarded. export anything you want to keep first.", ok: "discard & start new", danger: true }))) runTask(clearSession); })(); }} disabled={busy}>new project</button>
              <button onClick={() => { setMenu(null); fileRef.current?.click(); }} disabled={busy}>open project / import audio… <kbd>⌘O</kbd></button>
              <button onClick={() => { setMenu(null); runTask(saveProjectToDisk); }} disabled={!p.tracks.length || busy}>save project to disk… <kbd>⌘S</kbd></button>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(null); runTask(exportWav); }} disabled={!p.tracks.length || busy}>bounce mix to wav… <kbd>⌘B</kbd></button>
              <button onClick={() => { setMenu(null); runTask(() => exportStems()); }} disabled={!p.tracks.length || busy}>bounce stems (one wav per track)…</button>
              <button onClick={() => { setMenu(null); runTask(exportMidi); }} disabled={!p.tracks.some((t) => t.kind === "midi") || busy}>export midi…</button>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(null); window.open("/about", "_blank", "noopener"); }}>about otpadn ↗</button>
              <button onClick={() => { setMenu(null); void confirmDialog({ title: "credits & licences", body: "audio → midi model: MuScriptor by Kyutai & Mirelo — weights licensed CC BY-NC 4.0 (non-commercial use only). stem separation: HTDemucs (MIT). airwindows ButterComp2 / Density2 / Galactic / ClipOnly2 ports: MIT © Chris Johnson. acoustic drum samples: Virtuosity Drums (CC0). everything else: Otpadn's own code.", ok: "close" }); }}>credits &amp; licences…</button>
              <div className="menu-title" style={{ borderTop: "1px solid var(--line-2)", borderBottom: 0, marginTop: 2 }}>autosaved in this browser · ⌘S saves a .otpadn file with all audio</div>
            </div>
          )}
        </div>
        <button className="icon" disabled={!s.canUndo} onClick={() => s.undo()} data-tip="undo (⌘Z)">↶</button>
        <button className="icon" disabled={!s.canRedo} onClick={() => s.redo()} data-tip="redo (⇧⌘Z)">↷</button>
        <div className="cb-group" data-label="assist">
          <button className={hasAudio && !hasStems ? "primary" : ""} disabled={!splitSel || busy} onClick={() => splitSel && runTask(() => splitStems(splitSel.id, "ai"))} data-tip={`1 · split ${splitSel ? `"${splitSel.name}"` : "the selected audio track"} into 6 stems (demucs ai · drums · bass · vocals · guitar · piano · other · gpu · ${DEMUCS_MODEL_MB} mb once)${splitSel?.role === "mix" && !analyzed ? " · also finds tempo, key, sections, chords" : ""}`}>stems</button>
          <div className="rel">
            <button disabled={!audioSel || busy} onClick={() => toggle("clean")} data-tip="2 · remove noise and room from the selected audio track (one-time, undoable)">clean ▾</button>
            {menu === "clean" && audioSel && (
              <div className="popover menu">
                <div className="menu-title">dereverb + denoise “{audioSel.name}” · dpdfnet, one pass</div>
                {[1, 0.7, 0.5].map((m) => (
                  <button key={m} onClick={() => { setMenu(null); runTask(() => cleanAudio(audioSel.id, m)); }}>
                    <span>{m === 1 ? "full ★" : m === 0.7 ? "strong" : "gentle"}</span>
                    <small>{Math.round(m * 100)}% processed · best on vocals / speech · {m === 1 ? "15 mb model once" : "blended with the original"}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="rel">
            <button disabled={!audioSel || busy} onClick={() => toggle("midi")} data-tip="3 · transcribe the selected audio track to midi (gpu)">midi ▾</button>
            {menu === "midi" && audioSel && (
              <div className="popover menu">
                <div className="menu-title">“{audioSel.name}”{audioSel.role !== "mix" ? ` (${audioSel.role} stem)` : " (full mix)"} → {audioSel.role !== "mix" ? `midi · ${audioSel.role} instruments only` : "one midi track per instrument"}</div>
                {(Object.keys(MUSCRIPTOR_SIZES) as MuscriptorModel[]).map((m) => (
                  <button key={m} onClick={() => { setMenu(null); runTask(() => convertToMidi(audioSel.id, { model: m })); }}>
                    <span>{MUSCRIPTOR_SIZES[m].label} model{m === "small" ? " ★" : ""}</span>
                    <small>{audioSel.role !== "mix" ? "only this stem's instrument · " : "all instruments + vocals · "}~{MUSCRIPTOR_SIZES[m].mb} mb once</small>
                  </button>
                ))}
                {audioSel.role !== "mix" && (
                  <button onClick={() => { setMenu(null); runTask(() => convertToMidi(audioSel.id, { restrict: false })); }}>
                    <span>any instrument</span>
                    <small>don't restrict to the stem's family</small>
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="rel">
            <button disabled={!p.tracks.length || busy} onClick={() => toggle("produce")} data-tip="4 · rework the selected midi region, or generate new parts from the song's chords">produce ▾</button>
            {menu === "produce" && (
              <div className="popover menu">
                {midiClip && (
                  <>
                    <div className="menu-title">“{sel!.name}” · selected midi region</div>
                    <button onClick={() => openProduce("piano")}><span>piano roll</span><small>edit notes <kbd>P</kbd></small></button>
                    <button onClick={() => openProduce("drums")}><span>drum producer</span><small>clean · rework (house / techno) · groove · kit</small></button>
                    <button onClick={() => openProduce("parts")}><span>part producer</span><small>keys · vocal / lead line · guitar</small></button>
                  </>
                )}
                <div className="menu-title" style={midiClip ? { borderTop: "1px solid var(--line-2)", marginTop: 2 } : undefined}>generate a new part · from the song's chords</div>
                {PART_KINDS.map((k) => (
                  <button key={k.id} onClick={() => { setMenu(null); runTask(async () => { await ensureHarmonyAudio(); generatePart(k.id); }); }}><span>{k.label}</span><small>{k.hint}</small></button>
                ))}
              </div>
            )}
          </div>
          <div className="rel">
            <button disabled={!analyzed || busy} onClick={() => toggle("arrange")} data-tip="5 · build a section-aware arrangement from stems, midi conversions and generated parts">arrange ▾</button>
            {menu === "arrange" && (
              <div className="popover">
                {(Object.keys(STYLE_INFO) as ArrangeStyle[]).map((k) => (
                  <label key={k} style={{ alignItems: "flex-start" }}>
                    <input type="radio" name="style" checked={style === k} onChange={() => setStyle(k)} />
                    <span><b>{k}</b><div className="desc">{STYLE_INFO[k]}</div></span>
                  </label>
                ))}
                <button className="primary" onClick={() => { setMenu(null); runTask(() => autoArrange(style)); }}>arrange</button>
              </div>
            )}
          </div>
          <button disabled={!p.tracks.length || busy} onClick={() => runTask(autoMix)} data-tip="6 · auto-mix: match loudness by role, set pan / eq / comp / reverb, master to ≈ −14 lufs">mix</button>
        </div>
      </div>

      <div className="cb-center">
        <div className="transport">
          <button className="icon" data-tip="go to start (return)" onClick={() => engine.seek(p.loop.on ? p.loop.start : 0)}>⏮</button>
          <button className="icon" data-tip="back one bar (,)" onClick={() => engine.seek(Math.floor(engine.beat / 4) * 4 - 4)}>«</button>
          <button className={`icon play ${engine.playing ? "on" : ""}`} data-tip="play / stop (space)" onClick={() => (engine.playing ? engine.stop() : engine.play())}>{engine.playing ? "■" : "▶"}</button>
          <button className={`icon rec ${isRecording() ? "on" : ""}`} data-tip={isRecording() ? "stop recording (R)" : `record on ${s.project.tracks.find((t) => t.id === s.ui.armedTrackId)?.name ?? "a new audio track"} · ${engine.countInBars ? `${engine.countInBars}-bar count-in` : "no count-in"} (R)`} onClick={() => runTask(toggleRecording)}>●</button>
          <button className="icon" data-tip="forward one bar (.)" onClick={() => engine.seek(Math.floor(engine.beat / 4) * 4 + 4)}>»</button>
          <button className={`icon ${engine.metronome ? "on" : ""}`} data-tip="metronome click (K)" onClick={() => { engine.metronome = !engine.metronome; store.setUi({}); }}>♩</button>
          <button className={`icon auto ${s.ui.showAutomation ? "on" : ""}`} data-tip="automation view (A): draw volume / pan / sends / plug-in curves on the tracks" onClick={() => store.setUi({ showAutomation: !s.ui.showAutomation })}>A</button>
          <button className={`icon wr ${s.ui.autoWrite ? "on" : ""}`} data-tip="latch write: moving a fader, knob or plug-in control while playing records automation" onClick={() => { resetLatch(); store.setUi({ autoWrite: !s.ui.autoWrite }); }}>W</button>
          <button className={`icon ${engine.countInBars ? "on" : ""}`} data-tip="count-in before recording (1 bar)" onClick={() => { engine.countInBars = engine.countInBars ? 0 : 1; store.setUi({}); }}>1·2·</button>
          <button className={`icon ${p.loop.on ? "on" : ""}`} data-tip="cycle (c) · shift-drag the ruler to set" onClick={() => store.update((x) => (x.loop.on = !x.loop.on))}>⟲</button>
        </div>
        <div className="lcd">
          <Lcd />
          <div className="lcd-cell">
            <NumberField value={p.bpm} min={30} max={300} step={0.5} width={56} data-tip="tempo (↑/↓ to nudge)" onCommit={(v) => store.update((x) => retempo(x, v))} />
            <span className="lcd-small">tempo</span>
          </div>
          <div className="lcd-cell">
            <span className="lcd-mid">4/4</span>
            <span className="lcd-small">{(() => {
              // the harmony layer's key (real parts + the mix), else the audio analysis
              const hm = songHarmony();
              if (hm) return `${NOTE_NAMES[hm.key.tonic]} ${hm.mode === "major" ? "maj" : hm.mode === "minor" ? "min" : hm.mode}`;
              return p.key ? `${NOTE_NAMES[p.key.tonic]} ${p.key.minor ? "min" : "maj"}` : "key —";
            })()}</span>
          </div>
        </div>
      </div>

      <div className="cb-right">
        <button className={live.typing ? "on" : ""} onClick={toggleTyping} data-tip={`musical typing (caps lock) · plays the selected instrument track · a–l keys, z/x octave (${live.octave}), c/v velocity (${live.velocity})${live.midiDevices.length ? " · midi: " + live.midiDevices.join(", ") : ""}`}>⌨{live.typing ? ` c${live.octave}` : ""}</button>
        <button className={s.ui.showInspector ? "on" : ""} data-tip="inspector (I)" onClick={() => store.setUi({ showInspector: !s.ui.showInspector })}>i</button>
        <button className={s.ui.showLibrary ? "on" : ""} data-tip="library (Y)" onClick={() => store.setUi({ showLibrary: !s.ui.showLibrary })}>lib</button>
        <button className={s.ui.showEditor && s.ui.editorTab === "mixer" ? "on" : ""} data-tip="mixer (X)" onClick={() => store.setUi(s.ui.showEditor && s.ui.editorTab === "mixer" ? { showEditor: false } : { showEditor: true, editorTab: "mixer" })}>mix</button>
        <button className={s.ui.showEditor && s.ui.editorTab === "piano" ? "on" : ""} data-tip="piano roll (P)" onClick={() => store.setUi(s.ui.showEditor && s.ui.editorTab === "piano" ? { showEditor: false } : { showEditor: true, editorTab: "piano" })}>roll</button>
      </div>
    </header>
  );
}
