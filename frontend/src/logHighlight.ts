import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";

// Log highlighting (what vim's `messages` syntax, VS Code's Log File Highlighter
// and MobaXterm's keyword colouring do). There is no single standard; level
// words follow syslog severities (RFC 5424: emerg alert crit err warning notice
// info debug) and the log4j/logback family (FATAL ERROR WARN INFO DEBUG TRACE).
// Rules are user-editable and saved with the session.

export interface LogRule {
  id: string;
  on: boolean;
  label: string; // shown in the rules dialog
  pattern: string;
  regex: boolean; // false = whole-word text match
  caseSensitive: boolean;
  color: string; // CSS colour of the matched text
  line: boolean; // also tint the whole line
}

export const DEFAULT_LOG_RULES: LogRule[] = [
  {
    id: "error",
    on: true,
    label: "오류",
    pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`,
    regex: true,
    caseSensitive: false,
    color: "#ff6b6b",
    line: true,
  },
  {
    id: "warn",
    on: true,
    label: "경고",
    pattern: String.raw`\bWARN(ING)?\b`,
    regex: true,
    caseSensitive: false,
    color: "#e5c07b",
    line: false,
  },
  {
    id: "info",
    on: true,
    label: "정보",
    pattern: String.raw`\b(INFO|NOTICE)\b|\[Note\]`,
    regex: true,
    caseSensitive: false,
    color: "#61afef",
    line: false,
  },
  {
    id: "debug",
    on: true,
    label: "디버그",
    pattern: String.raw`\b(DEBUG|TRACE|VERBOSE)\b`,
    regex: true,
    caseSensitive: false,
    color: "#7f848e",
    line: false,
  },
  {
    id: "time",
    on: true,
    label: "시각",
    // syslog "Oct 20 17:03:00", ISO / mariadb "2026-10-20  0:49:54",
    // redis "18 Oct 2026 23:00:44.012"; optional ms
    pattern: String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`,
    regex: true,
    caseSensitive: true,
    color: "#56b6c2",
    line: false,
  },
  {
    id: "mk119",
    on: true,
    label: "장애 신호 (클러스터·프로세스)",
    pattern: String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`,
    regex: true,
    caseSensitive: true,
    color: "#ff9e64",
    line: true,
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compile a rule; null when empty or an invalid regex (the dialog flags it).
// A group that contains a repeat and is itself repeated ("(a+)+", "(\w*)*",
// "(x|y+){2,}") can backtrack exponentially on an unlucky line. Colouring runs
// on the UI thread with no way to interrupt a regex, so such rules are refused.
export function riskyRegex(src: string): boolean {
  const s = src.replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "x"); // drop escapes and classes
  const groups: boolean[] = []; // per open group: does it contain a repeat?
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") groups.push(false);
    else if (c === ")") {
      const inner = groups.pop() ?? false;
      const next = s[i + 1];
      const repeated = next === "*" || next === "+" || next === "{";
      if (inner && repeated) return true;
      if (groups.length && (inner || repeated)) groups[groups.length - 1] = true;
    } else if ((c === "*" || c === "+" || c === "{") && groups.length) {
      groups[groups.length - 1] = true;
    }
  }
  return false;
}

// Why a rule can't be used: "" (fine), "invalid" regex / matches "", or "slow".
export function ruleProblem(r: LogRule): "" | "invalid" | "slow" {
  if (!r.pattern) return "";
  if (r.regex && riskyRegex(r.pattern)) return "slow";
  return compileRule(r) ? "" : "invalid";
}

export function compileRule(r: LogRule): RegExp | null {
  if (!r.pattern) return null;
  if (r.regex && riskyRegex(r.pattern)) return null;
  try {
    const src = r.regex ? r.pattern : `(?<![\\w])${escapeRe(r.pattern)}(?![\\w])`;
    const re = new RegExp(src, r.caseSensitive ? "g" : "gi");
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

function build(view: EditorView, rules: Compiled[]): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.length > MAX_LINE_SCAN ? line.text.slice(0, MAX_LINE_SCAN) : line.text;
      let tinted = false;
      for (const r of rules) {
        if (r.dead) continue;
        const t0 = performance.now();
        r.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = r.re.exec(text))) {
          if (!m[0]) {
            r.re.lastIndex++;
            continue;
          }
          out.push(r.mark.range(line.from + m.index, line.from + m.index + m[0].length));
          if (r.line && !tinted) {
            out.push(r.line.range(line.from));
            tinted = true;
          }
        }
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

// The editor extension for a rule set (only enabled, valid rules).
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

export function normalizeLogRules(raw: unknown): LogRule[] {
  if (!Array.isArray(raw)) return DEFAULT_LOG_RULES;
  const out: LogRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || typeof (r as any).pattern !== "string") continue;
    const x = r as any;
    out.push({
      id: typeof x.id === "string" ? x.id : Math.random().toString(36).slice(2),
      on: x.on !== false,
      label: typeof x.label === "string" ? x.label : "",
      pattern: x.pattern,
      regex: !!x.regex,
      caseSensitive: !!x.caseSensitive,
      color: typeof x.color === "string" && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : "#ff6b6b",
      line: !!x.line,
    });
  }
  return out;
}
