import type { ChannelSettings } from "../model/types";

/**
 * Exact magnitude response of a channel's EQ, computed with real BiquadFilterNodes
 * (same filter math as playback) on a 1-sample OfflineAudioContext that is never rendered.
 */
let ctx: OfflineAudioContext | null = null;
let nodes: BiquadFilterNode[] = [];

export type EqBandId = "hpf" | "low" | "mid" | "mid2" | "high" | "lpf";

export function bandParams(ch: ChannelSettings): { id: EqBandId; type: BiquadFilterType; f: number; g: number; q: number; on: boolean }[] {
  return [
    { id: "hpf", type: "highpass", f: ch.hpf || 20, g: 0, q: 0.707, on: ch.hpf > 0 },
    { id: "low", type: "lowshelf", f: ch.eqLowFreq, g: ch.eqLow, q: 1, on: ch.eqLow !== 0 },
    { id: "mid", type: "peaking", f: ch.eqMidFreq, g: ch.eqMid, q: ch.eqMidQ, on: ch.eqMid !== 0 },
    { id: "mid2", type: "peaking", f: ch.eqMid2Freq, g: ch.eqMid2, q: ch.eqMid2Q, on: ch.eqMid2 !== 0 },
    { id: "high", type: "highshelf", f: ch.eqHighFreq, g: ch.eqHigh, q: 1, on: ch.eqHigh !== 0 },
    { id: "lpf", type: "lowpass", f: ch.lpf || 20000, g: 0, q: 0.707, on: ch.lpf > 0 },
  ];
}

/** dB response at each frequency in `freqs`. */
export function eqResponse(ch: ChannelSettings, freqs: Float32Array): Float32Array {
  ctx ??= new OfflineAudioContext(1, 1, 48000);
  if (!nodes.length) nodes = Array.from({ length: 6 }, () => ctx!.createBiquadFilter());
  const total = new Float32Array(freqs.length);
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  bandParams(ch).forEach((b, i) => {
    if (!b.on) return;
    const n = nodes[i];
    n.type = b.type;
    n.frequency.value = b.f;
    n.gain.value = b.g;
    n.Q.value = b.q;
    n.getFrequencyResponse(freqs as Float32Array<ArrayBuffer>, mag as Float32Array<ArrayBuffer>, phase as Float32Array<ArrayBuffer>);
    for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k] + 1e-9);
  });
  return total;
}
