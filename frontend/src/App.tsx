import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { EditorView } from "@codemirror/view";
import { undo, redo, selectAll } from "@codemirror/commands";
import CodeEditor, { type PaneMode } from "./CodeEditor";
import FindReplace, { type FindTarget } from "./FindReplace";
import { runSyncedNav, syncedNavCommand } from "./syncNav";
import BundleTree, { TREE_DRAG_TYPE } from "./BundleTree";
import { looksLikeLog, type LogRule } from "./logHighlight";
import {
  COMMON,
  migratedStore,
  normalizeTagStore,
  rotationKey,
  rulesFor,
  serializeTags,
  tagsFor,
  type AppliedTags,
  type TagStore,
} from "./logTags";
import TagsDialog from "./TagsDialog";
import "./App.css";
import {
  OpenFileDialog,
  OpenFilesDialog,
  OpenFolderDialog,
  ScanBundle,
  ReadFile,
  ReadFileAs,
  SaveFileDialog,
  SaveFile,
  SaveSession,
  CloseWithSession,
  LoadSession,
  LoadTags,
  SaveTags,
  StatFile,
  TypeChips,
  CancelChips,
  AutoUpdate,
  ApplyUpdate,
  GetPendingReleaseNotes,
  MarkReleaseNotesSeen,
  ShowUpdateModeNoticeOnce,
  FrontendReady,
  FileAssociationSupported,
  GetPlatform,
  SupportedFileTypes,
  AssociationStatus,
  RegisterFileTypes,
  UnregisterFileTypes,
  OpenDefaultAppsSettings,
} from "../wailsjs/go/main/App";
import type { main, updater } from "../wailsjs/go/models";
import {
  WindowSetTitle,
  BrowserOpenURL,
  OnFileDrop,
  OnFileDropOff,
  ClipboardGetText,
  ClipboardSetText,
  EventsOn,
  EventsOff,
} from "../wailsjs/runtime";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Lang = "markdown" | "html" | "plaintext";
type ViewMode = "editor" | "split" | "preview";

interface Tab {
  id: string;
  title: string; // basename shown on the tab
  path: string; // absolute path on disk, "" when never saved
  lang: Lang;
  content: string;
  dirty: boolean;
  view: ViewMode;
  mtime: number; // disk mtime (unix ms) captured at open/last save; 0 when unsaved
  encoding: string; // text encoding used to read/write the file
  reloadSeq: number; // bumped to force the editor to remount with replaced content
  // Clean tabs are persisted as path only (a few big logs used to make the
  // session tens of MB, re-serialized on every keystroke). Such a tab comes
  // back with needsLoad set and is read from disk when first shown.
  needsLoad: boolean;
  loadError: string; // why the deferred read failed ("" = none)
  // Shown instead of the title where set: files opened from a log bundle all
  // share names ("messages" ×3), so they read "server1 · messages".
  label: string;
  logColors: "" | "on" | "off"; // log colouring override; "" = auto (log-like plain text)
}

const ENCODINGS: { id: string; label: string }[] = [
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-8-bom", label: "UTF-8 BOM" },
  { id: "cp949", label: "CP949 (EUC-KR)" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "utf-16be", label: "UTF-16 BE" },
];
const ENC_IDS = ENCODINGS.map((e) => e.id);
function encLabel(id: string): string {
  return ENCODINGS.find((e) => e.id === id)?.label ?? "UTF-8";
}

// Multi view: up to MAX_PANES editors side by side. Slots keep their tab and
// mode even while hidden by a smaller pane count, so 4 → 2 → 4 restores them.
interface Slot {
  tabId: string; // "" = empty pane
  mode: PaneMode;
  server: string; // log-bundle server folder this pane follows ("" = none)
  note: string; // why the pane is empty after a bundle switch ("" = none)
}
// A log bundle: a folder with one sub-folder per server. Picking a log in one
// pane opens the same log of each pane's server.
interface BundleInfo {
  root: string;
  servers: string[];
}
interface MultiState {
  on: boolean;
  count: number; // panes shown (1..MAX_PANES)
  slots: Slot[]; // always MAX_PANES long
  bundle: BundleInfo | null;
}
const MAX_PANES = 6;
const DEFAULT_PANE_MODE: PaneMode = "read"; // logs are for reading; editing is opt-in
const emptySlots = (): Slot[] =>
  Array.from({ length: MAX_PANES }, () => ({ tabId: "", mode: DEFAULT_PANE_MODE, server: "", note: "" }));
const DEFAULT_MULTI: MultiState = { on: false, count: 2, slots: emptySlots(), bundle: null };

function normalizeMulti(raw: any, tabIds: Set<string>): MultiState {
  if (!raw || typeof raw !== "object") return DEFAULT_MULTI;
  const count = Number.isInteger(raw.count) ? Math.min(MAX_PANES, Math.max(1, raw.count)) : 2;
  const seen = new Set<string>();
  const slots = emptySlots().map((d, i) => {
    const r = Array.isArray(raw.slots) ? raw.slots[i] : null;
    const mode: PaneMode = r && (r.mode === "edit" || r.mode === "read" || r.mode === "lock") ? r.mode : d.mode;
    let tabId = r && typeof r.tabId === "string" && tabIds.has(r.tabId) ? r.tabId : "";
    if (tabId && seen.has(tabId)) tabId = ""; // one pane per tab
    if (tabId) seen.add(tabId);
    const server = r && typeof r.server === "string" ? r.server : "";
    return { tabId, mode, server, note: "" };
  });
  const bundle =
    raw.bundle && typeof raw.bundle.root === "string" && Array.isArray(raw.bundle.servers)
      ? { root: raw.bundle.root, servers: raw.bundle.servers.filter((x: any) => typeof x === "string") }
      : null;
  return { on: !!raw.on, count, slots, bundle };
}

// Path of `rel` inside a bundle server folder, with the root's separator.
function bundlePath(root: string, server: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), server, ...rel.split("/")].join(sep);
}

// Windows paths are case-insensitive and take either slash.
const isWinPath = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
function normPath(p: string): string {
  return isWinPath(p) ? p.replace(/\//g, "\\").toLowerCase() : p;
}
function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}
// Is `p` inside folder `root` (with or without a trailing separator)?
function underRoot(p: string, root: string): boolean {
  const r = normPath(root).replace(/[\\/]+$/, "");
  const n = normPath(p);
  return n.length > r.length && n.startsWith(r) && (n[r.length] === "\\" || n[r.length] === "/");
}

// The file in `server` that matches `rel`: the same relative path (rtaskmgr
// layout), else the only file with the same name (flat "dump everything" layout).
// Names compare case-insensitively: bundles come from Windows copies as often
// as from Linux servers.
function resolveInServer(scan: main.Bundle, server: string, rel: string): main.BundleFile | null {
  const srv = scan.servers.find((x) => x.name === server);
  if (!srv) return null;
  const exact = srv.files.find((f) => f.rel === rel);
  if (exact) return exact;
  const lower = rel.toLowerCase();
  const folded = srv.files.find((f) => f.rel.toLowerCase() === lower);
  if (folded) return folded;
  const base = lower.split("/").pop();
  const same = srv.files.filter((f) => f.rel.toLowerCase().split("/").pop() === base);
  return same.length === 1 ? same[0] : null;
}

function fmtSize(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + "GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + "MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + "KB";
  return n + "B";
}
const BIG_FILE = 100 << 20; // warn before opening a log this large

// Columns of the 6-wide grid each pane spans: 1–3 panes sit in one row; 4 is
// 2×2; 5 is 3 over 2; 6 is 3×2.
const PANE_MODES: { id: PaneMode; icon: string; tip: string }[] = [
  { id: "edit", icon: "✏️", tip: "편집 — 고칠 수 있음, 같이 움직임" },
  { id: "read", icon: "📖", tip: "읽기 전용 — 키보드로 이동·복사는 됨, 고치기는 막힘, 같이 움직임" },
  { id: "lock", icon: "🔒", tip: "잠금 — 키보드가 전부 막힘(복사만 됨), 마우스로만 이동, 같이 움직이기에서 빠짐" },
];

const noop = () => {};

// Shortcuts that act on the focused document, ignored while it is 🔒 locked
// (find, new, open, zoom and Ctrl+Tab still work; the toolbar mouse still does).
const LOCK_BLOCKED_CMDS = new Set<CmdId>(["save", "saveAs", "close", "replace", "inClause", "chips"]);

function paneSpan(i: number, count: number): number {
  if (count <= 3) return 6 / count;
  const top = Math.ceil(count / 2);
  return i < top ? 6 / top : 6 / (count - top);
}

interface Session {
  version: number;
  tabs: Tab[];
  activeId: string;
  splitRatio: number;
  fontSize?: number; // editor font size (px); optional so older sessions still load
  keybindings?: Record<string, string>; // per-command combo overrides
  // Log colour rules from before tags (now the `common` tag in tags.json). Only
  // read, to build common on first run; written back only until tags.json exists.
  logRules?: unknown;
  multi?: MultiState;
}

// v3: clean tabs carry no content (needsLoad). Older builds reject v3 instead of
// restoring those tabs as empty files that a save would then write back.
const SESSION_VERSION = 3;
const AUTOSAVE_MS = 400;
const TAGS_SAVE_MS = 400;
const PREVIEW_MS = 120;

// Editor font size (Ctrl+wheel to zoom, Ctrl+0 to reset). Bounds keep it usable.
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;
const clampFont = (n: number) =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)));

// chips 자동입력 카운트다운 (default 3, adjustable in the setup dialog).
const DEFAULT_COUNT = 3;
const MIN_COUNT = 1;
const MAX_COUNT = 10;
const clampCount = (n: number) => Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));

// --- keybindings ----------------------------------------------------------
// Only the app's own "special" commands are remappable here. Standard editor
// keys (copy/paste/cut/undo/redo/select-all) are owned by CodeMirror and left
// alone, and Ctrl+Tab tab-navigation is fixed.
type CmdId =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "close"
  | "find"
  | "replace"
  | "inClause"
  | "chips"
  | "resetZoom";

interface CommandDef {
  id: CmdId;
  label: string;
  defaultCombo: string;
}

const COMMANDS: CommandDef[] = [
  { id: "new", label: "새 파일", defaultCombo: "ctrl+n" },
  { id: "open", label: "열기", defaultCombo: "ctrl+o" },
  { id: "save", label: "저장", defaultCombo: "ctrl+s" },
  { id: "saveAs", label: "다른 이름으로 저장", defaultCombo: "ctrl+shift+s" },
  { id: "close", label: "탭 닫기", defaultCombo: "ctrl+w" },
  { id: "find", label: "찾기", defaultCombo: "ctrl+f" },
  { id: "replace", label: "바꾸기", defaultCombo: "ctrl+h" },
  { id: "inClause", label: "IN절 변환", defaultCombo: "ctrl+i" },
  { id: "chips", label: "chips 자동입력", defaultCombo: "ctrl+p" },
  { id: "resetZoom", label: "편집기 확대 초기화", defaultCombo: "ctrl+0" },
];

const CMD_IDS = COMMANDS.map((c) => c.id);
const DEFAULT_KEYBINDS = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.defaultCombo])
) as Record<CmdId, string>;
const CMD_LABEL = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.label])
) as Record<CmdId, string>;

// Standard editing/navigation combos that may NOT be reassigned to an app
// command (they belong to CodeMirror or tab navigation).
const RESERVED_COMBOS = new Set([
  "ctrl+c",
  "ctrl+v",
  "ctrl+x",
  "ctrl+z",
  "ctrl+y",
  "ctrl+a",
  "ctrl+shift+z",
  "ctrl+d",
  "ctrl+tab",
  "ctrl+shift+tab",
]);

// Canonical "ctrl+shift+s" string from a keyboard event, or null when only
// modifiers are held. Meta (⌘) folds into ctrl so bindings are cross-platform.
function comboFromEvent(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (key === "control" || key === "shift" || key === "alt" || key === "meta") {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) =>
      p === "ctrl"
        ? "Ctrl"
        : p === "shift"
        ? "Shift"
        : p === "alt"
        ? "Alt"
        : p === "tab"
        ? "Tab"
        : p === "space"
        ? "Space"
        : p.length === 1
        ? p.toUpperCase()
        : p.charAt(0).toUpperCase() + p.slice(1)
    )
    .join("+");
}

// Merge a persisted keybinding blob over the defaults, keeping only known
// commands and string values so a corrupt/old blob can't break dispatch.
function normalizeKeybinds(raw: any): Record<CmdId, string> {
  const out = { ...DEFAULT_KEYBINDS };
  if (raw && typeof raw === "object") {
    for (const id of CMD_IDS) {
      if (typeof raw[id] === "string" && raw[id]) out[id] = raw[id];
    }
  }
  return out;
}

const WELCOME_MD = `# Chipper에 오신 것을 환영합니다 👋

왼쪽 칸(**소스**)을 편집하면 오른쪽 칸(**미리보기**)에 실시간으로 반영됩니다.
오른쪽 미리보기는 읽기 전용입니다.

## 주요 기능

- **여러 파일**을 탭으로 열고 전환
- \`.md\` · \`.txt\` · \`.html\` 등 열기 / 저장 / 다른 이름으로 저장
- **자동 저장** — 그냥 창을 닫아도 다음 실행 때 그대로 복원됩니다
- 소스 / 분할 / 미리보기 화면 전환

## 단축키

| 동작 | 키 |
| --- | --- |
| 새 파일 | \`Ctrl\` + \`N\` |
| 열기 | \`Ctrl\` + \`O\` |
| 저장 | \`Ctrl\` + \`S\` |
| 다른 이름으로 저장 | \`Ctrl\` + \`Shift\` + \`S\` |
| 탭 닫기 | \`Ctrl\` + \`W\` |
| 다음/이전 탭 | \`Ctrl\` + \`Tab\` |

> 이 환영 문서는 편집하거나 닫아도 됩니다. 마음껏 사용해 보세요!

\`\`\`js
console.log("Hello, Markdown!");
\`\`\`
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function langFromPath(path: string): Lang {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "";
  if (ext === "md" || ext === "markdown" || ext === "mdown" || ext === "mkd") return "markdown";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  return "plaintext";
}

function defaultView(lang: Lang): ViewMode {
  return lang === "plaintext" ? "editor" : "split";
}

function langLabel(lang: Lang): string {
  return lang === "markdown" ? "Markdown" : lang === "html" ? "HTML" : "텍스트";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html);
}

function makeTab(p: Partial<Tab>): Tab {
  const lang = p.lang ?? "markdown";
  return {
    id: p.id ?? newId(),
    title: p.title ?? "제목 없음",
    path: p.path ?? "",
    lang,
    content: p.content ?? "",
    dirty: p.dirty ?? false,
    view: p.view ?? defaultView(lang),
    mtime: p.mtime ?? 0,
    encoding: p.encoding && ENC_IDS.includes(p.encoding) ? p.encoding : "utf-8",
    reloadSeq: p.reloadSeq ?? 0,
    needsLoad: p.needsLoad ?? false,
    loadError: "",
    label: p.label ?? "",
    logColors: p.logColors ?? "",
  };
}

// Sanitize a tab loaded from a persisted session so a corrupt/old blob can't
// break the UI.
function normalizeTab(raw: any): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.content !== "string") return null;
  const lang: Lang =
    raw.lang === "markdown" || raw.lang === "html" || raw.lang === "plaintext"
      ? raw.lang
      : langFromPath(typeof raw.path === "string" ? raw.path : "");
  const view: ViewMode =
    raw.view === "editor" || raw.view === "split" || raw.view === "preview"
      ? raw.view
      : defaultView(lang);
  return makeTab({
    id: typeof raw.id === "string" ? raw.id : undefined,
    title: typeof raw.title === "string" && raw.title ? raw.title : "제목 없음",
    path: typeof raw.path === "string" ? raw.path : "",
    lang,
    content: raw.content,
    dirty: !!raw.dirty,
    view,
    mtime: typeof raw.mtime === "number" ? raw.mtime : 0,
    encoding: typeof raw.encoding === "string" ? raw.encoding : "utf-8",
    reloadSeq: typeof raw.reloadSeq === "number" ? raw.reloadSeq : 0,
    needsLoad: !!raw.needsLoad && typeof raw.path === "string" && raw.path !== "",
    label: typeof raw.label === "string" ? raw.label : "",
    logColors: raw.logColors === "on" || raw.logColors === "off" ? raw.logColors : "",
  });
}

function suggestName(tab: Tab): string {
  if (tab.path) return tab.title;
  const base =
    tab.title && tab.title !== "제목 없음" ? tab.title.replace(/\.[a-z0-9]+$/i, "") : "무제";
  if (tab.lang === "html") return base + ".html";
  if (tab.lang === "plaintext") return base + ".txt";
  return base + ".md";
}

// Parse a selection into an SQL IN-clause. Two accepted shapes:
//  - one token per line (newline-separated) -> "(a,\nb,\nc)"
//  - space-separated tokens on a single line -> "(a, b, c)"
// Anything else is invalid (button stays disabled). Surrounding commas on
// tokens are tolerated so already-comma'd lists convert cleanly.
// Shared tokenizer for both "IN절 변환" and "chips 자동입력". Two accepted shapes:
// one token per line (newline-separated) or space-separated tokens on one line.
function tokenizeList(sel: string): { ok: boolean; items: string[]; multiline: boolean } {
  const s = sel.trim();
  if (!s) return { ok: false, items: [], multiline: false };
  const strip = (t: string) => t.replace(/^[,\s]+|[,\s]+$/g, "");
  if (/\n/.test(s)) {
    const items = s.split(/\r?\n/).map(strip).filter(Boolean);
    if (items.length === 0 || items.some((l) => /\s/.test(l))) {
      return { ok: false, items: [], multiline: true }; // empty or a line has internal spaces
    }
    return { ok: true, items, multiline: true };
  }
  const items = s.split(/\s+/).map((t) => t.replace(/^,+|,+$/g, "")).filter(Boolean);
  if (items.length === 0) return { ok: false, items: [], multiline: false };
  return { ok: true, items, multiline: false };
}

function parseInClause(sel: string): { ok: boolean; result: string } {
  const { ok, items, multiline } = tokenizeList(sel);
  if (!ok) return { ok: false, result: "" };
  return { ok: true, result: "(" + items.join(multiline ? ",\n" : ", ") + ")" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type CommitKey = "enter" | "tab" | "comma";
interface ChipsState {
  phase: "setup" | "countdown" | "typing" | "done";
  items: string[];
  commitKey: CommitKey;
  slow: boolean;
  countStart: number; // configured countdown length (seconds)
  count: number; // countdown seconds remaining
  done: number; // items typed so far
  total: number;
  message: string;
}

// Module-level guard: the guarded silent auto-update path must fire at most once
// per process, even across React StrictMode double-mounts.
let autoApplyFired = false;

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  const [keybinds, setKeybinds] = useState<Record<CmdId, string>>(DEFAULT_KEYBINDS);
  const [keysOpen, setKeysOpen] = useState<boolean>(false); // keybinding settings modal
  // Log colour tags (~/.chipper/tags.json). tagsReady: loaded (or migrated);
  // tagsReadOnlyRef: written by a newer chipper (or unreadable), never saved over.
  const [tagStore, setTagStore] = useState<TagStore>(() => migratedStore(undefined));
  const tagStoreRef = useRef(tagStore);
  tagStoreRef.current = tagStore;
  const [tagsReady, setTagsReady] = useState<boolean>(false);
  const tagsReadyRef = useRef(false);
  const tagsReadOnlyRef = useRef(false);
  const [tagsNotice, setTagsNotice] = useState<string>(""); // shown in the tag window
  // The old session's logRules, carried in the session only until tags.json
  // has been written once — so a failed first tag save loses nothing.
  const legacyRulesRef = useRef<unknown>(undefined);
  const lastSavedTags = useRef(""); // tags.json text last written (or loaded)
  const [tagsOpen, setTagsOpen] = useState<string | null>(null); // tag window, with the tag to select
  const [treeOpen, setTreeOpen] = useState<boolean>(true); // log bundle tree beside the panes
  const [dropSlot, setDropSlot] = useState<number | null>(null); // pane under a tree drag
  const [capturing, setCapturing] = useState<CmdId | null>(null); // row awaiting a key
  const [keyError, setKeyError] = useState<string>("");
  // --- file-association ("파일 연결") modal state ---------------------------
  const [assocOpen, setAssocOpen] = useState<boolean>(false);
  const [assocSupported, setAssocSupported] = useState<boolean>(false); // Windows-only registry panel
  // GOOS of this build. "windows" until the binding answers, so the Windows path
  // (the overwhelmingly common one) never flickers through another platform's UI.
  // Drives the file-association guidance and whether chips auto-typing is offered.
  const [platform, setPlatform] = useState<string>("windows");
  const autotypeSupported = platform !== "linux"; // Win32 SendInput / osascript only
  const [assocTypes, setAssocTypes] = useState<{ ext: string; label: string }[]>([]);
  const [assocChecked, setAssocChecked] = useState<Record<string, boolean>>({});
  const [assocMsg, setAssocMsg] = useState<string>("");
  const [loaded, setLoaded] = useState<boolean>(false);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findReplace, setFindReplace] = useState<boolean>(false);
  const [multi, setMulti] = useState<MultiState>(DEFAULT_MULTI);
  const [focusSlot, setFocusSlot] = useState<number>(0);
  const multiRef = useRef(multi);
  multiRef.current = multi;
  const focusSlotRef = useRef(focusSlot);
  focusSlotRef.current = focusSlot;
  const [paneCounts, setPaneCounts] = useState<Record<string, number>>({});
  const [bundleScan, setBundleScan] = useState<main.Bundle | null>(null);
  const bundleScanRef = useRef(bundleScan);
  bundleScanRef.current = bundleScan;
  // --- live editors ---------------------------------------------------------
  // One EditorView per tab on screen. While mounted, a tab's text lives in its
  // view; tab.content is refreshed only when the editor goes away (onFlush) or a
  // save writes it, so typing never copies the whole document.
  const viewsRef = useRef(new Map<string, EditorView>());
  const setView = useCallback((id: string, v: EditorView | null) => {
    if (v) viewsRef.current.set(id, v);
    else viewsRef.current.delete(id);
  }, []);
  // The editor commands act on: the active tab's view (the focused pane).
  const getFocusedView = useCallback(
    (): EditorView | null => viewsRef.current.get(activeIdRef.current) ?? null,
    []
  );
  const liveContent = useCallback(
    (t: Tab): string => viewsRef.current.get(t.id)?.state.doc.toString() ?? t.content,
    []
  );
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSel: boolean; inOk: boolean } | null>(null);
  const [encMenu, setEncMenu] = useState<boolean>(false);
  const [canInClause, setCanInClause] = useState<boolean>(false);
  const onSelectionChange = useCallback((text: string) => {
    setCanInClause(tokenizeList(text).ok);
  }, []);
  const [chips, setChips] = useState<ChipsState | null>(null);

  // --- auto-update UI state -------------------------------------------------
  // updateBadge is the small pill shown right of the brand. When a newer build
  // exists it's a persistent "download" button that calls ApplyUpdate(info) on
  // click — which opens the release page in the browser (no self-replace).
  const [updateBadge, setUpdateBadge] = useState<{
    text: string;
    info: updater.UpdateInfo | null; // non-null → clickable download badge
  } | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<{
    version: string;
    notes: string;
  } | null>(null);

  // Refs mirroring the latest state so stable callbacks (shortcuts, flush) can
  // read current values without being re-created.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const ratioRef = useRef(splitRatio);
  const fontSizeRef = useRef(fontSize);
  const keybindsRef = useRef(keybinds);
  const keysOpenRef = useRef(keysOpen);
  const capturingRef = useRef(capturing);
  const loadedRef = useRef(loaded);
  const assocOpenRef = useRef(assocOpen);
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  ratioRef.current = splitRatio;
  fontSizeRef.current = fontSize;
  keybindsRef.current = keybinds;
  keysOpenRef.current = keysOpen;
  capturingRef.current = capturing;
  loadedRef.current = loaded;
  assocOpenRef.current = assocOpen;

  const active = tabs.find((t) => t.id === activeId);

  // --- session snapshot -----------------------------------------------------
  const snapshot = useCallback((): string => {
    const s: Session = {
      version: SESSION_VERSION,
      tabs: tabsRef.current.map((t) =>
        t.path && !t.dirty
          ? { ...t, content: "", needsLoad: true, loadError: "" }
          : { ...t, content: liveContent(t) }
      ),
      activeId: activeIdRef.current,
      splitRatio: ratioRef.current,
      fontSize: fontSizeRef.current,
      keybindings: keybindsRef.current,
      ...(legacyRulesRef.current !== undefined ? { logRules: legacyRulesRef.current } : {}),
      multi: multiRef.current,
    };
    return JSON.stringify(s);
  }, [liveContent]);

  // --- initial load (once) --------------------------------------------------
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return; // guard StrictMode double-invoke in dev
    didInit.current = true;
    // Tags: tags.json when there is one; otherwise (first run, or a broken file
    // with no usable .bak) common is built from the old session rules and saved.
    const initTags = async (legacy: unknown) => {
      let store: TagStore | null = null;
      const notes: string[] = [];
      let alarm = false;
      try {
        const r = await LoadTags();
        if (r.broken) {
          alarm = true;
          notes.push(`태그 파일이 깨져 있어 ${r.broken} 로 옮겨 두었습니다 (${r.problem}).`);
        }
        if (r.exists && r.data) {
          store = normalizeTagStore(JSON.parse(r.data));
          // what is on disk counts as saved: no rewrite (and no .bak turnover)
          // at every start just because normalizing changed the formatting
          if (!r.restored) lastSavedTags.current = serializeTags(store);
          if (r.restored) notes.push("직전 태그 파일(tags.json.bak)로 되살렸습니다.");
          if (r.newer) {
            tagsReadOnlyRef.current = true;
            notes.push("더 새 버전의 chipper 가 만든 태그 파일이라, 여기서 바꾼 내용은 저장되지 않습니다.");
          }
        } else if (r.broken) notes.push("기본 규칙으로 다시 시작합니다.");
      } catch (e) {
        console.error("태그 불러오기 실패", e);
        alarm = true;
        notes.push("태그 파일을 읽지 못해 이번에는 저장하지 않습니다: " + String(e));
        tagsReadOnlyRef.current = true; // don't overwrite a file we couldn't read
      }
      if (!store) {
        store = migratedStore(legacy);
        if (Array.isArray(legacy)) legacyRulesRef.current = legacy;
      }
      setTagStore(store);
      tagStoreRef.current = store;
      if (notes.length) {
        setTagsNotice(notes.join(" "));
        if (alarm) alert(notes.join("\n"));
      }
      tagsReadyRef.current = true;
      setTagsReady(true);
    };
    (async () => {
      let legacy: unknown = undefined;
      try {
        const raw = await LoadSession();
        if (raw) {
          const s = JSON.parse(raw);
          legacy = s?.logRules;
          // A recognized session is honored verbatim — including an empty tab
          // list — so "no tabs open" is faithfully restored, not re-welcomed.
          if (s && typeof s.version === "number" && s.version <= SESSION_VERSION && Array.isArray(s.tabs)) {
            const restored = s.tabs.map(normalizeTab).filter(Boolean) as Tab[];
            setTabs(restored);
            const wanted =
              typeof s.activeId === "string" && restored.some((t) => t.id === s.activeId)
                ? s.activeId
                : restored[0]?.id ?? "";
            setActiveId(wanted);
            if (
              typeof s.splitRatio === "number" &&
              s.splitRatio >= 0.15 &&
              s.splitRatio <= 0.85
            ) {
              setSplitRatio(s.splitRatio);
            }
            if (typeof s.fontSize === "number") {
              setFontSize(clampFont(s.fontSize));
            }
            setKeybinds(normalizeKeybinds(s.keybindings));
            setMulti(normalizeMulti(s.multi, new Set(restored.map((t) => t.id))));
            await initTags(legacy);
            setLoaded(true);
            return;
          }
        }
      } catch (e) {
        console.error("세션 복원 실패", e);
      }
      // First run or unrecognized/corrupt session → welcome document.
      if (!tagsReadyRef.current) await initTags(legacy);
      const w = makeTab({
        title: "환영합니다.md",
        content: WELCOME_MD,
        lang: "markdown",
        view: "split",
      });
      setTabs([w]);
      setActiveId(w.id);
      setLoaded(true);
    })();
  }, []);

  // --- auto-update (mount-once) ---------------------------------------------
  // Notify-only. Pop any release notes stashed by a previous version, then check
  // for a newer build; if one exists, leave a persistent manual-download pill
  // next to the brand. We never self-replace the running exe — corporate EDR
  // quarantines self-updating binaries.
  useEffect(() => {
    if (autoApplyFired) return;
    autoApplyFired = true;
    (async () => {
      // One-time notice: auto-update changed to notify-only due to the corporate
      // EDR policy. Fire-and-forget (native dialog, self-guarded to show once,
      // and a no-op off Windows where the policy never applied).
      ShowUpdateModeNoticeOnce().catch(() => {});
      // Learn the platform here rather than in openAssoc: the toolbar's chips
      // auto-typing button is gated on it and renders long before that modal.
      try { setPlatform(await GetPlatform()); } catch { /* keep the default */ }
      try {
        const notes = await GetPendingReleaseNotes();
        if (notes?.version) {
          setReleaseNotes({ version: notes.version, notes: notes.notes ?? "" });
        }
      } catch {
        // ignore — notes are best-effort
      }
      try {
        const r = await AutoUpdate();
        if (r?.info?.available) {
          setUpdateBadge({
            text: `⬆️ 새 버전 ${r.info.latestVersion} — 다운로드`,
            info: r.info,
          });
        }
      } catch {
        // ignore — offline / no releases
      }
    })();
  }, []);

  // --- autosave: debounced, skipped when nothing changed -------------------
  // Serializing every tab on every keystroke is what made big files sluggish,
  // so we only write once typing pauses. A window close still keeps the final
  // keystrokes: Go holds the close and asks for one last snapshot (below).
  const lastSavedSnap = useRef("");
  const saveSessionNow = useCallback(() => {
    if (!loadedRef.current) return;
    const snap = snapshot();
    if (snap === lastSavedSnap.current) return;
    lastSavedSnap.current = snap;
    SaveSession(snap).catch((e) => {
      lastSavedSnap.current = ""; // retry on the next change
      console.error("자동저장 실패", e);
    });
  }, [snapshot]);

  // Keystrokes don't change React state (see viewsRef), so they arm the same
  // timer through markEdited instead of through this effect.
  const autosaveTimer = useRef<number | undefined>(undefined);
  const scheduleAutosave = useCallback(() => {
    window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(saveSessionNow, AUTOSAVE_MS);
  }, [saveSessionNow]);

  useEffect(() => {
    if (!loaded) return;
    scheduleAutosave();
  }, [tabs, activeId, splitRatio, fontSize, keybinds, multi, loaded, scheduleAutosave]);

  // --- tags: debounced save, like the session --------------------------------
  const tagsTimer = useRef<number | undefined>(undefined);
  const saveTagsNow = useCallback(async (): Promise<void> => {
    window.clearTimeout(tagsTimer.current);
    if (!tagsReadyRef.current || tagsReadOnlyRef.current) return;
    const js = serializeTags(tagStoreRef.current);
    if (js === lastSavedTags.current) return;
    lastSavedTags.current = js;
    try {
      await SaveTags(js);
      setTagsNotice((n) => (n.startsWith("태그 저장 실패") ? "" : n));
      if (legacyRulesRef.current !== undefined) {
        legacyRulesRef.current = undefined; // common lives in tags.json from now on
        scheduleAutosave();
      }
    } catch (e) {
      lastSavedTags.current = ""; // retry on the next change
      console.error("태그 저장 실패", e);
      setTagsNotice("태그 저장 실패: " + String(e));
    }
  }, [scheduleAutosave]);
  useEffect(() => {
    if (!tagsReady) return;
    window.clearTimeout(tagsTimer.current);
    // the first run's migrated common is written at once
    const wait = legacyRulesRef.current !== undefined || !lastSavedTags.current ? 0 : TAGS_SAVE_MS;
    tagsTimer.current = window.setTimeout(() => void saveTagsNow(), wait);
  }, [tagStore, tagsReady, saveTagsNow]);

  useEffect(() => {
    const off = EventsOn("chipper:flush-before-close", () => {
      // tags first: once they are on disk the session can drop the old logRules
      saveTagsNow()
        .catch(() => {})
        .finally(() => {
          CloseWithSession(loadedRef.current ? snapshot() : "").catch(() => {});
        });
    });
    return off;
  }, [snapshot, saveTagsNow]);

  // --- flush on focus loss / hide (extra insurance) -------------------------
  useEffect(() => {
    const flush = () => {
      void saveTagsNow();
      saveSessionNow();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [saveSessionNow, saveTagsNow]);

  // --- window title ---------------------------------------------------------
  useEffect(() => {
    const t = tabs.find((x) => x.id === activeId);
    const title = t ? `${t.dirty ? "● " : ""}${t.title} — Chipper` : "Chipper";
    document.title = title;
    try {
      WindowSetTitle(title);
    } catch {
      /* runtime not ready */
    }
  }, [tabs, activeId]);

  // --- actions --------------------------------------------------------------
  const getActive = useCallback(
    () => tabsRef.current.find((t) => t.id === activeIdRef.current),
    []
  );

  // Ask before overwriting a file that changed on disk since we opened/saved it.
  const confirmOverwriteIfChanged = useCallback(async (t: Tab): Promise<boolean> => {
    if (!t.path || !t.mtime) return true;
    try {
      const st = await StatFile(t.path);
      if (st.exists && st.modTime && st.modTime !== t.mtime) {
        return window.confirm(
          `"${t.title}" 파일이 다른 프로그램에서 변경되었습니다.\n지금 편집 중인 내용으로 덮어쓸까요? (디스크의 외부 변경사항은 사라집니다)`
        );
      }
    } catch {
      /* stat failed → proceed */
    }
    return true;
  }, []);

  const doNew = useCallback(() => {
    const tab = makeTab({ title: "제목 없음", content: "", lang: "markdown", view: "split" });
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const doOpen = useCallback(async () => {
    try {
      const res = await OpenFileDialog();
      if (!res || res.canceled) return;
      if (res.binary) {
        alert(`"${res.name}"은(는) 텍스트 문서가 아니어서 열 수 없습니다.`);
        return;
      }
      const existing = tabsRef.current.find((t) => t.path && t.path === res.path);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const lang = langFromPath(res.path);
      const tab = makeTab({
        title: res.name,
        path: res.path,
        content: res.content,
        lang,
        dirty: false,
        view: defaultView(lang),
        mtime: res.modTime,
        encoding: res.encoding,
      });
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
    } catch (e) {
      alert("파일을 열지 못했습니다:\n" + String(e));
    }
  }, []);

  // --- file association ("파일 연결") handlers ------------------------------
  // Opens the modal, loading platform support + per-extension current status.
  const openAssoc = useCallback(async () => {
    setAssocMsg("");
    try {
      const supported = await FileAssociationSupported();
      setAssocSupported(supported);
      try { setPlatform(await GetPlatform()); } catch { /* keep the default */ }
      const types = await SupportedFileTypes();
      const list = (types || []).map((t) => ({ ext: t.ext, label: t.label }));
      setAssocTypes(list);
      if (supported) {
        const status = await AssociationStatus();
        setAssocChecked(Object.fromEntries(list.map((t) => [t.ext, !!status?.[t.ext]])));
      }
    } catch (e) {
      console.error("파일 연결 상태 조회 실패", e);
    }
    setAssocOpen(true);
  }, []);

  // Applies the checkbox selection as a diff against the CURRENT registration
  // (fetched fresh so we never act on stale state): registers newly-checked
  // types, unregisters newly-unchecked ones.
  const doApplyAssoc = useCallback(async () => {
    try {
      const current = await AssociationStatus();
      const toRegister = assocTypes
        .filter((t) => assocChecked[t.ext] && !current?.[t.ext])
        .map((t) => t.ext);
      const toUnregister = assocTypes
        .filter((t) => !assocChecked[t.ext] && current?.[t.ext])
        .map((t) => t.ext);
      if (!toRegister.length && !toUnregister.length) {
        setAssocMsg("변경할 내용이 없습니다.");
        return;
      }
      if (toRegister.length) await RegisterFileTypes(toRegister);
      if (toUnregister.length) await UnregisterFileTypes(toUnregister);
      const status = await AssociationStatus();
      setAssocChecked(Object.fromEntries(assocTypes.map((t) => [t.ext, !!status?.[t.ext]])));
      const parts: string[] = [];
      if (toRegister.length) parts.push(`${toRegister.length}개 형식 연결`);
      if (toUnregister.length) parts.push(`${toUnregister.length}개 형식 해제`);
      setAssocMsg(
        `${parts.join(", ")} 완료. 기본 앱으로 지정하려면 아래 '기본 앱 설정 열기'에서 Chipper를 선택하세요.`
      );
    } catch (e) {
      setAssocMsg("적용 실패: " + String(e));
    }
  }, [assocTypes, assocChecked]);

  // Open one or more files by absolute path (used by drag & drop). Dedupes
  // against already-open tabs and within the batch, skips binaries, and focuses
  // the last one opened.
  // Returns the ids of the tabs (opened or already open) in path order; pass
  // activate=false when the caller places them itself (multi-view panes).
  const openPaths = useCallback(async (paths: string[], activate = true): Promise<string[]> => {
    const seen = new Set(tabsRef.current.filter((t) => t.path).map((t) => t.path));
    const skipped: string[] = [];
    const ids: string[] = [];
    let lastId = "";
    for (const path of paths) {
      if (!path) continue;
      const existing = tabsRef.current.find((t) => t.path === path);
      if (existing) {
        lastId = existing.id;
        ids.push(existing.id);
        continue;
      }
      if (seen.has(path)) continue; // duplicate within this drop batch
      try {
        const res = await ReadFile(path);
        if (!res) continue;
        if (res.binary) {
          skipped.push(res.name || path);
          continue;
        }
        const lang = langFromPath(res.path);
        const tab = makeTab({
          title: res.name,
          path: res.path,
          content: res.content,
          lang,
          dirty: false,
          view: defaultView(lang),
          mtime: res.modTime,
          encoding: res.encoding,
        });
        seen.add(path);
        setTabs((prev) => (prev.some((t) => t.path === tab.path) ? prev : [...prev, tab]));
        lastId = tab.id;
        ids.push(tab.id);
      } catch (e) {
        skipped.push((path.split(/[\\/]/).pop() || path) + " (열기 실패)");
        console.error("드롭 파일 열기 실패", path, e);
      }
    }
    if (activate && lastId) setActiveId(lastId);
    if (skipped.length) {
      alert("다음 파일은 열 수 없습니다 (텍스트 문서가 아니거나 읽기 실패):\n- " + skipped.join("\n- "));
    }
    return ids;
  }, []);

  const doSaveAs = useCallback(async () => {
    const t = getActive();
    if (!t || t.needsLoad) return; // content not read yet — never write ""
    const savedContent = liveContent(t); // exactly what we hand to disk
    try {
      const res = await SaveFileDialog(suggestName(t), savedContent, t.encoding);
      if (!res || res.canceled) return;
      const lang = langFromPath(res.path);
      setTabs((prev) => {
        let next = prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                path: res.path,
                title: res.name,
                lang,
                mtime: res.modTime,
                content: savedContent,
                // stay dirty if the user typed while the dialog was open
                dirty: liveContent(x) !== savedContent,
                view: lang === "plaintext" && x.view === "split" ? "editor" : x.view,
              }
            : x
        );
        // De-duplicate: if another tab is already bound to this path, drop it so
        // two tabs never diverge on the same file.
        const dup = next.find((x) => x.id !== t.id && x.path && x.path === res.path);
        if (dup) next = next.filter((x) => x.id !== dup.id);
        return next;
      });
    } catch (e) {
      alert("저장하지 못했습니다:\n" + String(e));
    }
  }, [getActive, liveContent]);

  const doSave = useCallback(async () => {
    const t = getActive();
    if (!t || t.needsLoad) return; // content not read yet — never write ""
    if (!t.path) {
      await doSaveAs();
      return;
    }
    const savedContent = liveContent(t);
    if (!(await confirmOverwriteIfChanged(t))) return;
    try {
      const doc = await SaveFile(t.path, savedContent, t.encoding);
      setTabs((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? { ...x, content: savedContent, dirty: liveContent(x) !== savedContent, mtime: doc.modTime }
            : x
        )
      );
    } catch (e) {
      alert("저장하지 못했습니다:\n" + String(e));
    }
  }, [getActive, doSaveAs, confirmOverwriteIfChanged, liveContent]);

  const doCloseTab = useCallback((id: string) => {
    const prev = tabsRef.current;
    const t = prev.find((x) => x.id === id);
    if (!t) return;
    if (t.dirty) {
      const ok = window.confirm(
        `"${t.title}"에 저장하지 않은 변경사항이 있습니다.\n탭을 닫으면 자동 복원에서도 제거됩니다. 닫을까요?`
      );
      if (!ok) return;
    }
    const idx = prev.findIndex((x) => x.id === id);
    const next = prev.filter((x) => x.id !== id);
    setTabs(next);
    if (id === activeIdRef.current) {
      const na = next[idx] ?? next[idx - 1] ?? next[0];
      setActiveId(na ? na.id : "");
    }
  }, []);

  // --- deferred read of tabs restored without content ------------------------
  // Only the tab being looked at is read, so a session full of big logs starts
  // fast and holds in memory just what has actually been opened.
  const loadingIds = useRef(new Set<string>());
  const loadTabFromDisk = useCallback(async (t: Tab) => {
    if (loadingIds.current.has(t.id)) return;
    loadingIds.current.add(t.id);
    let res: Awaited<ReturnType<typeof ReadFile>> | null = null;
    let err = "";
    try {
      // Keep the encoding the tab was using; fall back to auto-detection.
      res = await ReadFileAs(t.path, t.encoding).catch(() => ReadFile(t.path));
      if (res?.binary) {
        res = null;
        err = "텍스트 파일이 아닙니다.";
      }
    } catch (e) {
      err = String(e);
    }
    loadingIds.current.delete(t.id);
    setTabs((prev) =>
      prev.map((x) =>
        x.id !== t.id || !x.needsLoad
          ? x
          : res
            ? {
                ...x,
                content: res.content,
                encoding: res.encoding || x.encoding,
                mtime: res.modTime,
                needsLoad: false,
                loadError: "",
                reloadSeq: x.reloadSeq + 1,
              }
            : { ...x, loadError: err || "파일을 읽지 못했습니다." }
      )
    );
  }, []);

  useEffect(() => {
    if (active && active.needsLoad && !active.loadError) loadTabFromDisk(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.needsLoad, active?.loadError, loadTabFromDisk]);

  // --- multi view -----------------------------------------------------------
  // The focused pane's tab is the active tab, so the status bar, save, close and
  // every editor command keep meaning "the editor I am in".
  const focusPane = useCallback((i: number) => {
    const id = multiRef.current.slots[i]?.tabId ?? "";
    setFocusSlot(i);
    activeIdRef.current = id; // a context menu may read it before the re-render
    setActiveId(id);
    const v = id ? viewsRef.current.get(id) : undefined;
    const r = v?.state.selection.main;
    setCanInClause(!!v && !!r && r.to - r.from <= 2_000_000 && tokenizeList(v.state.sliceDoc(r.from, r.to)).ok);
  }, []);

  // Put tabs into panes: the first at `start`, the rest into the next empty
  // visible panes (extras just stay open as tabs). A tab lives in one pane only.
  const placeTabs = useCallback((ids: string[], start: number) => {
    if (!ids.length) return;
    setMulti((m) => {
      const slots = m.slots.map((x) => ({ ...x }));
      const put = (i: number, id: string) => {
        slots.forEach((x) => {
          if (x.tabId === id) x.tabId = "";
        });
        slots[i].tabId = id;
      };
      put(start, ids[0]);
      let k = 1;
      for (let n = 1; n < m.count && k < ids.length; n++) {
        const j = (start + n) % m.count;
        if (!slots[j].tabId) put(j, ids[k++]);
      }
      return { ...m, slots };
    });
    setFocusSlot(start);
    activeIdRef.current = ids[0];
    setActiveId(ids[0]);
  }, []);

  const openIntoPanes = useCallback(
    async (paths: string[], start: number) => {
      const ids = await openPaths(paths, false);
      placeTabs(ids, start);
    },
    [openPaths, placeTabs]
  );

  const openFilesIntoPane = useCallback(
    async (i: number) => {
      try {
        const paths = await OpenFilesDialog();
        if (paths && paths.length) await openIntoPanes(paths, i);
      } catch (e) {
        alert("파일을 열지 못했습니다:\n" + String(e));
      }
    },
    [openIntoPanes]
  );

  // --- log bundle ----------------------------------------------------------------
  // Open one file as a tab (or find it already open); null if not text.
  const openOne = useCallback(async (path: string, label: string): Promise<string | null> => {
    const existing = tabsRef.current.find((t) => samePath(t.path, path));
    if (existing) {
      if (!existing.label) {
        setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, label } : t)));
      }
      return existing.id;
    }
    const res = await ReadFile(path);
    if (!res || res.binary) return null;
    const lang = langFromPath(res.path);
    const tab = makeTab({
      title: res.name,
      path: res.path,
      content: res.content,
      lang,
      view: defaultView(lang),
      mtime: res.modTime,
      encoding: res.encoding,
      label,
    });
    setTabs((prev) => (prev.some((t) => samePath(t.path, tab.path)) ? prev : [...prev, tab]));
    return tab.id;
  }, []);

  const scanBundle = useCallback(async (root: string): Promise<main.Bundle | null> => {
    try {
      const b = await ScanBundle(root);
      setBundleScan(b);
      return b;
    } catch (e) {
      alert("로그 묶음 폴더를 읽지 못했습니다:\n" + String(e));
      return null;
    }
  }, []);

  // Bumped by every bundle switch / new bundle: a switch still awaiting file
  // reads when a newer one starts drops its result instead of overwriting.
  const bundleGen = useRef(0);

  // Choose a bundle folder: one pane per server (up to MAX_PANES), then pick a log.
  const openBundle = useCallback(async () => {
    let root = "";
    try {
      root = await OpenFolderDialog();
    } catch (e) {
      alert("폴더를 고르지 못했습니다:\n" + String(e));
      return;
    }
    if (!root) return;
    const b = await scanBundle(root);
    if (!b) return;
    bundleGen.current++;
    const servers = b.servers.map((x) => x.name);
    const old = multiRef.current.bundle;
    setFindOpen(false);
    setMulti((m) => ({
      on: true,
      count: Math.min(servers.length, MAX_PANES),
      bundle: { root, servers },
      slots: m.slots.map((x, i) => ({ ...x, tabId: "", server: servers[i] ?? "", note: "" })),
    }));
    // Unedited tabs the previous bundle opened go with it.
    if (old) {
      setTabs((prev) => prev.filter((t) => !(t.label && !t.dirty && underRoot(t.path, old.root))));
    }
    setFocusSlot(0);
    activeIdRef.current = "";
    setActiveId("");
    setTreeOpen(true); // pick logs from the tree
    if (servers.length > MAX_PANES) {
      alert(
        `서버 폴더가 ${servers.length}개라 앞의 ${MAX_PANES}개만 칸에 넣었습니다.\n칸 아래 서버 이름을 눌러 다른 서버로 바꿀 수 있습니다.`
      );
    }
  }, [scanBundle]);

  // Show `rel` in the given panes, each from its own server folder (`serverFor`
  // overrides a pane's server, used when the pane's server is being changed).
  // Panes whose server lacks the file say so; two panes never get the same tab.
  // Tabs the switch pushed out of every pane are closed unless edited, so the
  // tab bar doesn't pile up.
  const switchBundleLog = useCallback(
    async (rel: string, only: number | null, serverFor?: { slot: number; server: string }) => {
      const m = multiRef.current;
      if (!m.bundle) return;
      const gen = ++bundleGen.current;
      const root = m.bundle.root;
      // After a restart the file lists aren't loaded yet: read the folder now.
      const scan = bundleScanRef.current?.root === root ? bundleScanRef.current : await scanBundle(root);
      if (!scan || gen !== bundleGen.current) return;
      const serverOf = (i: number) => (serverFor && serverFor.slot === i ? serverFor.server : m.slots[i]?.server ?? "");
      const targets = (only != null ? [only] : Array.from({ length: m.count }, (_, i) => i)).filter((i) => serverOf(i));
      const picks = targets.map((i) => ({ i, server: serverOf(i), file: resolveInServer(scan, serverOf(i), rel) }));
      const big = picks.filter((x) => x.file && !x.file.compressed && x.file.size >= BIG_FILE);
      if (
        big.length &&
        !window.confirm(
          `큰 파일이 있습니다 (${big.map((x) => `${x.server} ${fmtSize(x.file!.size)}`).join(", ")}).\n` +
            "여는 데 오래 걸리고 메모리를 많이 씁니다. 계속할까요?"
        )
      ) {
        return;
      }
      const base = rel.split("/").pop() || rel;
      const result = new Map<number, { tabId: string; note: string; server: string }>();
      // tab id → visible pane showing it. Panes outside this switch keep theirs;
      // a target that would duplicate one gets a note instead.
      const taken = new Map<string, number>();
      m.slots.slice(0, m.count).forEach((x, i) => {
        if (x.tabId && !targets.includes(i)) taken.set(x.tabId, i);
      });
      for (const x of picks) {
        let r = { tabId: "", note: "", server: x.server };
        if (!x.file) r.note = `${x.server}에는 ${base} 가 없습니다`;
        else if (x.file.compressed) r.note = `${x.file.rel} 은 압축 파일이라 열 수 없습니다 (풀어서 여세요)`;
        else {
          let id: string | null = null;
          try {
            id = await openOne(bundlePath(root, x.server, x.file.rel), `${x.server} · ${x.file.rel.split("/").pop()}`);
          } catch {
            id = null;
          }
          if (!id) r.note = `${x.file.rel} 을 열 수 없습니다 (텍스트가 아니거나 읽기 실패)`;
          else if (taken.has(id)) r.note = `같은 파일이 ${taken.get(id)! + 1}번 칸에 열려 있습니다`;
          else {
            taken.set(id, x.i);
            r.tabId = id;
          }
        }
        result.set(x.i, r);
      }
      // A newer switch or another bundle took over while files were read.
      if (gen !== bundleGen.current || multiRef.current.bundle?.root !== root) return;
      const before = multiRef.current;
      // While files were read the user may have shrunk the grid or re-pointed a
      // pane: such panes keep what they have now.
      for (const [i, r] of [...result]) {
        if (i >= before.count || (!(serverFor && serverFor.slot === i) && before.slots[i]?.server !== r.server)) {
          result.delete(i);
        }
      }
      const placed = new Set([...result.values()].map((r) => r.tabId).filter(Boolean));
      const slots = before.slots.map((x, i) => {
        const r = result.get(i);
        if (r) return { ...x, tabId: r.tabId, note: r.note, server: r.server };
        // one pane per tab: a hidden pane (beyond the count) gives up a tab just placed
        return i >= before.count && x.tabId && placed.has(x.tabId) ? { ...x, tabId: "", note: "" } : x;
      });
      const pushedOut = new Set(
        before.slots.map((x) => x.tabId).filter((id) => id && !slots.some((x) => x.tabId === id))
      );
      setMulti({ ...before, slots });
      setTabs((prev) => prev.filter((t) => !(pushedOut.has(t.id) && !t.dirty && t.label)));
      const focusId = slots[focusSlotRef.current]?.tabId ?? "";
      activeIdRef.current = focusId;
      setActiveId(focusId);
    },
    [openOne, scanBundle]
  );

  // Point a pane at another server of the bundle, keeping the log it shows.
  const setPaneServer = useCallback(
    (i: number, server: string) => {
      const m = multiRef.current;
      const cur = tabsRef.current.find((t) => t.id === m.slots[i]?.tabId);
      const prefix = m.bundle && m.slots[i].server ? bundlePath(m.bundle.root, m.slots[i].server, "") : "";
      const rel = cur && prefix && underRoot(cur.path, prefix) ? cur.path.slice(prefix.length).replace(/\\/g, "/") : "";
      if (rel) {
        switchBundleLog(rel, i, { slot: i, server }); // sets the server along with the file
      } else {
        setMulti((mm) => ({ ...mm, slots: mm.slots.map((x, k) => (k === i ? { ...x, server, note: "" } : x)) }));
      }
    },
    [switchBundleLog]
  );

  // Tree: a file goes to the pane following its server — the focused pane if it
  // does, else the first such pane, else the focused pane switches server.
  const openFromTree = useCallback(
    (server: string, rel: string) => {
      const m = multiRef.current;
      const vis = m.slots.slice(0, m.count);
      const f = focusSlotRef.current;
      const idx = vis[f]?.server === server ? f : vis.findIndex((x) => x.server === server);
      const target = idx >= 0 ? idx : Math.min(f, m.count - 1);
      setFocusSlot(target);
      switchBundleLog(rel, target, { slot: target, server });
    },
    [switchBundleLog]
  );

  // After a restart the bundle's file list is read again for the tree.
  useEffect(() => {
    if (loaded && multi.on && multi.bundle && bundleScanRef.current?.root !== multi.bundle.root) {
      scanBundle(multi.bundle.root);
    }
  }, [loaded, multi.on, multi.bundle, scanBundle]);

  const clearPane = useCallback((i: number) => {
    setMulti((m) => ({ ...m, slots: m.slots.map((x, k) => (k === i ? { ...x, tabId: "" } : x)) }));
    if (i === focusSlotRef.current) {
      activeIdRef.current = "";
      setActiveId("");
    }
  }, []);

  const setPaneMode = useCallback((i: number, mode: PaneMode) => {
    setMulti((m) => ({ ...m, slots: m.slots.map((x, k) => (k === i ? { ...x, mode } : x)) }));
  }, []);

  const setPaneCount = useCallback(
    (n: number) => {
      setMulti((m) => ({ ...m, count: n }));
      if (focusSlotRef.current >= n) focusPane(0);
    },
    [focusPane]
  );

  const toggleMulti = useCallback(() => {
    setFindOpen(false);
    setMulti((m) => ({ ...m, on: !m.on }));
  }, []);

  // A tab activated from outside the panes (tab bar, Ctrl+O, a dropped or
  // associated file, a new file) goes into the first empty pane, otherwise
  // replaces the focused one. Already shown → just focus its pane.
  useEffect(() => {
    if (!multi.on || !activeId) return;
    const vis = multi.slots.slice(0, multi.count);
    const at = vis.findIndex((x) => x.tabId === activeId);
    if (at >= 0) {
      if (at !== focusSlot) {
        setFocusSlot(at);
        viewsRef.current.get(activeId)?.focus(); // keys must go where the status bar points
      }
      return;
    }
    let target = vis.findIndex((x) => !x.tabId);
    if (target < 0) target = Math.min(focusSlot, multi.count - 1);
    setMulti((m) => ({
      ...m,
      slots: m.slots.map((x, k) =>
        k === target ? { ...x, tabId: activeId } : x.tabId === activeId ? { ...x, tabId: "" } : x
      ),
    }));
    setFocusSlot(target);
  }, [activeId, multi, focusSlot]);

  // Closed tabs leave their pane empty.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    setMulti((m) =>
      m.slots.some((x) => x.tabId && !ids.has(x.tabId))
        ? { ...m, slots: m.slots.map((x) => (x.tabId && !ids.has(x.tabId) ? { ...x, tabId: "" } : x)) }
        : m
    );
  }, [tabs]);

  // Leaving multi view with an empty pane focused: show some tab again.
  useEffect(() => {
    if (!multi.on && !activeId && tabs.length) setActiveId(tabs[0].id);
  }, [multi.on, activeId, tabs]);

  // Every visible pane reads its file when it first appears (not just the
  // active tab, as in single view).
  useEffect(() => {
    if (!multi.on) return;
    for (const x of multi.slots.slice(0, multi.count)) {
      const t = tabs.find((y) => y.id === x.tabId);
      if (t && t.needsLoad && !t.loadError) loadTabFromDisk(t);
    }
  }, [multi, tabs, loadTabFromDisk]);

  const retryLoad = useCallback((id: string) => {
    setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, loadError: "" } : x)));
  }, []);

  const setViewFor = useCallback((id: string, view: ViewMode) => {
    setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, view } : x)));
  }, []);

  const openFind = useCallback(
    (replace: boolean) => {
      if (multiRef.current.on) {
        setFindReplace(replace);
        setFindOpen(true);
        return;
      }
      const a = getActive();
      if (!a) return;
      if (a.view === "preview") setViewFor(a.id, "split"); // ensure the editor is visible
      setFindReplace(replace);
      setFindOpen(true);
    },
    [getActive, setViewFor]
  );

  // Change the encoding the file is written with (and save now if it has a path).
  const saveWithEncoding = useCallback(
    async (enc: string) => {
      const t = getActive();
      if (!t || t.needsLoad) return; // content not read yet — never write ""
      if (!t.path) {
        // No file yet — just record the intended encoding for the next "다른 이름으로 저장".
        setTabs((prev) => prev.map((x) => (x.id === t.id ? { ...x, encoding: enc } : x)));
        return;
      }
      if (!(await confirmOverwriteIfChanged(t))) return;
      try {
        // Commit the encoding ONLY after the write succeeds, so a failed re-encode
        // (e.g. CP949 with unsupported chars) leaves the tab on its working encoding.
        const text = liveContent(t);
        const doc = await SaveFile(t.path, text, enc);
        setTabs((prev) =>
          prev.map((x) =>
            x.id === t.id
              ? { ...x, content: text, encoding: enc, dirty: liveContent(x) !== text, mtime: doc.modTime }
              : x
          )
        );
      } catch (e) {
        alert("저장하지 못했습니다:\n" + String(e));
      }
    },
    [getActive, confirmOverwriteIfChanged, liveContent]
  );

  // Re-read the file from disk decoding it with a different encoding.
  const reopenWithEncoding = useCallback(
    async (enc: string) => {
      const t = getActive();
      if (!t || !t.path) return;
      if (t.dirty && !window.confirm("저장하지 않은 변경사항이 사라집니다.\n다른 인코딩으로 다시 열까요?")) {
        return;
      }
      const before = liveContent(t);
      try {
        const res = await ReadFileAs(t.path, enc);
        if (!res) return;
        if (res.binary) {
          alert("선택한 인코딩으로는 이 파일을 텍스트로 읽을 수 없습니다.\n다시 열기를 취소했습니다.");
          return;
        }
        // Typed while the file was being read? Don't silently drop it.
        const now = tabsRef.current.find((x) => x.id === t.id);
        if (!now) return;
        if (
          liveContent(now) !== before &&
          !window.confirm("다시 여는 동안 고친 내용이 있습니다.\n그 내용을 버리고 다른 인코딩으로 다시 열까요?")
        ) {
          return;
        }
        setTabs((prev) =>
          prev.map((x) =>
            x.id === t.id
              ? {
                  ...x,
                  content: res.content,
                  encoding: res.encoding,
                  dirty: false,
                  mtime: res.modTime,
                  needsLoad: false,
                  loadError: "",
                  reloadSeq: x.reloadSeq + 1, // force the editor to remount with new content
                }
              : x
          )
        );
      } catch (e) {
        alert("다시 열지 못했습니다:\n" + String(e));
      }
    },
    [getActive, liveContent]
  );

  // --- editor right-click context menu --------------------------------------
  const openCtxMenu = useCallback((e: React.MouseEvent) => {
    // Let the find/replace inputs use the browser's native text menu.
    if ((e.target as HTMLElement).closest(".find-panel")) return;
    e.preventDefault();
    const v = getFocusedView();
    const hasSel = v ? v.state.selection.ranges.some((r) => !r.empty) : false;
    let inOk = false;
    if (v) {
      const r = v.state.selection.main;
      inOk = parseInClause(v.state.sliceDoc(r.from, r.to)).ok;
    }
    const MW = 200;
    const MH = 340;
    const x = Math.min(e.clientX, window.innerWidth - MW);
    const y = Math.min(e.clientY, window.innerHeight - MH);
    setEncMenu(false);
    setCtxMenu({ x, y, hasSel, inOk });
  }, [getFocusedView]);

  const runCtx = useCallback(async (action: string) => {
    setCtxMenu(null);
    const v = getFocusedView();
    if (!v) return;
    v.focus();
    try {
      if (action === "undo") undo(v);
      else if (action === "redo") redo(v);
      else if (action === "selectAll") selectAll(v);
      else if (action === "copy" || action === "cut") {
        const text = v.state.selection.ranges
          .map((r) => v.state.doc.sliceString(r.from, r.to))
          .join("\n");
        if (!text) return;
        const ok = await ClipboardSetText(text);
        if (!ok) {
          alert("클립보드에 복사하지 못했습니다.");
          return;
        }
        // only remove the selection once it is safely on the clipboard
        // (direct dispatches bypass readOnly, so check it ourselves)
        if (action === "cut" && !v.state.readOnly) v.dispatch(v.state.replaceSelection(""));
      } else if (action === "paste") {
        if (v.state.readOnly) return;
        const text = await ClipboardGetText();
        if (text) v.dispatch(v.state.replaceSelection(text));
      }
    } catch (err) {
      console.error("컨텍스트 메뉴 동작 실패", action, err);
    }
  }, [getFocusedView]);

  // Convert the selected ID list into an SQL IN-clause, replacing the selection.
  const doInClause = useCallback(() => {
    const v = getFocusedView();
    if (!v || v.state.readOnly) return;
    const r = v.state.selection.main;
    const parsed = parseInClause(v.state.sliceDoc(r.from, r.to));
    if (!parsed.ok) return;
    v.dispatch({
      changes: { from: r.from, to: r.to, insert: parsed.result },
      selection: { anchor: r.from + parsed.result.length }, // collapse after the result
    });
    v.focus();
  }, [getFocusedView]);

  // --- chips 자동입력 -------------------------------------------------------
  const openChips = useCallback(() => {
    const v = getFocusedView();
    if (!v) return;
    const r = v.state.selection.main;
    const { ok, items } = tokenizeList(v.state.sliceDoc(r.from, r.to));
    if (!ok) return;
    setEncMenu(false);
    setCtxMenu(null);
    setChips({
      phase: "setup",
      items,
      commitKey: "enter",
      slow: false,
      countStart: DEFAULT_COUNT,
      count: DEFAULT_COUNT,
      done: 0,
      total: items.length,
      message: "",
    });
  }, [getFocusedView]);

  // countdown tick
  useEffect(() => {
    if (!chips || chips.phase !== "countdown") return;
    if (chips.count <= 0) {
      setChips((c) => (c && c.phase === "countdown" ? { ...c, phase: "typing", done: 0, message: "" } : c));
      return;
    }
    const h = setTimeout(() => {
      setChips((c) => (c && c.phase === "countdown" ? { ...c, count: c.count - 1 } : c));
    }, 1000);
    return () => clearTimeout(h);
  }, [chips]);

  // run the backend auto-typer once we enter the typing phase
  useEffect(() => {
    if (!chips || chips.phase !== "typing") return;
    let cancelled = false;
    const perItemDelayMs = chips.slow ? 120 : 45;
    TypeChips(chips.items, chips.commitKey, perItemDelayMs)
      .then((res) => {
        if (cancelled) return;
        setChips((c) => (c ? { ...c, phase: "done", done: res.typed, message: res.message } : c));
      })
      .catch((e) => {
        if (cancelled) return;
        setChips((c) => (c ? { ...c, phase: "done", message: String(e) } : c));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips?.phase]);

  // live progress from the backend
  useEffect(() => {
    const cancel = EventsOn("chips:progress", (data: any) => {
      setChips((c) =>
        c && c.phase === "typing"
          ? {
              ...c,
              done: typeof data?.done === "number" ? data.done : c.done,
              total: typeof data?.total === "number" ? data.total : c.total,
            }
          : c
      );
    });
    return () => {
      if (typeof cancel === "function") cancel();
      else EventsOff("chips:progress");
    };
  }, []);

  // auto-close the summary
  useEffect(() => {
    if (chips?.phase !== "done") return;
    const h = setTimeout(() => setChips(null), 3500);
    return () => clearTimeout(h);
  }, [chips?.phase]);

  // Esc: cancel typing, or close the dialog
  useEffect(() => {
    if (!chips) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (chips.phase === "typing") CancelChips();
        else setChips(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chips]);

  // Close popups on outside click / Escape.
  useEffect(() => {
    if (!ctxMenu && !encMenu) return;
    const close = () => {
      setCtxMenu(null);
      setEncMenu(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onEsc);
    };
  }, [ctxMenu, encMenu]);

  // --- command dispatch -----------------------------------------------------
  // Runs an app command by id. Selection-gated commands (inClause/chips) no-op
  // on their own when nothing valid is selected.
  const runCommand = useCallback(
    (id: CmdId) => {
      switch (id) {
        case "new":
          doNew();
          break;
        case "open":
          doOpen();
          break;
        case "save":
          doSave();
          break;
        case "saveAs":
          doSaveAs();
          break;
        case "close":
          if (activeIdRef.current) doCloseTab(activeIdRef.current);
          break;
        case "find":
          openFind(false);
          break;
        case "replace":
          openFind(true);
          break;
        case "inClause":
          doInClause();
          break;
        case "chips":
          openChips();
          break;
        case "resetZoom":
          setFontSize(DEFAULT_FONT_SIZE);
          break;
      }
    },
    [doNew, doOpen, doSave, doSaveAs, doCloseTab, openFind, doInClause, openChips]
  );

  // --- keyboard shortcuts (user-remappable) ---------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysOpenRef.current || assocOpenRef.current) return; // a settings modal owns the keyboard
      const isMod = e.ctrlKey || e.metaKey;
      // Ctrl+Tab / Ctrl+Shift+Tab: fixed tab navigation (not remappable).
      if (isMod && e.key.toLowerCase() === "tab") {
        e.preventDefault();
        const m = multiRef.current;
        if (m.on) {
          const filled = m.slots
            .slice(0, m.count)
            .map((x, i) => (x.tabId ? i : -1))
            .filter((i) => i >= 0);
          if (filled.length < 2) return;
          const at = filled.indexOf(focusSlotRef.current);
          const next = e.shiftKey
            ? filled[(at - 1 + filled.length) % filled.length]
            : filled[(at + 1) % filled.length];
          focusPane(next);
          viewsRef.current.get(m.slots[next].tabId)?.focus();
          return;
        }
        const ts = tabsRef.current;
        if (ts.length < 2) return;
        const i = ts.findIndex((t) => t.id === activeIdRef.current);
        const ni = e.shiftKey ? (i - 1 + ts.length) % ts.length : (i + 1) % ts.length;
        setActiveId(ts[ni].id);
        return;
      }
      if (!isMod && !e.altKey) return; // app commands require a Ctrl/Alt modifier
      const combo = comboFromEvent(e);
      if (!combo) return;
      const binds = keybindsRef.current;
      const id = CMD_IDS.find((k) => binds[k] === combo);
      if (!id) return;
      e.preventDefault();
      const m = multiRef.current;
      if (m.on && m.slots[focusSlotRef.current]?.mode === "lock" && LOCK_BLOCKED_CMDS.has(id)) return;
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand, focusPane]);

  // --- keybinding capture ---------------------------------------------------
  // While a settings row is "listening", the next key combo (re)binds it.
  // Runs in the capture phase and stops propagation so it preempts the normal
  // command handler.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        setKeyError("");
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // modifier-only: keep listening
      if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        setKeyError("Ctrl 또는 Alt 를 포함한 조합을 눌러 주세요.");
        return;
      }
      if (RESERVED_COMBOS.has(combo)) {
        setKeyError(`${formatCombo(combo)} 은(는) 표준 편집/탐색 키라 쓸 수 없어요.`);
        return;
      }
      const conflict = CMD_IDS.find(
        (k) => k !== capturing && keybindsRef.current[k] === combo
      );
      if (conflict) {
        setKeyError(`${formatCombo(combo)} 은(는) 이미 '${CMD_LABEL[conflict]}'에 할당됨.`);
        return;
      }
      setKeybinds((prev) => ({ ...prev, [capturing]: combo }));
      setKeyError("");
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  // Esc closes the keybinding modal (when not mid-capture).
  useEffect(() => {
    if (!keysOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturingRef.current) {
        e.preventDefault();
        setKeysOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOpen]);

  // Esc closes the file-association modal.
  useEffect(() => {
    if (!assocOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setAssocOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assocOpen]);

  // --- Ctrl+wheel: zoom the editor AND preview together ---------------------
  // The WebView's built-in Ctrl+wheel zooms the whole page (toolbar, tabs,
  // buttons and all). We swallow that everywhere so the chrome never scales,
  // and instead drive our own zoom (editor font + preview) whenever the wheel
  // is over the workspace (either pane). Must be non-passive to preventDefault.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // block the webview's page zoom (keeps chrome fixed)
      const overContent = (e.target as HTMLElement | null)?.closest?.(".workspace");
      if (!overContent) return;
      setFontSize((s) => clampFont(s + (e.deltaY < 0 ? 1 : -1)));
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, true);
  }, []);

  // A tree drag cancelled or dropped outside a pane must not leave a pane outlined.
  useEffect(() => {
    const clear = () => setDropSlot(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  // --- drag & drop: open files dropped onto the window ----------------------
  useEffect(() => {
    OnFileDrop((x, y, paths) => {
      if (!paths || !paths.length) return;
      const pane = multiRef.current.on
        ? document.elementFromPoint(x, y)?.closest("[data-slot]")?.getAttribute("data-slot")
        : null;
      if (pane != null) openIntoPanes(paths, Number(pane));
      else openPaths(paths);
    }, false); // false = the whole window is a drop zone
    return () => {
      try {
        OnFileDropOff();
      } catch {
        /* ignore */
      }
    };
  }, [openPaths, openIntoPanes]);

  // --- file-association: open a double-clicked / associated file ------------
  // The running app receives pushes on "chipper:open-files" (2nd launch on
  // Windows, or macOS openFile while running). The very first cold-start file
  // is delivered by the PULL below: FrontendReady() marks us subscribed and
  // returns any path the Go side buffered before this listener existed.
  //
  // Gated on `loaded` so it runs strictly AFTER session restore has applied its
  // tabs. Otherwise the two mount effects race: restore does setTabs(restored)
  // (a full replace) while this one appends the opened file — and if restore's
  // (often larger) round-trip lands last, it clobbers the just-opened tab. The
  // Go side keeps the path buffered (frontendReady=false) until we finally call
  // FrontendReady() here, so deferring loses nothing; EventsOn is subscribed
  // before that call, so no live push can slip through unheard either.
  useEffect(() => {
    if (!loaded) return;
    const off = EventsOn("chipper:open-files", (paths: string[]) => {
      if (paths && paths.length) openPaths(paths);
    });
    FrontendReady()
      .then((paths) => {
        if (paths && paths.length) openPaths(paths);
      })
      .catch(() => {});
    return () => {
      try {
        off();
      } catch {
        /* ignore */
      }
    };
  }, [openPaths, loaded]);

  // visual "drop here" overlay, driven by DOM drag events for file drags
  useEffect(() => {
    let timer: number | undefined;
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      setDragOver(true);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setDragOver(false), 130);
    };
    const clear = () => {
      if (timer) window.clearTimeout(timer);
      setDragOver(false);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // --- preview (debounced so large docs stay responsive) --------------------
  // Only feed the preview while it is on screen: escaping a 10MB log on every
  // edit for a hidden pane was a large part of the lag on big files.
  // Keystrokes don't re-render the app, so the preview and the status-bar
  // character count re-read the live document a moment after typing pauses.
  const [previewSrc, setPreviewSrc] = useState("");
  const [, setDocTick] = useState(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const refreshActive = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      const t = tabsRef.current.find((x) => x.id === activeIdRef.current);
      const on = !!t && t.view !== "editor" && !t.needsLoad && !multiRef.current.on;
      setPreviewSrc(t && on ? liveContent(t) : "");
      setDocTick((n) => n + 1);
    }, PREVIEW_MS);
  }, [liveContent]);
  useEffect(refreshActive, [
    activeId,
    active?.view,
    active?.needsLoad,
    active?.reloadSeq,
    active?.content,
    refreshActive,
  ]);

  const previewHtml = useMemo(() => {
    if (!active) return "";
    if (active.lang === "html") return ""; // handled by the sandboxed iframe
    if (active.lang === "markdown") return renderMarkdown(previewSrc);
    return `<pre class="plain">${escapeHtml(previewSrc)}</pre>`;
  }, [previewSrc, active?.lang]);

  const htmlPreview = active?.lang === "html" ? previewSrc : "";

  // A keystroke in tab `id`'s editor: flag it dirty once, arm the autosave, and
  // refresh the preview/counters when it is the tab on screen.
  const markEdited = useCallback(
    (id: string) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (t && !t.dirty) setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, dirty: true } : x)));
      scheduleAutosave();
      if (id === activeIdRef.current) refreshActive();
    },
    [scheduleAutosave, refreshActive]
  );
  // An edited editor is going away: keep its final text in the tab. A stale
  // editor (the tab was reloaded with new content since) is ignored.
  // The text is also parked in flushedRef because the tab's next editor may
  // mount in the very same commit (pane moved, multi view toggled) — before the
  // state update lands — and must start from it, not from the old content.
  const flushedRef = useRef(new Map<string, { seq: number; text: string }>());
  const flushContent = useCallback((id: string, seq: number, text: string) => {
    flushedRef.current.set(id, { seq, text });
    setTabs((prev) =>
      prev.map((x) => (x.id === id && x.reloadSeq === seq ? { ...x, content: text } : x))
    );
  }, []);
  useEffect(() => {
    flushedRef.current.clear(); // the state now carries every parked text
  }, [tabs]);
  const initialDocFor = useCallback((id: string, seq: number) => {
    const parked = flushedRef.current.get(id);
    if (parked && parked.seq === seq) return parked.text;
    return tabsRef.current.find((x) => x.id === id)?.content ?? "";
  }, []);

  const findTargets = useCallback((): FindTarget[] => {
    const m = multiRef.current;
    if (m.on) {
      const out: FindTarget[] = [];
      for (const x of m.slots.slice(0, m.count)) {
        const v = x.tabId && x.mode !== "lock" ? viewsRef.current.get(x.tabId) : undefined;
        if (v) out.push({ key: x.tabId, view: v });
      }
      return out; // all locked → nothing to search
    }
    const id = activeIdRef.current;
    const v = viewsRef.current.get(id);
    return v ? [{ key: id, view: v }] : [];
  }, []);

  // preview scroll: preserve within a tab, reset to top when switching tabs —
  // one layout effect so no stale offset is ever painted.
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewScroll = useRef(0);
  const lastPreviewTab = useRef<string>("");
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    if (lastPreviewTab.current !== activeId) {
      lastPreviewTab.current = activeId;
      previewScroll.current = 0;
      el.scrollTop = 0;
    } else {
      el.scrollTop = previewScroll.current;
    }
  }, [previewHtml, activeId]);

  // Synced scrolling in split view: scrolling the source or the preview scrolls
  // the other proportionally. (HTML preview is a sandboxed iframe whose scroll
  // the parent cannot read, so sync applies to Markdown/plaintext previews.)
  useEffect(() => {
    if (!active || active.view !== "split" || active.lang === "html") return;
    const view = viewsRef.current.get(active.id);
    const ed = view ? view.scrollDOM : null;
    const pv = previewRef.current;
    if (!ed || !pv) return;

    let activeEl: HTMLElement | null = null;
    let clearTimer: number | undefined;
    const markActive = (el: HTMLElement) => {
      activeEl = el;
      if (clearTimer) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        activeEl = null;
      }, 120);
    };
    const sync = (src: HTMLElement, dst: HTMLElement) => {
      const sMax = src.scrollHeight - src.clientHeight;
      if (sMax <= 0) return;
      const dMax = dst.scrollHeight - dst.clientHeight;
      dst.scrollTop = (src.scrollTop / sMax) * dMax;
    };
    const onEd = () => {
      if (activeEl && activeEl !== ed) return; // driven by a sync from the preview
      markActive(ed);
      sync(ed, pv);
    };
    const onPv = () => {
      if (activeEl && activeEl !== pv) return; // driven by a sync from the editor
      markActive(pv);
      sync(pv, ed);
    };
    ed.addEventListener("scroll", onEd, { passive: true });
    pv.addEventListener("scroll", onPv, { passive: true });
    return () => {
      ed.removeEventListener("scroll", onEd);
      pv.removeEventListener("scroll", onPv);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, active?.view, active?.lang, active?.reloadSeq]);

  const onPreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (a) {
      const href = a.getAttribute("href");
      if (href && /^https?:\/\//i.test(href)) {
        e.preventDefault();
        try {
          BrowserOpenURL(href);
        } catch {
          /* ignore */
        }
      } else {
        e.preventDefault(); // never let the app window navigate away
      }
    }
  };

  // --- tab strip scrolling ---------------------------------------------------
  // With many tabs open the strip overflows and its scrollbar is hidden, so:
  // ‹ › buttons (shown only while overflowing), the mouse wheel scrolls it
  // sideways, and the active tab is always kept in view.
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });

  const updateTabScroll = useCallback(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    setTabScroll((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, []);

  useEffect(() => {
    const bar = tabBarRef.current;
    const el = tabStripRef.current;
    if (!bar || !el) return;
    // Listen on the whole bar so the wheel also works over the ‹ › buttons.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // Ctrl+wheel belongs to the global zoom handler
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? d * 40 : d; // line mode → px
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateTabScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScroll); // window resize
    ro.observe(el);
    return () => {
      bar.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateTabScroll);
      ro.disconnect();
    };
  }, [updateTabScroll]);

  // Tabs added/closed/renamed change scrollWidth without resizing the strip.
  useLayoutEffect(updateTabScroll, [tabs, updateTabScroll]);

  // Bring the active tab into view (Ctrl+Tab, newly opened file, etc.).
  useLayoutEffect(() => {
    const el = tabStripRef.current;
    const t = el?.querySelector<HTMLElement>(".tab.active");
    if (!el || !t) return;
    if (t.offsetLeft < el.scrollLeft) {
      el.scrollLeft = t.offsetLeft;
    } else if (t.offsetLeft + t.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = t.offsetLeft + t.offsetWidth - el.clientWidth;
    }
  }, [activeId, tabs.length]);

  const scrollTabs = (dir: -1 | 1) => {
    const el = tabStripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };
  const tabsOverflow = tabScroll.left || tabScroll.right;

  // --- split resizer --------------------------------------------------------
  const wsRef = useRef<HTMLDivElement | null>(null);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const el = wsRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let r = (ev.clientX - rect.left) / rect.width;
      r = Math.min(0.85, Math.max(0.15, r));
      setSplitRatio(r);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  // --- render ---------------------------------------------------------------
  const view = active?.view ?? "split";
  const showEditor = active ? view === "editor" || view === "split" : false;
  const showPreview = active ? view === "preview" || view === "split" : false;
  const split = showEditor && showPreview;

  // Preview zoom follows the editor zoom (Ctrl+wheel). Markdown/plaintext scale
  // by font-size (keeps the flex box/scroll intact); the HTML iframe scales by
  // injecting a base zoom into its document (only when zoomed, to stay faithful
  // at 1×).
  const previewZoom = fontSize / DEFAULT_FONT_SIZE;
  const previewFontPx = Math.round(15 * previewZoom); // 15px is the 1× base
  const htmlDoc =
    previewZoom === 1 ? htmlPreview : `<style>html{zoom:${previewZoom}}</style>` + htmlPreview;

  // Log colouring: on for log-looking plain text unless the tab says otherwise.
  const logOn = (t: Tab) =>
    t.logColors === "on" || (t.logColors === "" && t.lang === "plaintext" && looksLikeLog(t.title));
  // Tags applied to a tab, and their merged rules. Rule lists are cached per
  // tag combination so editors only reconfigure when the rules really change.
  const ruleCache = useMemo(() => new Map<string, LogRule[]>(), [tagStore]);
  const appliedTags = (t: Tab): AppliedTags => tagsFor(tagStore, t.path, multi.bundle);
  const rulesForTab = (t: Tab): LogRule[] => {
    const names = appliedTags(t).names;
    const key = names.join("\u0000");
    let r = ruleCache.get(key);
    if (!r) {
      r = rulesFor(tagStore, names);
      ruleCache.set(key, r);
    }
    return r;
  };
  const toggleLogColors = (t: Tab) =>
    setTabs((prev) => prev.map((x) => (x.id === t.id ? { ...x, logColors: logOn(t) ? "off" : "on" } : x)));

  // --- multi-view panes ------------------------------------------------------
  const visibleSlots = multi.slots.slice(0, multi.count);
  const renderPane = (slot: Slot, i: number) => {
    const t = slot.tabId ? tabs.find((x) => x.id === slot.tabId) : undefined;
    const focused = i === focusSlot;
    const shownIn = (id: string) => visibleSlots.findIndex((x, k) => k !== i && x.tabId === id);
    const n = t ? paneCounts[t.id] : undefined;
    return (
      <div
        key={i}
        data-slot={i}
        className={`mpane mode-${slot.mode}${focused ? " focused" : ""}${dropSlot === i ? " drop-target" : ""}`}
        style={{ gridColumn: `span ${paneSpan(i, multi.count)}` }}
        onMouseDownCapture={() => {
          if (focusSlotRef.current !== i || activeIdRef.current !== slot.tabId) focusPane(i);
        }}
        onContextMenu={t && !t.needsLoad ? openCtxMenu : undefined}
        // A file dragged from the bundle tree opens here, taking this pane to
        // the file's server. Capture phase, so CodeMirror never treats it as
        // text being dropped into the document.
        onDragOverCapture={(e) => {
          if (!e.dataTransfer.types.includes(TREE_DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (dropSlot !== i) setDropSlot(i);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSlot((d) => (d === i ? null : d));
        }}
        onDropCapture={(e) => {
          const raw = e.dataTransfer.getData(TREE_DRAG_TYPE);
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation();
          setDropSlot(null);
          try {
            const { server, rel } = JSON.parse(raw);
            if (typeof server === "string" && typeof rel === "string") {
              setFocusSlot(i);
              switchBundleLog(rel, i, { slot: i, server });
            }
          } catch {
            /* not ours */
          }
        }}
      >
        <div className="mpane-body">
          {!t ? (
            <div className="empty">
              <div className="empty-title">{slot.server ? slot.server : "빈 칸"}</div>
              {slot.note && <div className="empty-sub">{slot.note}</div>}
              <div className="empty-sub">
                {multi.bundle && slot.server
                  ? "왼쪽 트리에서 이 서버의 파일을 누르세요."
                  : "아래 「탭 고르기」에서 고르거나, 파일을 열거나, 이 칸에 파일을 끌어다 놓으세요."}
              </div>
              <div className="empty-actions">
                {multi.bundle && slot.server && !treeOpen && (
                  <button className="tb-btn" onClick={() => setTreeOpen(true)}>
                    ▶ 트리 펼치기
                  </button>
                )}
                <button className="tb-btn" onClick={() => openFilesIntoPane(i)}>
                  📂 파일 열기
                </button>
              </div>
            </div>
          ) : t.needsLoad ? (
            <div className="empty">
              {t.loadError ? (
                <>
                  <div className="empty-title">파일을 열 수 없습니다</div>
                  <div className="empty-sub">{t.path}</div>
                  <div className="empty-sub">{t.loadError}</div>
                  <div className="empty-actions">
                    <button className="tb-btn" onClick={() => retryLoad(t.id)}>
                      ↻ 다시 시도
                    </button>
                    <button className="tb-btn" onClick={() => doCloseTab(t.id)}>
                      × 탭 닫기
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty-title">불러오는 중…</div>
              )}
            </div>
          ) : (
            <CodeEditor
              key={t.id + "#" + t.reloadSeq}
              initialDoc={() => initialDocFor(t.id, t.reloadSeq)}
              lang={t.lang}
              fontSize={fontSize}
              mode={slot.mode}
              autoFocus={focused}
              logRules={logOn(t) ? rulesForTab(t) : null}
              onDocChanged={() => markEdited(t.id)}
              onFlush={(text) => flushContent(t.id, t.reloadSeq, text)}
              onView={(v) => setView(t.id, v)}
              onSelectionChange={focused ? onSelectionChange : noop}
            />
          )}
        </div>
        <div className="mpane-foot">
          <span className="mp-num">{i + 1}</span>
          {t?.dirty && (
            <span className="dot" title="저장하지 않은 변경사항">
              ●
            </span>
          )}
          {multi.bundle && (
            <select
              className="mp-server"
              value={slot.server}
              title="이 칸이 따라가는 서버 (로그 묶음)"
              onChange={(e) => setPaneServer(i, e.target.value)}
            >
              {!slot.server && <option value="">서버 —</option>}
              {multi.bundle.servers.map((sv) => (
                <option key={sv} value={sv}>
                  {sv}
                </option>
              ))}
            </select>
          )}
          <span className="mp-title" title={t ? t.path || t.title : ""}>
            {t ? (multi.bundle && slot.server && t.label ? t.title : t.label || t.title) : "빈 칸"}
          </span>
          {findOpen && t && (
            <span className="mp-count" title={slot.mode === "lock" ? "잠긴 칸은 찾지 않습니다" : "이 칸에서 찾은 개수"}>
              🔍 {slot.mode === "lock" ? "—" : n === undefined ? "…" : n > 2000 ? "2000+" : n}
            </span>
          )}
          <span className="mp-modes" role="group" aria-label="칸 모드">
            {PANE_MODES.map((m) => (
              <button
                key={m.id}
                className={slot.mode === m.id ? "mp-mode on" : "mp-mode"}
                title={m.tip}
                onClick={() => setPaneMode(i, m.id)}
              >
                {m.icon}
              </button>
            ))}
          </span>
          <select
            className="mp-pick"
            value=""
            title="이 칸에 띄울 탭 고르기"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__open__") openFilesIntoPane(i);
              else if (v) placeTabs([v], i);
            }}
          >
            <option value="">탭 고르기 ▾</option>
            {tabs.map((x) => {
              const o = shownIn(x.id);
              return (
                <option key={x.id} value={x.id}>
                  {x.label || x.title}
                  {x.id === slot.tabId ? "  (이 칸)" : o >= 0 ? `  (${o + 1}번 칸에서 옮김)` : ""}
                </option>
              );
            })}
            <option value="__open__">📂 파일 열기…</option>
          </select>
          {t && (
            <button className="mp-x" title="이 칸 비우기 (탭은 열린 채로 둠)" onClick={() => clearPane(i)}>
              ×
            </button>
          )}
        </div>
      </div>
    );
  };
  const findKey = visibleSlots
    .map((x) => {
      const t = tabs.find((y) => y.id === x.tabId);
      return `${x.tabId}:${x.mode}:${t ? t.reloadSeq : ""}:${t?.needsLoad ? 1 : 0}`;
    })
    .join("|");
  // Navigation keys pressed in a pane move every pane that is not locked. A
  // locked focused pane swallows keys itself (CodeEditor), so nothing moves.
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.target as HTMLElement).closest(".cm-editor")) return; // footer, find panel…
    const cmd = syncedNavCommand(e.nativeEvent);
    if (!cmd) return;
    const m = multiRef.current;
    if (m.slots[focusSlotRef.current]?.mode === "lock") return;
    const views = m.slots
      .slice(0, m.count)
      .filter((x) => x.tabId && x.mode !== "lock")
      .map((x) => viewsRef.current.get(x.tabId))
      .filter((v): v is EditorView => !!v);
    if (views.length < 2) return; // nothing to sync: plain CodeMirror behavior
    e.preventDefault();
    e.stopPropagation();
    runSyncedNav(views, cmd);
  };
  // For the tree: which pane shows which bundle file, and which panes follow a server.
  const treeShown = new Map<string, number[]>();
  const paneOfServer = new Map<string, number[]>();
  if (multi.bundle) {
    visibleSlots.forEach((x, i) => {
      if (!x.server) return;
      paneOfServer.set(x.server, [...(paneOfServer.get(x.server) ?? []), i]);
      const t = x.tabId ? tabs.find((y) => y.id === x.tabId) : undefined;
      const prefix = bundlePath(multi.bundle!.root, x.server, "");
      if (t && underRoot(t.path, prefix)) {
        const k = x.server + "\u0000" + t.path.slice(prefix.length).replace(/\\/g, "/");
        treeShown.set(k, [...(treeShown.get(k) ?? []), i]);
      }
    });
  }
  const multiGrid = (
    <div
      className="multi-grid"
      style={{ gridTemplateRows: multi.count <= 3 ? "1fr" : "1fr 1fr" }}
      onKeyDownCapture={onGridKeyDown}
    >
      {visibleSlots.map(renderPane)}
      {findOpen && (
        <FindReplace
          targets={findTargets}
          targetsKey={findKey}
          focusKey={activeId}
          startInReplace={findReplace}
          onClose={() => setFindOpen(false)}
          onCounts={setPaneCounts}
        />
      )}
    </div>
  );

  // Current display string for a command's shortcut (reflects remaps live).
  const keyHint = (id: CmdId) => formatCombo(keybinds[id]);

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">📎 Chipper</span>
        {updateBadge && (
          <button
            className="update-pill"
            disabled={!updateBadge.info}
            title={
              updateBadge.info
                ? "브라우저에서 릴리스 페이지를 열어 새 버전을 직접 내려받습니다 (자동 교체 안 함)"
                : ""
            }
            onClick={() => {
              if (updateBadge.info) {
                ApplyUpdate(updateBadge.info).catch(() => {});
              }
            }}
            style={{
              marginLeft: 8,
              padding: "2px 10px",
              fontSize: 12,
              lineHeight: 1.6,
              borderRadius: 999,
              border: "1px solid #3a6df0",
              background: updateBadge.info ? "#2b3550" : "transparent",
              color: "#9db8ff",
              cursor: updateBadge.info ? "pointer" : "default",
              whiteSpace: "nowrap",
            }}
          >
            {updateBadge.text}
          </button>
        )}
        <div className="tb-group">
          <button className="tb-btn" onClick={doNew} title={`새 파일 (${keyHint("new")})`}>
            ＋ 새 파일
          </button>
          <button className="tb-btn" onClick={doOpen} title={`열기 (${keyHint("open")})`}>
            📂 열기
          </button>
          <button
            className="tb-btn"
            onClick={doSave}
            title={`저장 (${keyHint("save")})`}
            disabled={!active}
          >
            💾 저장
          </button>
          <button
            className="tb-btn"
            onClick={doSaveAs}
            title={`다른 이름으로 저장 (${keyHint("saveAs")})`}
            disabled={!active}
          >
            다른 이름으로
          </button>
          <button
            className="tb-btn"
            onClick={() => openFind(false)}
            title={`찾기/바꾸기 (${keyHint("find")} / ${keyHint("replace")})`}
            disabled={!active}
          >
            🔍 찾기
          </button>
          <button
            className="tb-btn"
            onClick={doInClause}
            title={
              canInClause
                ? `선택한 ID 목록을 SQL IN 절 (…) 형식으로 변환 (${keyHint("inClause")})`
                : `줄바꿈 또는 공백으로 구분된 ID 목록을 블록 선택하면 활성화됩니다 (${keyHint("inClause")})`
            }
            disabled={!active || !canInClause}
          >
            ( ) IN절 변환
          </button>
          <button
            className="tb-btn"
            onClick={openChips}
            title={
              !autotypeSupported
                ? "chips 자동입력은 Windows·macOS 전용입니다 (리눅스에는 키 입력 합성 경로가 없습니다). 대신 ‘IN절 변환’으로 복사해 붙여넣으세요."
                : canInClause
                  ? `선택한 ID 목록을 외부 chips 입력창에 한 개씩 자동 입력 (${keyHint("chips")})`
                  : `줄바꿈/공백으로 구분된 ID 목록을 블록 선택하면 활성화됩니다 (${keyHint("chips")})`
            }
            disabled={!active || !canInClause || !autotypeSupported}
          >
            ⌨ chips 자동입력
          </button>
        </div>
        <div className="multi-ctl">
          <button
            className={multi.on ? "tb-btn on" : "tb-btn"}
            onClick={toggleMulti}
            title="여러 파일을 나란히 보기 (최대 6칸) — PageDown·방향키·찾기가 모든 칸에서 같이 동작"
          >
            ▦ 멀티 뷰
          </button>
          <button
            className="tb-btn"
            onClick={openBundle}
            title="로그 묶음 열기 — server1, server2… 폴더가 들어 있는 상위 폴더를 고르면 서버마다 한 칸씩 띄우고 왼쪽에 트리를 보여 줍니다. 트리에서 파일을 누르면 그 서버 칸에, ⇉ 는 모든 서버 칸에 열립니다"
          >
            📦 로그 묶음
          </button>
          {multi.on && (
            <div className="seg" role="group" aria-label="칸 수">
              {Array.from({ length: MAX_PANES }, (_, k) => k + 1).map((n) => (
                <button
                  key={n}
                  className={multi.count === n ? "seg-btn on" : "seg-btn"}
                  onClick={() => setPaneCount(n)}
                  title={`${n}칸`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>
        {active && !multi.on && (
          <div className="seg" role="group" aria-label="보기 모드">
            <button
              className={view === "editor" ? "seg-btn on" : "seg-btn"}
              onClick={() => setViewFor(active.id, "editor")}
            >
              소스
            </button>
            <button
              className={view === "split" ? "seg-btn on" : "seg-btn"}
              onClick={() => setViewFor(active.id, "split")}
            >
              분할
            </button>
            <button
              className={view === "preview" ? "seg-btn on" : "seg-btn"}
              onClick={() => setViewFor(active.id, "preview")}
            >
              미리보기
            </button>
          </div>
        )}
        <div className="tb-right">
          <button
            className="tb-btn"
            onClick={openAssoc}
            title="파일 연결 — .md/.txt 등을 Chipper로 여는 기본 앱 설정"
          >
            🔗 파일 연결
          </button>
          <button
            className="tb-btn"
            onClick={() => {
              setKeyError("");
              setCapturing(null);
              setKeysOpen(true);
            }}
            title="단축키 설정 — 특수 기능의 키를 재지정"
          >
            ⌨ 단축키
          </button>
          <span className="autosave">⟳ 자동저장 켜짐</span>
        </div>
      </div>

      <div className="tabbar" ref={tabBarRef}>
        {tabsOverflow && (
          <button
            className="tab-scroll"
            onClick={() => scrollTabs(-1)}
            disabled={!tabScroll.left}
            title="왼쪽 탭 보기 (탭 위에서 휠로도 이동)"
          >
            ‹
          </button>
        )}
        <div className="tabs-scroll" ref={tabStripRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={t.id === activeId ? "tab active" : "tab"}
            onClick={() => setActiveId(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                doCloseTab(t.id);
              }
            }}
            title={t.path || t.title}
          >
            {t.dirty && (
              <span className="dot" aria-hidden>
                ●
              </span>
            )}
            <span className="tab-title">{t.label || t.title}</span>
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                doCloseTab(t.id);
              }}
              title="닫기 (Ctrl+W)"
            >
              ×
            </span>
          </div>
        ))}
        </div>
        {tabsOverflow && (
          <button
            className="tab-scroll"
            onClick={() => scrollTabs(1)}
            disabled={!tabScroll.right}
            title="오른쪽 탭 보기 (탭 위에서 휠로도 이동)"
          >
            ›
          </button>
        )}
        <button className="tab-new" onClick={doNew} title="새 파일 (Ctrl+N)">
          ＋
        </button>
      </div>

      <div className="workspace" ref={wsRef}>
        {multi.on ? (
          <>
            {multi.bundle && bundleScan && bundleScan.root === multi.bundle.root && (treeOpen ? (
              <BundleTree
                key={bundleScan.root}
                scan={bundleScan}
                shown={treeShown}
                paneOfServer={paneOfServer}
                onOpen={openFromTree}
                onOpenAll={(rel) => switchBundleLog(rel, null)}
                onHide={() => setTreeOpen(false)}
                rotationKey={rotationKey}
                fmtSize={fmtSize}
                bigFile={BIG_FILE}
              />
            ) : (
              <button className="bt-show" title="로그 묶음 트리 펼치기" onClick={() => setTreeOpen(true)}>
                ▶
              </button>
            ))}
            {multiGrid}
          </>
        ) : !active ? (
          <div className="empty">
            <div className="empty-title">열린 문서가 없습니다</div>
            <div className="empty-actions">
              <button className="tb-btn" onClick={doNew}>
                ＋ 새 파일
              </button>
              <button className="tb-btn" onClick={doOpen}>
                📂 파일 열기
              </button>
            </div>
          </div>
        ) : active.needsLoad ? (
          <div className="empty">
            {active.loadError ? (
              <>
                <div className="empty-title">파일을 열 수 없습니다</div>
                <div className="empty-sub">{active.path}</div>
                <div className="empty-sub">{active.loadError}</div>
                <div className="empty-actions">
                  <button className="tb-btn" onClick={() => retryLoad(active.id)}>
                    ↻ 다시 시도
                  </button>
                  <button className="tb-btn" onClick={() => doCloseTab(active.id)}>
                    × 탭 닫기
                  </button>
                </div>
              </>
            ) : (
              <div className="empty-title">불러오는 중…</div>
            )}
          </div>
        ) : (
          <>
            {showEditor && (
              <div
                className="pane editor-pane"
                style={split ? { flex: `0 0 ${splitRatio * 100}%` } : { flex: "1 1 0" }}
                onContextMenu={openCtxMenu}
              >
                <div className="pane-head">
                  소스 · 편집
                  <span className="pane-hint">Alt+드래그 멀티커서 · Ctrl+D 다음 선택 · 우클릭 메뉴</span>
                </div>
                <CodeEditor
                  key={active.id + "#" + active.reloadSeq}
                  initialDoc={() => initialDocFor(active.id, active.reloadSeq)}
                  lang={active.lang}
                  fontSize={fontSize}
                  logRules={logOn(active) ? rulesForTab(active) : null}
                  onDocChanged={() => markEdited(active.id)}
                  onFlush={(text) => flushContent(active.id, active.reloadSeq, text)}
                  onView={(v) => setView(active.id, v)}
                  onSelectionChange={onSelectionChange}
                />
                {findOpen && (
                  <FindReplace
                    targets={findTargets}
                    targetsKey={active.id + "#" + active.reloadSeq}
                    focusKey={active.id}
                    startInReplace={findReplace}
                    onClose={() => setFindOpen(false)}
                  />
                )}
              </div>
            )}
            {split && (
              <div className="resizer" onMouseDown={startDrag} title="드래그하여 크기 조절" />
            )}
            {showPreview && (
              <div className="pane preview-pane" style={{ flex: "1 1 0" }}>
                <div className="pane-head">미리보기 · 읽기 전용</div>
                {active.lang === "html" ? (
                  <iframe
                    className="preview-frame"
                    sandbox=""
                    srcDoc={htmlDoc}
                    title="HTML 미리보기"
                  />
                ) : (
                  <div
                    className="preview-md"
                    ref={previewRef}
                    style={{ fontSize: previewFontPx + "px" }}
                    onScroll={(e) => {
                      previewScroll.current = (e.target as HTMLDivElement).scrollTop;
                    }}
                    onClick={onPreviewClick}
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="statusbar">
        {active ? (
          <>
            <span className="st-path">{active.path || "저장되지 않음 (아직 파일 없음)"}</span>
            <span className="st-right">
              <button
                className="st-font"
                title="에디터 글꼴 크기 · Ctrl+휠로 확대/축소, 클릭 또는 Ctrl+0으로 기본값(14px) 재설정"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setFontSize(DEFAULT_FONT_SIZE);
                }}
              >
                {fontSize}px
              </button>
              <span className="st-logwrap">
                <button
                  className={logOn(active) ? "st-log on" : "st-log"}
                  title="로그 색 (ERROR·WARN·INFO·시각 등 하이라이트) 켜기/끄기 — 로그 파일은 자동으로 켜짐"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    toggleLogColors(active);
                  }}
                >
                  🎨 {logOn(active) ? "로그 색" : "로그 색 꺼짐"}
                </button>
                {(() => {
                  const ap = appliedTags(active);
                  const src = ap.source;
                  const from =
                    src.kind === "file"
                      ? `파일 ${src.key} 에 직접 붙은 태그`
                      : src.kind === "dir"
                        ? src.key === ""
                          ? "서버 폴더 전체에 붙은 태그"
                          : `폴더 ${src.key} 에 붙은 태그`
                        : src.kind === "name"
                          ? `이름 「${src.key}」 에 붙은 태그`
                          : "붙은 태그 없음 (common 만)";
                  return (
                    <button
                      className={logOn(active) ? "st-log st-tags on" : "st-log st-tags"}
                      title={`이 탭의 로그 색 태그 — ${from}. 눌러서 태그·규칙 고치기`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setTagsOpen(ap.names.find((n) => n !== COMMON) ?? COMMON);
                      }}
                    >
                      🏷 {ap.names.join(" + ")}
                    </button>
                  );
                })()}
              </span>
              <span className="st-lang">{langLabel(active.lang)}</span>
              <span className="st-enc-wrap">
                <button
                  className="st-enc"
                  title="인코딩 (클릭하여 변경)"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setEncMenu((v) => !v);
                    setCtxMenu(null);
                  }}
                >
                  {encLabel(active.encoding)} ▾
                </button>
                {encMenu && (
                  <div className="enc-menu" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="menu-head">인코딩하여 저장 / 변환</div>
                    {ENCODINGS.map((e) => (
                      <button
                        key={"save-" + e.id}
                        className="menu-item"
                        onClick={() => {
                          setEncMenu(false);
                          saveWithEncoding(e.id);
                        }}
                      >
                        {active.encoding === e.id ? "● " : "   "}
                        {e.label}
                      </button>
                    ))}
                    <div className="menu-sep" />
                    <div className="menu-head">다른 인코딩으로 다시 열기</div>
                    {ENCODINGS.map((e) => (
                      <button
                        key={"open-" + e.id}
                        className="menu-item"
                        disabled={!active.path}
                        onClick={() => {
                          setEncMenu(false);
                          reopenWithEncoding(e.id);
                        }}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                )}
              </span>
              <span className="st-chars">
                {(viewsRef.current.get(active.id)?.state.doc.length ?? active.content.length).toLocaleString()}자
              </span>
              <span className={active.dirty ? "st-dirty on" : "st-dirty"}>
                {active.dirty ? "● 변경됨" : "저장됨"}
              </span>
            </span>
          </>
        ) : (
          <span className="st-path">준비됨</span>
        )}
      </div>

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-box">
            <div className="drop-icon">📥</div>
            <div>파일을 여기에 놓으면 열립니다</div>
            <div className="drop-sub">.md · .txt · .html 등 텍스트 문서</div>
          </div>
        </div>
      )}

      {chips && (
        <div className="chips-overlay">
          <div className="chips-dialog" onMouseDown={(e) => e.stopPropagation()}>
            {chips.phase === "setup" && (
              <>
                <div className="chips-title">⌨ chips 자동입력</div>
                <div className="chips-sub">
                  {chips.total}개 항목을 대상 입력창에 하나씩 자동으로 입력합니다.
                </div>
                <div className="chips-opt-row">
                  <span>확정 키</span>
                  <div className="seg">
                    {(["enter", "tab", "comma"] as CommitKey[]).map((k) => (
                      <button
                        key={k}
                        className={chips.commitKey === k ? "seg-btn on" : "seg-btn"}
                        onClick={() => setChips((c) => (c ? { ...c, commitKey: k } : c))}
                      >
                        {k === "enter" ? "Enter" : k === "tab" ? "Tab" : "쉼표(,)"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="chips-opt-row">
                  <span>카운트다운</span>
                  <div className="chips-stepper">
                    <button
                      aria-label="카운트다운 줄이기"
                      disabled={chips.countStart <= MIN_COUNT}
                      onClick={() =>
                        setChips((c) => (c ? { ...c, countStart: clampCount(c.countStart - 1) } : c))
                      }
                    >
                      −
                    </button>
                    <span className="val">{chips.countStart}초</span>
                    <button
                      aria-label="카운트다운 늘리기"
                      disabled={chips.countStart >= MAX_COUNT}
                      onClick={() =>
                        setChips((c) => (c ? { ...c, countStart: clampCount(c.countStart + 1) } : c))
                      }
                    >
                      ＋
                    </button>
                  </div>
                </div>
                <label className="chips-check">
                  <input
                    type="checkbox"
                    checked={chips.slow}
                    onChange={(e) => setChips((c) => (c ? { ...c, slow: e.target.checked } : c))}
                  />
                  느린 입력 (입력이 누락되면 사용)
                </label>
                <div className="chips-actions">
                  <button
                    className="tb-btn primary"
                    onClick={() =>
                      setChips((c) => (c ? { ...c, phase: "countdown", count: c.countStart } : c))
                    }
                  >
                    시작
                  </button>
                  <button className="tb-btn" onClick={() => setChips(null)}>
                    취소
                  </button>
                </div>
                <div className="chips-hint">
                  시작을 누른 뒤 카운트다운 동안 브라우저의 입력창을 클릭하세요.
                </div>
              </>
            )}
            {chips.phase === "countdown" && (
              <>
                <div className="chips-count">{chips.count}</div>
                <div className="chips-sub">대상 입력창을 클릭하세요…</div>
                <div className="chips-actions">
                  <button className="tb-btn" onClick={() => setChips(null)}>
                    취소
                  </button>
                </div>
                <div className="chips-hint">
                  취소하려면 이 창의 취소 버튼 또는 Esc 를 누르세요.
                </div>
              </>
            )}
            {chips.phase === "typing" && (
              <>
                <div className="chips-title">
                  입력 중… {chips.done}/{chips.total}
                </div>
                <div className="chips-bar">
                  <div
                    className="chips-bar-fill"
                    style={{ width: `${chips.total ? Math.round((chips.done / chips.total) * 100) : 0}%` }}
                  />
                </div>
                <div className="chips-actions">
                  <button className="tb-btn" onClick={() => CancelChips()}>
                    중지
                  </button>
                </div>
                <div className="chips-hint">입력 중에는 대상 창을 벗어나지 마세요.</div>
              </>
            )}
            {chips.phase === "done" && (
              <>
                <div className="chips-title">완료</div>
                <div className="chips-sub">{chips.message}</div>
                <div className="chips-actions">
                  <button className="tb-btn" onClick={() => setChips(null)}>
                    닫기
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="menu-item" onClick={() => runCtx("undo")}>
            실행 취소<span className="menu-key">Ctrl+Z</span>
          </button>
          <button className="menu-item" onClick={() => runCtx("redo")}>
            다시 실행<span className="menu-key">Ctrl+Y</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" disabled={!ctxMenu.hasSel} onClick={() => runCtx("cut")}>
            잘라내기<span className="menu-key">Ctrl+X</span>
          </button>
          <button className="menu-item" disabled={!ctxMenu.hasSel} onClick={() => runCtx("copy")}>
            복사<span className="menu-key">Ctrl+C</span>
          </button>
          <button className="menu-item" onClick={() => runCtx("paste")}>
            붙여넣기<span className="menu-key">Ctrl+V</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => runCtx("selectAll")}>
            모두 선택<span className="menu-key">Ctrl+A</span>
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={!ctxMenu.inOk}
            onClick={() => {
              setCtxMenu(null);
              doInClause();
            }}
          >
            IN절 변환<span className="menu-key">{keyHint("inClause")}</span>
          </button>
          <button
            className="menu-item"
            disabled={!ctxMenu.inOk || !autotypeSupported}
            title={autotypeSupported ? undefined : "chips 자동입력은 Windows·macOS 전용입니다"}
            onClick={() => {
              setCtxMenu(null);
              openChips();
            }}
          >
            chips 자동입력<span className="menu-key">{keyHint("chips")}</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setCtxMenu(null);
              openFind(false);
            }}
          >
            찾기<span className="menu-key">{keyHint("find")}</span>
          </button>
        </div>
      )}


      {tagsOpen !== null && (
        <TagsDialog
          store={tagStore}
          onChange={setTagStore}
          onClose={() => setTagsOpen(null)}
          initial={tagsOpen}
          applied={active ? appliedTags(active).names : [COMMON]}
          notice={tagsNotice}
        />
      )}

      {keysOpen && (
        <div
          className="chips-overlay"
          onMouseDown={() => {
            setKeysOpen(false);
            setCapturing(null);
          }}
        >
          <div className="keys-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="chips-title">⌨ 단축키 설정</div>
            <div className="chips-sub">
              특수 기능의 단축키를 바꿀 수 있어요. 복사·붙여넣기·실행취소 같은 표준 편집 키와
              Ctrl+Tab 탭 이동은 고정입니다.
            </div>
            <div className="keys-list">
              {COMMANDS.map((cmd) => (
                <div className="keys-row" key={cmd.id}>
                  <span className="keys-label">{cmd.label}</span>
                  <button
                    className={capturing === cmd.id ? "keys-bind capturing" : "keys-bind"}
                    onClick={() => {
                      setKeyError("");
                      setCapturing(cmd.id);
                    }}
                    title="클릭한 뒤 새 조합을 누르세요 (Esc 취소)"
                  >
                    {capturing === cmd.id ? "키를 누르세요…" : keyHint(cmd.id)}
                  </button>
                </div>
              ))}
            </div>
            <div className={keyError ? "keys-error on" : "keys-error"}>{keyError || " "}</div>
            <div className="chips-actions">
              <button
                className="tb-btn"
                onClick={() => {
                  setKeybinds(DEFAULT_KEYBINDS);
                  setKeyError("");
                  setCapturing(null);
                }}
              >
                기본값으로 초기화
              </button>
              <button
                className="tb-btn primary"
                onClick={() => {
                  setKeysOpen(false);
                  setCapturing(null);
                }}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {assocOpen && (
        <div className="chips-overlay" onMouseDown={() => setAssocOpen(false)}>
          <div className="keys-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="chips-title">🔗 파일 연결</div>
            {assocSupported ? (
              <>
                <div className="chips-sub">
                  선택한 형식을 Windows의 ‘다른 앱으로 열기’ 목록에 Chipper로 추가합니다.
                  앱이 기본값을 강제로 바꿀 수는 없어, 마지막에 ‘기본 앱 설정 열기’에서 Chipper를
                  기본 앱으로 지정하세요.
                </div>
                <div className="keys-list">
                  {assocTypes.map((t) => (
                    <label className="keys-row" key={t.ext} style={{ cursor: "pointer" }}>
                      <span className="keys-label">{t.label}</span>
                      <input
                        type="checkbox"
                        checked={!!assocChecked[t.ext]}
                        onChange={(e) =>
                          setAssocChecked((prev) => ({ ...prev, [t.ext]: e.target.checked }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className={assocMsg ? "keys-error on" : "keys-error"}>{assocMsg || " "}</div>
                <div className="chips-actions">
                  <button
                    className="tb-btn"
                    onClick={() => OpenDefaultAppsSettings().catch(() => {})}
                    title="Windows 설정 › 기본 앱 에서 형식별 기본 앱을 Chipper로 지정"
                  >
                    기본 앱 설정 열기…
                  </button>
                  <button className="tb-btn primary" onClick={doApplyAssoc}>
                    적용
                  </button>
                  <button className="tb-btn" onClick={() => setAssocOpen(false)}>
                    닫기
                  </button>
                </div>
              </>
            ) : platform === "linux" ? (
              <>
                <div className="chips-sub">리눅스에서 Chipper를 기본 앱으로 지정하는 방법</div>
                <div style={{ fontSize: 13, lineHeight: 1.7, padding: "4px 2px 12px" }}>
                  리눅스에는 앱이 건드릴 수 있는 per-user 레지스트리가 없어, 데스크톱 환경의 파일
                  관리자에서 직접 지정합니다.
                  <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    <li>파일 관리자에서 원하는 파일(예: <code>.md</code>)을 우클릭합니다.</li>
                    <li>
                      <b>‘다른 프로그램으로 열기’</b>(GNOME: ‘다른 응용 프로그램으로 열기’)를 선택합니다.
                    </li>
                    <li>
                      목록에서 <b>Chipper</b>를 고르고 <b>‘기본으로 설정’</b>을 체크한 뒤 엽니다.
                    </li>
                  </ol>
                  <div style={{ marginTop: 8, opacity: 0.8 }}>
                    목록에 Chipper가 안 보이면 <code>~/.local/share/applications/chipper.desktop</code>을
                    만들어 주세요 —{" "}
                    <code>Exec=/경로/chipper %f</code>,{" "}
                    <code>MimeType=text/markdown;text/plain;text/html;</code> 두 줄이 핵심이고,
                    저장 후 <code>update-desktop-database ~/.local/share/applications</code>를 한 번
                    실행합니다. 터미널에서 <code>xdg-mime default chipper.desktop text/markdown</code>로
                    바로 지정할 수도 있습니다.
                  </div>
                </div>
                <div className="chips-actions">
                  <button className="tb-btn primary" onClick={() => setAssocOpen(false)}>
                    닫기
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="chips-sub">macOS에서 Chipper를 기본 앱으로 지정하는 방법</div>
                <div style={{ fontSize: 13, lineHeight: 1.7, padding: "4px 2px 12px" }}>
                  macOS에는 확장자별 기본 앱을 바꾸는 설정 화면이 없어 Finder에서 직접 지정합니다.
                  <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    <li>Finder에서 원하는 파일(예: <code>.md</code>)을 하나 선택합니다.</li>
                    <li>
                      <b>⌘I</b>를 눌러 ‘정보 가져오기’를 엽니다.
                    </li>
                    <li>
                      ‘다음으로 열기’ 항목에서 <b>Chipper</b>를 선택합니다.
                    </li>
                    <li>
                      바로 아래 <b>‘모두 변경…’</b>을 누르고 ‘계속’을 클릭합니다.
                    </li>
                  </ol>
                  <div style={{ marginTop: 8, opacity: 0.8 }}>
                    확장자 종류(텍스트 / HTML / Markdown)마다 한 번씩 반복하면 됩니다. 한 번만 열려면
                    파일 우클릭 → ‘다음으로 열기’ → Chipper.
                  </div>
                </div>
                <div className="chips-actions">
                  <button className="tb-btn primary" onClick={() => setAssocOpen(false)}>
                    닫기
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {releaseNotes && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setReleaseNotes(null);
            MarkReleaseNotesSeen().catch(() => {});
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1e2128",
              color: "#e6e6e6",
              border: "1px solid #3a3f4b",
              borderRadius: 8,
              padding: 20,
              width: "min(560px, 90vw)",
              maxHeight: "80vh",
              overflow: "auto",
              boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              업데이트 완료 — {releaseNotes.version}
            </h3>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "inherit",
                fontSize: 13,
                lineHeight: 1.6,
                margin: "8px 0 16px",
              }}
            >
              {releaseNotes.notes || "새 버전이 적용되었습니다."}
            </pre>
            <div style={{ textAlign: "right" }}>
              <button
                className="tb-btn"
                onClick={() => {
                  setReleaseNotes(null);
                  MarkReleaseNotesSeen().catch(() => {});
                }}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
