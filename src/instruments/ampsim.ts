/**
 * Guitar amp + cabinet, as WebAudio nodes (our own DSP; cabinet = CC0 impulse responses from
 * Jester's Brutal Pack). Like a real rig it distorts the *summed* signal, so chords intermodulate:
 *   tighten HPF → mid boost (screamer) → preamp stage 1 (asymmetric tube-like clip, 4× oversampled)
 *   → interstage LPF → stage 2 → tone stack (bass / mid / treble) → power-amp soft clip
 *   → presence → 4×12 cab IR → output level.
 * Gain is auto-compensated so turning it up adds distortion, not mostly volume.
 */

export type CabId = "v30" | "blend" | "dv77" | "off";
export const CABS: CabId[] = ["v30", "blend", "dv77", "off"];

export interface AmpParams {
  gain: number; // 0..10
  bass: number; // 0..10, 5 = flat
  mid: number;
  treble: number;
  presence: number;
  cab: number; // index into CABS
  level: number; // dB
}

export const AMP_PRESETS: Record<"clean" | "crunch" | "highgain" | "bass", AmpParams> = {
  clean: { gain: 1.5, bass: 5.5, mid: 5, treble: 6, presence: 5, cab: 1, level: -3.5 },
  crunch: { gain: 5, bass: 5.5, mid: 6, treble: 6, presence: 5.5, cab: 0, level: 0 },
  highgain: { gain: 8.5, bass: 6, mid: 3.5, treble: 6.5, presence: 6.5, cab: 0, level: 2 },
  bass: { gain: 2.5, bass: 6, mid: 5.5, treble: 4.5, presence: 4, cab: 3, level: 0 },
};

const curveCache = new Map<string, Float32Array<ArrayBuffer>>();
/** Asymmetric soft clip (even harmonics, like a triode); k = hardness. */
function curve(kind: "pre" | "power", k: number) {
  const key = `${kind}:${k.toFixed(2)}`;
  let c = curveCache.get(key);
  if (!c) {
    c = new Float32Array(4096);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = kind === "pre" ? (x >= 0 ? Math.tanh(k * x) : Math.tanh(k * 0.8 * x) * 1.08) / Math.tanh(k) : Math.tanh(k * x) / Math.tanh(k);
    }
    curveCache.set(key, c);
  }
  return c;
}

const irBytes = new Map<CabId, Promise<ArrayBuffer>>();
const irBufs = new WeakMap<BaseAudioContext, Map<CabId, Promise<AudioBuffer>>>();
function cabBuffer(ctx: BaseAudioContext, id: CabId): Promise<AudioBuffer> {
  let m = irBufs.get(ctx);
  if (!m) irBufs.set(ctx, (m = new Map()));
  let p = m.get(id);
  if (!p) {
    let bytes = irBytes.get(id);
    if (!bytes) {
      bytes = fetch(`${import.meta.env.BASE_URL}instruments/cabs/${id}.wav`).then((r) => {
        if (!r.ok) throw new Error(`cabinet IR ${id}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      bytes.catch(() => irBytes.delete(id));
      irBytes.set(id, bytes);
    }
    p = bytes.then((b) => ctx.decodeAudioData(b.slice(0)));
    m.set(id, p);
  }
  return p;
}

export interface Amp {
  input: AudioNode;
  output: AudioNode;
  set(p: AmpParams): void;
  /** Resolves when the current cabinet IR is loaded (offline renders wait for it). */
  ready: Promise<void>;
  dispose(): void;
}

export function createAmp(ctx: BaseAudioContext, initial: AmpParams): Amp {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.7;
  const boost = ctx.createBiquadFilter(); boost.type = "peaking"; boost.frequency.value = 760; boost.Q.value = 0.8;
  const pre1 = ctx.createGain();
  const sh1 = ctx.createWaveShaper(); sh1.oversample = "4x";
  const lp1 = ctx.createBiquadFilter(); lp1.type = "lowpass"; lp1.frequency.value = 6500; lp1.Q.value = 0.6;
  const dc = ctx.createBiquadFilter(); dc.type = "highpass"; dc.frequency.value = 30; // removes the asymmetric clip's DC
  const pre2 = ctx.createGain();
  const sh2 = ctx.createWaveShaper(); sh2.oversample = "4x";
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 110;
  const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 650; mid.Q.value = 0.7;
  const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 3200;
  const power = ctx.createGain();
  const sh3 = ctx.createWaveShaper(); sh3.oversample = "2x"; sh3.curve = curve("power", 1.6);
  const pres = ctx.createBiquadFilter(); pres.type = "highshelf"; pres.frequency.value = 4800;
  const cab = ctx.createConvolver(); cab.normalize = false;
  const post = ctx.createBiquadFilter(); post.type = "lowpass"; post.frequency.value = 11000; post.Q.value = 0.5;
  const out = ctx.createGain();
  const bypassCab = ctx.createGain();
  input.connect(hp).connect(boost).connect(pre1).connect(sh1).connect(lp1).connect(dc).connect(pre2).connect(sh2).connect(low).connect(mid).connect(high).connect(power).connect(sh3).connect(pres);
  post.connect(out);
  let cabId: CabId | null = null;
  let ready: Promise<void> = Promise.resolve();
  const amp: Amp = {
    input,
    output: out,
    get ready() {
      return ready;
    },
    set(p) {
      const g = Math.max(0, Math.min(10, p.gain));
      hp.frequency.value = 70 + g * 6; // more gain → tighter lows (no flub under distortion)
      boost.gain.value = Math.max(0, g - 4) * 1.2; // screamer-style mid push on the higher settings
      const d1 = g * 2.6, d2 = g * 1.9; // dB of drive per stage
      pre1.gain.value = Math.pow(10, d1 / 20);
      pre2.gain.value = Math.pow(10, d2 / 20);
      sh1.curve = curve("pre", 1.2 + g * 0.12);
      sh2.curve = curve("pre", 1 + g * 0.1);
      const knob = (v: number, range: number) => ((Math.max(0, Math.min(10, v)) - 5) / 5) * range;
      low.gain.value = knob(p.bass, 9);
      mid.gain.value = knob(p.mid, 9);
      high.gain.value = knob(p.treble, 9);
      pres.gain.value = knob(p.presence, 8);
      // Auto make-up: the clipper caps the level, so only a part of the drive needs compensating.
      const makeup = -Math.min(d1 + d2, 12 + (d1 + d2) * 0.15);
      power.gain.value = 0.7;
      out.gain.value = Math.pow(10, (makeup + p.level - 14) / 20) * 2.2; // −14 dB: the cab IR adds gain; level 0 ≈ DI loudness
      const id = CABS[Math.round(p.cab)] ?? "v30";
      if (id !== cabId) {
        cabId = id;
        pres.disconnect();
        cab.disconnect();
        bypassCab.disconnect();
        if (id === "off") {
          pres.connect(bypassCab).connect(post);
          bypassCab.gain.value = 0.35;
          ready = Promise.resolve();
        } else {
          pres.connect(cab).connect(post);
          ready = cabBuffer(ctx, id).then(
            (b) => {
              if (cabId === id) cab.buffer = b;
            },
            () => {
              // no IR (offline / blocked): fall back to a speaker-like low-pass so it never goes silent
              if (cabId !== id) return;
              cab.disconnect();
              post.frequency.value = 5000;
              pres.disconnect();
              pres.connect(bypassCab).connect(post);
              bypassCab.gain.value = 0.35;
            },
          );
        }
      }
    },
    dispose() {
      input.disconnect();
      out.disconnect();
    },
  };
  amp.set(initial);
  return amp;
}
