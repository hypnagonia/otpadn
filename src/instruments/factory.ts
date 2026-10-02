import { DrumAbuse, DrumMachine, ElectricPiano, Mellotron, Scheduler, Smolken, Soundfont, SplendidGrandPiano } from "smplr";
import { DrumSynth } from "./drumsynth";
import { AcousticKit } from "./kit";
import { MultiKit } from "./multikit";
import { PluckGuitar } from "./pluck";
import { resolveDrum, SmplrPlayable, storage, type SmplrLike } from "./smplr";
import { Synth, SYNTHS } from "./synth";
import type { Playable } from "./types";

/** Instantiate a catalog id ("kind:name") on any (realtime or offline) audio context. */
export function createInstrument(ctx: BaseAudioContext, id: string, destination: AudioNode): Playable {
  const [kind, name] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  // The engine does its own lookahead, and offline renders run faster than real
  // time, so smplr must dispatch every note immediately instead of via setInterval.
  const scheduler = Scheduler(ctx, { lookaheadMs: 1e9 });
  const common = { destination, storage, scheduler } as const;
  switch (kind) {
    case "synth":
      return new Synth(ctx, destination, SYNTHS[name] ?? SYNTHS["saw-lead"]);
    case "piano":
      return new SmplrPlayable(SplendidGrandPiano(ctx, { ...common, notesToLoad: { notes: range(21, 108, 3), fallback: "nearest" } }) as SmplrLike);
    case "ep":
      return new SmplrPlayable(ElectricPiano(ctx, { ...common, instrument: name }) as SmplrLike);
    case "sf":
      return new SmplrPlayable(Soundfont(ctx, { ...common, kit: "MusyngKite", instrument: name }) as SmplrLike);
    case "smolken":
      return new SmplrPlayable(Smolken(ctx, { ...common, instrument: name }) as SmplrLike);
    case "mellotron":
      return new SmplrPlayable(Mellotron(ctx, { ...common, instrument: name }) as SmplrLike);
    case "drums": {
      const dm = DrumMachine(ctx, { ...common, instrument: name });
      let groups: string[] | null = null;
      return new SmplrPlayable(dm as unknown as SmplrLike, (n) => resolveDrum((groups ??= dm.getGroupNames()), n));
    }
    case "abuse": {
      const dm = DrumAbuse(ctx, { ...common, source: { kind: "machine", machine: name } });
      let groups: string[] | null = null;
      return new SmplrPlayable(dm as unknown as SmplrLike, (n) => resolveDrum((groups ??= dm.getGroupNames()), n));
    }
    case "dpkit":
      return new DrumSynth(ctx, destination, name);
    case "kit":
      return new AcousticKit(ctx, destination);
    case "multikit":
      return new MultiKit(ctx, destination, name);
    case "pluck":
      return new PluckGuitar(ctx, destination, name === "distortion" ? "distortion" : "acoustic");
    default:
      return new Synth(ctx, destination, SYNTHS["saw-lead"]);
  }
}

function range(a: number, b: number, step: number) {
  const out: number[] = [];
  for (let i = a; i <= b; i += step) out.push(i);
  return out;
}
