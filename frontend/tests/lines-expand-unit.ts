// Unit tests of 「⋯ N줄 생략」 펼치기 in lineView.ts (the 「🏷 태그 줄만」 view).
//   node tests/run-unit.cjs   (or bundle this file alone)
import {
  DEFAULT_LINES,
  foldGroups,
  foldText,
  foldTitle,
  gapTitle,
  groupsAt,
  groupsBeside,
  groupsStart,
  MAX_OPEN,
  normalizeLines,
  normalizeOpen,
  OPEN_ALL_MAX,
  OPEN_STEP,
  openFlat,
  openGap,
  openKey,
  rowsText,
  type FRow,
  type OpenSpan,
} from "../src/lineView";

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

// --- session: old sessions have no field; junk is dropped ---
ok("기본값: 펼친 곳 없음", (DEFAULT_LINES.open ?? []).length === 0);
ok("옛 세션(open 없음) → 칸 없음(옛 판과 같은 상태)", normalizeLines({ on: true, above: 1, below: 2, off: [] })!.open === undefined);
ok("open 이 배열이 아니면 없음", normalizeLines({ open: "1-5" })!.open === undefined && normalizeLines({ open: { 0: 1 } })!.open === undefined);
ok(
  "틀린 칸은 버림(0·음수·소수·거꾸로·문자), 묶음 번호 없으면 0",
  eq(normalizeOpen([[0, 5, 1], [-3, 2, 1], [1.5, 3, 1], [9, 4, 1], ["a", 3], [10, 12], [20, 30, 2]]), [
    [10, 12, 0],
    [20, 30, 2],
  ]),
  normalizeOpen([[0, 5, 1], [-3, 2, 1], [1.5, 3, 1], [9, 4, 1], ["a", 3], [10, 12], [20, 30, 2]])
);
ok(
  "같은 묶음끼리 겹치거나 붙으면 합침 · 다른 묶음은 그대로 · 줄 순서",
  eq(normalizeOpen([[30, 40, 1], [10, 20, 1], [21, 25, 1], [15, 35, 2], [41, 50, 1]]), [
    [10, 25, 1],
    [15, 35, 2],
    [30, 50, 1],
  ])
);
ok("세션 왕복", eq(normalizeLines(JSON.parse(JSON.stringify({ ...DEFAULT_LINES, open: [[5, 24, 0], [85, 104, 0]] })))!.open, [[5, 24, 0], [85, 104, 0]]));
const many: OpenSpan[] = [];
for (let i = 0; i < MAX_OPEN + 50; i++) many.push([i * 10 + 1, i * 10 + 2, i]);
ok(`${MAX_OPEN}개까지만 남김`, normalizeOpen(many).length === MAX_OPEN);

// --- what the engine gets ---
ok("엔진 인자 = [lo, hi, …]", eq(openFlat([[5, 24, 0], [85, 104, 0]]), [5, 24, 85, 104]) && eq(openFlat(undefined), []));
ok("openKey 는 줄만 봄(묶음 번호는 안 봄)", openKey([[5, 24, 0]]) === openKey([[5, 24, 7]]) && openKey([[5, 24, 0]]) !== openKey([[5, 25, 0]]));

// --- opening a gap: 「⋯ 100줄 생략」 standing for lines 5..104 ---
const up = openGap([], 5, 100, "up");
ok(`▲ 위로 ${OPEN_STEP}줄 = 생략 구간 위쪽 끝부터`, eq(up, [[5, 24, 0]]), up);
const down = openGap([], 5, 100, "down");
ok(`▼ 아래로 ${OPEN_STEP}줄 = 아래쪽 끝(다음 걸린 줄 바로 위)에서`, eq(down, [[85, 104, 0]]), down);
ok("전부 펼치기", eq(openGap([], 5, 100, "all"), [[5, 104, 0]]));
// after ▲ the gap row stands for 25..104 (80): ▲ again goes on from 25, same group
const up2 = openGap(up, 25, 80, "up");
ok("▲ 두 번 = 40줄, 한 묶음으로 합쳐짐", eq(up2, [[5, 44, 0]]), up2);
const both = openGap(up, 25, 80, "down");
ok("▲ 뒤 ▼ = 같은 묶음 두 조각", eq(both, [[5, 24, 0], [85, 104, 0]]), both);
const closed = openGap(both, 25, 60, "all");
ok("남은 생략을 전부 → 한 조각", eq(closed, [[5, 104, 0]]), closed);
ok("작은 구간(20줄 이하): ▲ 는 남은 줄만큼", eq(openGap([], 5, 7, "up"), [[5, 11, 0]]));
// another gap: a new group
const other = openGap(both, 200, 50, "up");
ok("다른 생략 줄 = 새 묶음", eq(other, [[5, 24, 0], [85, 104, 0], [200, 219, 1]]), other);
// a double-click (auto): small → all, big → OPEN_STEP each end
ok(`두 번 누르기: ${OPEN_ALL_MAX}줄 이하 → 전부`, eq(openGap([], 5, OPEN_ALL_MAX, "auto"), [[5, OPEN_ALL_MAX + 4, 0]]));
const big = openGap([], 5, 160_000, "auto");
ok(`두 번 누르기: 더 크면 위·아래 ${OPEN_STEP}줄씩`, eq(big, [[5, 24, 0], [160_004 - OPEN_STEP + 1, 160_004, 0]]), big);
ok("틀린 생략 행(줄 없음)은 그대로", eq(openGap(up, 0, 5, "all"), up) && eq(openGap(up, 5, 0, "all"), up));

// --- folding: the whole group (▲ and ▼ pieces together) ---
const g2 = openGap(other, 220, 30, "down"); // group 1 gets a ▼ piece
ok("조각이 붙은 생략 줄의 묶음", eq([...groupsBeside(g2, 25, 60)], [0]) && eq([...groupsBeside(g2, 220, 30 - OPEN_STEP)], [1]), g2);
ok("접기 줄(줄 85..104) → 그 묶음", eq([...groupsAt(g2, 85, 104)], [0]));
ok("펼친 줄 하나 → 그 묶음", eq([...groupsAt(g2, 210, 210)], [1]));
ok("펼치지 않은 줄 → 없음", groupsAt(g2, 60, 60).size === 0);
ok("묶음 0 접기 = ▲·▼ 조각 모두", eq(foldGroups(g2, new Set([0])), g2.filter((x) => x[2] === 1)));
ok("묶음 시작 줄", groupsStart(g2, new Set([0])) === 5 && groupsStart(g2, new Set([1])) === 200);

// --- text ---
const gap: FRow = { line: 0, text: "", col: -1, skip: 100, from: 5 };
ok("생략 행 풍선: 줄 범위 + 펼치기 방법 + Enter", /줄 5–104 생략/.test(gapTitle(gap)) && /전부 펼치기/.test(gapTitle(gap)) && /Enter/.test(gapTitle(gap)), gapTitle(gap));
ok(
  "큰 생략 행 풍선: 위·아래 20줄씩",
  /위·아래 20줄씩/.test(gapTitle({ ...gap, skip: 160_000 })),
  gapTitle({ ...gap, skip: 160_000 })
);
const fold: FRow = { line: 0, text: "", col: -1, skip: 1234, from: 5, fold: true };
ok("접기 줄 글자", foldText(fold) === "▾ 접기 · 펼친 1,234줄", foldText(fold));
ok("접기 줄 풍선", /줄 5–1,238/.test(foldTitle(fold)) && /접기|생략/.test(foldTitle(fold)), foldTitle(fold));
const rows: FRow[] = [
  { line: 3, text: "l3 ERROR", col: 3, hit: true },
  fold,
  { line: 5, text: "l5", col: -1, open: true },
  { line: 0, text: "", col: -1, skip: 7, from: 6 },
];
ok("복사: 접기 줄은 빼고 펼친 줄은 글자로", rowsText(rows) === "l3 ERROR\nl5\n⋯ 7줄 생략", rowsText(rows));

console.log(`lines-expand-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
