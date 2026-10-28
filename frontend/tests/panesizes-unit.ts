// Pure-function tests for multi-view pane sizes (paneSizes.ts).
// Run: node frontend/tests/run-unit.cjs
import {
  MIN_PANE_H,
  MIN_PANE_W,
  MV_GAP,
  dragCol,
  dragRow,
  equalLayout,
  equalizeRow,
  equalizeRows,
  gridVars,
  isEqualLayout,
  layoutFor,
  normalizePaneSizes,
  paneStyle,
  rowsOf,
  type PaneLayout,
} from "../src/paneSizes";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else fails.push(`${name}${extra === undefined ? "" : "  → " + JSON.stringify(extra)}`);
}
const r6 = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

// --- layout shape: same as the old 6-column grid ---------------------------------
eq("rows 1", rowsOf(1), [[0]]);
eq("rows 2", rowsOf(2), [[0, 1]]);
eq("rows 3", rowsOf(3), [[0, 1, 2]]);
eq("rows 4", rowsOf(4), [[0, 1], [2, 3]]);
eq("rows 5", rowsOf(5), [[0, 1, 2], [3, 4]]);
eq("rows 6", rowsOf(6), [[0, 1, 2], [3, 4, 5]]);
eq("rows out of range → clamp", [rowsOf(0), rowsOf(9).length], [[[0]], 2]);
eq("equal 5", { cols: equalLayout(5).cols.map(r6), rows: r6(equalLayout(5).rows) }, {
  cols: [[0.333333, 0.333333, 0.333333], [0.5, 0.5]],
  rows: [0.5, 0.5],
});
ok("equal layouts are equal", [1, 2, 3, 4, 5, 6].every((n) => isEqualLayout(equalLayout(n))));

// --- dragging a boundary --------------------------------------------------------
{
  const lay = equalLayout(3); // avail 900px → each 300px
  const d = dragCol(lay, 0, 0, 30, 900);
  eq("drag col: only the pair changes", r6(d.cols[0]), [0.366667, 0.3, 0.333333]);
  ok("drag col: sum kept", near(sum(d.cols[0]), 1));
  ok("drag col: input untouched", isEqualLayout(lay));
  const far = dragCol(lay, 0, 0, 5000, 900);
  eq("drag col: right pane keeps its minimum", Math.round(far.cols[0][1] * 900), MIN_PANE_W);
  eq("drag col: left grows by the rest", Math.round(far.cols[0][0] * 900), 600 - MIN_PANE_W);
  const back = dragCol(lay, 0, 1, -5000, 900);
  eq("drag col (2nd bar) left: middle keeps its minimum", Math.round(back.cols[0][1] * 900), MIN_PANE_W);
  eq("drag col (2nd bar): first pane untouched", r6([back.cols[0][0]]), [0.333333]);
  // pair smaller than two minimums: both stay at half the pair
  const tiny = dragCol(equalLayout(3), 0, 0, 100, 300);
  eq("narrow window: pair split evenly at most", r6(tiny.cols[0]), [0.333333, 0.333333, 0.333333]);
  ok("bad index → same layout", dragCol(lay, 0, 2, 10, 900) === lay && dragCol(lay, 3, 0, 10, 900) === lay);
  ok("zero width → same layout", dragCol(lay, 0, 0, 10, 0) === lay);
}
{
  const lay = equalLayout(6);
  const d = dragCol(lay, 1, 1, -60, 1200);
  eq("6 panes: bottom row only", [r6(d.cols[0]), r6(d.cols[1])], [r6(lay.cols[0]), [0.333333, 0.283333, 0.383333]]);
  const r = dragRow(lay, 100, 500);
  eq("rows: top taller", r6(r.rows), [0.7, 0.3]);
  eq("rows: bottom keeps its minimum", Math.round(dragRow(lay, 999, 500).rows[1] * 500), MIN_PANE_H);
  eq("rows: top keeps its minimum", Math.round(dragRow(lay, -999, 500).rows[0] * 500), MIN_PANE_H);
  ok("rows on a one-row layout → same", dragRow(equalLayout(3), 50, 500) === equalLayout(3) || isEqualLayout(dragRow(equalLayout(3), 50, 500)));
  // double-click: that row (or the rows) equal again, the rest kept
  const both = dragRow(dragCol(dragCol(lay, 0, 0, 80, 900), 1, 0, 80, 900), 60, 500);
  const e0 = equalizeRow(both, 0);
  eq("equalize row 0 only", [r6(e0.cols[0]), r6(e0.cols[1]), r6(e0.rows)], [r6(lay.cols[0]), r6(both.cols[1]), r6(both.rows)]);
  const er = equalizeRows(both);
  eq("equalize rows only", [r6(er.cols[0]), r6(er.rows)], [r6(both.cols[0]), [0.5, 0.5]]);
}

// --- session: save / restore, per count -----------------------------------------
{
  const four: PaneLayout = dragRow(dragCol(equalLayout(4), 0, 0, 120, 800), -40, 600);
  const two: PaneLayout = dragCol(equalLayout(2), 0, 0, -100, 1000);
  const saved = JSON.parse(JSON.stringify({ "4": four, "2": two }));
  const back = normalizePaneSizes(saved);
  eq("round trip 4", { c: back["4"].cols.map(r6), r: r6(back["4"].rows) }, { c: four.cols.map(r6), r: r6(four.rows) });
  eq("round trip 2", back["2"].cols.map(r6), two.cols.map(r6));
  eq("count switch: saved count comes back", layoutFor(back, 4).cols.map(r6), four.cols.map(r6));
  ok("count switch: other count is equal", isEqualLayout(layoutFor(back, 3)) && isEqualLayout(layoutFor(back, 6)));
  eq("old session (no field) → nothing", normalizePaneSizes(undefined), {});
  eq("junk → nothing", [normalizePaneSizes(null), normalizePaneSizes("x"), normalizePaneSizes([1, 2]), normalizePaneSizes(7)], [{}, {}, {}, {}]);
  // a layout that doesn't fit its count is dropped (equal), others kept
  const mixed = normalizePaneSizes({
    "3": { cols: [[0.5, 0.5]], rows: [1] }, // 2 widths for 3 panes
    "4": { cols: [[0.5, 0.5]], rows: [1] }, // 1 row for a 2-row count
    "5": { cols: [[0.2, 0.3, 0.5], [0.5, 0.5]], rows: [0.6, 0.4] },
    "6": { cols: [[0.2, NaN, 0.5], [1, 1, 1]], rows: [0.5, 0.5] },
    "2": { cols: [[-1, 2]], rows: [1] },
    "7": { cols: [[1]], rows: [1] },
    "1": { cols: [[1]], rows: [1] },
  });
  eq("only fitting layouts kept", Object.keys(mixed).sort(), ["1", "5"]);
  eq("kept values", r6(mixed["5"].cols[0]), [0.2, 0.3, 0.5]);
  // sums off (hand edit, older rounding): scaled to 1; a near-zero pane gets a floor
  const scaled = normalizePaneSizes({ "2": { cols: [[2, 6]], rows: [3] }, "3": { cols: [[1, 1e-9, 1]], rows: [1] } });
  eq("scaled to 1", [r6(scaled["2"].cols[0]), r6(scaled["2"].rows)], [[0.25, 0.75], [1]]);
  ok("vanishing pane gets a floor", scaled["3"].cols[0][1] > 0.015 && near(sum(scaled["3"].cols[0]), 1), scaled["3"].cols[0]);
}

// --- CSS positions: panes and bars tile the grid exactly, at any size -------------
// evaluates calc((100% - Apx) * f + Bpx) / calc((100% - Apx) * f) for a size W
function px(expr: string, W: number): number {
  const m = /^calc\(\(100% - (\d+)px\) \* ([\d.e-]+)(?: \+ (\d+)px)?\)$/.exec(expr);
  if (!m) throw new Error("bad calc " + expr);
  return (W - +m[1]) * +m[2] + (m[3] ? +m[3] : 0);
}
for (const n of [1, 2, 3, 4, 5, 6]) {
  let lay = equalLayout(n);
  lay = dragCol(lay, 0, 0, 77, 1000);
  if (lay.cols[1]) lay = dragCol(lay, 1, 0, -55, 1000);
  if (lay.rows.length > 1) lay = dragRow(lay, 33, 600);
  for (const [W, H] of [[1400, 800], [700, 400]]) {
    const v = gridVars(lay, n);
    const shape = rowsOf(n);
    let good = true;
    const why: string[] = [];
    shape.forEach((panes, r) => {
      let x = 0;
      panes.forEach((p, j) => {
        const px0 = px(v[`--mv${p}-x`], W);
        const w = px(v[`--mv${p}-w`], W);
        if (!near(px0, x, 1e-6)) (good = false), why.push(`pane ${p} x ${px0} ≠ ${x}`);
        if (j + 1 < panes.length) {
          const bx = px(v[`--mvc${r}-${j}-x`], W);
          if (!near(bx, px0 + w, 1e-6)) (good = false), why.push(`bar ${r}-${j} at ${bx} ≠ ${px0 + w}`);
        }
        x = px0 + w + MV_GAP;
        if (!near(w / (W - (panes.length - 1) * MV_GAP), lay.cols[r][j], 1e-5)) (good = false), why.push(`pane ${p} ratio`);
      });
      if (!near(x - MV_GAP, W, 1e-6)) (good = false), why.push(`row ${r} ends at ${x - MV_GAP} ≠ ${W}`);
      const y = px(v[`--mvr${r}-y`], H);
      const h = px(v[`--mvr${r}-h`], H);
      if (r === 0 && y !== 0) (good = false), why.push("row 0 y");
      if (r === 1 && !near(px(v["--mvrh-y"], H) + MV_GAP, y, 1e-6)) (good = false), why.push("row bar");
      if (r === shape.length - 1 && !near(y + h, H, 1e-6)) (good = false), why.push(`last row ends ${y + h}`);
      panes.forEach((p) => {
        if (v[`--mv${p}-y`] !== v[`--mvr${r}-y`] || v[`--mv${p}-h`] !== v[`--mvr${r}-h`]) (good = false), why.push(`pane ${p} row vars`);
      });
    });
    ok(`tiling ${n} panes at ${W}×${H} (ratios kept)`, good, why);
    ok(`no row bar for ${n}`, (shape.length > 1) === ("--mvrh-y" in v));
  }
}
eq("pane style references its vars", paneStyle(3), {
  left: "var(--mv3-x)",
  top: "var(--mv3-y)",
  width: "var(--mv3-w)",
  height: "var(--mv3-h)",
});

console.log(`panesizes unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
