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

// 「✏️ 편집으로 열기」 of a big file read in 「📖 읽기 보기」 (readview): the text
// comes to the window in 4MB pieces (EditOpenChunk), the window answering
// between them; building the editor at the end stops it for a moment.
// .18 / headless measurements in readview-impl.md.
export const EDIT_SEC_PER_MB = 0.1;
export const EDIT_HEAP_PER_BYTE = 3.3; // window JS memory per byte held (300MB → ~1GB, realtest 10-28)

// Why a file of `size` cannot be opened for editing with `held` already held
// ("" = it can): the same total as 「전체 열기」 (WHOLE_BUDGET).
export function editBudgetWhy(held: number, size: number, fmt: (n: number) => string): string {
  if (held + size <= WHOLE_BUDGET) return "";
  // a few bytes over reads 「768.0MB 가 되어 768.0MB 를 넘습니다」 in MB: say the bytes (agy F-12)
  const total = fmt(held + size) === fmt(WHOLE_BUDGET) ? `${(held + size).toLocaleString("en-US")} 바이트` : fmt(held + size);
  const limit = fmt(held + size) === fmt(WHOLE_BUDGET) ? `${fmt(WHOLE_BUDGET)}(${WHOLE_BUDGET.toLocaleString("en-US")} 바이트)` : fmt(WHOLE_BUDGET);
  return `편집으로 연 파일이 합쳐 ${total} 가 되어 ${limit} 를 넘습니다(지금 ${fmt(held)}) — 편집 중인 다른 큰 탭을 📖 읽기로 돌리거나 닫으세요`;
}

export function editAskText(size: number, held: number, fmt: (n: number) => string): string {
  const s = Math.max(1, Math.round((size / (1 << 20)) * EDIT_SEC_PER_MB));
  const gb = (size * EDIT_HEAP_PER_BYTE) / (1 << 30);
  return [
    `· 여는 데 약 ${s}초 걸립니다(크기로 추정). 그동안 이 탭은 보기를 바꿀 수 없고, 다른 탭의 「✏️ 편집으로 열기」도 기다립니다 — [취소]로 그만둘 수 있습니다. 끝에 편집기를 만드는 몇 초는 앱이 응답하지 않습니다.`,
    `· 화면 메모리를 약 ${gb < 0.1 ? "0.1" : gb.toFixed(1)}GB 씁니다(창 하나 한계 약 4GB).`,
    `· 편집으로 연 파일은 모두 합쳐 ${fmt(WHOLE_BUDGET)} 까지입니다 — 지금 ${fmt(held)}, 이 파일까지 ${fmt(held + size)}.`,
    "· 저장도 오래 걸립니다(300MB 에 수십 초, 그동안 다른 탭의 편집 열기는 막힘).",
    "· 보기·찾기·제외만 할 거면 📖 읽기 보기가 빠르고 가볍습니다.",
  ].join("\n");
}

// The window's JS memory has a hard ceiling (~4GB, then 「Out of Memory」). Text
// let go (✏️ → 📖, a closed tab) leaves the budget at once but the memory only
// when the engine collects it, and it collects late: on the test PC (.18 10-29)
// with 99MB×7 held and three 300MB 📖 panes in use the heap went 2.3 → 3.8GB in
// four ✏️ ↔ 📖 rounds without a collection and the fifth read killed the window
// (with the pieces kept unjoined it collected at 3.7GB in a lighter run). So no
// new read into the editor while the heap is over HEAP_MAX of its limit (≈3.3GB);
// what is already open stays. Letting text go does not bring the heap down (.18:
// 60s idle, a tab to 📖, two tabs closed — 3.43GB all along); only reopening the
// app does, and the message says so. heap null (no performance.memory: macOS WKWebView,
// Linux WebKitGTK) = only the budget counts.
export const HEAP_MAX = 0.8;
export function heapWhyOf(heap: { used: number; limit: number } | null, size: number, fmt: (n: number) => string): string {
  if (!heap || !(heap.limit > 0) || size <= 0 || heap.used <= heap.limit * HEAP_MAX) return "";
  return `화면 메모리가 ${fmt(heap.used)} / 약 ${fmt(heap.limit)} 로 한계에 가까워 새로 편집기로 읽어 들이지 않습니다 — 이미 연 편집은 그대로 쓸 수 있습니다. 내려놓은 글자는 창이 스스로 치울 때까지 메모리에 남아 있어(몇 분이 지나도 안 치울 수 있음), 계속 꺼져 있으면 고친 것을 저장하고 앱을 다시 여세요 — 다시 열면 화면 메모리가 비워집니다`;
}
