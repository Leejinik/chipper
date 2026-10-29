// App shortcuts — every one of them remappable in ⌨ 단축키 설정 (user 10-29).
//
// What stays fixed (RESERVED_COMBOS and FIXED_KEYS below): the editor's and the
// OS's own keys — copy/paste/cut/undo/redo/select-all, CodeMirror's multi-cursor
// and navigation, Ctrl+Tab tab moves, and Esc/Enter/Tab inside windows.
//
// Combos are stored as "ctrl+alt+shift+key" (that order). ⌘ folds into ctrl, so
// one binding works on Windows (Ctrl) and macOS (⌘ — and ⌃ too). The key part is
// the physical key for letters/digits (keyCombo.ts), so 한글 IME mode does not
// matter. Only the display differs per platform: "Ctrl+Shift+S" vs "⇧⌘S".
import { useSyncExternalStore } from "react";
import { comboKey, normalizeCombo } from "./keyCombo";

export type CmdId =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "close"
  | "nextTab"
  | "prevTab"
  | "find"
  | "replace"
  | "findNext"
  | "findPrev"
  | "inClause"
  | "chips"
  | "resetZoom"
  | "lvTop"
  | "lvEnd"
  | "lvPageUp"
  | "lvPageDown"
  | "lvOpen";

// Where a command's key is listened for:
//  app   — anywhere in the window (needs Ctrl/⌘ or Alt/⌥)
//  find  — in the editor and in the find boxes (찾기/바꾸기 panel, 줄만 보기 찾기)
//  lines — in a 「🏷 줄만 보기」 / 「📖 읽기 보기」 list only; Shift with it widens the selection
export type CmdScope = "app" | "find" | "lines";
export type CmdGroup = "file" | "find" | "tools" | "lines" | "zoom";

export interface CommandDef {
  id: CmdId;
  label: string;
  group: CmdGroup;
  scope: CmdScope;
  defaultCombo: string;
  // macOS default when it differs: up to two keys, space-separated
  macDefault?: string;
}

export const COMMANDS: CommandDef[] = [
  { id: "new", label: "새 파일", group: "file", scope: "app", defaultCombo: "ctrl+n" },
  { id: "open", label: "열기", group: "file", scope: "app", defaultCombo: "ctrl+o" },
  { id: "save", label: "저장", group: "file", scope: "app", defaultCombo: "ctrl+s" },
  { id: "saveAs", label: "다른 이름으로 저장", group: "file", scope: "app", defaultCombo: "ctrl+shift+s" },
  { id: "close", label: "탭 닫기", group: "file", scope: "app", defaultCombo: "ctrl+w" },
  // ⌃Tab works on macOS too (⌘Tab is the system app switcher); ⇧⌘] / ⇧⌘[ are the Mac tab keys
  { id: "nextTab", label: "다음 탭 (멀티 뷰: 다음 칸)", group: "file", scope: "app", defaultCombo: "ctrl+tab", macDefault: "ctrl+tab ctrl+shift+]" },
  { id: "prevTab", label: "이전 탭 (멀티 뷰: 이전 칸)", group: "file", scope: "app", defaultCombo: "ctrl+shift+tab", macDefault: "ctrl+shift+tab ctrl+shift+[" },
  { id: "find", label: "찾기", group: "find", scope: "app", defaultCombo: "ctrl+f" },
  // ⌘H hides the app on macOS (App menu): ⌥⌘F there, the Mac editors' replace key
  { id: "replace", label: "바꾸기", group: "find", scope: "app", defaultCombo: "ctrl+h", macDefault: "ctrl+alt+f" },
  { id: "findNext", label: "다음 찾기", group: "find", scope: "find", defaultCombo: "f3" },
  { id: "findPrev", label: "이전 찾기", group: "find", scope: "find", defaultCombo: "shift+f3" },
  { id: "inClause", label: "IN절 변환", group: "tools", scope: "app", defaultCombo: "ctrl+i" },
  { id: "chips", label: "chips 자동입력", group: "tools", scope: "app", defaultCombo: "ctrl+p" },
  { id: "lvTop", label: "맨 위 줄로", group: "lines", scope: "lines", defaultCombo: "home" },
  { id: "lvEnd", label: "맨 끝 줄로 (끝 따라가기)", group: "lines", scope: "lines", defaultCombo: "end" },
  { id: "lvPageUp", label: "한 화면 위로", group: "lines", scope: "lines", defaultCombo: "pageup" },
  { id: "lvPageDown", label: "한 화면 아래로", group: "lines", scope: "lines", defaultCombo: "pagedown" },
  { id: "lvOpen", label: "고른 줄을 전체 보기로 열기", group: "lines", scope: "lines", defaultCombo: "enter" },
  { id: "resetZoom", label: "글자 크기 기본값(14px)", group: "zoom", scope: "app", defaultCombo: "ctrl+0" },
];

export const GROUPS: { id: CmdGroup; label: string }[] = [
  { id: "file", label: "파일·탭" },
  { id: "find", label: "찾기" },
  { id: "tools", label: "ID 목록 도구" },
  { id: "lines", label: "🏷 줄만 보기 · 📖 읽기 보기" },
  { id: "zoom", label: "확대" },
];

export const SCOPE_LABEL: Record<CmdScope, string> = {
  app: "어디서나",
  find: "편집기·찾기 칸에서",
  lines: "줄 목록 칸 안에서",
};
// What Shift does with a lines key (shown under the group).
export const LINES_NOTE = "줄 목록을 눌러 둔 동안만 먹습니다. 이동 키에 Shift 를 더하면 고른 줄이 넓어집니다(Shift 는 따로 정하지 않음).";

export const CMD_IDS = COMMANDS.map((c) => c.id);
// A command's keys: up to two combos, space-separated ("" = none). Combos never
// contain a space (the space bar is "space").
export const MAX_KEYS = 2;
export const keysOf = (v: string | undefined): string[] => (v ? v.split(" ").filter(Boolean) : []);
export const DEFAULT_KEYBINDS = Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaultCombo])) as Record<CmdId, string>;
const MAC_DEFAULT_KEYBINDS = Object.fromEntries(COMMANDS.map((c) => [c.id, c.macDefault ?? c.defaultCombo])) as Record<CmdId, string>;
export const defaultKeybinds = (mac: boolean): Record<CmdId, string> => (mac ? MAC_DEFAULT_KEYBINDS : DEFAULT_KEYBINDS);
export const CMD_LABEL = Object.fromEntries(COMMANDS.map((c) => [c.id, c.label])) as Record<CmdId, string>;
const CMD_SCOPE = Object.fromEntries(COMMANDS.map((c) => [c.id, c.scope])) as Record<CmdId, CmdScope>;
export type Keybinds = Record<CmdId, string>;

// Standard editing/navigation combos no command may take: CodeMirror's and the
// OS's editing keys, and Ctrl+Home/End (start/end of the document in the editor
// — and of the list in 줄만 보기, where they stay fixed). Ctrl+Tab is a setting
// now (다음/이전 탭); CodeMirror's Tab indent is plain Tab / Shift+Tab only.
export const RESERVED_COMBOS = new Set([
  "ctrl+c",
  "ctrl+v",
  "ctrl+x",
  "ctrl+z",
  "ctrl+y",
  "ctrl+a",
  "ctrl+shift+z",
  "ctrl+d",
  "ctrl+home",
  "ctrl+end",
  "ctrl+shift+home",
  "ctrl+shift+end",
]);

// macOS: keys the system or the app menu (menu.go: App + Edit) takes before the
// app sees them, as folded combos (⌘ or ⌃): Spotlight / input source, screen
// shots, hide, minimize, quit, log out, force quit, window cycling, Dock, and the
// Edit menu's 「Paste and Match Style」.
export const MAC_SYSTEM_COMBOS = new Map<string, string>([
  ["ctrl+space", "Spotlight·입력 소스 전환"],
  ["ctrl+alt+space", "Finder 검색·입력 소스"],
  ["ctrl+shift+3", "화면 찍기"],
  ["ctrl+shift+4", "화면 찍기"],
  ["ctrl+shift+5", "화면 찍기"],
  ["ctrl+h", "앱 가리기"],
  ["ctrl+alt+h", "다른 앱 가리기"],
  ["ctrl+m", "창 내리기"],
  ["ctrl+q", "앱 끝내기"],
  ["ctrl+shift+q", "로그아웃"],
  ["ctrl+alt+escape", "강제 종료"],
  ["ctrl+`", "창 돌아가기"],
  ["ctrl+alt+d", "Dock 가리기"],
  ["ctrl+alt+shift+v", "편집 메뉴 「붙여넣고 스타일 맞추기」"],
]);

// macOS keys that depend on which of ⌘ / ⌃ is held (the folded combo cannot
// tell): ⌘Tab (app switcher; ⌃Tab is fine) and ⌃ + arrows (Mission Control,
// Spaces; ⌘ + arrows are fine). For the key press in the settings window.
export function macEventProblem(e: KeyLike, mac: boolean): string {
  if (!mac) return "";
  const k = e.key;
  if (e.metaKey && k === "Tab") return "⌘Tab 은 macOS 앱 전환 키라 앱에 오지 않아요(⌃Tab 은 됩니다).";
  if (e.ctrlKey && !e.metaKey && /^Arrow/.test(k)) return "⌃ + 방향키는 macOS Mission Control·데스크탑 전환 키라 쓸 수 없어요(⌘ + 방향키는 됩니다).";
  return "";
}

// Fixed keys, shown read-only in the settings window so the user sees what is
// not theirs to change (and why). Combos use the stored form; text = free text.
export interface FixedKey {
  label: string;
  combos?: string[];
  text?: (mac: boolean) => string;
}
export const FIXED_KEYS: { group: string; why: string; macOnly?: boolean; keys: FixedKey[] }[] = [
  {
    group: "편집",
    why: "편집기·OS 공통 키",
    keys: [
      { label: "복사 · 붙여넣기 · 잘라내기", combos: ["ctrl+c", "ctrl+v", "ctrl+x"] },
      // CodeMirror: redo is Ctrl+Y off macOS, ⇧⌘Z on macOS (⌘Y does nothing there)
      { label: "되돌리기 · 다시 하기", text: (mac) => (mac ? ["ctrl+z", "ctrl+shift+z"] : ["ctrl+z", "ctrl+y", "ctrl+shift+z"]).map((c) => formatCombo(c, mac)).join(" · ") },
      { label: "모두 고르기", combos: ["ctrl+a"] },
      { label: "다음 같은 글자도 고르기(멀티 커서)", combos: ["ctrl+d"] },
      { label: "세로 멀티 커서", text: (mac) => `${modLabel("alt", mac)}+드래그` },
      { label: "문서 처음 · 끝", combos: ["ctrl+home", "ctrl+end"] },
    ],
  },
  {
    group: "줄 목록 칸",
    why: "방향키·Esc 는 목록의 기본 키",
    keys: [
      { label: "한 줄 위 · 아래", text: () => "↑ · ↓" },
      { label: "맨 위 · 맨 끝 (위 설정과 함께 늘 됨)", combos: ["ctrl+home", "ctrl+end"] },
      { label: "고른 줄 풀기", text: () => "Esc" },
    ],
  },
  {
    group: "창",
    why: "창 안의 기본 키 — 바꾸면 창을 못 닫을 수 있음",
    keys: [
      { label: "닫기 · 그만두기", text: () => "Esc" },
      { label: "기본 단추 · 다음 칸", text: () => "Enter · Tab" },
    ],
  },
  {
    group: "macOS 시스템·메뉴",
    why: "시스템이나 앱 메뉴가 먼저 가져가 앱에 오지 않음",
    macOnly: true,
    keys: [
      { label: "Spotlight · 입력 소스", text: () => "⌘Space · ⌃Space" },
      { label: "앱 전환 · 창 돌아가기", text: () => "⌘Tab · ⌘`" },
      { label: "가리기 · 내리기 · 끝내기", text: () => "⌘H · ⌥⌘H · ⌘M · ⌘Q" },
      { label: "화면 찍기", text: () => "⇧⌘3 · ⇧⌘4 · ⇧⌘5" },
      { label: "Mission Control · 데스크탑 전환", text: () => "⌃ + 방향키" },
    ],
  },
];

// --- events → combos ----------------------------------------------------------------------
interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

// Canonical "ctrl+shift+s" from a keyboard event, or null when only modifiers
// are held. Meta (⌘) folds into ctrl so bindings are cross-platform.
export function comboFromEvent(e: KeyLike): string | null {
  const key = comboKey(e); // physical key, so 한글 mode gives "s", not "ㄴ"
  if (key === "control" || key === "shift" || key === "alt" || key === "meta" || key === "os" || key === "altgraph") return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return normalizeCombo(parts.join("+")); // a shifted symbol without a code: "}" → "]"
}

const MOD_ORDER = ["ctrl", "alt", "shift"];
// Split a stored combo into modifiers + key; null when it is not canonical.
function parse(combo: string): { mods: string[]; key: string } | null {
  if (!combo) return null;
  const parts = combo.split("+");
  // the "+" key itself would be "ctrl++" → last part empty; keep it as the key
  let key = parts.pop() as string;
  if (key === "" && parts[parts.length - 1] === "") {
    parts.pop();
    key = "+";
  }
  if (!key) return null;
  let at = -1;
  for (const m of parts) {
    const i = MOD_ORDER.indexOf(m);
    if (i <= at) return null; // unknown, repeated or out of order
    at = i;
  }
  return { mods: parts, key };
}
const withoutShift = (combo: string) => combo.split("+").filter((p, i, a) => !(p === "shift" && i < a.length - 1)).join("+");
function withShift(combo: string): string {
  const p = parse(combo);
  if (!p || p.mods.includes("shift")) return combo;
  return [...p.mods, "shift", p.key].join("+");
}

// --- display ------------------------------------------------------------------------------
const KEY_NAMES: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Esc",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
};

// A modifier's name: Windows/Linux words, macOS symbols. "ctrl" is the folded
// Ctrl-or-⌘ of a combo (⌘ on a Mac); "control" is the real ⌃ key (wheel setting).
export function modLabel(mod: "ctrl" | "alt" | "shift" | "meta" | "control", mac: boolean): string {
  if (mac) return { ctrl: "⌘", meta: "⌘", control: "⌃", alt: "⌥", shift: "⇧" }[mod];
  return { ctrl: "Ctrl", control: "Ctrl", meta: "Win", alt: "Alt", shift: "Shift" }[mod];
}

// "Ctrl+Shift+S" (Windows/Linux) or "⇧⌘S" (macOS: symbols, Apple order ⌥⇧⌘, no "+").
export function formatCombo(combo: string, mac: boolean): string {
  if (!combo) return "없음";
  const p = parse(combo) ?? { mods: [], key: combo };
  const k = p.key;
  const keyName = KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  if (mac) {
    // ⌘Tab is the system app switcher and never reaches the app: tab moves are ⌃Tab there
    if (k === "tab" && p.mods.includes("ctrl")) return "⌃" + (p.mods.includes("alt") ? "⌥" : "") + (p.mods.includes("shift") ? "⇧" : "") + keyName;
    const order = ["alt", "shift", "ctrl"];
    const mods = order.filter((m) => p.mods.includes(m)).map((m) => modLabel(m as "ctrl", true));
    return mods.join("") + keyName;
  }
  return [...p.mods.map((m) => modLabel(m as "ctrl", false)), keyName].join("+");
}

// "Ctrl+Tab · Ctrl+Shift+]" — every key of a command, or "없음".
export function formatKeys(v: string, mac: boolean): string {
  const ks = keysOf(v);
  return ks.length ? ks.map((c) => formatCombo(c, mac)).join(" · ") : "없음";
}

// --- validity -------------------------------------------------------------------------------
const isFKey = (k: string) => /^f([1-9]|1[0-9]|2[0-4])$/.test(k);
const LINES_FIXED = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "escape", "tab"]);

// The concrete combos a binding takes: a lines key also takes its Shift variant.
function occupied(id: CmdId, combo: string): string[] {
  if (!combo) return [];
  return CMD_SCOPE[id] === "lines" ? [combo, withShift(combo)] : [combo];
}

// Why `combo` may not be bound to `id` (empty = fine). Checks the command's scope,
// the fixed keys and every other command's key.
// `own` = the command's other keys (a second key must differ from the first).
export function bindProblem(id: CmdId, combo: string, binds: Keybinds, mac: boolean, own: string[] = []): string {
  if (!combo) return "";
  const p = parse(combo);
  if (!p) return "알 수 없는 키입니다.";
  const scope = CMD_SCOPE[id];
  const ctrl = modLabel("ctrl", mac);
  const alt = modLabel("alt", mac);
  const modded = p.mods.includes("ctrl") || p.mods.includes("alt");
  if (scope === "app" && !modded) return `${ctrl} 또는 ${alt} 를 포함한 조합을 눌러 주세요.`;
  if (scope === "find" && !modded && !isFKey(p.key))
    return `글자를 치는 칸에서도 먹는 키라 ${ctrl}·${alt} 조합이나 F1~F12 를 눌러 주세요.`;
  if (scope === "lines") {
    if (p.mods.includes("shift")) return "Shift 는 고른 줄 넓히기에 쓰여 따로 정할 수 없어요.";
    if (!modded && LINES_FIXED.has(p.key)) return `${formatCombo(combo, mac)} 은(는) 줄 목록의 고정 키라 쓸 수 없어요.`;
  }
  for (const c of occupied(id, combo)) {
    if (RESERVED_COMBOS.has(c)) return `${formatCombo(c, mac)} 은(는) 표준 편집/탐색 키라 쓸 수 없어요.`;
    const sys = mac ? MAC_SYSTEM_COMBOS.get(c) : undefined;
    if (sys) return `${formatCombo(c, mac)} 은(는) macOS 가 먼저 가져가는 키(${sys})라 쓸 수 없어요.`;
  }
  const mine = new Set(occupied(id, combo));
  if (own.some((o) => occupied(id, o).some((c) => mine.has(c)))) return `${formatCombo(combo, mac)} 은(는) 이미 이 기능의 다른 키예요.`;
  for (const other of CMD_IDS) {
    if (other === id) continue;
    const hit = keysOf(binds[other]).find((k) => occupied(other, k).some((c) => mine.has(c)));
    if (hit) return `${formatCombo(hit, mac)} 은(는) 이미 '${CMD_LABEL[other]}'에 할당됨.`;
  }
  return "";
}

// The combo to store for `id` from a key press in the settings window (null =
// modifiers only, keep listening). Lines keys are stored without Shift.
export function captureCombo(id: CmdId, e: KeyLike): string | null {
  const c = comboFromEvent(e);
  if (!c) return null;
  return CMD_SCOPE[id] === "lines" ? withoutShift(c) : c;
}

// Merge persisted keybindings over the defaults: `raw` = each command's first key
// (the format v1.3.1 reads), `raw2` = second keys. Saved keys win (in command
// order); a saved key its command may not use, or one already taken, is dropped
// — when none is left the command gets its default; a default that is now taken
// is dropped too, so a session from an earlier build never ends with one key on
// two commands. Unknown commands and non-strings are dropped; "" (no key) is kept.
// `mac` picks the macOS defaults and refuses the keys macOS takes first.
export function normalizeKeybinds(raw: unknown, mac = false, raw2?: unknown): Keybinds {
  const out = Object.fromEntries(CMD_IDS.map((id) => [id, ""])) as Keybinds;
  const done = new Set<CmdId>();
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const src2 = raw2 && typeof raw2 === "object" ? (raw2 as Record<string, unknown>) : {};
  const take = (id: CmdId, vals: string[]) => {
    const got: string[] = [];
    for (const v of vals) {
      if (got.length >= MAX_KEYS) break;
      const c = normalizeCombo(v.toLowerCase());
      if (!bindProblem(id, c, out, mac, got)) got.push(c);
    }
    out[id] = got.join(" ");
    return got.length;
  };
  for (const id of CMD_IDS) {
    const v = src[id];
    if (typeof v !== "string") continue;
    if (v === "") {
      done.add(id);
      continue;
    }
    const v2 = src2[id];
    if (take(id, [...keysOf(v), ...(typeof v2 === "string" ? keysOf(v2) : [])])) done.add(id);
  }
  const defs = defaultKeybinds(mac);
  for (const id of CMD_IDS) if (!done.has(id)) take(id, keysOf(defs[id]));
  return out;
}

// The session form: [first keys (every command, "" = none — what v1.3.1 reads),
// second keys (only the commands that have one)].
export function splitKeybinds(b: Keybinds): [Record<string, string>, Record<string, string>] {
  const first: Record<string, string> = {};
  const second: Record<string, string> = {};
  for (const id of CMD_IDS) {
    const ks = keysOf(b[id]);
    first[id] = ks[0] ?? "";
    if (ks[1]) second[id] = ks[1];
  }
  return [first, second];
}

// The command of `scope` a key press is bound to, or null. Lines keys match with
// or without Shift (Shift widens the selection).
export function matchCommand(e: KeyLike, scope: CmdScope, binds: Keybinds): CmdId | null {
  let c = comboFromEvent(e);
  if (!c) return null;
  if (scope === "lines") c = withoutShift(c);
  for (const id of CMD_IDS) if (CMD_SCOPE[id] === scope && keysOf(binds[id]).includes(c)) return id;
  return null;
}

// --- wheel zoom ------------------------------------------------------------------------------
// Which modifier + wheel zooms the editor font: both (default), Ctrl/⌃ only, ⌘ only.
// ⌘ is metaKey — the Windows key on Windows, so the choice is offered on macOS only.
export type WheelZoom = "both" | "ctrl" | "meta";
export const WHEEL_ZOOMS: WheelZoom[] = ["both", "ctrl", "meta"];
export const normalizeWheelZoom = (v: unknown): WheelZoom => (WHEEL_ZOOMS.includes(v as WheelZoom) ? (v as WheelZoom) : "both");
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean }, mode: WheelZoom): boolean {
  if (mode === "ctrl") return e.ctrlKey;
  if (mode === "meta") return e.metaKey;
  return e.ctrlKey || e.metaKey;
}
export function wheelZoomLabel(mode: WheelZoom, mac: boolean): string {
  const ctrl = mac ? "⌃ control" : "Ctrl";
  const meta = mac ? "⌘ command" : "Win";
  return mode === "ctrl" ? `${ctrl} 만` : mode === "meta" ? `${meta} 만` : `둘 다 (${mac ? "⌃" : "Ctrl"} · ${mac ? "⌘" : "Win"})`;
}
// The wheel combo as shown in tooltips: "Ctrl+휠", "⌘+휠", "⌃/⌘+휠".
export function wheelHint(mode: WheelZoom, mac: boolean): string {
  if (!mac) return mode === "meta" ? "Win+휠" : "Ctrl+휠";
  return (mode === "ctrl" ? "⌃" : mode === "meta" ? "⌘" : "⌃/⌘") + "+휠";
}

// --- the current settings, for handlers that live outside React renders ----------------------
// (CodeMirror keymaps, window listeners). App writes it; useKeys() reads it in renders.
export interface KeysState {
  binds: Keybinds;
  mac: boolean;
  wheel: WheelZoom;
}
let state: KeysState = { binds: DEFAULT_KEYBINDS, mac: false, wheel: "both" };
const subs = new Set<() => void>();
export const keysNow = (): KeysState => state;
export function setKeysState(next: Partial<KeysState>): void {
  const s = { ...state, ...next };
  if (s.binds === state.binds && s.mac === state.mac && s.wheel === state.wheel) return;
  state = s;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const useKeys = (): KeysState => useSyncExternalStore(subscribe, keysNow);
// "Ctrl+F" / "⌘F" for a command, as bound now.
export const keyText = (id: CmdId, s: KeysState = state) => formatKeys(s.binds[id], s.mac);
