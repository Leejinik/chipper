// Pure-function tests for log colour tags and rule kinds.
// Run: node frontend/tests/run-unit.cjs   (bundles this file with esbuild, then runs it)
import {
  DEFAULT_LOG_RULES,
  compileRule,
  normalizeLogRules,
  normalizeRule,
  riskyRegex,
  ruleProblem,
  type LogRule,
} from "../src/logHighlight";
import {
  COMMON,
  bundleRel,
  deleteTag,
  migratedStore,
  normalizeTagStore,
  placesOf,
  renameTag,
  rotationKey,
  rulesFor,
  tagNameProblem,
  tagsFor,
  uniqueTagName,
  type TagStore,
} from "../src/logTags";

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
  const re = compileRule(r);
  return re ? [...line.matchAll(re)].map((m) => m[0]) : ["<null>"];
};

// --- risky regex ---------------------------------------------------------------
const risky = [
  "(a|aa)+$",
  "(a|aa)+",
  "(?:a|aa)+$",
  "(a|ab)*",
  "(a+)+",
  "(\\w*)*",
  "(x|y+){2,}",
  "(.|x)+",
  "(a?b|b)+",
  "(\\d|1)+",
  "((a)|a)+",
  "(a|b|ab)+c",
  "(foo|f)+",
  "(A|a)+", // case-insensitive overlap counts too
  "x(a|aa){3,}y",
  "(a+){5}",
  "((\\d{1,3}\\.){3})+",
  "((a|aa))+", // ambiguous alternation nested in a repeated group
  "((ab|a)c)+", // not actually slow, but refused on the safe side
];
const riskyWant = risky.map(() => true);
risky.forEach((p, i) => eq(`riskyRegex(${p})`, riskyRegex(p), riskyWant[i]));
const safe = [
  "(INFO|NOTICE)+",
  "(ab)+",
  "\\d{4}-\\d\\d",
  "(foo|bar){2}",
  "(a|b)?",
  "[(]+",
  "\\(a|aa\\)+",
  "(abc){1}",
  "a{2}",
  "x{",
  "(error|warn)\\b",
  "(?<=x)(a|b)+",
  "\\b(\\d{1,3}\\.){3}\\d{1,3}\\b", // IP address: small bounded repeat
  "(a|aa){3}",
  "(\\w+\\s){1,4}",
];
for (const p of safe) eq(`riskyRegex(${p}) safe`, riskyRegex(p), false);
for (const r of DEFAULT_LOG_RULES) eq(`default rule ${r.id} not risky`, riskyRegex(r.pattern), false);
eq("ruleProblem slow", ruleProblem(rule({ kind: "regex", pattern: "(a|aa)+$" })), "slow");
eq("text kind with the same characters is fine", ruleProblem(rule({ kind: "text", pattern: "(a|aa)+$" })), "");
eq("compileRule refuses slow", compileRule(rule({ kind: "regex", pattern: "(a|aa)+$" })), null);
eq("ruleProblem invalid", ruleProblem(rule({ kind: "regex", pattern: "(" })), "invalid");
eq("ruleProblem matches empty", ruleProblem(rule({ kind: "regex", pattern: "x*" })), "invalid");

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
eq("name NEL", !!tagNameProblem("a\u0085b", []), true);
eq("unique name", uniqueTagName("새 태그", ["새 태그", "새 태그 (2)"]), "새 태그 (3)");

// --- store normalize / migrate -------------------------------------------------
const norm = normalizeTagStore({
  version: 1,
  tags: [
    { name: "collector", rules: [{ id: "a", pattern: "x", kind: "text" }] },
    { name: "Collector", rules: [] },
    { name: "collector", rules: [] }, // duplicate: dropped
    { name: " bad", rules: [] }, // invalid: dropped
  ],
  assign: { dir: { "modules\\lizcollector/": ["collector", "common", "collector"] }, file: { x: "nope" } },
});
eq("normalize: common added first", norm.tags.map((t) => t.name), [COMMON, "collector", "Collector"]);
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
      "modules/lizcollector/admin.log.*": ["admin"],
      "modules/lizcollector/plain.log": [],
    },
    name: { messages: ["syslog"], "app.log.*": ["kafka"] },
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
  ["file tag overrides folder (rotation)", "C:\\logs\\bromo\\server1\\modules\\lizcollector\\admin.log.2026-10-21", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log.*"],
  ["file tag rotation .3", "C:\\logs\\bromo\\server2\\modules\\lizcollector\\admin.log.3", "B", [COMMON, "admin"], "file:modules/lizcollector/admin.log.*"],
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
  ["outside bundle: rotated name", "D:\\tmp\\app.log.2026-10-20", null, [COMMON, "kafka"], "name:app.log.*"],
  ["outside bundle: no rule", "D:\\tmp\\other.txt", null, [COMMON], "none"],
  ["no path", "", "B", [COMMON], "none"],
  ["linux bundle", "/data/bromo/server1/modules/lizcollector/collector.log", "L", [COMMON, "collector", "kafka"], "dir:modules/lizcollector"],
  ["linux is case-sensitive for servers", "/data/bromo/SERVER1/modules/lizcollector/collector.log", "L", [COMMON], "none"],
];
for (const [name, path, b, want, src] of table) {
  const r = tagsFor(store, path, b === "B" ? B : b === "L" ? L : null);
  eq(`tagsFor: ${name}`, r.names, want);
  eq(`tagsFor source: ${name}`, r.source.kind === "none" ? "none" : `${r.source.kind}:${(r.source as any).key}`, src);
}
eq("bundleRel", bundleRel("C:\\logs\\bromo\\server1\\a\\b.log", B), { server: "server1", rel: "a/b.log" });
eq("rotationKey", rotationKey("modules/x/collector.log.2026-10-21_1"), "modules/x/collector.log.*");
eq("rotationKey messages-", rotationKey("messages-20261011"), "messages-*");

// --- rulesFor: tag rules first (they win), then common --------------------------
eq("rulesFor order", rulesFor(store, [COMMON, "collector", "kafka"]).map((r) => r.id), ["k1", "f1", "c1"]);
eq("rulesFor common only", rulesFor(store, [COMMON]).map((r) => r.id), ["c1"]);

// --- edits -------------------------------------------------------------------------
const ren = renameTag(store, "collector", "lizcollector", "T");
eq("rename: assign follows", ren.assign.dir["modules/lizcollector"], ["lizcollector", "kafka"]);
eq("rename: Collector untouched", ren.assign.dir["modules"], ["Collector"]);
eq("rename common refused", renameTag(store, COMMON, "x") === store, true);
const del = deleteTag(store, "admin");
eq("delete: file key removed → inherits", del.assign.file["modules/lizcollector/admin.log.*"], undefined);
eq(
  "delete: inherited after delete",
  tagsFor(del, "C:\\logs\\bromo\\server1\\modules\\lizcollector\\admin.log.1", B).names,
  [COMMON, "collector", "kafka"]
);
eq("delete: other list shrinks", deleteTag(store, "kafka").assign.dir["modules/lizcollector"], ["collector"]);
eq("delete common refused", deleteTag(store, COMMON) === store, true);
eq("placesOf", placesOf(store, "kafka"), [
  { kind: "dir", key: "modules/lizcollector" },
  { kind: "name", key: "app.log.*" },
]);

console.log(`unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
