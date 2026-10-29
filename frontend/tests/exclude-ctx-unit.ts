// Unit tests of the right-click 「🚫 제외에 추가」 logic (src/excludeCtx.ts).
//   node tests/run-unit.cjs   (or bundle this file alone)
import { addExcludeText, excludeAddState, excludeMenuState, excludeTarget, MAX_PICK, MENU_TEXT, menuText } from "../src/excludeCtx";
import { MAX_EXCLUDE, MAX_EXCLUDE_LEN, type ExcludeRule } from "../src/lineView";

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

// --- the selection → the chip's text ---
ok("빈 선택 → 이유", excludeTarget("").problem.includes("먼저 고르세요") && excludeTarget("").pattern === "");
ok("글자 그대로", eq(excludeTarget("commonConnection"), { pattern: "commonConnection", problem: "" }));
ok("앞뒤 공백 뺌", excludeTarget("  abc def \t").pattern === "abc def");
ok("공백뿐 → 이유", excludeTarget("   ").problem.includes("공백뿐"));
ok("여러 줄 → 이유", excludeTarget("abc\ndef").problem.includes("여러 줄") && excludeTarget("abc\r\ndef").problem.includes("여러 줄"));
ok("끝의 줄바꿈만이면 한 줄 (줄 끝까지 고름)", eq(excludeTarget("abc def\n"), { pattern: "abc def", problem: "" }) && excludeTarget("\nabc\r\n").pattern === "abc");
ok("ANSI 코드 뺌", excludeTarget("\x1b[31mERROR\x1b[0m x").pattern === "ERROR x");
ok("코드뿐 → 공백뿐 이유", excludeTarget("\x1b[0m").problem.includes("공백뿐"));
const long = "a".repeat(MAX_EXCLUDE_LEN);
ok(`${MAX_EXCLUDE_LEN}자 = 됨`, excludeTarget(long).pattern === long);
ok(`${MAX_EXCLUDE_LEN + 1}자 → 이유(칩 상한)`, excludeTarget(long + "b").problem.includes(`${MAX_EXCLUDE_LEN}자보다 긴`));
ok(`${MAX_PICK + 1}자 → 「너무 깁니다」`, excludeTarget("a".repeat(MAX_PICK + 1)).problem.includes("너무 깁니다"));
ok("공백으로 둘러싸 1000자 안 → 됨", excludeTarget("  " + long + "  ").pattern === long);
ok("한글", excludeTarget(" 연결 끊김 ").pattern === "연결 끊김");
ok("정규식 글자도 글자 그대로", excludeTarget("a.*(b").pattern === "a.*(b");

// --- what adding does ---
const list = [X("abc"), X("def", { on: false }), X("Ghi", { caseSensitive: true }), X("jkl", { kind: "word" })];
ok("새 글자 → new", excludeAddState(list, "zzz") === "new");
ok("켜진 같은 칩 → on", excludeAddState(list, "abc") === "on");
ok("꺼진 같은 칩 → off", excludeAddState(list, "def") === "off");
ok("대소문자 구분 칩과는 다른 칩(우클릭은 무시로)", excludeAddState(list, "Ghi") === "new");
ok("단어 칩과는 다른 칩(우클릭은 글자 그대로)", excludeAddState(list, "jkl") === "new");
ok("대소문자만 다른 무시 칩 → 같은 칩", excludeAddState(list, "ABC") === "on" && excludeAddState(list, "DEF") === "off");
ok("대소문자 구분 칩은 대소문자가 다르면 다른 칩", excludeAddState(list, "ghi") === "new");
ok("꺼진 칩(대소문자만 다름) → 그 칩을 켬", eq(addExcludeText(list, "DEF").list, [X("abc"), X("def"), list[2], list[3]]));
const full = Array.from({ length: MAX_EXCLUDE }, (_, i) => X("p" + i));
ok("50개 → full", excludeAddState(full, "new") === "full");
ok("50개여도 같은 칩은 on/off", excludeAddState(full, "p3") === "on" && excludeAddState(full.map((x, i) => (i === 3 ? { ...x, on: false } : x)), "p3") === "off");

let r = addExcludeText(list, "zzz");
ok("추가: 끝에 켜진 글자 그대로·대소문자 무시", r.state === "new" && eq(r.list[r.list.length - 1], X("zzz")) && r.list.length === 5, r);
ok("추가 안내: 줄만 보기에서 적용", r.msg.includes("「zzz」") && r.msg.includes("추가했습니다") && r.msg.includes("줄만 보기에서 적용됩니다"), r.msg);
ok("원래 목록은 그대로", list.length === 4);
r = addExcludeText(list, "def");
ok("꺼진 칩 → 켜기만(쌍둥이 없음)", r.state === "off" && r.list.length === 4 && r.list[1].on === true && r.msg.includes("켰습니다"), r);
r = addExcludeText(list, "abc");
ok("켜진 칩 → 그대로 + 「이미」", r.state === "on" && r.list === list && r.msg.includes("이미"), r);
r = addExcludeText(full, "new");
ok("가득 → 그대로 + 이유", r.state === "full" && r.list === full && r.msg.includes(`${MAX_EXCLUDE}개까지`), r);

// --- the menu item ---
ok("메뉴: 됨", eq(excludeMenuState(list, { pattern: "zzz", problem: "" }), { ok: true, why: "" }));
ok("메뉴: 꺼진 칩이면 됨(켜기)", excludeMenuState(list, { pattern: "def", problem: "" }).ok);
ok("메뉴: 이미 켜짐 → 꺼짐 + 이유", !excludeMenuState(list, { pattern: "abc", problem: "" }).ok && excludeMenuState(list, { pattern: "abc", problem: "" }).why.includes("이미"));
ok("메뉴: 가득 → 꺼짐 + 이유", excludeMenuState(full, { pattern: "x", problem: "" }).why.includes("지우세요"));
ok("메뉴: 선택 문제 → 그 이유", eq(excludeMenuState(list, excludeTarget("a\nb")), { ok: false, why: excludeTarget("a\nb").problem }));

// --- the text in the menu ---
ok("짧으면 그대로", menuText("abc") === "abc");
ok(`${MENU_TEXT}자 넘으면 자르고 …`, menuText("x".repeat(MENU_TEXT + 5)) === "x".repeat(MENU_TEXT) + "…");
ok("자를 때 글자(서로게이트) 안 깨짐", menuText("😀".repeat(MENU_TEXT + 1)) === "😀".repeat(MENU_TEXT) + "…");

console.log(`exclude-ctx-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
