import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";
import { RE2JS } from "re2js";
import { translateJS } from "./jsRegex";
import { noteRuleTrouble } from "./ruleHealth";

// Log highlighting (what vim's `messages` syntax, VS Code's Log File Highlighter
// and MobaXterm's keyword colouring do). There is no single standard; level
// words follow syslog severities (RFC 5424: emerg alert crit err warning notice
// info debug) and the log4j/logback family (FATAL ERROR WARN INFO DEBUG TRACE).
// Rules are user-editable and live in log colour tags (~/.chipper/tags.json,
// see logTags.ts); old sessions carried them as `logRules`.

// "text" = the typed characters anywhere (spaces allowed), "word" = only where
// not glued to letters/digits, "regex" = a JavaScript regular expression.
export type RuleKind = "text" | "word" | "regex";
export const RULE_KINDS: RuleKind[] = ["text", "word", "regex"];

export interface LogRule {
  id: string;
  on: boolean;
  label: string; // shown in the rules dialog
  pattern: string;
  kind: RuleKind; // older rules had `regex: boolean` (true = regex, false = word)
  caseSensitive: boolean;
  color: string; // CSS colour of the matched text
  line: boolean; // also tint the whole line
  filter: boolean; // used by "tag lines only" view (줄만 보기에 씀)
  // With `line`: tint the line only when a match starts within its first
  // lineHead characters (the level column of a log line). Absent/0 = anywhere.
  // Display only — which lines match (and 「줄만」) does not depend on it.
  lineHead?: number;
}

// The level column: 「줄 앞 60자 안」 (plan 7절).
export const LEVEL_HEAD = 60;
export const MAX_LINE_HEAD = 2000;

// Revision of the built-in common rules. tags.json remembers the revision its
// common was last brought up to (TagStore.defaults); commonDefaults.ts moves an
// older common forward without touching the rules the user changed.
//   1 = v1.2.0 … stage 5,  2 = stage 6 (error line tint only in the level
//   column, more time formats, failed/Exception text colour only).
export const DEFAULTS_REV = 2;

export const DEFAULT_LOG_RULES: LogRule[] = [
  {
    // The level: the level words as logs write them (upper case: log4j,
    // logback, kafka, zookeeper, spring, mariadb [ERROR], liz modules) in the
    // level column — the line background. Lower-case 「(unknown error)」 or an
    // upper-case word further on is the message, not the level.
    id: "error",
    on: true,
    label: "오류 (레벨)",
    pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC)\b`,
    kind: "regex",
    caseSensitive: true,
    color: "#ff6b6b",
    line: true,
    filter: true,
    lineHead: LEVEL_HEAD,
  },
  {
    // Bracketed level words are levels wherever they are: ClickHouse writes
    // <Error> after the query id ({…uuid…}), often past column 60; nginx /
    // apache write [error]. 「줄만」 off: the next rule already keeps the lines.
    id: "error-ck",
    on: true,
    label: "오류 줄 배경 (<Error>·[error] 꼴)",
    pattern: String.raw`<(Fatal|Critical|Error)>|\[(emerg|alert|crit|error)\]`,
    kind: "regex",
    caseSensitive: true,
    color: "#ff6b6b",
    line: true,
    filter: false,
  },
  {
    // v1.2.0's 오류 words anywhere, in any case (「INFO … has failed」,
    // 「I/O exception」, 「(unknown error)」): the text colour only, the line is
    // not tinted. 「줄만」 keeps the same lines as v1.2.0's 오류 rule did.
    id: "fail",
    on: true,
    label: "오류·실패 낱말 (글자색만)",
    pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`,
    kind: "regex",
    caseSensitive: false,
    color: "#ff6b6b",
    line: false,
    filter: true,
  },
  {
    id: "warn",
    on: true,
    label: "경고",
    pattern: String.raw`\bWARN(ING)?\b`,
    kind: "regex",
    caseSensitive: false,
    color: "#e5c07b",
    line: false,
    filter: true,
  },
  {
    id: "info",
    on: true,
    label: "정보",
    pattern: String.raw`\b(INFO|NOTICE)\b|\[Note\]`,
    kind: "regex",
    caseSensitive: false,
    color: "#61afef",
    line: false,
    filter: false,
  },
  {
    id: "debug",
    on: true,
    label: "디버그",
    pattern: String.raw`\b(DEBUG|TRACE|VERBOSE)\b`,
    kind: "regex",
    caseSensitive: false,
    color: "#7f848e",
    line: false,
    filter: false,
  },
  {
    id: "time",
    on: true,
    label: "시각",
    // syslog "Oct 20 17:03:00", ISO / mariadb "2026-10-20  0:49:54" (also
    // kafka "[2026-10-20 19:07:03,123]" and zookeeper "2026-10-20 19:07:03,123"
    // through [.,]ms), redis "18 Oct 2026 23:00:44.012", clickhouse
    // "2026.10.20 19:07:03.039812", liz modules "10-22 00:00:03"
    pattern: String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?|\b\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d(\.\d+)?|\b\d\d-\d\d \d\d:\d\d:\d\d([.,]\d+)?`,
    kind: "regex",
    caseSensitive: true,
    color: "#56b6c2",
    line: false,
    filter: false,
  },
  {
    id: "mk119",
    on: true,
    label: "장애 신호 (클러스터·프로세스)",
    pattern: String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`,
    kind: "regex",
    caseSensitive: true,
    color: "#ff9e64",
    line: true,
    filter: true,
  },
];

// The built-in common rules of revision 1 (v1.2.0 … stage 5), exactly as they
// were. commonDefaults.ts compares against these to tell an old default the
// user never touched from one they changed.
export const DEFAULT_LOG_RULES_V1: LogRule[] = [
  { id: "error", on: true, label: "오류", pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`, kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true },
  { id: "warn", on: true, label: "경고", pattern: String.raw`\bWARN(ING)?\b`, kind: "regex", caseSensitive: false, color: "#e5c07b", line: false, filter: true },
  { id: "info", on: true, label: "정보", pattern: String.raw`\b(INFO|NOTICE)\b|\[Note\]`, kind: "regex", caseSensitive: false, color: "#61afef", line: false, filter: false },
  { id: "debug", on: true, label: "디버그", pattern: String.raw`\b(DEBUG|TRACE|VERBOSE)\b`, kind: "regex", caseSensitive: false, color: "#7f848e", line: false, filter: false },
  { id: "time", on: true, label: "시각", pattern: String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`, kind: "regex", caseSensitive: true, color: "#56b6c2", line: false, filter: false },
  { id: "mk119", on: true, label: "장애 신호 (클러스터·프로세스)", pattern: String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`, kind: "regex", caseSensitive: true, color: "#ff9e64", line: true, filter: true },
];


const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- matching engines ------------------------------------------------------------
//
// A rule the user writes as a regex runs on re2js (RE2 ported to JavaScript):
// matching time is linear in the line length whatever the pattern, so no regex
// can freeze the editor — the old guard (a heuristic that refused "risky"
// shapes like (a|aa)+ and also many harmless ones like (\w|-)+) is gone.
// The pattern is still JavaScript syntax: translateJS (jsRegex.ts) rewrites it
// into RE2 syntax exactly like the Go line filter does, so a line is coloured
// exactly when 「태그 줄만 보기」 keeps it. What RE2 cannot express (look-ahead,
// look-behind, back-references) is refused with the reason.
//
// The built-in default patterns, and 「글자 그대로」/「단어」 rules (escaped
// text), run on the browser's own RegExp, which is faster: they are known
// linear, and translateJS keeps their meaning identical.

export type RuleProblem = "" | "invalid" | "unsupported";

// Matches of one rule on one line: flat [from, to, from, to, …], non-empty,
// in order, not overlapping.
export interface RuleMatcher {
  engine: "v8" | "re2";
  ranges(text: string): number[];
}

interface CompiledRule {
  matcher: RuleMatcher | null;
  problem: RuleProblem;
  reason: string; // Korean, "" when fine
}

const BUILTIN_PATTERNS = new Set([...DEFAULT_LOG_RULES, ...DEFAULT_LOG_RULES_V1].map((r) => r.pattern));
const NONE: number[] = [];

function v8Matcher(re: RegExp): RuleMatcher {
  return {
    engine: "v8",
    ranges(text) {
      re.lastIndex = 0;
      let out: number[] | null = null;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (!m[0]) {
          re.lastIndex++;
          continue;
        }
        (out ??= []).push(m.index, m.index + m[0].length);
      }
      return out ?? NONE;
    },
  };
}

function re2Matcher(re: RE2JS): RuleMatcher {
  return {
    engine: "re2",
    ranges(text) {
      // test() runs the DFA only (fast); most lines don't match most rules.
      if (!re.test(text)) return NONE;
      const out: number[] = [];
      const m = re.matcher(text);
      while (m.find()) {
        const a = m.start();
        const b = m.end();
        if (b > a) out.push(a, b);
      }
      return out;
    },
  };
}

// re2js / Go regexp parse errors → the same Korean words the Go filter uses.
const RE2_ERRORS: [string, string][] = [
  ["invalid character class range", "글자 범위가 잘못되었습니다"],
  ["invalid character class", "잘못된 글자 묶음입니다"],
  ["invalid escape", "잘못된 이스케이프입니다"],
  ["invalid named capture", "잘못된 이름 그룹입니다"],
  ["invalid or unsupported Perl syntax", "알 수 없는 그룹 표기 (? 입니다"],
  ["invalid nested repetition", "반복 기호를 잘못 썼습니다"],
  ["invalid repeat count", "반복 횟수는 1000 이하만 됩니다"],
  ["invalid UTF-8", "잘못된 UTF-8 글자가 있습니다"],
  ["missing closing ]", "글자 묶음 [ 이 닫히지 않았습니다"],
  ["missing closing )", "괄호 짝이 맞지 않습니다"],
  ["unexpected )", "괄호 짝이 맞지 않습니다"],
  ["missing argument to repetition", "반복할 대상이 없습니다"],
  ["trailing backslash", "정규식 끝에 \\ 가 홀로 있습니다"],
  ["nests too deeply", "괄호가 너무 깊습니다"],
  ["too large", "정규식이 너무 큽니다"],
];
function re2ErrorReason(e: unknown): string {
  const msg = String((e as any)?.message ?? e);
  for (const [k, v] of RE2_ERRORS) if (msg.includes(k)) return v;
  return "정규식을 해석할 수 없습니다";
}

const compileCache = new Map<string, CompiledRule>();

function compileFull(r: Pick<LogRule, "kind" | "pattern" | "caseSensitive">): CompiledRule {
  if (!r.pattern) return { matcher: null, problem: "", reason: "" };
  const key = `${r.kind}\u0000${r.caseSensitive ? 1 : 0}\u0000${r.pattern}`;
  const hit = compileCache.get(key);
  if (hit) return hit;
  let res: CompiledRule;
  if (r.kind === "regex" && !BUILTIN_PATTERNS.has(r.pattern)) {
    const t = translateJS(r.pattern, !r.caseSensitive);
    // "… 지원하지 않습니다" = JavaScript-only syntax; anything else is a broken pattern
    if (t.reason) res = { matcher: null, problem: t.reason.includes("지원하지 않습니다") ? "unsupported" : "invalid", reason: t.reason };
    else {
      try {
        const re = RE2JS.compile(t.out);
        res = re.test("")
          ? { matcher: null, problem: "invalid", reason: "빈 글자에도 걸리는 정규식입니다" }
          : { matcher: re2Matcher(re), problem: "", reason: "" };
      } catch (e) {
        res = { matcher: null, problem: "invalid", reason: re2ErrorReason(e) };
      }
    }
  } else {
    try {
      const re = new RegExp(ruleSource(r), r.caseSensitive ? "g" : "gi");
      res = re.test("")
        ? { matcher: null, problem: "invalid", reason: "빈 글자에도 걸리는 정규식입니다" }
        : { matcher: v8Matcher(re), problem: "", reason: "" };
    } catch {
      res = { matcher: null, problem: "invalid", reason: "정규식을 해석할 수 없습니다" };
    }
  }
  if (compileCache.size > 500) compileCache.clear();
  compileCache.set(key, res);
  return res;
}

// THE check of a rule (one function for every caller — tag window, import,
// 「이 글자로 규칙」): whether it can be used and, if not, why.
//   problem: "" (fine), "invalid" (a broken regex, or one that matches the
//            empty string) or "unsupported" (JavaScript-only syntax RE2 has no
//            equivalent for: look-ahead, look-behind, back-references, …);
//   reason:  the same in Korean words ("" when fine), the Go filter's wording.
// Cached per (kind, case, pattern), so calling it on every render is cheap.
export function ruleCheck(r: Pick<LogRule, "kind" | "pattern" | "caseSensitive">): { problem: RuleProblem; reason: string } {
  const c = compileFull(r);
  return { problem: c.problem, reason: c.reason };
}
// Shorthands of ruleCheck.
export const ruleProblem = (r: LogRule): RuleProblem => ruleCheck(r).problem;
export const ruleProblemReason = (r: LogRule): string => ruleCheck(r).reason;

// The JavaScript regex source a rule means (text and word rules escaped).
export function ruleSource(r: Pick<LogRule, "kind" | "pattern">): string {
  if (r.kind === "regex") return r.pattern;
  if (r.kind === "word") return `(?<![\\w])${escapeRe(r.pattern)}(?![\\w])`;
  return escapeRe(r.pattern);
}

// The matcher for a rule; null when empty or unusable (see ruleProblem).
export function compileRule(r: LogRule): RuleMatcher | null {
  return compileFull(r).matcher;
}

// --- colouring ---------------------------------------------------------------------
//
// Priority (what colour a character gets when several rules match it):
//  - between layers (rulesFor/layersFor: the file's tags, then common), the
//    higher layer wins — a tag beats common;
//  - inside one layer it is what v1.2.0 showed. v1.2.0 put every match in as
//    an overlapping mark and CodeMirror shows the innermost one: the match
//    that ends first, then the one that starts last. So a user rule added
//    below a default rule shows inside the longer default match (Pointer inside
//    NullPointerException). For two rules matching the very same range v1.2.0
//    had no fixed answer — CodeMirror puts such marks in separate layers and
//    its heap order (which depends on the other marks around) picked one — so
//    here the later rule wins, as the plan says (a rule added below wins).
// Line background: the first rule with 「줄」 that matches, in the highest
// layer that has one (v1.2.0: the first matching line rule).
// Overlaps are resolved here so the editor gets non-overlapping marks.

const MAX_LINE_SCAN = 2000; // don't regex-scan minified megabyte lines in full
// Safety net: a rule that takes longer than this in one pass (now only
// possible with very many matches) is switched off for the rest of the session.
const RULE_BUDGET_MS = 60;
const LINE_CACHE_MAX = 4000; // lines whose colouring is remembered (per rule set)

interface Compiled {
  m: RuleMatcher;
  layer: number;
  mark: Decoration;
  line: Decoration | null;
  head: number; // LogRule.lineHead (0 = anywhere)
  key: string; // ruleKey
  label: string;
  dead: boolean;
  spent: number; // ms used in the current pass
}

// One line's colouring: spans = flat [from, to, rule, …] (rule = index into the
// compiled list), tint = the rule whose line background shows, or -1.
// dim = flat [from, to, …] of ANSI colour codes (shown faint, see paintLine).
export interface LinePaint {
  spans: number[];
  tint: number;
  dim?: number[];
}

// Resolve the matches of every rule on one line. found[i] = ranges of rule i
// (flat, sorted, non-overlapping), layer[i] = its layer (0 = highest).
// lineHead[i] > 0: rule i tints the line only when its first match starts
// before that column (LogRule.lineHead).
export function resolvePaint(len: number, found: number[][], layer: number[], lineRule: boolean[], lineHead?: number[]): LinePaint {
  let tint = -1;
  let count = 0;
  for (let i = 0; i < found.length; i++) {
    if (!found[i].length) continue;
    count += found[i].length / 2;
    if (tint < 0 && lineRule[i] && !(lineHead?.[i] && found[i][0] >= lineHead[i])) tint = i;
  }
  if (!count) return { spans: NONE, tint };
  // Gather and order by start; nothing overlapping → done.
  const all: number[] = []; // from, to, rule
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    for (let k = 0; k < f.length; k += 2) all.push(f[k], f[k + 1], i);
  }
  const idx = Array.from({ length: count }, (_, k) => k);
  idx.sort((x, y) => all[3 * x] - all[3 * y] || x - y);
  let overlap = false;
  for (let k = 1; k < count; k++)
    if (all[3 * idx[k]] < all[3 * idx[k - 1] + 1]) {
      overlap = true;
      break;
    }
  if (!overlap) {
    const spans: number[] = [];
    for (const k of idx) spans.push(all[3 * k], all[3 * k + 1], all[3 * k + 2]);
    return { spans, tint };
  }
  // Per character winner. Each rule's own matches never overlap, so the work is
  // at most (rules × line length).
  const win = new Int32Array(len).fill(-1);
  const beats = (a: number, b: number) => {
    const ra = all[3 * a + 2];
    const rb = all[3 * b + 2];
    if (layer[ra] !== layer[rb]) return layer[ra] < layer[rb];
    const ta = all[3 * a + 1];
    const tb = all[3 * b + 1];
    if (ta !== tb) return ta < tb; // innermost: ends first
    const fa = all[3 * a];
    const fb = all[3 * b];
    if (fa !== fb) return fa > fb; // … then starts last
    return ra > rb; // the very same range: the later rule (see above)
  };
  for (let k = 0; k < count; k++) {
    const a = all[3 * k];
    const b = Math.min(all[3 * k + 1], len);
    for (let c = a; c < b; c++) if (win[c] < 0 || beats(k, win[c])) win[c] = k;
  }
  const spans: number[] = [];
  for (let c = 0; c < len; ) {
    const w = win[c];
    let e = c + 1;
    while (e < len && win[e] === w) e++;
    if (w >= 0) spans.push(c, e, all[3 * w + 2]);
    c = e;
  }
  return { spans, tint };
}

// --- ANSI colour codes -------------------------------------------------------------
//
// Programs that colour their terminal output leave ESC [ … m codes in the log
// (`ESC[31m2026-10-20 09:32:56ESC[0m [ESC[1;31mWARNESC[0m]`). Rules are matched
// on the line without the codes — the characters one reads — and the codes are
// shown faint. The Go line filter takes out exactly the same sequences
// (internal/linefilter/ansi.go), so 「줄만」 keeps the lines the editor colours.
// A sequence = ESC '[', parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F,
// one final byte 0x40–0x7E (any CSI, not only the colour ones). An ESC that
// does not start a complete sequence stays a character.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export interface AnsiStripped {
  text: string; // the line without the codes
  raw: Int32Array; // raw[i] = index in the line of text[i]; raw[text.length] = line length
  codes: number[]; // flat [from, to, …] of the codes in the line
}

// The line without its ANSI codes, or null when it has none.
export function stripAnsi(line: string): AnsiStripped | null {
  if (line.indexOf("\x1b") < 0) return null;
  ANSI_RE.lastIndex = 0;
  const codes: number[] = [];
  let cut = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(line))) {
    codes.push(m.index, m.index + m[0].length);
    cut += m[0].length;
  }
  if (!codes.length) return null;
  const raw = new Int32Array(line.length - cut + 1);
  let text = "";
  let at = 0;
  let n = 0;
  const keep = (a: number, b: number) => {
    text += line.slice(a, b);
    for (let i = a; i < b; i++) raw[n++] = i;
  };
  for (let k = 0; k < codes.length; k += 2) {
    keep(at, codes[k]);
    at = codes[k + 1];
  }
  keep(at, line.length);
  raw[n] = line.length;
  return { text, raw, codes };
}

// One line's colouring, the same for the editor and 「줄만」 (lineView.ts):
// find(text) gives every rule's matches on the text it is handed (the line
// without ANSI codes); the result is in the line's own positions, with the
// codes in `dim`. lineHead columns count the characters without the codes.
export function paintLine(
  text: string,
  find: (visible: string) => number[][],
  layer: number[],
  lineRule: boolean[],
  lineHead?: number[]
): LinePaint {
  const a = stripAnsi(text);
  if (!a) return resolvePaint(text.length, find(text), layer, lineRule, lineHead);
  const p = resolvePaint(a.text.length, find(a.text), layer, lineRule, lineHead);
  const spans: number[] = [];
  const s = p.spans;
  for (let k = 0; k < s.length; k += 3) spans.push(a.raw[s[k]], a.raw[s[k + 1] - 1] + 1, s[k + 2]);
  return { spans, tint: p.tint, dim: a.codes };
}

// A rule's identity for notes about it (ruleHealth.ts): what it matches.
export const ruleKey = (r: Pick<LogRule, "kind" | "pattern" | "caseSensitive">) =>
  `${r.kind}\u0000${r.caseSensitive ? 1 : 0}\u0000${r.pattern}`;

const ANSI_DIM = Decoration.mark({ class: "cm-ansi", attributes: { style: "opacity:0.45" } });

class Painter {
  cache = new Map<string, LinePaint>();
  layer: number[];
  lineRule: boolean[];
  lineHead: number[];
  constructor(public rules: Compiled[]) {
    this.layer = rules.map((r) => r.layer);
    this.lineRule = rules.map((r) => !!r.line);
    this.lineHead = rules.map((r) => r.head);
  }
  private find = (text: string): number[][] => {
    const found: number[][] = [];
    for (const r of this.rules) {
      if (r.dead) {
        found.push(NONE);
        continue;
      }
      const t0 = performance.now();
      found.push(r.m.ranges(text));
      r.spent += performance.now() - t0;
    }
    return found;
  };
  paint(text: string): LinePaint {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const p = paintLine(text, this.find, this.layer, this.lineRule, this.lineHead);
    if (this.cache.size >= LINE_CACHE_MAX) this.cache.clear();
    this.cache.set(text, p);
    return p;
  }
  build(view: EditorView): DecorationSet {
    const out: Range<Decoration>[] = [];
    const doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = doc.lineAt(pos);
        const text = line.length > MAX_LINE_SCAN ? line.text.slice(0, MAX_LINE_SCAN) : line.text;
        const p = this.paint(text);
        if (p.tint >= 0) out.push(this.rules[p.tint].line!.range(line.from));
        const s = p.spans;
        for (let k = 0; k < s.length; k += 3) out.push(this.rules[s[k + 2]].mark.range(line.from + s[k], line.from + s[k + 1]));
        const d = p.dim;
        if (d) for (let k = 0; k < d.length; k += 2) out.push(ANSI_DIM.range(line.from + d[k], line.from + d[k + 1]));
        pos = line.to + 1;
      }
    }
    let died = false;
    for (const r of this.rules) {
      if (!r.dead && r.spent > RULE_BUDGET_MS) {
        r.dead = died = true;
        console.warn(`로그 색 규칙 「${r.label}」이 너무 느려 이번 실행 동안 끕니다`);
        noteRuleTrouble(r.key, "editor");
      }
      r.spent = 0;
    }
    if (died) this.cache.clear();
    return Decoration.set(out, true);
  }
}

// Rules in layers, highest priority first (a tag's rules, …, common's rules).
export type RuleLayers = LogRule[][];

// The editor extension for a rule set (only enabled, usable rules). A flat
// list is one layer — v1.2.0's meaning. See the priority notes above.
export function logHighlighter(rules: LogRule[] | RuleLayers): Extension {
  const layers: LogRule[][] = rules.length && Array.isArray(rules[0]) ? (rules as RuleLayers) : [rules as LogRule[]];
  const compiled: Compiled[] = [];
  layers.forEach((rs, layer) => {
    for (const r of rs) {
      if (!r.on) continue;
      const m = compileRule(r);
      if (!m) continue;
      compiled.push({
        m,
        layer,
        head: lineHeadOf(r),
        key: ruleKey(r),
        label: r.label || r.pattern,
        dead: false,
        spent: 0,
        mark: Decoration.mark({ attributes: { style: `color:${r.color};font-weight:600` } }),
        line: r.line ? Decoration.line({ attributes: { style: `background-color:${r.color}1f` } }) : null,
      });
    }
  });
  if (!compiled.length) return [];
  const painter = new Painter(compiled);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = painter.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = painter.build(u.view);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Files that look like logs get colouring by default (plain text only).
export function looksLikeLog(name: string): boolean {
  return /\.(log|err|out|trc|trace)(\b|\.|$)|messages|journal|syslog|secure|catalina|\.log\.|\.\d+$|^[^.]+$/i.test(name);
}

// 「줄만 보기에 씀」 for a rule saved before the flag existed: the noisy common
// defaults (정보·디버그·시각) are off, everything else — including rules the
// user added — on.
const FILTER_OFF_BY_DEFAULT = new Set(["info", "debug", "time"]);
export const defaultFilterFor = (id: string) => !FILTER_OFF_BY_DEFAULT.has(id);

export function normalizeRule(x: any): LogRule | null {
  if (!x || typeof x !== "object" || typeof x.pattern !== "string") return null;
  const id = typeof x.id === "string" && x.id ? x.id : Math.random().toString(36).slice(2);
  // old rules: regex true → regex, false → word (the old "단어")
  const kind: RuleKind = RULE_KINDS.includes(x.kind) ? x.kind : x.regex ? "regex" : "word";
  return {
    id,
    on: x.on !== false,
    label: typeof x.label === "string" ? x.label : "",
    pattern: x.pattern,
    kind,
    caseSensitive: !!x.caseSensitive,
    color: typeof x.color === "string" && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : "#ff6b6b",
    line: !!x.line,
    filter: typeof x.filter === "boolean" ? x.filter : defaultFilterFor(id),
    ...(validLineHead(x.lineHead) ? { lineHead: x.lineHead } : {}),
  };
}

// lineHead is kept only as a whole number 1 … MAX_LINE_HEAD (else: anywhere).
export const validLineHead = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LINE_HEAD;
export const lineHeadOf = (r: Pick<LogRule, "lineHead">): number => (validLineHead(r.lineHead) ? r.lineHead : 0);

// Rules from an old session (`logRules`) or a tag; the defaults when not an array.
export function normalizeLogRules(raw: unknown): LogRule[] {
  if (!Array.isArray(raw)) return DEFAULT_LOG_RULES;
  return raw.map(normalizeRule).filter((r): r is LogRule => !!r);
}
