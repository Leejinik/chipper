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
import { subscribeDocChanges } from "./CodeEditor";

// One editor the panel searches. In multi view every synced pane is a target;
// otherwise it is just the active editor.
export interface FindTarget {
  key: string; // tab id
  view: EditorView;
}

interface Props {
  targets: () => FindTarget[];
  targetsKey: string; // changes when the set of target views changes → re-sync
  focusKey: string; // the focused target: replace / find-all act on it alone
  startInReplace: boolean;
  onClose: () => void;
  onCounts?: (counts: Record<string, number>) => void; // per-target match counts
}

const COUNT_CAP = 2000; // stop counting past this (keeps huge files responsive)
const SELECT_CAP = 10000; // max cursors created by "모두 찾기"
const RECOUNT_MS = 150; // recount this long after edits stop

const EMPTY_QUERY = new SearchQuery({ search: "" });

function countMatches(q: SearchQuery, view: EditorView): number {
  let c = 0;
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
  return c;
}

// A Microsoft-Office-style Find & Replace panel. The query highlights in every
// target and ▲/▼ move each target to its own next match; "바꾸기", "모두 바꾸기"
// and "모두 찾기" (every match as a cursor, Sublime style) touch only the
// focused editor, so one keystroke never rewrites several files.
export default function FindReplace({
  targets,
  targetsKey,
  focusKey,
  startInReplace,
  onClose,
  onCounts,
}: Props) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(startInReplace);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const findRef = useRef<HTMLInputElement>(null);
  const touched = useRef(new Set<EditorView>()); // views we put a query into
  const onCountsRef = useRef(onCounts);
  onCountsRef.current = onCounts;

  const buildQuery = () =>
    new SearchQuery({
      search: findText,
      replace: replaceText,
      caseSensitive,
      wholeWord,
      regexp,
    });

  // Push the current query into a view so matches highlight and the commands
  // operate on it. Returns the query.
  const commit = (view: EditorView): SearchQuery => {
    const q = buildQuery();
    view.dispatch({ effects: setSearchQuery.of(q) });
    touched.current.add(view);
    return q;
  };

  const query = buildQuery();
  const canRun = !!findText && query.valid; // false on empty box or in-progress invalid regex

  const publish = (next: Record<string, number>) => {
    setCounts(next);
    onCountsRef.current?.(next);
  };

  // Keep every target's query + match count in sync with the inputs/options and
  // the set of targets; recount a target shortly after its document changes.
  useEffect(() => {
    const list = targets();
    const live = new Set(list.map((t) => t.view));
    // Views that dropped out of the target set lose their highlight.
    for (const v of touched.current) {
      if (!live.has(v)) {
        v.dispatch({ effects: setSearchQuery.of(EMPTY_QUERY) });
        touched.current.delete(v);
      }
    }
    const current: Record<string, number> = {};
    for (const t of list) {
      const q = commit(t.view);
      current[t.key] = findText && q.valid ? countMatches(q, t.view) : 0;
    }
    publish(current);

    const timers = new Map<string, number>();
    const unsubs = list.map((t) =>
      subscribeDocChanges(t.view, () => {
        window.clearTimeout(timers.get(t.key));
        timers.set(
          t.key,
          window.setTimeout(() => {
            const q = buildQuery();
            current[t.key] = findText && q.valid ? countMatches(q, t.view) : 0;
            publish({ ...current });
          }, RECOUNT_MS)
        );
      })
    );
    return () => {
      unsubs.forEach((u) => u());
      timers.forEach((h) => window.clearTimeout(h));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findText, replaceText, caseSensitive, wholeWord, regexp, targetsKey]);

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, []);

  useEffect(() => {
    if (startInReplace) setShowReplace(true);
  }, [startInReplace]);

  // Clear the highlight everywhere when the panel closes.
  useEffect(() => {
    return () => {
      for (const v of touched.current) {
        try {
          v.dispatch({ effects: setSearchQuery.of(EMPTY_QUERY) });
        } catch {
          /* view already destroyed */
        }
      }
      touched.current.clear();
      onCountsRef.current?.({});
    };
  }, []);

  const focused = (): EditorView | null => targets().find((t) => t.key === focusKey)?.view ?? null;

  // Move every target to its next/previous match. Never lets an empty/invalid
  // query fall through to CodeMirror's own native search panel. Focus stays in
  // the panel (Office style): handing it to the editor made the next Enter type
  // a newline into the document instead of finding the next match.
  const step = (fn: (v: EditorView) => boolean | void) => {
    if (!findText) return;
    for (const t of targets()) {
      const q = commit(t.view);
      if (!q.valid) return;
      fn(t.view);
    }
  };

  // Run an editing command on the focused editor only.
  const runFocused = (fn: (v: EditorView) => boolean | void) => {
    const v = focused();
    if (!v || !findText) return;
    const q = commit(v);
    if (!q.valid) return;
    fn(v);
    v.focus();
  };

  // Select every match in the focused editor as a cursor. We build the selection
  // ourselves (instead of the built-in selectMatches, which silently no-ops past
  // 1000 matches).
  const doFindAll = () => {
    const v = focused();
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
      const v = focused();
      onClose();
      v?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      step((v) => (e.shiftKey ? findPrevious(v) : findNext(v)));
    }
  };

  const keys = Object.keys(counts);
  const fmt = (n: number) => (n > COUNT_CAP ? `${COUNT_CAP}+` : `${n}`);
  const total = keys.reduce((a, k) => a + Math.min(counts[k], COUNT_CAP + 1), 0);
  const countLabel = !findText
    ? ""
    : keys.length > 1
      ? `${keys.length}칸 ${keys.some((k) => counts[k] > COUNT_CAP) ? `${total}+` : total}개`
      : `${fmt(counts[keys[0]] ?? 0)}개`;
  const focusEditable = (() => {
    const v = focused();
    return !!v && !v.state.readOnly;
  })();

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
        <span className="find-count" title={keys.length > 1 ? "칸마다의 개수는 각 칸 아래에 표시됩니다" : ""}>
          {countLabel}
        </span>
        <button className="find-btn" onClick={() => step(findPrevious)} disabled={!canRun} title="이전 찾기 (Shift+Enter)">
          ▲
        </button>
        <button className="find-btn" onClick={() => step(findNext)} disabled={!canRun} title="다음 찾기 (Enter)">
          ▼
        </button>
        <button
          className="find-btn wide"
          onClick={doFindAll}
          disabled={!canRun}
          title={keys.length > 1 ? "지금 선택한 칸에서만 모두 찾기 → 멀티 커서" : "모두 찾기 → 멀티 커서"}
        >
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
          <button
            className="find-btn wide"
            onClick={() => runFocused(replaceNext)}
            disabled={!canRun || !focusEditable}
            title={focusEditable ? "현재 항목 바꾸기" : "읽기 전용 칸에서는 바꿀 수 없습니다"}
          >
            바꾸기
          </button>
          <button
            className="find-btn wide"
            onClick={() => runFocused(replaceAll)}
            disabled={!canRun || !focusEditable}
            title={
              !focusEditable
                ? "읽기 전용 칸에서는 바꿀 수 없습니다"
                : keys.length > 1
                  ? "지금 선택한 칸에서만 모두 바꾸기"
                  : "모두 바꾸기"
            }
          >
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
