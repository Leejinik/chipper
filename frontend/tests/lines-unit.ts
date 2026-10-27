// Unit tests of lineView.ts (the 「🏷 태그 줄만」 logic without React).
//   node tests/run-lines-unit.cjs
import {
  countFromPage,
  DEFAULT_LINES,
  filterKey,
  filterRules,
  gapText,
  gapTitle,
  geometry,
  MAX_SCROLL,
  normalizeLines,
  RowPainter,
  rowAtScroll,
  rowLine,
  RowStore,
  rowsText,
  ruleOwners,
  scrollForRow,
  type FRow,
} from "../src/lineView";
import { DEFAULT_LOG_RULES, type LogRule } from "../src/logHighlight";
import { emptyAssign, type TagStore } from "../src/logTags";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- normalizeLines ---
ok("garbage → null", normalizeLines(null) === null && normalizeLines("x") === null);
ok("defaults", eq(normalizeLines({}), { on: false, above: 0, below: 3, off: [] }));
ok("clamps", eq(normalizeLines({ on: true, above: -5, below: 99999, off: ["a", 3, "b"] }), { on: true, above: 0, below: 1000, off: ["a", "b"] }));
ok("strings → numbers", eq(normalizeLines({ above: "7", below: "x" }), { on: false, above: 7, below: 0, off: [] }));
ok("DEFAULT_LINES = 위 0 아래 3", DEFAULT_LINES.above === 0 && DEFAULT_LINES.below === 3);

// --- which rules filter ---
const R = (id: string, pattern: string, extra: Partial<LogRule> = {}): LogRule => ({
  id,
  on: true,
  label: id,
  pattern,
  kind: "text",
  caseSensitive: false,
  color: "#123456",
  line: false,
  filter: true,
  ...extra,
});
const store: TagStore = {
  version: 1,
  tags: [
    { name: "common", rules: DEFAULT_LOG_RULES, updated: "" },
    { name: "collector", rules: [R("c1", "rebalance"), R("c2", "off rule", { on: false }), R("c3", "no filter", { filter: false }), R("c4", "")], updated: "" },
    { name: "admin", rules: [R("a1", "login")], updated: "" },
  ],
  assign: emptyAssign(),
};
const fr = filterRules(store, ["common"], []);
ok("common 만: 오류·경고·장애 (정보·디버그·시각 빠짐)", eq(fr.map((r) => r.id), ["error", "warn", "mk119"]), fr.map((r) => r.id));
const fr2 = filterRules(store, ["common", "collector"], []);
ok("태그 먼저, common 나중 · 꺼진/줄만 아님/빈 규칙 빠짐", eq(fr2.map((r) => r.id), ["c1", "error", "warn", "mk119"]), fr2.map((r) => r.id));
ok("ruleOwners 같은 순서", eq(ruleOwners(store, ["common", "collector"], []), ["collector", "common", "common", "common"]));
ok("common 끄기", eq(filterRules(store, ["common", "collector"], ["common"]).map((r) => r.id), ["c1"]));
ok("여러 태그 순서대로", eq(filterRules(store, ["common", "admin", "collector"], ["common"]).map((r) => r.id), ["a1", "c1"]));
ok("없는 태그 이름 무시", eq(filterRules(store, ["common", "nope"], ["common"]), []));
// filterKey: only what changes the lines kept
const k1 = filterKey(fr2);
ok("색·이름표·줄 배경만 바뀌면 같은 키", k1 === filterKey(fr2.map((r) => ({ ...r, color: "#000000", label: "x", line: !r.line }))));
ok("패턴이 바뀌면 다른 키", k1 !== filterKey(fr2.map((r, i) => (i ? r : { ...r, pattern: "rebalancing" }))));
ok("종류가 바뀌면 다른 키", k1 !== filterKey(fr2.map((r, i) => (i ? r : { ...r, kind: "word" as const }))));
ok("대소문자가 바뀌면 다른 키", k1 !== filterKey(fr2.map((r, i) => (i ? r : { ...r, caseSensitive: true }))));
ok("순서가 바뀌면 다른 키(규칙 번호가 바뀜)", k1 !== filterKey([...fr2].reverse()));

// --- RowStore ---
const row = (line: number): FRow => ({ line, text: "l" + line, col: -1 });
const rows = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => row(a + k + 1));
{
  const st = new RowStore(4);
  st.put(0, rows(0, 6)); // pages 0 (4) and 1 (2)
  ok("put 나눔", st.held(0) === 4 && st.held(1) === 2 && st.get(5)!.line === 6);
  st.put(8, rows(8, 10)); // hole (page 1 holds 2 of 4) → page 2 starts at its beginning: kept
  ok("다음 페이지 맨 앞은 받음", st.held(2) === 2);
  st.put(7, rows(7, 8)); // page 1 offset 3 > held 2: a hole → dropped
  ok("구멍 나는 행은 버림", st.held(1) === 2 && st.get(7) === undefined);
  st.put(6, rows(6, 8)); // fills page 1
  ok("이어 붙이기", st.held(1) === 4 && st.get(7)!.line === 8);
  st.put(2, rows(2, 4)); // overlap: no change
  ok("겹치는 행은 그대로", st.held(0) === 4 && st.get(3)!.line === 4);
  st.dropFrom(5);
  ok("dropFrom: 그 행부터 버림", st.held(0) === 4 && st.held(1) === 1 && st.held(2) === 0);
  st.put(0, rows(0, 4));
  st.put(8, rows(8, 12));
  st.put(40, rows(40, 44));
  st.trim(2, 0);
  ok("trim: 가까운 페이지만", st.pages.size === 2 && st.held(0) === 4 && st.held(10) === 0, [...st.pages.keys()]);
  st.clear();
  ok("clear", st.pages.size === 0);
}

// --- countFromPage ---
ok("끝 페이지 = from+행", countFromPage({ from: 10, rows: [1, 2], available: 50, total: 50, end: true }) === 12);
ok("끝났으면 total", countFromPage({ from: 0, rows: [1], available: 50, total: 40, end: false }) === 40);
ok("훑는 중 available", countFromPage({ from: 0, rows: [1], available: 33, total: -1, end: false }) === 33);

// --- scrolling ---
{
  const rh = 20;
  const g = geometry(1000, rh);
  ok("작은 결과: 실제 높이", !g.scaled && g.height === 20000);
  ok("작은 결과: 행 ↔ 위치", rowAtScroll(400, 1000, rh, 300) === 20 && scrollForRow(20, 1000, rh, 300) === 400);
  ok("끝 넘어가면 끝에 멈춤", scrollForRow(5000, 1000, rh, 300) === 20000 - 300);
  const big = 4_000_000; // 80M px
  const gb = geometry(big, rh);
  ok("큰 결과: 높이 상한", gb.scaled && gb.height === MAX_SCROLL);
  ok("큰 결과: 처음 = 0행", rowAtScroll(0, big, rh, 300) === 0 && scrollForRow(0, big, rh, 300) === 0);
  const endTop = MAX_SCROLL - 300;
  ok("큰 결과: 끝 위치 = 마지막 화면", Math.abs(rowAtScroll(endTop, big, rh, 300) - (big - 15)) < 1e-6);
  let mono = true;
  let prev = -1;
  for (let t = 0; t <= endTop; t += 997) {
    const r = rowAtScroll(t, big, rh, 300);
    if (r < prev) mono = false;
    prev = r;
  }
  ok("큰 결과: 위치→행 단조", mono);
  ok("큰 결과: 행→위치→행 되돌아옴", Math.abs(rowAtScroll(scrollForRow(1234567, big, rh, 300), big, rh, 300) - 1234567) < 1);
}

// --- text ---
const gap: FRow = { line: 0, text: "", col: -1, skip: 1234, from: 11 };
ok("생략 행 글자", gapText(gap) === "⋯ 1,234줄 생략");
ok("생략 행 풍선", gapTitle(gap).startsWith("줄 11–1,244 생략"));
ok("생략 한 줄", gapTitle({ line: 0, text: "", col: -1, skip: 1, from: 5 }) === "줄 5 생략");
ok("rowLine: 줄 / 생략 행은 첫 줄", rowLine(row(7)) === 7 && rowLine(gap) === 11);
ok("복사 글자", rowsText([row(1), gap, row(1245)]) === "l1\n⋯ 1,234줄 생략\nl1245");

// --- colours: same as the editor's resolution ---
{
  const p = new RowPainter([[R("t", "rebalance", { color: "#00aa00" })], DEFAULT_LOG_RULES]);
  const a = p.paint("2026-10-20 10:00:00 ERROR kafka rebalance failed");
  const colors = a.spans.map((s) => [s.from, s.to, s.color]);
  ok(
    "시각·오류·태그·failed 색 (태그가 common 을 이김)",
    eq(colors, [
      [0, 19, "#56b6c2"],
      [20, 25, "#ff6b6b"],
      [32, 41, "#00aa00"],
      [42, 48, "#ff6b6b"],
    ]),
    colors
  );
  ok("오류 줄 배경", a.tint === "#ff6b6b");
  ok("규칙 없음 → 칠하지 않음", new RowPainter(null).paint("ERROR").spans.length === 0);
  const off = new RowPainter([[R("t", "x", { on: false })]]);
  ok("꺼진 규칙 → 칠하지 않음", off.empty && off.paint("x").spans.length === 0);
}

console.log(`lines-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
