// 「🚫 제외에 추가」 from a right-click (plan 「우클릭 「제외에 추가」」): the text
// picked in a 「🏷 태그 줄만」 row, or in the whole-file editor, becomes one of
// the tab's exclude chips (lineView.ts ExcludeRule) — 글자 그대로, 대소문자
// 무시, on (the chip input's defaults). The logic without React or the DOM
// (unit-tested in tests/exclude-ctx-unit.ts); ExcludeCtxMenu.tsx is the menus.

import { stripAnsi } from "./logHighlight";
import { addExclude, MAX_EXCLUDE, MAX_EXCLUDE_LEN, sameExclude, type ExcludeRule } from "./lineView";

export const MAX_PICK = 4000; // longer selections are not even looked at (the 🎨 rule menu's limit)
export const MENU_TEXT = 24; // characters of the text shown in the menu item

// The chip a selection gives, or why it cannot be one. Surrounding spaces are
// dropped (a drag usually catches one) and ANSI codes taken out (chips match
// the line without them, like the tag rules).
export function excludeTarget(sel: string): { pattern: string; problem: string } {
  if (!sel) return { pattern: "", problem: "글자를 먼저 고르세요 — 줄의 글자를 끌어서 고른 뒤 우클릭" };
  if (sel.length > MAX_PICK) return { pattern: "", problem: "고른 글자가 너무 깁니다" };
  if (/[\r\n]/.test(sel.replace(/^[\r\n]+|[\r\n]+$/g, ""))) return { pattern: "", problem: "여러 줄은 제외에 넣을 수 없습니다 — 한 줄 안의 글자를 고르세요" };
  const a = stripAnsi(sel);
  const pattern = (a ? a.text : sel).replace(/[\r\n]+/g, "").trim();
  if (!pattern) return { pattern: "", problem: "공백뿐인 글자는 제외에 넣을 수 없습니다" };
  if (pattern.length > MAX_EXCLUDE_LEN) return { pattern: "", problem: `${MAX_EXCLUDE_LEN}자보다 긴 글자는 제외에 넣을 수 없습니다` };
  return { pattern, problem: "" };
}

const chipOf = (pattern: string) => ({ pattern, kind: "text" as const, caseSensitive: false });

// The chip that already does what `pattern` would (the same chip, or a 글자
// 그대로·대소문자 무시 chip that differs only in case — 「ABC」 picked when
// 「abc」 is there), or -1.
export function excludeTwin(list: ExcludeRule[], pattern: string): number {
  const i = list.findIndex((x) => sameExclude(x, chipOf(pattern)));
  if (i >= 0) return i;
  const low = pattern.toLowerCase();
  return list.findIndex((x) => x.kind === "text" && !x.caseSensitive && x.pattern.toLowerCase() === low);
}

// What adding `pattern` to `list` would do: a new chip, switching an off twin
// on, nothing (the same chip is on already), or nothing (no room).
export type ExcludeAddState = "new" | "off" | "on" | "full";
export function excludeAddState(list: ExcludeRule[], pattern: string): ExcludeAddState {
  const i = excludeTwin(list, pattern);
  if (i >= 0) return list[i].on ? "on" : "off";
  return list.length >= MAX_EXCLUDE ? "full" : "new";
}

// The menu item: enabled or not, and why not (shown under the item).
export function excludeMenuState(list: ExcludeRule[], t: { pattern: string; problem: string }): { ok: boolean; why: string } {
  if (t.problem) return { ok: false, why: t.problem };
  const s = excludeAddState(list, t.pattern);
  if (s === "on") return { ok: false, why: "이미 켜진 제외 칩입니다" };
  if (s === "full") return { ok: false, why: `제외 칩은 ${MAX_EXCLUDE}개까지입니다 — 안 쓰는 칩을 지우세요` };
  return { ok: true, why: "" };
}

// The text in the menu, cut to MENU_TEXT characters.
export function menuText(pattern: string): string {
  const cs = [...pattern];
  return cs.length > MENU_TEXT ? cs.slice(0, MENU_TEXT).join("") + "…" : pattern;
}

// The tab's chips after adding `pattern` (the same chip is switched on, not
// doubled), and the status-bar line for the editor (which does not show the
// chips: they apply in 「🏷 줄만」).
export function addExcludeText(list: ExcludeRule[], pattern: string): { list: ExcludeRule[]; state: ExcludeAddState; msg: string } {
  const state = excludeAddState(list, pattern);
  const q = `「${menuText(pattern)}」`;
  const tail = " — 줄만 보기에서 적용됩니다";
  if (state === "full") return { list, state, msg: `🚫 제외 칩은 ${MAX_EXCLUDE}개까지라 ${q} 를 넣지 못했습니다` };
  if (state === "on") return { list, state, msg: `🚫 ${q} 는 이미 줄만 보기 제외에 있습니다${tail}` };
  const i = excludeTwin(list, pattern);
  const next = i >= 0 ? list.map((x, k) => (k === i ? { ...x, on: true } : x)) : addExclude(list, chipOf(pattern));
  return { list: next, state, msg: state === "off" ? `🚫 꺼져 있던 줄만 보기 제외 ${q} 를 켰습니다${tail}` : `🚫 ${q} 를 줄만 보기 제외에 추가했습니다${tail}` };
}
