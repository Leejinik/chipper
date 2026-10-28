import { useEffect, useRef } from "react";
import { EditorState, Compartment, Prec, type Text } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  search,
  highlightSelectionMatches,
  selectNextOccurrence,
  findNext,
  findPrevious,
  getSearchQuery,
} from "@codemirror/search";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";
import { columnSelection } from "./columnSelection";
import { logHighlighter, type LogRule, type RuleLayers } from "./logHighlight";

export type EditorLang = "markdown" | "html" | "plaintext";

// How a multi-view pane takes the keyboard:
//  edit — normal editing
//  read — read-only: keyboard navigation and copy still work
//  lock — every key is ignored here (except copy); only the mouse moves it
export type PaneMode = "edit" | "read" | "lock";

// In "lock", swallow keys before CodeMirror sees them. Returning true makes the
// view preventDefault but the event still bubbles, so window-level app
// shortcuts (Ctrl+S, Ctrl+F, …) keep working.
const lockKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (e) => !((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c"),
  })
);

function modeExtension(mode: PaneMode) {
  if (mode === "edit") return [];
  if (mode === "read") return EditorState.readOnly.of(true);
  return [EditorState.readOnly.of(true), lockKeys];
}

// F3 / Shift-F3 only jump between matches once a valid query exists (set from
// the custom find panel). Without this guard the raw commands would fall through
// to CodeMirror's own native search panel. Returning true swallows the key.
const findNextSafe = (v: EditorView) => {
  const q = getSearchQuery(v.state);
  return q && q.search && q.valid ? findNext(v) : true;
};
const findPrevSafe = (v: EditorView) => {
  const q = getSearchQuery(v.state);
  return q && q.search && q.valid ? findPrevious(v) : true;
};

function langExtension(lang: EditorLang) {
  if (lang === "markdown") return markdown();
  if (lang === "html") return html();
  return [];
}

// Extra per-view "document changed" listeners (the find panel recounts matches
// with these). Kept outside the editor config so listeners can come and go
// without reconfiguring the view.
const docListeners = new WeakMap<EditorView, Set<() => void>>();
export function subscribeDocChanges(view: EditorView, fn: () => void): () => void {
  let set = docListeners.get(view);
  if (!set) docListeners.set(view, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

// Selections bigger than this are not sliced out for the IN-clause/chips gate:
// Ctrl+A on a 10MB log would otherwise copy and tokenize the whole file.
const SEL_TEXT_CAP = 2_000_000;

// Font size lives in a theme compartment so Ctrl+wheel zoom can reconfigure it
// live. Reconfiguring (rather than mutating CSS) makes CodeMirror re-measure
// character/line geometry, so the caret and selections stay aligned.
function fontSizeTheme(px: number) {
  return EditorView.theme({ "&": { fontSize: px + "px" } });
}

interface Props {
  // Read when the editor mounts (not at render): when the same tab's editor is
  // replaced in one commit, the old one's onFlush has run by then.
  initialDoc: () => string | Text; // a big file's pieces come as a Text (editParts.ts)
  lang: EditorLang;
  fontSize: number;
  // The document is NOT copied out on every keystroke (that made big files
  // sluggish): onDocChanged only signals a change, readers take the text from
  // the view when they need it, and onFlush hands the final text back when the
  // editor goes away after being edited.
  onDocChanged: () => void;
  onFlush: (text: string) => void;
  onView: (view: EditorView | null) => void;
  onSelectionChange: (text: string) => void;
  mode?: PaneMode;
  autoFocus?: boolean; // false for multi-view panes that mount without focus
  logRules?: LogRule[] | RuleLayers | null; // log colouring rules (flat = one layer, or layers: tags then common); null = off
}

// CodeEditor wraps a CodeMirror 6 EditorView. The parent remounts it per tab
// (key={tab.id}), so it owns one document for its lifetime; content flows out
// via onChange. Multi-cursor is enabled: Alt+drag = rectangular/column cursors
// (Notepad++ style), Ctrl+D = select next occurrence (Sublime style), and the
// find panel can turn all matches into cursors via selectMatches.
export default function CodeEditor({
  initialDoc,
  lang,
  fontSize,
  onDocChanged,
  onFlush,
  onView,
  onSelectionChange,
  mode = "edit",
  autoFocus = true,
  logRules = null,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const fontComp = useRef(new Compartment());
  const modeComp = useRef(new Compartment());
  const logComp = useRef(new Compartment());
  const onChangeRef = useRef(onDocChanged);
  const onFlushRef = useRef(onFlush);
  const onViewRef = useRef(onView);
  const onSelRef = useRef(onSelectionChange);
  onChangeRef.current = onDocChanged;
  onFlushRef.current = onFlush;
  onViewRef.current = onView;
  onSelRef.current = onSelectionChange;

  useEffect(() => {
    if (!host.current) return;
    let edited = false;
    const state = EditorState.create({
      doc: initialDoc(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        columnSelection(), // Alt+drag column cursors; Alt can be pressed mid-drag
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search(),
        EditorView.lineWrapping,
        langComp.current.of(langExtension(lang)),
        oneDark,
        fontComp.current.of(fontSizeTheme(fontSize)),
        modeComp.current.of(modeExtension(mode)),
        logComp.current.of(logRules ? logHighlighter(logRules) : []),
        keymap.of([
          indentWithTab,
          { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
          { key: "F3", run: findNextSafe, preventDefault: true },
          { key: "Shift-F3", run: findPrevSafe, preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // A file dropped from Explorer is opened as its own tab by the window-level
        // Wails handler. CodeMirror would ALSO read it and paste its whole text
        // into this document at the drop point, so claim file drops here.
        EditorView.domEventHandlers({
          drop: (e) => !!e.dataTransfer?.types.includes("Files"),
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            edited = true;
            onChangeRef.current();
            docListeners.get(u.view)?.forEach((fn) => fn());
          }
          if (u.docChanged || u.selectionSet) {
            const r = u.state.selection.main;
            onSelRef.current(r.to - r.from > SEL_TEXT_CAP ? "" : u.state.sliceDoc(r.from, r.to));
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    onViewRef.current(view);
    if (autoFocus) view.focus();
    return () => {
      onSelRef.current(""); // clear any selection-dependent UI when the editor goes away
      if (edited) onFlushRef.current(view.state.doc.toString());
      onViewRef.current(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure the language when it changes (e.g. Save As .md -> .html).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: langComp.current.reconfigure(langExtension(lang)) });
  }, [lang]);

  // Apply Ctrl+wheel zoom live. The reconfigure triggers CodeMirror's own
  // re-measure so caret/selection geometry follows the new font size.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: fontComp.current.reconfigure(fontSizeTheme(fontSize)) });
  }, [fontSize]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: modeComp.current.reconfigure(modeExtension(mode)) });
  }, [mode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: logComp.current.reconfigure(logRules ? logHighlighter(logRules) : []) });
  }, [logRules]);

  return <div className="cm-host" ref={host} />;
}
