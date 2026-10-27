// Headless test of log colour tags against the built frontend (frontend/dist).
// The Go bindings (window.go.main.App) and the Wails runtime are faked; the fake
// lives on the Node side so its state (session, tags.json) survives reloads.
//
//   cd frontend && npm run build && node tests/tags-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

// ---- static server for dist -------------------------------------------------
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

// ---- fake Go side -------------------------------------------------------------
function makeBackend() {
  const st = { session: "", tags: null, bak: null, calls: [], files: {}, scan: null, failSave: false, loadTags: null };
  const impl = {
    LoadSession: () => st.session,
    SaveSession: (d) => {
      st.session = d;
    },
    CloseWithSession: (d) => {
      if (d) st.session = d;
    },
    LoadTags: () => {
      if (st.loadTags) return st.loadTags;
      return st.tags == null
        ? { data: "", exists: false, restored: false, broken: "", problem: "", newer: false }
        : { data: st.tags, exists: true, restored: false, broken: "", problem: "", newer: false };
    },
    SaveTags: (js) => {
      if (st.failSave) throw new Error("disk full (fake)");
      const v = JSON.parse(js);
      if (v.version !== 1 || !Array.isArray(v.tags)) throw new Error("bad envelope");
      const names = v.tags.map((t) => t.name);
      if (new Set(names).size !== names.length) throw new Error("dup tag name");
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
      st.calls.push({ name, args, t: Date.now() });
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push(d.type() + ": " + d.message());
    await (page.__dialogAnswer === false ? d.dismiss() : d.accept());
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(300);
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
// text of the editor spans coloured `hex` (the browser rewrites the style as rgb())
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const spansWith = (page, color) =>
  page.$$eval(`.cm-content span[style*="color: ${rgb(color)}"]`, (els) => els.map((e) => e.textContent));
const statusTags = (page) => page.$eval(".st-tags", (e) => e.textContent.trim()).catch(() => null);
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const tagNames = (be) => savedTags(be)?.tags.map((t) => t.name);

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    // =============== 1. common migration from an old session =================
    console.log("1. common 이전");
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "2026-10-20 10:00:00 INFO start\nERROR boom\nxxBANANAxx and banana\n";
      const oldRules = [
        { id: "error", on: true, label: "오류", pattern: "\\bERROR\\b", regex: true, caseSensitive: false, color: "#aa0001", line: true },
        { id: "info", on: true, label: "정보", pattern: "INFO", regex: false, caseSensitive: false, color: "#aa0002", line: false },
        { id: "u1", on: true, label: "바나나", pattern: "banana", regex: false, caseSensitive: false, color: "#aa0003", line: false },
      ];
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1", { logRules: oldRules });
      let { ctx, page } = await openPage(browser, url, be);
      await sleep(500);
      const s1 = savedTags(be);
      ok("tags.json 생성됨", !!s1);
      ok("common 하나", s1 && s1.tags.length === 1 && s1.tags[0].name === "common", s1 && s1.tags.map((t) => t.name));
      const r = s1 ? s1.tags[0].rules : [];
      ok("규칙 3개 그대로", r.map((x) => x.id).join() === "error,info,u1", r.map((x) => x.id));
      ok("regex:true → kind regex, regex:false → kind word", r.map((x) => x.kind).join() === "regex,word,word", r.map((x) => x.kind));
      ok("filter 기본값: 오류 true · 정보 false · 사용자 규칙 true", r.map((x) => x.filter).join() === "true,false,true", r.map((x) => x.filter));
      ok("옛 regex 필드는 새 규칙에 없음", r.every((x) => !("regex" in x)));
      // colours from the migrated common: "banana" is a word rule (old regex:false)
      ok("이전된 단어 규칙 색칠 (banana 만, xxBANANAxx 아님)", JSON.stringify(await spansWith(page, "#aa0003")) === JSON.stringify(["banana"]), await spansWith(page, "#aa0003"));
      // session written afterwards has no logRules
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(700);
      ok("세션에 logRules 더는 안 씀", !("logRules" in JSON.parse(be.st.session)), Object.keys(JSON.parse(be.st.session)));
      await ctx.close();

      // restart with an OLD session again (logRules present) — tags.json wins, no second migration
      const tagsBefore = be.st.tags;
      const changed = JSON.parse(tagsBefore);
      changed.tags[0].rules[0].color = "#bb0001";
      be.st.tags = JSON.stringify(changed, null, 2);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1", { logRules: oldRules });
      const savesBefore = be.st.calls.filter((c) => c.name === "SaveTags").length;
      ({ ctx, page } = await openPage(browser, url, be));
      await sleep(800);
      ok("다시 켜면 이전 안 함 (tags.json 그대로)", JSON.parse(be.st.tags).tags[0].rules[0].color === "#bb0001");
      ok("다시 켜도 SaveTags 안 부름(바뀐 것 없음)", be.st.calls.filter((c) => c.name === "SaveTags").length === savesBefore);
      ok("tags.json 규칙으로 색칠", (await spansWith(page, "#bb0001")).includes("ERROR"));
      await ctx.close();

      // first run without any session → defaults in common
      const be2 = makeBackend();
      ({ ctx, page } = await openPage(browser, url, be2));
      await sleep(400);
      ok("세션 없음 → common = 기본 규칙 6개", savedTags(be2)?.tags[0].rules.length === 6, savedTags(be2)?.tags[0].rules.length);
      ok(
        "기본 규칙 filter",
        savedTags(be2)?.tags[0].rules.map((x) => x.filter).join() === "true,true,false,false,false,true"
      );
      await ctx.close();

      // first tag save fails → session keeps the old logRules (nothing lost)
      const be3 = makeBackend();
      be3.st.failSave = true;
      be3.st.files["D:\\logs\\app.log"] = "x\n";
      be3.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1", { logRules: oldRules });
      ({ ctx, page } = await openPage(browser, url, be3));
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(700);
      ok("태그 첫 저장 실패 시 세션에 logRules 유지", JSON.stringify(JSON.parse(be3.st.session).logRules) === JSON.stringify(oldRules));
      be3.st.failSave = false;
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(700);
      ok("저장 성공 뒤 세션에서 logRules 빠짐", !!be3.st.tags && !("logRules" in JSON.parse(be3.st.session)));
      await ctx.close();
    }

    // =============== 2. rule kinds colour + risky regex + tag window ============
    console.log("2. 규칙 종류 색칠 · 위험 정규식 · 태그 창");
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\k.log"] =
        "10:00 Kafka Rebalance started\nerror err: xerr\ntook 120ms and 5ms\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\n";
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          {
            name: "common",
            rules: [
              { id: "t", on: true, label: "", pattern: "kafka rebalance", kind: "text", caseSensitive: false, color: "#cc0001", line: false, filter: true },
              { id: "w", on: true, label: "", pattern: "err", kind: "word", caseSensitive: false, color: "#cc0002", line: false, filter: true },
              { id: "r", on: true, label: "", pattern: "\\d{3}ms", kind: "regex", caseSensitive: false, color: "#cc0003", line: false, filter: true },
            ],
            updated: "",
          },
        ],
        assign: { dir: {}, file: {}, name: {} },
      });
      be.st.session = session([tab("t1", "D:\\logs\\k.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(300);
      ok("글자 그대로(공백 포함, 대소문자 무시)", JSON.stringify(await spansWith(page, "#cc0001")) === '["Kafka Rebalance"]', await spansWith(page, "#cc0001"));
      ok("단어 (error·xerr 안 칠함)", JSON.stringify(await spansWith(page, "#cc0002")) === '["err"]', await spansWith(page, "#cc0002"));
      ok("정규식", JSON.stringify(await spansWith(page, "#cc0003")) === '["120ms"]', await spansWith(page, "#cc0003"));
      ok("상태 표시줄 🏷 common", (await statusTags(page)) === "🏷 common", await statusTags(page));

      // open tag window from the status bar
      await page.dispatchEvent(".st-tags", "mousedown");
      await page.waitForSelector(".tags-dialog");
      ok("태그 창 열림 · common 선택", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "common");

      // add a risky regex rule
      await page.click(".rule-add");
      const rows = await page.$$(".tags-dialog .rule-row");
      const last = rows[rows.length - 1];
      ok("새 규칙 기본 = 글자 그대로", (await last.$eval(".rule-kind", (e) => e.value)) === "text");
      ok("새 규칙 기본 = 줄만 씀", await last.$eval(".rule-filter", (e) => e.checked));
      await (await last.$(".rule-kind")).selectOption("regex");
      await (await last.$(".rule-pattern")).fill("(a|aa)+$");
      ok("(a|aa)+$ 거부 표시", (await last.$eval(".rule-pattern", (e) => e.getAttribute("data-problem"))) === "slow");
      await (await last.$("input[type=color]")).evaluate((e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "#cc0009");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const t0 = Date.now();
      await sleep(200);
      ok("위험 정규식으로 화면 안 멈춤 · 안 칠함", Date.now() - t0 < 1500 && (await spansWith(page, "#cc0009")).length === 0);
      // same characters as "글자 그대로" are fine
      await (await last.$(".rule-kind")).selectOption("text");
      ok("같은 글자를 글자 그대로로 바꾸면 문제 없음", (await last.$eval(".rule-pattern", (e) => e.getAttribute("data-problem"))) === "");
      // kinds switch the colouring live: make it a word "5ms"
      await (await last.$(".rule-pattern")).fill("5ms");
      await (await last.$(".rule-kind")).selectOption("word");
      await sleep(150);
      ok("단어 5ms 는 120ms 안에서 안 칠함", JSON.stringify(await spansWith(page, "#cc0009")) === '["5ms"]', await spansWith(page, "#cc0009"));
      await (await last.$(".rule-kind")).selectOption("text");
      await sleep(150);
      // "120ms" is already claimed by the regex rule above (earlier rule wins); text 5ms colours only the free "5ms"
      ok("글자 그대로 5ms — 앞 규칙이 칠한 곳은 앞 규칙 색", JSON.stringify(await spansWith(page, "#cc0009")) === '["5ms"]', await spansWith(page, "#cc0009"));

      // ---- tags: add / rename / case-distinct / conflict / duplicate / delete / clear common
      await page.click("text=＋ 새 태그");
      await page.waitForSelector(".tag-rename");
      await page.fill(".tag-rename", "collector");
      await page.press(".tag-rename", "Enter");
      await sleep(100);
      ok("태그 추가 + 이름 바꾸기", (await page.$$eval(".tag-item .tag-name", (es) => es.map((e) => e.textContent))).join() === "common,collector");
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "Collector");
      await page.press(".tag-rename", "Enter");
      await sleep(100);
      ok("대소문자 다른 두 태그 공존", (await page.$$eval(".tag-item .tag-name", (es) => es.map((e) => e.textContent))).join() === "common,collector,Collector");
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "collector");
      await page.press(".tag-rename", "Enter");
      await sleep(100);
      const err = await page.$eval(".tags-name-error", (e) => e.textContent);
      ok("같은 이름(대소문자까지) 충돌 거부", err.includes("이미 있습니다") && !!(await page.$(".tag-rename")), err);
      await page.fill(".tag-rename", " lead");
      await page.press(".tag-rename", "Enter");
      ok("앞 공백 거부", (await page.$eval(".tags-name-error", (e) => e.textContent)).includes("공백"));
      await page.press(".tag-rename", "Escape");
      await sleep(100);
      ok("Esc 로 이름 바꾸기 취소 (창은 열린 채)", !!(await page.$(".tags-dialog")) && !(await page.$(".tag-rename")));
      ok("취소한 새 태그는 기본 이름으로 남음", (await page.$$eval(".tag-item .tag-name", (es) => es.map((e) => e.textContent))).join() === "common,collector,Collector,새 태그");
      // the new tag gets a rule by default kind text + filter true
      await page.click('.tag-item[data-tag="collector"]');
      await page.click(".rule-add");
      await page.fill(".tags-dialog .rule-row .rule-pattern", "rebalance");
      ok("collector 에 규칙 1개", (await page.$$(".tags-dialog .rule-row")).length === 1);
      // duplicate
      await page.click("text=복제");
      await sleep(100);
      ok("복제", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "collector 복사" && (await page.$$(".tags-dialog .rule-row")).length === 1);
      // delete it
      await page.click(".tags-side-actions >> text=삭제");
      await sleep(100);
      ok("삭제", !(await page.$$eval(".tag-item .tag-name", (es) => es.map((e) => e.textContent))).includes("collector 복사"));
      // common: no delete, clear instead
      await page.click('.tag-item[data-tag="common"]');
      ok("common 은 삭제 버튼 없음 · 비우기", !(await page.$(".tags-side-actions >> text=삭제")) && !!(await page.$(".tags-side-actions >> text=비우기")));
      ok("common 이름 바꾸기 막힘", await page.$eval(".tags-side-actions >> text=이름 바꾸기", (e) => e.disabled));
      await page.dblclick('.tag-item[data-tag="common"]');
      ok("common 더블클릭해도 이름 바꾸기 안 열림", !(await page.$(".tag-rename")));
      await page.click(".tags-side-actions >> text=비우기");
      await sleep(100);
      ok("common 비우기", (await page.$$(".tags-dialog .rule-row")).length === 0);
      await sleep(150);
      ok("비우면 색칠도 사라짐", (await spansWith(page, "#cc0001")).length === 0);
      // debounced save then check file
      await sleep(700);
      const sv = savedTags(be);
      ok("저장된 태그 목록", JSON.stringify(sv.tags.map((t) => t.name)) === JSON.stringify(["common", "collector", "Collector", "새 태그"]), sv.tags.map((t) => t.name));
      ok("저장된 common 비어 있음", sv.tags[0].rules.length === 0);
      ok("저장된 collector 규칙 = text·filter", sv.tags[1].rules[0].kind === "text" && sv.tags[1].rules[0].filter === true && sv.tags[1].rules[0].pattern === "rebalance");
      ok("직전본 보관(가짜 .bak)", !!be.st.bak);
      await page.click(".tags-dialog .chips-actions >> text=닫기");
      ok("닫기", !(await page.$(".tags-dialog")));
      await ctx.close();
    }

    // =============== 3. tagsFor in the app: bundle folders, file override, name =====
    console.log("3. 적용 태그 (묶음 폴더·파일 덮어쓰기·이름·멀티 뷰)");
    {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
      be.st.files[P("s1", "modules/lizcollector/collector.log")] = "kafka rebalance begin\nERROR x\n";
      be.st.files[P("s2", "modules/lizcollector/collector.log")] = "kafka rebalance begin\n";
      be.st.files[P("s1", "modules/lizcollector/admin.log.2026-10-21")] = "kafka rebalance\nlogin ok\n";
      be.st.files["D:\\tmp\\messages"] = "kafka rebalance\nsshd login\n";
      be.st.scan = {
        root: R,
        servers: [
          { name: "s1", files: [{ rel: "modules/lizcollector/collector.log", size: 40, compressed: false }, { rel: "modules/lizcollector/admin.log.2026-10-21", size: 20, compressed: false }], truncated: false, unreadable: 0 },
          { name: "s2", files: [{ rel: "modules/lizcollector/collector.log", size: 20, compressed: false }], truncated: false, unreadable: 0 },
        ],
      };
      const rule = (id, pattern, color, line = false) => ({ id, on: true, label: "", pattern, kind: "text", caseSensitive: false, color, line, filter: true });
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          { name: "common", rules: [rule("c", "rebalance", "#dd0000"), rule("e", "ERROR", "#dd0009")], updated: "" },
          { name: "collector", rules: [rule("k", "kafka rebalance", "#dd0001")], updated: "" },
          { name: "admin", rules: [rule("a", "login", "#dd0002")], updated: "" },
          { name: "syslog", rules: [rule("s", "sshd", "#dd0003")], updated: "" },
        ],
        assign: {
          dir: { "modules/lizcollector": ["collector"] },
          file: { "modules/lizcollector/admin.log.*": ["admin"] },
          name: { messages: ["syslog"] },
        },
      });
      const tabs = [
        tab("a", P("s1", "modules/lizcollector/collector.log"), { label: "s1 · collector.log" }),
        tab("b", P("s2", "modules/lizcollector/collector.log"), { label: "s2 · collector.log" }),
        tab("c", P("s1", "modules/lizcollector/admin.log.2026-10-21"), { label: "s1 · admin.log.2026-10-21" }),
        tab("d", "D:\\tmp\\messages"),
      ];
      const multi = {
        on: true,
        count: 2,
        slots: [
          { tabId: "a", mode: "read", server: "s1" },
          { tabId: "b", mode: "read", server: "s2" },
          { tabId: "", mode: "read", server: "" },
          { tabId: "", mode: "read", server: "" },
          { tabId: "", mode: "read", server: "" },
          { tabId: "", mode: "read", server: "" },
        ],
        bundle: { root: R, servers: ["s1", "s2"] },
      };
      be.st.session = session(tabs, "a", { multi });
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(600);
      ok("멀티 뷰 2칸 표시", (await page.$$(".mpane")).length === 2);
      ok("묶음 트리 표시", !!(await page.$(".bundle-tree")));
      ok("상태 표시줄 = common + collector (폴더 태그)", (await statusTags(page)) === "🏷 common + collector", await statusTags(page));
      const both = await spansWith(page, "#dd0001");
      ok("두 서버 칸 모두 collector 색 (태그가 common 을 이김)", both.filter((x) => x === "kafka rebalance").length === 2, both);
      ok("겹친 글자는 common 색 안 섞임", (await spansWith(page, "#dd0000")).length === 0, await spansWith(page, "#dd0000"));
      ok("common 규칙도 함께 (ERROR)", (await spansWith(page, "#dd0009")).includes("ERROR"));
      // open admin.log from the tree (server s1 → modules → lizcollector)
      await page.locator('.bt-row.dir:has-text("modules")').first().click();
      await page.locator('.bt-row.dir:has-text("lizcollector")').first().click();
      await page.click('.bt-row.file:has-text("admin.log")');
      await sleep(500);
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, "stage3-statusbar.png") });
      ok("파일에 직접 붙은 태그만 (admin, collector 아님)", (await statusTags(page)) === "🏷 common + admin", await statusTags(page));
      ok("admin 색", (await spansWith(page, "#dd0002")).includes("login"));
      // tag window from here selects admin and lists where it is attached
      await page.dispatchEvent(".st-tags", "mousedown");
      await page.waitForSelector(".tags-dialog");
      ok("태그 창이 적용 태그(admin)를 선택", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "admin");
      const where = await page.$$eval(".tags-place", (es) => es.map((e) => e.textContent));
      ok("어디에 붙어 있나 표시", where.some((w) => w.includes("modules/lizcollector/admin.log.*")), where);
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, "stage3-tag-window.png") });
      ok("적용 중 태그 표시(●)", (await page.$$eval(".tag-item.applied .tag-name", (es) => es.map((e) => e.textContent))).join() === "common,admin");
      await page.keyboard.press("Escape");
      await sleep(100);
      ok("Esc 로 태그 창 닫힘", !(await page.$(".tags-dialog")));
      // log colours off/on still works
      await page.dispatchEvent(".st-log", "mousedown");
      await sleep(200);
      const offCount = (await spansWith(page, "#dd0002")).length;
      await page.dispatchEvent(".st-log", "mousedown");
      await sleep(200);
      ok("🎨 로그 색 끄고 켜기", offCount === 0 && (await spansWith(page, "#dd0002")).length > 0, offCount);
      await ctx.close();

      // single view: a file outside the bundle uses the name rule
      be.st.session = session(tabs, "d", { multi: { ...multi, on: false } });
      const r2 = await openPage(browser, url, be);
      await sleep(500);
      ok("묶음 밖 파일 = 이름 규칙 (messages → syslog)", (await statusTags(r2.page)) === "🏷 common + syslog", await statusTags(r2.page));
      ok("syslog 색", (await spansWith(r2.page, "#dd0003")).includes("sshd"));
      await r2.ctx.close();
    }

    // =============== 4. close handshake saves the last tag change ================
    console.log("4. 창 닫기 때 마지막 변경 저장");
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\z.log"] = "hello\n";
      be.st.session = session([tab("t1", "D:\\logs\\z.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(400);
      await page.dispatchEvent(".st-tags", "mousedown");
      await page.waitForSelector(".tags-dialog");
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "last-minute");
      await page.press(".tag-rename", "Enter");
      // within the debounce window: ask to close
      const n0 = be.st.calls.length;
      await page.evaluate(() => window.runtime.EventsEmit("chipper:flush-before-close"));
      await sleep(400);
      const after = be.st.calls.slice(n0).map((c) => c.name);
      ok("닫기 전에 SaveTags → 그다음 CloseWithSession", after.indexOf("SaveTags") >= 0 && after.indexOf("SaveTags") < after.indexOf("CloseWithSession"), after);
      ok("마지막 태그가 저장됨", (tagNames(be) || []).includes("last-minute"), tagNames(be));
      await ctx.close();

      // read-only (newer file): never saved
      const be2 = makeBackend();
      be2.st.loadTags = { data: JSON.stringify({ version: 2, tags: [{ name: "common", rules: [] }, { name: "future", rules: [] }] }), exists: true, restored: false, broken: "", problem: "", newer: true };
      const r2 = await openPage(browser, url, be2);
      await sleep(600);
      await r2.page.evaluate(() => window.runtime.EventsEmit("chipper:flush-before-close"));
      await sleep(300);
      ok("새 버전 형식 tags.json 은 저장 안 함", !be2.st.calls.some((c) => c.name === "SaveTags"));
      await r2.page.dispatchEvent(".st-tags", "mousedown");
      ok("새 버전 안내 표시", ((await r2.page.$eval(".tags-notice", (e) => e.textContent).catch(() => "")) || "").includes("더 새 버전"));
      await r2.ctx.close();

      // broken file moved aside, restored from .bak: notice + alert
      const be3 = makeBackend();
      be3.st.loadTags = { data: JSON.stringify({ version: 1, tags: [{ name: "common", rules: [] }, { name: "fromBak", rules: [] }] }), exists: true, restored: true, broken: "C:\\h\\.chipper\\tags.broken-20261027-093005.json", problem: "JSON 형식이 아닙니다", newer: false };
      const r3 = await openPage(browser, url, be3);
      await sleep(500);
      ok("깨진 파일 알림", r3.page.__dialogs.some((d) => d.includes("tags.broken-20261027-093005.json") && d.includes(".bak")), r3.page.__dialogs);
      await r3.page.dispatchEvent(".st-tags", "mousedown");
      ok("되살린 태그 보임", (await r3.page.$$eval(".tag-item .tag-name", (es) => es.map((e) => e.textContent))).includes("fromBak"));
      await r3.ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\ne2e: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
