import { memo } from "react";
import { useStoreQuiet } from "../../model/store";
import ChannelStrip, { MasterStrip } from "./ChannelStrip";

/** Mixer window (X): every track strip left→right, master pinned on the right. */
function Mixer() {
  const s = useStoreQuiet();
  return (
    <div className="mixer">
      <div className="mixer-strips">
        {s.project.tracks.map((t) => (
          <ChannelStrip key={t.id} t={t} selected={s.ui.selectedTrackId === t.id || s.ui.selectedTrackIds.includes(t.id)} />
        ))}
        {!s.project.tracks.length && <div className="hint">no tracks yet</div>}
      </div>
      <div className="mixer-master">
        <MasterStrip />
      </div>
    </div>
  );
}

/** memo: a prop-less panel only re-renders through its own store subscription. */
export default memo(Mixer);
