/** Insert-slot commands. Owner is a track id or "master". */
import { controlChanged } from "../edit/automation";
import { store } from "../model/store";
import { uid } from "../model/types";
import { defaultParams, type Insert, type PluginType } from "./defs";

export type InsertOwner = string | "master";

function list(owner: InsertOwner): Insert[] {
  const p = store.project;
  if (owner === "master") return (p.masterInserts ??= []);
  const t = p.tracks.find((x) => x.id === owner);
  if (!t) return [];
  return (t.inserts ??= []);
}

export const getInserts = (owner: InsertOwner) => list(owner);
export const findInsert = (owner: InsertOwner, id: string) => list(owner).find((i) => i.id === id);

export function addInsert(owner: InsertOwner, type: PluginType, params?: Partial<Record<string, number>>) {
  const ins: Insert = { id: uid("ins"), type, on: true, params: { ...defaultParams(type), ...params } as Record<string, number> };
  store.update(() => list(owner).push(ins));
  store.setUi({ selectedInsert: { owner, id: ins.id }, showEditor: true, editorTab: "plugin" });
  return ins;
}

export function removeInsert(owner: InsertOwner, id: string) {
  store.update(() => {
    const l = list(owner);
    const i = l.findIndex((x) => x.id === id);
    if (i >= 0) l.splice(i, 1);
  });
  if (store.ui.selectedInsert?.id === id) store.setUi({ selectedInsert: null });
}

export const toggleInsert = (owner: InsertOwner, id: string) =>
  store.update(() => {
    const ins = findInsert(owner, id);
    if (ins) ins.on = !ins.on;
  });

export const setParam = (owner: InsertOwner, id: string, key: string, value: number) => {
  store.update(() => {
    const ins = findInsert(owner, id);
    if (ins) ins.params[key] = value;
  });
  if (owner !== "master") controlChanged(owner, `ins:${id}:${key}`, value);
};

export const openInsert = (owner: InsertOwner, id: string) => store.setUi({ selectedInsert: { owner, id }, showEditor: true, editorTab: "plugin" });
