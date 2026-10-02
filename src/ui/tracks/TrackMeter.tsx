import { useEffect, useRef } from "react";
import { engine } from "../../engine/transport";
import { T } from "../common/theme";
import { onFrame, readLevel } from "../mixer/levels";

/**
 * Signal indicator for a track header: vertical peak meter (−48…0 dBFS, green → yellow → red)
 * with a short peak hold and a clip LED that stays lit until clicked. Driven by the shared meter
 * loop (ui/mixer/levels.ts), one analyser read per track per frame.
 */

export default function TrackMeter({ trackId }: { trackId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let level = -100, peak = -100, hold = 0, clipped = false, drawnIdle = false;
    const cv = ref.current!;
    cv.onclick = (e) => {
      e.stopPropagation();
      clipped = false;
      drawnIdle = false; // redraw the LED even while stopped
    };
    const draw = () => {
      const an = engine.strips.get(trackId)?.meter;
      const idle = !engine.playing && level < -99 && peak < -99;
      if (idle && drawnIdle) return; // silent and already drawn: skip the read and the redraw
      drawnIdle = idle;
      const db = an && engine.playing ? readLevel(an).peakDb : -120;
      level = Math.max(db, level - 1.5);
      if (db > peak || ++hold > 45) {
        peak = db;
        hold = 0;
      }
      if (db > -0.3) clipped = true;
      const g = cv.getContext("2d")!;
      const W = cv.width, H = cv.height;
      g.fillStyle = "#151619";
      g.fillRect(0, 0, W, H);
      const y = (d: number) => H - Math.max(0, Math.min(1, (d + 48) / 48)) * (H - 4);
      const seg = (from: number, to: number, c: string) => {
        const a = Math.max(y(level), y(to)), b2 = y(from);
        if (b2 > a) {
          g.fillStyle = c;
          g.fillRect(0, a, W, b2 - a);
        }
      };
      if (level > -48) {
        seg(-48, -12, T.meterGreen);
        seg(-12, -3, T.meterYellow);
        seg(-3, 0, T.meterRed);
      }
      if (peak > -48) {
        g.fillStyle = peak > -3 ? T.meterRed : "#e8e8e8";
        g.fillRect(0, y(peak), W, 1);
      }
      g.fillStyle = clipped ? T.meterRed : "#2a2b2f";
      g.fillRect(0, 0, W, 3); // clip LED (click to reset)
    };
    const off = onFrame(draw);
    return () => {
      off();
    };
  }, [trackId]);
  // Absolutely positioned inside a wrapper so the canvas never sizes the header row.
  return (
    <div className="trk-meter" data-tip="level · red top = clipped (click to reset)">
      <canvas ref={ref} width={5} height={64} />
    </div>
  );
}
