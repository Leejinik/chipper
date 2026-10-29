// The whole-file editor's right-click menu reads CodeMirror's selection; the
// screen shows the browser's. A context click changes the browser's first —
// every engine collapses it when the press is not inside it, and on macOS
// WebKit then selects the word under the pointer before the contextmenu event
// (EventHandler::sendContextMenuEvent, EditingBehavior Mac) — and CodeMirror
// reads that only later (selectionchange). So the menu could say one text
// while another was shown picked (10-29, Mac: 「commonConnection」 in the menu,
// a space picked on screen; chromium: the item off after a press just beside).
//
// Here: the selection at the press (taken before anything handles it) is the
// menu's when the press was on or just beside it, like the 「🏷 줄만」 rows
// (ExcludeCtxMenu.tsx); otherwise CodeMirror's, as before. Either way
// CodeMirror is set to it and the screen shows it again, so the menu, the
// screen and what the menu does agree.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type Press = { view: EditorView; x: number; y: number; t: number; anchor: number; head: number; near: boolean };
let press: Press | null = null;
const PRESS_MS = 5000;

// Installs the press listener (capture, on the window: before CodeMirror and
// the panes' own handlers). Returns the remover.
export function trackEditorPress(): () => void {
  const down = (e: MouseEvent) => {
    press = null;
    if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return; // right button, Ctrl+click (macOS)
    const el = e.target instanceof Element ? e.target.closest(".cm-editor") : null;
    const view = el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
    if (!view) return;
    // what is shown picked (CodeMirror may not have read a fresh one yet)
    const m = view.state.selection.main;
    const sel = screenSelection(view) ?? { anchor: m.anchor, head: m.head };
    const from = Math.min(sel.anchor, sel.head);
    const to = Math.max(sel.anchor, sel.head);
    if (from === to) return;
    // judged now, on the selection as drawn before the press changes anything
    press = { view, x: e.clientX, y: e.clientY, t: performance.now(), anchor: sel.anchor, head: sel.head, near: nearRange(view, from, to, e.clientX, e.clientY) };
  };
  window.addEventListener("mousedown", down, true);
  return () => window.removeEventListener("mousedown", down, true);
}

// The press on or just beside [from, to): within a line box of the drawn
// text, about 1.5 characters off its ends at most (any of its lines).
function nearRange(view: EditorView, from: number, to: number, x: number, y: number): boolean {
  try {
    const a = view.domAtPos(from);
    const b = view.domAtPos(to);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    const m = Math.min(24, Math.max(6, 1.5 * view.defaultCharacterWidth));
    return [...r.getClientRects()].some((q) => q.width > 0 && y >= q.top - 1 && y <= q.bottom + 1 && x >= q.left - m && x <= q.right + m);
  } catch {
    return false;
  }
}

// The browser's selection in the view, as document positions (null: none there).
function screenSelection(view: EditorView): { anchor: number; head: number } | null {
  const ws = window.getSelection();
  if (!ws || ws.rangeCount === 0 || !ws.anchorNode || !ws.focusNode) return null;
  if (!view.contentDOM.contains(ws.anchorNode) || !view.contentDOM.contains(ws.focusNode)) return null;
  try {
    return { anchor: view.posAtDOM(ws.anchorNode, ws.anchorOffset), head: view.posAtDOM(ws.focusNode, ws.focusOffset) };
  } catch {
    return null;
  }
}

// Called as the editor's menu opens: makes CodeMirror's main selection the
// one the menu is about (see above). Only the main range changes; other
// ranges of a multi-selection stay when it already matched.
export function settleEditorSelection(view: EditorView): void {
  const p = press;
  press = null;
  const cur = view.state.selection.main;
  let want: { anchor: number; head: number } | null = null;
  if (p && p.view === view && performance.now() - p.t < PRESS_MS) {
    if (p.near && Math.max(p.anchor, p.head) <= view.state.doc.length) want = { anchor: p.anchor, head: p.head };
  }
  if (!want) want = { anchor: cur.anchor, head: cur.head };
  const sameAsState = Math.min(want.anchor, want.head) === cur.from && Math.max(want.anchor, want.head) === cur.to;
  if (!sameAsState) view.dispatch({ selection: EditorSelection.single(want.anchor, want.head), scrollIntoView: false });
  // and the screen: CodeMirror does not redraw a selection it thinks is shown
  // already (the press moved the browser's one, CodeMirror has not read that yet)
  const ws = window.getSelection();
  const now = screenSelection(view);
  if (ws && !(now && now.anchor === want.anchor && now.head === want.head)) {
    try {
      const a = view.domAtPos(want.anchor);
      const h = view.domAtPos(want.head);
      ws.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    } catch {
      /* the view changed meanwhile */
    }
  }
}
