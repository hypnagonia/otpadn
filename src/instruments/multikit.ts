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

/*
 * Stores are keyed by kit + sample rate, not by context: AudioBuffers aren't tied to a context,
 * so live playback and every offline render at the same rate (auto-mix runs N+2 of them) share
 * one decode. A store no context uses any more is released after a minute, or at once under
 * memory pressure; the live context's store stays.
 */
const stores = new Map<string, Promise<KitStore>>();
const users = new Map<string, { live: boolean; offline: number; timer?: number }>();
const live = new Set<KitStore>();
const seen = new WeakMap<BaseAudioContext, Set<string>>();

function dropStore(key: string) {
  const u = users.get(key);
  if (!u || u.live || u.offline > 0) return 0;
  const p = stores.get(key);
  stores.delete(key);
  users.delete(key);
  const freed = memory.byKey(`kit:${key}`);
  p?.then((ks) => ks.release());
  return freed;
}
memory.reclaimer("drum kit playback cache", 25, async () => {
  let n = 0;
  for (const k of [...stores.keys()]) n += dropStore(k);
  for (const ks of live) n += ks.dropCache();
  return n;
});

function kitStore(ctx: BaseAudioContext, id: string): Promise<KitStore> {
  const key = `${id}:${ctx.sampleRate}`;
  // Count each context once per kit.
  let mine = seen.get(ctx);
  if (!mine) seen.set(ctx, (mine = new Set()));
  if (!mine.has(key)) {
    mine.add(key);
    let u = users.get(key);
    if (!u) users.set(key, (u = { live: false, offline: 0 }));
    clearTimeout(u.timer);
    if (ctx instanceof AudioContext) u.live = true;
    else {
      u.offline++;
      ctx.addEventListener?.("complete", () => {
        const cur = users.get(key);
        if (!cur) return;
        cur.offline--;
        if (!cur.live && cur.offline <= 0) cur.timer = window.setTimeout(() => dropStore(key), 60_000);
      });
    }
  }
  let p = stores.get(key);
  if (!p) {
    p = (async () => {
      await memory.ensure(220 * 1024 * 1024, "loading the multitrack drum kit");
      const { files } = await fetchKit(id);
      const ks = new KitStore(ctx, `kit:${key}`, files);
      await ks.ready;
      if (ctx instanceof AudioContext) live.add(ks);
      return ks;
    })();
    p.catch(() => stores.delete(key));
    stores.set(key, p);
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

/** Kit pieces that trigger a sample layer slot (slot name = the mic group it plays into). */
const LAYER_SLOT: Record<string, string> = { KDrumR: "kick", Snare: "snare" };
/** Drum pieces (vs cymbals) and the mic groups that are meant for cymbals. */
const DRUM_PIECES = new Set(["KDrumR", "Snare", "Tom1", "Tom2", "FTom1"]);
const CYMBAL_PIECES = new Set(["HihatClosed", "HihatOpen", "HihatPedal", "CrashL", "RideR", "RideRBell"]);
const CYMBAL_MICS = new Set<KitGroup>(["hihat", "ride", "overheads"]);

export class MultiKit implements Playable {
  ready: Promise<void>;
  /** One output bus per mic group; the engine routes them to the kit's aux tracks. */
  readonly outputs: Record<KitGroup, GainNode>;
  private pieces = new Map<number, { name: string; choke?: string; group?: string; layers: { power: number; files: [KitGroup, string][] }[] }>();
  private store: KitStore | null = null;
  private ringing = new Map<string, { src: AudioBufferSourceNode; g: GainNode; t: number }[]>();
  private layers: Partial<Record<string, { buffer: AudioBuffer; level: number }>> = {};
  setLayers(layers: Partial<Record<string, { buffer: AudioBuffer; level: number }>>) {
    this.layers = layers;
  }
  private cymbalBleed = 1; // linear gain of drum hits in the cymbal mics
  setCymbalBleed(db: number) {
    this.cymbalBleed = db <= -60 ? 0 : Math.pow(10, db / 20);
  }
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
    // Velocity → loudness, like a player: amplitude ∝ velocity^1.5 (110 ≈ −1.9 dB, 70 ≈ −7.8 dB,
    // 30 ≈ −19 dB re the hardest hit); cymbals a little steeper (played more dynamically). The
    // recorded layer nearest that loudness is played and trimmed the rest of the way, so the same
    // velocity sounds the same on every piece however its layers are spaced.
    const cym = CYMBAL_PIECES.has(piece.name);
    const P = piece.layers.map((l) => l.power), Pmax = P[L - 1];
    const layerDb = P.map((x) => 10 * Math.log10(Math.max(1e-12, x) / Pmax)); // power is energy-like
    const target = (cym ? 36 : 30) * Math.log10(v); // 110 ≈ −1.9 dB, 70 ≈ −7.8 dB, 30 ≈ −19 dB (cymbals steeper)
    let want = 0;
    for (let i = 1; i < L; i++) if (Math.abs(layerDb[i] - target) < Math.abs(layerDb[want] - target)) want = i;
    let li = want;
    // Seeded by note + time (not Math.random): the same variation on every playback and bounce.
    const h = hash01(note, time);
    // ±1 layer for timbre variety, only to a neighbour within 3 dB of the target.
    if (L > 2 && h < 0.35) {
      const nb = Math.max(0, Math.min(L - 1, li + (h < 0.175 ? -1 : 1)));
      if (Math.abs(layerDb[nb] - target) < 3) li = nb;
    }
    // Anti machine-gun: never the same sample twice in a row on one piece (one sample per layer).
    if (L > 1 && this.lastLayer.get(piece.name) === li) {
      const alt = [li - 1, li + 1].filter((i) => i >= 0 && i < L).sort((x, y) => Math.abs(layerDb[x] - target) - Math.abs(layerDb[y] - target))[0];
      if (alt !== undefined && Math.abs(layerDb[alt] - target) < 4.5) li = alt;
    }
    this.lastLayer.set(piece.name, li);
    const layer = piece.layers[li];
    // trim the chosen layer to the target loudness (bounded: a layer never stretched > ±6 dB)
    let level = Math.pow(10, Math.max(-6, Math.min(6, target - layerDb[li])) / 20);
    // Per-hit micro variation, identical on every mic of this hit (keeps the multitrack image coherent).
    const h2 = hash01(note + 128, time), h3 = hash01(note + 256, time);
    const rate = 1 + (h2 - 0.5) * 0.012; // ±0.6 % ≈ ±10 cents
    level *= 1 + (h3 - 0.5) * (cym ? 0.3 : 0.1); // ±0.4 dB drums, ±1.2 dB cymbals (no two strokes alike)
    if (piece.choke)
      for (const r of this.ringing.get(piece.choke) ?? []) {
        if (r.t >= time) continue; // only hats that started earlier (notes may be scheduled out of order)
        r.g.gain.setTargetAtTime(0, time, 0.012);
        try { r.src.stop(time + 0.1); } catch { /* not started */ }
      }
    const parts: { src: AudioBufferSourceNode; g: GainNode }[] = [];
    const drum = DRUM_PIECES.has(piece.name);
    for (const [g, file] of layer.files) {
      // Cymbal mics hearing the drums: scaled (modern metal keeps them cymbals-only).
      const bleed = drum && CYMBAL_MICS.has(g as KitGroup) ? this.cymbalBleed : 1;
      if (bleed === 0) continue;
      const buf = this.store?.get(file);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gain = this.ctx.createGain();
      gain.gain.value = level * bleed;
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
    // Sample layer (reinforcement): one-shot into the same mic group, following the hit's velocity.
    const slot = LAYER_SLOT[piece.name], lay = slot && this.layers[slot];
    const out = slot && this.outputs[slot as KitGroup];
    if (lay && out) {
      const src = this.ctx.createBufferSource();
      src.buffer = lay.buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = Math.pow(10, lay.level / 20) * Math.pow(v, 1.3) * (1 + (h3 - 0.5) * 0.1);
      src.connect(gain).connect(out);
      src.start(time);
      this.all.add(src);
      parts.push({ src, g: gain });
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
