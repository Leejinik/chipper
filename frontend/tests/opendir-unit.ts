// Pure-function tests for 「📂 디렉토리 열기」 (openDir.ts) and the tag keys a
// directory gives its files. Run: node frontend/tests/run-unit.cjs
import { normalizeTagStore, rotationKey, tagsFor } from "../src/logTags";
import { canOpenAll, dirIndex, dirName, serversWith } from "../src/openDir";
import { placeTags, setAssign, type AssignTarget } from "../src/tagAssign";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}

const f = (rel: string) => ({ rel, size: 1, compressed: false });
const srv = (name: string, rels: string[]) => ({ name, files: rels.map(f), truncated: false, unreadable: 0, notRead: false });
const scan = (servers: ReturnType<typeof srv>[], rootFiles: string[] = []) =>
  ({ root: "C:\\d", servers, rootFiles: rootFiles.map(f), rootTruncated: false, truncated: false, fileLimit: 20000, files: 0 }) as any;

// --- ⇉ only when 2+ top folders hold the log
{
  const b = scan([
    srv("server1", ["modules/lizcollector/collector.log", "messages", "only1.log"]),
    srv("server2", ["modules/lizcollector/collector.log", "Messages"]),
    srv("server3", ["x/messages", "y/messages"]), // two files of that name: no unique match
  ]);
  const ix = dirIndex(b);
  eq("same rel in 2 folders", serversWith(ix, "modules/lizcollector/collector.log"), ["server1", "server2"]);
  eq("case-insensitive name", serversWith(ix, "messages"), ["server1", "server2"]);
  eq("⇉ for a shared log", canOpenAll(ix, "server1", "modules/lizcollector/collector.log"), true);
  eq("no ⇉ for a log only one folder has", canOpenAll(ix, "server1", "only1.log"), false);
  eq("no ⇉ for a file directly in the folder", canOpenAll(ix, "", "modules/lizcollector/collector.log"), false);
  // flat dump: same base name in another folder, different path
  const flat = dirIndex(scan([srv("a", ["logs/app.log"]), srv("b", ["app.log"])]));
  eq("same name, other path (flat dump)", serversWith(flat, "logs/app.log"), ["a", "b"]);
}
{
  // one top folder (e.g. a single server opened, or one deep tree): never ⇉
  const ix = dirIndex(scan([srv("logs", ["a/b/c/d.log"])]));
  eq("one top folder: no ⇉", canOpenAll(ix, "logs", "a/b/c/d.log"), false);
  // files only: no top folders at all
  const none = dirIndex(scan([], ["messages", "app.log"]));
  eq("files only: no servers", none.servers.length, 0);
  eq("files only: no ⇉", canOpenAll(none, "", "messages"), false);
  eq("null scan", dirIndex(null).servers.length, 0);
}

// --- directory name in the tree head
eq("dirName windows", dirName("C:\\logs\\b1\\"), "b1");
eq("dirName linux", dirName("/var/log"), "log");
eq("dirName root", dirName("/"), "/");
eq("dirName drive", dirName("D:\\"), "D:");

// --- tag keys stay "path under the top folder" (not under the opened folder)
{
  const store = normalizeTagStore({
    version: 1,
    tags: [
      { name: "common", rules: [] },
      { name: "collector", rules: [] },
      { name: "syslog", rules: [] },
    ],
    assign: { dir: { "modules/lizcollector": ["collector"] }, file: {}, name: { messages: ["syslog"] } },
  });
  const B = { root: "C:\\d", servers: ["server1", "server2"] };
  eq("top-folder file → dir key", tagsFor(store, "C:\\d\\server2\\modules\\lizcollector\\collector.log", B).names, ["common", "collector"]);
  // a file directly in the opened folder belongs to no top folder: its name decides
  eq("root file → name key", tagsFor(store, "C:\\d\\messages", B).names, ["common", "syslog"]);
  // the tree's target for such a file is a name target, so assigning there is found again
  const t: AssignTarget = { kind: "name", key: rotationKey("app.log"), path: "C:\\d\\app.log" };
  const s2 = setAssign(store, t, B, ["collector"]);
  eq("root file assign → stored as name", s2.assign.name[rotationKey("app.log")], ["collector"]);
  eq("root file assign → applies", tagsFor(s2, "C:\\d\\app.log.1", B).names, ["common", "collector"]);
  eq("root file assign → place shows it direct", placeTags(s2, t, B).direct, ["collector"]);
  // after 「디렉토리 닫기」 (no bundle) a top-folder file falls back to its name
  eq("closed dir → name lookup", tagsFor(store, "C:\\d\\server1\\messages", null).names, ["common", "syslog"]);
  // ... but a tab of a closed directory keeps its tags through the bundle history
  eq("closed dir, history → dir key", tagsFor(store, "C:\\d\\server1\\modules\\lizcollector\\c.log", [B]).names, ["common", "collector"]);
}

console.log(`opendir unit: ${pass} passed, ${fails.length} failed`);
for (const x of fails) console.log("FAIL " + x);
if (fails.length) process.exit(1);
