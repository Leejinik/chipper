// Multi-view pane sizes: how wide each pane of a row is and how tall each row
// is, as fractions, kept per pane count (1..6) so going 4 → 2 → 4 brings the
// 4-pane layout back. Pure functions only (MultiGrid.tsx does the DOM part).
//
// Layout (unchanged from the 6-column grid it replaces): 1–3 panes = one row,
// 4–6 panes = two rows, ceil(n/2) on top and the rest below.

export const MAX_SIZED_PANES = 6;
// Width of a boundary bar between panes, the same as the editor/preview
// `.resizer` of the one-pane view.
export const MV_GAP = 6;
// Smallest pane a drag may leave (measured headless, 12px UI font):
// - width 260: the pane head keeps its number, 「전체 / 🏷 줄만」 and the three
//   mode buttons visible (the title shrinks first). 「탭 고르기」 and × need
//   ~410px with a file path (~490 with a bundle server list); below that they
//   are clipped at the right edge, as with six equal panes on a small screen.
// - height 150: the head plus a few editor lines; a 「🏷 줄만」 pane at 260px
//   wide wraps its head to ~90px and still shows a couple of rows.
export const MIN_PANE_W = 260;
export const MIN_PANE_H = 150;
// A restored fraction below this is treated as damage (a pane can't vanish).
const MIN_FRAC = 0.02;

export interface PaneLayout {
  cols: number[][]; // per row: width fraction of each pane (sums to 1)
  rows: number[]; // height fraction of each row (sums to 1)
}
export type PaneSizes = Record<string, PaneLayout>; // key = pane count

// Pane indices of each row.
export function rowsOf(count: number): number[][] {
  const n = Math.min(MAX_SIZED_PANES, Math.max(1, Math.floor(count) || 1));
  const idx = Array.from({ length: n }, (_, i) => i);
  if (n <= 3) return [idx];
  const top = Math.ceil(n / 2);
  return [idx.slice(0, top), idx.slice(top)];
}

const equal = (k: number) => Array.from({ length: k }, () => 1 / k);

export function equalLayout(count: number): PaneLayout {
  const rows = rowsOf(count);
  return { cols: rows.map((r) => equal(r.length)), rows: equal(rows.length) };
}

// Fractions that are all finite and > 0, scaled to sum 1; null when unusable.
function fracs(raw: unknown, k: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== k) return null;
  if (!raw.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) return null;
  let v = raw as number[];
  for (let pass = 0; pass < 2; pass++) {
    const sum = v.reduce((a, b) => a + b, 0);
    v = v.map((x) => Math.max(MIN_FRAC, x / sum));
  }
  const sum = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / sum);
}

// The saved layout of one pane count, or null when it doesn't fit that count.
function normalizeLayout(raw: any, count: number): PaneLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const shape = rowsOf(count);
  if (!Array.isArray(raw.cols) || raw.cols.length !== shape.length) return null;
  const cols: number[][] = [];
  for (let r = 0; r < shape.length; r++) {
    const c = fracs(raw.cols[r], shape[r].length);
    if (!c) return null;
    cols.push(c);
  }
  const rows = fracs(raw.rows, shape.length);
  return rows ? { cols, rows } : null;
}

// Session value → sizes. Anything missing or broken means "equal" for that
// count (an old session has no field at all).
export function normalizePaneSizes(raw: unknown): PaneSizes {
  const out: PaneSizes = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (let n = 1; n <= MAX_SIZED_PANES; n++) {
    const lay = normalizeLayout((raw as any)[String(n)], n);
    if (lay) out[String(n)] = lay;
  }
  return out;
}

export function layoutFor(sizes: PaneSizes, count: number): PaneLayout {
  return normalizeLayout(sizes[String(count)], count) ?? equalLayout(count);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Moving the boundary between panes j and j+1 of row r by `delta` px, where
// `avail` px are shared by that row's panes (bars excluded). Only those two
// panes change; neither goes below `minPx` (or half the pair when the pair
// itself is smaller than two minimums).
export function dragCol(lay: PaneLayout, r: number, j: number, delta: number, avail: number, minPx = MIN_PANE_W): PaneLayout {
  const row = lay.cols[r];
  if (!row || j < 0 || j + 1 >= row.length || !(avail > 0)) return lay;
  return { ...lay, cols: lay.cols.map((c, k) => (k === r ? movePair(c, j, delta / avail, minPx / avail) : c)) };
}

// Moving the boundary between the two rows by `delta` px (`avail` = height
// shared by the rows).
export function dragRow(lay: PaneLayout, delta: number, avail: number, minPx = MIN_PANE_H): PaneLayout {
  if (lay.rows.length < 2 || !(avail > 0)) return lay;
  return { ...lay, rows: movePair(lay.rows, 0, delta / avail, minPx / avail) };
}

function movePair(v: number[], j: number, d: number, minF: number): number[] {
  const sum = v[j] + v[j + 1];
  const m = Math.min(minF, sum / 2);
  const a = clamp(v[j] + d, m, sum - m);
  const out = v.slice();
  out[j] = a;
  out[j + 1] = sum - a;
  return out;
}

export function equalizeRow(lay: PaneLayout, r: number): PaneLayout {
  if (!lay.cols[r]) return lay;
  return { ...lay, cols: lay.cols.map((c, k) => (k === r ? equal(c.length) : c)) };
}

export function equalizeRows(lay: PaneLayout): PaneLayout {
  return { ...lay, rows: equal(lay.rows.length) };
}

export const isEqualLayout = (lay: PaneLayout) =>
  [...lay.cols, lay.rows].every((v) => v.every((x) => Math.abs(x - 1 / v.length) < 1e-9));

// --- CSS ---------------------------------------------------------------------
// Positions are custom properties on the grid element: percentages of the grid
// minus the bars, so the ratios hold whatever the window size. The panes and
// bars only reference the properties, so a drag rewrites the properties alone.
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const num = (x: number) => String(r6(x));
const span = (k: number) => `(100% - ${(k - 1) * MV_GAP}px)`;
const at = (k: number, cum: number, i: number) => `calc(${span(k)} * ${num(cum)} + ${i * MV_GAP}px)`;
const len = (k: number, f: number) => `calc(${span(k)} * ${num(f)})`;
// Rounded fractions whose sum is exactly 1 (the last one takes the rest), so a
// pane ends exactly where the next bar starts.
function rounded(v: number[]): number[] {
  const out: number[] = [];
  let cum = 0;
  v.forEach((x, i) => {
    const f = i + 1 < v.length ? r6(x) : r6(1 - cum);
    out.push(f);
    cum = r6(cum + f);
  });
  return out;
}

export function gridVars(lay: PaneLayout, count: number): Record<string, string> {
  const vars: Record<string, string> = {};
  const shape = rowsOf(count);
  const R = shape.length;
  const rows = rounded(lay.rows);
  let ry = 0;
  shape.forEach((panes, r) => {
    const k = panes.length;
    const fr = rows[r];
    const y = at(R, ry, r);
    const h = len(R, fr);
    vars[`--mvr${r}-y`] = y;
    vars[`--mvr${r}-h`] = h;
    const cols = rounded(lay.cols[r]);
    let cx = 0;
    panes.forEach((p, j) => {
      const f = cols[j];
      vars[`--mv${p}-x`] = at(k, cx, j);
      vars[`--mv${p}-w`] = len(k, f);
      vars[`--mv${p}-y`] = y;
      vars[`--mv${p}-h`] = h;
      cx = r6(cx + f);
      if (j + 1 < k) vars[`--mvc${r}-${j}-x`] = at(k, cx, j);
    });
    ry = r6(ry + fr);
    if (r + 1 < R) vars[`--mvrh-y`] = at(R, ry, r);
  });
  return vars;
}

// Style of pane i (fixed per index: the values come from gridVars).
export function paneStyle(i: number): Record<string, string> {
  return { left: `var(--mv${i}-x)`, top: `var(--mv${i}-y)`, width: `var(--mv${i}-w)`, height: `var(--mv${i}-h)` };
}
