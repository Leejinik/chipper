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
import CodeEditor from "./CodeEditor";
import FindReplace from "./FindReplace";
import "./App.css";
import {
  OpenFileDialog,
  ReadFile,
  ReadFileAs,
  SaveFileDialog,
  SaveFile,
  SaveSession,
  StashSession,
  LoadSession,
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
  SupportedFileTypes,
  AssociationStatus,
  RegisterFileTypes,
  UnregisterFileTypes,
  OpenDefaultAppsSettings,
} from "../wailsjs/go/main/App";
import type { updater } from "../wailsjs/go/models";
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

interface Session {
  version: number;
  tabs: Tab[];
  activeId: string;
  splitRatio: number;
  fontSize?: number; // editor font size (px); optional so older sessions still load
  keybindings?: Record<string, string>; // per-command combo overrides
}

const SESSION_VERSION = 2;
const AUTOSAVE_MS = 150;
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

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
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
  const [capturing, setCapturing] = useState<CmdId | null>(null); // row awaiting a key
  const [keyError, setKeyError] = useState<string>("");
  // --- file-association ("파일 연결") modal state ---------------------------
  const [assocOpen, setAssocOpen] = useState<boolean>(false);
  const [assocSupported, setAssocSupported] = useState<boolean>(false); // Windows-only registry panel
  const [assocTypes, setAssocTypes] = useState<{ ext: string; label: string }[]>([]);
  const [assocChecked, setAssocChecked] = useState<Record<string, boolean>>({});
  const [assocMsg, setAssocMsg] = useState<string>("");
  const [loaded, setLoaded] = useState<boolean>(false);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findReplace, setFindReplace] = useState<boolean>(false);
  const editorViewRef = useRef<EditorView | null>(null);
  const onEditorView = useCallback((v: EditorView | null) => {
    editorViewRef.current = v;
  }, []);
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
      tabs: tabsRef.current,
      activeId: activeIdRef.current,
      splitRatio: ratioRef.current,
      fontSize: fontSizeRef.current,
      keybindings: keybindsRef.current,
    };
    return JSON.stringify(s);
  }, []);

  // --- initial load (once) --------------------------------------------------
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return; // guard StrictMode double-invoke in dev
    didInit.current = true;
    (async () => {
      try {
        const raw = await LoadSession();
        if (raw) {
          const s = JSON.parse(raw);
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
            setLoaded(true);
            return;
          }
        }
      } catch (e) {
        console.error("세션 복원 실패", e);
      }
      // First run or unrecognized/corrupt session → welcome document.
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
      // EDR policy. Fire-and-forget (native dialog, self-guarded to show once).
      ShowUpdateModeNoticeOnce().catch(() => {});
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

  // --- autosave: stash to Go every change + debounced disk write ------------
  useEffect(() => {
    if (!loaded) return;
    const snap = snapshot();
    // Keep the backend's in-memory copy current so OnBeforeClose can flush the
    // final keystrokes synchronously even on an abrupt window close.
    StashSession(snap).catch(() => {});
    const h = setTimeout(() => {
      SaveSession(snap).catch((e) => console.error("자동저장 실패", e));
    }, AUTOSAVE_MS);
    return () => clearTimeout(h);
  }, [tabs, activeId, splitRatio, fontSize, keybinds, loaded, snapshot]);

  // --- flush on focus loss / hide (extra insurance) -------------------------
  useEffect(() => {
    const flush = () => {
      if (!loadedRef.current) return;
      const snap = snapshot();
      StashSession(snap).catch(() => {});
      SaveSession(snap).catch(() => {});
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
  }, [snapshot]);

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
  const openPaths = useCallback(async (paths: string[]) => {
    const seen = new Set(tabsRef.current.filter((t) => t.path).map((t) => t.path));
    const skipped: string[] = [];
    let lastId = "";
    for (const path of paths) {
      if (!path) continue;
      const existing = tabsRef.current.find((t) => t.path === path);
      if (existing) {
        lastId = existing.id;
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
      } catch (e) {
        skipped.push((path.split(/[\\/]/).pop() || path) + " (열기 실패)");
        console.error("드롭 파일 열기 실패", path, e);
      }
    }
    if (lastId) setActiveId(lastId);
    if (skipped.length) {
      alert("다음 파일은 열 수 없습니다 (텍스트 문서가 아니거나 읽기 실패):\n- " + skipped.join("\n- "));
    }
  }, []);

  const doSaveAs = useCallback(async () => {
    const t = getActive();
    if (!t) return;
    const savedContent = t.content; // exactly what we hand to disk
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
                // stay dirty if the user typed while the dialog was open
                dirty: x.content !== savedContent,
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
  }, [getActive]);

  const doSave = useCallback(async () => {
    const t = getActive();
    if (!t) return;
    if (!t.path) {
      await doSaveAs();
      return;
    }
    const savedContent = t.content;
    if (!(await confirmOverwriteIfChanged(t))) return;
    try {
      const doc = await SaveFile(t.path, savedContent, t.encoding);
      setTabs((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? { ...x, dirty: x.content !== savedContent, mtime: doc.modTime }
            : x
        )
      );
    } catch (e) {
      alert("저장하지 못했습니다:\n" + String(e));
    }
  }, [getActive, doSaveAs, confirmOverwriteIfChanged]);

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

  const updateContent = useCallback((id: string, content: string) => {
    setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, content, dirty: true } : x)));
  }, []);

  const setViewFor = useCallback((id: string, view: ViewMode) => {
    setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, view } : x)));
  }, []);

  const openFind = useCallback(
    (replace: boolean) => {
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
      if (!t) return;
      if (!t.path) {
        // No file yet — just record the intended encoding for the next "다른 이름으로 저장".
        setTabs((prev) => prev.map((x) => (x.id === t.id ? { ...x, encoding: enc } : x)));
        return;
      }
      if (!(await confirmOverwriteIfChanged(t))) return;
      try {
        // Commit the encoding ONLY after the write succeeds, so a failed re-encode
        // (e.g. CP949 with unsupported chars) leaves the tab on its working encoding.
        const doc = await SaveFile(t.path, t.content, enc);
        setTabs((prev) =>
          prev.map((x) =>
            x.id === t.id
              ? { ...x, encoding: enc, dirty: x.content !== t.content, mtime: doc.modTime }
              : x
          )
        );
      } catch (e) {
        alert("저장하지 못했습니다:\n" + String(e));
      }
    },
    [getActive, confirmOverwriteIfChanged]
  );

  // Re-read the file from disk decoding it with a different encoding.
  const reopenWithEncoding = useCallback(
    async (enc: string) => {
      const t = getActive();
      if (!t || !t.path) return;
      if (t.dirty && !window.confirm("저장하지 않은 변경사항이 사라집니다.\n다른 인코딩으로 다시 열까요?")) {
        return;
      }
      try {
        const res = await ReadFileAs(t.path, enc);
        if (!res) return;
        if (res.binary) {
          alert("선택한 인코딩으로는 이 파일을 텍스트로 읽을 수 없습니다.\n다시 열기를 취소했습니다.");
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
                  reloadSeq: x.reloadSeq + 1, // force the editor to remount with new content
                }
              : x
          )
        );
      } catch (e) {
        alert("다시 열지 못했습니다:\n" + String(e));
      }
    },
    [getActive]
  );

  // --- editor right-click context menu --------------------------------------
  const openCtxMenu = useCallback((e: React.MouseEvent) => {
    // Let the find/replace inputs use the browser's native text menu.
    if ((e.target as HTMLElement).closest(".find-panel")) return;
    e.preventDefault();
    const v = editorViewRef.current;
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
  }, []);

  const runCtx = useCallback(async (action: string) => {
    setCtxMenu(null);
    const v = editorViewRef.current;
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
        if (action === "cut") v.dispatch(v.state.replaceSelection(""));
      } else if (action === "paste") {
        const text = await ClipboardGetText();
        if (text) v.dispatch(v.state.replaceSelection(text));
      }
    } catch (err) {
      console.error("컨텍스트 메뉴 동작 실패", action, err);
    }
  }, []);

  // Convert the selected ID list into an SQL IN-clause, replacing the selection.
  const doInClause = useCallback(() => {
    const v = editorViewRef.current;
    if (!v) return;
    const r = v.state.selection.main;
    const parsed = parseInClause(v.state.sliceDoc(r.from, r.to));
    if (!parsed.ok) return;
    v.dispatch({
      changes: { from: r.from, to: r.to, insert: parsed.result },
      selection: { anchor: r.from + parsed.result.length }, // collapse after the result
    });
    v.focus();
  }, []);

  // --- chips 자동입력 -------------------------------------------------------
  const openChips = useCallback(() => {
    const v = editorViewRef.current;
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
  }, []);

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
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand]);

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

  // --- drag & drop: open files dropped onto the window ----------------------
  useEffect(() => {
    OnFileDrop((_x, _y, paths) => {
      if (paths && paths.length) openPaths(paths);
    }, false); // false = the whole window is a drop zone
    return () => {
      try {
        OnFileDropOff();
      } catch {
        /* ignore */
      }
    };
  }, [openPaths]);

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
  const previewSource = useDebounced(active && active.lang !== "html" ? active.content : "", PREVIEW_MS);
  const previewHtml = useMemo(() => {
    if (!active) return "";
    if (active.lang === "html") return ""; // handled by the sandboxed iframe
    if (active.lang === "markdown") return renderMarkdown(previewSource);
    return `<pre class="plain">${escapeHtml(previewSource)}</pre>`;
  }, [previewSource, active?.lang]);

  const htmlPreview = useDebounced(active && active.lang === "html" ? active.content : "", PREVIEW_MS);

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
    const view = editorViewRef.current;
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
              canInClause
                ? `선택한 ID 목록을 외부 chips 입력창에 한 개씩 자동 입력 (${keyHint("chips")})`
                : `줄바꿈/공백으로 구분된 ID 목록을 블록 선택하면 활성화됩니다 (${keyHint("chips")})`
            }
            disabled={!active || !canInClause}
          >
            ⌨ chips 자동입력
          </button>
        </div>
        {active && (
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

      <div className="tabbar">
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
            <span className="tab-title">{t.title}</span>
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
        <button className="tab-new" onClick={doNew} title="새 파일 (Ctrl+N)">
          ＋
        </button>
      </div>

      <div className="workspace" ref={wsRef}>
        {!active ? (
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
                  initialDoc={active.content}
                  lang={active.lang}
                  fontSize={fontSize}
                  onChange={(text) => updateContent(active.id, text)}
                  onView={onEditorView}
                  onSelectionChange={onSelectionChange}
                />
                {findOpen && (
                  <FindReplace
                    getView={() => editorViewRef.current}
                    viewKey={active.id}
                    docText={active.content}
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
              <span className="st-chars">{active.content.length.toLocaleString()}자</span>
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
            disabled={!ctxMenu.inOk}
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
