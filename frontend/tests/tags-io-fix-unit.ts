// Stage 5 fixes (stage5-fix.md): label compared, rule differences in the clash
// question, 「나머지 N개」 across files, rule ids kept, label checks, limits, one
// name maker, assignments in export/import, speed.
// Run: node frontend/tests/run-unit.cjs
import { type LogRule } from "../src/logHighlight";
import { COMMON, normalizeTagStore, uniqueTagName, type TagStore } from "../src/logTags";
import {
  exportPayload,
  importRule,
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
const ids = () => "new" + n++;
const file = (name: string, tags: { name: string; rules: unknown[] }[], extra: Partial<ImportFile> & { assign?: unknown } = {}): ImportFile =>
  ({ path: "C:\\in\\" + name, file: name, error: "", tags, problems: [], ...extra } as ImportFile);
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
const store = (tags: { name: string; rules: LogRule[] }[], assign: any = {}): TagStore =>
  normalizeTagStore({ version: 1, tags: tags.map((t) => ({ ...t, updated: "old" })), assign: { dir: {}, file: {}, name: {}, ...assign } });

(async () => {
  // ---- 판정 med 1 / 되묻기 ③: label is compared --------------------------------
  eq("label: only the label differs → not the same", sameRules([R({ id: "1", label: "mine" })], [R({ id: "2", label: "theirs" })]), false);
  eq("label: ids and colour case still don't count", sameRules([R({ id: "1", color: "#AABBCC" })], [R({ id: "2", color: "#aabbcc" })]), true);
  {
    const s = store([{ name: COMMON, rules: [] }, { name: "admin", rules: [R({ id: "a", pattern: "login", label: "old name" })] }]);
    const { asked, ask } = script([{ choice: "overwrite" }]);
    const res = await runImport(s, [file("f", [{ name: "admin", rules: [{ id: "a", pattern: "login", label: "new name" }] }])], ask, NOW, ids);
    eq("label-only change is asked about", asked.map((c) => c.name), ["admin"]);
    eq("label-only change arrives when overwritten", res.store.tags[1].rules[0].label, "new name");
  }

  // ---- 판정 med 2 / 되묻기 ②: what differs, in the question -----------------------
  {
    const mine = [
      R({ id: "error", pattern: "ERROR", color: "#ff0000", line: true }),
      R({ id: "warn", pattern: "WARN", color: "#ffaa00" }),
      R({ id: "info", pattern: "INFO", label: "정보" }),
      R({ id: "k", pattern: "kafka" }),
    ];
    const s = store([{ name: COMMON, rules: mine }]);
    const theirs = [
      { id: "error", pattern: "ERROR", color: "#0000ff", line: true }, // colour changed
      { id: "info", pattern: "INFO", label: "INFO 줄" }, // label changed
      { pattern: "FATAL", color: "#ff0000" }, // added
      { id: "k2", pattern: "kafka" }, // same content, other id → paired by content
      { pattern: "(?<=x)a", kind: "regex" }, // dropped (RE2)
      { pattern: "y", color: "red" }, // dropped (colour)
    ];
    const { asked, ask } = script([{ choice: "skip" }]);
    await runImport(s, [file("team", [{ name: COMMON, rules: theirs }])], ask, NOW, ids);
    const c: any = asked[0];
    eq("diff counts", c?.diff && [c.diff.added.length, c.diff.removed.length, c.diff.changed.length], [1, 1, 2]);
    eq("diff: added lists the pattern", c?.diff?.added?.[0]?.includes("FATAL"), true);
    eq("diff: removed lists the pattern", c?.diff?.removed?.[0]?.includes("WARN"), true);
    eq("diff: colour change described", c?.diff?.changed?.some((x: string) => x.includes("ERROR") && x.includes("#ff0000") && x.includes("#0000ff")), true);
    eq("diff: label change described", c?.diff?.changed?.some((x: string) => x.includes("이름표") && x.includes("정보") && x.includes("INFO 줄")), true);
    eq("question says how many bad rules were left out", c?.dropped, 2);
    eq("question counts the usable rules", [c?.mine, c?.theirs], [4, 4]);
    // order only
    const s2 = store([{ name: "t", rules: [R({ id: "1", pattern: "a" }), R({ id: "2", pattern: "b" })] }]);
    const q2 = script([{ choice: "skip" }]);
    await runImport(s2, [file("f", [{ name: "t", rules: [{ id: "2", pattern: "b" }, { id: "1", pattern: "a" }] }])], q2.ask, NOW, ids);
    const d2: any = (q2.asked[0] as any)?.diff;
    eq("diff: only the order differs", d2 && [d2.added.length, d2.removed.length, d2.changed.length, d2.reordered], [0, 0, 0, true]);
  }

  // ---- 판정 low: 「나머지 N개」 counts clashes across files; 「방금 가져온 태그」 ------
  {
    const s = store([{ name: COMMON, rules: [] }, { name: "collector", rules: [R({ pattern: "mine" })] }]);
    const { asked, ask } = script([{ choice: "skip" }, { choice: "skip" }]);
    await runImport(
      s,
      [file("A", [{ name: "collector", rules: [{ pattern: "a" }] }, { name: "kafka", rules: [{ pattern: "1" }] }]), file("B", [{ name: "kafka", rules: [{ pattern: "2" }] }])],
      ask,
      NOW,
      ids
    );
    eq("left counts B's kafka (clashes with A's, added in this import)", asked.map((c) => [c.name, c.file, c.left]), [
      ["collector", "A", 1],
      ["kafka", "B", 0],
    ]);
    eq("a tag from an earlier file of this import is named as such", asked.map((c: any) => c.mineFrom ?? null), ["", "A"]);
    // sticky answers now really cover it: one question
    const q = script([{ choice: "overwrite", all: true }]);
    const r = await runImport(
      s,
      [file("A", [{ name: "collector", rules: [{ pattern: "a" }] }, { name: "kafka", rules: [{ pattern: "1" }] }]), file("B", [{ name: "kafka", rules: [{ pattern: "2" }] }])],
      q.ask,
      NOW,
      ids
    );
    eq("「모두 같게」 offered and covering the cross-file clash", [q.asked.length, q.asked[0].left, r.summary.overwritten], [1, 1, ["collector", "kafka"]]);
  }

  // ---- 판정 low: incoming rule ids kept unless they clash ----------------------------
  {
    const s = store([{ name: COMMON, rules: [R({ id: "error", pattern: "ERROR" })] }]);
    const exported = JSON.parse(exportPayload(s, [COMMON], NOW));
    eq("export carries rule ids", exported.tags[0].rules[0].id, "error");
    const { ask } = script([{ choice: "overwrite" }]);
    const res = await runImport(
      s,
      [file("f", [{ name: COMMON, rules: [{ id: "error", pattern: "ERROR!" }, { id: "warn", pattern: "WARN" }, { id: "warn", pattern: "W2" }, { pattern: "no id" }] }])],
      ask,
      NOW,
      ids
    );
    const got = res.store.tags[0].rules.map((r) => r.id);
    eq("ids kept: error, warn", got.slice(0, 2), ["error", "warn"]);
    eq("a repeated id in the same tag gets a new one", got[2] !== "warn" && got[2].startsWith("new"), true);
    eq("no id → a new one", got[3].startsWith("new"), true);
    eq("odd ids are not kept", importRule({ pattern: "a", id: "a\u202eb" }, () => "fresh") && (importRule({ pattern: "a", id: "a\u202eb" }, () => "fresh") as any).rule?.id, "fresh");
  }

  // ---- 판정 low: label checked like a name ---------------------------------------------
  for (const [what, label] of [
    ["bidi control", "a\u202eb"],
    ["zero width", "a\u200bb"],
    ["control", "a\u0000b"],
    ["line break", "a\nb"],
  ]) {
    const r: any = importRule({ pattern: "a", label }, () => "id");
    eq("label refused: " + what, typeof r.problem === "string" && r.problem.includes("이름표"), true);
  }
  eq("plain Korean label fine", "rule" in importRule({ pattern: "a", label: "카프카 재조정" }, () => "id"), true);

  // ---- 판정 med 8: limits refuse the whole file ---------------------------------------
  {
    const s = store([{ name: COMMON, rules: [] }]);
    const many = (k: number) => Array.from({ length: k }, (_, i) => ({ name: "t" + i, rules: [] }));
    const cases: [string, ImportFile, string][] = [
      ["1001 tags", file("big", many(1001)), "태그가 너무 많습니다 (1001개"],
      ["2001 rules", file("big", [{ name: "t", rules: Array.from({ length: 2001 }, () => ({ pattern: "a" })) }]), "규칙이 너무 많습니다 (2001개"],
      ["pattern 1001 chars", file("big", [{ name: "ok", rules: [] }, { name: "t", rules: [{ pattern: "가".repeat(1001) }] }]), "패턴이 너무 깁니다 (1001자"],
      ["label 101 chars", file("big", [{ name: "t", rules: [{ pattern: "a", label: "a".repeat(101) }] }]), "이름표가 너무 깁니다 (101자"],
    ];
    for (const [what, f, want] of cases) {
      const { ask } = script([]);
      const r = await runImport(s, [f, file("small", [{ name: "kept", rules: [] }])], ask, NOW, ids);
      eq("limit: " + what + " → file refused with why", r.summary.notImported.some((x) => x.startsWith("big: ") && x.includes(want)), true);
      eq("limit: " + what + " → nothing from it, the other file still comes", r.summary.added, ["kept"]);
    }
    const atLimit = file("ok", [{ name: "t", rules: Array.from({ length: 2000 }, (_, i) => ({ pattern: "가".repeat(1000), label: "a".repeat(100), id: "i" + i })) }]);
    const r = await runImport(s, [atLimit], script([]).ask, NOW, ids);
    eq("limit: exactly at the limits is fine", r.summary.added, ["t"]);
  }

  // ---- 판정 low: one name maker, within 100 characters ----------------------------------
  {
    const long = "가".repeat(100);
    eq("uniqueTagName keeps within 100", [...uniqueTagName(long, [long])].length <= 100, true);
    eq("uniqueTagName adds the number", uniqueTagName(long, [long]).endsWith(" (2)"), true);
    eq("renamedTagName = uniqueTagName", renamedTagName("collector", ["collector", "collector (2)"]), uniqueTagName("collector", ["collector", "collector (2)"]));
  }

  // ---- user 결정 4: assignments exported only when asked, only for those tags ----------
  {
    const s = store(
      [
        { name: COMMON, rules: [] },
        { name: "collector", rules: [R({ pattern: "k" })] },
        { name: "admin", rules: [R({ pattern: "a" })] },
      ],
      {
        dir: { "modules/lizcollector": ["collector"], "modules/both": ["collector", "admin"], "modules/admin": ["admin"], "modules/none": [] },
        file: { "modules/lizadmin/admin.log": ["admin"] },
        name: { messages: ["collector"] },
      }
    );
    const off = JSON.parse(exportPayload(s, ["collector"], NOW));
    eq("export: no assign unless asked", "assign" in off, false);
    const on = JSON.parse((exportPayload as any)(s, ["collector"], NOW, true));
    eq("export: only the exported tags' places, other names left out", on.assign, {
      dir: { "modules/lizcollector": ["collector"], "modules/both": ["collector"] },
      file: {},
      name: { messages: ["collector"] },
    });
  }
  // ---- user 결정 4: assignments imported — mine kept, renamed names followed ----------
  {
    const s = store(
      [
        { name: COMMON, rules: [] },
        { name: "collector", rules: [R({ pattern: "mine" })] },
        { name: "admin", rules: [R({ pattern: "a" })] },
        { name: "same", rules: [R({ pattern: "s" })] },
      ],
      { dir: { "modules/mine": ["admin"], "modules/emptied": [] } }
    );
    const f = file(
      "team",
      [
        { name: "collector", rules: [{ pattern: "theirs" }] }, // → renamed collector (2)
        { name: "admin", rules: [{ pattern: "theirs" }] }, // → skipped
        { name: "same", rules: [{ pattern: "s" }] }, // same content
        { name: "kafka", rules: [{ pattern: "k" }] }, // new
      ],
      {
        assign: {
          dir: {
            "modules\\lizcollector\\": ["collector"], // key normalized
            "modules/mine": ["collector"], // mine has it → kept
            "modules/emptied": ["kafka"], // mine says "no tags here" → kept
            "modules/admin": ["admin"], // skipped tag → not added
            "modules/mixed": ["admin", "kafka", "common", "unknown"],
          },
          file: { "m/k.log.*": ["kafka"] }, // legacy rotation key
          name: { messages: ["same"] },
        },
      }
    );
    const { ask } = script([{ choice: "rename" }, { choice: "skip" }]);
    const { store: out, summary } = await runImport(s, [f], ask, NOW, ids);
    eq("assign: renamed tag's places use the new name", out.assign.dir["modules/lizcollector"], ["collector (2)"]);
    eq("assign: my own place kept", out.assign.dir["modules/mine"], ["admin"]);
    eq("assign: my 「no tags」 kept", out.assign.dir["modules/emptied"], []);
    eq("assign: a skipped tag's places not taken", "modules/admin" in out.assign.dir, false);
    eq("assign: only imported names, no common / unknown", out.assign.dir["modules/mixed"], ["kafka"]);
    eq("assign: rotation key normalized", out.assign.file["m/k.log"], ["kafka"]);
    eq("assign: same-content tag's place taken", out.assign.name["messages"], ["same"]);
    const s2: any = summary;
    eq("assign: counted", [s2.assignAdded?.length, s2.assignKept?.length], [4, 2]);
    eq(
      "assign: summary line",
      summaryLine(summary),
      "추가 1 · 덮어씀 0 · 건너뜀 2 · 이름 바꿔 추가 1 · 잘못된 규칙 0 · 붙인 곳 4개 추가 · 2개는 내 지정이 있어 건너뜀"
    );
    eq("assign: details name the places", summaryDetails(summary).some((d) => d.includes("modules/mine") && d.includes("내 지정")), true);
    eq("assign: original store untouched", s.assign.dir, { "modules/mine": ["admin"], "modules/emptied": [] });
    // only places, nothing else new → still a change (saved, undoable)
    const only = await runImport(out, [file("again", [{ name: "kafka", rules: [{ pattern: "k" }] }], { assign: { dir: { "x/y": ["kafka"] } } })], script([]).ask, NOW, ids);
    eq("assign: a place alone is a change", [only.store !== out, only.store.assign.dir["x/y"]], [true, ["kafka"]]);
    // no assign in the file → as before
    const none = await runImport(out, [file("plain", [{ name: "kafka", rules: [{ pattern: "k" }] }])], script([]).ask, NOW, ids);
    eq("assign: none in the file → store unchanged", none.store === out, true);
  }

  // ---- 판정 med 8: no copying the whole list per tag -----------------------------------
  {
    const s = store([{ name: COMMON, rules: [] }]);
    const files = Array.from({ length: 20 }, (_, k) =>
      file("f" + k, Array.from({ length: 1000 }, (_, i) => ({ name: `t${k}-${i}`, rules: [{ pattern: "p" + i }] })))
    );
    const t0 = performance.now();
    const r = await runImport(s, files, script([]).ask, NOW, ids);
    const ms = performance.now() - t0;
    console.log(`  (20 files x 1000 tags: ${Math.round(ms)} ms)`);
    eq("20,000 new tags in 20 files: well under a second", [r.summary.added.length, ms < 1000], [20000, true]);
  }

  console.log(`io-fix-unit: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  if (fails.length) process.exit(1);
})();
