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
import { defaultChannel, type Project } from "../model/types";
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

const VIEW_KEYS = ["pxPerBeat", "trackHeight", "showInspector", "showLibrary", "showEditor", "editorTab", "editorHeight", "snap", "follow", "rollMode", "selectedTrackId", "dpSession", "ppSession"] as const;

interface Session {
  project: Project;
  sources: [string, BufferSource][];
  view: Partial<UiState>;
  savedAt: number;
}

/** Buffer ids needed to rebuild everything the project references (including stem ancestors). */
function neededSources(p: Project): Map<string, BufferSource> {
  const need = new Map<string, BufferSource>();
  const visit = (id: string) => {
    const src = bufferSources.get(id);
    if (!src || need.has(id)) return;
    need.set(id, src);
    if (src.type === "stem" || src.type === "processed") visit(src.parent);
  };
  for (const t of p.tracks) for (const c of t.clips) if (c.kind === "audio") visit(c.bufferId);
  // Audio an undo step can bring back must stay on disk too.
  for (const id of store.historyBuffers()) visit(id);
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
      if (failed.size) for (const t of s.project.tracks) t.clips = t.clips.filter((c) => c.kind !== "audio" || !failed.has(c.bufferId));
      store.setUi(s.view);
      migrate(s.project);
      store.setProject(s.project);
      pendingBuffers.clear();
      store.log(`Restored session "${s.project.name}" from ${new Date(s.savedAt).toLocaleString()}`);
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

