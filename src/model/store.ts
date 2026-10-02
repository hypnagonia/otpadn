import { useSyncExternalStore } from "react";
import type { Project } from "./types";

/** Decoded audio lives outside the project so the project stays serialisable. */
export const buffers = new Map<string, AudioBuffer>();

/**
 * How each buffer was made, so a session can be rebuilt after the tab closes without
 * storing hundreds of MB of PCM: original files are kept as bytes, stems are re-split.
 */
export type BufferSource =
  | { type: "file"; name: string }
  /** engine "dsp": re-split on restore (deterministic). engine "ai": 16-bit PCM kept in IndexedDB. */
  | { type: "stem"; parent: string; stem: string; engine?: "dsp" | "ai" }
  /** Result of a one-time processing op (dereverb + denoise); PCM kept in IndexedDB. */
  | { type: "processed"; parent: string; op: "dpdfnet"; mix: number }
  /** Recorded from an input; PCM kept in IndexedDB. */
  | { type: "recorded" };
export const bufferSources = new Map<string, BufferSource>();
export const peaksCache = new Map<string, Float32Array>(); // interleaved min/max per PEAK_BLOCK samples
export const PEAK_BLOCK = 256;

export const emptyProject = (): Project => ({
  name: "Untitled",
  bpm: 120,
  key: null,
  sections: [],
  chords: [],
  tracks: [],
  masterDb: 0,
  masterInserts: [],
  loop: { on: false, start: 0, end: 16 },
  lengthBeats: 64,
});

type Listener = () => void;
type Snap = { json: string; bufs: Set<string> };
const snapBytes = (s: Snap) => s.json.length * 2; // UTF-16

import type { Tool } from "../edit/ops";
import { memory } from "../system/memory";
import { syncAuxTracks } from "./auxTracks";

export type EditorTab = "mixer" | "eq" | "plugin" | "piano" | "drums" | "parts" | "console";

export interface UiState {
  selectedTrackId: string | null;
  selectedClipId: string | null;
  /** Panels, Logic-style: Inspector (I), Library (Y), Editor pane (E) with Mixer (X) / Piano Roll (P). */
  showInspector: boolean;
  showLibrary: boolean;
  showEditor: boolean;
  editorTab: EditorTab;
  editorHeight: number;
  pxPerBeat: number;
  trackHeight: number;
  tool: Tool;
  snap: number; // beats, 0 = off
  follow: boolean; // catch playhead
  rollMode: "bricks" | "tab"; // MIDI editor view
  selectedInsert: { owner: string; id: string } | null; // plugin shown in the editor pane
  armedTrackId: string | null; // audio track that records
  contextMenu: { x: number; y: number; trackId: string | null; clipId: string | null; beat: number } | null;
  /** Range-tool selection: a time slice on some tracks (montage edits). */
  range: { start: number; end: number; trackIds: string[] } | null;
  busy: { label: string; progress: number } | null;
  log: string[];
  /** Drum Producer session shown in the "drum producer" tab. */
  dpSession: string | null;
  /** Part Producer session shown in the "part producer" tab. */
  ppSession: string | null;
}

class Store {
  project: Project = emptyProject();
  ui: UiState = {
    selectedTrackId: null,
    selectedClipId: null,
    showInspector: true,
    showLibrary: false,
    showEditor: true,
    editorTab: "mixer",
    editorHeight: 360,
    pxPerBeat: 24,
    trackHeight: 56,
    tool: "pointer",
    snap: 1,
    follow: true,
    rollMode: "bricks",
    selectedInsert: null,
    armedTrackId: null,
    contextMenu: null,
    range: null,
    busy: null,
    log: [],
    dpSession: null,
    ppSession: null,
  };
  private listeners = new Set<Listener>();
  private version = 0;
  /** Bumped only by project mutations (UI-only changes don't touch it). */
  projectVersion = 0;
  private lastBusyEmit = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /* ── undo / redo: JSON snapshots of the project; rapid edits (drags) coalesce into one step ── */
  private past: Snap[] = [];
  private future: Snap[] = [];
  private lastEdit = 0;
  private static readonly COALESCE_MS = 600;
  private static readonly MAX_HISTORY = 150;

  private snap(): Snap {
    const bufs = new Set<string>();
    for (const t of this.project.tracks) for (const c of t.clips) if (c.kind === "audio") bufs.add(c.bufferId);
    return { json: JSON.stringify(this.project), bufs };
  }

  /** Mutate the project in place, then notify. Records an undo step (merged with edits < 600 ms apart). */
  update(fn: (p: Project) => void) {
    const now = performance.now();
    if (now - this.lastEdit > Store.COALESCE_MS) {
      this.past.push(this.snap());
      this.future = [];
      this.capHistory();
    }
    this.lastEdit = now;
    fn(this.project);
    this.projectChanged();
  }
  /** Replace the whole project (import / new / restore): starts a fresh history. */
  setProject(p: Project) {
    this.project = p;
    this.past = [];
    this.future = [];
    this.projectChanged();
  }
  /** Start a new undo step with the next edit (a new gesture), even if it comes < 600 ms after the last one. */
  checkpoint() {
    this.lastEdit = 0;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snap());
    this.project = JSON.parse(prev.json);
    this.lastEdit = 0;
    this.projectChanged();
  }
  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snap());
    this.project = JSON.parse(next.json);
    this.lastEdit = 0;
    this.projectChanged();
  }
  /** Keep undo history within its step and byte limits (a slice of the memory budget). */
  capHistory(maxBytes = Math.min(96 * 1024 * 1024, memory.budget() * 0.04)) {
    let bytes = [...this.past, ...this.future].reduce((n, s) => n + snapBytes(s), 0);
    while (this.past.length && (this.past.length > Store.MAX_HISTORY || bytes > maxBytes)) bytes -= snapBytes(this.past.shift()!);
    memory.track("history", bytes, "history", "undo history");
    return bytes;
  }
  /** Drop all but the last `keep` undo steps; returns bytes freed. */
  trimHistory(keep: number): number {
    const before = [...this.past, ...this.future].reduce((n, s) => n + snapBytes(s), 0);
    this.past = this.past.slice(-keep);
    this.future = [];
    const after = this.capHistory();
    return before - after;
  }

  /** Buffer ids still referenced by any undo/redo step (kept alive by the GC). */
  historyBuffers(): Set<string> {
    const s = new Set<string>();
    for (const h of [...this.past, ...this.future]) h.bufs.forEach((b) => s.add(b));
    return s;
  }
  private projectChanged() {
    syncAuxTracks(this.project);
    this.project.lengthBeats = computeLength(this.project);
    this.projectVersion++;
    gcBuffers(this.project, this.historyBuffers());
    this.emit();
  }
  /** Bumped only when a UI field actually changes value (not by progress, log lines or empty repaints). */
  uiVersion = 0;
  setUi(patch: Partial<UiState>) {
    const changed = (Object.keys(patch) as (keyof UiState)[]).some((k) => this.ui[k] !== patch[k]);
    this.ui = { ...this.ui, ...patch };
    if (changed) this.uiVersion++;
    this.emit();
  }
  log(msg: string) {
    const t = new Date().toLocaleTimeString();
    this.ui = { ...this.ui, log: [...this.ui.log.slice(-300), `[${t}] ${msg}`] };
    this.emit();
  }
  busy(label: string | null, progress = 0) {
    // Progress callbacks fire hundreds of times; repaint at most ~12×/s.
    const now = performance.now();
    if (label && this.ui.busy?.label === label && progress < 1 && now - this.lastBusyEmit < 80) {
      this.ui.busy.progress = progress;
      return;
    }
    this.lastBusyEmit = now;
    this.ui = { ...this.ui, busy: label ? { label, progress } : null };
    this.emit();
  }
}

/** Drop decoded audio no clip references any more (e.g. stems from a previous analysis). */
function gcBuffers(p: Project, keep: Set<string>) {
  const used = new Set<string>(keep);
  for (const t of p.tracks) for (const c of t.clips) if (c.kind === "audio") used.add(c.bufferId);
  for (const id of buffers.keys())
    if (!used.has(id) && !pendingBuffers.has(id)) {
      buffers.delete(id);
      peaksCache.delete(id);
      memory.untrack(`buf:${id}`);
    }
}

/** Buffers registered but not yet placed in the project (mid-analysis). */
export const pendingBuffers = new Set<string>();

function computeLength(p: Project): number {
  let end = 16;
  const spb = 60 / p.bpm;
  for (const t of p.tracks)
    for (const c of t.clips) {
      const len = c.kind === "midi" ? c.length : c.duration / spb;
      end = Math.max(end, c.start + len);
    }
  return Math.ceil(end / 4) * 4 + 8;
}

export const store = new Store();

export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

const quietKey = () => `${store.projectVersion}:${store.uiVersion}`;
/**
 * Like useStore, but re-renders only when the project or a UI field changes — not for busy
 * progress, log lines or transport repaints (those fire many times per second). Use it in
 * anything that doesn't display progress, the log or the play state.
 */
export function useStoreQuiet() {
  useSyncExternalStore(store.subscribe, quietKey);
  return store;
}

// Old undo steps are the cheapest thing to give back under memory pressure.
// Registered after module init: store.ts and system/memory.ts import each other, so `memory`
// may not exist yet while this module evaluates (blank page in dev and prod).
queueMicrotask(() => memory.reclaimer("undo history", 10, () => store.trimHistory(5)));
