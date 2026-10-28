// Unit tests of 「🚫 제외」 in lineView.ts (chips of the 「🏷 태그 줄만」 view).
//   node tests/run-unit.cjs   (or bundle this file alone)
import {
  addExclude,
  DEFAULT_LINES,
  excludeKey,
  excludeLabel,
  excludeProblem,
  excludeRequest,
  MAX_EXCLUDE,
  normalizeExclude,
  normalizeLines,
  removeExclude,
  toggleExclude,
  type ExcludeRule,
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
const X = (pattern: string, o: Partial<ExcludeRule> = {}): ExcludeRule => ({ pattern, kind: "text", caseSensitive: false, on: true, ...o });

// --- session: old sessions have no field; junk is dropped ---
ok("기본값: 제외 없음", eq(DEFAULT_LINES.ex, []));
ok("옛 세션(ex 없음) → []", eq(normalizeLines({ on: true, above: 1, below: 2, off: [] })!.ex, []));
ok("ex 가 배열이 아니면 []", eq(normalizeLines({ ex: "commonConnection" })!.ex, []) && eq(normalizeLines({ ex: { pattern: "x" } })!.ex, []));
const raw = [
  { pattern: "commonConnection", kind: "text", caseSensitive: false, on: true },
  { pattern: "Keep", kind: "word", caseSensitive: true, on: false },
  { pattern: "a\\d+", kind: "regex" },
  { pattern: "", kind: "text" },
  { pattern: "two\nlines" },
  { pattern: 5 },
  null,
  { pattern: "x".repeat(1001) },
  { pattern: "noKind" },
  { pattern: "bad", kind: "glob" },
  { pattern: "commonConnection", kind: "text", caseSensitive: false, on: false }, // twin of the first
];
const n = normalizeExclude(raw);
ok(
  "세션 정리: 빈 것·줄바꿈·숫자·1000자 넘음·쌍둥이 빠짐, 종류 없으면 글자 그대로, on 없으면 켜짐",
  eq(n, [
    X("commonConnection"),
    X("Keep", { kind: "word", caseSensitive: true, on: false }),
    X("a\\d+", { kind: "regex" }),
    X("noKind"),
    X("bad"),
  ]),
  n
);
ok("세션 왕복", eq(normalizeLines(JSON.parse(JSON.stringify({ ...DEFAULT_LINES, ex: n })))!.ex, n));
ok(`최대 ${MAX_EXCLUDE}개`, normalizeExclude(Array.from({ length: 80 }, (_, i) => ({ pattern: "p" + i }))).length === MAX_EXCLUDE);

// --- chips ---
let l: ExcludeRule[] = [];
l = addExclude(l, { pattern: "commonConnection", kind: "text", caseSensitive: false });
ok("추가 = 켜진 칩", eq(l, [X("commonConnection")]));
l = toggleExclude(l, 0);
ok("누르면 꺼짐", l[0].on === false);
l = addExclude(l, { pattern: "commonConnection", kind: "text", caseSensitive: false });
ok("같은 칩을 또 추가 → 쌍둥이 없이 다시 켬", l.length === 1 && l[0].on === true);
l = addExclude(l, { pattern: "commonConnection", kind: "text", caseSensitive: true });
ok("대소문자만 달라도 다른 칩", l.length === 2);
l = addExclude(l, { pattern: "x\\d", kind: "regex", caseSensitive: false });
l = toggleExclude(l, 1);
const rq = excludeRequest(l);
ok("엔진에는 켜진 칩만, 칩 번호 대응", eq(rq.chip, [0, 2]) && eq(rq.rules.map((r) => r.pattern), ["commonConnection", "x\\d"]) && rq.rules.every((r) => r.on));
ok("요청 규칙 모양 = linefilter.Rule", eq(Object.keys(rq.rules[0]).sort(), ["caseSensitive", "kind", "on", "pattern"]));
const k1 = excludeKey(l);
ok("꺼진 칩은 키에 안 들어감", k1 === excludeKey(removeExclude(l, 1)));
ok("켜고 끄면 키가 바뀜 → 다시 거름", excludeKey(toggleExclude(l, 0)) !== k1);
ok("모두 끄면 = 제외 없음 키", excludeKey(l.map((x) => ({ ...x, on: false }))) === excludeKey([]));
ok("지우기", eq(removeExclude(l, 0).map((x) => x.pattern), ["commonConnection", "x\\d"]));
const full = Array.from({ length: MAX_EXCLUDE }, (_, i) => X("p" + i));
ok(`${MAX_EXCLUDE}개면 더 안 늘어남`, addExclude(full, { pattern: "more", kind: "text", caseSensitive: false }).length === MAX_EXCLUDE);

// --- what can be a chip (the tag rules' check) ---
ok("글자 그대로: 아무 글자나 됨 (정규식 기호도 글자)", excludeProblem({ pattern: "a(b", kind: "text", caseSensitive: false }) === "");
ok("빈 글자는 문제 아님(추가만 안 됨)", excludeProblem({ pattern: "", kind: "text", caseSensitive: false }) === "");
ok("틀린 정규식 → 사유", excludeProblem({ pattern: "a(b", kind: "regex", caseSensitive: false }) !== "");
const lb = excludeProblem({ pattern: "(?<=x)y", kind: "regex", caseSensitive: false });
ok("뒤돌아보기 → 줄만 보기에서 쓸 수 없음 (태그 규칙과 같은 사유)", /쓸 수 없|뒤돌아보기/.test(lb), lb);
ok("줄바꿈", /줄바꿈/.test(excludeProblem({ pattern: "a\nb", kind: "text", caseSensitive: false })));
ok("1000자", /1000/.test(excludeProblem({ pattern: "x".repeat(1001), kind: "text", caseSensitive: false })));

// --- labels ---
ok("칩 글자", excludeLabel(X("abc")) === "abc" && excludeLabel(X("abc", { caseSensitive: true })) === "abc Aa");
ok("단어·정규식 표시", excludeLabel(X("abc", { kind: "word" })) === "‹abc›" && excludeLabel(X("a\\d", { kind: "regex" })) === "/a\\d/");

console.log(`lines-exclude-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
