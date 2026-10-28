// Unit tests of the whole-file total (wholeBudget.ts): six real 300MB logs
// opened whole killed the window on the test PC (10-28, realtest-progress.md).
//   node tests/run-unit.cjs
import { budgetAsks, budgetText, BUDGET_SMALL, WHOLE_BUDGET, wholeBudget, wholeWaitText } from "../src/wholeBudget";

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

console.log(`wholebudget-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
