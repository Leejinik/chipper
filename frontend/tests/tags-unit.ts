// Pure-function tests for log colour tags and rule kinds.
// Run: node frontend/tests/run-unit.cjs   (bundles this file with esbuild, then runs it)
import {
  DEFAULT_LOG_RULES,
  compileRule,
  normalizeLogRules,
  normalizeRule,
  resolvePaint,
  ruleCheck,
  ruleProblem,
  ruleProblemReason,
  ruleSource,
  type LogRule,
} from "../src/logHighlight";
import { translateJS } from "../src/jsRegex";
import {
  COMMON,
  bundleRel,
  deleteTag,
  layersFor,
  legacyLogRules,
  migratedStore,
  normalizeTagName,
  normalizeTagStore,
  placesOf,
  renameTag,
  repairTagName,
  rotationKey,
  rulesFor,
  tagNameProblem,
  tagsErrorCode,
  tagsFor,
  TAGS_ERR,
  uniqueTagName,
  type TagStore,
} from "../src/logTags";
import corpusJson from "./translate-corpus.json";
import goJson from "./translate-go.json";
import namesJson from "./tag-names.json";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}

const rule = (p: Partial<LogRule>): LogRule => ({
  id: "r",
  on: true,
  label: "",
  pattern: "",
  kind: "text",
  caseSensitive: false,
  color: "#123456",
  line: false,
  filter: true,
  ...p,
});
const matches = (r: LogRule, line: string): string[] => {
  const m = compileRule(r);
  if (!m) return ["<null>"];
  const rs = m.ranges(line);
  const out: string[] = [];
  for (let k = 0; k < rs.length; k += 2) out.push(line.slice(rs[k], rs[k + 1]));
  return out;
};
const chr = (...cps: number[]) => String.fromCodePoint(...cps);

// --- RE2 engine (user regexes) --------------------------------------------------
// 1. translateJS is the Go line filter's translateJS: same output, same reason,
//    for 3,200 hand-picked + random patterns (tests/translate-go.json is the Go
//    side's answer; regenerate per tests/gen-translate-corpus.cjs).
const corpus = corpusJson as { js: string; ci: boolean }[];
const goOut = goJson as { out: string; reason: string; filter: string }[];
eq("corpus and Go answers line up", corpus.length === goOut.length && corpus.length > 3000, true);
{
  const diff: string[] = [];
  corpus.forEach((c, i) => {
    const t = translateJS(c.js, c.ci);
    if (t.out !== goOut[i].out || t.reason !== goOut[i].reason)
      diff.push(`${JSON.stringify(c)}: ts=${JSON.stringify(t)} go=${JSON.stringify(goOut[i])}`);
  });
  eq("translateJS = Go translateJS on every corpus case", diff.slice(0, 5), []);
}

// 2. The editor refuses a regex exactly when the Go filter does — except the
//    filter's own extra refusals of patterns that colour nothing anyway (never
//    match / need a line break / only empty matches); the editor just colours
//    nothing for those.
const FILTER_ONLY = ["어떤 글자에도", "줄바꿈이 꼭", "빈 일치만"];
{
  const diff: string[] = [];
  corpus.forEach((c, i) => {
    const r = rule({ kind: "regex", pattern: c.js, caseSensitive: !c.ci });
    const editorOK = ruleProblem(r) === "";
    const g = goOut[i].filter;
    const goOK = g === "" || FILTER_ONLY.some((x) => g.startsWith(x));
    if (editorOK !== goOK) diff.push(`${JSON.stringify(c)}: editor=${ruleProblemReason(r) || "ok"} go=${g || "ok"}`);
  });
  eq("editor refuses a regex when the Go filter does", diff.slice(0, 8), []);
}

// 3. Same matches as the browser's own engine (what v1.2.0 coloured with) for
//    every corpus regex both can run, on short random lines.
{
  const alphabet = [..."aAbBkKsSeE-_.,:/=@()[]{} 019\t"].concat(
    [0xe9, 0xc9, 0xdf, 0x1e9e, 0xac00, 0xa0, 0x3000, 0x1c4, 0x1c5, 0x1c6, 0x17f, 0x212a, 0x2028].map((c) => chr(c))
  );
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const lines = Array.from({ length: 24 }, () => Array.from({ length: 1 + rnd(10) }, () => alphabet[rnd(alphabet.length)]).join(""));
  const diff: string[] = [];
  let compared = 0;
  corpus.forEach((c, i) => {
    if (goOut[i].reason) return;
    const r = rule({ kind: "regex", pattern: c.js, caseSensitive: !c.ci });
    const m = compileRule(r);
    if (!m || m.engine !== "re2") return;
    let v8: RegExp;
    try {
      v8 = new RegExp(c.js, c.ci ? "gi" : "g");
    } catch {
      return;
    }
    compared++;
    for (const line of lines) {
      const want: number[] = [];
      v8.lastIndex = 0;
      let x: RegExpExecArray | null;
      while ((x = v8.exec(line))) {
        if (!x[0]) {
          v8.lastIndex++;
          continue;
        }
        want.push(x.index, x.index + x[0].length);
      }
      const got = m.ranges(line);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        diff.push(`${JSON.stringify(c)} on ${JSON.stringify(line)}: re2=${JSON.stringify(got)} v8=${JSON.stringify(want)}`);
        break;
      }
    }
  });
  eq("re2 matches = browser regex matches (corpus × random lines)", diff.slice(0, 5), []);
  // Outside the BMP the browser (no u flag) sees two halves, RE2 and Go one
  // character: \S on "😀" is [0,1],[1,2] there and [0,2] here — the same
  // characters get coloured, so the comparison above leaves such lines out.
  eq("enough regexes compared", compared > 1000, true);
}

// 4. The review's slow regexes no longer stop the screen: they are accepted
//    and each runs over a 2,000-character worst-case line in milliseconds.
const slowOnes: [string, string][] = [
  ["(a+){4}$", "a".repeat(1999) + "!"],
  ["(a+){3}b", "a".repeat(2000)],
  ["(.*,){4}X", "a,".repeat(1000)],
  ["(\\w+\\s?){4}!", "abcd ".repeat(400)],
  ["(\\d+\\.?){4}x", "1".repeat(2000)],
  ["((a+){4}){4}$", "a".repeat(1999) + "!"],
  ["(ab?|b)+$", "ab".repeat(999) + "c"],
  [".*a.*b", "a".repeat(2000)],
  [".*a.*b.*c", "ab".repeat(1000)],
  ["(a|aa)+$", "a".repeat(1999) + "!"],
  ["(x+x+)+y", "x".repeat(2000)],
];
for (const [p, line] of slowOnes) {
  const r = rule({ kind: "regex", pattern: p, caseSensitive: true });
  eq(`accepted: ${p}`, ruleProblem(r), "");
  const m = compileRule(r)!;
  const t0 = performance.now();
  m.ranges(line);
  const ms = performance.now() - t0;
  eq(`fast on a 2,000-char worst-case line: ${p} (${ms.toFixed(1)} ms)`, ms < 100, true);
}
// v1.2.0 coloured these; the old stage-3 guard refused them — coloured again
eq("(\\w|-)+ colours", matches(rule({ kind: "regex", pattern: "(\\w|-)+" }), "host-name.example"), ["host-name", "example"]);
eq("(\\d|\\.)+ colours", matches(rule({ kind: "regex", pattern: "(\\d|\\.)+" }), "ip 10.0.0.1 x"), ["10.0.0.1"]);
eq("(,|\\s)+ colours", matches(rule({ kind: "regex", pattern: "(,|\\s)+" }), "a, b"), [", "]);
eq("(\\w|\\.)+@ colours", matches(rule({ kind: "regex", pattern: "(\\w|\\.)+@" }), "mail a.b@c"), ["a.b@"]);
eq("([a-z]|\\d)+ colours", matches(rule({ kind: "regex", pattern: "([a-z]|\\d)+", caseSensitive: true }), "AB12cd"), ["12cd"]);
eq("(\\d{1,3}\\.){3}\\d{1,3} colours", matches(rule({ kind: "regex", pattern: "(\\d{1,3}\\.){3}\\d{1,3}" }), "to 10.10.90.137:502"), ["10.10.90.137"]);
// (,|\s)* matches the empty string: refused as in v1.2.0 (it never coloured there either)
eq("(,|\\s)* matches empty → invalid (as in v1.2.0)", ruleProblem(rule({ kind: "regex", pattern: "(,|\\s)*" })), "invalid");
// JavaScript-only syntax: refused with the reason
eq("look-behind unsupported", ruleProblem(rule({ kind: "regex", pattern: "(?<=a)b" })), "unsupported");
eq("look-behind reason", ruleProblemReason(rule({ kind: "regex", pattern: "(?<=a)b" })).includes("뒤돌아보기"), true);
eq("look-ahead reason", ruleProblemReason(rule({ kind: "regex", pattern: "x(?=y)" })).includes("앞보기"), true);
eq("back-reference reason", ruleProblemReason(rule({ kind: "regex", pattern: "(a)\\1" })).includes("역참조"), true);
eq("broken regex invalid", ruleProblem(rule({ kind: "regex", pattern: "(" })), "invalid");
eq("broken regex reason", ruleProblemReason(rule({ kind: "regex", pattern: "(" })), "괄호 짝이 맞지 않습니다");
eq("repeat over 1000", ruleProblemReason(rule({ kind: "regex", pattern: "a{1001}" })), "반복 횟수는 1000 이하만 됩니다");
eq("ruleProblem matches empty", ruleProblem(rule({ kind: "regex", pattern: "x*" })), "invalid");
eq("text kind with regex characters is fine", ruleProblem(rule({ kind: "text", pattern: "(a|aa)+$" })), "");
eq("word kind keeps the browser engine", compileRule(rule({ kind: "word", pattern: "err" }))?.engine, "v8");
eq("user regex runs on re2", compileRule(rule({ kind: "regex", pattern: "\\d+ms" }))?.engine, "re2");
for (const r of DEFAULT_LOG_RULES) {
  eq(`default rule ${r.id} usable`, ruleProblem(r), "");
  eq(`default rule ${r.id} on the browser engine`, compileRule(r)?.engine, "v8");
  // and the browser engine means the same as RE2 for it
  const viaRe2 = compileRule({ ...r, pattern: "(?:" + r.pattern + ")" })!;
  const line = "10-21 00:00:03 ERROR JedisSentinelPool.run : Lost connection; WARN x; INFO y NullPointerException 2026-10-20 17:03:00.123 Oct 20 17:03:00 Killed process";
  eq(`default rule ${r.id}: re2 = browser`, viaRe2.ranges(line), compileRule(r)!.ranges(line));
}
eq("ruleCheck: one call, both answers", ruleCheck({ kind: "regex", pattern: "(?<=a)b", caseSensitive: false }).problem, "unsupported");
eq("ruleCheck: fine", ruleCheck({ kind: "regex", pattern: "(a+){4}$", caseSensitive: true }), { problem: "", reason: "" });
eq("tagsErrorCode from a Go error", tagsErrorCode(new Error("[TAGS_NEWER_ON_DISK] 디스크의 … 덮어쓰지 않았습니다")), TAGS_ERR.NEWER_ON_DISK);
eq("tagsErrorCode from a string", tagsErrorCode("[TAGS_INVALID] x: y"), TAGS_ERR.INVALID);
eq("tagsErrorCode none", tagsErrorCode(new Error("disk full")), "");
eq("ruleSource word", ruleSource({ kind: "word", pattern: "a.b" }), "(?<![\\w])a\\.b(?![\\w])");
// non-BMP characters: indexes are UTF-16 like the editor's
eq("emoji indexes", compileRule(rule({ kind: "regex", pattern: "x" }))!.ranges(chr(0x1f600) + "x"), [2, 3]);
// JS case folding, not RE2's: k does not match the Kelvin sign, s not the long s
eq("ci k vs Kelvin", matches(rule({ kind: "regex", pattern: "k+" }), "kK" + chr(0x212a)), ["kK"]);
eq("ci é vs É", matches(rule({ kind: "regex", pattern: "caf[é]" }), "CAF" + chr(0xc9)), ["CAF" + chr(0xc9)]);

// --- colour priority (resolvePaint) -------------------------------------------------
// v1.2.0 inside one layer: the match ending first shows, then the one starting
// last, then the later rule; a higher layer (a tag) beats common.
eq(
  "v1.2.0: a user rule shows inside a longer default match",
  resolvePaint(30, [[2, 22], [6, 13]], [0, 0], [false, false]).spans,
  [2, 6, 0, 6, 13, 1, 13, 22, 0]
);
eq("same range: the later rule", resolvePaint(10, [[0, 5], [0, 5]], [0, 0], [false, false]).spans, [0, 5, 1]);
eq("same range ×3: the last rule", resolvePaint(10, [[0, 5], [0, 5], [0, 5]], [0, 0, 0], [false, false, false]).spans, [0, 5, 2]);
eq("partial overlap: the one ending first", resolvePaint(20, [[0, 10], [5, 15]], [0, 0], [false, false]).spans, [0, 10, 0, 10, 15, 1]);
eq("same end: the one starting last", resolvePaint(20, [[0, 10], [5, 10]], [0, 0], [false, false]).spans, [0, 5, 0, 5, 10, 1]);
eq("a tag beats common over the whole overlap", resolvePaint(30, [[2, 22], [6, 13]], [0, 1], [false, false]).spans, [2, 22, 0]);
eq("common shows where the tag doesn't match", resolvePaint(30, [[6, 13], [2, 22]], [0, 1], [false, false]).spans, [2, 6, 1, 6, 13, 0, 13, 22, 1]);
eq("no overlap: as found, in order", resolvePaint(30, [[10, 12], [0, 3, 20, 25]], [0, 0], [false, false]).spans, [0, 3, 1, 10, 12, 0, 20, 25, 1]);
// line background: the first matching 「줄」 rule (v1.2.0), tags first
eq("tint: first matching line rule", resolvePaint(10, [[0, 1], [2, 3]], [0, 0], [true, true]).tint, 0);
eq("tint: a non-matching line rule doesn't count", resolvePaint(10, [[], [2, 3], [4, 5]], [0, 0, 0], [true, false, true]).tint, 2);
eq("tint: the tag's line rule beats common's", resolvePaint(10, [[4, 5], [0, 1]], [0, 1], [true, true]).tint, 0);
eq("tint: none", resolvePaint(10, [[0, 1]], [0], [false]).tint, -1);

// --- rule kinds ----------------------------------------------------------------
eq("text with spaces", matches(rule({ pattern: "kafka rebalance" }), "10:00 Kafka Rebalance start; kafka rebalance done"), [
  "Kafka Rebalance",
  "kafka rebalance",
]);
eq("text case-sensitive", matches(rule({ pattern: "kafka rebalance", caseSensitive: true }), "Kafka Rebalance / kafka rebalance"), [
  "kafka rebalance",
]);
eq("text is literal, not regex", matches(rule({ pattern: "a.b" }), "axb a.b"), ["a.b"]);
eq("text inside a word", matches(rule({ pattern: "err" }), "error err"), ["err", "err"]);
eq("word only alone", matches(rule({ kind: "word", pattern: "err" }), "error err: xerr"), ["err"]);
eq("regex", matches(rule({ kind: "regex", pattern: "\\d{3}ms" }), "took 120ms and 5ms"), ["120ms"]);
eq("korean text", matches(rule({ pattern: "연결 실패" }), "DB 연결 실패 (재시도)"), ["연결 실패"]);

// --- normalize (old session rules) ---------------------------------------------
eq("old regex:true → regex", normalizeRule({ id: "x", pattern: "a", regex: true })?.kind, "regex");
eq("old regex:false → word", normalizeRule({ id: "x", pattern: "a", regex: false })?.kind, "word");
eq("old no flag → word", normalizeRule({ id: "x", pattern: "a" })?.kind, "word");
eq("new kind kept", normalizeRule({ id: "x", pattern: "a", kind: "text", regex: true })?.kind, "text");
eq("bad kind → from regex", normalizeRule({ id: "x", pattern: "a", kind: "glob", regex: true })?.kind, "regex");
eq("old filter default: info off", normalizeRule({ id: "info", pattern: "a" })?.filter, false);
eq("old filter default: error on", normalizeRule({ id: "error", pattern: "a" })?.filter, true);
eq("old filter default: user rule on", normalizeRule({ id: "k3j2", pattern: "a" })?.filter, true);
eq("explicit filter kept", normalizeRule({ id: "info", pattern: "a", filter: true })?.filter, true);
eq("not an array → defaults", normalizeLogRules(undefined).length, DEFAULT_LOG_RULES.length);
eq("[] stays empty", normalizeLogRules([]).length, 0);
eq(
  "defaults filter",
  DEFAULT_LOG_RULES.map((r) => [r.id, r.filter]),
  [
    ["error", true],
    ["warn", true],
    ["info", false],
    ["debug", false],
    ["time", false],
    ["mk119", true],
  ]
);
eq("defaults are regex kind", DEFAULT_LOG_RULES.every((r) => r.kind === "regex"), true);

// --- tag names -------------------------------------------------------------------
eq("name ok", tagNameProblem("collector", ["Collector", COMMON]), "");
eq("name dup exact", !!tagNameProblem("collector", ["collector"]), true);
eq("name empty", !!tagNameProblem("", []), true);
eq("name lead space", !!tagNameProblem(" a", []), true);
eq("name trail space", !!tagNameProblem("a ", []), true);
eq("name inner space ok", tagNameProblem("kafka 확인", []), "");
eq("name tab", !!tagNameProblem("a\tb", []), true);
eq("name newline", !!tagNameProblem("a\nb", []), true);
eq("name NEL", !!tagNameProblem("a" + chr(0x85) + "b", []), true);
// the table Go's TestTagNameProblem_SharedWithFrontend checks too
for (const c of namesJson as { name: string; ok: boolean }[])
  eq(`name rule shared with Go: ${JSON.stringify(c.name)}`, tagNameProblem(c.name, []) === "", c.ok);
eq("normalizeTagName NFD → NFC", normalizeTagName("e" + chr(0x301)), chr(0xe9));
eq("repair: invisible removed", repairTagName("a" + chr(0x200b) + "b", []), "ab");
eq("repair: RLO removed", repairTagName(chr(0x202e) + "collector", []), "collector");
eq("repair: ends trimmed", repairTagName(" x" + chr(0xfeff), []), "x");
eq("repair: unique", repairTagName("a" + chr(0x200b), ["a"]), "a (2)");
eq("repair: nothing left", repairTagName(chr(0x200b), []), "이름 없는 태그");
eq("repair: long name fits with a suffix", [...repairTagName("가".repeat(150), ["가".repeat(95)])].length <= 100, true);
eq("repair result is a valid name", tagNameProblem(repairTagName("가".repeat(150) + " ", []), []), "");
eq("unique name", uniqueTagName("새 태그", ["새 태그", "새 태그 (2)"]), "새 태그 (3)");

// --- store normalize / migrate -------------------------------------------------
const normNotes: string[] = [];
const norm = normalizeTagStore({
  version: 1,
  tags: [
    { name: "collector", rules: [{ id: "a", pattern: "x", kind: "text" }] },
    { name: "Collector", rules: [] },
    { name: "collector", rules: [] }, // duplicate: kept as "collector (2)"
    { name: " bad", rules: [] }, // invalid: kept as "bad"
  ],
  assign: { dir: { "modules\\lizcollector/": ["collector", "common", "collector"] }, file: { x: "nope" } },
}, normNotes);
eq("normalize: common added first, bad names repaired (not dropped)", norm.tags.map((t) => t.name), [COMMON, "collector", "Collector", "collector (2)", "bad"]);
eq("normalize: a note per repaired name", normNotes.length, 2);
eq("normalize: common gets defaults when missing", norm.tags[0].rules.length, DEFAULT_LOG_RULES.length);
eq("normalize: assign keys/values cleaned", norm.assign, { dir: { "modules/lizcollector": ["collector"] }, file: {}, name: {} });
eq(
  "normalize: common moved first",
  normalizeTagStore({ tags: [{ name: "a", rules: [] }, { name: COMMON, rules: [] }] }).tags.map((t) => t.name),
  [COMMON, "a"]
);
eq("normalize: empty common stays empty", normalizeTagStore({ tags: [{ name: COMMON, rules: [] }] }).tags[0].rules.length, 0);
const mig = migratedStore([{ id: "error", pattern: "ERR", regex: false, color: "#ff0000", line: true }], "T");
eq("migrate from session rules", mig.tags, [
  {
    name: COMMON,
    rules: [
      { id: "error", on: true, label: "", pattern: "ERR", kind: "word", caseSensitive: false, color: "#ff0000", line: true, filter: true },
    ],
    updated: "T",
  },
]);
eq("migrate without session rules → defaults", migratedStore(undefined).tags[0].rules.length, DEFAULT_LOG_RULES.length);

// --- tagsFor ---------------------------------------------------------------------
const store: TagStore = normalizeTagStore({
  version: 1,
  tags: [
    { name: COMMON, rules: [rule({ id: "c1", pattern: "ERROR" })] },
    { name: "collector", rules: [rule({ id: "k1", pattern: "kafka rebalance" })] },
    { name: "Collector", rules: [rule({ id: "K1", pattern: "OTHER" })] },
    { name: "admin", rules: [rule({ id: "a1", pattern: "login" })] },
    { name: "kafka", rules: [rule({ id: "f1", pattern: "ISR" })] },
    { name: "server", rules: [] },
    { name: "syslog", rules: [] },
  ],
  assign: {
    dir: {
      "": ["server"],
      modules: ["Collector"],
      "modules/lizcollector": ["collector", "kafka"],
      "modules/quiet": [],
      "modules/gone": ["deleted-tag"],
    },
    file: {
      "modules/lizcollector/admin.log": ["admin"],
      "modules/lizcollector/plain.log": [],
    },
    name: { messages: ["syslog"], "app.log": ["kafka"] },
  },
});
const B = { root: "C:\\logs\\bromo", servers: ["server1", "server2", "Server3"] };
const L = { root: "/data/bromo", servers: ["server1"] };
type Row = [string, string, string | null, string[], string];
const table: Row[] = [
  // name, path, bundle?, want names, want source
  ["folder tag", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\collector.log", "B", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["same path other server", "C:\\logs\\bromo\\server2\\modules\\lizcollector\\collector.log.2026-10-21_1", "B", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["deeper file inherits nearest folder", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\sub\\x.log", "B", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["file tag overrides folder (rotation)", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\admin.log.2026-10-21", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log"],
  ["file tag rotation .3", "C:\\logs\\bromo\\server2\\modules\\lizcollector\\admin.log.3", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log"],
  ["file tag on the live file too", "C:\\logs\\bromo\\server2\\modules\\lizcollector\\admin.log", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log"],
  ["file tag on a gz rotation", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\admin.log.2026-10-21.1.gz", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log"],
  ["file [] = explicitly none", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\plain.log", "B", [COMMON], "file:modules/lizcollector/plain.log"],
  ["folder [] stops inheritance", "C:\\logs\\bromo\\server1\\modules\\quiet\\q.log", "B", [COMMON], "dir:modules/quiet"],
  ["case-sensitive tag on parent folder", "C:\\logs\\bromo\\server1\\modules\\other\\o.log", "B", [COMMON, "Collector"], "dir:modules"],
  ["server root tag", "C:\\logs\\bromo\\server1\\messages", "B", [COMMON, "server"], "dir:"],
  ["unknown tag skipped", "C:\\logs\\bromo\\server1\\modules\\gone\\g.log", "B", [COMMON], "dir:modules/gone"],
  ["windows path case-insensitive", "c:\\LOGS\\Bromo\\SERVER1\\Modules\\LizCollector\\collector.log", "B", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["forward slashes", "C:/logs/bromo/server3/modules/lizcollector/collector.log", "B", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["not a server folder → name rule", "C:\\logs\\bromo\\notes\\messages", "B", [COMMON, "syslog"], "name:messages"],
  ["file directly in bundle root → name rule", "C:\\logs\\bromo\\messages", "B", [COMMON, "syslog"], "name:messages"],
  ["outside bundle: name", "D:\\tmp\\messages", "B", [COMMON, "syslog"], "name:messages"],
  ["outside bundle: rotated name", "D:\\tmp\\app.log.2026-10-20", null, [COMMON, "kafka"], "name:app.log"],
  ["outside bundle: live name", "D:\\tmp\\app.log", null, [COMMON, "kafka"], "name:app.log"],
  ["outside bundle: messages-date", "D:\\tmp\\messages-20261011", null, [COMMON, "syslog"], "name:messages"],
  ["dot-dot segments are not under a server", "C:\\logs\\bromo\\server1\\..\\server2\\messages", "B", [COMMON, "syslog"], "name:messages"],
  ["outside bundle: no rule", "D:\\tmp\\other.txt", null, [COMMON], "none"],
  ["no path", "", "B", [COMMON], "none"],
  ["linux bundle", "/data/bromo/server1/modules/lizcollector/collector.log", "L", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["linux is case-sensitive for servers", "/data/bromo/SERVER1/modules/lizcollector/collector.log", "L", [COMMON], "none"],
  ["linux is case-sensitive for assign keys", "/data/bromo/server1/Modules/LizCollector/collector.log", "L", [COMMON, "server"], "dir:"],
  ["bundle list: the first bundle holding the path", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\collector.log", "LB", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
];
for (const [name, path, b, want, src] of table) {
  const r = tagsFor(store, path, b === "B" ? B : b === "L" ? L : b === "LB" ? [L, B] : null);
  eq(`tagsFor: ${name}`, r.names, want);
  eq(`tagsFor source: ${name}`, r.source.kind === "none" ? "none" : `${r.source.kind}:${(r.source as any).key}`, src);
}
eq("bundleRel", bundleRel("C:\\logs\\bromo\\server1\\a\\b.log", B), { server: "server1", rel: "a/b.log" });
// rotation key = the live file's name; real names from an rtaskmgr log bundle
const rot: [string, string][] = [
  ["modules/x/collector.log", "modules/x/collector.log"],
  ["modules/x/collector.log.1", "modules/x/collector.log"],
  ["modules/x/collector.log.2026-10-21_1", "modules/x/collector.log"],
  ["kafka/controller.log.2026-10-21-06", "kafka/controller.log"],
  ["state-change.log.2026-10-21-06", "state-change.log"],
  ["messages", "messages"],
  ["messages-20261011", "messages"],
  ["messages.from-20261011", "messages"],
  ["sudo.log.from-20261011", "sudo.log"],
  ["sssd_kcm.log-20261011", "sssd_kcm.log"],
  ["api_debug.log.2026-10-21.1.gz", "api_debug.log"],
  ["clickhouse-server.log.0.gz", "clickhouse-server.log"],
  ["app.log.gz", "app.log"],
  ["gc.log.0.current", "gc.log"],
  ["kafkaServer-gc.log.0.current", "kafkaServer-gc.log"],
  ["app.log.10", "app.log"],
  ["gc-logs-20261021-123456.tar.gz", "gc-logs-20261021-123456.tar.gz"],
  ["zookeeper-root-server-server01.out", "zookeeper-root-server-server01.out"],
  ["2026-10-21", "2026-10-21"],
  ["d.2026-10-21/x.log", "d.2026-10-21/x.log"],
];
for (const [x, want] of rot) eq(`rotationKey(${x})`, rotationKey(x), want);
eq(
  "old stage-3 keys (x.*) are read as the new ones",
  normalizeTagStore({ tags: [{ name: "t", rules: [] }], assign: { file: { "a/b.log.*": ["t"] }, name: { "messages-*": ["t"] } } }).assign,
  { dir: {}, file: { "a/b.log": ["t"] }, name: { messages: ["t"] } }
);
eq("bundleRel: dotted-I root keeps indexes", bundleRel("C:\\" + chr(0x130) + "logs\\s1\\a.log", { root: "C:\\" + chr(0x130) + "logs", servers: ["s1"] }), { server: "s1", rel: "a.log" });

// --- rulesFor: tag rules first (they win), then common --------------------------
eq("rulesFor order", rulesFor(store, [COMMON, "collector", "kafka"]).map((r) => r.id), ["k1", "f1", "c1"]);
eq("rulesFor common only", rulesFor(store, [COMMON]).map((r) => r.id), ["c1"]);
eq("layersFor: one layer per tag, common last", layersFor(store, [COMMON, "collector", "kafka"]).map((l) => l.map((r) => r.id)), [["k1"], ["f1"], ["c1"]]);

// --- old-format common in the session (v1.2.0 downgrade) ------------------------
const legacyStore = normalizeTagStore({
  tags: [
    {
      name: COMMON,
      rules: [
        rule({ id: "t", kind: "text", pattern: "a.b (x)" }),
        rule({ id: "w", kind: "word", pattern: "err" }),
        rule({ id: "r", kind: "regex", pattern: "\\d+ms", line: true }),
      ],
    },
  ],
});
const legacy = legacyLogRules(legacyStore) as any[];
eq("legacy: regex flags", legacy.map((x) => [x.id, x.regex]), [["t", true], ["w", false], ["r", true]]);
eq("legacy: text escaped", legacy[0].pattern, "a\\.b \\(x\\)");
eq("legacy: no kind field (v1.2.0 would ignore it, but a migration must not read it)", "kind" in legacy[0], false);
eq("legacy text means the same in v1.2.0", [..."z a.b (x) axb (x)".matchAll(new RegExp(legacy[0].pattern, "gi"))].map((m) => m.index), [2]);
eq("legacy round trip through the migration", migratedStore(legacy).tags[0].rules.map((r) => [r.id, r.kind, r.pattern]), [
  ["t", "regex", "a\\.b \\(x\\)"],
  ["w", "word", "err"],
  ["r", "regex", "\\d+ms"],
]);

// --- edits -------------------------------------------------------------------------
const ren = renameTag(store, "collector", "lizcollector", "T");
eq("rename: assign follows", ren.assign.dir["modules/lizcollector"], ["lizcollector", "kafka"]);
eq("rename: Collector untouched", ren.assign.dir["modules"], ["Collector"]);
eq("rename common refused", renameTag(store, COMMON, "x") === store, true);
const del = deleteTag(store, "admin");
eq("delete: file key removed → inherits", del.assign.file["modules/lizcollector/admin.log"], undefined);
eq(
  "delete: inherited after delete",
  tagsFor(del, "C:\\logs\\bromo\\server1\\modules\\lizcollector\\admin.log.1", B).names,
  [COMMON, "collector", "kafka"]
);
eq("delete: other list shrinks", deleteTag(store, "kafka").assign.dir["modules/lizcollector"], ["collector"]);
eq("delete common refused", deleteTag(store, COMMON) === store, true);
eq("placesOf", placesOf(store, "kafka"), [
  { kind: "dir", key: "modules/lizcollector" },
  { kind: "name", key: "app.log" },
]);

console.log(`unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
