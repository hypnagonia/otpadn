import type { Insert } from "../plugins/defs";
import { InsertChain } from "../plugins/nodes";
import type { ChannelSettings, Send } from "../model/types";

const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface Strip {
  input: GainNode;
  analyser: AnalyserNode;
  /** Small analyser for level meters (the big one feeds the EQ spectrum). */
  meter: AnalyserNode;
  apply(ch: ChannelSettings, audible: boolean, neutral?: boolean): void;
  /** Rebuild/update the insert chain; resolves once wired (worklets loaded). */
  setInserts(inserts: Insert[], bpm: number, sidechainOf?: (trackId: string) => AudioNode | undefined): Promise<void>;
  /** Post-fader signal (sidechain source). */
  postFader: AudioNode;
  /** Wire sends to bus inputs. */
  setSends(sends: Send[] | undefined, busInput: (busId: string) => AudioNode | undefined, audible: boolean): void;
  inserts: InsertChain;
  dispose(): void;
}

/** input → HPF → low shelf → mid peak → high shelf → compressor → fader → pan → out (+ post-fader reverb send) */
export function createStrip(ctx: BaseAudioContext, out: AudioNode, reverbIn: AudioNode): Strip {
  const input = ctx.createGain();
  const hpf = ctx.createBiquadFilter();
  hpf.type = "highpass";
  hpf.Q.value = 0.707;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 100;
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.Q.value = 1;
  const mid2 = ctx.createBiquadFilter();
  mid2.type = "peaking";
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  const lpf = ctx.createBiquadFilter();
  lpf.type = "lowpass";
  lpf.Q.value = 0.707;
  const chain = new InsertChain(ctx);
  const sends = new Map<string, { gain: GainNode; bus: string; pre: boolean; dest: AudioNode }>();
  const fader = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const send = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096; // EQ spectrum display
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024; // ≈ 21 ms at 48 kHz: one meter reading per frame

  input.connect(hpf).connect(low).connect(mid).connect(mid2).connect(high).connect(lpf).connect(chain.input);
  chain.output.connect(fader).connect(pan);
  pan.connect(out);
  pan.connect(analyser);
  pan.connect(meter);
  fader.connect(send).connect(reverbIn);

  const set = (p: AudioParam, v: number) => {
    if (ctx instanceof AudioContext) p.setTargetAtTime(v, ctx.currentTime, 0.015);
    else p.value = v;
  };

  return {
    input,
    analyser,
    meter,
    apply(ch, audible, neutral = false) {
      if (neutral) {
        set(hpf.frequency, 10);
        set(low.gain, 0);
        set(mid.gain, 0);
        set(mid2.gain, 0);
        set(high.gain, 0);
        set(lpf.frequency, 22000);
        set(fader.gain, audible ? 1 : 0);
        set(pan.pan, 0);
        set(send.gain, 0);
        return;
      }
      set(hpf.frequency, ch.hpf > 0 ? ch.hpf : 10);
      set(low.gain, ch.eqLow);
      set(low.frequency, ch.eqLowFreq);
      set(mid.gain, ch.eqMid);
      set(mid.frequency, ch.eqMidFreq);
      set(mid.Q, ch.eqMidQ);
      set(mid2.gain, ch.eqMid2);
      set(mid2.frequency, ch.eqMid2Freq);
      set(mid2.Q, ch.eqMid2Q);
      set(high.gain, ch.eqHigh);
      set(high.frequency, ch.eqHighFreq);
      set(lpf.frequency, ch.lpf > 0 ? ch.lpf : 22000);
      set(fader.gain, audible ? dbToGain(ch.volumeDb) : 0);
      set(pan.pan, ch.pan);
      set(send.gain, ch.reverbSend);
    },
    inserts: chain,
    setInserts: (ins, bpm, sc) => chain.apply(ins, bpm, sc),
    postFader: fader,
    setSends(list, busInput, audible) {
      const want = new Map((list ?? []).map((sd) => [sd.id, sd]));
      for (const [id, s] of sends)
        if (!want.has(id) || want.get(id)!.bus !== s.bus || want.get(id)!.pre !== s.pre || busInput(s.bus) !== s.dest) {
          s.gain.disconnect();
          (s.pre ? chain.output : fader).disconnect(s.gain);
          sends.delete(id);
        }
      for (const sd of want.values()) {
        let s = sends.get(sd.id);
        if (!s) {
          const dest = busInput(sd.bus);
          if (!dest) continue;
          const gain = ctx.createGain();
          (sd.pre ? chain.output : fader).connect(gain);
          gain.connect(dest);
          s = { gain, bus: sd.bus, pre: sd.pre, dest };
          sends.set(sd.id, s);
        }
        // A muted channel sends nothing, also pre-fader.
        set(s.gain.gain, audible ? Math.pow(10, sd.level / 20) : 0);
      }
    },
    dispose() {
      input.disconnect();
      pan.disconnect();
      send.disconnect();
      fader.disconnect();
      sends.forEach((sd) => sd.gain.disconnect());
      sends.clear();
      chain.dispose();
    },
  };
}

function makeImpulse(ctx: BaseAudioContext, seconds = 2.4, predelay = 0.02): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (seconds + predelay));
  const ir = ctx.createBuffer(2, len, sr);
  // Seeded noise: every render (live or bounce) gets the same impulse, so exports are reproducible.
  let seed = 0x2f6b1d;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = Math.floor(predelay * sr); i < len; i++) {
      const t = i / sr - predelay;
      const decay = Math.exp((-6.9 * t) / seconds);
      // Progressive damping: tail gets darker over time.
      const k = 0.15 + 0.8 * Math.min(1, t / seconds);
      lp = lp * k + (rnd() * 2 - 1) * (1 - k);
      d[i] = lp * decay * 1.8;
    }
  }
  return ir;
}

export interface Master {
  input: GainNode;
  inserts: InsertChain;
  reverbIn: AudioNode;
  analyser: AnalyserNode;
  apply(masterDb: number, bypass?: boolean): void;
}

/** sum → glue comp → makeup → brickwall-ish limiter → soft clip → out */
export function createMaster(ctx: BaseAudioContext): Master {
  const input = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -12;
  glue.ratio.value = 2;
  glue.attack.value = 0.03;
  glue.release.value = 0.25;
  glue.knee.value = 6;
  const makeup = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.ratio.value = 20;
  limiter.knee.value = 0;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const clip = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.abs(x) < 0.9 ? x : Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) / 0.1));
  }
  clip.curve = curve;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  const verb = ctx.createConvolver();
  verb.buffer = makeImpulse(ctx);
  const verbIn = ctx.createGain();
  const verbHp = ctx.createBiquadFilter();
  verbHp.type = "highpass";
  verbHp.frequency.value = 250;
  verbIn.connect(verbHp).connect(verb).connect(input);

  const chain = new InsertChain(ctx);
  input.connect(chain.input);
  chain.output.connect(glue).connect(makeup).connect(limiter).connect(clip).connect(analyser);
  clip.connect(ctx.destination);
  const bypassPath = ctx.createGain();
  bypassPath.gain.value = 0;
  input.connect(bypassPath).connect(ctx.destination);

  let bypassed = false;
  return {
    input,
    inserts: chain,
    reverbIn: verbIn,
    analyser,
    apply(masterDb, bypass = false) {
      makeup.gain.value = dbToGain(masterDb);
      if (bypass === bypassed) return;
      // Bypass = raw sum (for measuring), used by offline loudness analysis.
      bypassed = bypass;
      bypassPath.gain.value = bypass ? 1 : 0;
      if (bypass) clip.disconnect();
      else {
        clip.connect(analyser);
        clip.connect(ctx.destination);
      }
    },
  };
}
