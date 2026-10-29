// Headless tests of the v1.3.1 fix round 1 (fix-r1-prompt.md): 100MB+ files are
// read-only (📖·🏷), the editing budget counts file bytes, W cancel/retry races,
// S blocks every write, the chunked open of plain files, 「📖 읽기」 when over the
// budget, the multi view ✏️, and agy F-04…F-11 — against the built frontend
// (frontend/dist) and the REAL line filter (Go helper, as readview-e2e.cjs).
//
//   cd frontend && npm run build && node tests/fixr1-e2e.cjs   (ONLY=A,B…)
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder> → screenshots
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const ROOT = path.join(__dirname, "..", "..");
const SHOTS = process.env.SHOTS || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 600) : ""));
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 600)));
}
async function until(fn, ms = 8000, step = 40) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = undefined;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}
async function openTagWindow(page) {
  await page.dispatchEvent(".st-tags", "mousedown");
  await page.waitForSelector(".tag-menu");
  await page.click(".tag-menu >> text=태그 창 열기");
  await page.waitForSelector(".tags-dialog");
}

// ---- static server for dist ---------------------------------------------------------
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

// ---- the Go helper (real engine) ----------------------------------------------------------
let goAddr = "";
async function startGo() {
  const addrFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lf-e2e-")), "addr");
  const proc = spawn("go", ["test", "-run", "^TestFilterE2EServer$", "-count=1", "-v", "."], {
    cwd: ROOT,
    env: { ...process.env, CHIPPER_LF_E2E: addrFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const addr = await until(() => fs.existsSync(addrFile) && fs.readFileSync(addrFile, "utf8"), 240000, 200);
  if (!addr) throw new Error("Go 도우미가 뜨지 않았습니다:\n" + log);
  goAddr = addr;
  return proc;
}
async function goPost(name, args) {
  const r = await fetch(`http://${goAddr}/call`, { method: "POST", body: JSON.stringify({ name, args }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const goGet = (p) => fetch(`http://${goAddr}${p}`).then((r) => r.text());

// ---- fake Go side for everything else ------------------------------------------------------
function makeBackend() {
  const st = { session: "", tags: null, calls: [], files: {}, sizes: {}, scan: null, openFiles: [], tooBigSave: 0, saveAs: [], gone: new Set(), bin: new Set() };
  const read = (p) => {
    if (st.files[p] != null) return st.files[p];
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    throw new Error("no such file " + p);
  };
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
      const c = read(p);
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: st.bin.has(p), canceled: false };
    },
    ReadFileAs: (p, enc) => ({ ...impl.ReadFile(p), encoding: enc }),
    StatFile: (p) => {
      if (st.gone.has(p)) return { exists: false, modTime: 0, size: 0 };
      if (st.sizes[p] != null) return { exists: true, modTime: 1, size: st.sizes[p] };
      return fs.existsSync(p) ? { exists: true, modTime: 1, size: fs.statSync(p).size } : { exists: false, modTime: 0, size: 0 };
    },
    ScanBundle: () => st.scan,
    // Go's SaveFile: tooBigSave = the size the saved file would have (over the
    // open limit → refused with the prefix until allowTooBig, like app.go)
    SaveFile: (p, content, opt) => {
      if (st.tooBigSave && !(opt && opt.allowTooBig)) throw new Error("CHIPPER_TOO_BIG_AFTER_SAVE:" + st.tooBigSave);
      st.files[p] = content;
      return { path: p, name: p.split(/[\\/]/).pop(), content: "", modTime: 2, size: content.length, encoding: "utf-8", binary: false, canceled: false, eol: "lf", eolMixed: false, bom: false, unchanged: false };
    },
    OpenFolderDialog: () => (st.scan ? st.scan.root : ""),
    OpenFilesDialog: () => st.openFiles,
    OpenFileDialog: () => st.openFiles[0] || "",
    // 「화면 메모리 정리」 (Go hostgc): st.gcReady = it is there; st.onGc = what a collection does (the test lowers the fake heap)
    SniffBinary: (p) => st.bin.has(p),
    HostGCReady: () => !!st.gcReady,
    CollectWindowGarbage: async () => {
      st.gcCalls = (st.gcCalls || 0) + 1;
      if (st.onGc) await st.onGc();
      return st.gcReady ? "" : "off: test";
    },
    SaveFileDialog: (name) => {
      st.saveAs.push(name);
      return { canceled: true };
    },
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "FilterFind", "ValidateFilterRules", "EditOpenBegin", "EditOpenChunk", "EditOpenEnd", "MemInfo"]);
  // delay[name] = ms: hold that call before it goes out (late answers, races)
  const delay = {};
  return {
    st,
    delay,
    call: async (name, args) => {
      st.calls.push({ name, args: name === "SaveSession" ? [] : args, t: Date.now() }); // sessions: kept in st.session only (big texts)
      if (delay[name]) await sleep(delay[name]);
      if (FILTER.has(name)) return goPost(name, args);
      const f = impl[name];
      return f ? f(...args) : null;
    },
  };
}

const INIT = () => {
  window.__chipperTestHooks = true;
  // the window's JS memory as the app reads it (performance.memory), overridable: window.__fakeHeap = { used, limit }
  try {
    const real = Object.getOwnPropertyDescriptor(Performance.prototype, "memory");
    Object.defineProperty(performance, "memory", {
      configurable: true,
      get() {
        const f = window.__fakeHeap;
        if (f) return { usedJSHeapSize: f.used, totalJSHeapSize: f.used, jsHeapSizeLimit: f.limit };
        return real && real.get ? real.get.call(performance) : undefined;
      },
    });
  } catch {
    /* no performance.memory */
  }
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
      ClipboardSetText: async (t) => {
        window.__clip = t;
        return true;
      },
    },
    { get: (t, name) => t[name] || (() => undefined) }
  );
};

async function openPage(browser, url, be, viewport = { width: 1400, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push(d.type() + ": " + d.message());
    await d.accept();
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
  // relay the engine's progress events into the page
  let from = 0;
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const j = JSON.parse(await goGet(`/events?from=${from}`));
        from = j.next;
        if (j.events.length && !page.isClosed())
          await page.evaluate((evs) => evs.forEach((e) => window.runtime.EventsEmit("linefilter:progress", e)), j.events);
      } catch {
        /* page closing */
      }
      await sleep(25);
    }
  })();
  ctx.on("close", () => (stop = true));
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(200);
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
const viewData = (page, scope = "") => page.$eval(scope + " .lines-view", (e) => ({ ...e.dataset }));
const calls = (be, name) => be.st.calls.filter((c) => c.name === name);
const waitDone = (page, scope = "") => until(async () => (await viewData(page, scope)).state === "done", 15000);
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const LN = (extra = {}) => ({ on: true, read: true, big: true, above: 0, below: 3, off: [], ex: [], ...extra });
const Rt = (id, p, extra = {}) => tab(id, p, { lines: LN(), ...extra });
const Lt = (id, p) => tab(id, p, { lines: LN({ read: false }) });
const Et = (id, p) => tab(id, p, { lines: LN({ on: false, read: false }) });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixr1-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const MB = 1 << 20;
  const lines = [];
  for (let i = 1; i <= 400; i++) lines.push(`2026-10-28 12:00:00 INFO ${i % 37 === 0 ? "ERROR failed " : ""}line ${i}`);
  for (const n of ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log", "g.log", "h.log", "Same.log"]) fs.writeFileSync(P(n), lines.join("\n"));
  fs.writeFileSync(P("small.log.gz"), zlib.gzipSync(lines.join("\n")));
  // Korean UTF-8: 3 bytes a character
  const ko = [];
  for (let i = 1; i <= 20000; i++) ko.push(`${i} 가나다라마바사아자차카타파하 한글 로그 줄입니다 오류없음`);
  fs.writeFileSync(P("ko.log"), ko.join("\n"));
  const koBytes = fs.statSync(P("ko.log")).size;
  const koChars = ko.join("\n").length;
  // a 10KB line with a word 6KB in (past the 4KB a row shows)
  fs.writeFileSync(P("long.log"), ["first line", "x".repeat(6000) + "TAIL_SECRET_AT_6K" + "y".repeat(4000), "last line"].join("\n"));
  const tabStates = (page) => page.$$eval(".lines-seg.big", (els) => els.map((e) => e.dataset.state));
  const seg = (page, k, scope = "") => page.click(`${scope} .lines-seg.big button:nth-child(${k})`);
  const mode = (page, scope = "") => page.$eval(scope + " .lines-view", (e) => e.dataset.mode).catch(() => null);
  const flashText = (page) => page.$eval(".st-flash", (e) => e.textContent).catch(() => "");
  const held = (page) => page.$eval(".st-mem", (e) => +e.dataset.held).catch(() => -1);
  // 「✏️」 of the tab shown in `scope` pressed although its button is off (a
  // click racing the re-render): the app's own requestEdit (test hook)
  const forceEdit = async (page, scope = "") => {
    const id = await page.$eval(scope + " .lines-host", (e) => e.dataset.tab);
    await page.evaluate((id) => window.__chipperTest.requestEdit(id), id);
  };
  const encMenu = async (page, section, label) => {
    await page.dispatchEvent(".st-enc", "mousedown");
    await page.waitForSelector(".enc-menu");
    const items = await page.$$(".enc-menu .menu-item");
    const all = [];
    for (const it of items) all.push([it, await it.textContent()]);
    const half = section === "save" ? all.slice(0, 5) : all.slice(5);
    const hit = half.find(([, t]) => t.replace("●", "").trim() === label);
    if (!hit) throw new Error("no menu item " + label);
    await hit[0].evaluate((b) => {
      b.disabled = false;
      b.click();
    });
  };
  const openSess = (be, vp) => openPage(browser, url, be, vp);
  try {
    // =============== A. 100MB 이상 = 읽기 전용 (모든 편집 길이 막힘, 이유 표시) =======================
    if (want("A")) {
      console.log("A. 100MB 이상 = 읽기 전용: ✏️ 꺼짐·이유, 확인 창·W 없음, 저장 길 전부 막힘, 복원 E → R");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 300 * MB;
      be.st.sizes[P("b.log")] = 300 * MB;
      be.st.sizes[P("c.log")] = 100 * MB;
      be.st.session = session([Rt("t1", P("a.log")), Et("t2", P("b.log")), Lt("t3", P("c.log"))], "t1");
      const { ctx, page } = await openSess(be);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await waitDone(page);
      await until(async () => (await page.$eval(".lines-seg.big button:nth-child(3)", (b) => b.title)).includes("100MB"), 3000);
      const sb = await page.$eval(".lines-seg.big button:nth-child(3)", (b) => [b.disabled, b.title]);
      ok("R 300MB: ✏️ 꺼짐 + 「100MB 이상 파일은 읽기 전용」", sb[0] === true && sb[1].includes("100MB 이상 파일은 읽기 전용") && sb[1].includes("나눠"), sb);
      const lb = await page.$eval(".lv-edit", (b) => [b.disabled, b.title]);
      ok("머리의 「✏️ 편집으로 열기」도 꺼짐 + 같은 이유", lb[0] === true && lb[1].includes("100MB 이상 파일은 읽기 전용"), lb);
      await forceEdit(page);
      await sleep(500);
      ok("눌러도 확인 창(C)·여는 중(W) 없음", (await page.$(".choice-ask")) === null && (await page.$(".rv-wait")) === null && calls(be, "EditOpenBegin").length === 0);
      ok("눌렀을 때 이유를 알려 줌", (await flashText(page)).includes("100MB 이상 파일은 읽기 전용"), await flashText(page));
      await page.focus(".lv-scroll");
      await page.keyboard.press("Control+s");
      await sleep(150);
      ok("Ctrl+S → 쓰지 않음 + 안내", calls(be, "SaveFile").length === 0 && (await flashText(page)).includes("저장할 것이 없습니다"), await flashText(page));
      await encMenu(page, "save", "UTF-8 BOM");
      await sleep(250);
      ok("상태 표시줄 「인코딩하여 저장」 → 쓰지 않음 + 이유", calls(be, "SaveFile").length === 0 && (await flashText(page)).includes("읽기 전용"), await flashText(page));
      await page.click('.tb-btn:has-text("다른 이름으로")', { force: true });
      await sleep(250);
      ok("「다른 이름으로」 → 대화상자 안 열림 + 이유", be.st.saveAs.length === 0 && (await flashText(page)).includes("읽기 전용"), await flashText(page));
      const rf0 = calls(be, "ReadFileAs").length + calls(be, "ReadFile").length;
      await encMenu(page, "open", "CP949 (EUC-KR)");
      await sleep(400);
      ok(
        "「다른 인코딩으로 다시 열기」 → 📖 그대로(편집기로 안 읽음), 인코딩만 바뀜",
        calls(be, "ReadFileAs").length + calls(be, "ReadFile").length === rf0 &&
          calls(be, "EditOpenBegin").length === 0 &&
          (await mode(page)) === "all" &&
          (await page.$eval(".st-enc", (e) => e.textContent)).includes("CP949"),
        await page.$eval(".st-enc", (e) => e.textContent)
      );
      // the tab that was ✏️ in the session: back as 📖, with a word
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="all"]', { timeout: 8000 }).catch(() => {});
      await sleep(400);
      ok("세션에서 ✏️ 이던 300MB 탭 → 📖 로 열림(W 없음)", (await mode(page)) === "all" && calls(be, "EditOpenBegin").length === 0 && (await page.$(".rv-wait")) === null, await tabStates(page));
      ok("… 안내: 읽기 전용이라 📖", (await flashText(page)).includes("읽기 전용"), await flashText(page));
      // exactly 100MB in 🏷: ✏️ off too
      await page.click(".tabs-scroll .tab:nth-child(3)");
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await until(async () => (await page.$eval(".lines-seg.big button:nth-child(3)", (b) => b.title)).includes("100MB"), 3000);
      ok("정확히 100MB(🏷) 도 ✏️ 꺼짐", await page.$eval(".lines-seg.big button:nth-child(3)", (b) => b.disabled && b.title.includes("100MB 이상")));
      await ctx.close();
      // multi view: a pane's ✏️, a small .gz
      const be2 = makeBackend();
      be2.st.sizes[P("a.log")] = 300 * MB;
      be2.st.sizes[P("b.log")] = 150 * MB;
      be2.st.session = session([Rt("t1", P("a.log")), Lt("t2", P("b.log")), Lt("t3", P("small.log.gz"))], "t1", {
        multi: {
          on: true,
          count: 3,
          slots: [{ tabId: "t1", mode: "edit", server: "" }, { tabId: "t2", mode: "edit", server: "" }, { tabId: "t3", mode: "edit", server: "" }, ...Array.from({ length: 3 }, () => ({ tabId: "", mode: "read", server: "" }))],
          bundle: null,
        },
      });
      const r2 = await openSess(be2);
      await until(async () => (await r2.page.$$(".lines-view")).length === 3, 10000);
      await sleep(500);
      const pb = await r2.page.$$eval(".mpane .lines-seg.big button:nth-child(3)", (els) => els.map((b) => [b.disabled, b.title]));
      ok("멀티 뷰 칸 ✏️: 300MB·150MB 꺼짐(100MB 이유), .gz 꺼짐(.gz 이유)", pb.length === 3 && pb[0][0] && pb[0][1].includes("100MB 이상") && pb[1][0] && pb[1][1].includes("100MB 이상") && pb[2][0] && pb[2][1].includes(".gz"), pb);
      await forceEdit(r2.page, '.mpane[data-slot="1"]');
      await sleep(400);
      ok("칸 ✏️ 를 눌러도 C·W 없음", (await r2.page.$(".choice-ask")) === null && calls(be2, "EditOpenBegin").length === 0);
      await r2.ctx.close();
    }

    // =============== B. 편집 예산 = 파일 바이트 (한글 UTF-8) ======================================
    if (want("B")) {
      console.log("B. 편집 예산은 파일 바이트(한글 UTF-8 = 글자 수의 약 3배) · 🧠 같은 단위");
      const be = makeBackend();
      be.st.openFiles = [P("ko.log")];
      const { ctx, page } = await openSess(be);
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".cm-editor", { timeout: 8000 });
      await until(async () => (await held(page)) >= koBytes, 3000);
      ok(`작은 한글 파일 E: 예산 = 파일 바이트 ${koBytes} (글자 ${koChars} 아님)`, (await held(page)) >= koBytes && (await held(page)) < koBytes + 4096, { held: await held(page), koBytes, koChars });
      await ctx.close();
      // a 📖 tab (<100MB) → ✏️: W counts bytes, E keeps counting bytes
      const be2 = makeBackend();
      be2.st.session = session([Rt("t1", P("ko.log"))], "t1");
      const r2 = await openSess(be2);
      await r2.page.waitForSelector('.lines-view[data-mode="all"]');
      await r2.page.click(".lv-edit");
      await r2.page.click('.choice-ask [data-choice="edit"]');
      await r2.page.waitForSelector(".cm-editor", { timeout: 15000 });
      await sleep(500);
      const h2 = await held(r2.page);
      ok(`📖 → ✏️ 끝난 뒤(E)도 바이트로 셈 (${h2} = ${koBytes})`, h2 >= koBytes && h2 < koBytes + 4096, { h2, koBytes, koChars });
      await r2.page.dispatchEvent(".st-mem", "mousedown");
      await r2.page.waitForSelector(".mem-pop");
      const memN = await r2.page.$$eval(".mem-pop tr", (els) => els.map((e) => e.querySelector(".mem-n").textContent));
      ok("🧠 탭별 목록도 바이트", memN.includes(Math.round(koBytes / MB) + "MB"), { memN, koBytes });
      await r2.ctx.close();
    }

    // =============== C. W 취소 직후 다시 열기 (agy F-02) · 시작했던 R/L 로 · Esc 취소 (F-07) =================
    if (want("C")) {
      console.log("C. W 취소 직후 다시 ✏️ → 예산 남음(F-02) · 🏷 에서 연 W 취소 → 🏷 · W 에서 Esc = 취소(F-07)");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 60 * MB;
      be.st.sizes[P("b.log")] = 60 * MB;
      be.st.session = session([Rt("t1", P("a.log")), Lt("t2", P("b.log"))], "t1");
      const { ctx, page } = await openSess(be);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      be.delay.EditOpenChunk = 600;
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      ok("W 시작 → 예산 60MB", (await until(async () => (await held(page)) === 60 * MB, 2000)) === true, await held(page));
      await page.click(".rv-cancel");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      // again at once
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      await sleep(450); // past the old W's 200ms clean-up
      ok("취소 직후 다시 연 W: 예산 그대로 60MB (옛 타이머가 지우지 않음)", (await held(page)) === 60 * MB, await held(page));
      await page.click(".rv-cancel");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      // from 🏷: cancel goes back to 🏷
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await seg(page, 3);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      await page.click(".rv-cancel");
      await page.waitForSelector(".lines-view");
      await sleep(200);
      ok("🏷 에서 연 W 취소 → 🏷 로", (await mode(page)) === "lines" && JSON.stringify(await tabStates(page)) === '["L"]', await tabStates(page));
      // Esc in W cancels (F-07)
      await seg(page, 3);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
      ok("W 에서 Esc → 취소(🏷 로)", (await page.$(".rv-wait")) === null && (await mode(page)) === "lines", await tabStates(page));
      ok("… 예산 풀림", (await until(async () => (await held(page)) === 0, 2000)) === true, await held(page));
      be.delay.EditOpenChunk = 0;
      await ctx.close();
    }

    // =============== D. 다른 탭 W·S 를 requestEdit 안에서도 확인 · 세션 스냅샷 S·W·C → R ============
    if (want("D")) {
      console.log("D. 글자 든 탭의 ✏️ 도 다른 탭 W 중이면 막힘(함수 안) · 세션: W·C·S 는 R 로 저장");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 60 * MB;
      be.st.sizes[P("b.log")] = 60 * MB;
      be.st.session = session([Rt("t1", P("a.log")), Lt("t2", P("b.log"))], "t1");
      const { ctx, page } = await openSess(be);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      // t2: ✏️ then 🏷 (holds its text)
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await seg(page, 3);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      await seg(page, 2);
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      // W on t1 (started from 🏷: the session still says 📖)
      be.delay.EditOpenChunk = 4000;
      await page.click(".tabs-scroll .tab:nth-child(1)");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await seg(page, 2);
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await seg(page, 3);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(400);
      const snapW = JSON.parse(be.st.session).tabs.find((t) => t.id === "t1");
      ok("W 중 세션 = R (읽기 보기)", snapW && snapW.needsLoad && snapW.lines.on && snapW.lines.read, snapW && snapW.lines);
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await forceEdit(page);
      await sleep(250);
      ok("W 중 글자 든 탭 ✏️(눌림) → 막힘(🏷 그대로) + 이유", (await mode(page)) === "lines" && (await flashText(page)).includes("편집용으로 여는 중"), [await mode(page), await flashText(page)]);
      await page.click(".tabs-scroll .tab:nth-child(1)");
      await page.click(".rv-cancel");
      be.delay.EditOpenChunk = 0;
      // C in the session: R
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      await page.click(".lv-edit");
      await page.waitForSelector(".choice-ask");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(400);
      const snapC = JSON.parse(be.st.session).tabs.find((t) => t.id === "t1");
      ok("C 중 세션 = R", snapC && snapC.lines.on && snapC.lines.read, snapC && snapC.lines);
      await page.keyboard.press("Escape");
      // S (saving) of a big tab: R in the session
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await seg(page, 3);
      await page.waitForSelector(".cm-editor");
      await page.click(".cm-content");
      await page.keyboard.type("Q");
      be.delay.SaveFile = 1500;
      await page.keyboard.press("Control+s");
      await until(async () => (await tabStates(page)).includes("S"), 2000);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(400);
      const snapS = JSON.parse(be.st.session).tabs.find((t) => t.id === "t2");
      ok("S 중 세션 = R", snapS && snapS.needsLoad && snapS.lines.on && snapS.lines.read, snapS && { n: snapS.needsLoad, l: snapS.lines });
      await until(async () => !(await tabStates(page)).includes("S"), 4000);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(400);
      const snapE = JSON.parse(be.st.session).tabs.find((t) => t.id === "t2");
      ok("저장 끝난 뒤 세션 = E (편집)", snapE && !snapE.lines.on, snapE && snapE.lines);
      be.delay.SaveFile = 0;
      await ctx.close();
    }

    // =============== E. 저장 중(S): 인코딩하여 저장·다른 이름으로·다른 인코딩으로 다시 열기 막힘 ============
    if (want("E")) {
      console.log("E. S 중 상태 표시줄 「인코딩하여 저장」·「다른 이름으로」·「다른 인코딩으로 다시 열기」 막힘");
      const be = makeBackend();
      be.st.openFiles = [P("d.log")];
      const { ctx, page } = await openSess(be);
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".cm-editor");
      await page.click(".cm-content");
      await page.keyboard.type("Q");
      be.delay.SaveFile = 1500;
      await page.keyboard.press("Control+s");
      await sleep(200);
      await encMenu(page, "save", "UTF-8 BOM");
      await sleep(150);
      ok("S 중 「인코딩하여 저장」 → 두 번째 쓰기 없음 + 안내", calls(be, "SaveFile").length === 1 && (await flashText(page)).includes("저장 중"), [calls(be, "SaveFile").length, await flashText(page)]);
      await page.click('.tb-btn:has-text("다른 이름으로")', { force: true });
      await sleep(150);
      ok("S 중 「다른 이름으로」 → 대화상자 없음", be.st.saveAs.length === 0, be.st.saveAs);
      const r0 = calls(be, "ReadFileAs").length + calls(be, "EditOpenBegin").length;
      await encMenu(page, "open", "CP949 (EUC-KR)");
      await sleep(150);
      ok("S 중 「다른 인코딩으로 다시 열기」 → 읽지 않음", calls(be, "ReadFileAs").length + calls(be, "EditOpenBegin").length === r0);
      await sleep(1600);
      ok("저장은 한 번만", calls(be, "SaveFile").length === 1, calls(be, "SaveFile").length);
      be.delay.SaveFile = 0;
      await ctx.close();
    }

    // =============== F. 큰 일반 파일 열기 = 조각으로 · 100MB 미만 E 탭 다른 인코딩 ======================
    if (want("F")) {
      console.log("F. 큰 파일을 편집기로 열 때 조각으로(EditOpen) · 그 탭 「다른 인코딩으로 다시 열기」");
      const be = makeBackend();
      be.st.sizes[P("e.log")] = 100 * MB - 1;
      be.st.sizes[P("f.log")] = 1 * MB;
      be.st.openFiles = [P("e.log")];
      const { ctx, page } = await openSess(be);
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      ok("100MB − 1 → 편집기, 조각으로 읽음(ReadFile 0, EditOpenBegin 1)", calls(be, "ReadFile").length === 0 && calls(be, "EditOpenBegin").length === 1, [calls(be, "ReadFile").length, calls(be, "EditOpenBegin").length]);
      ok("… 글자 그대로", (await until(() => page.$eval(".cm-content", (e) => e.textContent.includes("INFO line 1")), 5000)) === true, await page.$eval(".cm-content", (e) => e.textContent.slice(0, 120)));
      // the document made from the pieces (never joined): typing and saving write the whole file
      await page.click(".cm-content");
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" TAILTYPED");
      await page.keyboard.press("Control+s");
      await until(() => calls(be, "SaveFile").length === 1, 5000);
      const sv = calls(be, "SaveFile")[0];
      const want0 = fs.readFileSync(P("e.log"), "utf8") + " TAILTYPED";
      ok("조각으로 연 탭 고쳐 저장 → 파일 전체 + 고친 글자", !!sv && sv.args[1] === want0, sv && [sv.args[1].length, want0.length, sv.args[1].slice(-30)]);
      await encMenu(page, "open", "CP949 (EUC-KR)");
      await until(async () => (await page.$eval(".st-enc", (e) => e.textContent)).includes("CP949"), 6000);
      ok("100MB 미만 E 탭 「다른 인코딩으로 다시 열기」 → 다시 읽음(CP949)", (await page.$eval(".st-enc", (e) => e.textContent)).includes("CP949") && (await page.$(".cm-editor")) !== null, await page.$eval(".st-enc", (e) => e.textContent));
      be.st.openFiles = [P("f.log")];
      await page.keyboard.press("Control+o");
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 3, 6000);
      ok("작은 파일은 그대로 한 번에(ReadFile)", calls(be, "ReadFile").length === 1, calls(be, "ReadFile").length);
      await ctx.close();
    }

    // =============== G. 예산 넘는 32~100MB: 「📖 읽기」도 고를 수 있음 ==============================
    if (want("G")) {
      console.log("G. 예산 넘는 32~100MB 파일 → 확인 창에 「📖 읽기」");
      const be = makeBackend();
      const names = ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log", "g.log", "h.log"];
      for (const n of names) be.st.sizes[P(n)] = 99 * MB;
      be.st.openFiles = names.map(P);
      be.st.session = session([], "", { multi: { on: true, count: 1, slots: Array.from({ length: 6 }, () => ({ tabId: "", mode: "edit", server: "" })), bundle: null } });
      const { ctx, page } = await openSess(be);
      await page.click('.mpane[data-slot="0"] .empty-actions button:has-text("파일 열기")');
      await page.waitForSelector(".big-ask");
      const btns = await page.$$eval(".big-ask button", (e) => e.map((b) => b.textContent.trim()));
      ok("확인 창 버튼 = 「📖 읽기 / 🏷 태그 줄만 열기 / 취소」", JSON.stringify(btns) === JSON.stringify(["📖 읽기", "🏷 태그 줄만 열기", "취소"]), btns);
      await page.click('.big-ask button:has-text("📖 읽기")');
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 8, 8000);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      ok("8개 모두 📖 (편집기로 안 읽음)", calls(be, "ReadFile").length === 0 && calls(be, "EditOpenBegin").length === 0 && (await mode(page)) === "all");
      await ctx.close();
    }

    // =============== H. 멀티 뷰 「📖 읽기 전용」 칸에서 ✏️ → 입력됨 (F-03) · 좁은 칸 ===================
    if (want("H")) {
      console.log("H. 멀티 뷰 📖 칸에서 ✏️ 로 연 탭에 글자가 들어감(F-03) · 6칸 좁은 창에서 칸 아래 단추 잘리지 않음");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 60 * MB;
      be.st.session = session([Rt("t1", P("a.log"))], "t1", { multi: { on: true, count: 1, slots: Array.from({ length: 6 }, (_, k) => ({ tabId: k ? "" : "t1", mode: "read", server: "" })), bundle: null } });
      const { ctx, page } = await openSess(be);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await seg(page, 3);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      await page.click(".cm-content");
      await page.keyboard.press("Control+End");
      await page.keyboard.type("TYPED");
      await sleep(200);
      ok("📖 칸에서 ✏️ 로 연 탭에 글자 입력됨", await page.$eval(".cm-content", (e) => e.textContent.includes("TYPED")));
      await ctx.close();
      for (const vp of [{ width: 900, height: 650 }, { width: 800, height: 600 }]) {
        const be2 = makeBackend();
        const names = ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log"];
        for (const n of names) be2.st.sizes[P(n)] = 300 * MB;
        const ts = names.map((n, k) => Rt("t" + k, P(n)));
        be2.st.session = session(ts, "t0", { multi: { on: true, count: 6, slots: ts.map((t) => ({ tabId: t.id, mode: "read", server: "" })), bundle: null } });
        const r2 = await openSess(be2, vp);
        await until(async () => (await r2.page.$$(".lines-view")).length === 6, 10000);
        await sleep(300);
        const out = await r2.page.$$eval(".mpane-foot", (feet) =>
          feet.map((f) => {
            const fr = f.getBoundingClientRect();
            return [".mp-modes", ".mp-pick", ".mp-x", ".lines-seg"].filter((s) => {
              const e = f.querySelector(s);
              if (!e) return true;
              const r = e.getBoundingClientRect();
              return r.right > fr.right + 0.5 || r.width < 4;
            });
          })
        );
        ok(`6칸 ${vp.width}×${vp.height}: 칸 모드·탭 고르기·×·📖🏷✏️ 가 칸 안에 보임`, out.every((x) => x.length === 0), out);
        await r2.ctx.close();
      }
    }

    // =============== I. agy F-04 · F-05 · F-06 · F-10 · F-11 · F-12 ================================
    if (want("I")) {
      console.log("I. F-04 대소문자 다른 같은 경로 · F-05 늦은 StatFile · F-06 미리보기 · F-10 4KB 뒤 찾기 · F-11 지운 파일 · F-12 문구");
      // F-04
      {
        const be = makeBackend();
        be.st.openFiles = [P("Same.log")];
        const { ctx, page } = await openSess(be);
        await page.keyboard.press("Control+o");
        await page.waitForSelector(".cm-editor");
        await page.click(".cm-content");
        await page.keyboard.type("DIRTY");
        await sleep(200);
        const n0 = (await page.$$(".tabs-scroll .tab")).length;
        be.st.openFiles = [P("SAME.LOG")];
        await page.keyboard.press("Control+o");
        await sleep(500);
        ok(
          "F-04: 고친 탭의 같은 파일(대소문자 다름) 열기 → 편집기·고친 글자 그대로, 새 탭 없음",
          (await page.$(".cm-editor")) !== null && (await page.$eval(".cm-content", (e) => e.textContent.includes("DIRTY"))) && (await page.$$(".tabs-scroll .tab")).length === n0,
          [(await page.$$(".tabs-scroll .tab")).length, n0]
        );
        await ctx.close();
      }
      // F-05
      {
        const be = makeBackend();
        be.st.sizes[P("a.log")] = 60 * MB;
        be.st.sizes[P("b.log")] = 60 * MB;
        be.st.session = session([Rt("t1", P("a.log")), Rt("t2", P("b.log"))], "t1", {
          multi: { on: true, count: 2, slots: [{ tabId: "t1", mode: "edit", server: "" }, { tabId: "t2", mode: "edit", server: "" }, ...Array.from({ length: 4 }, () => ({ tabId: "", mode: "edit", server: "" }))], bundle: null },
        });
        const { ctx, page } = await openSess(be);
        await until(async () => (await page.$$('.lines-view[data-mode="all"]')).length === 2, 8000);
        await page.click('.mpane[data-slot="1"] .lv-edit');
        await page.click('.choice-ask [data-choice="edit"]');
        await page.waitForSelector('.mpane[data-slot="1"] .cm-editor', { timeout: 15000 });
        await page.click('.mpane[data-slot="1"] .cm-content');
        await page.keyboard.type("Z");
        await until(async () => (await tabStates(page)).includes("D"), 3000);
        be.delay.StatFile = 600;
        await page.click('.mpane[data-slot="0"] .lv-edit');
        await sleep(50);
        await page.click('.mpane[data-slot="1"] .lines-seg.big button:nth-child(1)');
        await page.waitForSelector('.choice-ask[data-kind="dirty"]');
        await sleep(900);
        ok("F-05: 늦게 끝난 ✏️ 확인이 「저장 / 버리기 / 취소」 를 덮지 않음", (await page.$('.choice-ask[data-kind="dirty"]')) !== null, await page.$eval(".choice-ask", (e) => e.dataset.kind).catch(() => null));
        await page.click('.choice-ask [data-choice="cancel"]').catch(() => {});
        be.delay.StatFile = 0;
        await ctx.close();
      }
      // F-06 · F-11 · F-10 (single view)
      {
        const be = makeBackend();
        be.st.sizes[P("a.log")] = 60 * MB;
        be.st.sizes[P("long.log")] = 150 * MB;
        be.st.session = session([Rt("t1", P("a.log")), Rt("t2", P("long.log"))], "t1");
        const { ctx, page } = await openSess(be);
        await page.waitForSelector('.lines-view[data-mode="all"]');
        await page.click('.seg-btn:has-text("미리보기")', { force: true, timeout: 2000 }).catch(() => {});
        await sleep(300);
        ok("F-06: 📖 에서 「미리보기」 눌러도 읽기 화면·📖🏷✏️ 남음", (await page.$(".lines-view")) !== null && (await page.$(".lines-seg.big")) !== null);
        // F-11
        be.st.gone.add(P("a.log"));
        await page.click(".lv-edit");
        await sleep(400);
        ok("F-11: 지워진 파일 ✏️ → 확인 창 없이 「지워졌거나 옮겨졌습니다」", (await page.$(".choice-ask")) === null && (await flashText(page)).includes("지워졌"), await flashText(page));
        if (await page.$(".choice-ask")) await page.keyboard.press("Escape");
        be.st.gone.delete(P("a.log"));
        // F-10: find past 4KB in 📖
        await page.click(".tabs-scroll .tab:nth-child(2)");
        await page.waitForSelector('.lines-view[data-mode="all"]');
        await waitDone(page);
        await page.focus(".lv-scroll");
        await page.keyboard.press("Control+f");
        await page.waitForSelector(".lv-find-input");
        const ph = await page.$eval(".lv-find-input", (e) => e.placeholder);
        ok("F-10: 📖 찾기 칸 이름 = 읽기 보기", ph.includes("읽기") && !ph.includes("줄만"), ph);
        await page.fill(".lv-find-input", "TAIL_SECRET_AT_6K");
        await until(async () => /줄$/.test(await page.$eval(".lv-find-count", (e) => e.textContent)), 6000);
        await page.keyboard.press("Enter");
        await sleep(400);
        const far = await page.$eval(".lines-view", (e) => e.textContent);
        ok("F-10: 4KB 뒤에서 찾은 줄 → 「안 보이는 뒤쪽」 안내", far.includes("안 보이는 뒤쪽"), far.slice(0, 300));
        await ctx.close();
      }
      // F-12: a 0-byte file in 📖 says it is empty
      {
        fs.writeFileSync(P("zero.log"), "");
        const be = makeBackend();
        be.st.session = session([Rt("t1", P("zero.log"))], "t1");
        const { ctx, page } = await openSess(be);
        await page.waitForSelector('.lines-view[data-mode="all"]');
        await waitDone(page);
        ok("F-12: 0바이트 파일 📖 → 「빈 파일입니다.」", (await page.$eval(".lines-view", (e) => e.textContent)).includes("빈 파일입니다"), await page.$eval(".lines-view", (e) => e.textContent.slice(0, 200)));
        await ctx.close();
      }
      // F-12: 768MB + 1 byte
      {
        const be = makeBackend();
        const sz = { "a.log": 99 * MB, "b.log": 99 * MB, "c.log": 99 * MB, "d.log": 99 * MB, "e.log": 99 * MB, "f.log": 99 * MB, "g.log": 99 * MB, "h.log": 768 * MB - 7 * 99 * MB + 1 };
        for (const [n, s] of Object.entries(sz)) be.st.sizes[P(n)] = s;
        const ts = Object.keys(sz).map((n, k) => Rt("t" + k, P(n)));
        be.st.session = session(ts, "t0");
        const { ctx, page } = await openSess(be);
        for (let k = 0; k < 7; k++) {
          await page.click(`.tabs-scroll .tab:nth-child(${k + 1})`);
          await page.waitForSelector('.lines-view[data-mode="all"]');
          await page.click(".lv-edit");
          await page.click('.choice-ask [data-choice="edit"]');
          await page.waitForSelector(".cm-editor", { timeout: 15000 });
        }
        await page.click(".tabs-scroll .tab:nth-child(8)");
        await page.waitForSelector('.lines-view[data-mode="all"]');
        await sleep(300);
        const w = await page.$eval(".lv-edit", (b) => [b.disabled, b.title]);
        ok("F-12: 768MB+1바이트 → 꺼짐, 문구 모순 없음(바이트 수로)", w[0] && !/768\.0MB 가 되어 768\.0MB/.test(w[1]) && w[1].includes("바이트"), w);
        await ctx.close();
      }
    }
    // =============== J. 화면 JS 힙이 차 있으면 ✏️·큰 열기를 막음 (작은 파일판 OOM, .18 10-29) ==========
    if (want("J")) {
      console.log("J. 내려놓은 글자가 아직 안 풀려 화면 힙이 차 있으면 ✏️ 꺼짐+이유 · 풀리면 다시 켜짐 · 큰 일반 열기는 📖 를 권함");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 99 * MB;
      be.st.sizes[P("b.log")] = 99 * MB;
      be.st.session = session([Rt("t1", P("a.log"))], "t1");
      const { ctx, page } = await openSess(be);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      const GB = 1 << 30;
      await page.evaluate((GB) => (window.__fakeHeap = { used: 3.4 * GB, limit: 4.1 * GB }), GB);
      await page.click(".tabs-scroll .tab:nth-child(1)"); // re-render
      const w = await until(async () => {
        const x = await page.$eval(".lv-edit", (b) => [b.disabled, b.title]);
        return x[0] && x;
      }, 5000);
      ok("힙 3.4GB / 4.1GB(80% 넘음) → ✏️ 꺼짐 + 「화면 메모리」 이유", !!w && w[1].includes("화면 메모리"), w || (await page.$eval(".lv-edit", (b) => [b.disabled, b.title])));
      await page.evaluate(() => window.__chipperTest.requestEdit(document.querySelector(".lines-host").dataset.tab));
      await sleep(300);
      ok("눌러도 확인 창 없음", (await page.$(".choice-ask")) === null && calls(be, "EditOpenBegin").length === 0);
      await page.evaluate((GB) => (window.__fakeHeap = { used: 1.0 * GB, limit: 4.1 * GB }), GB);
      const back = await until(async () => !(await page.$eval(".lv-edit", (b) => b.disabled)), 6000);
      ok("힙이 풀리면(1.0GB) 손대지 않아도 몇 초 안에 ✏️ 다시 켜짐", back === true);
      // a big plain file opened while the heap is full: the question offers 📖
      await page.evaluate((GB) => (window.__fakeHeap = { used: 3.4 * GB, limit: 4.1 * GB }), GB);
      be.st.openFiles = [P("b.log")];
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".big-ask", { timeout: 5000 }).catch(() => {});
      const ask = await page.$eval(".big-ask", (e) => [e.textContent, [...e.querySelectorAll("button")].map((b) => b.textContent.trim())]).catch(() => null);
      ok("힙이 찬 채 99MB 열기 → 확인 창(📖 읽기 권함·화면 메모리 이유)", !!ask && ask[1][0] === "📖 읽기" && ask[0].includes("화면 메모리"), ask);
      if (ask) await page.click('.big-ask button:has-text("📖 읽기")');
      await sleep(400);
      ok("… 📖 로 열림(편집기로 안 읽음)", calls(be, "ReadFile").length === 0 && calls(be, "EditOpenBegin").length === 0);
      await ctx.close();
    }
    // =============== J2. 「화면 메모리 정리」(호스트 GC) 가 있으면: ✏️ 는 켜져 있고 누르면 정리 뒤 진행 · 내려놓은 뒤 높으면 정리 =====
    if (want("J2")) {
      console.log("J2. 호스트 GC 있음: 힙이 차 있어도 ✏️ 켜짐 → 누르면 정리 → 내려가면 확인 창 / 안 내려가면 이유 · 📖 로 내려놓은 뒤 힙 60% 넘으면 정리");
      const GB = 1 << 30;
      const be = makeBackend();
      be.st.gcReady = true;
      be.st.sizes[P("a.log")] = 60 * MB;
      be.st.sizes[P("b.log")] = 60 * MB;
      be.st.session = session([Rt("t1", P("a.log")), Rt("t2", P("b.log"))], "t1");
      const { ctx, page } = await openSess(be);
      be.st.onGc = () => page.evaluate((GB) => (window.__fakeHeap = { used: 1.0 * GB, limit: 4.1 * GB }), GB);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await page.evaluate((GB) => (window.__fakeHeap = { used: 3.4 * GB, limit: 4.1 * GB }), GB);
      await sleep(2500);
      ok("힙 3.4GB 여도 ✏️ 켜짐(누르면 정리)", await page.$eval(".lv-edit", (b) => !b.disabled));
      await page.click(".lv-edit");
      await page.waitForSelector('.choice-ask[data-kind="edit"]', { timeout: 5000 }).catch(() => {});
      ok("누름 → 정리 1번 → 힙 내려감 → 확인 창", (be.st.gcCalls || 0) === 1 && (await page.$('.choice-ask[data-kind="edit"]')) !== null, be.st.gcCalls);
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      // let it go with the heap high: collected once
      await page.evaluate((GB) => (window.__fakeHeap = { used: 2.8 * GB, limit: 4.1 * GB }), GB);
      const c0 = be.st.gcCalls;
      await seg(page, 1);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await until(() => be.st.gcCalls > c0, 3000);
      ok("✏️ → 📖, 힙 2.8GB(60% 넘음) → 정리 1번", be.st.gcCalls === c0 + 1, be.st.gcCalls - c0);
      // low heap: not collected
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      const c1 = be.st.gcCalls;
      await seg(page, 1);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await sleep(1200);
      ok("✏️ → 📖, 힙 1.0GB → 정리 안 함(창이 멈추니)", be.st.gcCalls === c1, be.st.gcCalls - c1);
      // the collection does not bring it down: the reason, no question
      be.st.onGc = null;
      await page.evaluate((GB) => (window.__fakeHeap = { used: 3.4 * GB, limit: 4.1 * GB }), GB);
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await sleep(300);
      await page.click(".lv-edit");
      await sleep(4000);
      ok("정리해도 안 내려감 → 확인 창 없이 이유(「다시 여세요」)", (await page.$(".choice-ask")) === null && (await flashText(page)).includes("다시 여세요"), await flashText(page));
      await ctx.close();
    }
    // =============== M. F-08 .gz 는 크기 상관없이 📖 · F-09 이진 파일은 막지 않고 경고 + 📖 =====================
    if (want("M")) {
      console.log("M. 작은 .gz → 📖 · 이진 파일 → 알림 없이 📖 + 「텍스트 파일이 아닌 것 같습니다」 · 보통 파일엔 띠 없음");
      fs.writeFileSync(P("struct.bin"), "x");
      const be = makeBackend();
      be.st.bin.add(P("struct.bin"));
      be.st.bin.add(P("h.log"));
      be.st.sizes[P("h.log")] = 150 * MB;
      be.st.session = session([], "");
      be.st.openFiles = [P("small.log.gz")];
      const { ctx, page } = await openSess(be);
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".lines-view", { timeout: 8000 });
      ok("작은 .gz(1KB) → 기본 📖 읽기", (await mode(page)) === "all", await mode(page));
      ok("… 보통 파일엔 경고 띠 없음", (await page.$(".lv-binwarn")) === null);
      be.st.openFiles = [P("struct.bin")];
      const d0 = page.__dialogs.length;
      await page.keyboard.press("Control+o");
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 2, 5000);
      await page.waitForSelector(".lv-binwarn", { timeout: 5000 }).catch(() => {});
      ok(
        "이진 파일(작음) → 알림 없이 📖 + 경고 띠",
        page.__dialogs.length === d0 && (await mode(page)) === "all" && (await page.$(".cm-editor")) === null && (await page.$eval(".lv-binwarn", (e) => e.textContent).catch(() => "")).includes("텍스트 파일이 아닌 것 같습니다"),
        page.__dialogs.slice(d0)
      );
      be.st.openFiles = [P("h.log")];
      await page.keyboard.press("Control+o");
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 3, 5000);
      await page.waitForSelector(".lv-binwarn", { timeout: 5000 }).catch(() => {});
      ok("이진으로 보이는 150MB → 📖 + 경고 띠", (await mode(page)) === "all" && (await page.$(".lv-binwarn")) !== null);
      await ctx.close();
    }
    // =============== N. 내려놓은 편집 문서가 남지 않음 (작은 판 누수 시험) ==================================
    // 10MB × 7 를 ✏️ 로 열고, 하나씩 📖(고쳤으면 버리기) → ✏️ → 글자 하나(D) 를 되풀이. 바퀴마다 CDP 로 GC 한 뒤 힙.
    // 8바퀴(모든 탭이 한 번씩 D) 뒤로는 평평해야 함 — 바퀴마다 파일 크기만큼 남으면 누군가 옛 문서를 잡고 있는 것.
    // (Playwright 의 ElementHandle 도 떼어 낸 편집기를 잡으므로 이 절은 locator().waitFor() 만 씀)
    if (want("N")) {
      console.log("N. ✏️ ↔ 📖 + 고침(D) 21바퀴 — GC 뒤 힙이 7바퀴 뒤로 평평");
      const line = "2026-10-29 01:00:00 INFO collector line with some text here and there\n";
      const body = line.repeat(Math.ceil((10 << 20) / line.length));
      const n = 7;
      for (let k = 0; k < n; k++) fs.writeFileSync(P(`leak${k}.log`), body);
      const be = makeBackend();
      be.st.session = session(Array.from({ length: n }, (_, k) => Rt("t" + k, P(`leak${k}.log`))), "t0");
      const { ctx, page } = await openSess(be);
      const cdp = await ctx.newCDPSession(page);
      const heapMB = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        await sleep(150);
        await cdp.send("HeapProfiler.collectGarbage");
        return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576;
      };
      const pick = (k) => page.click(`.tabs-scroll .tab:nth-child(${k + 1})`);
      const edit = async () => {
        await page.locator('.lines-view[data-mode="all"]').first().waitFor();
        await page.click(".lv-edit");
        await page.click('.choice-ask [data-choice="edit"]');
        await page.locator(".cm-editor").first().waitFor({ timeout: 30000 });
      };
      for (let k = 0; k < n; k++) {
        await pick(k);
        await edit();
      }
      const hs = [];
      for (let r = 0; r < 3 * n; r++) {
        await pick(r % n);
        await page.locator(".cm-editor").first().waitFor();
        await page.click(".lines-seg.big button:nth-child(1)");
        if (await page.locator('.choice-ask[data-kind="dirty"]').waitFor({ timeout: 800 }).then(() => true, () => false)) await page.click('.choice-ask [data-choice="discard"]');
        await edit();
        await page.click(".cm-content");
        await page.keyboard.press("Control+End");
        await page.keyboard.type(" R" + r);
        await sleep(250);
        hs.push(Math.round(await heapMB()));
      }
      // from the 8th round on (every tab has been ✏️ → 📖 → ✏️ → D once: its steady cost is in)
      const grow = hs[hs.length - 1] - hs[n];
      ok(`GC 뒤 힙: 8바퀴 ${hs[n]}MB → 21바퀴 ${hs[hs.length - 1]}MB (늘어남 ${grow}MB ≤ 8MB, 파일 10MB)`, grow <= 8, hs);
      await ctx.close();
    }
    // =============== K. 6칸에서 칸 머리(칩 여러 줄·찾기 칸)가 길어도 칸 아래 단추 줄이 보이고 눌림 =========
    if (want("K")) {
      console.log("K. 6칸 · 칸 머리가 길어도(제외 칩 여러 줄·찾기 칸) 칸 아래 단추 줄을 목록이 덮지 않음 — 창 작게/크게");
      const exs = ["java.lang.Object@", "port(502)", "Interface Converter", "ALL POINTS MISSED!!!", "uncollected :", "connection timed out", "POINTS", "LAST_DAY(", "checkpoint", "failed to connect"].map((pattern, k) => ({ pattern, kind: "text", caseSensitive: false, on: k % 3 !== 1 }));
      for (const vp of [{ width: 1100, height: 560 }, { width: 1400, height: 900 }]) {
        const be = makeBackend();
        const names = ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log"];
        for (const n of names) be.st.sizes[P(n)] = 300 * MB;
        const ts = names.map((n, k) => tab("t" + k, P(n), { lines: LN({ read: k % 2 === 0, ex: exs }) }));
        be.st.session = session(ts, "t0", { multi: { on: true, count: 6, slots: ts.map((t) => ({ tabId: t.id, mode: "read", server: "" })), bundle: null } });
        const { ctx, page } = await openSess(be, vp);
        await until(async () => (await page.$$(".lines-view")).length === 6, 10000);
        // the find bar open in every pane too
        for (let i = 0; i < 6; i++) {
          await page.click(`.mpane[data-slot="${i}"] .lv-scroll`, { position: { x: 5, y: 5 }, force: true }).catch(() => {});
          await page.keyboard.press("Control+f");
        }
        await sleep(400);
        const hit = await page.$$eval(".mpane", (ps) =>
          ps.map((pn) => {
            const foot = pn.querySelector(".mpane-foot");
            const out = [];
            for (const sel of [".lines-seg button:nth-child(2)", ".mp-pick", ".mp-modes button"]) {
              const b = foot.querySelector(sel);
              if (!b) {
                out.push(sel + ":없음");
                continue;
              }
              const r = b.getBoundingClientRect();
              const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              if (!e || !foot.contains(e)) out.push(sel + ":" + (e ? e.className : "null"));
            }
            return out;
          })
        );
        ok(`6칸 ${vp.width}×${vp.height}: 칸 아래 단추(🏷·탭 고르기·칸 모드)를 누르면 그 단추가 받음`, hit.every((x) => x.length === 0), hit);
        const rowsOver = await page.$$eval(".mpane", (ps) =>
          ps.map((pn) => {
            const f = pn.querySelector(".mpane-foot").getBoundingClientRect();
            const sc = pn.querySelector(".lv-scroll");
            return sc ? Math.round(sc.getBoundingClientRect().bottom - f.top) : -999;
          })
        );
        ok(`6칸 ${vp.width}×${vp.height}: 목록이 단추 줄 위로 넘지 않음`, rowsOver.every((d) => d <= 1), rowsOver);
        await ctx.close();
      }
    }
    // =============== L. 제외 칩 바꾼 직후(다시 훑는 중·보던 자리로 돌아가는 중) End·Home 이 이김 (부하 시험 재현 1) ======
    if (want("L")) {
      console.log("L. 칩을 누른 직후 End → 끝으로 가서 훑기가 끝날 때까지 끝을 따라감 · Home 도 사용자 것이 이김");
      const big = [];
      for (let i = 1; i <= 400000; i++) big.push(`2026-10-29 01:00:00 INFO ${i % 3 === 0 ? "noise " : ""}line ${i} ${"x".repeat(40)}`);
      fs.writeFileSync(P("big.log"), big.join("\n"));
      const lastLine = 400000;
      for (const key of ["End", "Home"]) {
        const be = makeBackend();
        be.st.sizes[P("big.log")] = 150 * MB;
        be.st.session = session([Rt("t1", P("big.log"), { lines: LN({ ex: [{ pattern: "noise", kind: "text", caseSensitive: false, on: false }] }) })], "t1");
        const { ctx, page } = await openSess(be);
        await page.waitForSelector('.lines-view[data-mode="all"]');
        await waitDone(page);
        // about 30% down
        await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight * 0.3));
        await sleep(500);
        // the way back to the place comes late (a busy engine)
        be.delay.FilterRowOfLine = 1500;
        await page.click('.lv-chip[data-ex="0"] .lv-chip-t');
        await sleep(60);
        await page.focus(".lv-scroll");
        await page.keyboard.press(key);
        await sleep(2500);
        await waitDone(page);
        await sleep(500);
        const vd = await viewData(page);
        const lines = await page.$$eval(".lv-row[data-line]", (els) => els.map((e) => +e.dataset.line));
        const sel = await page.$eval(".lv-row.sel", (e) => +e.dataset.line).catch(() => 0);
        if (key === "End") ok(`칩 직후 End → 끝(마지막 줄 ${lastLine} 보임·선택)`, lines.includes(lastLine) && sel === lastLine, { last: Math.max(...lines), sel, count: vd.count });
        else ok("칩 직후 Home → 맨 앞(1번째 줄 보임·선택)", lines.includes(1) && sel === 1, { first: Math.min(...lines), sel, vd, rows: (await page.$$eval(".lv-row", (els) => els.slice(0, 3).map((e) => e.className + "|" + e.dataset.row + "|" + e.textContent.slice(0, 30)))), top: await page.$eval(".lv-scroll", (e) => e.scrollTop) });
        be.delay.FilterRowOfLine = 0;
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  console.log(`\nfixr1-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
