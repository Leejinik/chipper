import { RULE_KINDS, ruleProblem, type LogRule, type RuleKind } from "./logHighlight";
import { COMMON, addTag, setTagRules, tagNameProblem, type TagStore } from "./logTags";

// Sharing tags between people: export some tags to a <name>.chipper-tags.json
// file, import such files (Go: tags_io.go reads the envelope, this file checks
// every rule and resolves name clashes).
//
//   { "format": "chipper-tags", "version": 1, "exported": "<ISO time>",
//     "tags": [ { "name": "collector",
//                 "rules": [ { "on": true, "label": "", "pattern": "kafka rebalance", "kind": "text",
//                              "caseSensitive": false, "color": "#c678dd", "line": false, "filter": true } ] } ] }
//
// No rule ids, no `updated`, no assignments (where a tag is attached is each
// person's own folder layout). Every rule field but `pattern` may be left out.

export const EXPORT_FORMAT = "chipper-tags";
export const EXPORT_VERSION = 1;
export const EXPORT_EXT = ".chipper-tags.json";

// --- export --------------------------------------------------------------------

const exportRule = (r: LogRule) => ({
  on: r.on,
  label: r.label,
  pattern: r.pattern,
  kind: r.kind,
  caseSensitive: r.caseSensitive,
  color: r.color,
  line: r.line,
  filter: r.filter,
});

// The export file text for `names` (in the store's order; unknown names skipped).
export function exportPayload(store: TagStore, names: string[], now = new Date().toISOString()): string {
  const want = new Set(names);
  const tags = store.tags.filter((t) => want.has(t.name)).map((t) => ({ name: t.name, rules: t.rules.map(exportRule) }));
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exported: now, tags }, null, 2) + "\n";
}

// A file name from what the user typed (or the one tag's name): characters
// Windows refuses in file names become "_". "" when there is nothing to use.
export function exportFileName(typed: string): string {
  let base = typed
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (base.toLowerCase().endsWith(EXPORT_EXT)) base = base.slice(0, -EXPORT_EXT.length);
  else if (base.toLowerCase().endsWith(".json")) base = base.slice(0, -5);
  return base ? base + EXPORT_EXT : "";
}

// --- checking imported rules ---------------------------------------------------

const DEFAULT_COLOR = "#c678dd";
const MAX_PATTERN = 10000;
const clip = (s: string, n = 40) => ([...s].length > n ? [...s].slice(0, n).join("") + "…" : s);

// The one place an imported tag name is checked — the same rule as tag names
// in tags.json. MERGE NOTE: when stage 3's name normalization (NFC; zero-width,
// bidi control and BOM characters refused) lands, call it here and use the
// normalized name.
export function importTagName(name: string): { name: string; problem: string } {
  return { name, problem: tagNameProblem(name, []) };
}

// The one place an imported rule's pattern is judged usable. MERGE NOTE: when
// stage 3's RE2-based check lands (look-around, back references … refused),
// call it here instead of the heuristic.
export function importRuleProblem(r: LogRule): string {
  const p = ruleProblem(r);
  if (p === "slow") return "화면을 멈출 수 있는 정규식(반복이 겹침)";
  if (p === "invalid") return r.kind === "regex" ? "잘못된 정규식" : "쓸 수 없는 패턴";
  return "";
}

let idSeq = 0;
const newRuleId = () => "i" + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);

// One rule from an import file, checked: a usable LogRule, or why not.
// pattern is required; kind defaults to "text" (an old-style `regex: bool`
// is understood); colour #rgb or #rrggbb; booleans default on/off as for a
// new rule; unknown fields are ignored.
export function importRule(x: unknown, newId: () => string = newRuleId): { rule: LogRule } | { problem: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { problem: "규칙이 { } 형식이 아님" };
  const o = x as Record<string, unknown>;
  if (typeof o.pattern !== "string") return { problem: "패턴(pattern)이 없거나 글자가 아님" };
  if (!o.pattern) return { problem: "패턴이 비어 있음" };
  if (o.pattern.length > MAX_PATTERN) return { problem: `패턴이 너무 김(${MAX_PATTERN}자 넘음)` };
  let kind: RuleKind;
  if (o.kind !== undefined) {
    if (!RULE_KINDS.includes(o.kind as RuleKind)) return { problem: `모르는 종류 「${clip(String(o.kind), 20)}」(text·word·regex 중 하나)` };
    kind = o.kind as RuleKind;
  } else kind = typeof o.regex === "boolean" ? (o.regex ? "regex" : "word") : "text";
  let color = DEFAULT_COLOR;
  if (o.color !== undefined) {
    const c = typeof o.color === "string" ? o.color.trim() : "";
    if (/^#[0-9a-f]{6}$/i.test(c)) color = c.toLowerCase();
    else if (/^#[0-9a-f]{3}$/i.test(c)) color = "#" + [...c.slice(1).toLowerCase()].map((h) => h + h).join("");
    else return { problem: `잘못된 색 「${clip(String(o.color), 20)}」(#rrggbb 형식이어야 함)` };
  }
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const rule: LogRule = {
    id: newId(),
    on: bool(o.on, true),
    label: typeof o.label === "string" ? o.label : "",
    pattern: o.pattern,
    kind,
    caseSensitive: bool(o.caseSensitive, false),
    color,
    line: bool(o.line, false),
    filter: bool(o.filter, true),
  };
  const p = importRuleProblem(rule);
  return p ? { problem: p } : { rule };
}

// "The same content": the rules' kind, pattern, caseSensitive, color, line,
// filter and on, in order. ids, labels and `updated` don't count.
export function sameRules(a: LogRule[], b: LogRule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.kind === y.kind &&
      x.pattern === y.pattern &&
      x.caseSensitive === y.caseSensitive &&
      x.color.toLowerCase() === y.color.toLowerCase() &&
      x.line === y.line &&
      x.filter === y.filter &&
      x.on === y.on
    );
  });
}

// "collector (2)", "collector (3)", … not in `taken`, kept within the
// 100-character name limit.
export function renamedTagName(base: string, taken: string[]): string {
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const chars = [...base];
    const room = 100 - suffix.length;
    const n = (chars.length > room ? chars.slice(0, room).join("").trimEnd() : base) + suffix;
    if (!taken.includes(n)) return n;
  }
}

// --- import --------------------------------------------------------------------

// What Go's ImportTagsDialog / ImportTagsFiles return per file (tags_io.go).
export interface ImportFile {
  path: string;
  file: string;
  error: string;
  tags: { name: string; rules: unknown[] }[] | null;
  problems: string[] | null;
  tagsJson?: boolean;
}

export type ImportChoice = "overwrite" | "skip" | "rename";

export interface ImportConflict {
  name: string;
  file: string; // file it comes from
  isCommon: boolean;
  mine: number; // rule counts
  theirs: number;
  renameTo: string; // what 「다른 이름으로」 would call it
  left: number; // further clashes after this one (for 「나머지도 모두 같게」)
}

// null = stop the import (nothing is changed).
export type AskConflict = (c: ImportConflict) => Promise<{ choice: ImportChoice; all: boolean } | null>;

export interface ImportSummary {
  canceled: boolean;
  added: string[];
  overwritten: string[];
  same: string[]; // skipped: same content
  skipped: string[]; // skipped: chosen
  renamed: { from: string; to: string }[];
  badRules: string[]; // rules left out, with why
  notImported: string[]; // files / tags that were refused as a whole, with why
}

interface Pending {
  name: string;
  file: string;
  rules: LogRule[];
}

// Imports `files` into `store`. Clashes (same name, case included, different
// content) are put to `ask` one at a time; 「나머지도 모두 같게」 answers the
// rest. Returns the new store (=== store when nothing changed) and what
// happened. The store is only built up here — the caller applies it at once,
// so one save (and one .bak) covers the whole import.
export async function runImport(
  store: TagStore,
  files: ImportFile[],
  ask: AskConflict,
  now = new Date().toISOString(),
  newId: () => string = newRuleId
): Promise<{ store: TagStore; summary: ImportSummary }> {
  const sum: ImportSummary = { canceled: false, added: [], overwritten: [], same: [], skipped: [], renamed: [], badRules: [], notImported: [] };
  const queue: Pending[] = [];
  for (const f of files) {
    const fname = f.file || f.path.split(/[\\/]/).pop() || f.path;
    if (f.error) {
      sum.notImported.push(`${fname}: ${f.error}`);
      continue;
    }
    for (const p of f.problems ?? []) sum.notImported.push(`${fname}: ${p}`);
    for (const t of f.tags ?? []) {
      const nm = importTagName(typeof t?.name === "string" ? t.name : "");
      if (nm.problem) {
        sum.notImported.push(`${fname}: 태그 「${clip(String(t?.name ?? ""))}」 ${nm.problem}`);
        continue;
      }
      const raw = Array.isArray(t.rules) ? t.rules : [];
      const rules: LogRule[] = [];
      raw.forEach((x, i) => {
        const r = importRule(x, newId);
        if ("rule" in r) rules.push(r.rule);
        else {
          const pat = x && typeof x === "object" && typeof (x as any).pattern === "string" ? ` 「${clip((x as any).pattern)}」` : "";
          sum.badRules.push(`${fname} · ${nm.name} · ${i + 1}번째 규칙${pat}: ${r.problem}`);
        }
      });
      if (raw.length && !rules.length) {
        sum.notImported.push(`${fname}: 태그 「${clip(nm.name)}」 는 규칙이 모두 잘못돼 가져오지 않았습니다`);
        continue;
      }
      queue.push({ name: nm.name, file: fname, rules });
    }
  }

  let s = store;
  let sticky: ImportChoice | null = null;
  const clashes = (from: number) =>
    queue.slice(from).filter((p) => {
      const mine = s.tags.find((t) => t.name === p.name);
      return mine && !sameRules(mine.rules, p.rules);
    }).length;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const mine = s.tags.find((t) => t.name === p.name); // exact name: collector ≠ Collector
    if (!mine) {
      s = addTag(s, p.name, p.rules, now);
      sum.added.push(p.name);
      continue;
    }
    if (sameRules(mine.rules, p.rules)) {
      sum.same.push(p.name);
      continue;
    }
    const renameTo = renamedTagName(p.name, s.tags.map((t) => t.name));
    let choice = sticky;
    if (!choice) {
      const a = await ask({
        name: p.name,
        file: p.file,
        isCommon: p.name === COMMON,
        mine: mine.rules.length,
        theirs: p.rules.length,
        renameTo,
        left: clashes(i + 1),
      });
      if (!a) return { store, summary: { ...sum, canceled: true } };
      choice = a.choice;
      if (a.all) sticky = a.choice;
    }
    if (choice === "overwrite") {
      s = setTagRules(s, p.name, p.rules, now);
      sum.overwritten.push(p.name);
    } else if (choice === "rename") {
      s = addTag(s, renameTo, p.rules, now);
      sum.renamed.push({ from: p.name, to: renameTo });
    } else sum.skipped.push(p.name);
  }
  return { store: s, summary: sum };
}

// "추가 2 · 덮어씀 1 · 건너뜀 3 · 이름 바꿔 추가 1 · 잘못된 규칙 2"
export function summaryLine(s: ImportSummary): string {
  const parts = [
    `추가 ${s.added.length}`,
    `덮어씀 ${s.overwritten.length}`,
    `건너뜀 ${s.same.length + s.skipped.length}`,
    `이름 바꿔 추가 ${s.renamed.length}`,
    `잘못된 규칙 ${s.badRules.length}`,
  ];
  if (s.notImported.length) parts.push(`가져오지 못함 ${s.notImported.length}`);
  return parts.join(" · ");
}

// The details under the summary line.
export function summaryDetails(s: ImportSummary): string[] {
  const q = (names: string[]) => names.map((n) => `「${n}」`).join(", ");
  const out: string[] = [];
  if (s.added.length) out.push(`추가: ${q(s.added)}`);
  if (s.overwritten.length) out.push(`덮어씀: ${q(s.overwritten)}`);
  if (s.same.length) out.push(`건너뜀(내 태그와 내용이 같음): ${q(s.same)}`);
  if (s.skipped.length) out.push(`건너뜀(고르신 대로): ${q(s.skipped)}`);
  if (s.renamed.length) out.push(`이름 바꿔 추가: ${s.renamed.map((r) => `「${r.from}」 → 「${r.to}」`).join(", ")}`);
  for (const b of s.badRules) out.push(`잘못된 규칙(뺌): ${b}`);
  for (const n of s.notImported) out.push(`가져오지 못함: ${n}`);
  return out;
}
