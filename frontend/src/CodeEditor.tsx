import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
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

export type EditorLang = "markdown" | "html" | "plaintext";

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

// Font size lives in a theme compartment so Ctrl+wheel zoom can reconfigure it
// live. Reconfiguring (rather than mutating CSS) makes CodeMirror re-measure
// character/line geometry, so the caret and selections stay aligned.
function fontSizeTheme(px: number) {
  return EditorView.theme({ "&": { fontSize: px + "px" } });
}

interface Props {
  initialDoc: string;
  lang: EditorLang;
  fontSize: number;
  onChange: (text: string) => void;
  onView: (view: EditorView | null) => void;
  onSelectionChange: (text: string) => void;
}

// CodeEditor wraps a CodeMirror 6 EditorView. The parent remounts it per tab
// (key={tab.id}), so it owns one document for its lifetime; content flows out
// via onChange. Multi-cursor is enabled: Alt+drag = rectangular/column cursors
// (Notepad++ style), Ctrl+D = select next occurrence (Sublime style), and the
// find panel can turn all matches into cursors via selectMatches.
export default function CodeEditor({ initialDoc, lang, fontSize, onChange, onView, onSelectionChange }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const fontComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onViewRef = useRef(onView);
  const onSelRef = useRef(onSelectionChange);
  onChangeRef.current = onChange;
  onViewRef.current = onView;
  onSelRef.current = onSelectionChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: initialDoc,
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
        keymap.of([
          indentWithTab,
          { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
          { key: "F3", run: findNextSafe, preventDefault: true },
          { key: "Shift-F3", run: findPrevSafe, preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const r = u.state.selection.main;
            onSelRef.current(u.state.sliceDoc(r.from, r.to));
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    onViewRef.current(view);
    view.focus();
    return () => {
      onSelRef.current(""); // clear any selection-dependent UI when the editor goes away
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

  return <div className="cm-host" ref={host} />;
}
