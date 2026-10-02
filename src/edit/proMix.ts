/** "Pro mix" command (track menu, inspector): applies a mix style's chain and logs what changed. */
import { isMultiKit } from "../instruments/multikit";
import { applyProMix } from "../model/chains";
import { MIX_STYLE_LABEL, type MixStyle } from "../model/mixStyles";
import { store } from "../model/store";

export function applyProMixCmd(trackId: string, style: MixStyle) {
  let target = store.project.tracks.find((t) => t.id === trackId);
  if (target?.kind === "aux") target = store.project.tracks.find((t) => t.id === target!.auxOf);
  if (!target) return;
  const name = target.name, kit = isMultiKit(target.instrument);
  let ok = false;
  store.update((p) => void (ok = applyProMix(p, trackId, style)));
  store.log(ok ? `Pro mix (${MIX_STYLE_LABEL[style]}) applied to "${name}"${kit ? " — all mic channels + drum bus" : ""}` : `Error: no pro mix for "${name}"`);
}
