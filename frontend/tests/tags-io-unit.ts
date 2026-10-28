// Pure-function tests for tag export / import (logTagsIO.ts).
// Run: node frontend/tests/run-unit.cjs
import { DEFAULT_LOG_RULES, type LogRule } from "../src/logHighlight";
import { COMMON, normalizeTagStore, type TagStore } from "../src/logTags";
import {
  EXPORT_EXT,
  exportFileName,
  exportPayload,
  importRule,
  importTagName,
  renamedTagName,
  runImport,
  sameRules,
  summaryDetails,
  summaryLine,
  type AskConflict,
  type ImportChoice,
  type ImportConflict,
  type ImportFile,
} from "../src/logTagsIO";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}

const R = (p: Partial<LogRule>): LogRule => ({
  id: "r" + Math.random(),
  on: true,
  label: "",
  pattern: "x",
  kind: "text",
  caseSensitive: false,
  color: "#c678dd",
  line: false,
  filter: true,
  ...p,
});
const NOW = "2026-10-27T01:00:00.000Z";
let n = 0;
const ids = () => "id" + n++;

const store0 = (): TagStore =>
  normalizeTagStore({
    version: 1,
    tags: [
      { name: COMMON, rules: [R({ pattern: "ERROR", color: "#ff0000", line: true })], updated: "a" },
      { name: "collector", rules: [R({ pattern: "kafka rebalance" })], updated: "b" },
      { name: "admin", rules: [R({ pattern: "login", kind: "word" })], updated: "c" },
    ],
    assign: { dir: { "modules/lizcollector": ["collector"] }, file: {}, name: {} },
  });

// ---- export payload ----------------------------------------------------------
{
  const s = store0();
  const js = exportPayload(s, ["admin", "collector", "nope"], NOW);
  const v = JSON.parse(js);
  eq("export envelope", [v.format, v.version, v.exported], ["chipper-tags", 1, NOW]);
  eq("export tags in store order, unknown skipped", v.tags.map((t: any) => t.name), ["collector", "admin"]);
  // stage 5 fix: rule ids travel (common's default ids "error", "warn" … survive a round trip)
  eq("export rule fields (with id)", Object.keys(v.tags[0].rules[0]), ["id", "on", "label", "pattern", "kind", "caseSensitive", "color", "line", "filter"]);
  eq("export has no assign / updated", ["assign" in v, "updated" in v.tags[0]], [false, false]);
  eq("export common", JSON.parse(exportPayload(s, [COMMON], NOW)).tags[0].rules[0].pattern, "ERROR");
  eq("export ends with newline", js.endsWith("}\n"), true);
}
// 10-28 .18: export dropped lineHead (「레벨 자리만 줄 배경」), so a round trip
// changed the default 오류 rule and re-importing common asked 「바뀜 1」.
{
  const withHead = DEFAULT_LOG_RULES.filter((r) => r.lineHead);
  eq("defaults have a lineHead rule", withHead.length > 0, true);
  const s = normalizeTagStore({ version: 1, tags: [{ name: COMMON, rules: DEFAULT_LOG_RULES, updated: "" }], assign: { dir: {}, file: {}, name: {} } });
  const out = JSON.parse(exportPayload(s, [COMMON], NOW)).tags[0].rules;
  eq("export keeps lineHead", out.filter((r: any) => r.lineHead).map((r: any) => r.lineHead), withHead.map((r) => r.lineHead));
  const back = out.map((r: any) => (importRule(r) as { rule?: LogRule }).rule);
  eq("round trip: every rule imports", back.every(Boolean), true);
  eq("round trip: same rules", sameRules(back as LogRule[], s.tags[0].rules), true);
}

// ---- file names ----------------------------------------------------------------
eq("file name: tag", exportFileName("collector"), "collector" + EXPORT_EXT);
eq("file name: Windows-illegal characters", exportFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j" + EXPORT_EXT);
eq("file name: trailing dots/spaces", exportFileName(" team. "), "team" + EXPORT_EXT);
eq("file name: already has extension", exportFileName("x.chipper-tags.json"), "x" + EXPORT_EXT);
eq("file name: .json", exportFileName("x.json"), "x" + EXPORT_EXT);
eq("file name: empty", exportFileName("  "), "");
eq("file name: Korean", exportFileName("수집기 태그"), "수집기 태그" + EXPORT_EXT);

// ---- importRule ----------------------------------------------------------------
{
  const ok = (x: unknown) => {
    const r = importRule(x, () => "id");
    return "rule" in r ? r.rule : r.problem;
  };
  eq("rule: only pattern → defaults (text, on, filter)", ok({ pattern: "kafka rebalance" }), {
    id: "id",
    on: true,
    label: "",
    pattern: "kafka rebalance",
    kind: "text",
    caseSensitive: false,
    color: "#c678dd",
    line: false,
    filter: true,
  });
  eq("rule: old regex:false → word", (ok({ pattern: "err", regex: false }) as LogRule).kind, "word");
  eq("rule: old regex:true → regex", (ok({ pattern: "\\d+", regex: true }) as LogRule).kind, "regex");
  eq("rule: #RGB expands, lower-cased", (ok({ pattern: "a", color: "#F0A" }) as LogRule).color, "#ff00aa");
  eq("rule: #RRGGBB lower-cased", (ok({ pattern: "a", color: "#ABCDEF" }) as LogRule).color, "#abcdef");
  eq("rule: unknown fields ignored", Object.keys(ok({ pattern: "a", shiny: 1, id: "theirs", updated: "x" }) as LogRule).includes("shiny"), false);
  eq("rule: their id kept (stage 5 fix)", (ok({ pattern: "a", id: "theirs" }) as LogRule).id, "theirs");
  eq("rule: a non-text id is not", (ok({ pattern: "a", id: 7 }) as LogRule).id, "id");
  eq("rule: non-boolean flag → default", (ok({ pattern: "a", line: "yes", on: 0 }) as LogRule).line === false, true);
  const bad: [string, unknown, string][] = [
    ["not an object", "kafka", "{ } 형식"],
    ["array", ["a"], "{ } 형식"],
    ["null", null, "{ } 형식"],
    ["no pattern", { kind: "text" }, "패턴(pattern)이 없거나"],
    ["pattern number", { pattern: 5 }, "패턴(pattern)이 없거나"],
    ["empty pattern", { pattern: "" }, "비어 있음"],
    ["huge pattern", { pattern: "a".repeat(10001) }, "너무 김"],
    ["unknown kind", { pattern: "a", kind: "glob" }, "모르는 종류 「glob」"],
    ["bad colour name", { pattern: "a", color: "red" }, "잘못된 색 「red」"],
    ["bad colour hex", { pattern: "a", color: "#12345g" }, "잘못된 색"],
    ["colour number", { pattern: "a", color: 123 }, "잘못된 색"],
    // the reason is ruleCheck's (stage 3, RE2) — the same words as the tag window
    ["invalid regex", { pattern: "(abc", kind: "regex" }, "괄호 짝이 맞지 않습니다"],
    ["regex matching empty", { pattern: "a*", kind: "regex" }, "빈 글자에도 걸리는 정규식"],
    ["RE2: look-behind", { pattern: "(?<=x)a", kind: "regex" }, "뒤돌아보기"],
    ["RE2: back reference", { pattern: String.raw`(a)\1`, kind: "regex" }, "역참조"],
  ];
  for (const [name, x, want] of bad) {
    const r = ok(x);
    eq("rule refused: " + name, typeof r === "string" && r.includes(want), true);
    if (typeof r !== "string" || !r.includes(want)) fails.push("   (" + name + " gave " + JSON.stringify(r) + ")");
  }
  eq("rule: slow pattern as text is fine", typeof ok({ pattern: "(a|aa)+$", kind: "text" }), "object");
  // RE2 runs in linear time, so the old 「slow」 regexes are usable now
  eq("rule: (a|aa)+$ regex is fine with RE2", typeof ok({ pattern: "(a|aa)+$", kind: "regex" }), "object");
  eq("rule: (a+)+ regex is fine with RE2", typeof ok({ pattern: "(a+)+", kind: "regex" }), "object");
  // import names go through stage 3's normalizeTagName + tagNameProblem
  eq("name: NFD → NFC", importTagName("cafe\u0301"), { name: "caf\u00e9", problem: "" });
  eq("name: zero-width refused", importTagName("a\u200bb").problem !== "", true);
  eq("name: bidi control refused", importTagName("a\u202eb").problem !== "", true);
}

// ---- sameRules ------------------------------------------------------------------
{
  const a = [R({ id: "1", label: "mine", pattern: "x", color: "#AABBCC" })];
  // 판정 ③ (stage 5 fix): the label counts — only ids and colour case don't
  eq("same: ids, colour case ignored", sameRules(a, [R({ id: "2", label: "mine", pattern: "x", color: "#aabbcc" })]), true);
  for (const k of ["label", "kind", "pattern", "caseSensitive", "color", "line", "filter", "on"] as const) {
    const changed: Partial<LogRule> =
      k === "label" ? { label: "theirs" } : k === "kind" ? { kind: "word" } : k === "pattern" ? { pattern: "y" } : k === "color" ? { color: "#000000" } : { [k]: !a[0][k] };
    eq("differs on " + k, sameRules(a, [R({ ...a[0], ...changed })]), false);
  }
  eq("differs on order", sameRules([R({ pattern: "a" }), R({ pattern: "b" })], [R({ pattern: "b" }), R({ pattern: "a" })]), false);
  eq("differs on count", sameRules(a, []), false);
  eq("both empty same", sameRules([], []), true);
}

// ---- renamedTagName ----------------------------------------------------------
eq("rename: (2)", renamedTagName("collector", ["collector"]), "collector (2)");
eq("rename: (3) when (2) taken", renamedTagName("collector", ["collector", "collector (2)"]), "collector (3)");
eq("rename: stays within 100 chars", [...renamedTagName("가".repeat(100), [])].length <= 100, true);
eq("rename: common", renamedTagName(COMMON, [COMMON]), "common (2)");

// ---- runImport ------------------------------------------------------------------
const file = (name: string, tags: { name: string; rules: unknown[] }[], extra: Partial<ImportFile> = {}): ImportFile => ({
  path: "C:\\in\\" + name,
  file: name,
  error: "",
  tags,
  problems: [],
  ...extra,
});
const er = (r: LogRule) => ({ pattern: r.pattern, kind: r.kind, caseSensitive: r.caseSensitive, color: r.color, line: r.line, filter: r.filter, on: r.on });
// scripted answers; records the questions
function script(answers: ({ choice: ImportChoice; all?: boolean } | null)[]) {
  const asked: ImportConflict[] = [];
  const ask: AskConflict = async (c) => {
    asked.push(c);
    const a = answers.shift();
    if (a === undefined) throw new Error("unexpected question for " + c.name);
    return a ? { choice: a.choice, all: !!a.all } : null;
  };
  return { asked, ask };
}

(async () => {
  const s = store0();
  const sameCommon = s.tags[0].rules.map(er);
  const sameCollector = s.tags[1].rules.map(er);
  // 1. none / same / different×3, plus a case-different name, plus common
  {
    const { asked, ask } = script([{ choice: "overwrite" }, { choice: "skip" }, { choice: "rename" }]);
    const f = file("team.chipper-tags.json", [
      { name: "kafka", rules: [{ pattern: "rebalance" }] }, // new
      { name: "collector", rules: [{ ...sameCollector[0], id: "zz" }] }, // same content (other id; a label difference would be asked — tags-io-fix-unit)
      { name: "Collector", rules: [{ pattern: "UPPER" }] }, // case-different → new, no question
      { name: COMMON, rules: [{ pattern: "FATAL", color: "#ff0000" }] }, // differs → overwrite
      { name: "admin", rules: [{ pattern: "logout" }] }, // differs → skip
    ]);
    const f2 = file("b.chipper-tags.json", [{ name: "collector", rules: [{ pattern: "theirs" }] }]); // differs → rename
    const { store: out, summary } = await runImport(s, [f, f2], ask, NOW, ids);
    eq("asked about common, admin, collector (not Collector)", asked.map((c) => c.name), [COMMON, "admin", "collector"]);
    eq("common question flagged", asked[0].isCommon, true);
    eq("question carries counts and file", [asked[1].mine, asked[1].theirs, asked[1].file], [1, 1, "team.chipper-tags.json"]);
    eq("question offers the new name", asked[2].renameTo, "collector (2)");
    eq("left counts the clashes still to come", asked.map((c) => c.left), [2, 1, 0]);
    eq("added", summary.added, ["kafka", "Collector"]);
    eq("same", summary.same, ["collector"]);
    eq("overwritten", summary.overwritten, [COMMON]);
    eq("skipped", summary.skipped, ["admin"]);
    eq("renamed", summary.renamed, [{ from: "collector", to: "collector (2)" }]);
    eq("store names", out.tags.map((t) => t.name), [COMMON, "collector", "admin", "kafka", "Collector", "collector (2)"]);
    eq("common overwritten", out.tags[0].rules.map((r) => r.pattern), ["FATAL"]);
    eq("overwritten common updated", out.tags[0].updated, NOW);
    eq("skipped admin untouched", out.tags[2].rules.map((r) => r.pattern), ["login"]);
    eq("same collector untouched (keeps ids, updated)", [out.tags[1].rules[0].id, out.tags[1].updated], [s.tags[1].rules[0].id, s.tags[1].updated]);
    eq("assign untouched", out.assign, s.assign);
    eq("original store not mutated", s.tags[0].rules.map((r) => r.pattern), ["ERROR"]);
    eq("summary line", summaryLine(summary), "추가 2 · 덮어씀 1 · 건너뜀 2 · 이름 바꿔 추가 1 · 잘못된 규칙 0");
    eq("summary details", summaryDetails(summary), [
      "추가: 「kafka」, 「Collector」",
      "덮어씀: 「common」",
      "건너뜀(내 태그와 내용이 같음): 「collector」",
      "건너뜀(고르신 대로): 「admin」",
      "이름 바꿔 추가: 「collector」 → 「collector (2)」",
    ]);
  }
  // 2. 「나머지도 모두 같게」
  {
    const { asked, ask } = script([{ choice: "overwrite", all: true }]);
    const f = file("x", [
      { name: COMMON, rules: [] },
      { name: "collector", rules: [{ pattern: "a" }] },
      { name: "admin", rules: [{ pattern: "b" }] },
    ]);
    const { store: out, summary } = await runImport(s, [f], ask, NOW, ids);
    eq("all: asked once", asked.length, 1);
    eq("all: every clash overwritten", summary.overwritten, [COMMON, "collector", "admin"]);
    eq("all: emptied common imported as empty (someone who clears common)", out.tags[0].rules.length, 0);
    const r2 = script([{ choice: "rename", all: true }]);
    const res2 = await runImport(s, [f], r2.ask, NOW, ids);
    eq("all rename", res2.summary.renamed.map((r) => r.to), ["common (2)", "collector (2)", "admin (2)"]);
    const r3 = script([{ choice: "skip", all: true }]);
    const res3 = await runImport(s, [f], r3.ask, NOW, ids);
    eq("all skip → store unchanged (same object)", res3.store === s, true);
    eq("all skip summary", summaryLine(res3.summary), "추가 0 · 덮어씀 0 · 건너뜀 3 · 이름 바꿔 추가 0 · 잘못된 규칙 0");
  }
  // 3. cancel (Esc) → nothing
  {
    const { ask } = script([{ choice: "overwrite" }, null]);
    const f = file("x", [
      { name: "new1", rules: [{ pattern: "n" }] },
      { name: COMMON, rules: [{ pattern: "a" }] },
      { name: "collector", rules: [{ pattern: "b" }] },
    ]);
    const { store: out, summary } = await runImport(s, [f], ask, NOW, ids);
    eq("cancel: store unchanged", out === s, true);
    eq("cancel flagged", summary.canceled, true);
  }
  // 4. bad rules filtered, bad files / tags reported, sames with dropped rules
  {
    const LOOKBEHIND = "뒤돌아보기 (?<= / (?<! 는 Go(RE2) 정규식에서 지원하지 않습니다";
    const { ask } = script([]);
    const files: ImportFile[] = [
      file("bad.chipper-tags.json", [
        {
          name: "mixed",
          rules: [{ pattern: "ok" }, { pattern: "(?<=x)a", kind: "regex" }, { pattern: "x", color: "blue" }, { pattern: "(", kind: "regex" }, 7],
        },
        { name: "allbad", rules: [{ pattern: "(", kind: "regex" }] },
        { name: "empty", rules: [] },
        { name: "collector", rules: [...sameCollector, { pattern: "x", color: "nope" }] }, // same once the bad rule is dropped
      ], { problems: ["2번째 태그: 이름(name)이 없거나 글자가 아니라 뺐습니다"] }),
      file("notes.txt", [], { error: "chipper 태그 파일이 아닙니다 (\"format\": \"chipper-tags\" 가 없음)", tags: null, problems: null }),
      file("odd.json", [{ name: " lead", rules: [] }]),
    ];
    const { store: out, summary } = await runImport(s, files, ask, NOW, ids);
    eq("bad: added", summary.added, ["mixed", "empty"]);
    eq("bad: mixed keeps the good rule", out.tags.find((t) => t.name === "mixed")?.rules.map((r) => r.pattern), ["ok"]);
    eq("bad: same after dropping bad rule", summary.same, ["collector"]);
    eq("bad rules counted", summary.badRules.length, 6);
    eq(
      "bad rule reasons",
      summary.badRules.map((b) => b.replace(/^.*: /, "")),
      [LOOKBEHIND, "잘못된 색 「blue」(#rrggbb 형식이어야 함)", "괄호 짝이 맞지 않습니다", "규칙이 { } 형식이 아님", "괄호 짝이 맞지 않습니다", "잘못된 색 「nope」(#rrggbb 형식이어야 함)"]
    );
    eq("bad rule message names file, tag, position, pattern", summary.badRules[0], "bad.chipper-tags.json · mixed · 2번째 규칙 「(?<=x)a」: " + LOOKBEHIND);
    eq("not imported: Go problem, all-bad tag, file error, odd name", summary.notImported.length, 4);
    eq("not imported: all-bad tag", summary.notImported.some((x) => x.includes("「allbad」 는 규칙이 모두 잘못돼")), true);
    eq("not imported: file error", summary.notImported.some((x) => x.startsWith("notes.txt: chipper 태그 파일이 아닙니다")), true);
    eq("not imported: odd name re-checked", summary.notImported.some((x) => x.includes("odd.json") && x.includes("공백")), true);
    eq("summary line with failures", summaryLine(summary), "추가 2 · 덮어씀 0 · 건너뜀 1 · 이름 바꿔 추가 0 · 잘못된 규칙 6 · 가져오지 못함 4");
  }
  // 5. two files with the same new tag: second compares against the first
  {
    const { asked, ask } = script([{ choice: "overwrite" }]);
    const files = [file("a", [{ name: "kafka", rules: [{ pattern: "one" }] }]), file("b", [{ name: "kafka", rules: [{ pattern: "two" }] }]), file("c", [{ name: "kafka", rules: [{ pattern: "two" }] }])];
    const { store: out, summary } = await runImport(s, files, ask, NOW, ids);
    eq("multi-file: second file clashes with the first", asked.map((c) => c.file), ["b"]);
    eq("multi-file: third same as overwritten", summary.same, ["kafka"]);
    eq("multi-file: result", out.tags.find((t) => t.name === "kafka")?.rules.map((r) => r.pattern), ["two"]);
  }
  // 6. a round trip of one's own export is all "same"
  {
    const { ask } = script([]);
    const v = JSON.parse(exportPayload(s, s.tags.map((t) => t.name), NOW));
    const { store: out, summary } = await runImport(s, [file("me", v.tags)], ask, NOW, ids);
    eq("round trip: all same, store unchanged", [summary.same, out === s], [[COMMON, "collector", "admin"], true]);
    // and into an empty home: defaults common differs from exported common → question
    const fresh = normalizeTagStore({ version: 1, tags: [] });
    eq("fresh home has default common", fresh.tags[0].rules.length, DEFAULT_LOG_RULES.length);
    const r = script([{ choice: "overwrite" }]);
    const res = await runImport(fresh, [file("me", v.tags)], r.ask, NOW, ids);
    eq("into a fresh home: added + common overwritten", [res.summary.added, res.summary.overwritten], [["collector", "admin"], [COMMON]]);
    eq("rule ids unique after import", new Set(res.store.tags.flatMap((t) => t.rules.map((x) => x.id))).size, res.store.tags.reduce((a, t) => a + t.rules.length, 0));
  }

  console.log(`io-unit: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  if (fails.length) process.exit(1);
})();
