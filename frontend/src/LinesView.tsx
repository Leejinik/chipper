import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FilterStart,
  FilterRows,
  FilterCancel,
  FilterClose,
  FilterRowOfLine,
} from "../wailsjs/go/main/App";
import { linefilter } from "../wailsjs/go/models";
import { EventsOn, ClipboardSetText } from "../wailsjs/runtime";
import type { LogRule, RuleLayers } from "./logHighlight";
import "./LinesView.css";
import LinesFind, { useLinesFindOpen } from "./LinesFind";
import {
  clampContext,
  countFromPage,
  filterKey,
  fmtN,
  gapText,
  gapTitle,
  geometry,
  MAX_CONTEXT,
  RowPainter,
  rowAtScroll,
  rowLine,
  rowsText,
  RowStore,
  scrollForRow,
  spanStyle,
  noteSlowFilterRules,
  type FRow,
} from "./lineView";

// 「🏷 태그 줄만」: the lines of the file on disk that the applied tags' 「줄만」
// rules match, with `above`/`below` lines around each, other stretches folded
// into 「⋯ N줄 생략」 rows. Line numbers are the file's. The Go engine filters
// the file (it never needs the file in the editor, so this also works for
// files too big to open and for .gz); this view asks it for the rows on screen
// only (pages around the viewport), so its memory stays small whatever the
// result, and new context sizes redraw from one page.
//
// Keys: ↑↓ PgUp PgDn Home End move the selected row (Shift extends), Enter or
// a double-click (or a click on the line number) opens the whole file at that
// line, Ctrl+C copies the selected rows (or the selected text), Ctrl+A all rows.

const PAGE = 500; // rows per page fetched
const OVERSCAN = 150; // rows fetched beyond the viewport each way
const MAX_PAGES = 120; // pages held (60,000 rows) — older ones are fetched again when needed
const COPY_MAX = 50_000;
const MAX_ROWS = 200_000; // the engine's DefaultMaxRows (when it says rows were cut, hits = cap + 1)
const BIG_RESULT = 40 << 20; // estimated text past this → check the 64MB cap at once

// One subscription to the engine's progress events, dispatched by view id.
// Events for a view not listening yet are kept (its id is known only once
// FilterStart has answered, and the first events may come before).
type Listener = (p: linefilter.Progress) => void;
const listeners = new Map<string, Listener>();
const early = new Map<string, linefilter.Progress>();
let subscribed = false;
function subscribe(id: string, fn: Listener): () => void {
  if (!subscribed) {
    subscribed = true;
    EventsOn("linefilter:progress", (p: linefilter.Progress) => {
      if (!p || !p.jobId) return;
      const f = listeners.get(p.jobId);
      if (f) f(p);
      else {
        early.set(p.jobId, p);
        if (early.size > 64) early.delete(early.keys().next().value as string);
      }
    });
  }
  listeners.set(id, fn);
  const e = early.get(id);
  early.delete(id);
  if (e) fn(e);
  return () => {
    listeners.delete(id);
    early.delete(id);
  };
}

export interface LinesViewProps {
  path: string;
  encoding: string; // "" = let the engine detect (a tab that was never read)
  rules: LogRule[]; // the 「줄만」 rules (lineView.filterRules); row/rule indexes refer to this
  ruleTags: string[]; // the tag of each rule, for labels
  tagNames: string[]; // tags applied to the file (common first)
  off: string[]; // of those, the ones left out
  above: number;
  below: number;
  layers: RuleLayers | null; // colours (the editor's), null = log colours off
  fontSize: number;
  dirty: boolean; // the tab has unsaved edits (the view shows the file on disk)
  autoFocus: boolean;
  initialLine: number; // line to show first (coming back to the view)
  onContext: (above: number, below: number) => void;
  onToggleTag: (name: string) => void;
  onJump: (line: number) => void; // open the whole file at this line
  onFull: () => void; // back to the whole file
  onLeave: (line: number) => void; // the top line, when the view goes away
}

type Trunc = "" | "rows" | "bytes";

export default function LinesView(p: LinesViewProps) {
  const pr = useRef(p);
  pr.current = p;
  const key = filterKey(p.rules);

  const [prog, setProg] = useState<linefilter.Progress | null>(null);
  const [issues, setIssues] = useState<linefilter.RuleIssue[]>([]);
  const [count, setCount] = useState(0);
  const [, setTick] = useState(0);
  const [startErr, setStartErr] = useState("");
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState(0);
  const [trunc, setTrunc] = useState<Trunc>("");
  const [sel, setSel] = useState<{ a: number; h: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const [aText, setAText] = useState(String(p.above));
  const [bText, setBText] = useState(String(p.below));

  const jobRef = useRef("");
  const verRef = useRef(0);
  const tailRef = useRef(0);
  const countRef = useRef(0);
  const doneRef = useRef(false);
  const storeRef = useRef(new RowStore(PAGE));
  const epochRef = useRef(0);
  const inflight = useRef(new Set<string>());
  const emptyAt = useRef(new Map<string, number>()); // page → count when it came back empty
  const abRef = useRef({ A: clampContext(p.above), B: clampContext(p.below) });
  const seeking = useRef(0); // seeks in flight
  const pendingRow = useRef<number | null>(null); // scroll here once the count allows
  const pendingLine = useRef(0); // line to come back to when the scan has reached it
  // The line the view is going back to (a context change or a restart asked for
  // it, the scroll is not there yet): what topLine() says until then, so a
  // second change before the first one landed keeps the place too.
  const anchorLine = useRef(0);
  const scannedRef = useRef(0); // lines the scan has read (last progress)
  const scRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef(0); // first row index on screen (for the anchor)
  const timing = useRef({ t0: 0, first: false, redraw0: 0 });
  const followRef = useRef(false); // stuck to the end (a growing log)
  const progQueued = useRef<linefilter.Progress | null>(null);

  const bump = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);
  const setCountBoth = useCallback((c: number) => {
    countRef.current = c;
    setCount(c);
  }, []);
  // Progress updates come every ~100ms and with every page: draw at most once a frame.
  const showProg = useCallback((x: linefilter.Progress) => {
    if (x.jobId === jobRef.current && x.scannedLines > scannedRef.current) scannedRef.current = x.scannedLines;
    const first = progQueued.current === null;
    progQueued.current = x;
    if (first)
      requestAnimationFrame(() => {
        const q = progQueued.current;
        progQueued.current = null;
        if (q && q.jobId === jobRef.current) setProg(q);
      });
  }, []);

  const rowH = Math.max(14, Math.round(p.fontSize * 1.6));
  const geo = geometry(count, rowH);
  const firstF = rowAtScroll(scrollTop, count, rowH, viewH);
  const first = Math.max(0, Math.floor(firstF));
  const vis = Math.ceil(viewH / rowH) + 1;
  firstRef.current = first;

  // The file line at the top of the view (where to come back after a change).
  const topLine = useCallback((): number => {
    if (anchorLine.current) return anchorLine.current;
    const st = storeRef.current;
    const r = st.get(firstRef.current) ?? st.get(firstRef.current + 1);
    return r ? rowLine(r) : 0;
  }, []);

  // --- talking to the engine ---------------------------------------------------------------

  const onChangedRef = useRef<() => void>(() => {});
  const onAppendRef = useRef<(x: linefilter.Progress) => void>(() => {});

  // A page answer: true when its rows belong to what the view shows now.
  const applyPage = useCallback(
    (pg: linefilter.Page, ep: number): boolean => {
      if (ep !== epochRef.current) return false;
      if (pg.changed) {
        onChangedRef.current();
        return false;
      }
      if (pg.version !== verRef.current) {
        if (pg.version > verRef.current) onAppendRef.current(pg.progress);
        return false;
      }
      if (pg.progress) showProg(pg.progress);
      if (pg.truncated) setTrunc(pg.truncated as Trunc);
      const c = countFromPage(pg);
      if (c !== countRef.current) {
        if (c < countRef.current) storeRef.current.dropFrom(c);
        setCountBoth(c);
      }
      return true;
    },
    [setCountBoth, showProg]
  );

  // Fill page pIdx from where it ends. `force`: even when the count says
  // there is nothing there (right after a context change, to learn it).
  const fetchPage = useCallback(
    async (pIdx: number, force = false) => {
      const job = jobRef.current;
      if (!job) return;
      const ep = epochRef.current;
      const st = storeRef.current;
      const have = st.held(pIdx);
      const from = pIdx * PAGE + have;
      const n = PAGE - have;
      if (n <= 0 || (!force && from >= countRef.current)) return;
      const k = `${ep}:${pIdx}`;
      if (inflight.current.has(k)) return;
      if (!force && emptyAt.current.get(k) === countRef.current) return;
      inflight.current.add(k);
      try {
        const { A, B } = abRef.current;
        const pg = await FilterRows(job, A, B, from, n);
        if (job !== jobRef.current) return;
        if (applyPage(pg, ep)) {
          if (!pg.rows.length) emptyAt.current.set(k, countRef.current);
          else if (rootRef.current && !rootRef.current.dataset.rowsMs)
            rootRef.current.dataset.rowsMs = String(Math.round(performance.now() - timing.current.t0));
          st.put(from, pg.rows as FRow[]);
          bump();
        }
      } catch (e) {
        if (job === jobRef.current) setStartErr(String(e));
      } finally {
        inflight.current.delete(k);
      }
    },
    [applyPage, bump]
  );

  // While scanning: learn how many rows exist (row 0 is cheap to answer).
  const probing = useRef({ busy: false, again: false });
  const probe = useCallback(async () => {
    const pb = probing.current;
    if (pb.busy) {
      pb.again = true;
      return;
    }
    pb.busy = true;
    let job = "";
    try {
      do {
        pb.again = false;
        job = jobRef.current;
        if (!job) return;
        const ep = epochRef.current;
        const { A, B } = abRef.current;
        const pg = await FilterRows(job, A, B, 0, 1);
        if (job !== jobRef.current) return;
        if (applyPage(pg, ep)) {
          storeRef.current.put(0, pg.rows as FRow[]);
          bump();
        }
      } while (pb.again);
    } catch (e) {
      if (job && job === jobRef.current) setStartErr(String(e)); // not for a job given up meanwhile
    } finally {
      pb.busy = false;
    }
  }, [applyPage, bump]);

  // The 64MB cap is found by reading the rows up to it; when the result looks
  // that big, do it now so the notice and the scroll bar are right at once.
  const checkByteCap = useCallback(() => {
    const st = storeRef.current;
    let n = 0;
    let bytes = 0;
    for (const rows of st.pages.values())
      for (const r of rows) {
        n++;
        bytes += r.text.length + 1;
      }
    if (!n || (bytes / n) * countRef.current < BIG_RESULT) return;
    const job = jobRef.current;
    const ep = epochRef.current;
    const { A, B } = abRef.current;
    setTimeout(() => {
      if (job !== jobRef.current || ep !== epochRef.current) return;
      FilterRows(job, A, B, Math.max(0, countRef.current - 1), 1)
        .then((pg) => {
          if (job === jobRef.current && applyPage(pg, ep)) bump();
        })
        .catch(() => {});
    }, 200);
  }, [applyPage, bump]);

  // Go to file line `line` (the first row showing it or after it).
  const seek = useCallback(
    async (line: number) => {
      const job = jobRef.current;
      if (!job) return;
      const ep = epochRef.current;
      const { A, B } = abRef.current;
      // Not scanned that far yet: the engine would answer with the rows known
      // so far (some row near the scan's end). Show the start and go there when
      // the scan is done — no stop at a wrong place on the way.
      if (line > 1 && !doneRef.current && line + B >= scannedRef.current) {
        pendingLine.current = line;
        anchorLine.current = line;
        if (!storeRef.current.held(0)) await fetchPage(0, true);
        bump();
        return;
      }
      seeking.current++;
      try {
        let row = 0;
        if (line > 1) row = await FilterRowOfLine(job, A, B, line);
        if (job !== jobRef.current || ep !== epochRef.current) return;
        pendingRow.current = row;
        await fetchPage(Math.floor(row / PAGE), true);
      } catch (e) {
        // a request of a job (or a layout) given up meanwhile: not this view's error
        if (job === jobRef.current && ep === epochRef.current) {
          anchorLine.current = 0;
          setStartErr(String(e));
        }
      } finally {
        seeking.current--;
        bump();
      }
    },
    [fetchPage, bump]
  );

  // Lines were appended (progress.version went up): rows from (old tailLine −
  // above) on may change — drop them and fetch again (engine contract).
  const appendBusy = useRef<{ busy: boolean; next: linefilter.Progress | null }>({ busy: false, next: null });
  onAppendRef.current = (x: linefilter.Progress) => {
    const ab = appendBusy.current;
    if (ab.busy) {
      ab.next = x;
      return;
    }
    ab.busy = true;
    (async () => {
      let job = "";
      try {
        let cur: linefilter.Progress | null = x;
        while (cur) {
          ab.next = null;
          job = jobRef.current;
          if (!job || cur.version <= verRef.current) break;
          const T = tailRef.current;
          const { A, B } = abRef.current;
          let cut = 0;
          if (T > 0) cut = await FilterRowOfLine(job, A, B, Math.max(1, T - A));
          if (job !== jobRef.current) return;
          storeRef.current.dropFrom(cut);
          emptyAt.current.clear();
          verRef.current = cur.version;
          tailRef.current = cur.tailLine;
          if (countRef.current > cut) setCountBoth(cut);
          showProg(cur);
          await probe();
          cur = ab.next;
        }
      } catch (e) {
        if (job && job === jobRef.current) setStartErr(String(e)); // not for a job given up meanwhile
      } finally {
        ab.busy = false;
        bump();
      }
    })();
  };

  // The file was rewritten (not appended to): filter it again, staying near
  // the same line.
  onChangedRef.current = () => {
    if (!jobRef.current) return;
    pendingLine.current = topLine();
    jobRef.current = "";
    setNotice("파일 내용이 바뀌어(덧붙음이 아님) 처음부터 다시 걸렀습니다.");
    setRestart((r) => r + 1);
  };

  const onProgress = useCallback(
    (x: linefilter.Progress) => {
      if (x.jobId !== jobRef.current) return;
      if (x.changed) {
        onChangedRef.current();
        return;
      }
      if (x.version > verRef.current) {
        onAppendRef.current(x);
        return;
      }
      if (x.version === verRef.current) tailRef.current = x.tailLine;
      showProg(x);
      if (x.done && !doneRef.current) {
        doneRef.current = true;
        probe().then(() => {
          checkByteCap();
          const ln = pendingLine.current;
          if (ln) {
            pendingLine.current = 0;
            seek(ln);
          }
        });
      } else probe();
    },
    [probe, seek, showProg, checkByteCap]
  );

  // --- start (and start again when the file, encoding or rules change) ------------------------
  useEffect(() => {
    let alive = true;
    let unsub = () => {};
    let mine = "";
    epochRef.current++;
    jobRef.current = "";
    storeRef.current.clear();
    inflight.current.clear();
    emptyAt.current.clear();
    verRef.current = 0;
    tailRef.current = 0;
    scannedRef.current = 0;
    doneRef.current = false;
    followRef.current = false;
    countRef.current = 0;
    setCount(0);
    setProg(null);
    setIssues([]);
    setStartErr("");
    setTrunc("");
    setSel(null);
    timing.current = { t0: performance.now(), first: false, redraw0: 0 };
    if (rootRef.current) {
      delete rootRef.current.dataset.firstMs;
      delete rootRef.current.dataset.doneMs;
      delete rootRef.current.dataset.startMs;
      delete rootRef.current.dataset.rowsMs;
    }
    const cur = pr.current;
    // No rule to filter with (every tag unticked, or no 「줄만」 rule): nothing
    // to scan for — don't read the whole file (a temp copy for CP949/UTF-16) for it.
    if (!cur.rules.length) {
      return () => {
        alive = false;
      };
    }
    const req = linefilter.Request.createFrom({
      path: cur.path,
      encoding: cur.encoding,
      rules: cur.rules.map((r) => ({ id: r.id, kind: r.kind, pattern: r.pattern, caseSensitive: r.caseSensitive, on: true, filter: true })),
    });
    FilterStart(req)
      .then((res) => {
        if (!alive) {
          FilterClose(res.jobId);
          return;
        }
        mine = res.jobId;
        jobRef.current = mine;
        if (rootRef.current) rootRef.current.dataset.startMs = String(Math.round(performance.now() - timing.current.t0));
        verRef.current = res.progress.version;
        tailRef.current = res.progress.tailLine;
        scannedRef.current = res.progress.scannedLines;
        setIssues(res.issues ?? []);
        setProg(res.progress);
        unsub = subscribe(mine, (x) => onProgressRef.current(x));
        if (res.progress.done) {
          doneRef.current = true;
        }
        const ln = pendingLine.current || (restartsSeen.current === 0 ? cur.initialLine : 0);
        pendingLine.current = 0;
        restartsSeen.current++;
        anchorLine.current = ln > 1 ? ln : 0;
        const go = ln > 1 ? seek(ln) : fetchPage(0, true);
        go.then(() => {
          if (doneRef.current) checkByteCap();
        });
      })
      .catch((e) => {
        if (alive) setStartErr(String(e));
      });
    return () => {
      alive = false;
      unsub();
      if (mine) {
        if (mine === jobRef.current) {
          // going away, or starting again with other rules: keep the place
          const tl = topLine();
          if (!pendingLine.current) pendingLine.current = tl;
          pr.current.onLeave(tl);
        }
        FilterClose(mine);
      }
      jobRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.path, p.encoding, key, restart]);
  const restartsSeen = useRef(0);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  // --- context sizes changed: same scan, rows laid out again ------------------------------------
  const abFirst = useRef(true);
  useEffect(() => {
    const A = clampContext(p.above);
    const B = clampContext(p.below);
    setAText(String(A));
    setBText(String(B));
    if (abFirst.current) {
      abFirst.current = false;
      abRef.current = { A, B };
      return;
    }
    if (A === abRef.current.A && B === abRef.current.B) return;
    // topLine() of a view whose rows were just dropped for the previous change
    // would be 0 (the top): the anchor keeps the line until the scroll lands.
    const line = topLine();
    anchorLine.current = line > 1 ? line : 0;
    abRef.current = { A, B };
    epochRef.current++;
    storeRef.current.clear();
    emptyAt.current.clear();
    setTrunc("");
    timing.current.redraw0 = performance.now();
    if (rootRef.current) delete rootRef.current.dataset.redrawMs;
    seek(line).then(() => {
      if (doneRef.current) checkByteCap();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.above, p.below]);

  // --- fetch what is on screen ---------------------------------------------------------------------
  useEffect(() => {
    if (!jobRef.current || seeking.current) return;
    const st = storeRef.current;
    const lo = Math.max(0, first - OVERSCAN);
    const hi = Math.min(count - 1, first + vis + OVERSCAN);
    for (let pg = Math.floor(lo / PAGE); pg <= Math.floor(hi / PAGE); pg++) {
      const need = Math.min(PAGE, count - pg * PAGE);
      if (st.held(pg) < need) fetchPage(pg);
    }
    st.trim(MAX_PAGES, first);
  });

  // --- scrolling ---------------------------------------------------------------------------------------
  const scrollToRow = useCallback(
    (row: number) => {
      const el = scRef.current;
      if (!el) return;
      el.scrollTop = scrollForRow(row, countRef.current, rowH, el.clientHeight);
      setScrollTop(el.scrollTop);
    },
    [rowH]
  );

  useLayoutEffect(() => {
    const el = scRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 400));
    ro.observe(el);
    setViewH(el.clientHeight || 400);
    if (p.autoFocus) el.focus({ preventScroll: true });
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending row to show (after a context change or coming back), once it exists.
  useLayoutEffect(() => {
    const r = pendingRow.current;
    if (r === null) return;
    if (r < count || (doneRef.current && count > 0)) {
      pendingRow.current = null;
      scrollToRow(Math.min(r, Math.max(0, count - 1)));
      // landed: the view's own top line counts again (unless another seek or a
      // seek waiting for the scan is still to land)
      if (!seeking.current && !pendingLine.current) anchorLine.current = 0;
    }
  });

  // A growing log, scrolled to the end: stay at the end.
  useLayoutEffect(() => {
    if (followRef.current && count > 0) scrollToRow(count);
  }, [count, scrollToRow]);

  // Past MAX_SCROLL the bar is scaled; the wheel then moves by rows, not pixels.
  useEffect(() => {
    const el = scRef.current;
    if (!el || !geo.scaled) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const rows = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * vis : e.deltaY / rowH;
      scrollToRow(rowAtScroll(el.scrollTop, countRef.current, rowH, el.clientHeight) + rows);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [geo.scaled, rowH, vis, scrollToRow]);

  const onScroll = () => {
    const el = scRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    followRef.current = doneRef.current && countRef.current > vis && el.scrollTop >= geo.height - el.clientHeight - rowH;
  };

  // --- timing (read by the .18 measurements: data-start-ms / -rows-ms / -first-ms / -done-ms from the
  // start, data-redraw-ms from a context change to the rows painted) ----------------------------------
  const allShown = (() => {
    if (!jobRef.current) return false;
    const end = Math.min(count, first + vis - 1);
    for (let i = first; i < end; i++) if (!storeRef.current.get(i)) return false;
    return true;
  })();
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const t = timing.current;
    if (!t.first && allShown && (count > 0 || prog?.done)) {
      t.first = true;
      requestAnimationFrame(() => {
        if (rootRef.current) rootRef.current.dataset.firstMs = String(Math.round(performance.now() - t.t0));
      });
    }
    if (t.redraw0 && allShown && !seeking.current && pendingRow.current === null) {
      const t0 = t.redraw0;
      t.redraw0 = 0;
      requestAnimationFrame(() => {
        if (rootRef.current) rootRef.current.dataset.redrawMs = String(Math.round(performance.now() - t0));
      });
    }
    if (prog?.done && !el.dataset.doneMs) el.dataset.doneMs = String(Math.round(performance.now() - t.t0));
  });

  // --- selection, keys, copying -----------------------------------------------------------------------
  const jump = (i: number) => {
    const r = storeRef.current.get(i);
    if (r) pr.current.onJump(rowLine(r));
  };
  const moveTo = (h: number, extend: boolean) => {
    const c = countRef.current;
    if (!c) return;
    h = Math.max(0, Math.min(c - 1, h));
    setSel((s) => ({ a: extend && s ? s.a : h, h }));
    const el = scRef.current;
    const full = Math.max(1, Math.floor((el?.clientHeight ?? viewH) / rowH));
    if (h < firstRef.current) scrollToRow(h);
    else if (h >= firstRef.current + full) scrollToRow(h - full + 1);
  };
  const copyRows = async (a: number, b: number) => {
    const job = jobRef.current;
    if (!job) return;
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    let cut = false;
    if (hi - lo + 1 > COPY_MAX) {
      hi = lo + COPY_MAX - 1;
      cut = true;
    }
    const out: FRow[] = [];
    const { A, B } = abRef.current;
    const ep = epochRef.current;
    for (let i = lo; i <= hi; ) {
      const r = storeRef.current.get(i);
      if (r) {
        out.push(r);
        i++;
        continue;
      }
      const pg = await FilterRows(job, A, B, i, Math.min(5000, hi - i + 1));
      if (job !== jobRef.current || ep !== epochRef.current || !pg.rows.length) break;
      out.push(...(pg.rows as FRow[]));
      i += pg.rows.length;
    }
    try {
      await ClipboardSetText(rowsText(out));
      setNotice(`${fmtN(out.length)}행을 복사했습니다${cut ? ` (한 번에 ${fmtN(COPY_MAX)}행까지)` : ""}.`);
    } catch (e) {
      setNotice("복사하지 못했습니다: " + String(e));
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const c = countRef.current;
    const h = sel?.h ?? firstRef.current;
    const page = Math.max(1, Math.floor(viewH / rowH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        moveTo(sel ? h + 1 : h, e.shiftKey);
        break;
      case "ArrowUp":
        moveTo(sel ? h - 1 : h, e.shiftKey);
        break;
      case "PageDown":
        moveTo(h + page, e.shiftKey);
        break;
      case "PageUp":
        moveTo(h - page, e.shiftKey);
        break;
      case "Home":
        moveTo(0, e.shiftKey);
        break;
      case "End":
        moveTo(c - 1, e.shiftKey);
        break;
      case "Enter":
        if (sel) jump(sel.h);
        break;
      case "Escape":
        if (sel) setSel(null);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled && ctrl && !e.altKey && e.key.toLowerCase() === "a") {
      if (c) setSel({ a: 0, h: c - 1 });
      handled = true;
    }
    if (!handled && ctrl && !e.altKey && e.key.toLowerCase() === "c") {
      const ws = window.getSelection();
      if (ws && !ws.isCollapsed && scRef.current?.contains(ws.anchorNode)) return; // the browser copies the text
      if (sel) copyRows(sel.a, sel.h);
      handled = !!sel;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // --- drawing ------------------------------------------------------------------------------------------
  const [findOpen, closeFind, findNonce] = useLinesFindOpen(rootRef); // Ctrl+F (LinesFind.tsx)
  const painter = useMemo(() => new RowPainter(p.layers), [p.layers]);
  useEffect(() => noteSlowFilterRules(p.rules, prog?.slowRules), [p.rules, prog?.slowRules?.length]); // for the tag window
  const paintText = (text: string) => {
    const pt = painter.paint(text);
    if (!pt.spans.length) return { node: text as React.ReactNode, tint: pt.tint };
    const parts: React.ReactNode[] = [];
    let at = 0;
    pt.spans.forEach((s, k) => {
      if (s.from > at) parts.push(text.slice(at, s.from));
      parts.push(
        <span key={k} style={spanStyle(s)}>
          {text.slice(s.from, s.to)}
        </span>
      );
      at = s.to;
    });
    if (at < text.length) parts.push(text.slice(at));
    return { node: parts as React.ReactNode, tint: pt.tint };
  };

  const maxLine = Math.max(prog?.totalLines ?? 0, prog?.scannedLines ?? 0, 9999);
  const gutterCh = String(maxLine).length + 1;
  const selLo = sel ? Math.min(sel.a, sel.h) : -1;
  const selHi = sel ? Math.max(sel.a, sel.h) : -1;
  const rowsEls: JSX.Element[] = [];
  const end = Math.min(count, first + vis);
  for (let i = first; i < end; i++) {
    const r = storeRef.current.get(i);
    const top = geo.scaled ? scrollTop + (i - firstF) * rowH : i * rowH;
    const selected = i >= selLo && i <= selHi;
    const base = { top, height: rowH, lineHeight: rowH + "px" };
    if (!r) {
      rowsEls.push(
        <div key={i} className="lv-row lv-wait" style={base}>
          <span className="lv-no" style={{ width: gutterCh + "ch" }} />
          <span className="lv-text">…</span>
        </div>
      );
      continue;
    }
    if (r.line === 0) {
      rowsEls.push(
        <div
          key={i}
          className={"lv-row lv-gap" + (selected ? " sel" : "")}
          style={base}
          title={gapTitle(r)}
          data-row={i}
          onMouseDown={(e) => {
            moveTo(i, e.shiftKey);
            scRef.current?.focus();
          }}
          onDoubleClick={() => jump(i)}
        >
          <span className="lv-no" style={{ width: gutterCh + "ch" }} />
          <span className="lv-mark" />
          <span className="lv-text">{gapText(r)}</span>
        </div>
      );
      continue;
    }
    const { node, tint } = paintText(r.text);
    const rule = r.hit && r.rules?.length ? p.rules[r.rules[0]] : undefined;
    const far = r.hit && r.col > r.text.length;
    rowsEls.push(
      <div
        key={i}
        className={"lv-row" + (r.hit ? " lv-hit" : " lv-near") + (selected ? " sel" : "")}
        style={tint ? { ...base, backgroundColor: tint + "1f" } : base}
        data-row={i}
        data-line={r.line}
        onMouseDown={(e) => {
          moveTo(i, e.shiftKey);
          scRef.current?.focus();
        }}
        onDoubleClick={() => jump(i)}
      >
        <span
          className="lv-no"
          style={{ width: gutterCh + "ch" }}
          title="눌러서 전체 보기로 이 줄 열기"
          onClick={() => jump(i)}
        >
          {r.line}
        </span>
        <span
          className="lv-mark"
          style={rule ? { background: rule.color } : undefined}
          title={
            r.hit
              ? "걸린 규칙: " + (r.rules ?? []).map((k) => ruleName(p, k)).join(", ")
              : "걸린 줄의 위·아래 줄"
          }
        />
        <span className="lv-text">
          {node}
          {r.truncatedLine && <span className="lv-cut"> … (긴 줄이라 앞 4KB 만 보임)</span>}
          {far && <span className="lv-cut"> ◂ 걸린 글자는 {fmtN(r.col + 1)}번째 글자부터 (안 보이는 뒤쪽)</span>}
        </span>
      </div>
    );
  }

  // --- header ------------------------------------------------------------------------------------------------
  const noRules = !p.rules.length; // nothing is scanned (see the start effect)
  const scanning = !noRules && !!prog && !prog.done && !startErr;
  const pct = prog && prog.totalBytes > 0 ? Math.min(100, Math.floor((prog.scannedBytes / prog.totalBytes) * 100)) : 0;
  const hits = noRules ? 0 : prog?.hits ?? 0;
  let stat = "준비 중…";
  if (noRules) stat = "거를 규칙 없음";
  else if (startErr) stat = "오류";
  else if (prog) {
    if (prog.canceled) stat = `멈춤 — 여기까지 걸린 줄 ${fmtN(hits)} · ${fmtN(count)}행`;
    else if (scanning && hits === 0) stat = `훑는 중 ${pct}% — 아직 걸린 줄 없음`;
    else if (scanning) stat = `거르는 중 ${pct}% · 걸린 줄 ${fmtN(hits)}`;
    else
      stat =
        `걸린 줄 ${fmtN(prog.truncated ? hits - 1 : hits)}${prog.truncated ? "+" : ""} · ${fmtN(count)}행` +
        (prog.totalLines ? ` / 전체 ${fmtN(prog.totalLines)}줄` : "") +
        ` · ${(prog.elapsedMs / 1000).toFixed(2)}초`;
  }
  const ruleHitTitle = p.rules
    .map((r, k) => `${ruleName(p, k)}: ${fmtN(prog?.ruleHits?.[k] ?? 0)}줄${prog?.truncated ? " (앞부분 기준)" : ""}`)
    .join("\n");
  const commitCtx = (which: "a" | "b", text: string) => {
    if (which === "a") setAText(text);
    else setBText(text);
    if (!/^\d+$/.test(text.trim())) return; // still typing (empty) — keep the last value
    const v = clampContext(parseInt(text, 10));
    const cur = pr.current;
    if (which === "a") cur.onContext(v, cur.below);
    else cur.onContext(cur.above, v);
  };

  const notes: { cls: string; text: string }[] = [];
  const err = startErr || prog?.error;
  if (err) notes.push({ cls: "err", text: "거르지 못했습니다: " + err });
  if (!p.rules.length)
    notes.push({
      cls: "warn",
      text: "줄만 보기에 쓰는 규칙이 없습니다 — 위의 태그 체크를 켜거나, 태그 창(🏷)에서 규칙의 「줄만」을 켜세요.",
    });
  if (issues.length)
    notes.push({
      cls: "warn",
      text: `줄만 보기에서 쓸 수 없는 규칙 ${issues.length}개(빼고 거름): ` + issues.map((x) => `「${ruleName(p, x.index)}」 ${x.reason}`).join(" · "),
    });
  if (prog?.slowRules?.length)
    notes.push({
      cls: "warn",
      text:
        `느린 규칙 ${prog.slowRules.length}개: ` +
        prog.slowRules.map((k) => `「${ruleName(p, k)}」`).join(", ") +
        " — 정규식이 복잡해 느린 방식으로 거릅니다(결과는 같음). 규칙을 단순하게 하면 빨라집니다.",
    });
  if (prog?.truncated)
    notes.push({
      cls: "warn",
      text:
        `걸린 줄이 ${fmtN(hits - 1)}줄을 넘어 앞부분만 보여 줍니다` +
        (prog.totalBytes > 0 && prog.done ? ` (파일의 앞 ${pct}%까지만 훑음)` : "") +
        ". 규칙이나 태그 체크를 줄이면 끝까지 볼 수 있습니다.",
    });
  else if (trunc === "rows")
    // The cap is on rows shown (걸린 줄 + 위·아래 줄), not on hits: the scan
    // itself went to the end, but rows after the cap are not shown.
    notes.push({
      cls: "warn",
      text:
        `보이는 줄(걸린 줄과 위·아래 줄)이 ${fmtN(MAX_ROWS)}행을 넘어 앞 ${fmtN(MAX_ROWS)}행까지만 보여 줍니다 — ` +
        "그 뒤에도 걸린 줄이 더 있습니다. 위·아래 줄 수나 규칙·태그 체크를 줄이면 더 볼 수 있습니다.",
    });
  if (trunc === "bytes")
    notes.push({
      cls: "warn",
      text: `결과가 64MB 를 넘어 앞 ${fmtN(count)}행까지만 보여 줍니다. 위·아래 줄 수를 줄이면 더 볼 수 있습니다.`,
    });
  if (prog && prog.invalidBytes > 0)
    notes.push({
      cls: "info",
      text: `UTF-8 이 아닌 바이트 ${fmtN(prog.invalidBytes)}개(줄 ${fmtN(prog.invalidLine)}부터)는 �로 보입니다 — 다른 인코딩이면 상태 표시줄에서 바꾸세요.`,
    });
  if (p.dirty) notes.push({ cls: "info", text: "고친 내용이 있는 탭입니다 — 줄만 보기는 저장된 파일 기준입니다." });
  if (notice) notes.push({ cls: "info", text: notice });

  return (
    <div
      className="lines-view"
      ref={rootRef}
      data-state={noRules ? "done" : startErr ? "error" : prog?.done ? "done" : "scan"}
      data-count={count}
      data-hits={hits}
    >
      <div className="lv-head">
        <button className="lv-btn" onClick={() => pr.current.onFull()} title="전체 파일 보기로 돌아가기 (줄을 두 번 누르거나 Enter 면 그 줄로)">
          📄 전체
        </button>
        <span className="lv-title">🏷 줄만</span>
        <span className="lv-tags" role="group" aria-label="거를 때 쓸 태그">
          {p.tagNames.map((n) => (
            <label key={n} className={"lv-tag" + (p.off.includes(n) ? " off" : "")} title={`「${n}」 태그의 「줄만」 규칙으로 거르기`}>
              <input type="checkbox" checked={!p.off.includes(n)} onChange={() => pr.current.onToggleTag(n)} />
              {n}
            </label>
          ))}
        </span>
        <label className="lv-ctx" title="걸린 줄 위(앞)로 함께 볼 줄 수 (grep -B)">
          위
          <input
            type="number"
            min={0}
            max={MAX_CONTEXT}
            value={aText}
            onChange={(e) => commitCtx("a", e.target.value)}
            onBlur={() => setAText(String(clampContext(p.above)))}
          />
        </label>
        <label className="lv-ctx" title="걸린 줄 아래(뒤)로 함께 볼 줄 수 (grep -A)">
          아래
          <input
            type="number"
            min={0}
            max={MAX_CONTEXT}
            value={bText}
            onChange={(e) => commitCtx("b", e.target.value)}
            onBlur={() => setBText(String(clampContext(p.below)))}
          />
        </label>
        <span className="lv-stat" title={ruleHitTitle}>
          {stat}
        </span>
        {scanning ? (
          <button
            className="lv-btn"
            title="거르기 멈추기 (여기까지 찾은 줄은 남음)"
            onClick={() => {
              if (jobRef.current) FilterCancel(jobRef.current);
            }}
          >
            ■ 멈추기
          </button>
        ) : (
          <button
            className="lv-btn"
            title="처음부터 다시 거르기"
            onClick={() => {
              pendingLine.current = topLine();
              setNotice("");
              setRestart((r) => r + 1);
            }}
          >
            ↻
          </button>
        )}
      </div>
      {notes.map((n, k) => (
        <div key={k} className={"lv-note " + n.cls}>
          {n.text}
        </div>
      ))}
      {findOpen && (
        <LinesFind
          job={jobRef.current}
          above={abRef.current.A}
          below={abRef.current.B}
          count={count}
          done={!!prog?.done}
          version={prog?.version ?? 0}
          sel={sel ? sel.h : null}
          focusNonce={findNonce}
          scroller={scRef}
          onGo={(row) => moveTo(row, false)}
          onClose={() => {
            closeFind();
            scRef.current?.focus();
          }}
        />
      )}
      <div
        className="lv-scroll"
        ref={scRef}
        tabIndex={0}
        style={{ fontSize: p.fontSize + "px" }}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="lv-space" style={{ height: Math.max(geo.height, 1) }}>
          {rowsEls}
        </div>
        {noRules ? (
          <div className="lv-empty">거를 규칙이 없습니다.</div>
        ) : (
          // no hit: the one 「⋯ N줄 생략」 row (or none) and this
          prog?.done &&
          !err &&
          (count === 0 || hits === 0) && (
            <div className="lv-empty" style={count > 0 && count < 10 ? { top: count * rowH + 12 } : undefined}>
              걸린 줄이 없습니다.
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ruleName(p: LinesViewProps, k: number): string {
  const r = p.rules[k];
  if (!r) return `#${k + 1}`;
  const name = r.label || r.pattern;
  const tag = p.ruleTags[k];
  return tag ? `${tag} · ${name}` : name;
}
