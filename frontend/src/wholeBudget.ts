// How much text the window may hold read whole (the editor), all tabs together.
//
// On the test PC (.18, 10-28, six real 300MB collector logs) a 300MB log read
// whole took about 1GB of the window's JS memory (3.3 bytes a byte); with six
// of them opened whole at once the window died (white) while reading the 4th
// (3.7GB). Past this total a file is not offered 「전체 열기」: 「🏷 태그 줄만」
// (reads nothing into the window) or nothing. Files under BUDGET_SMALL never
// make it ask (a memo next to big logs).
export const WHOLE_BUDGET = 768 << 20;
export const BUDGET_SMALL = 32 << 20;

export interface BudgetFile {
  size: number;
  whole: boolean; // it would be read whole (not .gz, not over the open limit)
}

// Would reading `files` whole, on top of `held` (text the tabs hold, plus files
// being read), go over WHOLE_BUDGET? `adding` = the sizes that count.
export function wholeBudget(held: number, files: BudgetFile[]): { over: boolean; adding: number; counted: number } {
  const counted = files.filter((f) => f.whole && f.size >= BUDGET_SMALL);
  const adding = counted.reduce((a, f) => a + f.size, 0);
  return { over: counted.length > 0 && held + adding > WHOLE_BUDGET, adding, counted: counted.length };
}

// Does this file make the question come up because of the budget?
export const budgetAsks = (over: boolean, f: BudgetFile) => over && f.whole && f.size >= BUDGET_SMALL;

export function budgetText(held: number, adding: number, one: boolean, fmt: (n: number) => string): string {
  return (
    (held > 0
      ? `전체로 열었거나 여는 중인 파일이 이미 ${fmt(held)} 있어, ${one ? "이 파일" : "이 파일들"}(${fmt(adding)})까지 전체로 열면 합계 ${fmt(held + adding)} 입니다.`
      : `${one ? "이 파일을" : "이 파일들을 모두"} 전체로 열면 합계 ${fmt(adding)} 입니다.`) +
    `\n한 창에서 전체로 열 수 있는 것은 모두 합쳐 ${fmt(WHOLE_BUDGET)} 까지입니다 — 더 열면 메모리가 모자라 앱이 멈춥니다(300MB 하나에 약 1GB).` +
    "\n「🏷 태그 줄만」은 파일을 읽어 들이지 않아 바로 볼 수 있습니다." +
    (held > 0 ? " 전체로 보려면 전체로 연 다른 큰 탭을 닫으세요." : " 전체로 보려면 한 번에 여는 파일을 줄이세요.")
  );
}

// Reading a file whole, the window takes the whole text in one message: on the
// test PC a 300MB log took 45s, 33s of it with the window not answering at all
// (10-28, realtest 6회차). Said in the question so the wait is not taken for a hang.
export const WHOLE_SEC_PER_MB = 0.15;
export function wholeWaitText(bytes: number): string {
  const s = Math.max(1, Math.round((bytes / (1 << 20)) * WHOLE_SEC_PER_MB));
  return `전체로 열면 다 읽을 때까지 창이 멈춘 것처럼 보입니다(약 ${s}초 — 100MB 에 15초쯤). 그동안 누른 것은 다 읽은 뒤에 처리됩니다.`;
}
