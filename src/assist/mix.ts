import { renderProject } from "../engine/render";
import { isAudible } from "../engine/schedule";
import { dspPool } from "../dsp/pool";
import { store } from "../model/store";
import { uid, type ChannelSettings, type Project, type Role, type Track } from "../model/types";
import { defaultParams } from "../plugins/defs";
import { hasChain } from "../model/chains";

/** Track loudness target relative to a -18 LUFS reference, plus tone/space per role. */
interface RoleMix {
  rel: number;
  pan: number;
  ch: Partial<ChannelSettings>;
}

const ROLE_MIX: Record<Role, RoleMix> = {
  drums: { rel: 0, pan: 0, ch: { hpf: 30, eqLow: 1, eqMid: -1, eqMidFreq: 400, eqHigh: 1.5, compOn: true, compThreshold: -14, compRatio: 3, reverbSend: 0.06 } },
  bass: { rel: -2.5, pan: 0, ch: { hpf: 32, eqLow: 1.5, eqMid: -2, eqMidFreq: 250, eqHigh: -1, compOn: true, compThreshold: -20, compRatio: 4, reverbSend: 0 } },
  vocals: { rel: 0.5, pan: 0, ch: { hpf: 90, eqLow: -1, eqMid: -1.5, eqMidFreq: 320, eqHigh: 2, compOn: true, compThreshold: -22, compRatio: 3.5, reverbSend: 0.2 } },
  lead: { rel: -4, pan: 0, ch: { hpf: 150, eqMid: -1, eqMidFreq: 500, eqHigh: 1, compOn: true, compThreshold: -18, compRatio: 2.5, reverbSend: 0.22 } },
  keys: { rel: -6, pan: -0.35, ch: { hpf: 120, eqMid: -2, eqMidFreq: 400, eqHigh: 0.5, compOn: true, compThreshold: -18, compRatio: 2, reverbSend: 0.15 } },
  other: { rel: -4, pan: 0.35, ch: { hpf: 110, eqMid: -2, eqMidFreq: 350, eqHigh: 1, compOn: true, compThreshold: -18, compRatio: 2, reverbSend: 0.12 } },
  guitar: { rel: -4, pan: -0.4, ch: { hpf: 100, eqMid: -1.5, eqMidFreq: 300, eqHigh: 1, compOn: true, compThreshold: -18, compRatio: 2.5, reverbSend: 0.12 } },
  piano: { rel: -5, pan: 0.3, ch: { hpf: 60, eqMid: -1.5, eqMidFreq: 350, eqHigh: 0.5, compOn: true, compThreshold: -18, compRatio: 2, reverbSend: 0.16 } },
  pad: { rel: -10, pan: 0, ch: { hpf: 180, eqLow: -2, eqMid: -3, eqMidFreq: 400, compOn: false, reverbSend: 0.35 } },
  mix: { rel: 0, pan: 0, ch: {} },
};

const REF_LUFS = -18;
const MASTER_TARGET = -14; // streaming-ish loudness

/** Pick the 16-beat window where a track is busiest. */
function busiestWindow(p: Project, t: Track): [number, number] {
  const spb = 60 / p.bpm;
  const W = 16;
  let best = 0, bestScore = -1;
  for (let b = 0; b < p.lengthBeats - W; b += 4) {
    let score = 0;
    for (const c of t.clips) {
      if (c.kind === "midi") {
        for (const n of c.notes) {
          const at = c.start + n.start;
          if (at >= b && at < b + W) score += n.vel;
        }
      } else {
        const end = c.start + c.duration / spb;
        score += Math.max(0, Math.min(end, b + W) - Math.max(c.start, b));
      }
    }
    // Prefer loud sections for audio (energy) by section label.
    const sec = p.sections.find((s) => b >= s.start && b < s.start + s.length);
    if (sec) score *= 1 + sec.energy * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return [best, best + W];
}

async function measureTrack(p: Project, t: Track): Promise<number> {
  const [a, b] = busiestWindow(p, t);
  if (hasChain(t)) {
    // Pro-mix chains (kit mics + drum bus, sampled bass) are part of the sound: measure through
    // the whole strip, at a 0 dB fader.
    const buf = await renderProject(p, { fromBeat: a, toBeat: b, onlyTracks: [t.id], bypassMaster: true });
    return (await dspPool.lufs(buf)) - t.ch.volumeDb;
  }
  const buf = await renderProject(p, { fromBeat: a, toBeat: b, rawTracks: [t.id] });
  return dspPool.lufs(buf);
}

/** Run promises with limited concurrency (each offline render has its own audio thread). */
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

export async function autoMix() {
  const p = store.project;
  const tracks = p.tracks.filter((t) => isAudible(p, t) && t.role !== "mix" && t.clips.length);
  if (!tracks.length) throw new Error("Nothing to mix");

  // Same-role tracks get spread so they don't stack in the centre (except bass / vocals / drums).
  const roleCount = new Map<Role, number>();
  const panFor = (t: Track) => {
    const base = ROLE_MIX[t.role].pan;
    const k = roleCount.get(t.role) ?? 0;
    roleCount.set(t.role, k + 1);
    if (t.role === "bass" || t.role === "vocals" || t.role === "drums") return 0;
    if (k === 0) return base;
    const side = k % 2 ? -1 : 1;
    return Math.max(-0.7, Math.min(0.7, side * (Math.abs(base) + 0.2 * Math.ceil(k / 2))));
  };
  // Layers ("Gen ... (layer)") sit under the stems they reinforce.
  const layerOffset = (t: Track) => (/\(layer\)/.test(t.name) ? -7 : 0);

  let done = 0;
  store.busy("Measuring track loudness (offline render)…", 0);
  const measured = await pool(tracks, 3, async (t) => {
    const l = await measureTrack(p, t);
    store.busy("Measuring track loudness (offline render)…", ++done / tracks.length);
    return l;
  });

  store.update((pp) => {
    tracks.forEach((t, i) => {
      const tr = pp.tracks.find((x) => x.id === t.id)!;
      const rm = ROLE_MIX[t.role];
      const L = measured[i];
      const target = REF_LUFS + rm.rel + layerOffset(t);
      const gain = Number.isFinite(L) ? Math.max(-24, Math.min(18, target - L)) : 0;
      // A pro-mix chain keeps its own EQ / dynamics: the mix only sets the fader and pan.
      const chained = hasChain(t);
      tr.ch = chained ? { ...tr.ch, volumeDb: Math.round(gain * 10) / 10, pan: panFor(t) } : { ...tr.ch, ...rm.ch, volumeDb: Math.round(gain * 10) / 10, pan: panFor(t), compOn: false };
      // Role compression becomes a real compressor insert (re-used if one exists).
      tr.inserts ??= [];
      if (rm.ch.compOn && !chained) {
        let c = tr.inserts.find((i) => i.type === "compressor");
        if (!c) tr.inserts.push((c = { id: uid("ins"), type: "compressor", on: true, params: defaultParams("compressor") }));
        Object.assign(c.params, {
          threshold: rm.ch.compThreshold ?? -18,
          ratio: rm.ch.compRatio ?? 3,
          attack: t.role === "drums" ? 5 : t.role === "bass" ? 20 : 10,
          release: t.role === "vocals" ? 120 : 180,
          detector: t.role === "drums" ? 0 : 1,
        });
        c.on = true;
      }
      store.log(`Mix · ${t.name}: ${Number.isFinite(L) ? L.toFixed(1) : "silent"} LUFS → ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB, pan ${tr.ch.pan.toFixed(2)}`);
    });
    pp.masterDb = 0;
    // Gentle multiband glue on the master bus.
    pp.masterInserts ??= [];
    if (!pp.masterInserts.some((i) => i.type === "multiband"))
      pp.masterInserts.push({ id: uid("ins"), type: "multiband", on: true, params: { ...defaultParams("multiband"), thrL: -16, thrM: -18, thrH: -20, ratioL: 2, ratioM: 1.6, ratioH: 1.8 } });
  });

  // Master: two passes to land near the loudness target through the limiter.
  for (let pass = 0; pass < 2; pass++) {
    store.busy(`Mastering pass ${pass + 1}/2…`, pass / 2);
    const pp = store.project;
    const loud = [...pp.sections].sort((a, b) => b.energy - a.energy)[0];
    const from = loud?.start ?? 0;
    const buf = await renderProject(pp, { fromBeat: from, toBeat: from + Math.min(32, loud?.length ?? 32) });
    const L = await dspPool.lufs(buf);
    if (!Number.isFinite(L)) break;
    const delta = MASTER_TARGET - L;
    store.update((x) => {
      x.masterDb = Math.round(Math.max(-12, Math.min(14, x.masterDb + delta)) * 10) / 10;
    });
    store.log(`Master pass ${pass + 1}: ${L.toFixed(1)} LUFS (chorus) → master ${store.project.masterDb} dB`);
    if (Math.abs(delta) < 0.5) break;
  }
  store.busy(null);
}
