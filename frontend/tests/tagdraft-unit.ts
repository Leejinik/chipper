// The tag window's draft (「적용」 버튼, tags-apply-impl.md): edits laid over the
// saved store, laid again when the store changes outside the window.
// Run: node frontend/tests/run-unit.cjs
import { type LogRule } from "../src/logHighlight";
import { COMMON, addTag, emptyAssign, setTagRules, type TagStore } from "../src/logTags";
import { pushOp, rebaseDraft, sameTagStore, type DraftOp } from "../src/tagDraft";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}
const R = (id: string, pattern: string, p: Partial<LogRule> = {}): LogRule => ({
  id,
  on: true,
  label: "",
  pattern,
  kind: "text",
  caseSensitive: false,
  color: "#c678dd",
  line: false,
  filter: true,
  ...p,
});
const store = (tags: [string, LogRule[]][], assign = emptyAssign()): TagStore => ({
  version: 1,
  tags: tags.map(([name, rules]) => ({ name, rules, updated: "" })),
  assign,
});
const T = "2026-10-28T00:00:00.000Z";
const names = (s: TagStore) => s.tags.map((t) => t.name);
const pats = (s: TagStore, n: string) => s.tags.find((t) => t.name === n)?.rules.map((r) => r.pattern);
const ids = (s: TagStore, n: string) => s.tags.find((t) => t.name === n)?.rules.map((r) => r.id);
// what the window does: one edit at a time, over the view
const play = (base: TagStore, ops: DraftOp[]) => {
  let view = base;
  let kept: DraftOp[] = [];
  for (const op of ops) {
    const r = rebaseDraft(view, [op]);
    view = r.store;
    kept = r.ops.reduce(pushOp, kept);
  }
  return { view, ops: kept };
};

const base = store([
  [COMMON, [R("error", "ERROR"), R("warn", "WARN")]],
  ["collector", [R("k1", "kafka rebalance")]],
]);

// 1. nothing outside: laying all the edits again = the window's own view
{
  const ops: DraftOp[] = [
    { k: "add", name: "새 태그", rules: [], at: T },
    { k: "rename", from: "새 태그", to: "admin", at: T },
    { k: "rules", tag: "admin", e: { k: "push", rule: R("a1", "") }, at: T },
    { k: "rules", tag: "admin", e: { k: "upd", id: "a1", patch: { pattern: "l" } }, at: T },
    { k: "rules", tag: "admin", e: { k: "upd", id: "a1", patch: { pattern: "lo" } }, at: T },
    { k: "rules", tag: "admin", e: { k: "upd", id: "a1", patch: { pattern: "login" } }, at: T },
    { k: "rules", tag: COMMON, e: { k: "up", id: "warn" }, at: T },
    { k: "rules", tag: "collector", e: { k: "del", id: "k1" }, at: T },
  ];
  const w = play(base, ops);
  eq("1 view: tags", names(w.view), [COMMON, "collector", "admin"]);
  eq("1 view: admin rule", pats(w.view, "admin"), ["login"]);
  eq("1 view: common order", ids(w.view, COMMON), ["warn", "error"]);
  eq("1 view: collector emptied", pats(w.view, "collector"), []);
  eq("1 typing = one edit (upd coalesced)", w.ops.filter((o) => o.k === "rules" && o.e.k === "upd").length, 1);
  const r = rebaseDraft(base, w.ops);
  eq("1 rebase over the same base = view", sameTagStore(r.store, w.view), true);
  eq("1 no notes", r.notes, []);
  eq("1 base untouched", names(base), [COMMON, "collector"]);
}

// 2. a folder tag put on from the tree while the window is open survives 적용
{
  const w = play(base, [{ k: "rules", tag: "collector", e: { k: "push", rule: R("k2", "consumer") }, at: T }]);
  const outside: TagStore = { ...base, assign: { ...emptyAssign(), dir: { "modules/lizcollector": ["collector"] } } };
  const r = rebaseDraft(outside, w.ops);
  eq("2 assignment kept", r.store.assign.dir, { "modules/lizcollector": ["collector"] });
  eq("2 draft rule on top", pats(r.store, "collector"), ["kafka rebalance", "consumer"]);
  eq("2 no notes", r.notes, []);
}

// 3. 「이 글자로 규칙」 added a rule to common outside; the window changed another
{
  const w = play(base, [{ k: "rules", tag: COMMON, e: { k: "upd", id: "warn", patch: { color: "#123456" } }, at: T }]);
  const outside = setTagRules(base, COMMON, [...base.tags[0].rules, R("rt", "boom")], T);
  const r = rebaseDraft(outside, w.ops);
  eq("3 outside rule kept", pats(r.store, COMMON), ["ERROR", "WARN", "boom"]);
  eq("3 draft colour on top", r.store.tags[0].rules[1].color, "#123456");
  // the same rule changed both sides: the window's field wins, the other field stays
  const outside2 = setTagRules(base, COMMON, [R("error", "ERROR"), R("warn", "WARNING", { line: true })], T);
  const r2 = rebaseDraft(outside2, w.ops);
  eq("3 same rule: outside pattern + window colour", [r2.store.tags[0].rules[1].pattern, r2.store.tags[0].rules[1].line, r2.store.tags[0].rules[1].color], ["WARNING", true, "#123456"]);
}

// 4. import overwrote collector (new rule ids): the window's change to the old rule can't be laid
{
  const w = play(base, [
    { k: "rules", tag: "collector", e: { k: "upd", id: "k1", patch: { pattern: "rebalance!" } }, at: T },
    { k: "rules", tag: "collector", e: { k: "push", rule: R("k9", "mine") }, at: T },
  ]);
  const imported = setTagRules(base, "collector", [R("x1", "theirs")], T);
  const r = rebaseDraft(imported, w.ops);
  eq("4 imported rules + the window's new rule", pats(r.store, "collector"), ["theirs", "mine"]);
  eq("4 one note (the change to a rule that is gone)", r.notes.length, 1);
  eq("4 note names the tag", r.notes[0].includes("「collector」"), true);
  eq("4 dropped edit is out of the list", r.ops.length, 1);
  eq("4 laid again: no more notes", rebaseDraft(imported, r.ops).notes, []);
}

// 5. a tag made in the window, then the same name came in from outside
{
  const w = play(base, [
    { k: "add", name: "admin", rules: [], at: T },
    { k: "rules", tag: "admin", e: { k: "push", rule: R("a1", "login") }, at: T },
  ]);
  const outside = addTag(base, "admin", [R("o1", "theirs")], T);
  const r = rebaseDraft(outside, w.ops);
  eq("5 both kept, the window's renamed", names(r.store), [COMMON, "collector", "admin", "admin (2)"]);
  eq("5 outside admin untouched", pats(r.store, "admin"), ["theirs"]);
  eq("5 the window's rules follow its tag", pats(r.store, "admin (2)"), ["login"]);
  eq("5 note says the new name", r.notes.length === 1 && r.notes[0].includes("「admin (2)」"), true);
  eq("5 the window's selection follows its tag", [...r.follow], [["admin", "admin (2)"]]);
  // the window goes on with the names it now shows
  const more = rebaseDraft(outside, [...r.ops, { k: "rules", tag: "admin", e: { k: "push", rule: R("a2", "on theirs") }, at: T }]);
  eq("5 later edits use the names shown", [pats(more.store, "admin"), pats(more.store, "admin (2)")], [["theirs", "on theirs"], ["login"]]);
  eq("5 laid again: same, no notes", [sameTagStore(rebaseDraft(outside, r.ops).store, r.store), rebaseDraft(outside, r.ops).notes], [true, []]);
}

// 6. rename to a name that came in from outside; assignments follow the tag
{
  const b = store([[COMMON, []], ["col", [R("c", "x")]]], { dir: { a: ["col"] }, file: {}, name: {} });
  const w = play(b, [
    { k: "rename", from: "col", to: "collector", at: T },
    { k: "rules", tag: "collector", e: { k: "upd", id: "c", patch: { pattern: "y" } }, at: T },
  ]);
  const outside = addTag(b, "collector", [], T);
  const r = rebaseDraft(outside, w.ops);
  eq("6 renamed to collector (2)", names(r.store), [COMMON, "collector (2)", "collector"]);
  eq("6 edit followed", pats(r.store, "collector (2)"), ["y"]);
  eq("6 assignment renamed too", r.store.assign.dir, { a: ["collector (2)"] });
  eq("6 one note", r.notes.length, 1);
  eq("6 follow the renamed tag", [...r.follow], [["collector", "collector (2)"]]);
  eq("6 nothing outside: nothing to follow", rebaseDraft(b, w.ops).follow.size, 0);
}

// 7. the tag renamed in the window went away outside (restore): one note, under the old name
{
  const w = play(base, [
    { k: "rename", from: "collector", to: "coll", at: T },
    { k: "rules", tag: "coll", e: { k: "push", rule: R("n", "x") }, at: T },
    { k: "rules", tag: "coll", e: { k: "upd", id: "k1", patch: { on: false } }, at: T },
  ]);
  const restored = store([[COMMON, []]]);
  const r = rebaseDraft(restored, w.ops);
  eq("7 nothing laid", names(r.store), [COMMON]);
  eq("7 one note about collector", r.notes.length === 1 && r.notes[0].includes("「collector」"), true);
  eq("7 edits dropped", r.ops, []);
}

// 8. 비우기 / 기본값으로 keep rules that came in from outside meanwhile
{
  const w = play(base, [{ k: "rules", tag: COMMON, e: { k: "replace", ids: ["error", "warn"], rules: [] }, at: T }]);
  eq("8 cleared in the window", pats(w.view, COMMON), []);
  const outside = setTagRules(base, COMMON, [...base.tags[0].rules, R("rt", "boom")], T);
  const r = rebaseDraft(outside, w.ops);
  eq("8 outside rule kept after clearing", pats(r.store, COMMON), ["boom"]);
  eq("8 note", r.notes.length === 1 && r.notes[0].includes("「boom」"), true);
  const dflt = rebaseDraft(outside, [{ k: "rules", tag: COMMON, e: { k: "replace", ids: ["error", "warn"], rules: [R("error", "E2"), R("info", "INFO")] }, at: T }]);
  eq("8 defaults first, then the outside rule", pats(dflt.store, COMMON), ["E2", "INFO", "boom"]);
}

// 9. a rule added in the window whose id came in from outside gets a new id
{
  const w = play(base, [{ k: "rules", tag: "collector", e: { k: "push", rule: R("zz", "mine") }, at: T }]);
  const outside = setTagRules(base, "collector", [...base.tags[1].rules, R("zz", "theirs")], T);
  const r = rebaseDraft(outside, w.ops);
  const rs = r.store.tags[1].rules;
  eq("9 both rules", rs.map((x) => x.pattern), ["kafka rebalance", "theirs", "mine"]);
  eq("9 ids unique", new Set(rs.map((x) => x.id)).size, 3);
  eq("9 rewritten edit keeps the new id (laid again: same)", sameTagStore(rebaseDraft(outside, r.ops).store, r.store), true);
}

// 10. deleting in the window a tag that was put somewhere outside: deleted, place freed
{
  const w = play(base, [{ k: "delete", name: "collector" }]);
  const outside: TagStore = { ...base, assign: { ...emptyAssign(), dir: { m: ["collector"], n: ["collector", "x"] } } };
  const r = rebaseDraft(outside, w.ops);
  eq("10 gone", names(r.store), [COMMON]);
  eq("10 assignments without it", r.store.assign.dir, { n: ["x"] });
  // deleted outside too: nothing to do, no note
  eq("10 already gone: no note", rebaseDraft(store([[COMMON, []]]), w.ops).notes, []);
}

// 11. small things
{
  eq("11 up on the first rule = no edit", play(base, [{ k: "rules", tag: COMMON, e: { k: "up", id: "error" }, at: T }]).ops, []);
  eq("11 del of a rule gone = no edit", rebaseDraft(base, [{ k: "rules", tag: COMMON, e: { k: "del", id: "nope" }, at: T }]).ops, []);
  const a = addTag(base, "t", [], "2026-01-01");
  const b = addTag(base, "t", [], "2026-02-02");
  eq("11 same store except times", sameTagStore(a, b), true);
  eq("11 different rule", sameTagStore(a, setTagRules(a, "t", [R("q", "q")])), false);
  // add then delete again = no change (the window shows no unapplied change)
  const w = play(base, [
    { k: "rules", tag: COMMON, e: { k: "push", rule: R("tmp", "x") }, at: T },
    { k: "rules", tag: COMMON, e: { k: "del", id: "tmp" }, at: T },
  ]);
  eq("11 add + delete = same as saved", sameTagStore(w.view, base), true);
  // coalescing only for the same rule, one after another
  const ops = pushOp(pushOp([{ k: "rules", tag: COMMON, e: { k: "upd", id: "error", patch: { pattern: "a" } }, at: T }], { k: "rules", tag: COMMON, e: { k: "upd", id: "warn", patch: { pattern: "b" } }, at: T }), {
    k: "rules",
    tag: COMMON,
    e: { k: "upd", id: "error", patch: { color: "#000000" } },
    at: T,
  });
  eq("11 no coalescing across rules", ops.length, 3);
  const one = pushOp([{ k: "rules", tag: COMMON, e: { k: "upd", id: "error", patch: { pattern: "a" } }, at: T }], { k: "rules", tag: COMMON, e: { k: "upd", id: "error", patch: { color: "#000000" } }, at: T });
  eq("11 coalesced patch has both fields", one.length === 1 && one[0].k === "rules" && one[0].e.k === "upd" ? one[0].e.patch : null, { pattern: "a", color: "#000000" });
}

console.log(`tagdraft-unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
