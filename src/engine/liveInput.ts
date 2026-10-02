/**
 * Live playing of the selected instrument track:
 *  - Musical typing (Logic-style): A W S E D F T G Y H U J K O L P ; = C4… , Z/X octave, C/V velocity
 *  - Hardware MIDI keyboards via Web MIDI (note on/off, velocity), any channel
 */
import { store } from "../model/store";
import { engine } from "./transport";

const KEYMAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

export const live = { typing: false, octave: 4, velocity: 100, midiDevices: [] as string[] };
const held = new Map<string | number, (at?: number) => void>();

function noteOn(key: string | number, pitch: number, vel: number) {
  const t = store.project.tracks.find((x) => x.id === store.ui.selectedTrackId);
  if (!t || t.kind !== "midi") return;
  held.get(key)?.();
  const release = engine.playLive(t.id, pitch, vel);
  if (release) held.set(key, release);
}
function noteOff(key: string | number) {
  held.get(key)?.();
  held.delete(key);
}

/** Returns true when the key was consumed by musical typing. */
export function handleTypingKey(e: KeyboardEvent, down: boolean): boolean {
  if (!live.typing || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (down && e.repeat) return e.code in KEYMAP;
  if (e.code in KEYMAP) {
    const pitch = (live.octave + 1) * 12 + KEYMAP[e.code];
    if (down) noteOn(e.code, pitch, live.velocity);
    else noteOff(e.code);
    return true;
  }
  if (!down) return false;
  if (e.code === "KeyZ") live.octave = Math.max(0, live.octave - 1);
  else if (e.code === "KeyX") live.octave = Math.min(8, live.octave + 1);
  else if (e.code === "KeyC") live.velocity = Math.max(20, live.velocity - 20);
  else if (e.code === "KeyV") live.velocity = Math.min(127, live.velocity + 20);
  else return false;
  store.setUi({});
  return true;
}

export function toggleTyping() {
  live.typing = !live.typing;
  if (!live.typing) [...held.keys()].forEach(noteOff);
  store.setUi({});
}

/** Connect every Web MIDI input (once). Silently unavailable in browsers without Web MIDI. */
let midiInit = false;
export async function enableMidiInput() {
  if (midiInit || !("requestMIDIAccess" in navigator)) return;
  midiInit = true;
  try {
    const access = await navigator.requestMIDIAccess();
    const bind = () => {
      live.midiDevices = [];
      access.inputs.forEach((inp) => {
        live.midiDevices.push(inp.name ?? "midi in");
        inp.onmidimessage = (m) => {
          const [st, d1, d2] = m.data ?? [];
          const cmd = st & 0xf0;
          if (cmd === 0x90 && d2 > 0) noteOn(`m${d1}`, d1, d2);
          else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(`m${d1}`);
        };
      });
      store.setUi({});
      if (live.midiDevices.length) store.log(`MIDI input: ${live.midiDevices.join(", ")}`);
    };
    access.onstatechange = bind;
    bind();
  } catch {
    /* permission denied */
  }
}
