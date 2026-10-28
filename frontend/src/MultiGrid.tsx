// The multi-view grid with draggable boundaries: a bar between two panes of a
// row changes those two widths, the bar between the rows changes the row
// heights, a double-click on a bar makes that row (or the rows) equal again.
//
// Panes stay direct children (same keys, same DOM parent at every pane count),
// so editors are never remounted by a layout change. During a drag only the
// grid's custom properties are rewritten — React (and the editors) re-render
// once, at mouse up, when the new layout is committed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MIN_PANE_H,
  MIN_PANE_W,
  MV_GAP,
  dragCol,
  dragRow,
  equalizeRow,
  equalizeRows,
  gridVars,
  layoutFor,
  normalizePaneSizes,
  rowsOf,
  type PaneLayout,
  type PaneSizes,
} from "./paneSizes";
import "./MultiGrid.css";

export { paneStyle } from "./paneSizes";

// Sizes of every pane count, plus a ref that always holds the latest value
// (the session snapshot reads refs).
export function usePaneSizes() {
  const [sizes, setSizes] = useState<PaneSizes>({});
  const ref = useRef<PaneSizes>(sizes);
  const restore = useCallback((raw: unknown) => {
    const v = normalizePaneSizes(raw);
    ref.current = v;
    setSizes(v);
  }, []);
  const commit = useCallback((count: number, lay: PaneLayout) => {
    const v = { ...ref.current, [String(count)]: lay };
    ref.current = v;
    setSizes(v);
  }, []);
  return { sizes, ref, restore, commit };
}

interface Props {
  count: number;
  sizes: PaneSizes;
  onCommit: (count: number, lay: PaneLayout) => void;
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
}

const TIP = "끌어서 칸 크기 조절 · 두 번 누르면 균등하게";

export default function MultiGrid({ count, sizes, onCommit, onKeyDownCapture, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(() => layoutFor(sizes, count), [sizes, count]);
  const style = useMemo(() => gridVars(layout, count), [layout, count]);
  const shape = rowsOf(count);
  const [dragging, setDragging] = useState<string | null>(null); // key of the bar being dragged
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  const begin = (e: React.MouseEvent, kind: "col" | "row", key: string, next: (rect: DOMRect, ev: MouseEvent) => PaneLayout) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    stopRef.current?.();
    const rect = el.getBoundingClientRect();
    let cur = layout;
    const apply = (lay: PaneLayout) => {
      for (const [k, v] of Object.entries(gridVars(lay, count))) el.style.setProperty(k, v);
    };
    const move = (ev: MouseEvent) => {
      cur = next(rect, ev);
      apply(cur);
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      stopRef.current = null;
      setDragging(null);
      if (cur !== layout) onCommit(count, cur);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    document.body.style.userSelect = "none";
    document.body.style.cursor = kind === "col" ? "col-resize" : "row-resize";
    stopRef.current = stop;
    setDragging(key);
  };

  const bars: ReactNode[] = [];
  shape.forEach((panes, r) => {
    for (let j = 0; j + 1 < panes.length; j++) {
      bars.push(
        <div
          key={`c${r}-${j}`}
          className={`resizer mv-bar mv-col${dragging === `c${r}-${j}` ? " mv-active" : ""}`}
          data-mv-col={`${r}-${j}`}
          title={TIP}
          style={{ left: `var(--mvc${r}-${j}-x)`, top: `var(--mvr${r}-y)`, height: `var(--mvr${r}-h)` }}
          onMouseDown={(e) => {
            const x0 = e.clientX;
            const avail = (rect: DOMRect) => rect.width - (panes.length - 1) * MV_GAP;
            begin(e, "col", `c${r}-${j}`, (rect, ev) => dragCol(layout, r, j, ev.clientX - x0, avail(rect), MIN_PANE_W));
          }}
          onDoubleClick={() => onCommit(count, equalizeRow(layout, r))}
        />
      );
    }
  });
  if (shape.length > 1)
    bars.push(
      <div
        key="r"
        className={`resizer mv-bar mv-row${dragging === "r" ? " mv-active" : ""}`}
        data-mv-row="0"
        title={TIP}
        style={{ top: "var(--mvrh-y)" }}
        onMouseDown={(e) => {
          const y0 = e.clientY;
          begin(e, "row", "r", (rect, ev) => dragRow(layout, ev.clientY - y0, rect.height - (shape.length - 1) * MV_GAP, MIN_PANE_H));
        }}
        onDoubleClick={() => onCommit(count, equalizeRows(layout))}
      />
    );

  return (
    <div
      ref={ref}
      className={`multi-grid mv-sized${dragging ? " mv-dragging" : ""}`}
      data-count={count}
      style={style}
      onKeyDownCapture={onKeyDownCapture}
    >
      {children}
      {bars}
    </div>
  );
}
