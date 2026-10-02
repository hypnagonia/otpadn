/** Live playback: transport, lookahead note scheduler, mixer reconciliation. Singleton `engine`. */
import { createInstrument } from "../instruments/factory";
import { latencyHint } from "./audioPrefs";
import type { Playable } from "../instruments/types";
import { store } from "../model/store";
import type { Track } from "../model/types";
import { createMaster, createStrip, type Master, type Strip } from "./graph";
import { forNotes, frozenAsAudio, isAudible, isFrozen, kitLayersOf, scheduleAudio } from "./schedule";
import { holdLane, isPluginLane, lanesOf, pluginAutomation, scheduleLane } from "./automation";

const LOOKAHEAD_SEC = 0.2;
const TICK_MS = 25;

/**
 * Temporary listening overlay (Drum Producer A/B): preview tracks that are not part of the
 * project play on the same transport and scheduler; some tracks can be silenced, forced
 * audible, or trimmed (loudness compensation) without touching the project or its undo history.
 */
export interface Audition {
  tracks: Track[];
  mute: Set<string>;
  /** Heard even if muted in the project (e.g. the source after it was replaced). */
  unmute: Set<string>;
  trimDb: Map<string, number>;
}

export class Engine {
  ctx = new AudioContext({ latencyHint: latencyHint() });
  master: Master = createMaster(this.ctx);
  strips = new Map<string, Strip>();
  insts = new Map<string, { id: string; p: Playable }>();
  playing = false;
  /** Timeline anchor: `startBeat` sounds at context time `startCtx`. */
  private startCtx = 0;
  private startBeat = 0;
  /** Previous anchor, still valid until the scheduled loop wrap is reached. */
  private prevAnchor: { ctx: number; beat: number; until: number } | null = null;
  private scheduledTo = 0;
  private sources: AudioScheduledSourceNode[] = [];
  private timer: number | null = null;
  private pausedBeat = 0;
  private syncedVersion = -1;
  private loopSig = "";
  private chSig = new Map<string, string>();
  private insSig = new Map<string, string>();
  private bpm = store.project.bpm;
  audition: Audition | null = null;
  private auditionVersion = 0;
  private syncedAudition = -1;

  constructor() {
    store.subscribe(() => this.sync());
    this.sync();
  }

  get spb() {
    return 60 / this.bpm;
  }

  get beat(): number {
    if (!this.playing) return this.pausedBeat;
    const now = this.ctx.currentTime;
    const a = this.prevAnchor;
    if (a && now < a.until) return a.beat + (now - a.ctx) / this.spb;
    return this.startBeat + (now - this.startCtx) / this.spb;
  }

  /** Start / update / end an audition overlay (null ends it). */
  setAudition(a: Audition | null) {
    this.audition = a;
    this.auditionVersion++;
    this.sync();
  }

  /** Project tracks plus any audition preview tracks. */
  private tracks(): Track[] {
    return this.audition ? [...store.project.tracks, ...this.audition.tracks] : store.project.tracks;
  }

  /** Reconcile strips/instruments with the project; only runs when the project (or audition) changed. */
  sync() {
    if (store.projectVersion === this.syncedVersion && this.auditionVersion === this.syncedAudition) return;
    this.syncedVersion = store.projectVersion;
    this.syncedAudition = this.auditionVersion;
    const p = store.project;
    // Loop region changed while playing: audio clips were scheduled against the old loop → reschedule.
    const loopSig = `${p.loop.on}|${p.loop.start}|${p.loop.end}`;
    if (loopSig !== this.loopSig) {
      const changed = this.loopSig !== "";
      this.loopSig = loopSig;
      if (changed && this.playing) queueMicrotask(() => this.playing && this.play(this.beat));
    }
    if (p.bpm !== this.bpm) {
      // Re-anchor so the playhead doesn't jump when tempo changes mid-playback.
      const at = this.beat;
      this.bpm = p.bpm;
      if (this.playing) this.play(at);
      else this.pausedBeat = at;
    }
    const all = this.tracks();
    const audibleOf = new Map<string, boolean>();
    const au = this.audition;
    const previewIds = new Set(au?.tracks.map((t) => t.id));
    const ids = new Set(all.map((t) => t.id));
    for (const [id, s] of this.strips)
      if (!ids.has(id)) {
        s.dispose();
        this.strips.delete(id);
        this.chSig.delete(id);
        this.insSig.delete(id);
        this.autoSig.delete(id);
        this.insts.get(id)?.p.dispose();
        this.insts.delete(id);
      }
    for (const t of all) {
      let s = this.strips.get(t.id);
      // Aux outputs (kit mics) sum into their owner's strip, which acts as the drum bus.
      const busIn = t.kind === "aux" ? this.strips.get(t.auxOf!)?.input : undefined;
      if (!s) this.strips.set(t.id, (s = createStrip(this.ctx, busIn ?? this.master.input, this.master.reverbIn)));
      let audible = previewIds.has(t.id) ? !t.ch.mute : isAudible(p, t);
      if (au?.unmute.has(t.id)) audible = true;
      if (au?.mute.has(t.id)) audible = false;
      const trim = au?.trimDb.get(t.id) ?? 0;
      const auto = lanesOf(t).filter((l) => !isPluginLane(l.param)).map((l) => l.param);
      s.setAutomated(new Set(auto));
      const chSig = `${audible}|${trim}|${auto.join(",")}|${JSON.stringify(t.ch)}`;
      if (this.chSig.get(t.id) !== chSig) {
        this.chSig.set(t.id, chSig);
        s.apply(trim ? { ...t.ch, volumeDb: t.ch.volumeDb + trim } : t.ch, audible);
      }
      audibleOf.set(t.id, audible);
      s.setFrozen(!!t.frozen);
      if (t.frozen) {
        // Frozen: the render plays instead — release the instrument (samples, voices, CPU).
        const cur = this.insts.get(t.id);
        if (cur) {
          cur.p.dispose();
          this.insts.delete(t.id);
        }
      } else if (t.kind === "midi" && t.instrument) {
        const cur = this.insts.get(t.id);
        // Lazy: muted tracks don't download samples until they're heard.
        if (cur ? cur.id !== t.instrument : audible) {
          cur?.p.dispose();
          this.loadInstrument(t.id, t.instrument, s.input, true);
        }
        if (t.drumKit) this.insts.get(t.id)?.p.configure?.(t.drumKit);
        this.insts.get(t.id)?.p.setLayers?.(kitLayersOf(t));
        this.insts.get(t.id)?.p.setCymbalBleed?.(t.kitCymbalBleed ?? 0);
      }
    }
    // Second pass (every strip exists now): inserts with sidechain sources, and sends to buses.
    const sidechainOf = (id: string) => this.strips.get(id)?.postFader;
    const busInput = (id: string) => (all.find((b) => b.id === id)?.kind === "bus" ? this.strips.get(id)?.input : undefined);
    for (const t of all) {
      const s = this.strips.get(t.id);
      if (!s) continue;
      // Only touch the insert chain / sends when they (or what they connect to) changed.
      // Frozen tracks (and a frozen kit's mics) run no plug-ins: they're baked into the render.
      const frozenHere = isFrozen(p, t);
      const insSig = `${p.bpm}|${all.length}|${frozenHere}|${JSON.stringify(t.inserts ?? [])}`;
      if (this.insSig.get(t.id) !== insSig) {
        this.insSig.set(t.id, insSig);
        s.setInserts(frozenHere ? [] : t.inserts ?? [], p.bpm, sidechainOf);
      }
      s.setSends(t.kind === "bus" ? [] : t.ch.sends, busInput, audibleOf.get(t.id) ?? true);
    }
    // Verb knobs → the reverb return channel (if the project has one), else the built-in reverb.
    const rr = all.find((t) => t.reverbReturn);
    const rrIn = rr ? this.strips.get(rr.id)?.input : undefined;
    for (const [id, s] of this.strips) s.setReverbTarget(rrIn && id !== rr!.id ? rrIn : this.master.reverbIn);
    // Multi-out instruments → their aux tracks' strips.
    for (const t of all) {
      const inst = this.insts.get(t.id)?.p;
      const own = this.strips.get(t.id);
      if (!inst?.setOutputs || !own) continue;
      const dests: Record<string, AudioNode> = {};
      for (const a of all) if (a.kind === "aux" && a.auxOf === t.id && a.auxOut) {
        const st = this.strips.get(a.id);
        if (st) dests[a.auxOut] = st.input;
      }
      inst.setOutputs(dests, own.input);
    }
    this.master.apply(p.masterDb);
    this.master.inserts.apply(p.masterInserts ?? [], p.bpm);
    // Automation edited (or a strip rebuilt): reschedule from now while playing, else hold.
    for (const t of all) {
      const sig = JSON.stringify(lanesOf(t)) + (this.strips.get(t.id) ? "" : "-");
      if (this.autoSig.get(t.id) === sig) continue;
      this.autoSig.set(t.id, sig);
      if (this.playing) this.scheduleAutomation(t, Math.max(this.beat, this.startBeat), this.ctx.currentTime + 0.01);
      else this.holdAutomation(t, this.pausedBeat);
    }
  }

  /* ── automation (engine/automation.ts) ── */
  private autoSig = new Map<string, string>();
  private pluginLast = new Map<string, string>();
  private autoEnd(p = store.project) {
    return p.loop.on && p.loop.end > p.loop.start && this.beat < p.loop.end ? p.loop.end : Math.max(p.lengthBeats, this.beat + 16);
  }
  /** Curves from `fromBeat` (at context time t0) onward. */
  private scheduleAutomation(t: Track, fromBeat: number, t0: number) {
    const s = this.strips.get(t.id);
    if (!s) return;
    for (const l of lanesOf(t)) if (!isPluginLane(l.param)) scheduleLane(l, s.autoTargets(l.param), fromBeat, this.autoEnd(), t0, this.spb);
    this.pluginLast.delete(t.id);
  }
  private holdAutomation(t: Track, beat: number) {
    const s = this.strips.get(t.id);
    if (!s) return;
    for (const l of lanesOf(t)) if (!isPluginLane(l.param)) holdLane(l, s.autoTargets(l.param), beat, this.ctx.currentTime);
    this.applyPluginAutomation(t, beat);
  }
  /** Plug-in parameters at control rate (scheduler tick); only sends changed values. */
  private applyPluginAutomation(t: Track, beat: number) {
    const s = this.strips.get(t.id);
    if (!s) return;
    for (const [id, vals] of pluginAutomation(t, beat)) {
      const ins = t.inserts.find((i) => i.id === id);
      if (!ins?.on) continue;
      const key = `${t.id}:${id}`, sig = JSON.stringify(vals);
      if (this.pluginLast.get(key) === sig) continue;
      this.pluginLast.set(key, sig);
      s.inserts.setLive(id, { ...ins.params, ...vals }, store.project.bpm);
    }
  }

  /** Create a track's instrument; network failures get one automatic retry. */
  private loadInstrument(trackId: string, id: string, dest: AudioNode, retry: boolean) {
    const pl = createInstrument(this.ctx, id, dest);
    const kit = this.tracks().find((t) => t.id === trackId)?.drumKit;
    if (kit) pl.configure?.(kit);
    this.insts.set(trackId, { id, p: pl });
    pl.ready.then(
      () => store.log(`Loaded instrument ${id}`),
      (e) => {
        const cur = this.insts.get(trackId);
        if (retry && cur?.p === pl) {
          store.log(`Retrying ${id} after load error: ${e}`);
          pl.dispose();
          setTimeout(() => this.insts.get(trackId)?.p === pl && this.loadInstrument(trackId, id, dest, false), 1500);
        } else store.log(`Error: failed to load ${id}: ${e}`);
      },
    );
    return pl;
  }

  private scheduleAudioFrom(fromBeat: number, ctxStart: number) {
    const p = store.project;
    const to = p.loop.on && fromBeat < p.loop.end ? p.loop.end : Infinity;
    for (const t of p.tracks) {
      const s = this.strips.get(t.id);
      if (!s) continue;
      if (t.frozen) {
        const fa = frozenAsAudio(t);
        if (fa) scheduleAudio(this.ctx, fa, s.input, fromBeat, to, ctxStart, this.spb, this.sources);
      } else if (t.kind === "audio") scheduleAudio(this.ctx, t, s.input, fromBeat, to, ctxStart, this.spb, this.sources);
    }
  }

  /** Metronome on/off and count-in length (bars) used when recording or when asked to. */
  metronome = false;
  countInBars = 1;
  private countInUntil = -Infinity; // clicks always sound before this beat (count-in)
  private clickOut: GainNode | null = null;

  /** Context time at which the transport reaches `beat` (current anchor). */
  timeOfBeat(beat: number) {
    return this.startCtx + (beat - this.startBeat) * this.spb;
  }

  async play(fromBeat = this.pausedBeat, opts: { countIn?: boolean } = {}) {
    if (this.ctx.state !== "running") await this.ctx.resume();
    this.stopVoices();
    this.playing = true;
    this.prevAnchor = null;
    // Count-in: start one or more bars early; the clicks play, audio/MIDI start at fromBeat.
    const pre = opts.countIn ? this.countInBars * 4 : 0;
    this.countInUntil = opts.countIn ? fromBeat : -Infinity;
    this.startBeat = fromBeat - pre;
    this.startCtx = this.ctx.currentTime + 0.05;
    this.scheduledTo = fromBeat - pre;
    this.scheduleAudioFrom(fromBeat, this.timeOfBeat(fromBeat));
    for (const t of this.tracks()) if (lanesOf(t).length) this.scheduleAutomation(t, this.startBeat, this.startCtx);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.startWatchdog();
    store.setUi({});
  }

  private scheduleNotes(from: number, until: number) {
    for (const t of this.tracks()) {
      if (t.kind !== "midi" || t.frozen) continue;
      const inst = this.insts.get(t.id)?.p;
      if (!inst) continue;
      forNotes(t, from, until, (beat, pitch, dur, vel, slide) => {
        inst.start({ note: pitch, time: this.startCtx + (beat - this.startBeat) * this.spb, duration: dur * this.spb, velocity: vel, slide });
      });
    }
  }

  private tick() {
    this.lastTickAt = performance.now();
    const p = store.project;
    for (const t of this.tracks()) if (t.automation?.length) this.applyPluginAutomation(t, this.beat);
    const loop = p.loop.on && p.loop.end > p.loop.start && this.scheduledTo < p.loop.end + 1e-6;
    let horizon = this.startBeat + (this.ctx.currentTime + LOOKAHEAD_SEC - this.startCtx) / this.spb;
    if (loop && horizon >= p.loop.end) {
      // Sample-accurate wrap: schedule the next pass before the current one ends.
      this.scheduleClicks(this.scheduledTo, p.loop.end);
      this.scheduleNotes(this.scheduledTo, p.loop.end);
      const wrapCtx = this.startCtx + (p.loop.end - this.startBeat) * this.spb;
      this.prevAnchor = { ctx: this.startCtx, beat: this.startBeat, until: wrapCtx };
      this.countInUntil = -Infinity; // the count-in is over once we loop
      this.startBeat = p.loop.start;
      this.startCtx = wrapCtx;
      this.scheduledTo = p.loop.start;
      this.scheduleAudioFrom(p.loop.start, wrapCtx);
      for (const t of this.tracks()) if (lanesOf(t).length) this.scheduleAutomation(t, p.loop.start, wrapCtx);
      // Re-anchored: the lookahead horizon must be measured against the new anchor, or a whole
      // loop pass would be scheduled in one tick.
      horizon = this.startBeat + (this.ctx.currentTime + LOOKAHEAD_SEC - this.startCtx) / this.spb;
    }
    if (this.sources.length > 64) this.sources = this.sources.filter((src) => !(src as AudioBufferSourceNode & { _done?: boolean })._done);
    const until = Math.min(horizon, loop ? p.loop.end : Infinity);
    if (until <= this.scheduledTo) return;
    this.scheduleClicks(this.scheduledTo, until);
    this.scheduleNotes(Math.max(this.scheduledTo, this.countInUntil === -Infinity ? this.scheduledTo : this.countInUntil), until);
    this.scheduledTo = until;
  }

  /** Metronome blips on every beat in [from, until): accent on the bar, straight to the speakers. */
  private scheduleClicks(from: number, until: number) {
    for (let b = Math.ceil(from - 1e-9); b < until; b++) {
      if (!this.metronome && b >= this.countInUntil) continue;
      const t = this.timeOfBeat(b);
      if (t < this.ctx.currentTime) continue;
      this.clickOut ??= (() => {
        const g = this.ctx.createGain();
        g.gain.value = 0.5;
        g.connect(this.ctx.destination); // not through master FX, never in bounces
        return g;
      })();
      const bar = ((b % 4) + 4) % 4 === 0;
      const osc = this.ctx.createOscillator();
      osc.frequency.value = bar ? 1760 : 1175;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(bar ? 0.9 : 0.55, t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.connect(env).connect(this.clickOut);
      osc.start(t);
      osc.stop(t + 0.06);
      osc.onended = () => ((osc as OscillatorNode & { _done?: boolean })._done = true);
      this.sources.push(osc);
    }
  }

  private stopVoices() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources = [];
    this.insts.forEach((i) => i.p.stopAll());
  }

  stop() {
    clearInterval(this.watchTimer);
    this.pausedBeat = Math.max(0, this.beat);
    for (const t of this.tracks()) if (lanesOf(t).length) this.holdAutomation(t, this.pausedBeat);
    this.countInUntil = -Infinity;
    this.stopVoices();
    this.playing = false;
    this.prevAnchor = null;
    store.setUi({});
  }

  /*
   * Playback watchdog. Failures in the audio graph are silent by nature (a NaN from a filter or
   * a compressor mutes everything downstream for good; an overloaded audio thread just drops
   * out), so while playing we check twice a second and report to the console + the app log:
   *  - NaN/Inf on the master → name the strips carrying it, rebuild the graph, resume
   *  - audio thread slower than realtime (too many voices/effects for this machine)
   *  - main thread blocking the note scheduler past its lookahead (notes dropped)
   *  - master silent for 4 s while audible tracks have material there
   */
  private watchTimer: number | undefined;
  private lastRebuild = -Infinity;
  private lastTickAt = 0;
  private startWatchdog() {
    clearInterval(this.watchTimer);
    this.lastTickAt = 0;
    const buf = new Float32Array(2048);
    let lastWall = performance.now(), lastAudio = this.ctx.currentTime;
    let silentFor = 0, slowCount = 0, warnedAt = 0;
    const warn = (msg: string, err = false) => {
      (err ? console.error : console.warn)(`[otpadn] ${msg}`);
      if (performance.now() - warnedAt > 5000 || err) store.log(`${err ? "Error" : "Warning"}: ${msg}`);
      warnedAt = performance.now();
    };
    const nonFinite = (an: AnalyserNode) => {
      const b = buf.length >= an.fftSize ? buf.subarray(0, an.fftSize) : new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(b);
      let bad = false, sum = 0;
      for (let i = 0; i < b.length; i++) {
        const v = b[i];
        if (!Number.isFinite(v)) bad = true;
        else sum += v * v;
      }
      return { bad, rms: Math.sqrt(sum / b.length) };
    };
    this.watchTimer = window.setInterval(() => {
      if (!this.playing) return;
      const wall = performance.now(), audio = this.ctx.currentTime;
      // 1) audio thread keeping up?
      const ratio = (audio - lastAudio) / Math.max(1e-3, (wall - lastWall) / 1000);
      lastWall = wall;
      lastAudio = audio;
      if (this.ctx.state !== "running") warn(`audio context is "${this.ctx.state}" while playing (the OS or browser paused audio) — press play again.`, true);
      else if (ratio < 0.85) {
        if (++slowCount >= 2) warn(`audio thread can't keep up (${Math.round(ratio * 100)} % of realtime): too many voices or effects. Freeze/bounce heavy tracks or mute some.`);
      } else slowCount = 0;
      // 2) scheduler starved by a busy main thread?
      if (this.lastTickAt && wall - this.lastTickAt > LOOKAHEAD_SEC * 1000) warn(`main thread was blocked ${Math.round(wall - this.lastTickAt)} ms — some notes were scheduled late or dropped.`);
      // 3) NaN on the master?
      const m = nonFinite(this.master.analyser);
      if (m.bad) {
        const p = store.project;
        const culprits = [...this.strips].filter(([, st]) => nonFinite(st.analyser).bad).map(([id]) => p.tracks.find((t) => t.id === id)?.name ?? id);
        const where = culprits.length ? `in: ${culprits.join(", ")}` : "on the master bus";
        // A source that keeps producing NaN must not rebuild forever: once per 10 s, else stop.
        if (wall - this.lastRebuild < 10_000) {
          warn(`audio turned invalid (NaN) again ${where} — stopped. Bypass that track's inserts or change its instrument.`, true);
          this.stop();
          return;
        }
        this.lastRebuild = wall;
        warn(`audio turned invalid (NaN) ${where} — rebuilt the audio graph and resumed.`, true);
        this.rebuildGraph();
        return;
      }
      // 4) silent although something should sound?
      if (m.rms < 1e-6 && this.hasMaterialAt(this.beat)) {
        silentFor += 0.5;
        if (silentFor === 4) warn(`no sound for 4 s although tracks have material at bar ${Math.floor(this.beat / 4) + 1} (context: ${this.ctx.state}, ${Math.round(ratio * 100)} % realtime).`, true);
      } else silentFor = 0;
    }, 500);
  }
  /** Is any audible track supposed to make sound around this beat? */
  private hasMaterialAt(beat: number) {
    const p = store.project;
    for (const t of p.tracks) {
      if (!isAudible(p, t)) continue;
      for (const c of t.clips) {
        if (c.kind === "audio") {
          if (beat >= c.start && beat < c.start + c.duration / this.spb) return true;
        } else if (beat >= c.start && beat < c.start + c.length && c.notes.some((n) => Math.abs(c.start + n.start - beat) < 4 || (c.start + n.start <= beat && c.start + n.start + n.dur >= beat))) return true;
      }
    }
    return false;
  }
  /** Throw away every strip, instrument and the master (their DSP state may hold NaN) and rebuild. */
  private rebuildGraph() {
    const at = this.beat;
    this.stop();
    for (const st of this.strips.values()) st.dispose();
    for (const it of this.insts.values()) it.p.dispose();
    this.strips.clear();
    this.insts.clear();
    this.chSig.clear();
    this.insSig.clear();
    this.autoSig.clear();
    this.master.dispose();
    this.master = createMaster(this.ctx);
    this.syncedVersion = -1;
    this.sync();
    void this.play(at);
  }

  /** Set by the recorder: called before the transport moves away from a running take. */
  onTransportJump: (() => void) | null = null;

  seek(beat: number) {
    this.onTransportJump?.();
    this.pausedBeat = Math.max(0, beat);
    if (!this.playing) for (const t of this.tracks()) if (lanesOf(t).length) this.holdAutomation(t, this.pausedBeat);
    if (this.playing) this.play(this.pausedBeat);
    else store.setUi({});
  }

  /** Play a note on a track's instrument right now (live input); returns its release function. */
  playLive(trackId: string, pitch: number, velocity: number): ((at?: number) => void) | undefined {
    if (this.ctx.state !== "running") this.ctx.resume();
    let inst = this.insts.get(trackId)?.p;
    const t = store.project.tracks.find((x) => x.id === trackId);
    const strip = this.strips.get(trackId);
    if (!inst && t?.instrument && strip) inst = this.loadInstrument(trackId, t.instrument, strip.input, true);
    return inst?.start({ note: pitch, time: this.ctx.currentTime, duration: 30, velocity }) ?? undefined;
  }

  previewNote(trackId: string, pitch: number) {
    if (this.ctx.state !== "running") this.ctx.resume();
    let inst = this.insts.get(trackId)?.p;
    const t = store.project.tracks.find((x) => x.id === trackId);
    const strip = this.strips.get(trackId);
    if (!inst && t?.instrument && strip) inst = this.loadInstrument(trackId, t.instrument, strip.input, true);
    inst?.ready.then(() => inst!.start({ note: pitch, time: this.ctx.currentTime, duration: 0.3, velocity: 100 }));
  }
}

export const engine = new Engine();
