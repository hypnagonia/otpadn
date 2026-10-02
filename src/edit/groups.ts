/**
 * Channel groups: select tracks (⇧/⌘-click), ⌘G groups them. Linked controls move together —
 * volume relative (the balance inside the group is kept), mute / solo absolute, pan relative
 * (off by default). Hold ⌥ while changing a control to move just that track.
 */
import { store } from "../model/store";
import { uid, type ChannelGroup, type ChannelSettings, type Project, type Track } from "../model/types";
import { controlChanged } from "./automation";

export const GROUP_COLORS = ["#f2b84b", "#6cb7f5", "#ef6f6c", "#7cc68a", "#b48cf2", "#5cc9c0", "#f28cc2", "#f5925c"];

let altDown = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => e.key === "Alt" && (altDown = true));
  window.addEventListener("keyup", (e) => e.key === "Alt" && (altDown = false));
  window.addEventListener("blur", () => (altDown = false));
}

export const groupOf = (p: Project, t: Track | undefined): ChannelGroup | undefined => (t?.group ? p.groups?.find((g) => g.id === t.group) : undefined);
export const groupMembers = (p: Project, g: ChannelGroup) => p.tracks.filter((t) => t.group === g.id);
export const groupLabel = (p: Project, g: ChannelGroup) => g.name;

/** Select a track; ⇧ / ⌘ add or remove it from the multi-selection. */
export function selectTrack(id: string, e?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) {
  const multi = !!(e?.shiftKey || e?.metaKey || e?.ctrlKey);
  const cur = store.ui.selectedTrackIds.length ? store.ui.selectedTrackIds : store.ui.selectedTrackId ? [store.ui.selectedTrackId] : [];
  if (!multi) return store.setUi({ selectedTrackId: id, selectedTrackIds: [id] });
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  store.setUi({ selectedTrackIds: next, selectedTrackId: next.includes(id) ? id : next[next.length - 1] ?? null });
}

export function groupTracks(ids: string[]) {
  if (ids.length < 2) return;
  let name = "";
  store.update((p) => {
    p.groups ??= [];
    const used = new Set(p.groups.map((g) => g.name));
    let n = 1;
    while (used.has(`G${n}`)) n++;
    const g: ChannelGroup = { id: uid("grp"), name: `G${n}`, color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length], link: { volume: true, mute: true, solo: true, pan: false } };
    p.groups.push(g);
    for (const t of p.tracks) if (ids.includes(t.id)) t.group = g.id;
    pruneGroups(p);
    name = g.name;
  });
  store.log(`Grouped ${ids.length} tracks as ${name} — faders, mute and solo move together (hold ⌥ to move one track alone)`);
}

export function ungroup(groupId: string) {
  store.update((p) => {
    for (const t of p.tracks) if (t.group === groupId) delete t.group;
    p.groups = (p.groups ?? []).filter((g) => g.id !== groupId);
  });
}

export function removeFromGroup(trackId: string) {
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (t) delete t.group;
    pruneGroups(p);
  });
}

export async function renameGroupDialog(groupId: string, current: string) {
  const { promptDialog } = await import("../ui/common/Dialog");
  const name = (await promptDialog({ title: "rename group", value: current, ok: "rename" }))?.trim();
  if (name) updateGroup(groupId, (g) => (g.name = name.slice(0, 12)));
}

export function updateGroup(groupId: string, fn: (g: ChannelGroup) => void) {
  store.update((p) => {
    const g = p.groups?.find((x) => x.id === groupId);
    if (g) fn(g);
  });
}

/** Groups with fewer than two members dissolve. */
function pruneGroups(p: Project) {
  p.groups = (p.groups ?? []).filter((g) => {
    const n = p.tracks.filter((t) => t.group === g.id).length;
    if (n < 2) for (const t of p.tracks) if (t.group === g.id) delete t.group;
    return n >= 2;
  });
}

type Linked = Partial<Pick<ChannelSettings, "volumeDb" | "pan" | "mute" | "solo">>;

/** Change a channel control; group members follow per the group's links (⌥ = this track only). */
export function changeChannel(trackId: string, patch: Linked) {
  const written: { id: string; param: string; value: number }[] = [];
  store.update((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const g = altDown ? undefined : groupOf(p, t);
    const members = g ? groupMembers(p, g) : [t];
    const dVol = patch.volumeDb !== undefined ? patch.volumeDb - t.ch.volumeDb : 0;
    const dPan = patch.pan !== undefined ? patch.pan - t.ch.pan : 0;
    for (const m of members) {
      const self = m === t;
      if (patch.volumeDb !== undefined && (self || g!.link.volume)) {
        m.ch.volumeDb = self ? patch.volumeDb : Math.max(-60, Math.min(12, +(m.ch.volumeDb + dVol).toFixed(2)));
        written.push({ id: m.id, param: "volume", value: m.ch.volumeDb });
      }
      if (patch.pan !== undefined && (self || g!.link.pan)) {
        m.ch.pan = self ? patch.pan : Math.max(-1, Math.min(1, m.ch.pan + dPan));
        written.push({ id: m.id, param: "pan", value: m.ch.pan });
      }
      if (patch.mute !== undefined && (self || g!.link.mute)) m.ch.mute = patch.mute;
      if (patch.solo !== undefined && (self || g!.link.solo)) m.ch.solo = patch.solo;
    }
  });
  for (const w of written) controlChanged(w.id, w.param, w.value);
}
