/**
 * Audio recording from a microphone / interface into an audio track, with count-in.
 * Raw float PCM is captured by an AudioWorklet (no lossy encoding), trimmed to the punch-in
 * point and shifted by the measured round-trip latency so it lines up with what was heard.
 */
import { audioTrack, registerBuffer } from "../assist/tracks";
import { savePcm } from "../io/persist";
import { bufferSources, pendingBuffers, store } from "../model/store";
import { uid } from "../model/types";
import { ensureWorklets } from "../plugins/nodes";
import { est, memory } from "../system/memory";
import { engine } from "./transport";

interface Session {
  stream: MediaStream;
  node: AudioWorkletNode;
  src: MediaStreamAudioSourceNode;
  sink: GainNode;
  chunks: { frame: number; l: Float32Array; r: Float32Array }[];
  fromBeat: number;
  keepFromFrame: number;
  trackId: string | null;
}

let session: Session | null = null;
let starting = false;
export const isRecording = () => !!session || starting;

/** Start recording on the armed audio track (or a new one) at the playhead, after the count-in. */
export async function startRecording() {
  if (session || starting) return;
  starting = true; // guards the awaits below against a second press
  let stream: MediaStream | null = null;
  try {
    stream = await openAndStart();
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    throw e;
  } finally {
    starting = false;
  }
}

async function openAndStart(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't record audio (no microphone access API).");
  await memory.ensure(est.pcm(300, engine.ctx.sampleRate, 2), "recording (5 min headroom)");
  const ctx = engine.ctx;
  if (ctx.state !== "running") await ctx.resume();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  });
  await ensureWorklets(ctx);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "otpadn-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
  const sink = ctx.createGain();
  sink.gain.value = 0; // keeps the worklet pulled without monitoring the input (no feedback)
  src.connect(node).connect(sink).connect(ctx.destination);
  const armed = store.project.tracks.find((t) => t.id === store.ui.armedTrackId && t.kind === "audio");
  const fromBeat = Math.max(0, engine.beat);
  const s: Session = { stream, node, src, sink, chunks: [], fromBeat, keepFromFrame: Infinity, trackId: armed?.id ?? null };
  node.port.onmessage = (e) => {
    s.chunks.push(e.data);
    memory.track("recording", s.chunks.reduce((n, c) => n + c.l.byteLength * 2, 0), "transient", "recording in progress");
  };
  session = s;
  await engine.play(fromBeat, { countIn: true });
  engine.onTransportJump = () => void stopRecording(); // seeking ends the take (it stays aligned)
  // What was heard at the punch-in arrives at the input one round trip later.
  const roundTrip = (ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0);
  s.keepFromFrame = Math.round((engine.timeOfBeat(fromBeat) + roundTrip) * ctx.sampleRate);
  store.setUi({});
  store.log(`Recording from bar ${Math.floor(fromBeat / 4) + 1} (count-in ${engine.countInBars} bar, latency comp ${(roundTrip * 1000).toFixed(0)} ms)`);
  return stream;
}

export async function stopRecording() {
  const s = session;
  if (!s) return;
  session = null;
  engine.onTransportJump = null;
  engine.stop();
  s.node.port.postMessage("flush");
  await new Promise((r) => setTimeout(r, 120)); // let the flushed tail arrive
  s.src.disconnect();
  s.node.disconnect();
  s.sink.disconnect();
  s.stream.getTracks().forEach((t) => t.stop());
  memory.untrack("recording");
  const sr = engine.ctx.sampleRate;
  const parts = s.chunks.filter((c) => c.frame + c.l.length > s.keepFromFrame);
  const total = parts.reduce((n, c) => n + c.l.length - Math.max(0, s.keepFromFrame - c.frame), 0);
  if (total < sr * 0.1) {
    store.log("Recording too short — nothing kept.");
    store.setUi({});
    return;
  }
  const buf = new AudioBuffer({ numberOfChannels: 2, length: total, sampleRate: sr });
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let o = 0;
  for (const c of parts) {
    const skip = Math.max(0, s.keepFromFrame - c.frame);
    L.set(c.l.subarray(skip), o);
    R.set(c.r.subarray(skip), o);
    o += c.l.length - skip;
  }
  const id = await registerBuffer(buf);
  bufferSources.set(id, { type: "recorded" });
  savePcm(id, buf).catch((e) => store.log(`Error: couldn't store the recording: ${e}`));
  store.update((p) => {
    const target = s.trackId ? p.tracks.find((t) => t.id === s.trackId) : undefined;
    if (target) {
      target.clips.push({ id: uid("clip"), kind: "audio", start: s.fromBeat, bufferId: id, offset: 0, duration: buf.duration });
    } else {
      const t = audioTrack(`Audio ${p.tracks.filter((x) => x.kind === "audio").length + 1}`, "other", id, s.fromBeat);
      p.tracks.push(t);
      store.ui.armedTrackId = t.id;
    }
  });
  pendingBuffers.clear();
  store.log(`Recorded ${buf.duration.toFixed(1)} s`);
}

export const toggleRecording = () => (session ? stopRecording() : startRecording());
