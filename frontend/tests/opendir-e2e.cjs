// Headless test of 「📂 디렉토리 열기」 + 「× 디렉토리 닫기」: any folder opens as
// a tree only (pane count and multi view untouched), click = focused pane (or
// a tab in the one-pane view), drag = that pane, ⇉ only when 2+ top folders
// hold the log, tag keys stay "path under the top folder" (files directly in
// the folder go by name), close keeps tabs and leaves the session, reopen,
// restore of an older session (no auto placement), scan progress + cancel,
// file-limit warning. Same fake Go side as tags-assign-e2e.cjs.
//
//   cd frontend && npm run build && node tests/opendir-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder>  → screenshots open-dir-*.png
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
  const st = { session: "", tags: null, calls: [], files: {}, scans: {}, pick: "", scanError: null, slow: null };
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
      st.tags = js;
    },
    ReadFile: (p) => {
      const c = st.files[p];
      if (c == null) throw new Error("no such file " + p);
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: false, canceled: false };
    },
    ReadFileAs: (p) => impl.ReadFile(p),
    StatFile: (p) => (st.files[p] != null ? { exists: true, modTime: 1, size: st.files[p].length } : { exists: false, modTime: 0, size: 0 }),
    ScanBundle: (root) => {
      if (st.scanError) throw new Error(st.scanError);
      if (st.slow)
        return new Promise((resolve, reject) => {
          st.slow = { resolve, reject, root };
        });
      const b = st.scans[root];
      if (!b) throw new Error("open " + root + ": not found");
      return b;
    },
    CancelScanBundle: () => {
      if (st.slow && st.slow.reject) st.slow.reject(new Error("디렉토리 읽기를 취소했습니다"));
    },
    OpenFolderDialog: () => st.pick,
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
  page.__dialogs = [];
  page.on("dialog", (d) => {
    page.__dialogs.push(d.message());
    d.accept();
  });
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
const slotsOf = (xs) => {
  const s = xs.map((x) => ({ tabId: "", mode: "read", server: "", ...x }));
  while (s.length < 6) s.push({ tabId: "", mode: "read", server: "" });
  return s;
};
const row = (key) => `.bt-row[data-key="${key}"]`;
const flush = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(600);
};
const saved = (be) => (be.st.session ? JSON.parse(be.st.session) : null);
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const paneTitles = (page) => page.$$eval(".mpane .mp-title", (es) => es.map((e) => e.textContent));
const paneServers = (page) => page.$$eval(".mpane", (ps) => ps.map((p) => p.querySelector(".mp-server")?.value ?? null));
const tabTitles = (page) => page.$$eval(".tab .tab-title", (es) => es.map((e) => e.textContent));
const calls = (be, n) => be.st.calls.filter((c) => c.name === n);
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(80);
  }
  return v;
}
// HTML5 drag of a tree row onto a target, with the DataTransfer the tree sets.
async function dragTo(page, fromSel, toSel) {
  await page.evaluate(
    ([a, b]) => {
      const src = document.querySelector(a);
      const dst = document.querySelector(b);
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    [fromSel, toSel]
  );
}

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const shots = process.env.SHOTS;
  const shot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, name) }));
  try {
    // --- fixtures -----------------------------------------------------------
    // FLAT: not our layout — files only (rotated app.log folds) + one deep tree
    const FLAT = "C:\\x\\flat";
    const fp = (...xs) => [FLAT, ...xs].join("\\");
    const flatScan = {
      root: FLAT,
      servers: [
        { name: "deep", files: [{ rel: "a/b/c/d/e/deep.log", size: 10, compressed: false }], truncated: false, unreadable: 0, notRead: false },
      ],
      rootFiles: ["app.log", "app.log.1", "app.log.2", "messages"].map((rel) => ({ rel, size: 10, compressed: false })),
      rootTruncated: false,
      truncated: false,
      fileLimit: 20000,
      files: 5,
    };
    // BUNDLE: our layout — s1, s2, s3
    const R = "C:\\b\\bromo";
    const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
    const servers = ["s1", "s2", "s3"];
    const files = {};
    const make = (be) => {
      be.st.scans[FLAT] = flatScan;
      for (const rel of ["app.log", "app.log.1", "app.log.2", "messages"]) be.st.files[fp(rel)] = `${rel} line\nERROR one\n`;
      be.st.files[fp("deep", "a", "b", "c", "d", "e", "deep.log")] = "deep\n";
      for (const sv of servers) {
        files[sv] = [];
        const add = (rel) => {
          be.st.files[P(sv, rel)] = `${sv} ${rel}\nkafka rebalance\n`;
          files[sv].push({ rel, size: 20, compressed: false });
        };
        add("modules/lizcollector/collector.log");
        if (sv === "s1") add("modules/only1/x.log");
      }
      be.st.scans[R] = { root: R, servers: servers.map((name) => ({ name, files: files[name], truncated: false, unreadable: 0, notRead: false })), rootFiles: [], rootTruncated: false, truncated: false, fileLimit: 20000, files: 4 };
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          { name: "common", rules: [], updated: "" },
          { name: "collector", rules: [], updated: "" },
        ],
        assign: { dir: {}, file: {}, name: {} },
      });
    };

    console.log("1. 우리 구조 아닌 폴더 (한 칸 보기) → 트리만, 멀티 뷰 안 켬");
    {
      const be = makeBackend();
      make(be);
      be.st.files["D:\\mine.txt"] = "mine\n";
      be.st.session = session([tab("m", "D:\\mine.txt")], "m");
      const { ctx, page } = await openPage(browser, url, be);
      ok("툴바 버튼 이름 = 📂 디렉토리 열기", !!(await page.$('button:has-text("📂 디렉토리 열기")')) && !(await page.$('button:has-text("로그 묶음")')));
      be.st.pick = FLAT;
      await page.click('button:has-text("📂 디렉토리 열기")');
      await page.waitForSelector(".bundle-tree");
      ok("트리 머리 = 📂 flat", (await page.$eval(".bt-title", (e) => e.textContent)).includes("📂 flat"));
      ok("멀티 뷰 안 켬 (칸 없음)", (await page.$$(".mpane")).length === 0);
      ok("오류 알림 없음", page.__dialogs.length === 0, page.__dialogs);
      ok("하던 탭 그대로 보임", (await tabTitles(page)).join(",") === "mine.txt" && !!(await page.$(".cm-editor")));
      ok("「(이 폴더)」 그룹", (await page.$eval(row("root:"), (e) => e.textContent)).includes("(이 폴더)"));
      ok("이 폴더의 회전 파일 접힘 (app.log 3개)", !!(await page.$('.bt-row.series:has-text("app.log (3)")')));
      ok("깊은 폴더도 트리에", !!(await page.$(row("s:deep"))));
      ok("서버 하나뿐: ⇉ 없음", (await page.$$(".bt-all")).length === 0);
      await shot(page, "open-dir-flat.png");
      await page.click(row("f:/messages"));
      await until(async () => (await tabTitles(page)).length === 2);
      ok("누르기 → 한 칸 보기에서 탭으로 열림·활성", JSON.stringify(await tabTitles(page)) === '["mine.txt","messages"]' && (await page.$eval(".tab.active .tab-title", (e) => e.textContent)) === "messages", await tabTitles(page));
      ok("열어도 멀티 뷰 그대로 꺼짐", (await page.$$(".mpane")).length === 0);
      await page.click(row("d:deep/a"));
      for (const k of ["d:deep/a/b", "d:deep/a/b/c", "d:deep/a/b/c/d", "d:deep/a/b/c/d/e"]) await page.click(row(k));
      await page.click(row("f:deep/a/b/c/d/e/deep.log"));
      await until(async () => (await tabTitles(page)).length === 3);
      ok("깊은 폴더 파일 → 「deep · deep.log」 탭", (await tabTitles(page))[2] === "deep · deep.log", await tabTitles(page));
      // drop onto the one-pane workspace
      await page.click(row("r:/app.log"));
      await dragTo(page, row("f:/app.log.1"), ".workspace");
      await until(async () => (await tabTitles(page)).length === 4);
      ok("한 칸 보기에 끌어다 놓기 → 탭", (await tabTitles(page))[3] === "app.log.1", await tabTitles(page));
      // tags of a file directly in the folder go by its name
      await page.click(row("f:/messages"), { button: "right" });
      await page.waitForSelector(".bt-menu");
      await page.click(".bt-menu >> text=태그 지정…");
      await page.waitForSelector(".tag-assign");
      ok("이 폴더 파일 = 「이 이름」 지정", (await page.$eval(".ta-where", (e) => e.textContent)).includes("이름이 「messages」"));
      await page.setChecked('.ta-tag[data-tag="collector"] input[type=checkbox]', true);
      await page.click(".tag-assign .ta-ok");
      await sleep(300);
      ok("저장: assign.name.messages (폴더 키 아님)", JSON.stringify(savedTags(be).assign) === JSON.stringify({ dir: {}, file: {}, name: { messages: ["collector"] } }), savedTags(be).assign);
      ok("트리 칩도 바로", (await page.$$eval(`${row("f:/messages")} .bt-tag`, (es) => es.map((e) => e.textContent))).join() === "collector");
      await page.click(row("root:"), { button: "right" });
      await page.waitForSelector(".bt-menu");
      ok("「(이 폴더)」 줄은 태그 지정 꺼짐", await page.$eval(".bt-menu .menu-item", (e) => e.disabled));
      await page.keyboard.press("Escape");
      await ctx.close();
    }

    console.log("2. 멀티 뷰 3칸에서 열기 → 칸 수·칸 내용 그대로, 누르기 = 포커스 칸");
    {
      const be = makeBackend();
      make(be);
      be.st.files["D:\\mine.txt"] = "mine\n";
      be.st.session = session([tab("m", "D:\\mine.txt")], "m", { multi: { on: true, count: 3, slots: slotsOf([{ tabId: "m" }]), bundle: null } });
      const { ctx, page } = await openPage(browser, url, be);
      be.st.pick = R;
      await page.click('button:has-text("📂 디렉토리 열기")');
      await page.waitForSelector(".bundle-tree");
      await sleep(300);
      ok("칸 수 3 그대로", (await page.$$(".mpane")).length === 3);
      ok("칸 내용 그대로 (1번 mine.txt, 2·3 빈 칸)", JSON.stringify(await paneTitles(page)) === '["mine.txt","빈 칸","빈 칸"]', await paneTitles(page));
      ok("칸이 서버를 따라가지 않음 (자동 배치 없음)", JSON.stringify(await paneServers(page)) === '["","",""]', await paneServers(page));
      for (const k of ["d:s1/modules", "d:s1/modules/lizcollector", "d:s1/modules/only1", "d:s2/modules", "d:s2/modules/lizcollector"]) await page.click(row(k));
      await page.click(".mpane >> nth=2");
      await page.click(row("f:s2/modules/lizcollector/collector.log"));
      await until(async () => (await paneTitles(page))[2] === "collector.log");
      ok("s2 파일 누르기 → 포커스 칸(3번)에", JSON.stringify(await paneTitles(page)) === '["mine.txt","빈 칸","collector.log"]', await paneTitles(page));
      ok("3번 칸이 s2 를 따라감", (await paneServers(page))[2] === "s2", await paneServers(page));
      await dragTo(page, row("f:s1/modules/only1/x.log"), ".mpane[data-slot='1'] .mpane-body");
      await until(async () => (await paneTitles(page))[1] === "x.log");
      ok("끌어다 놓기 → 놓은 칸(2번)에", (await paneTitles(page))[1] === "x.log" && (await paneServers(page))[1] === "s1", { t: await paneTitles(page), s: await paneServers(page) });
      ok("1번 칸 그대로", (await paneTitles(page))[0] === "mine.txt");
      // ⇉ only for a log 2+ top folders hold
      await page.hover(row("f:s1/modules/lizcollector/collector.log"));
      ok("공통 로그에 ⇉", !!(await page.$(`${row("f:s1/modules/lizcollector/collector.log")} .bt-all`)));
      ok("s1 에만 있는 로그엔 ⇉ 없음", !(await page.$(`${row("f:s1/modules/only1/x.log")} .bt-all`)));
      await page.click(`${row("f:s1/modules/lizcollector/collector.log")} .bt-all`);
      await until(async () => JSON.stringify(await paneServers(page)) === '["s1","s2","s3"]' && (await paneTitles(page)).every((t) => t === "collector.log"));
      ok("⇉ → 폴더마다 한 칸 (s1·s2·s3)", JSON.stringify(await paneServers(page)) === '["s1","s2","s3"]', await paneServers(page));
      ok("⇉ → 세 칸 모두 collector.log", (await paneTitles(page)).every((t) => t === "collector.log"), await paneTitles(page));
      ok("mine.txt 는 탭으로 남음", (await tabTitles(page)).includes("mine.txt"), await tabTitles(page));
      // tag key = path under the top folder
      await page.click(row("d:s2/modules/lizcollector"), { button: "right" });
      await page.waitForSelector(".bt-menu");
      await page.click(".bt-menu >> text=태그 지정…");
      await page.waitForSelector(".tag-assign");
      await page.setChecked('.ta-tag[data-tag="collector"] input[type=checkbox]', true);
      await page.click(".tag-assign .ta-ok");
      await sleep(300);
      ok("태그 키 = 맨 위 폴더 아래 경로 modules/lizcollector", JSON.stringify(savedTags(be).assign.dir) === JSON.stringify({ "modules/lizcollector": ["collector"] }), savedTags(be).assign);
      ok("칸 셋 모두 🏷 collector", (await page.$$eval(".mpane", (ps) => ps.map((p) => [...p.querySelectorAll(".mp-tag")].map((e) => e.textContent).join()))).join("|") === "collector|collector|collector");
      await shot(page, "open-dir-multi.png");

      console.log("3. 닫기 → 트리 사라짐 · 탭 남음 · 세션에서 빠짐 · 다시 열기");
      const tabsBefore = await tabTitles(page);
      await page.click(".bt-close");
      await sleep(300);
      ok("트리 사라짐", !(await page.$(".bundle-tree")) && !(await page.$(".bt-show")));
      ok("탭 그대로", JSON.stringify(await tabTitles(page)) === JSON.stringify(tabsBefore), { before: tabsBefore, after: await tabTitles(page) });
      ok("칸 내용 그대로", (await paneTitles(page)).length === 3 && (await paneTitles(page)).every((t) => t.includes("collector.log")), await paneTitles(page));
      ok("칸 아래 서버 고르기 사라짐", JSON.stringify(await paneServers(page)) === "[null,null,null]", await paneServers(page));
      ok("닫아도 탭 태그 유지 (🏷 collector)", (await page.$$eval(".mpane .mp-tag", (es) => es.map((e) => e.textContent))).join() === "collector,collector,collector");
      await flush(page);
      const s = saved(be);
      ok("세션: multi.bundle = null, 칸 서버 비움", s && s.multi && s.multi.bundle === null && s.multi.slots.every((x) => !x.server), s && s.multi);
      be.st.pick = R;
      await page.click('button:has-text("📂 디렉토리 열기")');
      await page.waitForSelector(".bundle-tree");
      ok("다시 열기 → 트리", !!(await page.$(row("s:s1"))));
      ok("다시 열어도 칸 그대로", (await paneTitles(page)).every((t) => t.includes("collector.log")) && JSON.stringify(await paneServers(page)) === '["","",""]', { t: await paneTitles(page), s: await paneServers(page) });
      await ctx.close();
    }

    console.log("4. 옛 세션의 묶음 복원 → 칸 서버 그대로, 자동 배치 없음");
    {
      const be = makeBackend();
      make(be);
      const tabs = [tab("a", P("s1", "modules/lizcollector/collector.log"), { label: "s1 · collector.log" })];
      be.st.session = session(tabs, "a", {
        multi: { on: true, count: 2, slots: slotsOf([{ tabId: "a", server: "s1" }, { server: "s2" }]), bundle: { root: R, servers: ["s1", "s2"] } },
      });
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".bundle-tree", { timeout: 4000 }).catch(() => {});
      ok("트리 복원", !!(await page.$(".bundle-tree")));
      ok("칸 수 2 그대로", (await page.$$(".mpane")).length === 2);
      ok("칸 서버 그대로 (s1, s2)", JSON.stringify(await paneServers(page)) === '["s1","s2"]', await paneServers(page));
      ok("2번 칸은 비어 있음 (자동으로 채우지 않음)", (await paneTitles(page))[1] === "빈 칸", await paneTitles(page));
      ok("ScanBundle 한 번", calls(be, "ScanBundle").length === 1);
      await ctx.close();
    }
    {
      // one-pane view session with a bundle: the tree comes back there too
      const be = makeBackend();
      make(be);
      be.st.session = session([], "", { multi: { on: false, count: 2, slots: slotsOf([]), bundle: { root: FLAT, servers: ["deep"] } } });
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".bundle-tree", { timeout: 4000 }).catch(() => {});
      ok("한 칸 보기 세션도 트리 복원 · 멀티 뷰 안 켬", !!(await page.$(".bundle-tree")) && (await page.$$(".mpane")).length === 0);
      await ctx.close();
    }
    {
      // the folder is gone: closed with a word, not stuck with a tree that can't load
      const be = makeBackend();
      make(be);
      be.st.scanError = "open C:\\gone: The system cannot find the file specified.";
      be.st.session = session([], "", { multi: { on: true, count: 2, slots: slotsOf([{ server: "s1" }]), bundle: { root: "C:\\gone", servers: ["s1"] } } });
      const { ctx, page } = await openPage(browser, url, be);
      await until(() => page.__dialogs.length > 0, 3000);
      ok("읽을 수 없는 복원 폴더 → 닫았다고 알림", page.__dialogs.some((d) => d.includes("닫았습니다") && d.includes("C:\\gone")), page.__dialogs);
      await flush(page);
      ok("세션에서도 빠짐", saved(be).multi.bundle === null && saved(be).multi.slots.every((x) => !x.server), saved(be).multi);
      ok("트리 없음", !(await page.$(".bundle-tree")));
      await ctx.close();
    }

    console.log("5. 읽는 중 표시 · 취소 · 상한 경고");
    {
      const be = makeBackend();
      make(be);
      be.st.session = session([], "");
      const { ctx, page } = await openPage(browser, url, be);
      be.st.pick = "C:\\";
      be.st.slow = {};
      await page.click('button:has-text("📂 디렉토리 열기")');
      await page.waitForSelector(".dir-scan", { timeout: 2000 }).catch(() => {});
      ok("잠시 뒤 「읽는 중…」 + 취소", !!(await page.$(".dir-scan")) && (await page.$eval(".dir-scan", (e) => e.textContent)).includes("취소"));
      await page.evaluate(() => window.runtime.EventsEmit("chipper:dirscan-progress", { root: "C:\\", files: 12345, dirs: 678 }));
      await sleep(100);
      ok("진행 숫자", (await page.$eval(".dir-scan-sub", (e) => e.textContent)) === "파일 12,345개 · 폴더 678개", await page.$eval(".dir-scan-sub", (e) => e.textContent));
      await page.click(".dir-scan button");
      await sleep(300);
      ok("취소 → CancelScanBundle 호출", calls(be, "CancelScanBundle").length === 1);
      ok("취소 → 표시 사라짐 · 트리 없음 · 오류 알림 없음", !(await page.$(".dir-scan")) && !(await page.$(".bundle-tree")) && page.__dialogs.length === 0, page.__dialogs);
      // a scan that hit the limit
      be.st.slow = null;
      be.st.scans["C:\\"] = {
        root: "C:\\",
        servers: [
          { name: "Program Files", files: [{ rel: "a.txt", size: 1, compressed: false }], truncated: true, unreadable: 2, notRead: false },
          { name: "Windows", files: [], truncated: false, unreadable: 0, notRead: true },
        ],
        rootFiles: [],
        rootTruncated: false,
        truncated: true,
        fileLimit: 20000,
        files: 20000,
      };
      await page.click('button:has-text("📂 디렉토리 열기")');
      await page.waitForSelector(".bundle-tree");
      const warn = await page.$eval(".bt-limit", (e) => e.textContent).catch(() => "");
      ok("상한 경고: 20,000개까지만", warn.includes("20,000개까지만") && warn.includes("상한"), warn);
      ok("읽지 않은 폴더 표시", (await page.$eval(row("s:Windows"), (e) => e.textContent)).includes("(읽지 않음)"));
      ok("읽을 수 없는 항목 경고는 그대로", (await page.$$eval(".bt-warn", (es) => es.map((e) => e.textContent).join("|"))).includes("읽을 수 없는 항목 2개"));
      ok("전체 상한일 땐 폴더별 「앞의 N개만」 경고를 겹쳐 쓰지 않음", !(await page.$$eval(".bt-warn", (es) => es.map((e) => e.textContent).join("|"))).includes("앞의 1개만"));
      await shot(page, "open-dir-limit.png");
      await ctx.close();
    }
    console.log("6. 한 칸 보기에서 ⇉ → 멀티 뷰를 켜고 폴더마다 한 칸");
    {
      const be = makeBackend();
      make(be);
      be.st.session = session([], "", { multi: { on: false, count: 2, slots: slotsOf([]), bundle: { root: R, servers } } });
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".bundle-tree", { timeout: 4000 }).catch(() => {});
      for (const k of ["d:s1/modules", "d:s1/modules/lizcollector"]) await page.click(row(k));
      await page.click(row("f:s1/modules/lizcollector/collector.log"));
      await until(async () => (await tabTitles(page)).length === 1);
      ok("한 칸 보기 누르기 → 「s1 · collector.log」 탭", (await tabTitles(page))[0] === "s1 · collector.log" && (await page.$$(".mpane")).length === 0, await tabTitles(page));
      await page.hover(row("f:s1/modules/lizcollector/collector.log"));
      await page.click(`${row("f:s1/modules/lizcollector/collector.log")} .bt-all`);
      await until(async () => (await page.$$(".mpane")).length === 3 && (await paneTitles(page)).every((t) => t === "collector.log"));
      ok("⇉ → 멀티 뷰 3칸 · s1·s2·s3", (await page.$$(".mpane")).length === 3 && JSON.stringify(await paneServers(page)) === '["s1","s2","s3"]', await paneServers(page));
      ok("⇉ → 세 칸 모두 collector.log", (await paneTitles(page)).every((t) => t === "collector.log"), await paneTitles(page));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\nopendir e2e: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
