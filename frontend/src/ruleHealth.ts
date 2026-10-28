// Rules that were slow in this run of the app, for the tag window (1단계 재작업
// 판정 ③: 「느린 규칙」 also in the tag window, not only in 「줄만」).
//
// Two kinds of trouble, both known only once the rule has run on real text:
//  - "editor": the editor's colouring gave up on the rule (more than 60ms in one
//    pass, logHighlight.ts RULE_BUDGET_MS) and switched it off for that rule set
//    (until the tags change or the app restarts) — those matches were NOT coloured;
//  - "filter": the Go line filter had to fall back to its slow matcher for the
//    rule (its DFA grew too big, Progress.slowRules) — same result, slower.
// Keyed by what the rule matches (logHighlight.ruleKey: kind, case, pattern),
// so editing the pattern drops the note (the new pattern has not run yet).
// Kept in memory only: a slow rule shows again the next time it runs.

export type RuleTrouble = "editor" | "filter";

const seen = new Map<string, Set<RuleTrouble>>();
const listeners = new Set<() => void>();
let version = 0;

export function noteRuleTrouble(key: string, kind: RuleTrouble): void {
  let s = seen.get(key);
  if (!s) seen.set(key, (s = new Set()));
  if (s.has(kind)) return;
  s.add(kind);
  version++;
  // after the current render / paint pass
  setTimeout(() => listeners.forEach((f) => f()), 0);
}

export function ruleTrouble(key: string): RuleTrouble[] {
  const s = seen.get(key);
  return s ? [...s].sort() : [];
}

export const ruleTroubleVersion = () => version;

export function onRuleTrouble(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

// For tests.
export function clearRuleTrouble(): void {
  seen.clear();
  version++;
}

// The words shown next to a rule (Korean), "" = nothing known.
export function troubleText(kinds: RuleTrouble[]): string {
  const out: string[] = [];
  if (kinds.includes("editor"))
    out.push("이번 실행에서 편집기 색칠이 너무 느려 이 규칙을 끈 적이 있습니다 — 그 화면에서는 이 규칙의 색이 빠졌습니다. 규칙을 단순하게 고치세요");
  if (kinds.includes("filter"))
    out.push("줄만 보기에서 느린 방식으로 걸렀습니다 (결과는 같음) — 정규식을 단순하게 하면 빨라집니다");
  return out.join(" / ");
}
