// Pure-function tests for tag assignment (tagAssign.ts, stage 4).
// Run: node frontend/tests/run-unit.cjs
import { normalizeTagStore, rotationKey, setTagRules, tagsFor, type TagStore } from "../src/logTags";
import {
  applyAssignChange,
  cachedPlaceTags,
  dirProbe,
  folderTargetForPath,
  placeTags,
  seriesBase,
  setAssign,
  targetForPath,
  targetSentence,
  withEseo,
  type AssignTarget,
} from "../src/tagAssign";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}

const R = "C:\\b\\bromo";
const B = { root: R, servers: ["s1", "s2"] };
const pathOf = (sv: string) => (rel: string) => [R, sv, ...rel.split("/")].join("\\");
const dir = (sv: string, key: string): AssignTarget => ({ kind: "dir", key, path: dirProbe(pathOf(sv), key) });
// The key is what the app computes for that file (rotationKey), not typed in.
const file = (sv: string, rel: string): AssignTarget => ({ kind: "file", key: rotationKey(rel), path: pathOf(sv)(rel) });

let s: TagStore = normalizeTagStore({
  version: 1,
  tags: [{ name: "common", rules: [] }, { name: "collector", rules: [] }, { name: "admin", rules: [] }, { name: "Collector", rules: [] }],
  assign: {},
});
const names = (st: TagStore, p: string) => tagsFor(st, p, B).names;

// nothing assigned
let t = placeTags(s, dir("s1", "modules/lizcollector"), B);
eq("empty: direct undefined", t.direct, undefined);
eq("empty: not inherited", t.inherited, false);

// folder assignment, seen from both servers
s = setAssign(s, dir("s1", "modules/lizcollector"), B, ["collector"]);
eq("dir set", s.assign.dir, { "modules/lizcollector": ["collector"] });
eq("dir direct (s1)", placeTags(s, dir("s1", "modules/lizcollector"), B).direct, ["collector"]);
eq("dir direct (s2, same path)", placeTags(s, dir("s2", "modules/lizcollector"), B).direct, ["collector"]);
t = placeTags(s, dir("s1", "modules/lizcollector/sub"), B);
eq("sub folder inherits", [t.direct, t.inherited, t.effective], [undefined, true, ["collector"]]);
t = placeTags(s, dir("s1", "modules"), B);
eq("parent folder: nothing", [t.direct, t.effective], [undefined, []]);
eq("file under it", names(s, pathOf("s2")("modules/lizcollector/collector.log")), ["common", "collector"]);

// file series override
const adm = file("s1", "modules/lizcollector/admin.log.2026-10-21");
eq("file target = targetForPath (tree key = lookup key)", adm, targetForPath(adm.path, { rel: "modules/lizcollector/admin.log.2026-10-21" }));
s = setAssign(s, adm, B, ["admin"]);
t = placeTags(s, adm, B);
eq("file direct + overrides", [t.direct, t.overrides], [["admin"], ["collector"]]);
eq("other rotated file of the series", names(s, pathOf("s2")("modules/lizcollector/admin.log.3")), ["common", "admin"]);
eq("current file of the series (admin.log) too", names(s, pathOf("s2")("modules/lizcollector/admin.log")), ["common", "admin"]);
// unchecking all = follow the folder (key removed)
s = setAssign(s, adm, B, null);
eq("null removes file key", s.assign.file, {});
eq("back to folder tag", names(s, pathOf("s1")("modules/lizcollector/admin.log.2026-10-21")), ["common", "collector"]);

// [] = no tags here
s = setAssign(s, dir("s1", "modules/lizcollector"), B, []);
eq("dir [] kept as key", s.assign.dir, { "modules/lizcollector": [] });
t = placeTags(s, dir("s2", "modules/lizcollector"), B);
eq("dir [] direct = []", t.direct, []);
eq("dir [] stops inheritance", names(s, pathOf("s1")("modules/lizcollector/collector.log")), ["common"]);

// server root
s = setAssign(s, dir("s1", ""), B, ["Collector"]);
eq("root key", s.assign.dir[""], ["Collector"]);
eq("root direct", placeTags(s, dir("s2", ""), B).direct, ["Collector"]);
t = placeTags(s, dir("s1", "modules"), B);
eq("folder inherits from root", [t.inherited, t.effective, t.from], [true, ["Collector"], { kind: "dir", key: "" }]);
eq("lizcollector [] still wins over root", names(s, pathOf("s1")("modules/lizcollector/x.log")), ["common"]);
eq("case-distinct tag names", names(s, pathOf("s1")("other/y.log")), ["common", "Collector"]);

// order = given order, unknown and common dropped, duplicates dropped
s = setAssign(s, dir("s1", "a"), B, ["admin", "common", "nope", "collector", "admin"]);
eq("cleaned names", s.assign.dir["a"], ["admin", "collector"]);

// Windows case-insensitive: an existing key in another case is replaced, not duplicated
let w = normalizeTagStore({ version: 1, tags: [{ name: "common", rules: [] }, { name: "x", rules: [] }], assign: { dir: { "Modules/LizCollector": ["x"] } } });
eq("case-insensitive direct", placeTags(w, dir("s1", "modules/lizcollector"), B).direct, ["x"]);
w = setAssign(w, dir("s1", "modules/lizcollector"), B, null);
eq("case-insensitive clear removes the stored key", w.assign.dir, {});

// names outside a bundle
const nt = targetForPath("D:\\tmp\\messages", null)!;
eq("name target", [nt.kind, nt.key], ["name", "messages"]);
s = setAssign(s, nt, B, ["admin"]);
eq("name set", s.assign.name, { messages: ["admin"] });
eq("name applies", names(s, "D:\\other\\messages"), ["common", "admin"]);
eq("name direct", placeTags(s, nt, B).direct, ["admin"]);
const rt = targetForPath("D:\\tmp\\app.log.2026-10-01", null)!;
eq("rotated name target key", rt.key, "app.log");
eq("bundle file target", targetForPath(pathOf("s1")("m/c.log.3"), { rel: "m/c.log.3" }), { kind: "file", key: "m/c.log", path: pathOf("s1")("m/c.log.3") });
eq("no path → no target", targetForPath("", null), null);

// sentences
eq("seriesBase", [seriesBase("a/collector.log.*"), seriesBase("messages-*"), seriesBase("a/b.log")], ["a/collector.log", "messages", "a/b.log"]);
eq("sentence dir", targetSentence(dir("s1", "modules/lizcollector")), "모든 서버의 modules/lizcollector 폴더와 그 아래 모든 파일에 적용됩니다");
eq("sentence file", targetSentence(adm), "모든 서버의 modules/lizcollector/admin.log 와 회전 파일 모두에 적용됩니다");

// ---- stage 4 fix ----
// 「이 폴더에 태그 지정」 from a tab: the folder the file lies in
const fp = pathOf("s2")("modules/lizcollector/collector.log.1");
const ft = folderTargetForPath(fp, { rel: "modules/lizcollector/collector.log.1" })!;
eq("folder target key", [ft.kind, ft.key], ["dir", "modules/lizcollector"]);
eq("folder target probe = the dir probe the tree uses", ft.path, dir("s2", "modules/lizcollector").path);
const ftRoot = folderTargetForPath(pathOf("s1")("messages"), { rel: "messages" })!;
eq("file right under the server → server folder (key \"\")", [ftRoot.key, ftRoot.path], ["", dir("s1", "").path]);
eq("folder target outside a bundle → none", folderTargetForPath("D:\\x\\messages", null), null);
eq("folder target without a path → none", folderTargetForPath("", { rel: "a/b.log" }), null);
{
  // assigning through the folder target = assigning on the tree's folder line
  let a = normalizeTagStore({ version: 1, tags: [{ name: "common" }, { name: "collector" }], assign: {} });
  a = setAssign(a, ft, B, ["collector"]);
  eq("folder target saves the dir key", a.assign.dir, { "modules/lizcollector": ["collector"] });
  eq("folder target = tree line (direct)", placeTags(a, dir("s1", "modules/lizcollector"), B).direct, ["collector"]);
  const linux = { root: "/home/q/b", servers: ["s1"] };
  const lp = "/home/q/b/s1/Logs/app.log";
  const lt = folderTargetForPath(lp, { rel: "Logs/app.log" })!;
  eq("linux folder probe", lt.path, "/home/q/b/s1/Logs/\u0001");
  eq("linux folder target applies", tagsFor(setAssign(a, lt, linux, ["collector"]), lp, linux).names, ["common", "collector"]);
}

// The assign window's 확인 applies only its own change to the latest store
{
  const opened = normalizeTagStore({
    version: 1,
    tags: [{ name: "common" }, { name: "collector" }],
    assign: { dir: { "modules/x": ["collector"] } },
  });
  // meanwhile (window open): a rule added to collector, a new tag, another place
  let latest = setTagRules(opened, "collector", [{ id: "r", on: true, label: "", pattern: "kafka", kind: "text", caseSensitive: false, color: "#dd0001", line: false, filter: true }]);
  latest = { ...latest, tags: [...latest.tags, { name: "zk", rules: [], updated: "" }] };
  latest = setAssign(latest, dir("s1", "modules/zk"), B, ["zk"]);
  const target = dir("s1", "modules/lizcollector");
  const out = applyAssignChange(latest, { target, created: ["admin"], names: ["collector", "admin"] }, B);
  eq("only this place changes", out.assign.dir, { "modules/x": ["collector"], "modules/zk": ["zk"], "modules/lizcollector": ["collector", "admin"] });
  eq("rules changed meanwhile are kept", out.tags.find((t) => t.name === "collector")!.rules.length, 1);
  eq("tags made meanwhile are kept, the new one added", out.tags.map((t) => t.name), ["common", "collector", "zk", "admin"]);
  const again = applyAssignChange(out, { target, created: ["admin"], names: null }, B);
  eq("a made tag that exists by now is not added twice", again.tags.filter((t) => t.name === "admin").length, 1);
  eq("names null = follow the folder above (key removed)", "modules/lizcollector" in again.assign.dir, false);
  const none = applyAssignChange(out, { target, created: [], names: [] }, B);
  eq("[] = no tags here", none.assign.dir["modules/lizcollector"], []);
  eq("the input store is not changed", latest.assign.dir["modules/lizcollector"], undefined);
}

// tree cache: the same answer object while the store is the same
{
  const f = cachedPlaceTags(s, B);
  const a1 = f(dir("s1", "modules/lizcollector"));
  eq("cache: same object for the same place", a1 === f(dir("s1", "modules/lizcollector")), true);
  eq("cache: same answer as placeTags", a1, placeTags(s, dir("s1", "modules/lizcollector"), B));
  eq("cache: other server path asked separately", f(dir("s2", "modules/lizcollector")) === a1, false);
  const g = cachedPlaceTags(setAssign(s, dir("s1", "modules/lizcollector"), B, null), B);
  eq("cache: a new store gives a new answer", g(dir("s1", "modules/lizcollector")).direct, undefined);
}

// particle spacing
eq("withEseo after Korean", withEseo("서버 폴더 전체"), "서버 폴더 전체에서");
eq("withEseo after a path", withEseo("modules/lizcollector"), "modules/lizcollector 에서");
eq("withEseo after a closing bracket", withEseo("파일 a.log(회전 파일 포함)"), "파일 a.log(회전 파일 포함) 에서");

console.log(`assign unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
