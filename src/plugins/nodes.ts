/** Instantiate insert plugins on any (realtime/offline) audio context. */
import workletUrl from "./worklets.ts?worker&url";
import { DELAY_DIV_BEATS, type Insert, type PluginType } from "./defs";
import { createAmp, type AmpParams } from "../instruments/ampsim";

export interface PluginInstance {
  input: AudioNode;
  output: AudioNode;
  set(params: Record<string, number>, bpm: number): void;
  /** Latest gain reduction per band (dB, ≤ 0), for meters. */
  gr: number[];
  /** Resolves when async resources (e.g. a cabinet IR) are loaded; offline renders wait for it. */
  ready?: Promise<void>;
  /** Node whose input 1 is the sidechain (compressor only). */
  sidechainNode?: AudioNode;
  dispose(): void;
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
/** Worklet modules are per context; load once and cache the promise. */
export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) loaded.set(ctx, (p = ctx.audioWorklet.addModule(workletUrl)));
  return p;
}

function worklet(ctx: BaseAudioContext, name: string, bands: number, inputs = 1, params?: Record<string, number>): PluginInstance {
  // Initial params go in with the node: offline renders may finish before a port message lands.
  const node = new AudioWorkletNode(ctx, name, { numberOfInputs: inputs, numberOfOutputs: 1, outputChannelCount: [2], channelCountMode: "explicit", channelCount: 2, processorOptions: { params } });
  const inst: PluginInstance = {
    input: node,
    output: node,
    gr: new Array(bands).fill(0),
    set: (params) => node.port.postMessage(params),
    dispose: () => {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
  node.port.onmessage = (e) => (inst.gr = e.data.gr);
  if (inputs > 1) inst.sidechainNode = node;
  return inst;
}

function delay(ctx: BaseAudioContext): PluginInstance {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const dl = ctx.createDelay(4), dr = ctx.createDelay(4);
  const fbL = ctx.createGain(), fbR = ctx.createGain();
  const mk = () => {
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
    hp.type = "highpass";
    lp.type = "lowpass";
    hp.connect(lp);
    return { hp, lp };
  };
  const fL = mk(), fR = mk();
  const toL = ctx.createGain(), toR = ctx.createGain(); // input routing per mode
  input.connect(dry).connect(output);
  input.connect(split);
  toL.connect(dl);
  toR.connect(dr);
  dl.connect(fL.hp);
  dr.connect(fR.hp);
  fL.lp.connect(fbL);
  fR.lp.connect(fbR);
  fL.lp.connect(merge, 0, 0);
  fR.lp.connect(merge, 0, 1);
  merge.connect(wet).connect(output);
  let mode = -1;
  const rewire = (pp: number) => {
    if (pp === mode) return;
    mode = pp;
    fbL.disconnect();
    fbR.disconnect();
    split.disconnect();
    if (pp) {
      // ping-pong: mono sum enters left, bounces L→R→L
      toL.gain.value = 0.5;
      split.connect(toL, 0);
      split.connect(toL, 1);
      fbL.connect(dr);
      fbR.connect(dl);
    } else {
      toL.gain.value = 1;
      split.connect(toL, 0);
      split.connect(toR, 1);
      fbL.connect(dl);
      fbR.connect(dr);
    }
  };
  return {
    input,
    output,
    gr: [],
    set(p, bpm) {
      rewire(p.pingpong);
      const t = (DELAY_DIV_BEATS[p.div] ?? 1) * (60 / bpm);
      dl.delayTime.value = Math.min(3.9, t);
      dr.delayTime.value = Math.min(3.9, t * (1 + p.offset / 100));
      fbL.gain.value = fbR.gain.value = p.feedback / 100;
      for (const f of [fL, fR]) {
        f.hp.frequency.value = p.lowcut;
        f.lp.frequency.value = p.highcut;
      }
      wet.gain.value = p.mix / 100;
      dry.gain.value = 1 - (p.mix / 100) * 0.5;
    },
    dispose() {
      input.disconnect();
      output.disconnect();
    },
  };
}

/**
 * Transfer curves, all with gain ×3 around the origin (the drive staging below assumes it):
 *  soft: tanh (odd harmonics, smooth)   tape: gentler knee + soft ceiling (odd, warm)
 *  tube: asymmetric (even + odd harmonics; DC removed after the shaper)   hard: clipped linear
 */
const curve = (f: (x: number) => number) => {
  const c = new Float32Array(4096);
  const norm = Math.max(Math.abs(f(1)), Math.abs(f(-1)));
  for (let i = 0; i < c.length; i++) c[i] = f((i / (c.length - 1)) * 2 - 1) / norm;
  return c;
};
const SAT_CURVES = [
  curve((x) => Math.tanh(3 * x)),
  curve((x) => { const y = 3 * x; return y / Math.pow(1 + Math.pow(Math.abs(y), 2.5), 1 / 2.5); }),
  curve((x) => (Math.tanh(3 * x + 0.35) - Math.tanh(0.35)) / (1 - Math.tanh(0.35) ** 2)), // biased: smooth, asymmetric
  curve((x) => Math.max(-1, Math.min(1, 3 * x * 0.9))),
];
const satCurve = SAT_CURVES[0];

/** Saturator: drive → tanh shaper (4× oversampled) → tone low-pass, auto gain compensation, dry/wet. */
function saturator(ctx: BaseAudioContext): PluginInstance {
  const input = ctx.createGain(), output = ctx.createGain();
  const pre = ctx.createGain(), sh = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), post = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
  sh.curve = satCurve;
  sh.oversample = "4x";
  lp.type = "lowpass";
  const dc = ctx.createBiquadFilter(); // removes the DC the asymmetric (tube) curve adds
  dc.type = "highpass";
  dc.frequency.value = 12;
  dc.Q.value = 0.707;
  let mode = 0;
  input.connect(pre).connect(sh).connect(dc).connect(lp).connect(post).connect(wet).connect(output);
  input.connect(dry).connect(output);
  return {
    input,
    output,
    gr: [],
    set(p) {
      const m = Math.max(0, Math.min(SAT_CURVES.length - 1, Math.round(p.mode ?? 0)));
      if (m !== mode) {
        mode = m;
        sh.curve = SAT_CURVES[m];
      }
      const drive = Math.pow(10, p.drive / 20);
      pre.gain.value = drive / 3; // the curve itself has ×3 gain at the origin
      post.gain.value = 1 / Math.sqrt(drive); // roughly level-matched so drive ≠ louder
      lp.frequency.value = p.tone;
      wet.gain.value = (p.mix / 100) * Math.pow(10, p.output / 20);
      dry.gain.value = (1 - p.mix / 100) * Math.pow(10, p.output / 20);
    },
    dispose() {
      input.disconnect();
      output.disconnect();
    },
  };
}

/** Requires ensureWorklets(ctx) to have resolved for worklet-based types. `params` = initial settings. */
export function createPlugin(ctx: BaseAudioContext, type: PluginType, params?: Record<string, number>): PluginInstance {
  switch (type) {
    case "compressor": return worklet(ctx, "otpadn-comp", 1, 2, params);
    case "multiband": return worklet(ctx, "otpadn-mbcomp", 3, 1, params);
    case "reverb": return worklet(ctx, "otpadn-plate", 0, 1, params);
    case "delay": return delay(ctx);
    case "saturator": return saturator(ctx);
    case "limiter": return worklet(ctx, "otpadn-limiter", 1, 1, params);
    case "amp": {
      const a = createAmp(ctx, { gain: 6, bass: 5.5, mid: 5, treble: 6, presence: 5.5, cab: 0, level: 0 });
      return { input: a.input, output: a.output, gr: [], set: (p) => a.set(p as unknown as AmpParams), dispose: () => a.dispose(), get ready() { return a.ready; } } as PluginInstance;
    }
  }
}

/** Live chain for one channel: rebuilt when the insert list changes, params pushed otherwise. */
export class InsertChain {
  readonly input: GainNode;
  readonly output: GainNode;
  instances = new Map<string, PluginInstance>();
  private sig = "";
  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }
  private sc = new Map<string, { src: AudioNode; dst: AudioNode }>();
  /** Returns a promise that resolves when the chain is wired (worklets loaded). */
  async apply(inserts: Insert[], bpm: number, sidechainOf?: (trackId: string) => AudioNode | undefined): Promise<void> {
    const paramsOf = (ins: Insert) => (ins.type === "compressor" ? { ...ins.params, sc: ins.sidechain && sidechainOf?.(ins.sidechain) ? 1 : 0 } : ins.params);
    const sig = inserts.map((i) => `${i.id}:${i.type}:${i.on ? 1 : 0}`).join("|");
    if (sig !== this.sig) {
      this.sig = sig;
      if (inserts.some((i) => i.on && i.type !== "delay")) await ensureWorklets(this.ctx);
      if (sig !== this.sig) return; // superseded while loading
      this.input.disconnect();
      for (const [id, inst] of this.instances)
        if (!inserts.some((i) => i.id === id)) {
          inst.dispose();
          this.instances.delete(id);
        }
      let prev: AudioNode = this.input;
      for (const ins of inserts) {
        if (!ins.on) continue;
        let inst = this.instances.get(ins.id);
        if (!inst) this.instances.set(ins.id, (inst = createPlugin(this.ctx, ins.type, paramsOf(ins))));
        inst.output.disconnect();
        prev.connect(inst.input);
        prev = inst.output;
      }
      prev.connect(this.output);
    }
    for (const ins of inserts) if (ins.on) this.instances.get(ins.id)?.set(paramsOf(ins), bpm);
    // Sidechain sources → compressor input 1 (rewired only when the source changes).
    for (const ins of inserts) {
      const inst = this.instances.get(ins.id);
      const want = ins.on && ins.sidechain && inst?.sidechainNode ? sidechainOf?.(ins.sidechain) : undefined;
      const cur = this.sc.get(ins.id);
      if (cur && (cur.src !== want || cur.dst !== inst?.sidechainNode)) {
        try { cur.src.disconnect(cur.dst, 0, 1); } catch { /* already gone */ }
        this.sc.delete(ins.id);
      }
      if (want && inst?.sidechainNode && !this.sc.has(ins.id)) {
        want.connect(inst.sidechainNode, 0, 1);
        this.sc.set(ins.id, { src: want, dst: inst.sidechainNode });
      }
    }
    for (const [id, cur] of this.sc)
      if (!inserts.some((i) => i.id === id)) {
        try { cur.src.disconnect(cur.dst, 0, 1); } catch { /* already gone */ }
        this.sc.delete(id);
      }
    // Async resources (amp cabinet IRs): renders must not start before they're loaded.
    await Promise.all(inserts.filter((i) => i.on).map((i) => this.instances.get(i.id)?.ready ?? Promise.resolve()));
  }
  dispose() {
    for (const cur of this.sc.values()) {
      try { cur.src.disconnect(cur.dst, 0, 1); } catch { /* already gone */ }
    }
    this.sc.clear();
    this.instances.forEach((i) => i.dispose());
    this.input.disconnect();
    this.output.disconnect();
  }
}
