// 「🚫 제외에 추가」 right-click menus (logic in excludeCtx.ts):
//  - useExcludeCtx: the 「🏷 태그 줄만」 rows (LinesView.tsx) — text dragged in a
//    row, right-click → 「🚫 제외에 추가: 「…」」 adds it as the tab's chip
//    (the chip row shows it and the view filters again, like ＋ 추가).
//  - ExcludeEditorItem: the item in the whole-file editor's right-click menu
//    (App.tsx, next to 「🎨 이 글자로 로그 색 규칙 만들기…」) — adds it to the
//    tab's lines.ex; it applies when the tab shows 「🏷 줄만」.
// A selection that cannot be a chip (none, several lines, spaces only, too
// long, the 「⋯ 생략」 row) leaves the item off with the reason under it.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardSetText } from "../wailsjs/runtime";
import { addExcludeText, excludeMenuState, excludeTarget, menuText, MAX_PICK } from "./excludeCtx";
import type { ExcludeRule } from "./lineView";

type Target = { pattern: string; problem: string };
const elementOf = (n: Node | null): Element | null => (n ? (n instanceof Element ? n : n.parentElement) : null);

// The text picked in the rows under `root` (.lv-scroll): only the line's own
// text (not the line number, the colour mark or the 「… 긴 줄」 notes), and
// whether it spans lines or sits on a 「⋯ 생략」 row. `copy` = what the
// browser would copy.
export function rowsSelection(root: HTMLElement): { text: string; copy: string; problem: string } {
  const ws = window.getSelection();
  if (!ws || ws.rangeCount === 0 || ws.isCollapsed) return { text: "", copy: "", problem: "" };
  const range = ws.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return { text: "", copy: "", problem: "" };
  const copy = ws.toString();
  const inside = elementOf(range.commonAncestorContainer);
  if (inside?.closest(".lv-no, .lv-mark, .lv-cut")) return { text: "", copy, problem: "" }; // only the number / a note
  const frag = range.cloneContents();
  frag.querySelectorAll(".lv-no, .lv-mark, .lv-cut").forEach((e) => e.remove());
  const rows = [...frag.querySelectorAll(".lv-row")];
  let row: Element | null;
  let text: string;
  if (!rows.length) {
    row = inside?.closest(".lv-row") ?? null;
    text = frag.textContent ?? "";
  } else {
    // a row whose part in the selection is empty (a drag or triple click ending at the next row's start) does not count
    const filled = rows.filter((r) => (r.textContent ?? "") !== "");
    if (filled.length > 1) return { text: "", copy, problem: "여러 줄은 제외에 넣을 수 없습니다 — 한 줄 안의 글자를 고르세요" };
    row = filled[0] ?? null;
    text = row?.textContent ?? "";
  }
  if (row && (row.classList.contains("lv-gap") || row.classList.contains("lv-wait")))
    return { text: "", copy, problem: "「⋯ 생략」 표시가 아니라 로그 줄의 글자를 고르세요" };
  return { text, copy, problem: "" };
}

const MW = 300;
const MH = 120;

// A context click's press, taken before the browser handles it (capture, on
// the rows): what was picked then. The press itself changes the selection when
// it is not inside it — every engine collapses it there, and on macOS WebKit
// then selects the word under the pointer before the contextmenu event
// (EventHandler::sendContextMenuEvent, EditingBehavior Mac: 10-29, a Mac
// tester's drag → 제외 gave another word's chip or a disabled 「공백뿐」 item).
// A press just beside the picked text (its row, a character or so off its
// ends) still means that text; one further away is about what is under it.
type Press = { x: number; y: number; t: number; range: Range; rects: DOMRect[]; text: string; copy: string };
const PRESS_MS = 5000; // a menu opened later than this after the press (held button) is not about it
function nearPicked(p: Press, x: number, y: number): boolean {
  const n = Math.max(1, [...p.text].length);
  return p.rects.some((r) => {
    const m = Math.min(24, Math.max(6, (1.5 * r.width) / n)); // about 1.5 characters
    return y >= r.top - 1 && y <= r.bottom + 1 && x >= r.left - m && x <= r.right + m;
  });
}

// The rows' right-click menu: 복사 (the browser's menu it replaces had it) and
// 🚫 제외에 추가. `list`/`onChange` = the tab's chips (LinesView props).
export function useExcludeCtx(scRef: React.RefObject<HTMLElement>, list: () => ExcludeRule[], onChange: (next: ExcludeRule[]) => void) {
  const [menu, setMenu] = useState<{ x: number; y: number; copy: string; t: Target; seq: number } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const seqRef = useRef(0);
  const press = useRef<Press | null>(null);
  useEffect(() => {
    const el = scRef.current;
    if (!el) return;
    const down = (e: MouseEvent) => {
      press.current = null;
      if (!(e.button === 2 || (e.button === 0 && e.ctrlKey))) return; // right button, Ctrl+click (macOS)
      const ws = window.getSelection();
      if (!ws || ws.rangeCount === 0 || ws.isCollapsed) return;
      const r = ws.getRangeAt(0);
      if (!el.contains(r.commonAncestorContainer)) return;
      const s = rowsSelection(el);
      if (!s.text || s.problem) return;
      press.current = { x: e.clientX, y: e.clientY, t: performance.now(), range: r.cloneRange(), rects: [...r.getClientRects()], text: s.text, copy: s.copy };
    };
    el.addEventListener("mousedown", down, true);
    return () => el.removeEventListener("mousedown", down, true);
  }, [scRef]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // the menu only (not the rows' selection)
      close();
      scRef.current?.focus();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", close);
    };
  }, [menu, scRef]);

  const onContextMenu = (e: React.MouseEvent) => {
    const root = scRef.current;
    if (!root) return;
    e.preventDefault();
    let s = rowsSelection(root);
    const pd = press.current;
    press.current = null;
    if (pd && s.text !== pd.text && performance.now() - pd.t < PRESS_MS && nearPicked(pd, pd.x, pd.y)) {
      // the press beside the picked text changed the selection: that text, shown picked again
      const ws = window.getSelection();
      if (ws && root.contains(pd.range.commonAncestorContainer)) {
        ws.removeAllRanges();
        ws.addRange(pd.range);
      }
      s = { text: pd.text, copy: pd.copy, problem: "" };
    }
    const t = s.problem ? { pattern: "", problem: s.problem } : excludeTarget(s.text);
    const seq = ++seqRef.current;
    setMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - MW)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - MH)), copy: s.copy, t, seq });
    // The button is still down (macOS sends the menu on the press): its release
    // may clear the selection (a Ctrl+click on it does) — show the text the
    // menu is about picked again while the menu is open.
    const ws = window.getSelection();
    if (e.buttons !== 0 && ws && ws.rangeCount > 0 && !ws.isCollapsed && root.contains(ws.getRangeAt(0).commonAncestorContainer)) {
      const keep = ws.getRangeAt(0).cloneRange();
      const was = String(ws);
      const up = () =>
        setTimeout(() => {
          const w2 = window.getSelection();
          if (!w2 || menuRef.current?.seq !== seq || String(w2) === was || !root.contains(keep.commonAncestorContainer)) return;
          w2.removeAllRanges();
          w2.addRange(keep);
        }, 0); // after the release's own handling
      window.addEventListener("mouseup", up, { capture: true, once: true });
    }
  };

  let node: React.ReactNode = null;
  if (menu) {
    const st = excludeMenuState(list(), menu.t);
    const done = () => {
      setMenu(null);
      scRef.current?.focus();
    };
    node = createPortal(
      <div className="ctx-menu lv-exctx" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <button
          className="menu-item lv-exctx-copy"
          disabled={!menu.copy}
          onClick={() => {
            done();
            void ClipboardSetText(menu.copy);
          }}
        >
          복사<span className="menu-key">Ctrl+C</span>
        </button>
        <div className="menu-sep" />
        <button
          className="menu-item lv-exctx-add"
          disabled={!st.ok}
          title={st.ok ? `걸린 줄 중 「${menu.t.pattern}」 이 든 줄을 뺍니다 (글자 그대로 · 대소문자 무시)` : st.why}
          onClick={() => {
            done();
            window.getSelection()?.removeAllRanges();
            onChange(addExcludeText(list(), menu.t.pattern).list);
          }}
        >
          {menu.t.pattern ? `🚫 제외에 추가: 「${menuText(menu.t.pattern)}」` : "🚫 제외에 추가"}
        </button>
        {!st.ok && <div className="menu-head lv-exctx-why">{st.why}</div>}
      </div>,
      document.body
    );
  }
  return { onContextMenu, menu: node };
}

// The whole-file editor's item. `list` = the tab's chips (lines.ex), `noFile` =
// the tab has no file (no 「🏷 줄만」 for it). `setEx` changes the tab's chips,
// `flash` says what happened in the status bar.
export function ExcludeEditorItem(p: {
  target: Target;
  list: ExcludeRule[] | undefined;
  noFile: boolean;
  onDone: () => void;
  setEx: (f: (ex: ExcludeRule[]) => ExcludeRule[]) => void;
  flash: (msg: string) => void;
}) {
  const st = p.noFile ? { ok: false, why: "파일로 저장한 탭에서만 줄만 보기를 쓸 수 있습니다" } : excludeMenuState(p.list ?? [], p.target);
  const pattern = p.target.pattern;
  return (
    <>
      <button
        className="menu-item exclude-from-text-item"
        disabled={!st.ok}
        title={st.ok ? `「${pattern}」 이 든 걸린 줄을 이 탭의 줄만 보기에서 뺍니다 (글자 그대로 · 대소문자 무시)` : st.why}
        onClick={() => {
          p.onDone();
          const r = addExcludeText(p.list ?? [], pattern);
          if (r.state === "new" || r.state === "off") p.setEx((ex) => addExcludeText(ex, pattern).list);
          p.flash(r.msg);
        }}
      >
        {pattern ? `🚫 줄만 보기 제외에 추가: 「${menuText(pattern)}」` : "🚫 줄만 보기 제외에 추가"}
      </button>
      {!st.ok && <div className="menu-head exclude-from-text-why">{st.why}</div>}
    </>
  );
}

// The editor's selection (the main range) as a chip target; a long one is not
// read past MAX_PICK.
export function editorExcludeTarget(slice: (from: number, to: number) => string, from: number, to: number): Target {
  if (from === to) return excludeTarget("");
  return excludeTarget(slice(from, Math.min(to, from + MAX_PICK + 1)));
}
