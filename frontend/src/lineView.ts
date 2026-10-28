// 「🏷 태그 줄만」 view — the parts that need no React (unit-tested in
// tests/lines-unit.ts). The view itself is LinesView.tsx.
//
// The Go line filter (internal/linefilter, bindings Filter*) reads the file on
// disk and keeps every matched line's position; the view only ever holds the
// rows it shows (pages around the viewport), so its memory does not grow with
// the result and changing the context sizes costs one page.

import { noteRuleTrouble } from "./ruleHealth";
import { compileRule, lineHeadOf, paintLine, ruleCheck, ruleKey, RULE_KINDS, type LogRule, type RuleKind, type RuleLayers, type RuleMatcher } from "./logHighlight";
import { COMMON, rulesFor, type TagStore } from "./logTags";

// --- per-tab state (kept in the session) -------------------------------------

export interface LinesState {
  on: boolean; // the tab shows 「태그 줄만」 instead of the whole file
  above: number; // lines shown before each matched line (grep -B)
  below: number; // … after it (grep -A)
  off: string[]; // applied tags left out of the filter (e.g. "common")
  ex: ExcludeRule[]; // 「🚫 제외」 chips (this tab only, not the tags)
}
export const DEFAULT_LINES: LinesState = { on: false, above: 0, below: 3, off: [], ex: [] };

// 「🚫 제외」: a matched line that also holds one of these is left out — with
// the lines above/below it brought (they stay when another hit shows them).
// Same kinds and matching as a tag rule (the engine's Request.Exclude); a chip
// that is off is kept but not used.
export interface ExcludeRule {
  pattern: string;
  kind: RuleKind; // "text" by default
  caseSensitive: boolean;
  on: boolean;
}
export const MAX_EXCLUDE = 50;
export const MAX_EXCLUDE_LEN = 1000; // as a tag rule's pattern (import limit)

export function normalizeExclude(raw: unknown): ExcludeRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ExcludeRule[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object" || typeof x.pattern !== "string" || x.pattern === "") continue;
    if (x.pattern.length > MAX_EXCLUDE_LEN || /[\r\n]/.test(x.pattern)) continue;
    const kind: RuleKind = RULE_KINDS.includes(x.kind) ? x.kind : "text";
    const r: ExcludeRule = { pattern: x.pattern, kind, caseSensitive: x.caseSensitive === true, on: x.on !== false };
    if (out.some((y) => sameExclude(y, r))) continue;
    out.push(r);
    if (out.length >= MAX_EXCLUDE) break;
  }
  return out;
}

export const sameExclude = (a: Pick<ExcludeRule, "pattern" | "kind" | "caseSensitive">, b: Pick<ExcludeRule, "pattern" | "kind" | "caseSensitive">) =>
  a.pattern === b.pattern && a.kind === b.kind && a.caseSensitive === b.caseSensitive;

// A chip added: the same one already there is switched on instead (no twin).
export function addExclude(list: ExcludeRule[], r: Omit<ExcludeRule, "on">): ExcludeRule[] {
  const i = list.findIndex((x) => sameExclude(x, r));
  if (i >= 0) return list.map((x, k) => (k === i ? { ...x, on: true } : x));
  if (list.length >= MAX_EXCLUDE) return list;
  return [...list, { ...r, on: true }];
}
export const toggleExclude = (list: ExcludeRule[], i: number): ExcludeRule[] => list.map((x, k) => (k === i ? { ...x, on: !x.on } : x));
export const removeExclude = (list: ExcludeRule[], i: number): ExcludeRule[] => list.filter((_, k) => k !== i);

// The chips the engine gets (the ones on), and for each the chip's index —
// Request.Exclude indexes (excludeIssues, slowExclude) map back through it.
export function excludeRequest(list: ExcludeRule[]): { rules: { kind: RuleKind; pattern: string; caseSensitive: boolean; on: boolean }[]; chip: number[] } {
  const rules: { kind: RuleKind; pattern: string; caseSensitive: boolean; on: boolean }[] = [];
  const chip: number[] = [];
  list.forEach((x, i) => {
    if (!x.on || x.pattern === "") return;
    rules.push({ kind: x.kind, pattern: x.pattern, caseSensitive: x.caseSensitive, on: true });
    chip.push(i);
  });
  return { rules, chip };
}
// What makes two chip lists filter the same lines (off chips don't count).
export const excludeKey = (list: ExcludeRule[]): string =>
  JSON.stringify(excludeRequest(list).rules.map((r) => [r.kind, r.caseSensitive ? 1 : 0, r.pattern]));

// Can this be a chip? "" = yes; otherwise why not (the tag rules' check — the
// same reasons as the tag window).
export function excludeProblem(r: Pick<ExcludeRule, "pattern" | "kind" | "caseSensitive">): string {
  if (r.pattern === "") return "";
  if (r.pattern.length > MAX_EXCLUDE_LEN) return `${MAX_EXCLUDE_LEN}자까지 넣을 수 있습니다`;
  if (/[\r\n]/.test(r.pattern)) return "줄바꿈이 들어 있어 어느 줄에도 걸리지 않습니다";
  const c = ruleCheck(r);
  return c.problem ? c.reason : "";
}

// A chip's label: the text, with marks for a word / regex chip and case.
export function excludeLabel(r: ExcludeRule): string {
  const k = r.kind === "regex" ? "/" + r.pattern + "/" : r.kind === "word" ? "‹" + r.pattern + "›" : r.pattern;
  return r.caseSensitive ? k + " Aa" : k;
}
export const MAX_CONTEXT = 1000; // the engine takes up to 10,000; more is never useful on screen

export const clampContext = (n: unknown): number => {
  const v = typeof n === "number" ? n : parseInt(String(n), 10);
  return Number.isFinite(v) ? Math.min(MAX_CONTEXT, Math.max(0, Math.floor(v))) : 0;
};

export function normalizeLines(raw: any): LinesState | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    on: raw.on === true,
    above: clampContext(raw.above ?? DEFAULT_LINES.above),
    below: clampContext(raw.below ?? DEFAULT_LINES.below),
    off: Array.isArray(raw.off) ? raw.off.filter((x: unknown): x is string => typeof x === "string").slice(0, 100) : [],
    ex: normalizeExclude(raw.ex), // a session from before 「제외」: none
  };
}

// --- which rules filter ----------------------------------------------------------

// The rules 「태그 줄만」 keeps lines by: of the tags applied to the file (common
// always among them — see tagsFor) minus the ones switched off in the view,
// the enabled rules marked 「줄만」. The index of a rule here is what the
// engine reports in Row.rules / Progress.ruleHits / slowRules.
export function filterRules(store: TagStore, names: string[], off: string[]): LogRule[] {
  const use = names.filter((n) => !off.includes(n));
  return rulesFor(store, use).filter((r) => r.on && r.filter && r.pattern !== "");
}

// What makes two filter rule lists filter the same lines (colour and label
// changes don't need a new scan).
export function filterKey(rules: LogRule[]): string {
  return JSON.stringify(rules.map((r) => [r.kind, r.caseSensitive ? 1 : 0, r.pattern]));
}

// The tag a filter rule comes from, for labels ("collector · rebalance").
export function ruleOwners(store: TagStore, names: string[], off: string[]): string[] {
  const use = names.filter((n) => !off.includes(n));
  const order = [...use.filter((n) => n !== COMMON), ...(use.includes(COMMON) ? [COMMON] : [])];
  const byName = new Map(store.tags.map((t) => [t.name, t]));
  const out: string[] = [];
  for (const n of order) for (const r of byName.get(n)?.rules ?? []) if (r.on && r.filter && r.pattern !== "") out.push(n);
  return out;
}

// --- rows ----------------------------------------------------------------------------

// A row as the engine sends it (linefilter.Row).
export interface FRow {
  line: number; // 1-based line of the file; 0 = gap row
  text: string;
  hit?: boolean;
  rules?: number[];
  col: number;
  truncatedLine?: boolean;
  skip?: number; // gap rows: lines left out
  from?: number; // gap rows: first line left out
}

// The rows fetched so far, in pages of `size` rows. A page holds a prefix of
// its rows (a short answer, or rows not found yet); rows already held never
// change within one engine version, so pages only grow — until dropFrom().
export class RowStore {
  pages = new Map<number, FRow[]>();
  constructor(public size: number) {}
  get(i: number): FRow | undefined {
    return this.pages.get(Math.floor(i / this.size))?.[i % this.size];
  }
  // How many rows of page p are held.
  held(p: number): number {
    return this.pages.get(p)?.length ?? 0;
  }
  // Rows [from, from+rows.length). Rows that would leave a hole in a page are
  // not kept (the page is fetched again from its end).
  put(from: number, rows: FRow[]) {
    let i = from;
    let k = 0;
    while (k < rows.length) {
      const p = Math.floor(i / this.size);
      const off = i - p * this.size;
      const n = Math.min(rows.length - k, this.size - off);
      const have = this.pages.get(p) ?? [];
      if (off <= have.length) {
        if (off + n > have.length) {
          const next = have.slice(0, off);
          for (let x = 0; x < n; x++) next.push(rows[k + x]);
          this.pages.set(p, next);
        }
      } else break; // a hole: the rest can't be placed either
      i += n;
      k += n;
    }
  }
  // Forget rows ≥ i (lines were appended, or a smaller final count).
  dropFrom(i: number) {
    for (const p of [...this.pages.keys()]) {
      const start = p * this.size;
      if (start >= i) this.pages.delete(p);
      else if (start + this.held(p) > i) this.pages.set(p, this.pages.get(p)!.slice(0, i - start));
    }
  }
  clear() {
    this.pages.clear();
  }
  // Keep at most `max` pages: the ones nearest to row `near` stay.
  trim(max: number, near: number) {
    if (this.pages.size <= max) return;
    const c = Math.floor(near / this.size);
    const keys = [...this.pages.keys()].sort((a, b) => Math.abs(a - c) - Math.abs(b - c));
    for (const p of keys.slice(max)) this.pages.delete(p);
  }
}

// The row count a page tells (linefilter.Page).
export function countFromPage(pg: { from: number; rows: unknown[]; available: number; total: number; end: boolean }): number {
  if (pg.end) return pg.from + pg.rows.length;
  return pg.total >= 0 ? pg.total : pg.available;
}

// --- scrolling ---------------------------------------------------------------------------
//
// Rows have one fixed height. Past MAX_SCROLL pixels (browsers cap element
// heights around 33M px) the scroll bar is scaled: its position maps linearly
// onto the first row shown.

export const MAX_SCROLL = 8_000_000;

export interface Geometry {
  height: number; // of the scrolled content (px)
  scaled: boolean;
}
export function geometry(count: number, rowH: number): Geometry {
  const h = count * rowH;
  return h > MAX_SCROLL ? { height: MAX_SCROLL, scaled: true } : { height: h, scaled: false };
}
// The (fractional) first row at a scroll position.
export function rowAtScroll(top: number, count: number, rowH: number, viewH: number): number {
  const g = geometry(count, rowH);
  if (!g.scaled) return top / rowH;
  const range = g.height - viewH;
  const rows = count - viewH / rowH;
  return range > 0 ? (Math.min(top, range) / range) * rows : 0;
}
// The scroll position that puts `row` first.
export function scrollForRow(row: number, count: number, rowH: number, viewH: number): number {
  const g = geometry(count, rowH);
  const maxTop = Math.max(0, g.height - viewH);
  if (!g.scaled) return Math.min(maxTop, Math.max(0, row * rowH));
  const rows = count - viewH / rowH;
  return rows > 0 ? Math.min(maxTop, Math.max(0, (row / rows) * maxTop)) : 0;
}

// --- text ---------------------------------------------------------------------------------

export const fmtN = (n: number) => n.toLocaleString("en-US");

export function gapText(r: FRow): string {
  return `⋯ ${fmtN(r.skip ?? 0)}줄 생략`;
}
export function gapTitle(r: FRow): string {
  const a = r.from ?? 0;
  const b = a + (r.skip ?? 0) - 1;
  return a === b ? `줄 ${fmtN(a)} 생략` : `줄 ${fmtN(a)}–${fmtN(b)} 생략 (두 번 누르면 전체 보기로 그 자리)`;
}
// The line a row stands for when jumping to the whole file.
export const rowLine = (r: FRow) => (r.line > 0 ? r.line : r.from ?? 1);

// Rows as copied text.
export function rowsText(rows: FRow[]): string {
  return rows.map((r) => (r.line > 0 ? r.text : gapText(r))).join("\n");
}

// --- colouring -------------------------------------------------------------------------------
//
// The same colours as the editor: the same compiled rules (compileRule) and
// the same overlap resolution (resolvePaint, tags beat common). Lines of the
// view are at most 4KB (the engine cuts longer ones), so they are painted
// whole; the editor paints the first 2,000 characters of a line.

export interface PaintSpan {
  from: number;
  to: number;
  color: string; // "" = not coloured (an ANSI code outside any match)
  dim?: boolean; // an ANSI colour code (shown faint, like the editor)
}
// The style of a painted span in the view.
export const spanStyle = (s: PaintSpan) =>
  s.dim ? { color: s.color || undefined, fontWeight: s.color ? 600 : undefined, opacity: 0.45 } : { color: s.color, fontWeight: 600 };
export interface RowPaint {
  spans: PaintSpan[];
  tint: string; // line background colour ("" = none)
}
const NO_PAINT: RowPaint = { spans: [], tint: "" };

export class RowPainter {
  private m: RuleMatcher[] = [];
  private color: string[] = [];
  private layer: number[] = [];
  private lineRule: boolean[] = [];
  private lineHead: number[] = [];
  private cache = new Map<string, RowPaint>();
  constructor(layers: RuleLayers | null) {
    (layers ?? []).forEach((rs, layer) => {
      for (const r of rs) {
        if (!r.on) continue;
        const m = compileRule(r);
        if (!m) continue;
        this.m.push(m);
        this.color.push(r.color);
        this.layer.push(layer);
        this.lineRule.push(!!r.line);
        this.lineHead.push(lineHeadOf(r));
      }
    });
  }
  get empty() {
    return this.m.length === 0;
  }
  private find = (t: string) => this.m.map((m) => m.ranges(t));
  paint(text: string): RowPaint {
    if (!this.m.length || !text) return NO_PAINT;
    const hit = this.cache.get(text);
    if (hit) return hit;
    // the editor's own line painting (ANSI codes skipped, level-column tint)
    const p = paintLine(text, this.find, this.layer, this.lineRule, this.lineHead);
    const spans = p.dim ? dimSpans(text.length, p.spans, p.dim, this.color) : [];
    if (!p.dim) for (let k = 0; k < p.spans.length; k += 3) spans.push({ from: p.spans[k], to: p.spans[k + 1], color: this.color[p.spans[k + 2]] });
    const out = { spans, tint: p.tint >= 0 ? this.color[p.tint] : "" };
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(text, out);
    return out;
  }
}

// Spans of a line with ANSI codes: the colour spans (rule = spans[k+2]) cut
// around the codes, each code a faint span of its own (coloured too when it
// sits inside a match). Non-overlapping, in order.
function dimSpans(len: number, spans: number[], dim: number[], color: string[]): PaintSpan[] {
  const col = new Int32Array(len).fill(-1);
  for (let k = 0; k < spans.length; k += 3) col.fill(spans[k + 2], spans[k], spans[k + 1]);
  const isDim = new Uint8Array(len);
  for (let k = 0; k < dim.length; k += 2) isDim.fill(1, dim[k], dim[k + 1]);
  const out: PaintSpan[] = [];
  for (let c = 0; c < len; ) {
    let e = c + 1;
    while (e < len && col[e] === col[c] && isDim[e] === isDim[c]) e++;
    if (col[c] >= 0 || isDim[c]) out.push({ from: c, to: e, color: col[c] >= 0 ? color[col[c]] : "", ...(isDim[c] ? { dim: true } : {}) });
    c = e;
  }
  return out;
}

// 「줄만」 found rules its engine had to run the slow way (Progress.slowRules,
// indexes into `rules`): remember them for the tag window (ruleHealth.ts).
export function noteSlowFilterRules(rules: LogRule[], slow: number[] | null | undefined): void {
  for (const k of slow ?? []) if (rules[k]) noteRuleTrouble(ruleKey(rules[k]), "filter");
}
