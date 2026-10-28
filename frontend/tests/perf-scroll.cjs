// Scroll frame times of a big log with many colour rules, headless chromium,
// against a built frontend (default frontend/dist; DIST=<dir> for another build).
//
//   node tests/perf-scroll.cjs <log file> [rule set: A|A2|B|freeze]
//     A      = 6 default rules + 24 user rules (most regex) — usable by the old
//              stage-3 guard too, so old and new builds run the same rules
//     A2     = this build's built-in common rules (logHighlight DEFAULT_LOG_RULES,
//              revision 2 = 8 rules since stage 6) + the same 24 user rules
//     B      = A + the review's slow-looking regexes ((\w|-)+, (a+){4}$, …)
//     freeze = A + (a+){4}$ on a document with a 2,000-character "aaa…!" line
//   DIST=<dist dir>  PLAYWRIGHT=<path>  MB=<megabytes of the log to use, default 10>
//   COLORS=off  (log colouring off: what CodeMirror alone costs)
//   ANSI=1      every 3rd line wrapped in ANSI colour codes (ESC[..m), as some logs are
//
// Prints the time from setting scrollTop to the next frame (≈16.7 ms when idle) for smooth scrolling (200 × 120px) and for jumps
// (60 random positions): median, p95, max, and frames over 50 ms.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.resolve(process.env.DIST || path.join(__dirname, "..", "dist"));
const LOG = process.argv[2];
const SET = process.argv[3] || "A";
if (!LOG) throw new Error("usage: node tests/perf-scroll.cjs <log file> [A|A2|B|freeze]");

// The built-in common rules of the build under test, from its source (esbuild
// from vite's node_modules, like run-unit.cjs).
function currentDefaults() {
  const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));
  const out = esbuild.buildSync({
    stdin: { contents: 'export { DEFAULT_LOG_RULES } from "./src/logHighlight";', resolveDir: path.join(__dirname, ".."), loader: "ts" },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
  return m.exports.DEFAULT_LOG_RULES;
}

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(DIST, p);
    if (!f.startsWith(DIST) || !fs.existsSync(f)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

const rule = (id, pattern, kind, color, line = false, caseSensitive = false) => ({ id, on: true, label: id, pattern, kind, caseSensitive, color, line, filter: true });
const DEFAULTS = [
  ["error", String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`, false, "#ff6b6b", true],
  ["warn", String.raw`\bWARN(ING)?\b`, false, "#e5c07b", false],
  ["info", String.raw`\b(INFO|NOTICE)\b|\[Note\]`, false, "#61afef", false],
  ["debug", String.raw`\b(DEBUG|TRACE|VERBOSE)\b`, false, "#7f848e", false],
  ["time", String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`, true, "#56b6c2", false],
  ["mk119", String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`, true, "#ff9e64", true],
].map(([id, p, cs, c, line]) => rule(id, p, "regex", c, line, cs));
const USER_A = [
  ["deviceId: \\d+", "regex"],
  ["deviceInterfaceId: \\d+", "regex"],
  ["port\\(\\d+\\)", "regex"],
  ["\\[[A-Z ]+\\]", "regex"],
  ["queue = \\d+", "regex"],
  ["lizserver\\d+:\\d+", "regex"],
  ["at [\\w.$]+\\(", "regex"],
  ["\\d+ms", "regex"],
  ["Sleeping \\d+ms", "regex"],
  ["(\\d{1,3}\\.){3}\\d{1,3}", "regex"],
  ["collected\\s+=\\s+[\\d,]+", "regex"],
  ["\\(\\d[\\d,]*/sec\\)", "regex"],
  ["interface\\(\\d+\\)", "regex"],
  ["BTM\\d-L\\d", "regex"],
  ["sendRequestTask = \\w+", "regex"],
  ["\\bnull\\b", "regex"],
  ["[A-Z]{2,}-[A-Z0-9-]+", "regex"],
  ["No route to host", "text"],
  ["Connection refused", "text"],
  ["JedisConnectionException", "text"],
  ["AbstractMonitorForTCP", "text"],
  ["reserveReconnectTask", "word"],
  ["kafka queue", "text"],
  ["redis queue", "text"],
];
const USER_B = [
  ["(\\w|-)+\\.run", "regex"],
  ["(\\d|\\.)+:\\d+", "regex"],
  ["(a+){4}$", "regex"],
  ["(.*,){4}X", "regex"],
  ["(\\w+\\s?){4}!", "regex"],
  ["(ab?|b)+$", "regex"],
  [".*a.*b", "regex"],
];
const color = (i) => "#" + [0x40 + ((i * 53) % 0xa0), 0x40 + ((i * 97) % 0xa0), 0x40 + ((i * 29) % 0xa0)].map((x) => x.toString(16).padStart(2, "0")).join("");
const user = (list, base) => list.map(([p, k], i) => rule(`u${base + i}`, p, k, color(base + i), i % 7 === 0));
let rules = [...DEFAULTS, ...user(USER_A, 0)];
if (SET === "B") rules = [...rules, ...user(USER_B, 100)];
if (SET === "A2") rules = [...currentDefaults(), ...user(USER_A, 0)];
if (SET === "freeze") rules = [...rules, rule("slow", "(a+){4}$", "regex", "#123456")];

async function main() {
  const MB = Number(process.env.MB || 10);
  const fd = fs.openSync(LOG, "r");
  const buf = Buffer.alloc(MB * 1024 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let text = buf.subarray(0, n).toString("utf8");
  text = text.slice(0, text.lastIndexOf("\n") + 1);
  if (process.env.ANSI) {
    const E = "\x1b[";
    text = text
      .split("\n")
      .map((l, i) => (i % 3 === 0 && l ? `${E}0;32m${l.replace(/\b(ERROR|WARN|INFO)\b/, `${E}1;31m$1${E}0;32m`)}${E}0m` : l))
      .join("\n");
  }
  if (SET === "freeze") {
    // a worst-case line every ~2,000 lines, so one is on screen wherever we are
    const ls = text.split("\n");
    const bad = "a".repeat(1999) + "!";
    for (let i = 50; i < ls.length; i += 2000) ls.splice(i, 0, bad);
    text = ls.join("\n");
  }
  const FILE = "D:\\perf\\collector.log";
  const st = {
    session: JSON.stringify({
      version: 3,
      tabs: [{ id: "t1", title: "collector.log", path: FILE, lang: "plaintext", content: "", dirty: false, view: "editor", mtime: 1, encoding: "utf-8", reloadSeq: 0, needsLoad: true, loadError: "", label: "", logColors: process.env.COLORS === "off" ? "off" : "on" }],
      activeId: "t1",
      splitRatio: 0.5,
      fontSize: 14,
    }),
    tags: JSON.stringify({ version: 1, tags: [{ name: "common", rules, updated: "" }], assign: { dir: {}, file: {}, name: {} } }),
  };
  const impl = {
    LoadSession: () => ({ data: st.session, notice: "", detail: "", blocked: false }),
    SaveSession: () => {},
    CloseWithSession: () => {},
    LoadTags: () => ({ data: st.tags, exists: true, restored: false, restoredFrom: "", broken: "", problem: "", newer: false }),
    SaveTags: () => {},
    ReadFile: (p) => ({ path: p, name: "collector.log", content: text, modTime: 1, size: text.length, encoding: "utf-8", binary: false, canceled: false }),
    ReadFileAs: (p) => impl.ReadFile(p),
    StatFile: () => ({ exists: true, modTime: 1, size: text.length }),
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    FrontendReady: () => [],
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  const srv = await serve();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("dialog", (d) => d.accept());
  page.on("console", (m) => (m.type() === "warning" || m.type() === "error") && !/Measure loop/.test(m.text()) && console.log("  [console]", m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => (impl[name] ? impl[name](...args) : null));
  await page.addInitScript(() => {
    window.__events = {};
    window.go = { main: { App: new Proxy({}, { get: (_, name) => (...args) => window.__goCall(String(name), args) }) } };
    window.runtime = new Proxy(
      { EventsOnMultiple: (n, cb) => ((window.__events[n] = window.__events[n] || []).push(cb), () => {}), EventsEmit: () => {} },
      { get: (t, n) => t[n] || (() => undefined) }
    );
  });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => (document.querySelector(".cm-content")?.textContent || "").length > 1000, null, { timeout: 120000 });
  const openMs = Date.now() - t0;
  const r = await page.evaluate(async () => {
    const sc = document.querySelector(".cm-scroller");
    const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
    const stat = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), over50: s.filter((x) => x > 50).length };
    };
    await frame();
    await frame();
    const smooth = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      sc.scrollTop += 120;
      await frame();
      smooth.push(performance.now() - t);
    }
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const jumps = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      sc.scrollTop = Math.floor(rnd() * (sc.scrollHeight - sc.clientHeight));
      await frame();
      jumps.push(performance.now() - t);
    }
    return { smooth: stat(smooth), jumps: stat(jumps), height: sc.scrollHeight };
  });
  console.log(JSON.stringify({ dist: DIST, set: SET, rules: rules.length, ansi: !!process.env.ANSI, mb: MB, openMs, ...r }));
  await browser.close();
  srv.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
