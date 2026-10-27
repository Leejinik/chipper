// Pure-function tests for tag assignment (tagAssign.ts, stage 4).
// Run: node frontend/tests/run-unit.cjs
import { normalizeTagStore, tagsFor, type TagStore } from "../src/logTags";
import { dirProbe, placeTags, seriesBase, setAssign, targetForPath, targetSentence, type AssignTarget } from "../src/tagAssign";

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
const file = (sv: string, rel: string, key: string): AssignTarget => ({ kind: "file", key, path: pathOf(sv)(rel) });

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
const adm = file("s1", "modules/lizcollector/admin.log.2026-10-21", "modules/lizcollector/admin.log.*");
s = setAssign(s, adm, B, ["admin"]);
t = placeTags(s, adm, B);
eq("file direct + overrides", [t.direct, t.overrides], [["admin"], ["collector"]]);
eq("other rotated file of the series", names(s, pathOf("s2")("modules/lizcollector/admin.log.3")), ["common", "admin"]);
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
eq("rotated name target key", rt.key, "app.log.*");
eq("bundle file target", targetForPath(pathOf("s1")("m/c.log.3"), { rel: "m/c.log.3" }), { kind: "file", key: "m/c.log.*", path: pathOf("s1")("m/c.log.3") });
eq("no path → no target", targetForPath("", null), null);

// sentences
eq("seriesBase", [seriesBase("a/collector.log.*"), seriesBase("messages-*"), seriesBase("a/b.log")], ["a/collector.log", "messages", "a/b.log"]);
eq("sentence dir", targetSentence(dir("s1", "modules/lizcollector")), "모든 서버의 modules/lizcollector 폴더와 그 아래 모든 파일에 적용됩니다");
eq("sentence file", targetSentence(adm), "모든 서버의 modules/lizcollector/admin.log 와 회전 파일 모두에 적용됩니다");

console.log(`assign unit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
if (fails.length) process.exit(1);
