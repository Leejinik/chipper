import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection, SelectionRange } from "@codemirror/state";
import {
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from "@codemirror/search";

interface Props {
  getView: () => EditorView | null;
  viewKey: string; // active tab id — re-sync query/count when the view changes
  docText: string; // active doc content — re-count when the document changes
  startInReplace: boolean;
  onClose: () => void;
}

const COUNT_CAP = 2000; // stop counting past this (keeps huge files responsive)
const SELECT_CAP = 10000; // max cursors created by "모두 찾기"

// A Microsoft-Office-style Find & Replace panel that drives the active
// CodeMirror view. "모두 찾기" turns every match into a cursor (Sublime style).
export default function FindReplace({ getView, viewKey, docText, startInReplace, onClose }: Props) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(startInReplace);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [count, setCount] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);

  const buildQuery = () =>
    new SearchQuery({
      search: findText,
      replace: replaceText,
      caseSensitive,
      wholeWord,
      regexp,
    });

  // Push the current query into the editor so matches highlight and the
  // commands operate on it. Returns the query.
  const commit = (view: EditorView): SearchQuery => {
    const q = buildQuery();
    view.dispatch({ effects: setSearchQuery.of(q) });
    return q;
  };

  const query = buildQuery();
  const canRun = !!findText && query.valid; // false on empty box or in-progress invalid regex

  // Keep query + match count synced with the inputs/options, the active view
  // (viewKey), and the document (docText: replace/edits change the count).
  useEffect(() => {
    const view = getView();
    if (!view) {
      setCount(0);
      return;
    }
    const q = commit(view);
    let c = 0;
    if (findText && q.valid) {
      try {
        const cursor = q.getCursor(view.state);
        let r = cursor.next();
        while (!r.done && c <= COUNT_CAP) {
          c++;
          r = cursor.next();
        }
      } catch {
        c = 0;
      }
    }
    setCount(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findText, replaceText, caseSensitive, wholeWord, regexp, viewKey, docText]);

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, []);

  useEffect(() => {
    if (startInReplace) setShowReplace(true);
  }, [startInReplace]);

  // Clear the highlight when the panel closes.
  useEffect(() => {
    return () => {
      const v = getView();
      if (v) v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run a find/replace command, but never let an empty/invalid query fall
  // through to CodeMirror's own native search panel.
  const run = (fn: (v: EditorView) => boolean | void) => {
    const v = getView();
    if (!v || !findText) return;
    const q = commit(v);
    if (!q.valid) return;
    fn(v);
    v.focus();
  };

  // Select every match as a cursor. We build the selection ourselves (instead of
  // the built-in selectMatches, which silently no-ops past 1000 matches).
  const doFindAll = () => {
    const v = getView();
    if (!v || !findText) return;
    const q = commit(v);
    if (!q.valid) return;
    const ranges: SelectionRange[] = [];
    let overflow = false;
    try {
      const cursor = q.getCursor(v.state);
      let r = cursor.next();
      while (!r.done) {
        if (ranges.length >= SELECT_CAP) {
          overflow = true;
          break;
        }
        ranges.push(EditorSelection.range(r.value.from, r.value.to));
        r = cursor.next();
      }
    } catch {
      return;
    }
    if (!ranges.length) return;
    v.dispatch({ selection: EditorSelection.create(ranges), userEvent: "select.search.matches" });
    v.focus();
    onClose();
    if (overflow) {
      alert(`일치 항목이 너무 많아 ${SELECT_CAP.toLocaleString()}개까지만 커서로 선택했습니다.`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      const v = getView();
      onClose();
      v?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run((v) => (e.shiftKey ? findPrevious(v) : findNext(v)));
    }
  };

  const countLabel = findText ? (count > COUNT_CAP ? `${COUNT_CAP}+개` : `${count}개`) : "";

  return (
    <div className="find-panel" onKeyDown={onKeyDown}>
      <div className="find-head">
        <span className="find-title">{showReplace ? "찾기 및 바꾸기" : "찾기"}</span>
        <button className="find-x" onClick={onClose} title="닫기 (Esc)">
          ×
        </button>
      </div>

      <div className="find-row">
        <input
          ref={findRef}
          className={"find-input" + (findText && !query.valid ? " invalid" : "")}
          placeholder="찾을 내용"
          value={findText}
          onChange={(e) => setFindText(e.target.value)}
        />
        <span className="find-count">{countLabel}</span>
        <button className="find-btn" onClick={() => run(findPrevious)} disabled={!canRun} title="이전 찾기 (Shift+Enter)">
          ▲
        </button>
        <button className="find-btn" onClick={() => run(findNext)} disabled={!canRun} title="다음 찾기 (Enter)">
          ▼
        </button>
        <button className="find-btn wide" onClick={doFindAll} disabled={!canRun} title="모두 찾기 → 멀티 커서">
          모두 찾기
        </button>
      </div>

      {showReplace && (
        <div className="find-row">
          <input
            className="find-input"
            placeholder="바꿀 내용"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button className="find-btn wide" onClick={() => run(replaceNext)} disabled={!canRun} title="현재 항목 바꾸기">
            바꾸기
          </button>
          <button className="find-btn wide" onClick={() => run(replaceAll)} disabled={!canRun} title="모두 바꾸기">
            모두 바꾸기
          </button>
        </div>
      )}

      <div className="find-opts">
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          대/소문자 구분
        </label>
        <label>
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
          단어 단위
        </label>
        <label>
          <input type="checkbox" checked={regexp} onChange={(e) => setRegexp(e.target.checked)} />
          정규식
        </label>
        <button className="find-toggle" onClick={() => setShowReplace((v) => !v)}>
          {showReplace ? "찾기만" : "바꾸기 표시"}
        </button>
      </div>
    </div>
  );
}
