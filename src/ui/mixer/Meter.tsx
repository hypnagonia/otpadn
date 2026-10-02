import { useEffect, useRef } from "react";
import { engine } from "../../engine/transport";
import { T } from "../common/theme";
import { onFrame, readLevel } from "./levels";


/** RMS bar + peak-hold line from an AnalyserNode, -60..0 dBFS. */
export default function Meter({ getAnalyser, height = 150 }: { getAnalyser: () => AnalyserNode | undefined; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const get = useRef(getAnalyser);
  get.current = getAnalyser;
  useEffect(() => {
    let level = -100, peak = -100, hold = 0, drawnIdle = false;
    return onFrame(() => {
      const cv = ref.current, an = get.current();
      const idle = !engine.playing && level < -99 && peak < -99;
      if (!cv || !an || (idle && drawnIdle)) return; // nothing changed: no read, no redraw
      drawnIdle = idle;
      const { rmsDb, peakDb } = readLevel(an);
      level = Math.max(rmsDb, level - 1.2);
      if (peakDb > peak || ++hold > 60) {
        peak = peakDb;
        hold = 0;
      }
      const g = cv.getContext("2d")!;
      const H = cv.height, W = cv.width;
      g.clearRect(0, 0, W, H);
      const y = (d: number) => H - Math.max(0, Math.min(1, (d + 60) / 60)) * H;
      // Standard ballistics colouring: green to -12, yellow to -3, red above.
      const top = y(level);
      const seg = (from: number, to: number, c: string) => {
        const a = Math.max(top, y(to)), b = y(from);
        if (b > a) {
          g.fillStyle = c;
          g.fillRect(0, a, W, b - a);
        }
      };
      seg(-60, -12, T.meterGreen);
      seg(-12, -3, T.meterYellow);
      seg(-3, 0, T.meterRed);
      if (peak > -60) {
        g.fillStyle = peak > -0.5 ? T.clip : T.ink;
        g.fillRect(0, y(peak), W, 2);
      }
    });
  }, []);
  return <canvas ref={ref} className="meter" width={6} height={height} />;
}
