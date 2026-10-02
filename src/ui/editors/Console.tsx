import { useEffect, useRef } from "react";
import { useStore } from "../../model/store";

/** Console: pipeline log (analysis timings, mix decisions, load errors). */
export default function Console() {
  const s = useStore();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in current Chrome, which React would call as a cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [s.ui.log.length]);
  return (
    <div className="log">
      {s.ui.log.map((l, i) => (
        <div key={i} className={l.includes("Error") ? "err" : ""}>{l}</div>
      ))}
      <div ref={end} />
    </div>
  );
}
