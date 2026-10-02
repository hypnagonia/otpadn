/**
 * Multitrack sampled drum kit (CrocellKit, CC BY 4.0 — see public/kits/crocell/LICENSE.txt).
 * Every hit plays one file per mic group (kick, snare, toms, hihat, ride, overheads, room),
 * each into its own output, so the kit mixes like a real multi-mic recording. 8 velocity
 * layers per piece; adjacent layers alternate for variation. Lazy: loads on first use.
 */
import { memory } from "../system/memory";
import type { Playable } from "./types";

export const KIT_GROUPS = ["kick", "snare", "toms", "hihat", "ride", "overheads", "room"] as const;
export type KitGroup = (typeof KIT_GROUPS)[number];
export const KIT_GROUP_LABEL: Record<KitGroup, string> = { kick: "Kick", snare: "Snare", toms: "Toms", hihat: "Hihat", ride: "Ride", overheads: "Overheads", room: "Room" };

interface Manifest {
  sampleRate: number;
  groups: Record<string, { stereo: boolean }>;
  pieces: Record<string, { gm: number[]; choke?: string; group?: string; layers: { power: number; files: Record<string, string> }[] }>;
}

/** GM notes the kit has no dedicated piece for → nearest piece. */
const GM_EXTRA: Record<number, string> = { 37: "Snare", 39: "Snare", 70: "HihatClosed", 54: "HihatClosed", 82: "HihatClosed" };
const CONCURRENCY = 8;

const cache = new Map<string, Promise<{ manifest: Manifest; files: Map<string, ArrayBuffer> }>>();

/** Fetch manifest + all compressed files once per kit (~16 MB). */
function fetchKit(id: string) {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const base = `${import.meta.env.BASE_URL}kits/${id}/`;
      const manifest: Manifest = await (await fetch(base + "kit.json")).json();
      const names = [...new Set(Object.values(manifest.pieces).flatMap((pc) => pc.layers.flatMap((l) => Object.values(l.files))))];
      const files = new Map<string, ArrayBuffer>();
      let next = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (next < names.length) {
            const n = names[next++];
            const res = await fetch(base + n);
            if (!res.ok) throw new Error(`kit sample ${n}: HTTP ${res.status}`);
            files.set(n, await res.arrayBuffer());
          }
        }),
      );
      return { manifest, files };
    })();
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/**
 * Decoded kit audio for one AudioContext, shared by every instance on it. Stored as 16-bit PCM
 * (half of float), with a byte-bounded LRU of ready AudioBuffers for the hits actually played.
 */
class KitStore {
  private pcm = new Map<string, { ch: Int16Array[]; sr: number; len: number }>();
  private lru = new Map<string, AudioBuffer>();
  private lruBytes = 0;
  static readonly LRU_MAX = 96 * 1024 * 1024;
  ready: Promise<void>;
  constructor(readonly ctx: BaseAudioContext, readonly key: string, files: Map<string, ArrayBuffer>) {
    const names = [...files.keys()];
    let next = 0;
    // Decode a few at a time so float copies never pile up.
    this.ready = Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < names.length) {
          const n = names[next++];
          const buf = await ctx.decodeAudioData(files.get(n)!.slice(0));
          const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => {
            const f = buf.getChannelData(c);
            const i16 = new Int16Array(f.length);
            for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
            return i16;
          });
          this.pcm.set(n, { ch, sr: buf.sampleRate, len: buf.length });
        }
      }),
    ).then(() => this.account());
  }
  get bytes() {
    let n = 0;
    for (const p of this.pcm.values()) n += p.len * p.ch.length * 2;
    return n + this.lruBytes;
  }
  private account() {
    memory.track(this.key, this.bytes, "audio", "multitrack drum kit");
  }
  /** A playable buffer for a file (from the LRU, or built from 16-bit PCM). */
  get(name: string): AudioBuffer | undefined {
    const hit = this.lru.get(name);
    if (hit) {
      this.lru.delete(name);
      this.lru.set(name, hit); // most recently used
      return hit;
    }
    const p = this.pcm.get(name);
    if (!p) return undefined;
    const buf = new AudioBuffer({ numberOfChannels: p.ch.length, length: p.len, sampleRate: p.sr });
    p.ch.forEach((i16, c) => {
      const f = buf.getChannelData(c);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32767;
    });
    this.lru.set(name, buf);
    this.lruBytes += p.len * p.ch.length * 4;
    while (this.lruBytes > KitStore.LRU_MAX && this.lru.size > 1) {
      const [k, b] = this.lru.entries().next().value!;
      this.lru.delete(k);
      this.lruBytes -= b.length * b.numberOfChannels * 4;
    }
    this.account();
    return buf;
  }
  dropCache(): number {
    const freed = this.lruBytes;
    this.lru.clear();
    this.lruBytes = 0;
    this.account();
    return freed;
  }
  release() {
    memory.untrack(this.key);
  }
}

const stores = new WeakMap<BaseAudioContext, Map<string, Promise<KitStore>>>();
const live = new Set<KitStore>();
let ctxSeq = 0;
const ctxIds = new WeakMap<BaseAudioContext, number>();
memory.reclaimer("drum kit playback cache", 25, () => [...live].reduce((n, k) => n + k.dropCache(), 0));

function kitStore(ctx: BaseAudioContext, id: string): Promise<KitStore> {
  let m = stores.get(ctx);
  if (!m) stores.set(ctx, (m = new Map()));
  let p = m.get(id);
  if (!p) {
    if (!ctxIds.has(ctx)) ctxIds.set(ctx, ++ctxSeq);
    p = (async () => {
      await memory.ensure(220 * 1024 * 1024, "loading the multitrack drum kit");
      const { files } = await fetchKit(id);
      const ks = new KitStore(ctx, `kit:${id}:${ctxIds.get(ctx)}`, files);
      await ks.ready;
      if (ctx instanceof AudioContext) live.add(ks);
      else ctx.addEventListener?.("complete", () => ks.release()); // offline renders free theirs
      return ks;
    })();
    p.catch(() => m!.delete(id));
    m.set(id, p);
  }
  return p;
}

function hash01(note: number, time: number) {
  let h = Math.imul(note + 1, 0x9e3779b1) ^ Math.imul(Math.round(time * 1000) + 11, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export class MultiKit implements Playable {
  ready: Promise<void>;
  /** One output bus per mic group; the engine routes them to the kit's aux tracks. */
  readonly outputs: Record<KitGroup, GainNode>;
  private pieces = new Map<number, { name: string; choke?: string; group?: string; layers: { power: number; files: [KitGroup, string][] }[] }>();
  private store: KitStore | null = null;
  private ringing = new Map<string, { src: AudioBufferSourceNode; g: GainNode; t: number }[]>();
  private all = new Set<AudioBufferSourceNode>();
  /** Hits still ringing per piece, for the voice limit. */
  private hits = new Map<string, { t: number; parts: { src: AudioBufferSourceNode; g: GainNode }[] }[]>();
  /** Last layer played per piece: a repeat would be the identical sample ("machine gun"). */
  private lastLayer = new Map<string, number>();

  constructor(private ctx: BaseAudioContext, fallback: AudioNode, id = "crocell") {
    this.outputs = Object.fromEntries(KIT_GROUPS.map((g) => [g, ctx.createGain()])) as Record<KitGroup, GainNode>;
    this.setOutputs({}, fallback);
    this.ready = Promise.all([fetchKit(id), kitStore(ctx, id)]).then(([{ manifest }, ks]) => {
      this.store = ks;
      for (const [name, pc] of Object.entries(manifest.pieces)) {
        const entry = {
          name,
          choke: pc.choke,
          group: pc.group,
          layers: [...pc.layers].sort((a, b) => a.power - b.power).map((l) => ({ power: l.power, files: Object.entries(l.files) as [KitGroup, string][] })),
        };
        for (const n of pc.gm) this.pieces.set(n, entry);
      }
      for (const [n, piece] of Object.entries(GM_EXTRA)) {
        const src = [...this.pieces.values()].find((p) => p.name === piece);
        if (src && !this.pieces.has(+n)) this.pieces.set(+n, src);
      }
    });
  }

  /** Route each group to its track (missing groups go to `fallback`, the kit's own strip). */
  private routed = new Map<KitGroup, AudioNode>();
  setOutputs(dests: Partial<Record<KitGroup, AudioNode>>, fallback: AudioNode) {
    for (const g of KIT_GROUPS) {
      // Only rewire what changed: a disconnect/reconnect mid-playback is an audible dropout.
      const to = dests[g] ?? fallback;
      if (this.routed.get(g) === to) continue;
      this.routed.set(g, to);
      this.outputs[g].disconnect();
      this.outputs[g].connect(dests[g] ?? fallback);
    }
  }

  start({ note, time, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const piece = this.pieces.get(note);
    if (!piece?.layers.length) return;
    const L = piece.layers.length;
    const v = Math.max(1, Math.min(127, velocity)) / 127;
    // Velocity → layer (slightly convex so mid velocities reach mid layers), ±1 layer for variation.
    let li = Math.round(Math.pow(v, 0.9) * (L - 1));
    // Seeded by note + time (not Math.random): the same variation on every playback and bounce.
    const h = hash01(note, time);
    const want = li; // the layer this velocity asks for
    if (L > 2 && h < 0.35) li = Math.max(0, Math.min(L - 1, li + (h < 0.175 ? -1 : 1)));
    // Anti machine-gun: never the same sample twice in a row on one piece (the kit has one sample
    // per layer, no round-robins) — take the neighbour closest in loudness instead.
    if (L > 1 && this.lastLayer.get(piece.name) === li) {
      const P = piece.layers.map((l) => l.power);
      const alt = [li - 1, li + 1].filter((i) => i >= 0 && i < L).sort((a, b) => Math.abs(Math.log(P[a] / P[li])) - Math.abs(Math.log(P[b] / P[li])) || (h < 0.5 ? a - b : b - a))[0];
      if (alt !== undefined && Math.abs(Math.log(P[alt] / P[want])) < Math.log(3)) li = alt;
    }
    this.lastLayer.set(piece.name, li);
    const layer = piece.layers[li];
    // Fine level within the layer so the whole velocity range is continuous.
    const center = (want + 0.5) / L;
    let level = Math.max(0.6, Math.min(1.25, Math.pow(v / center, 0.4)));
    // Played a different layer than the velocity asked for: match its loudness. Layer "power" is
    // energy-like (measured: RMS² ∝ power), so amplitude scales with √power.
    if (li !== want) level *= Math.max(0.5, Math.min(2, Math.sqrt(piece.layers[want].power / layer.power)));
    // Per-hit micro variation, identical on every mic of this hit (keeps the multitrack image coherent).
    const h2 = hash01(note + 128, time), h3 = hash01(note + 256, time);
    const rate = 1 + (h2 - 0.5) * 0.012; // ±0.6 % ≈ ±10 cents
    level *= 1 + (h3 - 0.5) * 0.1; // ±0.4 dB
    if (piece.choke)
      for (const r of this.ringing.get(piece.choke) ?? []) {
        if (r.t >= time) continue; // only hats that started earlier (notes may be scheduled out of order)
        r.g.gain.setTargetAtTime(0, time, 0.012);
        try { r.src.stop(time + 0.1); } catch { /* not started */ }
      }
    const parts: { src: AudioBufferSourceNode; g: GainNode }[] = [];
    for (const [g, file] of layer.files) {
      const buf = this.store?.get(file);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gain = this.ctx.createGain();
      gain.gain.value = level;
      src.connect(gain).connect(this.outputs[g]);
      src.start(time);
      this.all.add(src);
      parts.push({ src, g: gain });
      if (piece.group) {
        const arr = this.ringing.get(piece.group) ?? [];
        arr.push({ src, g: gain, t: time });
        this.ringing.set(piece.group, arr.slice(-14));
      }
      src.onended = () => {
        gain.disconnect();
        this.all.delete(src);
      };
    }
    this.limitVoices(piece.name, time, parts);
  }

  /**
   * Voice limit per piece (like a drum sampler): a re-struck cymbal keeps its last 3 hits ringing,
   * older ones fade out under the new hit. Without it a ridden crash stacks ~24 six-second hits on
   * 6–7 mics (≈ 130 sample voices) — enough to overload the audio thread and crackle live.
   */
  private limitVoices(name: string, time: number, parts: { src: AudioBufferSourceNode; g: GainNode }[]) {
    if (!parts.length) return;
    const cymbal = /crash|ride|china|splash/i.test(name);
    const max = 3;
    const list = (this.hits.get(name) ?? []).filter((h) => h.parts.some((p) => this.all.has(p.src)));
    list.push({ t: time, parts });
    list.sort((a, b) => a.t - b.t);
    while (list.length > max) {
      const old = list[0];
      if (old.t >= time) break; // only hits that started before this one (notes can be scheduled out of order)
      list.shift();
      for (const p of old.parts) {
        p.g.gain.setTargetAtTime(0, time, cymbal ? 0.02 : 0.01);
        try { p.src.stop(time + (cymbal ? 0.15 : 0.08)); } catch { /* already stopped */ }
      }
    }
    this.hits.set(name, list);
  }

  stopAll() {
    // Short fade instead of a hard stop: cutting ringing cymbals mid-wave clicks.
    const now = this.ctx.currentTime;
    for (const list of this.hits.values())
      for (const h of list)
        for (const p of h.parts) {
          const g = p.g.gain;
          if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(now);
          else g.cancelScheduledValues(now);
          g.setTargetAtTime(0, now, 0.005);
        }
    this.hits.clear();
    this.all.forEach((s) => { try { s.stop(now + 0.04); } catch { /* not started */ } });
    this.all.clear();
  }
  dispose() {
    this.stopAll();
    KIT_GROUPS.forEach((g) => this.outputs[g].disconnect());
  }
}

export const isMultiKit = (id?: string) => !!id?.startsWith("multikit:");
