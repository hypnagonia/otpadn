import type { NoteSlide } from "../model/types";
/**
 * Multisampled pitched instruments (bass, acoustic guitar, DI electric guitar), built by
 * tools/build_sampled_instruments.py from CC0 sources. Zones × velocity layers × round robins;
 * layers are level-matched by measured loudness so velocity alone drives volume; round robins
 * never repeat back to back; bass is mono (legato); electric presets run through the amp/cab sim.
 * Samples live as 16-bit PCM per AudioContext with a small LRU of playable buffers.
 */
import { memory } from "../system/memory";
import { AMP_PRESETS, createAmp, type Amp } from "./ampsim";
import type { Playable } from "./types";

interface Layer { lovel: number; hivel: number; power: number; rr: string[] }
interface Zone { key: number; lo: number; hi: number; layers: Layer[] }
interface Manifest { name: string; release: number; mono: boolean; zones: Zone[] }

interface Preset {
  src: string;
  amp?: keyof typeof AMP_PRESETS;
  /** Velocity → brightness (a per-voice low-pass) for single-layer sources. */
  tone?: boolean;
  gain: number;
}
export const SAMPLED: Record<string, Preset> = {
  "bass-fingered": { src: "bass-darkblack", gain: 1.1 },
  "acoustic-martin": { src: "acoustic-martin", tone: true, gain: 0.7 },
  "egtr-di": { src: "egtr-fsbs", gain: 0.28 }, // realistic DI level (≈ −6 dBFS peaks on chords)
  "egtr-clean": { src: "egtr-fsbs", amp: "clean", gain: 0.28 },
  "egtr-crunch": { src: "egtr-fsbs", amp: "crunch", gain: 0.28 },
  "egtr-highgain": { src: "egtr-fsbs", amp: "highgain", gain: 0.28 },
};

/* ── loading: compressed files once per page, 16-bit PCM once per context ── */

const files = new Map<string, Promise<{ manifest: Manifest; bytes: Map<string, ArrayBuffer> }>>();
function fetchSource(src: string) {
  let p = files.get(src);
  if (!p) {
    p = (async () => {
      const base = `${import.meta.env.BASE_URL}instruments/${src}/`;
      const res = await fetch(base + "inst.json");
      if (!res.ok) throw new Error(`instrument ${src}: HTTP ${res.status}`);
      const manifest: Manifest = await res.json();
      const names = [...new Set(manifest.zones.flatMap((z) => z.layers.flatMap((l) => l.rr)))];
      const bytes = new Map<string, ArrayBuffer>();
      let next = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (next < names.length) {
            const n = names[next++];
            const r = await fetch(base + encodeURIComponent(n));
            if (!r.ok) throw new Error(`sample ${src}/${n}: HTTP ${r.status}`);
            bytes.set(n, await r.arrayBuffer());
          }
        }),
      );
      return { manifest, bytes };
    })();
    p.catch(() => files.delete(src));
    files.set(src, p);
  }
  return p;
}

class PcmStore {
  private pcm = new Map<string, { data: Int16Array; sr: number }>();
  private lru = new Map<string, AudioBuffer>();
  private lruBytes = 0;
  static readonly LRU_MAX = 48 * 1024 * 1024;
  constructor(readonly key: string, readonly label: string) {}
  async load(ctx: BaseAudioContext, bytes: Map<string, ArrayBuffer>) {
    const names = [...bytes.keys()];
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < names.length) {
          const n = names[next++];
          const buf = await ctx.decodeAudioData(bytes.get(n)!.slice(0));
          const f = buf.getChannelData(0);
          const i16 = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
          this.pcm.set(n, { data: i16, sr: buf.sampleRate });
        }
      }),
    );
    this.account();
  }
  private account() {
    let n = this.lruBytes;
    for (const p of this.pcm.values()) n += p.data.length * 2;
    memory.track(this.key, n, "audio", this.label);
  }
  get(name: string): AudioBuffer | undefined {
    const hit = this.lru.get(name);
    if (hit) {
      this.lru.delete(name);
      this.lru.set(name, hit);
      return hit;
    }
    const p = this.pcm.get(name);
    if (!p) return undefined;
    const buf = new AudioBuffer({ numberOfChannels: 1, length: p.data.length, sampleRate: p.sr });
    const f = buf.getChannelData(0);
    for (let i = 0; i < p.data.length; i++) f[i] = p.data[i] / 32767;
    this.lru.set(name, buf);
    this.lruBytes += p.data.length * 4;
    while (this.lruBytes > PcmStore.LRU_MAX && this.lru.size > 1) {
      const [k, b] = this.lru.entries().next().value!;
      this.lru.delete(k);
      this.lruBytes -= b.length * 4;
    }
    this.account();
    return buf;
  }
  release() {
    memory.untrack(this.key);
  }
}

const stores = new WeakMap<BaseAudioContext, Map<string, Promise<PcmStore>>>();
let seq = 0;
function storeFor(ctx: BaseAudioContext, src: string): Promise<{ store: PcmStore; manifest: Manifest }> {
  let m = stores.get(ctx);
  if (!m) stores.set(ctx, (m = new Map()));
  let p = m.get(src);
  if (!p) {
    p = (async () => {
      const { manifest, bytes } = await fetchSource(src);
      await memory.ensure(70 * 1024 * 1024, `loading ${manifest.name}`);
      const st = new PcmStore(`inst:${src}:${++seq}`, manifest.name);
      await st.load(ctx, bytes);
      if (!(ctx instanceof AudioContext)) ctx.addEventListener?.("complete", () => st.release());
      return st;
    })();
    p.catch(() => m!.delete(src));
    m.set(src, p);
  }
  return p.then(async (store) => ({ store, manifest: (await fetchSource(src)).manifest }));
}

/* ── the instrument ── */

interface Voice { note: number; start: number; end: number; env: GainNode; src: AudioBufferSourceNode }

export class SampledInstrument implements Playable {
  ready: Promise<void>;
  private preset: Preset;
  private store: PcmStore | null = null;
  private manifest: Manifest | null = null;
  private out: GainNode;
  private amp: Amp | null = null;
  private refPower = 1;
  private rr = new Map<string, number>();
  private voices: Voice[] = [];

  constructor(private ctx: BaseAudioContext, dest: AudioNode, id: string) {
    this.preset = SAMPLED[id] ?? SAMPLED["bass-fingered"];
    this.out = ctx.createGain();
    this.out.gain.value = this.preset.gain;
    if (this.preset.amp) {
      this.amp = createAmp(ctx, AMP_PRESETS[this.preset.amp]);
      this.out.connect(this.amp.input);
      this.amp.output.connect(dest);
    } else this.out.connect(dest);
    this.ready = Promise.all([
      storeFor(ctx, this.preset.src).then(({ store, manifest }) => {
        this.store = store;
        this.manifest = manifest;
        // Reference loudness = median layer power: every layer is matched to it, velocity sets the level.
        const ps = manifest.zones.flatMap((z) => z.layers.map((l) => l.power)).sort((a, b) => a - b);
        this.refPower = ps[Math.floor(ps.length / 2)] || 1;
      }),
      this.amp?.ready ?? Promise.resolve(),
    ]).then(() => undefined);
  }

  start({ note, time, duration, velocity, slide }: { note: number; time: number; duration: number; velocity: number; slide?: NoteSlide }) {
    const m = this.manifest, st = this.store;
    if (!m || !st) return;
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
    const zone = m.zones.find((z) => note >= z.lo && note <= z.hi) ?? m.zones.reduce((a, z) => (Math.abs(z.key - note) < Math.abs(a.key - note) ? z : a));
    const vel = Math.max(1, Math.min(127, velocity));
    const li = Math.max(0, zone.layers.findIndex((l) => vel >= l.lovel && vel <= l.hivel));
    const layer = zone.layers[li];
    // Round robin: cycle, so the same sample never plays twice in a row.
    const key = `${zone.key}:${li}`;
    const i = ((this.rr.get(key) ?? -1) + 1) % layer.rr.length;
    this.rr.set(key, i);
    const buf = st.get(layer.rr[i]);
    if (!buf) return;
    const rate = Math.pow(2, (note - zone.key) / 12);
    const v = vel / 127;
    const level = Math.sqrt(this.refPower / Math.max(1e-6, layer.power)) * (0.08 + 0.92 * Math.pow(v, 1.5));
    const release = Math.max(0.02, m.release);

    // Mono instruments (bass): a new note ends the previous one (legato); every instrument cuts a
    // retriggered same-pitch note. Short fades, never hard stops (no clicks).
    this.voices = this.voices.filter((vo) => vo.end > ctx.currentTime);
    for (const vo of this.voices)
      if (vo.start < t - 1e-4 && vo.end > t && (m.mono || vo.note === note)) {
        vo.env.gain.setTargetAtTime(0, t, 0.008);
        vo.end = t + 0.06;
        try { vo.src.stop(t + 0.06); } catch { /* already stopped */ }
      }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.002);
    const noteEnd = t + Math.max(0.03, duration);
    // Player slides: glide in (detune from N semitones to 0), fall at the end (down + fading).
    if (slide?.from) {
      src.detune.setValueAtTime(slide.from * 100, t);
      src.detune.linearRampToValueAtTime(0, t + Math.max(0.02, Math.min(slide.fromTime ?? 0.06, duration * 0.6)));
    }
    if (slide?.fall) {
      const ft = Math.max(0.04, Math.min(slide.fallTime ?? 0.18, duration * 0.7));
      src.detune.setValueAtTime(0, noteEnd - ft);
      src.detune.linearRampToValueAtTime(slide.fall * 100, noteEnd);
      env.gain.setValueAtTime(level, noteEnd - ft);
      env.gain.linearRampToValueAtTime(level * 0.3, noteEnd);
    } else env.gain.setValueAtTime(level, noteEnd);
    env.gain.setTargetAtTime(0, noteEnd, release / 4);
    const sampleEnd = t + buf.duration / rate;
    const end = Math.min(sampleEnd, noteEnd + release * 1.5);
    let head: AudioNode = env;
    if (this.preset.tone) {
      // Single velocity layer: soft notes get darker, like a real softer pluck.
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800 + 14000 * Math.pow(v, 1.6);
      lp.Q.value = 0.5;
      env.connect(lp);
      head = lp;
    }
    src.connect(env);
    head.connect(this.out);
    src.start(t);
    src.stop(end + 0.02);
    const voice: Voice = { note, start: t, end, env, src };
    this.voices.push(voice);
    src.onended = () => {
      head.disconnect();
      env.disconnect();
      this.voices = this.voices.filter((x) => x !== voice);
    };
  }

  stopAll() {
    const now = this.ctx.currentTime;
    for (const vo of this.voices) {
      const g = vo.env.gain;
      if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(now);
      else g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.006);
      try { vo.src.stop(now + 0.05); } catch { /* not started */ }
    }
    this.voices = [];
  }

  dispose() {
    this.stopAll();
    this.out.disconnect();
    this.amp?.dispose();
  }
}
