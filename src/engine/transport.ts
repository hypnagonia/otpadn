/** Live playback: transport, lookahead note scheduler, mixer reconciliation. Singleton `engine`. */
import { createInstrument } from "../instruments/factory";
import { latencyHint } from "./audioPrefs";
import type { Playable } from "../instruments/types";
import { store } from "../model/store";
import type { Track } from "../model/types";
import { createMaster, createStrip, type Master, type Strip } from "./graph";
import { forNotes, isAudible, scheduleAudio } from "./schedule";

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
      const chSig = `${audible}|${trim}|${JSON.stringify(t.ch)}`;
      if (this.chSig.get(t.id) !== chSig) {
        this.chSig.set(t.id, chSig);
        s.apply(trim ? { ...t.ch, volumeDb: t.ch.volumeDb + trim } : t.ch, audible);
      }
      audibleOf.set(t.id, audible);
      if (t.kind === "midi" && t.instrument) {
        const cur = this.insts.get(t.id);
        // Lazy: muted tracks don't download samples until they're heard.
        if (cur ? cur.id !== t.instrument : audible) {
          cur?.p.dispose();
          this.loadInstrument(t.id, t.instrument, s.input, true);
        }
        if (t.drumKit) this.insts.get(t.id)?.p.configure?.(t.drumKit);
      }
    }
    // Second pass (every strip exists now): inserts with sidechain sources, and sends to buses.
    const sidechainOf = (id: string) => this.strips.get(id)?.postFader;
    const busInput = (id: string) => (all.find((b) => b.id === id)?.kind === "bus" ? this.strips.get(id)?.input : undefined);
    for (const t of all) {
      const s = this.strips.get(t.id);
      if (!s) continue;
      // Only touch the insert chain / sends when they (or what they connect to) changed.
      const insSig = `${p.bpm}|${all.length}|${JSON.stringify(t.inserts ?? [])}`;
      if (this.insSig.get(t.id) !== insSig) {
        this.insSig.set(t.id, insSig);
        s.setInserts(t.inserts ?? [], p.bpm, sidechainOf);
      }
      s.setSends(t.kind === "bus" ? [] : t.ch.sends, busInput, audibleOf.get(t.id) ?? true);
    }
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
      if (s && t.kind === "audio") scheduleAudio(this.ctx, t, s.input, fromBeat, to, ctxStart, this.spb, this.sources);
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
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    store.setUi({});
  }

  private scheduleNotes(from: number, until: number) {
    for (const t of this.tracks()) {
      if (t.kind !== "midi") continue;
      const inst = this.insts.get(t.id)?.p;
      if (!inst) continue;
      forNotes(t, from, until, (beat, pitch, dur, vel) => {
        inst.start({ note: pitch, time: this.startCtx + (beat - this.startBeat) * this.spb, duration: dur * this.spb, velocity: vel });
      });
    }
  }

  private tick() {
    const p = store.project;
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
    this.pausedBeat = Math.max(0, this.beat);
    this.countInUntil = -Infinity;
    this.stopVoices();
    this.playing = false;
    this.prevAnchor = null;
    store.setUi({});
  }

  /** Set by the recorder: called before the transport moves away from a running take. */
  onTransportJump: (() => void) | null = null;

  seek(beat: number) {
    this.onTransportJump?.();
    this.pausedBeat = Math.max(0, beat);
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
