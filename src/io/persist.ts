/**
 * Session persistence (IndexedDB). Survives tab close / reload.
 *  - "files":   original imported audio as compressed bytes (keyed by buffer id)
 *  - "session": project JSON + buffer provenance + view state
 * Stems are not stored: they are re-split from their parent on restore (deterministic, ~2 s).
 */
import { dspPool } from "../dsp/pool";
import { migrateChains } from "../model/chains";
import { memory } from "../system/memory";
import { bufferSources, emptyProject, pendingBuffers, store, type BufferSource, type UiState } from "../model/store";
import { defaultChannel, type Project, OLD_ROLE_COLORS } from "../model/types";
import { defaultParams } from "../plugins/defs";

const DB = "stemdaw";
const VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  dbPromise ??= openDb().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      for (const name of ["files", "session", "pcm"]) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(store: "files" | "session" | "pcm", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? (req.result as T) : undefined);
    t.onerror = () => rej(t.error);
  });
}

export const saveFile = (id: string, bytes: ArrayBuffer, name: string) => tx("files", "readwrite", (s) => void s.put({ bytes, name }, id));

/** AI stems can't be recomputed cheaply: keep them as 16-bit PCM (half the size of float). */
export async function savePcm(id: string, buf: AudioBuffer) {
  if (!(await memory.ensureDisk(buf.length * buf.numberOfChannels * 2, "the AI stems"))) return;
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => {
    const f = buf.getChannelData(c);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
    return i16;
  });
  await tx("pcm", "readwrite", (s) => void s.put({ sampleRate: buf.sampleRate, channels }, id));
}

async function loadPcm(id: string): Promise<AudioBuffer | null> {
  const rec = await tx<{ sampleRate: number; channels: Int16Array[] }>("pcm", "readonly", (s) => s.get(id));
  if (!rec) return null;
  const b = new AudioBuffer({ numberOfChannels: rec.channels.length, length: rec.channels[0].length, sampleRate: rec.sampleRate });
  rec.channels.forEach((i16, c) => {
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32767;
    b.copyToChannel(f, c);
  });
  return b;
}

const VIEW_KEYS = ["pxPerBeat", "trackHeight", "showInspector", "showLibrary", "showEditor", "editorTab", "editorHeight", "snap", "follow", "showAutomation", "rollMode", "selectedTrackId", "dpSession", "ppSession"] as const;

interface Session {
  project: Project;
  sources: [string, BufferSource][];
  view: Partial<UiState>;
  savedAt: number;
}

/** Buffer ids needed to rebuild everything the project references (including stem ancestors). */
function neededSources(p: Project, withHistory = true): Map<string, BufferSource> {
  const need = new Map<string, BufferSource>();
  const visit = (id: string) => {
    const src = bufferSources.get(id);
    if (!src || need.has(id)) return;
    need.set(id, src);
    if (src.type === "stem" || src.type === "processed") visit(src.parent);
  };
  for (const t of p.tracks) for (const c of t.clips) if (c.kind === "audio") visit(c.bufferId);
  for (const t of p.tracks) for (const l of Object.values(t.kitLayers ?? {})) if (l) visit(l.bufferId);
  for (const t of p.tracks) if (t.frozen) visit(t.frozen.bufferId);
  // Audio an undo step can bring back must stay on disk too.
  if (withHistory) for (const id of store.historyBuffers()) visit(id);
  return need;
}

/** Set when a restore failed: autosave stays off until the user really changes something. */
let restoreFailedAt: number | null = null;

async function saveSession() {
  const p = store.project;
  if (restoreFailedAt !== null && store.projectVersion === restoreFailedAt) return;
  const sources = neededSources(p);
  const view = Object.fromEntries(VIEW_KEYS.map((k) => [k, store.ui[k]])) as Partial<UiState>;
  const session: Session = { project: p, sources: [...sources], view, savedAt: Date.now() };
  await tx("session", "readwrite", (s) => void s.put(session, "current"));
  // Drop audio files nothing needs any more.
  const keys = (await tx<IDBValidKey[]>("files", "readonly", (s) => s.getAllKeys())) ?? [];
  const stale = keys.filter((k) => !sources.has(String(k)));
  if (stale.length) await tx("files", "readwrite", (s) => void stale.forEach((k) => s.delete(k)));
  const pcmKeys = (await tx<IDBValidKey[]>("pcm", "readonly", (s) => s.getAllKeys())) ?? [];
  const stalePcm = pcmKeys.filter((k) => !sources.has(String(k)));
  if (stalePcm.length) await tx("pcm", "readwrite", (s) => void stalePcm.forEach((k) => s.delete(k)));
}

/** Wipe the saved session (File → New). */
export async function clearSession() {
  await tx("session", "readwrite", (s) => void s.clear());
  await tx("files", "readwrite", (s) => void s.clear());
  await tx("pcm", "readwrite", (s) => void s.clear());
  bufferSources.clear();
  store.setProject(emptyProject());
}

/** Rebuild buffers: decode original files, re-split stems (parents first). */
async function rebuild(sources: Map<string, BufferSource>, decode: (b: ArrayBuffer) => Promise<AudioBuffer>) {
  const { registerBuffer } = await import("../assist/tracks");
  const { toAudioBuffer } = await import("../assist/separate");
  const splits = new Map<string, Promise<Awaited<ReturnType<typeof dspPool.separate>>>>();
  const made = new Map<string, Promise<AudioBuffer>>();
  const aiSplits = new Map<string, Promise<Record<string, AudioBuffer>>>();
  const build = (id: string): Promise<AudioBuffer> => {
    let pr = made.get(id);
    if (pr) return pr;
    const src = sources.get(id)!;
    pr = (async () => {
      if (src.type === "file") {
        const rec = await tx<{ bytes: ArrayBuffer }>("files", "readonly", (s) => s.get(id));
        if (!rec) throw new Error(`missing audio file for ${src.name}`);
        return decode(rec.bytes.slice(0));
      }
      if (src.type === "frozen") {
        const pcm = await loadPcm(id);
        if (!pcm) throw new Error("a frozen track's audio is missing (it was unfrozen)");
        return pcm;
      }
      if (src.type === "recorded") {
        const pcm = await loadPcm(id);
        if (!pcm) throw new Error("a recording's audio is missing from browser storage");
        return pcm;
      }
      if (src.type === "processed") {
        const pcm = await loadPcm(id);
        if (pcm) return pcm;
        const { dereverbDenoise } = await import("../ml/dpdfnet");
        const parent = await build(src.parent);
        return dereverbDenoise(parent, src.mix, (x) => store.busy("Restoring session: re-running dereverb…", x.progress));
      }
      if (src.engine === "ai") {
        const pcm = await loadPcm(id);
        if (pcm) return pcm;
        // PCM missing (storage cleared): fall back to re-running the model.
        const { demucsSeparate } = await import("../ml/demucs");
        let ai = aiSplits.get(src.parent);
        if (!ai) aiSplits.set(src.parent, (ai = build(src.parent).then((parent) => demucsSeparate(parent, (x) => store.busy("Restoring session: re-running AI stem split…", x.progress)))));
        return (await ai)[src.stem as keyof Awaited<typeof ai>];
      }
      const parent = await build(src.parent);
      let sp = splits.get(src.parent);
      if (!sp) splits.set(src.parent, (sp = dspPool.separate(parent, (x) => store.busy("Restoring session: re-splitting stems…", x))));
      return toAudioBuffer((await sp).stems[src.stem as "drums" | "bass" | "vocals" | "other"], parent.sampleRate);
    })();
    made.set(id, pr);
    return pr;
  };
  // One broken source must not sink the whole session: skip it (its clips are dropped by the caller).
  const failed: string[] = [];
  for (const id of sources.keys()) {
    try {
      const buf = await build(id);
      await registerBuffer(buf, id);
      bufferSources.set(id, sources.get(id)!);
    } catch (e) {
      failed.push(id);
      store.log(`Error: couldn't restore one audio source (${(e as Error).message}); its clips were removed.`);
    }
  }
  return failed;
}

/** Bring older saved projects up to the current model. */
function migrate(p: Project) {
  p.masterInserts ??= [];
  p.drumSessions ??= {};
  p.partSessions ??= {};
  for (const t of p.tracks) {
    t.inserts ??= [];
    t.color = OLD_ROLE_COLORS[t.color] ?? t.color;
    if (t.ch.compOn) {
      t.inserts.push({ id: `ins_m_${t.id}`, type: "compressor", on: true, params: { ...defaultParams("compressor"), threshold: t.ch.compThreshold, ratio: t.ch.compRatio } });
      t.ch.compOn = false;
    }
    const d = defaultChannel();
    for (const k of Object.keys(d) as (keyof typeof d)[]) if (t.ch[k] === undefined) (t.ch as unknown as Record<string, unknown>)[k] = d[k];
  }
  migrateChains(p);
}

let timer: number | undefined;
let lastSaved = -1;

/** Restore the previous session (if any), then autosave on every project/view change. */
export async function startPersistence(decode: (b: ArrayBuffer) => Promise<AudioBuffer>) {
  try {
    const s = await tx<Session>("session", "readonly", (st) => st.get("current"));
    if (s?.project?.tracks?.length) {
      store.busy("Restoring last session…", 0);
      // Keep a copy of the last good session before anything can overwrite it.
      await tx("session", "readwrite", (st) => void st.put(s, "backup"));
      const sources = new Map(s.sources);
      const failed = new Set(await rebuild(sources, decode));
      if (failed.size) for (const t of s.project.tracks) {
        t.clips = t.clips.filter((c) => c.kind !== "audio" || !failed.has(c.bufferId));
        if (t.frozen && failed.has(t.frozen.bufferId)) delete t.frozen;
      }
      store.setUi(s.view);
      migrate(s.project);
      store.setProject(s.project);
      pendingBuffers.clear();
      store.log(`Restored session "${s.project.name}" from ${new Date(s.savedAt).toLocaleString()}`);
      void import("../assist/separate").then((m) => m.ensureHarmonyAudio());
    }
  } catch (e) {
    restoreFailedAt = store.projectVersion; // don't let autosave replace the stored session with an empty one
    store.log(`Error: could not restore last session: ${(e as Error).message}. It's kept as a backup; autosave resumes once you change something.`);
  } finally {
    store.busy(null);
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(flush, 800);
  };
  // Save only when the project or the saved view state actually changed (not on every UI emit).
  let lastView = "";
  const flush = () => {
    clearTimeout(timer);
    const view = JSON.stringify(VIEW_KEYS.map((k) => store.ui[k]));
    if (store.projectVersion === lastSaved && view === lastView) return;
    lastSaved = store.projectVersion;
    lastView = view;
    saveSession().catch((e) => console.warn("autosave failed", e));
  };
  store.subscribe(() => {
    if (!store.ui.busy) schedule();
  });
  // Last chance when the tab is hidden/closed.
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.addEventListener("pagehide", flush);
}


/* ── project files (.otpadn): the project + every audio source it needs, in one file ──────────
 * Layout: "OTPADN\x01\n" · u32 header length (LE) · header JSON · raw blobs back to back.
 * Blobs: original files (compressed bytes as imported) and 16-bit PCM (recordings, AI stems,
 * cleaned audio). Quick-split (DSP) stems aren't stored: they're re-split from their parent on
 * load, exactly like a session restore. Opening writes the blobs into IndexedDB and runs the
 * normal restore, so an opened project behaves like the autosaved session.
 */
const MAGIC = "OTPADN\u0001\n";
interface BlobEntry { id: string; store: "files" | "pcm"; size: number; name?: string; sampleRate?: number; lengths?: number[] }
interface ProjectFileHeader { format: "otpadn"; version: 1; savedAt: number; project: Project; view: Partial<UiState>; sources: [string, BufferSource][]; blobs: BlobEntry[] }

const toPcm16 = (buf: AudioBuffer) => Array.from({ length: buf.numberOfChannels }, (_, c) => {
  const f = buf.getChannelData(c), i16 = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
  return i16;
});

export async function exportProjectFile(): Promise<Blob> {
  const { buffers } = await import("../model/store");
  const p = store.project;
  await saveSession().catch(() => undefined); // storage holds the current audio
  const parts: BlobPart[] = [], blobs: BlobEntry[] = [], sources: [string, BufferSource][] = [];
  for (const [id, src] of neededSources(p, false)) {
    if (src.type === "stem" && src.engine !== "ai") { sources.push([id, src]); continue; } // re-split on load
    if (src.type === "file") {
      const rec = await tx<{ bytes: ArrayBuffer; name: string }>("files", "readonly", (s) => s.get(id));
      if (rec) {
        parts.push(rec.bytes);
        blobs.push({ id, store: "files", size: rec.bytes.byteLength, name: rec.name });
        sources.push([id, src]);
        continue;
      }
    } else {
      const rec = await tx<{ sampleRate: number; channels: Int16Array[] }>("pcm", "readonly", (s) => s.get(id));
      if (rec) {
        rec.channels.forEach((c) => parts.push(c as Int16Array<ArrayBuffer>));
        blobs.push({ id, store: "pcm", size: rec.channels.reduce((a, c) => a + c.byteLength, 0), sampleRate: rec.sampleRate, lengths: rec.channels.map((c) => c.length) });
        sources.push([id, src]);
        continue;
      }
    }
    // Not in storage (quota skipped it): write the decoded audio as PCM; it opens as a plain recording.
    const buf = buffers.get(id);
    if (!buf) continue;
    const ch = toPcm16(buf);
    ch.forEach((c) => parts.push(c as Int16Array<ArrayBuffer>));
    blobs.push({ id, store: "pcm", size: ch.reduce((a, c) => a + c.byteLength, 0), sampleRate: buf.sampleRate, lengths: ch.map((c) => c.length) });
    sources.push([id, { type: "recorded" }]);
  }
  const view = Object.fromEntries(VIEW_KEYS.map((k) => [k, store.ui[k]])) as Partial<UiState>;
  const header: ProjectFileHeader = { format: "otpadn", version: 1, savedAt: Date.now(), project: p, view, sources, blobs };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([MAGIC, len, head, ...parts], { type: "application/x-otpadn" });
}

export async function importProjectFile(file: File, decode: (b: ArrayBuffer) => Promise<AudioBuffer>) {
  const lead = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (new TextDecoder().decode(lead.subarray(0, MAGIC.length)) !== MAGIC) throw new Error(`${file.name} is not an Otpadn project file.`);
  const hlen = new DataView(lead.buffer).getUint32(MAGIC.length, true);
  const header = JSON.parse(await file.slice(MAGIC.length + 4, MAGIC.length + 4 + hlen).text()) as ProjectFileHeader;
  if (header.format !== "otpadn") throw new Error(`${file.name} is not an Otpadn project file.`);
  await memory.ensure(file.size * 3, `opening ${file.name}`); // decoded audio is larger than the file
  store.busy(`Opening ${file.name}…`, 0);
  try {
    // Replace the stored session with the file's audio.
    await tx("files", "readwrite", (s) => void s.clear());
    await tx("pcm", "readwrite", (s) => void s.clear());
    bufferSources.clear();
    let off = MAGIC.length + 4 + hlen;
    for (const b of header.blobs) {
      const bytes = await file.slice(off, off + b.size).arrayBuffer();
      off += b.size;
      if (b.store === "files") await tx("files", "readwrite", (s) => void s.put({ bytes, name: b.name ?? "audio" }, b.id));
      else {
        let o = 0;
        const channels = (b.lengths ?? []).map((n) => { const c = new Int16Array(bytes, o, n); o += n * 2; return c; });
        await tx("pcm", "readwrite", (s) => void s.put({ sampleRate: b.sampleRate ?? 48000, channels }, b.id));
      }
    }
    const failed = new Set(await rebuild(new Map(header.sources), decode));
    const p = header.project;
    if (failed.size) for (const t of p.tracks) {
      t.clips = t.clips.filter((c) => c.kind !== "audio" || !failed.has(c.bufferId));
      if (t.frozen && failed.has(t.frozen.bufferId)) delete t.frozen;
    }
    store.setUi(header.view);
    migrate(p);
    store.setProject(p);
    pendingBuffers.clear();
    restoreFailedAt = null;
    await saveSession();
    void import("../assist/separate").then((m) => m.ensureHarmonyAudio());
    store.log(`Opened project "${p.name}" (saved ${new Date(header.savedAt).toLocaleString()})${failed.size ? ` — ${failed.size} audio source(s) couldn't be restored` : ""}`);
  } finally {
    store.busy(null);
  }
}
