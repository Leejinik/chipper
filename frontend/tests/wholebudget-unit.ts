// Unit tests of the whole-file total (wholeBudget.ts): six real 300MB logs
// opened whole killed the window on the test PC (10-28, realtest-progress.md).
//   node tests/run-unit.cjs
import { budgetAsks, budgetText, BUDGET_SMALL, editAskText, editBudgetWhy, heapWhyOf, WHOLE_BUDGET, wholeBudget, wholeWaitText } from "../src/wholeBudget";
import { jsHeap, memLevel } from "../src/MemBar";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  }
}
const MB = 1 << 20;
const f = (mb: number, whole = true) => ({ size: Math.round(mb * MB), whole });
const fmt = (n: number) => (n / MB).toFixed(1) + "MB";

// six 300MB logs at once: over (1.8GB)
let r = wholeBudget(0, [f(300), f(300), f(300), f(300.3), f(289.8), f(300)]);
ok("six 300MB → over", r.over && r.counted === 6, r);
// two 300MB (600MB): fine; a third with two held: over
ok("two 300MB → fine", !wholeBudget(0, [f(300), f(300)]).over);
ok("third with 600MB held → over", wholeBudget(600 * MB, [f(300)]).over);
ok("168MB with 600MB held → fine (768 exactly)", !wholeBudget(600 * MB, [f(168)]).over);
ok("169MB with 600MB held → over", wholeBudget(600 * MB, [f(169)]).over);
// files that are never read whole (.gz, over the open limit) do not count
r = wholeBudget(700 * MB, [f(500, false), f(1)]);
ok("not-whole files and small ones don't count", !r.over && r.adding === 0 && r.counted === 0, r);
// small files never make it ask, even far over
ok("small file with a lot held → not over", !wholeBudget(5000 * MB, [f(31)]).over);
ok("BUDGET_SMALL file with a lot held → over", wholeBudget(WHOLE_BUDGET, [{ size: BUDGET_SMALL, whole: true }]).over);
// held alone over the total, nothing new that counts → no question
ok("held over, only a memo → not over", !wholeBudget(2000 * MB, [f(0.01)]).over);
// which files get asked
ok("budgetAsks: over + big whole", budgetAsks(true, f(40)));
ok("budgetAsks: not over", !budgetAsks(false, f(300)));
ok("budgetAsks: small", !budgetAsks(true, f(10)));
ok("budgetAsks: .gz", !budgetAsks(true, f(300, false)));
// the words: held / none held, one / several, what to do
let t = budgetText(600 * MB, 300 * MB, true, fmt);
ok("text held one", t.includes("이미 600.0MB") && t.includes("이 파일(300.0MB)") && t.includes("900.0MB") && t.includes("768.0MB") && t.includes("다른 큰 탭을 닫으세요"), t);
t = budgetText(0, 1800 * MB, false, fmt);
ok("text none held several", t.startsWith("이 파일들을 모두 전체로 열면 합계 1800.0MB") && t.includes("한 번에 여는 파일을 줄이세요") && !t.includes("닫으세요"), t);

// the wait, said in the question (300MB took 45s on the test PC)
t = wholeWaitText(300 * MB);
ok("wait 300MB ≈ 45초", t.includes("약 45초") && t.includes("멈춘 것처럼"), t);
ok("wait 600MB ≈ 90초", wholeWaitText(600 * MB).includes("약 90초"));
ok("wait tiny ≥ 1초", wholeWaitText(1000).includes("약 1초"));

// 「✏️ 편집으로 열기」 (readview): the same total, W counted from its start
{
  const MB = 1 << 20;
  const f = (n: number) => (n / MB).toFixed(1) + "MB";
  ok("편집: 300 + 300 = 600MB 허용", editBudgetWhy(300 * MB, 300 * MB, f) === "");
  ok("편집: 정확히 768MB 허용", editBudgetWhy(468 * MB, 300 * MB, f) === "");
  const why = editBudgetWhy(600 * MB, 300 * MB, f);
  ok("편집: 600 + 300 → 막힘 + 이유(합계·한도·지금)", why.includes("900.0MB") && why.includes("768.0MB") && why.includes("지금 600.0MB"), why);
  ok("편집: 1바이트 넘음 → 막힘", editBudgetWhy(WHOLE_BUDGET - 300 * MB + 1, 300 * MB, f) !== "");
  // agy F-12: a few bytes over must not read 「768.0MB 가 되어 768.0MB 를 넘습니다」
  const one = editBudgetWhy(WHOLE_BUDGET - 300 * MB + 1, 300 * MB, f);
  ok("편집: 1바이트 넘음 → 문구가 바이트로(모순 없음)", !one.includes("768.0MB 가 되어 768.0MB") && one.includes("805,306,369 바이트") && one.includes("805,306,368 바이트"), one);
  const t = editAskText(300 * MB, 300 * MB, f);
  ok("확인 창: 시간·멈춤·메모리·한도(지금·합계)·저장·읽기 권함", /약 30초/.test(t) && t.includes("응답하지 않") && /약 1\.0GB/.test(t) && t.includes("768.0MB") && t.includes("지금 300.0MB") && t.includes("600.0MB") && t.includes("저장도 오래") && t.includes("📖 읽기 보기"), t);
}

// the window's JS memory (heapWhyOf): no performance.memory (macOS / Linux webviews) → the budget only
{
  const MB = 1 << 20;
  const GB = 1 << 30;
  const f = (n: number) => (n / MB).toFixed(1) + "MB";
  ok("힙 값 없음(null) → 막지 않음(예산만)", heapWhyOf(null, 99 * MB, f) === "");
  ok("힙 한계 0·NaN → 막지 않음", heapWhyOf({ used: 1, limit: 0 }, 99 * MB, f) === "" && heapWhyOf({ used: 1, limit: NaN }, 99 * MB, f) === "");
  ok("힙 1.0/4.1GB + 99MB → 됨", heapWhyOf({ used: 1 * GB, limit: 4.1 * GB }, 99 * MB, f) === "");
  ok("힙 3.2/4.1GB(80% 아래) → 됨", heapWhyOf({ used: 3.2 * GB, limit: 4.1 * GB }, 99 * MB, f) === "");
  const w = heapWhyOf({ used: 3.4 * GB, limit: 4.1 * GB }, 99 * MB, f);
  ok("힙 3.4/4.1GB(80% 넘음) → 막힘 + 「화면 메모리」", w.includes("화면 메모리"), w);
  // node has performance but no performance.memory: like WKWebView / WebKitGTK
  ok("performance.memory 없음 → jsHeap() null", jsHeap() === null);
  ok("🧠 수준: 값 없음(0) → 표시 그대로", memLevel(0) === "");
}

console.log(`wholebudget-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
