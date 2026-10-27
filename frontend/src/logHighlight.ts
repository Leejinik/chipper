import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";

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
}

export const DEFAULT_LOG_RULES: LogRule[] = [
  {
    id: "error",
    on: true,
    label: "오류",
    pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`,
    kind: "regex",
    caseSensitive: false,
    color: "#ff6b6b",
    line: true,
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
    // syslog "Oct 20 17:03:00", ISO / mariadb "2026-10-20  0:49:54",
    // redis "18 Oct 2026 23:00:44.012"; optional ms
    pattern: String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`,
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


const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A group that is itself repeated ("(...)+", "(...)*", "(...){2,}") can
// backtrack exponentially on an unlucky line when
//   - it contains a repeat:            (a+)+  (\w*)*  (x|y+){2,}
//   - or its alternatives can overlap: (a|aa)+$  (a|ab)*  (.|x)+  (a?b|b)+
// Colouring runs on the UI thread with no way to interrupt a regex, so such
// rules are refused. A small bounded repeat of the group ({2}, {1,4}) can't
// blow up and is allowed — IP addresses are written (\d{1,3}\.){3}\d{1,3}.
// Overlap is judged on each alternative's first token and
// errs on the safe side: a class, ".", an escape class like \d, a nested group,
// an optional first token or an empty alternative counts as overlapping.
export function riskyRegex(src: string): boolean {
  type Frame = {
    inner: boolean; // contains a repeat
    firsts: string[]; // first-token key of each finished alternative
    cur: string | null; // first-token key of the current alternative
    justFirst: boolean; // the last token was that first token
  };
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  // A token that is not a group/quantifier/alternation, inside the current group.
  const token = (key: string) => {
    const f = top();
    if (!f) return;
    if (f.cur === null) {
      f.cur = key;
      f.justFirst = true;
    } else f.justFirst = false;
  };
  const overlap = (keys: string[]) => {
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i];
        const b = keys[j];
        if (a === b || a === "any" || b === "any") return true;
      }
    return false;
  };
  // Quantifier at src[i]: [its length, most repeats] or null.
  const quant = (i: number): [number, number] | null => {
    const c = src[i];
    if (c === "*" || c === "+") return [1, Infinity];
    if (c === "?") return [1, 1];
    if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(src.slice(i));
      if (!m || (m[1] === "" && m[3] === "")) return null; // a literal "{"
      const max = m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : Number(m[1]);
      return [m[0].length, max];
    }
    return null;
  };
  const SMALL_BOUND = 4; // (..){n,m} with m <= this backtracks at most k^4 ways
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      i++;
      if (n === "b" || n === "B") continue; // zero-width
      // \d \w \s \p{..} \uXXXX \xXX backrefs … : treat as "anything"
      if (/[dDwWsSpPuxXk0-9cfnrtv]/.test(n)) token("any");
      else token("c:" + n.toLowerCase());
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      for (; j < src.length && src[j] !== "]"; j++) if (src[j] === "\\") j++;
      i = j;
      token("any");
      continue;
    }
    if (c === "(") {
      token("any"); // a nested group as an alternative's first token may overlap
      stack.push({ inner: false, firsts: [], cur: null, justFirst: false });
      // skip (?: (?= (?! (?<= (?<! (?<name>
      const m = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(src.slice(i));
      if (m) i += m[0].length - 1;
      continue;
    }
    if (c === "|") {
      const f = top();
      if (f) {
        f.firsts.push(f.cur ?? "any"); // empty alternative overlaps everything
        f.cur = null;
        f.justFirst = false;
      }
      continue;
    }
    if (c === ")") {
      const f = stack.pop();
      if (!f) continue;
      f.firsts.push(f.cur ?? "any");
      const q = quant(i + 1);
      const repeated = !!q && q[1] > 1;
      const ambiguous = f.firsts.length > 1 && overlap(f.firsts);
      if (q && q[1] > SMALL_BOUND && (f.inner || ambiguous)) return true;
      const p = top();
      if (p) {
        // an ambiguous alternation inside a repeated group, ((a|aa))+, is as
        // bad as a repeat inside it
        if (f.inner || repeated || ambiguous) p.inner = true;
        p.justFirst = false;
      }
      if (q) {
        i += q[0];
        if (src[i + 1] === "?") i++; // lazy
      }
      continue;
    }
    const q = quant(i);
    if (q) {
      const f = top();
      if (f) {
        if (q[1] > 1) f.inner = true;
        if (f.justFirst) f.cur = "any"; // optional / repeated first token
        f.justFirst = false;
      }
      i += q[0] - 1;
      if (src[i + 1] === "?") i++;
      continue;
    }
    if (c === "^" || c === "$") continue;
    token(c === "." ? "any" : "c:" + c.toLowerCase());
  }
  return false;
}

// Why a rule can't be used: "" (fine), "invalid" regex / matches "", or "slow".
export function ruleProblem(r: LogRule): "" | "invalid" | "slow" {
  if (!r.pattern) return "";
  if (r.kind === "regex" && riskyRegex(r.pattern)) return "slow";
  return compileRule(r) ? "" : "invalid";
}

// The JavaScript regex source a rule compiles to.
export function ruleSource(r: Pick<LogRule, "kind" | "pattern">): string {
  if (r.kind === "regex") return r.pattern;
  if (r.kind === "word") return `(?<![\\w])${escapeRe(r.pattern)}(?![\\w])`;
  return escapeRe(r.pattern);
}

// Compile a rule; null when empty, an invalid / slow regex, or one matching "".
export function compileRule(r: LogRule): RegExp | null {
  if (!r.pattern) return null;
  if (r.kind === "regex" && riskyRegex(r.pattern)) return null;
  try {
    const re = new RegExp(ruleSource(r), r.caseSensitive ? "g" : "gi");
    return re.test("") ? null : re; // a pattern matching "" would loop forever
  } catch {
    return null;
  }
}

const MAX_LINE_SCAN = 2000; // don't regex-scan minified megabyte lines in full
// Safety net for slow rules the heuristic missed: a rule that takes longer than
// this in one pass is switched off for the rest of the session.
const RULE_BUDGET_MS = 60;

interface Compiled {
  re: RegExp;
  mark: Decoration;
  line: Decoration | null;
  label: string;
  dead: boolean;
  spent?: number; // ms used in the current pass
}

// Parts of [from,to) not yet coloured by an earlier rule (claimed is sorted).
function unclaimed(claimed: [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let s = from;
  for (const [a, b] of claimed) {
    if (b <= s) continue;
    if (a >= to) break;
    if (a > s) out.push([s, a]);
    s = Math.max(s, b);
    if (s >= to) break;
  }
  if (s < to) out.push([s, to]);
  return out;
}

function build(view: EditorView, rules: Compiled[]): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.length > MAX_LINE_SCAN ? line.text.slice(0, MAX_LINE_SCAN) : line.text;
      let tinted = false;
      const claimed: [number, number][] = []; // sorted, non-overlapping
      for (const r of rules) {
        if (r.dead) continue;
        const t0 = performance.now();
        r.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        let added = false;
        while ((m = r.re.exec(text))) {
          if (!m[0]) {
            r.re.lastIndex++;
            continue;
          }
          const a = m.index;
          const b = a + m[0].length;
          const parts: [number, number][] = claimed.length ? unclaimed(claimed, a, b) : [[a, b]];
          for (const [x, y] of parts) {
            out.push(r.mark.range(line.from + x, line.from + y));
            claimed.push([x, y]);
            added = true;
          }
          if (r.line && !tinted) {
            out.push(r.line.range(line.from));
            tinted = true;
          }
        }
        if (added) claimed.sort((p, q) => p[0] - q[0]);
        r.spent = (r.spent ?? 0) + performance.now() - t0;
      }
      pos = line.to + 1;
    }
  }
  for (const r of rules) {
    if (!r.dead && (r.spent ?? 0) > RULE_BUDGET_MS) {
      r.dead = true;
      console.warn(`로그 색 규칙 「${r.label}」이 너무 느려 이번 실행 동안 끕니다`);
    }
    r.spent = 0;
  }
  return Decoration.set(out, true);
}

// The editor extension for a rule set (only enabled, valid rules). Rules are
// in priority order: where two rules match the same characters the EARLIER
// one colours them, and the earliest matching rule with 「줄」 tints the line.
// rulesFor (logTags.ts) puts the file's tags before common, so a tag wins.
export function logHighlighter(rules: LogRule[]): Extension {
  const compiled = rules
    .filter((r) => r.on)
    .map((r) => ({ r, re: compileRule(r) }))
    .filter((x): x is { r: LogRule; re: RegExp } => !!x.re)
    .map(({ r, re }): Compiled => ({
      re,
      label: r.label || r.pattern,
      dead: false,
      mark: Decoration.mark({ attributes: { style: `color:${r.color};font-weight:600` } }),
      line: r.line ? Decoration.line({ attributes: { style: `background-color:${r.color}1f` } }) : null,
    }));
  if (!compiled.length) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, compiled);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view, compiled);
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
  };
}

// Rules from an old session (`logRules`) or a tag; the defaults when not an array.
export function normalizeLogRules(raw: unknown): LogRule[] {
  if (!Array.isArray(raw)) return DEFAULT_LOG_RULES;
  return raw.map(normalizeRule).filter((r): r is LogRule => !!r);
}
