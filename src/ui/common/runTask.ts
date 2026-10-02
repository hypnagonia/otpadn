import { store } from "../../model/store";
import { MemoryGuardError } from "../../system/memory";
import { confirmDialog } from "./Dialog";

/** Run an async action, surfacing errors in the log and clearing the busy state. */
export async function runTask(fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    store.log(`Error: ${(e as Error).message ?? e}`);
    if (e instanceof MemoryGuardError) confirmDialog({ title: "not enough memory", body: e.message, ok: "ok" });
    else store.setUi({ showEditor: true, editorTab: "console" });
  } finally {
    store.busy(null);
  }
}
