import type { Insert } from "../plugins/defs";
import { ensureWorklets, InsertChain } from "../plugins/nodes";
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
  /** AudioParams an automation lane drives ("volume" | "pan" | "verb" | "send:<id>"), or [] if none. */
  autoTargets(param: string): import("./automation").AutoTarget[];
  /** Params currently driven by automation: apply()/setSends() leave them alone. */
  setAutomated(params: Set<string>): void;
  /** Frozen track: input goes straight to the fader (EQ + inserts are baked into the audio). */
  setFrozen(on: boolean): void;
  dispose(): void;
}

/**
 * input (always stereo) → HPF → low shelf → bells → high shelf → LPF → inserts → fader → pan → out
 * (+ post-fader reverb send). Every channel is stereo from its input on — a mono source becomes
 * dual-mono there — so a track's level and pan never depend on whether it is mono, or on whether
 * an insert (stereo worklet) happens to sit in its chain.
 */
export function createStrip(ctx: BaseAudioContext, out: AudioNode, reverbIn: AudioNode): Strip {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";
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
  const autoVol = ctx.createGain(); // volume automation (after the static fader)
  let automated = new Set<string>();
  // Stereo pan, constant power: unity at centre, the kept side +3 dB at the extremes (a dual-mono
  // source keeps its loudness wherever it's panned). Web Audio's StereoPannerNode is equal-power
  // for mono input but a +6 dB-summing balance for stereo input — levels jumped with the source.
  const panSplit = ctx.createChannelSplitter(2), panL = ctx.createGain(), panR = ctx.createGain(), pan = ctx.createChannelMerger(2);
  panSplit.connect(panL, 0).connect(pan, 0, 0);
  panSplit.connect(panR, 1).connect(pan, 0, 1);
  const send = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096; // EQ spectrum display
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024; // ≈ 21 ms at 48 kHz: one meter reading per frame

  // EQ bands that are flat are left out of the signal path (wired back in when used): six
  // always-on stereo filters per strip add up fast with many tracks (a multitrack kit = 8 strips).
  const bands: [BiquadFilterNode, (ch: ChannelSettings) => boolean][] = [
    [hpf, (ch) => ch.hpf > 0],
    [low, (ch) => Math.abs(ch.eqLow) > 0.01],
    [mid, (ch) => Math.abs(ch.eqMid) > 0.01],
    [mid2, (ch) => Math.abs(ch.eqMid2) > 0.01],
    [high, (ch) => Math.abs(ch.eqHigh) > 0.01],
    [lpf, (ch) => ch.lpf > 0],
  ];
  let wired = "-", frozen = false, lastOn: BiquadFilterNode[] = [];
  const wire = (on: BiquadFilterNode[]) => {
    lastOn = on;
    const sig = frozen ? "frozen" : on.map((n) => bands.findIndex((b) => b[0] === n)).join(",");
    if (sig === wired) return;
    wired = sig;
    input.disconnect();
    for (const [n] of bands) n.disconnect();
    if (frozen) {
      input.connect(fader);
      return;
    }
    let prev: AudioNode = input;
    for (const n of on) {
      prev.connect(n);
      prev = n;
    }
    prev.connect(chain.input);
  };
  wire([]);
  chain.output.connect(fader).connect(autoVol).connect(panSplit);
  pan.connect(out);
  pan.connect(analyser);
  pan.connect(meter);
  autoVol.connect(send).connect(reverbIn); // post-fader taps sit after the volume automation

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
        wire([]);
        set(hpf.frequency, 10);
        set(low.gain, 0);
        set(mid.gain, 0);
        set(mid2.gain, 0);
        set(high.gain, 0);
        set(lpf.frequency, 22000);
        set(fader.gain, audible ? 1 : 0);
        set(panL.gain, 1);
        set(panR.gain, 1);
        set(send.gain, 0);
        return;
      }
      wire(bands.filter((b) => b[1](ch)).map((b) => b[0]));
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
      // An automated volume rides on autoVol; the static fader then only carries mute.
      set(fader.gain, audible ? (automated.has("volume") ? 1 : dbToGain(ch.volumeDb)) : 0);
      if (!automated.has("volume")) set(autoVol.gain, 1);
      if (!automated.has("pan")) {
        const th = ((Math.max(-1, Math.min(1, ch.pan)) + 1) * Math.PI) / 4;
        set(panL.gain, Math.SQRT2 * Math.cos(th));
        set(panR.gain, Math.SQRT2 * Math.sin(th));
      }
      if (!automated.has("verb")) set(send.gain, ch.reverbSend);
    },
    inserts: chain,
    setInserts: (ins, bpm, sc) => chain.apply(ins, bpm, sc),
    postFader: autoVol,
    setSends(list, busInput, audible) {
      const want = new Map((list ?? []).map((sd) => [sd.id, sd]));
      for (const [id, s] of sends)
        if (!want.has(id) || want.get(id)!.bus !== s.bus || want.get(id)!.pre !== s.pre || busInput(s.bus) !== s.dest) {
          s.gain.disconnect();
          (s.pre ? chain.output : autoVol).disconnect(s.gain);
          sends.delete(id);
        }
      for (const sd of want.values()) {
        let s = sends.get(sd.id);
        if (!s) {
          const dest = busInput(sd.bus);
          if (!dest) continue;
          const gain = ctx.createGain();
          (sd.pre ? chain.output : autoVol).connect(gain);
          gain.connect(dest);
          s = { gain, bus: sd.bus, pre: sd.pre, dest };
          sends.set(sd.id, s);
        }
        // A muted channel sends nothing, also pre-fader. Automated sends are driven by their lane.
        if (!audible) set(s.gain.gain, 0);
        else if (!automated.has(`send:${sd.id}`)) set(s.gain.gain, Math.pow(10, sd.level / 20));
      }
    },
    autoTargets(param) {
      const th = (p: number) => ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
      if (param === "volume") return [{ param: autoVol.gain, map: (v) => dbToGain(v) }];
      if (param === "pan") return [{ param: panL.gain, map: (p) => Math.SQRT2 * Math.cos(th(p)) }, { param: panR.gain, map: (p) => Math.SQRT2 * Math.sin(th(p)) }];
      if (param === "verb") return [{ param: send.gain, map: (v) => Math.max(0, v) }];
      if (param.startsWith("send:")) {
        const s = sends.get(param.slice(5));
        return s ? [{ param: s.gain.gain, map: (v) => Math.pow(10, v / 20) }] : [];
      }
      return [];
    },
    setAutomated(params) {
      automated = params;
    },
    setFrozen(on) {
      if (on === frozen) return;
      frozen = on;
      wire(lastOn);
    },
    dispose() {
      input.disconnect();
      pan.disconnect();
      autoVol.disconnect();
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
  /** Detach from the speakers (the watchdog rebuilds a master whose state went NaN). */
  dispose(): void;
}

/** sum → glue comp → makeup → brickwall-ish limiter → soft clip → out */
/** Galactic settings for the master send reverb (medium hall, slightly dark) + level vs. the old plate. */
const SEND_VERB = { replace: 0.62, brightness: 0.45, detune: 0.35, bigness: 0.38, mix: 1 };
const SEND_VERB_TRIM = 1.8; // ≈ +5 dB: same early/mid energy as the plate it replaced (measured)

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
  // Send reverb: airwindows Galactic (lush FDN) once the worklets are loaded; the generated-noise
  // convolver only bridges the moments before that (live engine start).
  const verbOut = ctx.createGain();
  verbOut.connect(input);
  verbIn.connect(verbHp).connect(verb).connect(verbOut);
  const useGalactic = () => {
    try {
      const g = new AudioWorkletNode(ctx, "aw-galactic", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { params: SEND_VERB } });
      verbHp.disconnect();
      verb.disconnect();
      verbHp.connect(g).connect(verbOut);
      verbOut.gain.value = SEND_VERB_TRIM;
      return true;
    } catch {
      return false; // module not loaded yet
    }
  };
  if (!(globalThis as { __otpadnOldVerb?: boolean }).__otpadnOldVerb && !useGalactic()) void ensureWorklets(ctx).then(useGalactic);

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
    dispose() {
      clip.disconnect();
      bypassPath.disconnect();
      input.disconnect();
      verbIn.disconnect();
    },
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
