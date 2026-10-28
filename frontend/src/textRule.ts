import { stripAnsi, type LogRule, type RuleKind } from "./logHighlight";
import { COMMON, setTagRules, type TagStore } from "./logTags";

// 「이 글자로 로그 색 규칙 만들기…」 (plan 2절 마지막 줄): the editor's selected
// text becomes a rule of a tag. The logic without React (RuleFromText.tsx is
// the small window).

export const MAX_RULE_TEXT = 1000; // the import limit for a pattern (logTagsIO IMPORT_LIMITS)

// The pattern a selection gives, or why it cannot be one. Surrounding spaces
// are dropped (a drag usually catches one); ANSI colour codes inside are taken
// out (rules are matched on the line without them — logHighlight paintLine).
export function selectionForRule(sel: string): { pattern: string; problem: string } {
  if (!sel) return { pattern: "", problem: "글자를 먼저 고르세요" };
  if (/[\r\n]/.test(sel.replace(/^[\r\n]+|[\r\n]+$/g, ""))) return { pattern: "", problem: "여러 줄은 규칙으로 만들 수 없습니다 — 한 줄 안의 글자를 고르세요" };
  const a = stripAnsi(sel);
  const pattern = (a ? a.text : sel).trim();
  if (!pattern) return { pattern: "", problem: "공백뿐인 글자는 규칙으로 만들 수 없습니다" };
  if ([...pattern].length > MAX_RULE_TEXT) return { pattern: "", problem: `${MAX_RULE_TEXT}자보다 긴 글자는 규칙으로 만들 수 없습니다` };
  return { pattern, problem: "" };
}

// The tag a new rule goes to by default: the first tag put on this file (not
// common), else common. `applied` = tagsFor(...).names (common first).
export function defaultRuleTag(applied: string[]): string {
  return applied.find((n) => n !== COMMON) ?? COMMON;
}

export interface TextRuleDraft {
  pattern: string;
  kind: RuleKind;
  caseSensitive: boolean;
  color: string;
  line: boolean;
  label: string;
}

const ruleId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// The rule of `tag` that already matches what the draft would (same kind,
// pattern and case), or undefined.
export function sameRuleIn(store: TagStore, tag: string, d: Pick<TextRuleDraft, "kind" | "pattern" | "caseSensitive">): LogRule | undefined {
  const t = store.tags.find((x) => x.name === tag);
  return t?.rules.find((r) => r.kind === d.kind && r.pattern === d.pattern && r.caseSensitive === d.caseSensitive);
}

// Adds the rule at the end of the tag (a rule added below wins the colour —
// logHighlight's priority notes), or, when the tag has the same rule already,
// changes that one's colour and line background (and switches it on) instead
// of making a twin. New rules have 「줄만」 on, like ＋ 규칙 추가 in the tag window.
export function addTextRule(
  store: TagStore,
  tag: string,
  d: TextRuleDraft,
  now = new Date().toISOString()
): { store: TagStore; rule: LogRule; updated: boolean } | null {
  const t = store.tags.find((x) => x.name === tag);
  if (!t || !d.pattern) return null;
  const old = sameRuleIn(store, tag, d);
  if (old) {
    const rule: LogRule = { ...old, on: true, color: d.color, line: d.line, label: d.label || old.label };
    return { store: setTagRules(store, tag, t.rules.map((r) => (r === old ? rule : r)), now), rule, updated: true };
  }
  const rule: LogRule = {
    id: ruleId(),
    on: true,
    label: d.label,
    pattern: d.pattern,
    kind: d.kind,
    caseSensitive: d.caseSensitive,
    color: d.color,
    line: d.line,
    filter: true,
  };
  return { store: setTagRules(store, tag, [...t.rules, rule], now), rule, updated: false };
}
