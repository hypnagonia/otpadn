import { store } from "../../model/store";

/** Horizontal drag handle that resizes the editor pane. Double-click toggles a tall layout. */
export default function Splitter() {
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = store.ui.editorHeight;
    const move = (ev: MouseEvent) => store.setUi({ editorHeight: Math.max(140, Math.min(window.innerHeight - 220, h0 - (ev.clientY - y0))) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className="splitter" onMouseDown={onDown} onDoubleClick={() => store.setUi({ editorHeight: store.ui.editorHeight > 400 ? 300 : Math.round(window.innerHeight * 0.55) })} />;
}
