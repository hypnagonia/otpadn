/** Save / open whole projects as .otpadn files (project + its audio), see persist.ts. */
import { engine } from "../engine/transport";
import { store } from "../model/store";
import { confirmDialog } from "../ui/common/Dialog";
import { exportProjectFile, importProjectFile } from "./persist";

export const isProjectFile = (f: File) => /\.otpadn$/i.test(f.name);

export async function saveProjectToDisk() {
  const name = `${(store.project.name || "untitled").replace(/[\\/:*?"<>|]+/g, "-")}.otpadn`;
  // The save dialog must open inside the click; the file is built after a location is chosen.
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  let handle: FileSystemFileHandle | null = null;
  if (picker) {
    try {
      handle = await picker({ suggestedName: name, types: [{ description: "Otpadn project", accept: { "application/x-otpadn": [".otpadn"] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return; // cancelled
    }
  }
  store.busy("Saving project…", 0);
  try {
    const blob = await exportProjectFile();
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    }
    store.log(`Saved project "${store.project.name}" (${(blob.size / 1048576).toFixed(1)} MB)${handle ? ` to ${handle.name}` : " to downloads"}`);
  } finally {
    store.busy(null);
  }
}

export async function openProjectFile(f: File) {
  if (store.project.tracks.length && !(await confirmDialog({ title: `open "${f.name}"?`, body: "the current session will be replaced. save it to disk first if you want to keep it.", ok: "open project", danger: true }))) return;
  engine.stop();
  await importProjectFile(f, (b) => engine.ctx.decodeAudioData(b));
}
