import { RULE_KINDS, ruleCheck, type LogRule, type RuleKind } from "./logHighlight";
import {
  COMMON,
  assignKey,
  hiddenCharProblem,
  normalizeTagName,
  tagNameProblem,
  uniqueTagName,
  type Tag,
  type TagAssign,
  type TagStore,
} from "./logTags";

// Sharing tags between people: export some tags to a <name>.chipper-tags.json
// file, import such files (Go: tags_io.go reads the envelope, this file checks
// every rule and resolves name clashes).
//
//   { "format": "chipper-tags", "version": 1, "exported": "<ISO time>",
//     "tags": [ { "name": "collector",
//                 "rules": [ { "id": "k1", "on": true, "label": "", "pattern": "kafka rebalance", "kind": "text",
//                              "caseSensitive": false, "color": "#c678dd", "line": false, "filter": true } ] } ],
//     "assign": { "dir": { "modules/lizcollector": ["collector"] }, "file": {}, "name": {} } }
//
// No `updated`. `assign` only when the sender ticks 「붙인 곳도 같이」, and then
// only the places of the exported tags (other tags' names left out). Every
// rule field but `pattern` may be left out.

export const EXPORT_FORMAT = "chipper-tags";
export const EXPORT_VERSION = 1;
export const EXPORT_EXT = ".chipper-tags.json";

// Import limits (product rule, the same in Go: tags_io.go maxImport*). A file
// beyond any of them is refused as a whole, with why.
export const IMPORT_LIMITS = { fileMB: 4, tags: 1000, rulesPerTag: 2000, pattern: 1000, label: 100 } as const;

const chars = (s: string) => [...s].length; // code points, like Go's RuneCount
const clip = (s: string, n = 40) => (chars(s) > n ? [...s].slice(0, n).join("") + "…" : s);

// --- export --------------------------------------------------------------------

const exportRule = (r: LogRule) => ({
  id: r.id,
  on: r.on,
  label: r.label,
  pattern: r.pattern,
  kind: r.kind,
  caseSensitive: r.caseSensitive,
  color: r.color,
  line: r.line,
  filter: r.filter,
});

// The places of `names` in the store: only entries holding one of them, each
// with just those names ("modules/both": ["collector", "admin"] exported for
// collector alone → ["collector"]). Entries with no tags ([]) are not places.
export function exportAssign(store: TagStore, names: string[]): TagAssign {
  const want = new Set(names);
  const pick = (m: Record<string, string[]>) => {
    const o: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(m)) {
      const keep = v.filter((n) => want.has(n));
      if (keep.length) o[k] = keep;
    }
    return o;
  };
  return { dir: pick(store.assign.dir), file: pick(store.assign.file), name: pick(store.assign.name) };
}

export const placeCount = (a: TagAssign) => Object.keys(a.dir).length + Object.keys(a.file).length + Object.keys(a.name).length;

// The export file text for `names` (in the store's order; unknown names
// skipped); with `withAssign`, also where they are attached.
export function exportPayload(store: TagStore, names: string[], now = new Date().toISOString(), withAssign = false): string {
  const want = new Set(names);
  const tags = store.tags.filter((t) => want.has(t.name)).map((t) => ({ name: t.name, rules: t.rules.map(exportRule) }));
  const out: Record<string, unknown> = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported: now, tags };
  if (withAssign) out.assign = exportAssign(store, tags.map((t) => t.name));
  return JSON.stringify(out, null, 2) + "\n";
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
  base = base.replace(/[. ]+$/, "");
  return base ? base + EXPORT_EXT : "";
}

// --- checking imported rules ---------------------------------------------------

const DEFAULT_COLOR = "#c678dd";

// Why a file's tags break the import limits ("" = they don't). Checked on
// every tag, also ones left out later for their name. Same words as Go.
export function importLimitProblem(tags: { name?: unknown; rules?: unknown }[]): string {
  const L = IMPORT_LIMITS;
  if (tags.length > L.tags) return `태그가 너무 많습니다 (${tags.length}개, 한 파일에 ${L.tags}개까지) — 이 파일은 가져오지 않습니다`;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const who = typeof t?.name === "string" ? `태그 「${clip(t.name, 60)}」` : `${i + 1}번째 태그`;
    const rules = Array.isArray(t?.rules) ? t.rules : [];
    if (rules.length > L.rulesPerTag)
      return `${who} 의 규칙이 너무 많습니다 (${rules.length}개, 태그 하나에 ${L.rulesPerTag}개까지) — 이 파일은 가져오지 않습니다`;
    for (let j = 0; j < rules.length; j++) {
      const r = rules[j] as { pattern?: unknown; label?: unknown } | null;
      if (!r || typeof r !== "object") continue;
      if (typeof r.pattern === "string" && chars(r.pattern) > L.pattern)
        return `${who} 의 ${j + 1}번째 규칙: 패턴이 너무 깁니다 (${chars(r.pattern)}자, ${L.pattern}자까지) — 이 파일은 가져오지 않습니다`;
      if (typeof r.label === "string" && chars(r.label) > L.label)
        return `${who} 의 ${j + 1}번째 규칙: 이름표가 너무 깁니다 (${chars(r.label)}자, ${L.label}자까지) — 이 파일은 가져오지 않습니다`;
    }
  }
  return "";
}

// The one place an imported tag name is checked — the same rule as tag names
// in tags.json (logTags.ts: NFC first, then tagNameProblem refuses zero-width,
// bidi control and BOM characters …). Returns the normalized name.
export function importTagName(name: string): { name: string; problem: string } {
  const n = normalizeTagName(name);
  return { name: n, problem: tagNameProblem(n, []) };
}

// The one place an imported rule's pattern is judged usable: ruleCheck
// (logHighlight.ts, RE2 — look-around, back references … refused, with the
// same words as the tag window).
export function importRuleProblem(r: LogRule): string {
  const c = ruleCheck(r);
  if (!c.problem) return "";
  return c.reason || (r.kind === "regex" ? "잘못된 정규식" : "쓸 수 없는 패턴");
}

let idSeq = 0;
const newRuleId = () => "i" + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
// An id from a file is kept when it is plain text (the defaults' "error",
// "warn" … survive a round trip); else the rule gets a new one.
const usableId = (v: unknown): v is string => typeof v === "string" && v !== "" && chars(v) <= 100 && !hiddenCharProblem(v) && v.trim() === v;

// One rule from an import file, checked: a usable LogRule, or why not.
// pattern is required; kind defaults to "text" (an old-style `regex: bool`
// is understood); colour #rgb or #rrggbb; booleans default on/off as for a
// new rule; the label is checked like a tag name's characters; unknown fields
// are ignored.
export function importRule(x: unknown, newId: () => string = newRuleId): { rule: LogRule } | { problem: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { problem: "규칙이 { } 형식이 아님" };
  const o = x as Record<string, unknown>;
  if (typeof o.pattern !== "string") return { problem: "패턴(pattern)이 없거나 글자가 아님" };
  if (!o.pattern) return { problem: "패턴이 비어 있음" };
  if (chars(o.pattern) > IMPORT_LIMITS.pattern) return { problem: `패턴이 너무 김(${IMPORT_LIMITS.pattern}자 넘음)` };
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
  const label = typeof o.label === "string" ? o.label : "";
  const hidden = hiddenCharProblem(label);
  if (hidden) return { problem: `이름표에 ${hidden}를 쓸 수 없음` };
  if (chars(label) > IMPORT_LIMITS.label) return { problem: `이름표가 너무 김(${IMPORT_LIMITS.label}자 넘음)` };
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const rule: LogRule = {
    id: usableId(o.id) ? o.id : newId(),
    on: bool(o.on, true),
    label,
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

// "The same content": the rules' label, kind, pattern, caseSensitive, color,
// line, filter and on, in order. ids and `updated` don't count.
const sameRule = (x: LogRule, y: LogRule) =>
  x.label === y.label &&
  x.kind === y.kind &&
  x.pattern === y.pattern &&
  x.caseSensitive === y.caseSensitive &&
  x.color.toLowerCase() === y.color.toLowerCase() &&
  x.line === y.line &&
  x.filter === y.filter &&
  x.on === y.on;

export function sameRules(a: LogRule[], b: LogRule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => sameRule(x, b[i]));
}

// --- what differs (for the clash question) -------------------------------------

export interface RuleDiff {
  added: string[]; // theirs only
  removed: string[]; // mine only
  changed: string[]; // in both, something differs: what
  reordered: boolean; // the rules in both come in another order
}

const KIND_WORD: Record<RuleKind, string> = { text: "글자 그대로", word: "단어", regex: "정규식" };
const onOff = (b: boolean) => (b ? "켬" : "끔");
const ruleName = (r: LogRule) => `「${clip(r.pattern)}」` + (r.label ? ` (${clip(r.label, 20)})` : "");

function changes(m: LogRule, t: LogRule): string[] {
  const out: string[] = [];
  if (m.pattern !== t.pattern) out.push(`패턴 「${clip(m.pattern)}」 → 「${clip(t.pattern)}」`);
  if (m.label !== t.label) out.push(`이름표 「${clip(m.label, 20)}」 → 「${clip(t.label, 20)}」`);
  if (m.kind !== t.kind) out.push(`종류 ${KIND_WORD[m.kind]} → ${KIND_WORD[t.kind]}`);
  if (m.caseSensitive !== t.caseSensitive) out.push(`대소문자 구분 ${onOff(m.caseSensitive)} → ${onOff(t.caseSensitive)}`);
  if (m.color.toLowerCase() !== t.color.toLowerCase()) out.push(`색 ${m.color.toLowerCase()} → ${t.color.toLowerCase()}`);
  if (m.line !== t.line) out.push(`줄 배경 ${onOff(m.line)} → ${onOff(t.line)}`);
  if (m.filter !== t.filter) out.push(`줄만 ${onOff(m.filter)} → ${onOff(t.filter)}`);
  if (m.on !== t.on) out.push(`켜짐 ${onOff(m.on)} → ${onOff(t.on)}`);
  return out;
}

// Rule by rule: rules are paired by id, then by (kind, pattern, case); what is
// left over was added (theirs) or removed (mine).
export function ruleDiff(mine: LogRule[], theirs: LogRule[]): RuleDiff {
  const pairT = new Array<number>(theirs.length).fill(-1); // theirs index → mine index
  const usedM = new Set<number>();
  const byId = new Map<string, number>();
  mine.forEach((r, i) => byId.has(r.id) || byId.set(r.id, i));
  theirs.forEach((t, ti) => {
    const mi = byId.get(t.id);
    if (mi !== undefined && !usedM.has(mi)) {
      pairT[ti] = mi;
      usedM.add(mi);
    }
  });
  const key = (r: LogRule) => `${r.kind}\u0000${r.caseSensitive}\u0000${r.pattern}`;
  const byKey = new Map<string, number[]>();
  mine.forEach((r, i) => usedM.has(i) || byKey.set(key(r), [...(byKey.get(key(r)) ?? []), i]));
  theirs.forEach((t, ti) => {
    if (pairT[ti] >= 0) return;
    const free = byKey.get(key(t))?.find((i) => !usedM.has(i));
    if (free !== undefined) {
      pairT[ti] = free;
      usedM.add(free);
    }
  });
  const d: RuleDiff = { added: [], removed: [], changed: [], reordered: false };
  let last = -1;
  theirs.forEach((t, ti) => {
    const mi = pairT[ti];
    if (mi < 0) {
      d.added.push(ruleName(t));
      return;
    }
    if (mi < last) d.reordered = true;
    last = mi;
    const c = changes(mine[mi], t);
    if (c.length) d.changed.push(`${ruleName(mine[mi])}: ${c.join(", ")}`);
  });
  mine.forEach((m, i) => usedM.has(i) || d.removed.push(ruleName(m)));
  return d;
}

// "collector (2)", "collector (3)", … not in `taken`, within the 100-character
// name limit — logTags.ts uniqueTagName (the one name maker).
export const renamedTagName = (base: string, taken: string[] | { has(name: string): boolean }) => uniqueTagName(base, taken);

// --- import --------------------------------------------------------------------

// What Go's ImportTagsDialog / ImportTagsFiles return per file (tags_io.go).
export interface ImportFile {
  path: string;
  file: string;
  error: string;
  tags: { name: string; rules: unknown[] }[] | null;
  problems: string[] | null;
  tagsJson?: boolean;
  assign?: { dir?: Record<string, unknown>; file?: Record<string, unknown>; name?: Record<string, unknown> } | null;
}

export type ImportChoice = "overwrite" | "skip" | "rename";

export interface ImportConflict {
  name: string;
  file: string; // file it comes from
  isCommon: boolean;
  mine: number; // rule counts
  theirs: number; // usable rules in the file
  dropped: number; // rules of this tag in the file left out as unusable
  diff: RuleDiff;
  mineFrom: string; // "" = the user's own tag; else the earlier file of this import it came from
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
  assignAdded: string[]; // places taken from the files ("📁 modules/lizcollector → collector")
  assignKept: string[]; // places the files named that already had my own assignment
}

interface Pending {
  name: string;
  file: string;
  fileIdx: number;
  rules: LogRule[];
  dropped: number;
}

const KIND_ICON = { dir: "📁", file: "📄", name: "🏷" } as const;
const placeText = (kind: keyof TagAssign, key: string) => `${KIND_ICON[kind]} ${kind === "dir" && key === "" ? "(서버 전체)" : key}`;

// Imports `files` into `store`. Clashes (same name, case included, different
// content) are put to `ask` one at a time; 「나머지도 모두 같게」 answers the
// rest. A file's places (assign) are taken where the user has no assignment of
// their own, under the names the tags ended up with (renamed ones followed,
// skipped ones left out). Returns the new store (=== store when nothing
// changed) and what happened. The store is only built up here — the caller
// applies it at once, so one save covers the whole import.
export async function runImport(
  store: TagStore,
  files: ImportFile[],
  ask: AskConflict,
  now = new Date().toISOString(),
  newId: () => string = newRuleId
): Promise<{ store: TagStore; summary: ImportSummary }> {
  const sum: ImportSummary = {
    canceled: false,
    added: [],
    overwritten: [],
    same: [],
    skipped: [],
    renamed: [],
    badRules: [],
    notImported: [],
    assignAdded: [],
    assignKept: [],
  };
  const queue: Pending[] = [];
  const usable: boolean[] = []; // per file: not refused as a whole
  files.forEach((f, fileIdx) => {
    const fname = f.file || f.path.split(/[\\/]/).pop() || f.path;
    usable.push(false);
    if (f.error) {
      sum.notImported.push(`${fname}: ${f.error}`);
      return;
    }
    const limit = importLimitProblem(f.tags ?? []);
    if (limit) {
      sum.notImported.push(`${fname}: ${limit}`);
      return;
    }
    usable[fileIdx] = true;
    for (const p of f.problems ?? []) sum.notImported.push(`${fname}: ${p}`);
    for (const t of f.tags ?? []) {
      const nm = importTagName(typeof t?.name === "string" ? t.name : "");
      if (nm.problem) {
        sum.notImported.push(`${fname}: 태그 「${clip(String(t?.name ?? ""))}」 ${nm.problem}`);
        continue;
      }
      const raw = Array.isArray(t.rules) ? t.rules : [];
      const rules: LogRule[] = [];
      const seenIds = new Set<string>();
      raw.forEach((x, i) => {
        const r = importRule(x, newId);
        if ("rule" in r) {
          if (seenIds.has(r.rule.id)) r.rule.id = newId(); // ids are unique within a tag
          seenIds.add(r.rule.id);
          rules.push(r.rule);
        } else {
          const pat = x && typeof x === "object" && typeof (x as any).pattern === "string" ? ` 「${clip((x as any).pattern)}」` : "";
          sum.badRules.push(`${fname} · ${nm.name} · ${i + 1}번째 규칙${pat}: ${r.problem}`);
        }
      });
      if (raw.length && !rules.length) {
        sum.notImported.push(`${fname}: 태그 「${clip(nm.name)}」 는 규칙이 모두 잘못돼 가져오지 않았습니다`);
        continue;
      }
      queue.push({ name: nm.name, file: fname, fileIdx, rules, dropped: raw.length - rules.length });
    }
  });

  // Working copy, built in place (no copying the whole list per tag).
  const tags: Tag[] = store.tags.slice();
  const at = new Map<string, number>(tags.map((t, i) => [t.name, i]));
  const cameFrom = new Map<string, string>(); // tag name → file it came from in this import
  const fate = files.map(() => new Map<string, string | null>()); // per file: name in file → name in store
  let changed = false;
  let sticky: ImportChoice | null = null;
  // Clashes still to come after item i: later items whose name exists (or will,
  // added by an earlier item of this import) with other content. Counted as if
  // the clashes were skipped.
  const leftAfter = (i: number) => {
    const virt = new Map<string, LogRule[]>();
    let n = 0;
    for (let j = i + 1; j < queue.length; j++) {
      const q = queue[j];
      const cur = virt.get(q.name) ?? (at.has(q.name) ? tags[at.get(q.name)!].rules : undefined);
      if (!cur) virt.set(q.name, q.rules);
      else if (!sameRules(cur, q.rules)) n++;
    }
    return n;
  };
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const idx = at.get(p.name); // exact name: collector ≠ Collector
    if (idx === undefined) {
      at.set(p.name, tags.length);
      tags.push({ name: p.name, rules: p.rules, updated: now });
      cameFrom.set(p.name, p.file);
      sum.added.push(p.name);
      fate[p.fileIdx].set(p.name, p.name);
      changed = true;
      continue;
    }
    const mine = tags[idx];
    if (sameRules(mine.rules, p.rules)) {
      sum.same.push(p.name);
      fate[p.fileIdx].set(p.name, p.name);
      continue;
    }
    const renameTo = renamedTagName(p.name, at);
    let choice = sticky;
    if (!choice) {
      const a = await ask({
        name: p.name,
        file: p.file,
        isCommon: p.name === COMMON,
        mine: mine.rules.length,
        theirs: p.rules.length,
        dropped: p.dropped,
        diff: ruleDiff(mine.rules, p.rules),
        mineFrom: cameFrom.get(p.name) ?? "",
        renameTo,
        left: leftAfter(i),
      });
      if (!a) return { store, summary: { ...sum, canceled: true } };
      choice = a.choice;
      if (a.all) sticky = a.choice;
    }
    if (choice === "overwrite") {
      tags[idx] = { ...mine, rules: p.rules, updated: now };
      cameFrom.set(p.name, p.file);
      sum.overwritten.push(p.name);
      fate[p.fileIdx].set(p.name, p.name);
      changed = true;
    } else if (choice === "rename") {
      at.set(renameTo, tags.length);
      tags.push({ name: renameTo, rules: p.rules, updated: now });
      cameFrom.set(renameTo, p.file);
      sum.renamed.push({ from: p.name, to: renameTo });
      fate[p.fileIdx].set(p.name, renameTo);
      changed = true;
    } else {
      sum.skipped.push(p.name);
      fate[p.fileIdx].set(p.name, null);
    }
  }

  // Places: mine win; a file's place is taken under the names its tags got.
  let assign = store.assign;
  const own = (kind: keyof TagAssign) => {
    if (assign === store.assign) assign = { dir: { ...store.assign.dir }, file: { ...store.assign.file }, name: { ...store.assign.name } };
    return assign[kind];
  };
  files.forEach((f, fi) => {
    if (!usable[fi] || !f.assign || typeof f.assign !== "object") return;
    for (const kind of ["dir", "file", "name"] as const) {
      const m = f.assign[kind];
      if (!m || typeof m !== "object") continue;
      for (const [raw, v] of Object.entries(m)) {
        if (!Array.isArray(v)) continue;
        const names = [
          ...new Set(
            v
              .filter((x): x is string => typeof x === "string")
              .map((x) => fate[fi].get(normalizeTagName(x)))
              .filter((x): x is string => !!x && x !== COMMON)
          ),
        ];
        if (!names.length) continue;
        const key = assignKey(raw, kind !== "dir");
        const place = placeText(kind, key);
        if (Object.prototype.hasOwnProperty.call(assign[kind], key)) {
          sum.assignKept.push(place);
          continue;
        }
        own(kind)[key] = names;
        sum.assignAdded.push(`${place} → ${names.join(", ")}`);
        changed = true;
      }
    }
  });
  if (!changed) return { store, summary: sum };
  return { store: { ...store, tags, assign }, summary: sum };
}

// "추가 2 · 덮어씀 1 · 건너뜀 3 · 이름 바꿔 추가 1 · 잘못된 규칙 2 (· 가져오지 못함 1)
//  (· 붙인 곳 3개 추가 · 1개는 내 지정이 있어 건너뜀)"
export function summaryLine(s: ImportSummary): string {
  const parts = [
    `추가 ${s.added.length}`,
    `덮어씀 ${s.overwritten.length}`,
    `건너뜀 ${s.same.length + s.skipped.length}`,
    `이름 바꿔 추가 ${s.renamed.length}`,
    `잘못된 규칙 ${s.badRules.length}`,
  ];
  if (s.notImported.length) parts.push(`가져오지 못함 ${s.notImported.length}`);
  if (s.assignAdded.length || s.assignKept.length)
    parts.push(`붙인 곳 ${s.assignAdded.length}개 추가`, `${s.assignKept.length}개는 내 지정이 있어 건너뜀`);
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
  if (s.assignAdded.length) out.push(`붙인 곳 추가: ${s.assignAdded.join(" · ")}`);
  if (s.assignKept.length) out.push(`붙인 곳 건너뜀(내 지정이 있어 내 것을 유지): ${s.assignKept.join(" · ")}`);
  return out;
}
