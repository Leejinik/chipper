// Headless test of stage 4 (tag assignment): tree right-click → tag window,
// inheritance / file override / "no tags" / follow parent, server root, new
// tag, rotated files, names outside the bundle, per-pane tag chips, keyboard
// tree navigation, persistence across restarts. Same fake Go side as
// tags-e2e.cjs (state lives in Node, so it survives reloads).
//
//   cd frontend && npm run build && node tests/tags-assign-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder>  → screenshots
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const notes = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
function note(s) {
  notes.push(s);
  console.log("  note " + s);
}

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
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

function makeBackend() {
  const st = { session: "", tags: null, bak: null, calls: [], files: {}, scan: null };
  const impl = {
    LoadSession: () => ({ data: st.session, notice: "", detail: "", blocked: false }),
    SaveSession: (d) => {
      st.session = d;
    },
    CloseWithSession: (d) => {
      if (d) st.session = d;
    },
    LoadTags: () =>
      st.tags == null
        ? { data: "", exists: false, restored: false, broken: "", problem: "", newer: false }
        : { data: st.tags, exists: true, restored: false, broken: "", problem: "", newer: false },
    SaveTags: (js) => {
      const v = JSON.parse(js);
      if (v.version !== 1 || !Array.isArray(v.tags)) throw new Error("bad envelope");
      if (st.tags != null) st.bak = st.tags;
      st.tags = js;
    },
    ReadFile: (p) => {
      const c = st.files[p];
      if (c == null) throw new Error("no such file " + p);
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: false, canceled: false };
    },
    ReadFileAs: (p) => impl.ReadFile(p),
    StatFile: (p) => (st.files[p] != null ? { exists: true, modTime: 1, size: st.files[p].length } : { exists: false, modTime: 0, size: 0 }),
    ScanBundle: () => st.scan,
    OpenFolderDialog: () => (st.scan ? st.scan.root : ""),
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  return {
    st,
    call: (name, args) => {
      st.calls.push({ name, args });
      const f = impl[name];
      return f ? f(...args) : null;
    },
  };
}

const INIT = () => {
  window.__events = {};
  const call = (name) => (...args) => window.__goCall(name, args);
  window.go = { main: { App: new Proxy({}, { get: (_, name) => call(String(name)) }) } };
  window.runtime = new Proxy(
    {
      EventsOnMultiple: (name, cb) => {
        (window.__events[name] = window.__events[name] || []).push(cb);
        return () => {
          window.__events[name] = (window.__events[name] || []).filter((x) => x !== cb);
        };
      },
      EventsEmit: (name, ...data) => (window.__events[name] || []).forEach((cb) => cb(...data)),
    },
    { get: (t, name) => t[name] || (() => undefined) }
  );
};

async function openPage(browser, url, be) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(500);
  return { ctx, page };
}

const tab = (id, p, extra = {}) => ({
  id,
  title: p.split(/[\\/]/).pop(),
  path: p,
  lang: "plaintext",
  content: "",
  dirty: false,
  view: "editor",
  mtime: 1,
  encoding: "utf-8",
  reloadSeq: 0,
  needsLoad: true,
  loadError: "",
  label: "",
  logColors: "",
  ...extra,
});
const session = (tabs, activeId, extra = {}) => JSON.stringify({ version: 3, tabs, activeId, splitRatio: 0.5, fontSize: 14, ...extra });
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const spansWith = (page, color) =>
  page.$$eval(`.cm-content span[style*="color: ${rgb(color)}"]`, (els) => els.map((e) => e.textContent));
// coloured spans per pane, in pane order
const paneSpans = (page, color) =>
  page.$$eval(
    ".mpane",
    (panes, c) => panes.map((p) => [...p.querySelectorAll(`.cm-content span[style*="color: ${c}"]`)].map((e) => e.textContent)),
    rgb(color)
  );
const statusTags = (page) => page.$eval(".st-tags", (e) => e.textContent.trim()).catch(() => null);
// status bar text, waiting up to 3 s for it to become `want` (files load asynchronously)
async function statusIs(page, want) {
  let v;
  for (let i = 0; i < 30; i++) {
    v = await statusTags(page);
    if (v === want) return v;
    await sleep(100);
  }
  if (process.env.DIAG) console.log("DIAG", want, v, await page.$$eval(".mpane", (ps) => ps.map((p) => p.className + " | " + p.querySelector(".mp-title")?.textContent)), await page.$eval(".st-path", (e) => e.textContent).catch(() => "?"));
  return v;
}
const paneChips = (page) =>
  page.$$eval(".mpane", (ps) => ps.map((p) => [...p.querySelectorAll(".mp-tag")].map((e) => e.textContent).join(",")));
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const flush = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(600);
};
// a tree row by its data-key (server/rel path keys built by BundleTree)
const row = (key) => `.bt-row[data-key="${key}"]`;
const rowChips = (page, key) =>
  page.$$eval(`${row(key)} .bt-tag`, (es) => es.map((e) => ({ t: e.textContent, c: e.className, title: e.title })));

async function assignVia(page, rowKey, fn) {
  await page.click(row(rowKey), { button: "right" });
  await page.waitForSelector(".bt-menu");
  await page.click(".bt-menu >> text=태그 지정…");
  await page.waitForSelector(".tag-assign");
  const r = await fn();
  return r;
}
const checkTag = (page, name, on = true) => page.setChecked(`.ta-tag[data-tag="${name}"] input[type=checkbox]`, on);
const confirm = async (page) => {
  await page.click(".tag-assign .ta-ok");
  await sleep(250);
};

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const shots = process.env.SHOTS;
  try {
    const be = makeBackend();
    const R = "C:\\b\\bromo";
    const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
    const servers = ["s1", "s2", "s3"];
    const files = {};
    const add = (sv, rel, text) => {
      be.st.files[P(sv, rel)] = text;
      (files[sv] = files[sv] || []).push({ rel, size: text.length, compressed: false });
    };
    for (const sv of servers) {
      add(sv, "modules/lizcollector/collector.log", `kafka rebalance begin ${sv}\nERROR x\nlogin ok\n`);
      add(sv, "modules/zookeeper/zk.log", "sshd up\nkafka rebalance\n");
    }
    for (const d of ["2026-10-21", "2026-10-22", "2026-10-23"]) add("s1", `modules/lizcollector/admin.log.${d}`, `login ${d}\nkafka rebalance\n`);
    for (const n of [1, 2, 3]) add("s1", `modules/zookeeper/zk.log.${n}`, `sshd ${n}\n`);
    add("s1", "messages", "sshd login\n");
    be.st.scan = { root: R, servers: servers.map((name) => ({ name, files: files[name], truncated: false, unreadable: 0 })) };
    be.st.files["D:\\tmp\\messages"] = "kafka rebalance\nsshd login\n";
    const rule = (id, pattern, color) => ({ id, on: true, label: "", pattern, kind: "text", caseSensitive: false, color, line: false, filter: true });
    be.st.tags = JSON.stringify({
      version: 1,
      tags: [
        { name: "common", rules: [rule("e", "ERROR", "#dd0009")], updated: "" },
        { name: "collector", rules: [rule("k", "kafka rebalance", "#dd0001")], updated: "" },
        { name: "admin", rules: [rule("a", "login", "#dd0002")], updated: "" },
        { name: "syslog", rules: [rule("s", "sshd", "#dd0003")], updated: "" },
      ],
      assign: { dir: {}, file: {}, name: {} },
    });
    const tabs = servers.map((sv, i) => tab("t" + i, P(sv, "modules/lizcollector/collector.log"), { label: `${sv} · collector.log` }));
    tabs.push(tab("out", "D:\\tmp\\messages"));
    const slots = [0, 1, 2].map((i) => ({ tabId: "t" + i, mode: "read", server: servers[i] }));
    while (slots.length < 6) slots.push({ tabId: "", mode: "read", server: "" });
    const multi = { on: true, count: 3, slots, bundle: { root: R, servers } };
    be.st.session = session(tabs, "t0", { multi });

    let { ctx, page } = await openPage(browser, url, be);
    await sleep(400);

    console.log("1. 처음: 태그 지정 없음");
    ok("칸 3개", (await page.$$(".mpane")).length === 3);
    ok("collector 색 없음", (await spansWith(page, "#dd0001")).length === 0);
    ok("칸 태그 표시 없음", (await paneChips(page)).join("|") === "||", await paneChips(page));
    ok("칸마다 common 옅은 칩은 항상", (await page.$$eval(".mpane .mp-common", (es) => es.map((e) => e.textContent))).join("|") === "common|common|common");
    ok("트리 줄은 Tab 으로 갈 수 있는 줄이 하나(첫 줄 tabIndex 0)", (await page.$$eval('.bt-row[tabindex="0"]', (es) => es.length)) === 1);

    console.log("2. 폴더 지정 → 서버 3대 같은 경로 칸 색");
    await page.click(row("d:s1/modules"));
    await page.click(row("d:s1/modules/lizcollector"));
    await assignVia(page, "d:s1/modules/lizcollector", async () => {
      const where = await page.$eval(".ta-where", (e) => e.textContent);
      ok("어디에 걸리는지 문장 (모든 서버의 modules/lizcollector)", where.includes("모든 서버의 modules/lizcollector"), where);
      ok("common 회색 「항상 적용」·체크 대상 아님", await page.$eval(".ta-common", (e) => e.textContent.includes("항상 적용") && e.querySelector("input").disabled));
      ok("처음 상태 = 상위 폴더 따르기", await page.$eval('.ta-modes input[type=radio]', (e) => e.checked));
      if (shots) await page.screenshot({ path: path.join(shots, "stage4-assign-dir.png") });
      await checkTag(page, "collector");
      await confirm(page);
    });
    ok("창 닫힘", !(await page.$(".tag-assign")));
    const p2 = await paneSpans(page, "#dd0001");
    ok("서버 3대 칸 모두 collector 색 (즉시 다시 칠함)", p2.length === 3 && p2.every((x) => x.includes("kafka rebalance")), p2);
    ok("칸마다 🏷 collector", (await paneChips(page)).join("|") === "collector|collector|collector", await paneChips(page));
    ok("상태 표시줄 = common + collector", (await statusIs(page, "🏷 common + collector")) === "🏷 common + collector", await statusTags(page));
    let ch = await rowChips(page, "d:s1/modules/lizcollector");
    ok("트리: 폴더에 직접 칩", ch.length === 1 && ch[0].t === "collector" && ch[0].c.includes("direct"), ch);
    ch = await rowChips(page, "f:s1/modules/lizcollector/collector.log");
    ok("트리: 하위 파일은 옅은 칩 + 「modules/lizcollector 에서 물려받음」", ch.length === 1 && ch[0].c.includes("inherited") && ch[0].title === "modules/lizcollector 에서 물려받음", ch);
    ch = await rowChips(page, "d:s1/modules");
    ok("트리: 상위 폴더에는 칩 없음", ch.length === 0, ch);
    await flush(page);
    ok("저장: assign.dir", JSON.stringify(savedTags(be).assign.dir) === JSON.stringify({ "modules/lizcollector": ["collector"] }), savedTags(be).assign);

    console.log("3. 칸 표시 누르면 태그 창의 그 태그");
    await page.click(".mpane >> nth=1 >> .mp-tag");
    await page.waitForSelector(".tags-dialog");
    ok("태그 창 = collector 선택", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "collector");
    ok("어디에 붙어 있나 = 모든 서버의 modules/lizcollector", (await page.$$eval(".tags-place", (es) => es.map((e) => e.textContent))).some((w) => w.includes("모든 서버의 modules/lizcollector")));
    await page.keyboard.press("Escape");
    await sleep(100);

    console.log("4. 회전 파일 묶음에 직접 지정 → 상위 폴더 덮어씀");
    await assignVia(page, "r:s1/modules/lizcollector/admin.log", async () => {
      const where = await page.$eval(".tag-assign .ta-where", (e) => e.textContent);
      ok("파일 문장: 「modules/lizcollector/admin.log 와 회전 파일 모두」", where.includes("modules/lizcollector/admin.log 와 회전 파일 모두"), where);
      const sub = await page.$$eval(".tag-assign .chips-sub", (es) => es.map((e) => e.textContent).join(" "));
      ok("폴더 태그 대신이라는 안내", sub.includes("폴더 태그(collector) 대신"), sub);
      ok("물려받는 중 표시", (await page.$eval('.ta-tag[data-tag="collector"]', (e) => e.textContent)).includes("물려받는 중"));
      await checkTag(page, "admin");
      await confirm(page);
    });
    ch = await rowChips(page, "r:s1/modules/lizcollector/admin.log");
    ok("트리: 파일 묶음에 📌 덮어쓴 칩", ch.length === 1 && ch[0].c.includes("override") && ch[0].t.includes("📌") && ch[0].title.includes("collector") , ch);
    await page.click(row("r:s1/modules/lizcollector/admin.log"));
    await page.click(row("f:s1/modules/lizcollector/admin.log.2026-10-22"));
    await sleep(500);
    ok("admin.log.2026-10-22 = common + admin (폴더 collector 대신)", (await statusIs(page, "🏷 common + admin")) === "🏷 common + admin", await statusTags(page));
    ok("그 칸 표시 = admin", (await paneChips(page))[0] === "admin", await paneChips(page));
    ok("admin 색", (await spansWith(page, "#dd0002")).some((x) => x === "login"));
    await page.click(row("f:s1/modules/lizcollector/admin.log.2026-10-23"));
    await sleep(400);
    ok("같은 묶음 다른 회전 파일도 admin", (await statusIs(page, "🏷 common + admin")) === "🏷 common + admin", await statusTags(page));
    await flush(page);
    ok("저장: assign.file 회전 키", JSON.stringify(savedTags(be).assign.file) === JSON.stringify({ "modules/lizcollector/admin.log": ["admin"] }), savedTags(be).assign.file);

    console.log("5. 체크 모두 끄기 = 상위 폴더 따르기(키 삭제)");
    await assignVia(page, "r:s1/modules/lizcollector/admin.log", async () => {
      ok("열면 admin 체크돼 있음", await page.isChecked('.ta-tag[data-tag="admin"] input[type=checkbox]'));
      await checkTag(page, "admin", false);
      ok("체크 다 끄면 「상위 폴더 따르기」 선택됨", await page.$eval('.ta-modes input[type=radio]', (e) => e.checked));
      await confirm(page);
    });
    await sleep(200);
    ok("다시 폴더 태그 (common + collector)", (await statusIs(page, "🏷 common + collector")) === "🏷 common + collector", await statusTags(page));
    await flush(page);
    ok("저장: file 키 삭제됨", JSON.stringify(savedTags(be).assign.file) === "{}", savedTags(be).assign.file);

    console.log("6. 「이 파일은 태그 없음」 = 상속 끊기 → 다시 상위 따르기");
    await page.click(row("d:s2/modules"));
    await page.click(row("d:s2/modules/lizcollector"));
    await assignVia(page, "f:s2/modules/lizcollector/collector.log", async () => {
      await page.click('.ta-modes label:has-text("태그 없음") input');
      await confirm(page);
    });
    await sleep(200);
    let p6 = await paneSpans(page, "#dd0001");
    ok("collector.log 칸들 collector 색 꺼짐 (s2·s3 칸)", p6.slice(1).every((x) => x.length === 0), p6);
    ok("칸 표시 없어짐", (await paneChips(page)).slice(1).join("|") === "|", await paneChips(page));
    ch = await rowChips(page, "f:s2/modules/lizcollector/collector.log");
    ok("트리: 「📌 태그 없음」 칩 (폴더 태그 대신)", ch.length === 1 && ch[0].c.includes("none") && ch[0].c.includes("override"), ch);
    await flush(page);
    ok("저장: file 키 = []", JSON.stringify(savedTags(be).assign.file) === JSON.stringify({ "modules/lizcollector/collector.log": [] }), savedTags(be).assign.file);
    await assignVia(page, "f:s1/modules/lizcollector/collector.log", async () => {
      const now = await page.$eval(".ta-now", (e) => e.textContent);
      ok("다른 서버 같은 파일에서 열어도 「태그 없음」 상태", now.includes("태그 없음으로 지정"), now);
      await page.click('.ta-modes label:has-text("상위 폴더 따르기") input');
      await confirm(page);
    });
    await sleep(200);
    p6 = await paneSpans(page, "#dd0001");
    ok("상위 따르기로 되돌리면 색 복귀", p6.slice(1).every((x) => x.includes("kafka rebalance")), p6);

    console.log("7. 서버 루트 지정 · 폴더 「태그 없음」 · 새 태그 만들기");
    await assignVia(page, "s:s1", async () => {
      const where = await page.$eval(".ta-where", (e) => e.textContent);
      ok("서버 루트 문장", where.includes("모든 서버의 서버 폴더 전체"), where);
      await checkTag(page, "syslog");
      await confirm(page);
    });
    await page.click(row("d:s1/modules/zookeeper"));
    ch = await rowChips(page, "d:s1/modules/zookeeper");
    ok("zookeeper 폴더는 서버 루트에서 물려받음", ch.length === 1 && ch[0].t === "syslog" && ch[0].title === "서버 폴더 전체에서 물려받음", ch);
    ch = await rowChips(page, "d:s1/modules/lizcollector");
    ok("lizcollector 는 자기 지정이 가까워 collector", ch.length === 1 && ch[0].t === "collector", ch);
    ch = await rowChips(page, "f:s1/messages");
    ok("서버 루트 바로 아래 파일도 syslog", ch.length === 1 && ch[0].t === "syslog", ch);
    await assignVia(page, "d:s1/modules/zookeeper", async () => {
      await page.click('.ta-modes label:has-text("태그 없음") input');
      await confirm(page);
    });
    // 3단계 회전 키: 지금 파일 zk.log 는 zk.log 회전 묶음 줄 안에 있음 → 잠깐 펼쳐서 봄
    await page.click(row("r:s1/modules/zookeeper/zk.log"));
    ok("(앞 조건) 묶음 안에 zk.log 줄 보임", !!(await page.$(row("f:s1/modules/zookeeper/zk.log"))));
    ch = await rowChips(page, "f:s1/modules/zookeeper/zk.log");
    ok("폴더 「태그 없음」 → 아래 파일 칩 없음(상속 끊김)", ch.length === 0, ch);
    await page.click(row("r:s1/modules/zookeeper/zk.log"));
    ch = await rowChips(page, "d:s1/modules/zookeeper");
    ok("폴더에 「태그 없음」 칩", ch.length === 1 && ch[0].c.includes("none"), ch);
    await assignVia(page, "d:s1/modules/zookeeper", async () => {
      await page.fill(".ta-new input", "collector");
      await page.click(".ta-new >> text=새 태그 만들기");
      ok("같은 이름 거부", (await page.$eval(".tag-assign .tags-name-error", (e) => e.textContent)).includes("이미 있습니다"));
      await page.fill(".ta-new input", "Collector");
      await page.press(".ta-new input", "Enter");
      ok("새 태그 Collector 바로 체크됨", await page.isChecked('.ta-tag[data-tag="Collector"] input[type=checkbox]'));
      ok("모드가 「고른 태그」로 (태그 없음 해제)", !(await page.isChecked('.ta-modes label:has-text("태그 없음") input')));
      await confirm(page);
    });
    await flush(page);
    const s7 = savedTags(be);
    ok("Collector 태그 생김 (collector 와 따로)", s7.tags.map((t) => t.name).join() === "common,collector,admin,syslog,Collector", s7.tags.map((t) => t.name));
    ok("assign.dir 세 곳", JSON.stringify(s7.assign.dir) === JSON.stringify({ "modules/lizcollector": ["collector"], "": ["syslog"], "modules/zookeeper": ["Collector"] }), s7.assign.dir);

    console.log("8. 회전 파일 전체 적용 (zk.log.1~3 묶음)");
    await assignVia(page, "r:s1/modules/zookeeper/zk.log", async () => {
      await checkTag(page, "syslog");
      await confirm(page);
    });
    await page.click(row("r:s1/modules/zookeeper/zk.log"));
    for (const n of [1, 3]) {
      await page.click(row(`f:s1/modules/zookeeper/zk.log.${n}`));
      await sleep(400);
      ok(`zk.log.${n} = common + syslog`, (await statusIs(page, "🏷 common + syslog")) === "🏷 common + syslog", await statusTags(page));
    }
    await page.click(row("f:s1/modules/zookeeper/zk.log"));
    await sleep(400);
    const live = await statusTags(page);
    ok("지금 쓰는 zk.log 도 회전 묶음 태그 = common + syslog", live === "🏷 common + syslog", live);

    console.log("9. 키보드로 트리 이동·열기·메뉴");
    await page.click(".bt-filter");
    await page.keyboard.press("ArrowDown");
    await sleep(100);
    const fk = () => page.evaluate(() => document.activeElement?.getAttribute("data-key"));
    ok("거르기 칸 ↓ → 트리 줄로", (await fk()) !== null, await fk());
    await page.keyboard.press("Home");
    await sleep(80);
    ok("Home → 첫 줄 s1", (await fk()) === "s:s1", await fk());
    await page.keyboard.press("ArrowLeft");
    await sleep(80);
    ok("← 로 서버 접기", (await page.getAttribute(row("s:s1"), "aria-expanded")) === "false");
    await page.keyboard.press("ArrowRight");
    await sleep(80);
    ok("→ 로 펼치기", (await page.getAttribute(row("s:s1"), "aria-expanded")) === "true");
    await page.keyboard.press("ArrowRight");
    await sleep(80);
    ok("→ 한 번 더 = 첫 자식(modules)", (await fk()) === "d:s1/modules", await fk());
    await page.keyboard.press("ArrowDown");
    await sleep(80);
    ok("↓ = lizcollector", (await fk()) === "d:s1/modules/lizcollector", await fk());
    await page.keyboard.press("ArrowLeft");
    await sleep(80);
    ok("열린 폴더에서 ← = 접기", (await page.getAttribute(row("d:s1/modules/lizcollector"), "aria-expanded")) === "false");
    await page.keyboard.press("ArrowLeft");
    await sleep(80);
    ok("닫힌 폴더에서 ← = 부모로", (await fk()) === "d:s1/modules", await fk());
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await sleep(80);
    ok("폴더에서 Enter = 펼치기", (await page.getAttribute(row("d:s1/modules/lizcollector"), "aria-expanded")) === "true");
    await page.keyboard.press("ArrowDown");
    await sleep(80);
    ok("↓ = collector.log", (await fk()) === "f:s1/modules/lizcollector/collector.log", await fk());
    // open something else in pane 1 first, then Enter brings collector.log back
    await page.keyboard.press("Shift+F10");
    await sleep(150);
    ok("Shift+F10 → 트리 메뉴, 첫 항목에 포커스", !!(await page.$(".bt-menu")) && (await page.evaluate(() => document.activeElement?.textContent || "")).includes("태그 지정"));
    await page.keyboard.press("ArrowDown");
    await sleep(50);
    ok("메뉴 안 ↓", (await page.evaluate(() => document.activeElement?.textContent || "")).includes("칸에 열기"));
    await page.keyboard.press("Escape");
    await sleep(150);
    ok("Esc → 메뉴 닫히고 줄로 포커스 복귀", !(await page.$(".bt-menu")) && (await fk()) === "f:s1/modules/lizcollector/collector.log", await fk());
    await page.keyboard.press("ContextMenu");
    await sleep(150);
    ok("메뉴 키로도 메뉴", !!(await page.$(".bt-menu")));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".tag-assign");
    ok("메뉴에서 Enter → 태그 지정 창", !!(await page.$(".tag-assign")));
    ok("창이 열리면 첫 체크 칸에 포커스", await page.evaluate(() => !!document.activeElement?.closest(".ta-tag")));
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    await sleep(200);
    ok("Esc = 취소 (바뀐 것 없음)", !(await page.$(".tag-assign")) && (await rowChips(page, "f:s1/modules/lizcollector/collector.log"))[0]?.c.includes("inherited"));
    ok("창 닫으면 트리 줄로 포커스 복귀", (await fk()) === "f:s1/modules/lizcollector/collector.log", await fk());
    // pane 1 shows zk.log (step 8); Enter on collector.log brings it back
    ok("(앞 조건) 1번 칸은 zk.log", (await page.$eval(".mpane >> nth=0 >> .mp-title", (e) => e.textContent)).includes("zk.log"));
    await page.focus(row("f:s1/modules/lizcollector/collector.log"));
    await page.keyboard.press("Enter");
    await sleep(500);
    ok("Enter = 파일 열기 (s1 칸에 collector.log)", (await page.$eval(".mpane >> nth=0 >> .mp-title", (e) => e.textContent)).includes("collector.log"));

    console.log("10. 묶음 밖 파일: 탭 우클릭 → 이 이름의 파일에 태그");
    await page.click(".tab:has-text('messages')", { button: "right" });
    await page.waitForSelector(".tag-menu");
    const item = await page.$eval(".tag-menu .menu-item", (e) => e.textContent);
    ok("탭 메뉴: 「이 이름(messages)의 파일에 태그…」", item.includes("이 이름(messages)의 파일에 태그"), item);
    await page.click(".tag-menu .menu-item >> nth=0");
    await page.waitForSelector(".tag-assign");
    const w10 = await page.$eval(".ta-where", (e) => e.textContent);
    ok("이름 문장", w10.includes("이름이 「messages」") && w10.includes("묶음 밖"), w10);
    await checkTag(page, "syslog");
    await confirm(page);
    await flush(page);
    ok("저장: assign.name.messages", JSON.stringify(savedTags(be).assign.name) === JSON.stringify({ messages: ["syslog"] }), savedTags(be).assign.name);
    // bundle tab right-click offers the file series instead
    await page.click(".tab:has-text('s2 · collector.log')", { button: "right" });
    await page.waitForSelector(".tag-menu");
    ok("묶음 파일 탭 메뉴 = 「이 파일(회전 파일 포함)에 태그 지정…」", (await page.$eval(".tag-menu .menu-item", (e) => e.textContent)).includes("이 파일(회전 파일 포함)"));
    await page.keyboard.press("Escape");
    await sleep(100);
    ok("Esc 로 탭 메뉴 닫힘", !(await page.$(".tag-menu")));
    if (shots) {
      await page.click(row("r:s1/modules/lizcollector/admin.log")).catch(() => {});
      await page.screenshot({ path: path.join(shots, "stage4-tree.png") });
    }
    await ctx.close();

    console.log("11. 다시 켜도 지정 유지 (tags.json)");
    // single view on the outside file → status bar 🏷 menu
    const sess = JSON.parse(be.st.session);
    ({ ctx, page } = await openPage(browser, url, be));
    await sleep(500);
    const p11 = await paneSpans(page, "#dd0001");
    ok("다시 켜도 collector 색 (3칸)", p11.length === 3 && p11.every((x) => x.includes("kafka rebalance")), p11);
    await page.click(row("d:s1/modules"));
    ch = await rowChips(page, "d:s1/modules/lizcollector");
    ok("다시 켜도 트리 칩", ch.length === 1 && ch[0].t === "collector", ch);
    ch = await rowChips(page, "s:s1");
    ok("서버 루트 칩 유지", ch.length === 1 && ch[0].t === "syslog", ch);
    await ctx.close();
    be.st.session = JSON.stringify({ ...sess, activeId: "out", multi: { ...sess.multi, on: false } });
    ({ ctx, page } = await openPage(browser, url, be));
    await sleep(500);
    ok("묶음 밖 messages = common + syslog", (await statusIs(page, "🏷 common + syslog")) === "🏷 common + syslog", await statusTags(page));
    ok("sshd 색", (await spansWith(page, "#dd0003")).includes("sshd"));
    await page.dispatchEvent(".st-tags", "mousedown");
    await page.waitForSelector(".tag-menu");
    await page.click(".tag-menu >> text=이 이름(messages)의 파일에 태그");
    await page.waitForSelector(".tag-assign");
    ok("상태 표시줄 🏷 에서도 같은 창, syslog 체크된 채", await page.isChecked('.ta-tag[data-tag="syslog"] input[type=checkbox]'));
    await checkTag(page, "syslog", false);
    await confirm(page);
    await sleep(200);
    ok("체크 끄면 이름 지정 지움 → common 만", (await statusIs(page, "🏷 common")) === "🏷 common", await statusTags(page));
    await flush(page);
    ok("저장: name 키 삭제", JSON.stringify(savedTags(be).assign.name) === "{}", savedTags(be).assign.name);
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\nassign e2e: ${pass} passed, ${fails.length} failed`);
  for (const n of notes) console.log("NOTE " + n);
  for (const f of fails) console.log("FAIL " + f);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
