import type { EditorView } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import {
  cursorPageDown,
  cursorPageUp,
  cursorLineDown,
  cursorLineUp,
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorDocStart,
  cursorDocEnd,
  selectPageDown,
  selectPageUp,
  selectLineDown,
  selectLineUp,
  selectCharLeft,
  selectCharRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectDocStart,
  selectDocEnd,
} from "@codemirror/commands";

// Navigation keys that move every synced multi-view pane together, as
// [move, extend selection with Shift]. Typing is not synced (by design).
const PLAIN: Record<string, [Command, Command]> = {
  PageDown: [cursorPageDown, selectPageDown],
  PageUp: [cursorPageUp, selectPageUp],
  ArrowDown: [cursorLineDown, selectLineDown],
  ArrowUp: [cursorLineUp, selectLineUp],
  ArrowLeft: [cursorCharLeft, selectCharLeft],
  ArrowRight: [cursorCharRight, selectCharRight],
  Home: [cursorLineBoundaryBackward, selectLineBoundaryBackward],
  End: [cursorLineBoundaryForward, selectLineBoundaryForward],
};
const WITH_CTRL: Record<string, [Command, Command]> = {
  Home: [cursorDocStart, selectDocStart],
  End: [cursorDocEnd, selectDocEnd],
};

// The command a keydown maps to, or null when the key is not synced.
export function syncedNavCommand(e: KeyboardEvent): Command | null {
  if (e.altKey || e.metaKey) return null;
  const pair = (e.ctrlKey ? WITH_CTRL : PLAIN)[e.key];
  return pair ? pair[e.shiftKey ? 1 : 0] : null;
}

// CodeMirror pages and steps from the cursor, but a pane scrolled with the
// mouse wheel keeps its cursor wherever it was — PageDown would then yank the
// pane back there. So a cursor that is off screen first moves to the first
// fully visible line, making every move start from what the user is looking at.
export function bringCursorIntoView(view: EditorView): void {
  const rect = view.scrollDOM.getBoundingClientRect();
  const top = rect.top - view.documentTop;
  const bottom = rect.bottom - view.documentTop;
  const sel = view.state.selection.main;
  const at = view.lineBlockAt(sel.head);
  if (at.bottom > top && at.top < bottom) return;
  let line = view.lineBlockAtHeight(Math.max(0, top));
  if (line.top < top && line.to < view.state.doc.length) line = view.lineBlockAt(line.to + 1);
  view.dispatch({ selection: { anchor: line.from } });
}

// Run one navigation command on each view.
export function runSyncedNav(views: EditorView[], cmd: Command): void {
  for (const v of views) {
    bringCursorIntoView(v);
    cmd(v);
  }
}
