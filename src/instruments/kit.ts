/**
 * Acoustic drum kit: CC0 "Virtuosity Drums" (sfzinstruments), thin subset — one stereo mic pair,
 * 2–3 velocity layers per piece (~8 MB). Lazy: samples load on first use, cached by the browser.
 */
import type { Playable } from "./types";

const BASE = "https://cdn.jsdelivr.net/gh/sfzinstruments/virtuosity_drums@master/Samples/mid/";
const FALLBACK = "https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/master/Samples/mid/";
const CACHE = "stemdaw-samples";

type Piece = { files: string[]; choke?: string; group?: string };
/** Files per piece, softest → hardest velocity layer. */
const PIECES: Record<string, Piece> = {
  kick: { files: ["kick/mid_kick_snon_vl2_rr1.flac", "kick/mid_kick_snon_vl4_rr1.flac"] },
  snare: { files: ["snare/mid_snare_center_vl12.flac", "snare/mid_snare_center_vl24.flac", "snare/mid_snare_center_vl36.flac"] },
  rimshot: { files: ["snare/mid_snare_rimshot_vl12.flac"] },
  xstick: { files: ["snare/mid_snare_crossstick_vl12.flac"] },
  hhClosed: { files: ["hh/mid_hh_closed_vl2_rr1.flac", "hh/mid_hh_closed_vl4_rr1.flac"], choke: "hh", group: "hh" },
  hhPedal: { files: ["hh/mid_hh_pedal_vl3_rr1.flac"], choke: "hh", group: "hh" },
  hhOpen: { files: ["hh/mid_hh_open_vl4_rr1.flac"], group: "hh" },
  tomHi: { files: ["htom/mid_htom_center_vl8.flac", "htom/mid_htom_center_vl16.flac"] },
  tomLo: { files: ["ltom/mid_ltom_center_vl8.flac", "ltom/mid_ltom_center_vl16.flac"] },
  crash: { files: ["crash/mid_crash_crash_vl2_rr1.flac", "crash/mid_crash_crash_vl3_rr1.flac"] },
  ride: { files: ["ride/mid_ride_ride_vl3_rr1.flac"] },
  rideBell: { files: ["ride/mid_ride_bell_vl3_rr1.flac"] },
};

/** General MIDI drum map → piece. */
const GM: Record<number, string> = {
  35: "kick", 36: "kick", 37: "xstick", 38: "snare", 39: "rimshot", 40: "rimshot",
  41: "tomLo", 43: "tomLo", 45: "tomLo", 47: "tomHi", 48: "tomHi", 50: "tomHi",
  42: "hhClosed", 44: "hhPedal", 46: "hhOpen", 49: "crash", 57: "crash", 51: "ride", 59: "ride", 53: "rideBell",
};

async function fetchCached(path: string): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(BASE + path);
  if (hit) return hit.arrayBuffer();
  let res = await fetch(BASE + path).catch(() => null);
  if (!res?.ok) res = await fetch(FALLBACK + path);
  if (!res.ok) throw new Error(`drum sample ${path}: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  cache?.put(BASE + path, new Response(bytes.slice(0)));
  return bytes;
}

export class AcousticKit implements Playable {
  ready: Promise<void>;
  private bufs = new Map<string, AudioBuffer[]>();
  private ringing = new Map<string, { src: AudioBufferSourceNode; g: GainNode; t: number }[]>();
  private all = new Set<AudioBufferSourceNode>();
  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {
    this.ready = Promise.all(
      Object.entries(PIECES).map(async ([name, p]) => {
        const layers = await Promise.all(p.files.map(async (f) => ctx.decodeAudioData(await fetchCached(f))));
        this.bufs.set(name, layers);
      }),
    ).then(() => undefined);
  }
  start({ note, time, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const name = GM[note];
    const piece = name ? PIECES[name] : undefined;
    const layers = name ? this.bufs.get(name) : undefined;
    if (!piece || !layers?.length) return;
    const v = velocity / 127;
    const buf = layers[Math.min(layers.length - 1, Math.floor(v * layers.length))];
    // Hi-hat choke: closed/pedal cut a ringing open hat.
    if (piece.choke)
      for (const r of this.ringing.get(piece.choke) ?? []) {
        if (r.t >= time) continue; // only hats that started earlier (notes may be scheduled out of order)
        r.g.gain.setTargetAtTime(0, time, 0.01);
        r.src.stop(time + 0.08);
      }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.25 + 0.75 * v * v;
    src.connect(g).connect(this.dest);
    src.start(time);
    this.all.add(src);
    if (piece.group) {
      const arr = this.ringing.get(piece.group) ?? [];
      arr.push({ src, g, t: time });
      this.ringing.set(piece.group, arr.slice(-4));
    }
    src.onended = () => {
      g.disconnect();
      this.all.delete(src);
    };
  }
  stopAll() {
    this.all.forEach((s) => { try { s.stop(); } catch { /* not started */ } });
    this.all.clear();
  }
  dispose() {
    this.stopAll();
  }
}
