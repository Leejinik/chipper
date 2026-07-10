import {
  EditorSelection,
  SelectionRange,
  countColumn,
  findColumn,
  EditorState,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// A rectangular/column selection that decides whether it is "column mode" on
// EVERY mouse move (by reading the live Alt state), instead of only at
// mousedown like CodeMirror's built-in rectangularSelection(). This lets the
// user press the mouse first and THEN hold Alt to switch the in-progress drag
// into a multi-cursor column selection.
//
// The geometry mirrors CodeMirror's own rectangleFor/getPos implementation.

const MaxOff = 2000;

interface RPos {
  line: number;
  col: number;
  off: number;
}

function absoluteColumn(view: EditorView, x: number): number {
  const ref = view.coordsAtPos(view.viewport.from);
  return ref ? Math.round(Math.abs((ref.left - x) / view.defaultCharacterWidth)) : -1;
}

function getPos(view: EditorView, event: MouseEvent): RPos {
  const offset = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  const line = view.state.doc.lineAt(offset);
  const off = offset - line.from;
  const col =
    off > MaxOff
      ? -1
      : off === line.length
      ? absoluteColumn(view, event.clientX)
      : countColumn(line.text, view.state.tabSize, off);
  return { line: line.number, col, off };
}

function rectangleFor(state: EditorState, a: RPos, b: RPos): SelectionRange[] {
  const startLine = Math.min(a.line, b.line);
  const endLine = Math.max(a.line, b.line);
  const ranges: SelectionRange[] = [];
  if (a.off > MaxOff || b.off > MaxOff || a.col < 0 || b.col < 0) {
    // Fallback for very long lines / positions past a measurable column:
    // offset-based, clamped to each line's bounds (safe approximation).
    const startOff = Math.min(a.off, b.off);
    const endOff = Math.max(a.off, b.off);
    for (let i = startLine; i <= endLine; i++) {
      const line = state.doc.line(i);
      const from = line.from + Math.min(startOff, line.length);
      const to = line.from + Math.min(endOff, line.length);
      ranges.push(EditorSelection.range(from, to));
    }
  } else {
    const startCol = Math.min(a.col, b.col);
    const endCol = Math.max(a.col, b.col);
    for (let i = startLine; i <= endLine; i++) {
      const line = state.doc.line(i);
      const start = findColumn(line.text, startCol, state.tabSize, true);
      if (start < 0) {
        ranges.push(EditorSelection.cursor(line.to));
      } else {
        const end = findColumn(line.text, endCol, state.tabSize);
        ranges.push(EditorSelection.range(line.from + start, line.from + end));
      }
    }
  }
  return ranges;
}

export function columnSelection() {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    // Only take over plain left-button single-click drags. Defer shift-extend,
    // Ctrl/Cmd multi-cursor, and double/triple-click word/line granularity to
    // CodeMirror's default mouse selection.
    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.detail > 1
    ) {
      return null;
    }
    let start = getPos(view, event);
    let startOffset = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    let startSel = view.state.selection;
    return {
      get(curEvent: MouseEvent, _extend: boolean, multiple: boolean) {
        if (curEvent.altKey) {
          const cur = getPos(view, curEvent);
          const ranges = rectangleFor(view.state, start, cur);
          if (!ranges.length) return startSel;
          return multiple
            ? EditorSelection.create(ranges.concat(startSel.ranges))
            : EditorSelection.create(ranges);
        }
        const head = view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false);
        return EditorSelection.single(startOffset, head);
      },
      update(update) {
        if (update.docChanged) {
          startOffset = update.changes.mapPos(startOffset);
          const newStart = update.changes.mapPos(update.startState.doc.line(start.line).from);
          const newLine = update.state.doc.lineAt(newStart);
          start = { line: newLine.number, col: start.col, off: Math.min(start.off, newLine.length) };
          startSel = startSel.map(update.changes);
        }
      },
    };
  });
}
