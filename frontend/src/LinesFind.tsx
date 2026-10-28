import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FilterFind } from "../wailsjs/go/main/App";
import { linefilter } from "../wailsjs/go/models";
import { compileRule, ruleCheck, type LogRule, type RuleKind, type RuleMatcher } from "./logHighlight";
import "./LinesFind.css";

// 「찾기」 (Ctrl+F) inside the 「🏷 태그 줄만」 view (2단계 판정 ③).
//
// The view holds only the pages around the screen (LinesView: up to 60,000 of
// possibly millions of rows), so finding among 「the rows fetched」 would miss
// most of the result and 「다음」 could not reach far rows. The search runs in
// Go over the whole filtered result instead (FilterFind → linefilter.Find):
// one call lists every matching row (up to 100,000, the count goes on), then
// ▲▼ / Enter move between them here without asking again. It runs again when
// the query, the context sizes or the result change (while the scan is still
// running, every 0.7s with 「지금까지」 shown).
// The matches on screen are highlighted with the CSS Custom Highlight API (no
// change to the rows' DOM); the current one is the selected row.
// Query kinds are the tag rules' (글자 그대로 / 단어 / 정규식, the same RE2
// translation in Go and here), so what Go counts is what is highlighted.

export const LINES_FIND_EVENT = "chipper:lines-find";

// The 「줄만」 view of a tab (App wraps each in .lines-host[data-tab]).
export function linesFindHost(tabId: string): HTMLElement | null {
  if (!tabId) return null;
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(tabId) : tabId.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLElement>(`.lines-host[data-tab="${esc}"] .lines-view`);
}
// Ask that view to open (or focus) its find bar. false = no such view.
export function openLinesFind(host: HTMLElement | null): boolean {
  if (!host) return false;
  host.dispatchEvent(new CustomEvent(LINES_FIND_EVENT));
  return true;
}

// For LinesView: [open, close, focus nonce] driven by LINES_FIND_EVENT on root.
export function useLinesFindOpen(rootRef: RefObject<HTMLElement>): [boolean, () => void, number] {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const on = () => {
      setOpen(true);
      setNonce((n) => n + 1);
    };
    el.addEventListener(LINES_FIND_EVENT, on);
    return () => el.removeEventListener(LINES_FIND_EVENT, on);
  }, [rootRef]);
  return [open, useCallback(() => setOpen(false), []), nonce];
}

// --- highlights (one registry for all views: CSS.highlights is per document) ---
const hlAll = new Map<number, { all: Range[]; cur: Range[] }>();
let hlSeq = 0;
function publish() {
  const reg = (globalThis as any).CSS?.highlights;
  const H = (globalThis as any).Highlight;
  if (!reg || !H) return;
  const all: Range[] = [];
  const cur: Range[] = [];
  for (const v of hlAll.values()) {
    all.push(...v.all);
    cur.push(...v.cur);
  }
  if (all.length) reg.set("lv-find", new H(...all));
  else reg.delete("lv-find");
  if (cur.length) reg.set("lv-find-cur", new H(...cur));
  else reg.delete("lv-find-cur");
}
// Ranges of the matches in one row's text element (the painted spans; the
// 「… 긴 줄」 notes after the text are not part of the line).
function rowRanges(el: Element, m: RuleMatcher): Range[] {
  const nodes: Text[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest(".lv-cut") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n as Text);
  const starts: number[] = [];
  let text = "";
  for (const n of nodes) {
    starts.push(text.length);
    text += n.data;
  }
  const f = m.ranges(text);
  if (!f.length) return [];
  const at = (p: number): [Text, number] => {
    let k = 0;
    while (k + 1 < nodes.length && starts[k + 1] <= p) k++;
    return [nodes[k], p - starts[k]];
  };
  const out: Range[] = [];
  for (let k = 0; k < f.length; k += 2) {
    const r = document.createRange();
    const [a, ao] = at(f[k]);
    const [b, bo] = at(f[k + 1] - 1);
    r.setStart(a, ao);
    r.setEnd(b, bo + 1);
    out.push(r);
  }
  return out;
}

export interface LinesFindProps {
  job: string; // the view's FilterStart job ("" before it has one)
  above: number;
  below: number;
  count: number; // rows of the view now
  done: boolean; // the scan has ended
  version: number; // Progress.version (appends)
  sel: number | null; // the selected row
  focusNonce: number; // changes when Ctrl+F asks again → focus the box
  scroller: RefObject<HTMLDivElement>;
  onGo: (row: number) => void; // select and show a row
  onClose: () => void;
}

interface Found {
  key: string;
  rows: number[];
  total: number;
  capped: boolean;
  partial: boolean;
  canceled: boolean;
  issue: string;
}

const KIND_OF = (word: boolean, regex: boolean): RuleKind => (regex ? "regex" : word ? "word" : "text");

// First index in sorted a with a[i] > x (or ≥ x when eq), a.length if none.
function after(a: number[], x: number, eq = false): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eq ? a[mid] < x : a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export default function LinesFind(p: LinesFindProps) {
  const [q, setQ] = useState("");
  const [cs, setCs] = useState(false);
  const [word, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(++hlSeq);
  const pr = useRef(p);
  pr.current = p;

  const rule: Pick<LogRule, "kind" | "pattern" | "caseSensitive"> = { kind: KIND_OF(word, regex), pattern: q, caseSensitive: cs };
  const check = q ? ruleCheck(rule) : { problem: "", reason: "" };
  const key = `${p.job}\u0000${p.above}\u0000${p.below}\u0000${p.version}\u0000${rule.kind}\u0000${cs ? 1 : 0}\u0000${q}`;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [p.focusNonce]);

  // Stop a Find still running in Go (an empty query takes over the view's find
  // seq): when the text is cleared and when 찾기 closes.
  const searching = useRef(false);
  const stopFind = () => {
    const c = pr.current;
    if (!searching.current || !c.job) return;
    searching.current = false;
    FilterFind(c.job, c.above, c.below, linefilter.Rule.createFrom({ kind: "text", pattern: "", caseSensitive: false })).catch(() => {});
  };
  useEffect(() => stopFind, []);

  // search (again) — debounced while typing; while the scan runs, again every 0.7s
  const rerun = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!q || !p.job) {
      stopFind();
      setFound(null);
      setBusy(false);
      return;
    }
    if (check.problem) {
      setFound({ key, rows: [], total: 0, capped: false, partial: false, canceled: false, issue: check.reason });
      setBusy(false);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      searching.current = true;
      FilterFind(p.job, p.above, p.below, linefilter.Rule.createFrom({ kind: rule.kind, pattern: q, caseSensitive: cs }))
        .then((r) => {
          if (alive && !r.partial) searching.current = false;
          if (!alive || r.canceled) return;
          setFound({ key, rows: r.rows ?? [], total: r.total, capped: !!r.capped, partial: !!r.partial, canceled: false, issue: r.issue ?? "" });
          setBusy(false);
          if (r.partial) rerun.current = window.setTimeout(() => setTick((n) => n + 1), 700);
        })
        .catch((e) => {
          if (!alive) return;
          setFound({ key, rows: [], total: 0, capped: false, partial: false, canceled: false, issue: String(e) });
          setBusy(false);
        });
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
      window.clearTimeout(rerun.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, p.done, tick]);

  const rows = found?.rows ?? [];
  const go = (dir: 1 | -1) => {
    if (!rows.length) return;
    const cur = p.sel ?? -1;
    let i: number;
    if (dir > 0) {
      i = after(rows, cur);
      if (i >= rows.length) i = 0;
    } else {
      i = after(rows, cur, true) - 1;
      if (i < 0) i = rows.length - 1;
    }
    p.onGo(rows[i]);
  };

  // highlight the matches on screen after every render of the view
  const matcher = q && !check.problem ? compileRule({ ...rule, id: "", on: true, label: "", color: "", line: false, filter: true } as LogRule) : null;
  useLayoutEffect(() => {
    const sc = p.scroller.current;
    const all: Range[] = [];
    const cur: Range[] = [];
    if (sc && matcher && rows.length) {
      for (const el of sc.querySelectorAll<HTMLElement>(".lv-row[data-line]")) {
        const row = +(el.dataset.row ?? -1);
        const k = after(rows, row, true);
        if (rows[k] !== row) continue; // only rows Go counted
        const t = el.querySelector(".lv-text");
        if (!t) continue;
        const rs = rowRanges(t, matcher);
        all.push(...rs);
        if (row === p.sel) cur.push(...rs);
      }
    }
    hlAll.set(idRef.current, { all, cur });
    publish();
  });
  useEffect(
    () => () => {
      hlAll.delete(idRef.current);
      publish();
    },
    []
  );

  const at = p.sel !== null && rows.length ? after(rows, p.sel, true) : -1;
  const atText = at >= 0 && rows[at] === p.sel ? `${(at + 1).toLocaleString("en-US")} / ` : "";
  let status = "";
  if (q) {
    if (found?.issue) status = "쓸 수 없음: " + found.issue;
    else if (!found || (busy && found.key !== key)) status = "찾는 중…";
    else if (!found.total) status = found.partial ? "아직 없음 (거르는 중)" : "없음";
    else
      status =
        atText +
        `${found.total.toLocaleString("en-US")}줄` +
        (found.capped ? ` (앞 ${found.rows.length.toLocaleString("en-US")}줄로 이동)` : "") +
        (found.partial ? " · 거르는 중 — 지금까지" : "");
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      p.onClose();
    } else if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      inputRef.current?.select();
    } else return;
    e.stopPropagation();
  };

  return (
    <div className="lv-find" onKeyDown={onKey} role="search" aria-label="줄만 보기 안에서 찾기">
      <span className="lv-find-title" title="걸러진 결과 전체(화면에 안 보이는 행 포함)에서 찾습니다. 「⋯ 생략」 줄 안은 찾지 않습니다">
        🔍
      </span>
      <input
        ref={inputRef}
        className={"lv-find-input" + (found?.issue && q ? " invalid" : "")}
        placeholder="줄만 보기 안에서 찾기"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <span className="lv-find-count" aria-live="polite">
        {status}
      </span>
      <button className="lv-btn" title="이전 (Shift+Enter)" disabled={!rows.length} onClick={() => go(-1)}>
        ▲
      </button>
      <button className="lv-btn" title="다음 (Enter)" disabled={!rows.length} onClick={() => go(1)}>
        ▼
      </button>
      <label className="lv-find-opt" title="대소문자 구분">
        <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} />
        Aa
      </label>
      <label className="lv-find-opt" title="단어 단위 (앞뒤가 글자·숫자가 아닐 때만)">
        <input type="checkbox" checked={word} disabled={regex} onChange={(e) => setWord(e.target.checked)} />
        단어
      </label>
      <label className="lv-find-opt" title="정규식 (태그 규칙과 같은 문법 — 앞보기·뒤돌아보기·역참조는 쓸 수 없음)">
        <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
        .*
      </label>
      <button className="lv-btn" title="닫기 (Esc)" onClick={() => p.onClose()}>
        ×
      </button>
    </div>
  );
}
