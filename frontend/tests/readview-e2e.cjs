// Headless test of 「📖 읽기 보기」 (readview: LinesView mode "all", the
// 📖/🏷/✏️ switch, 「✏️ 편집으로 열기」 C → W → E, D 저장/버리기/취소, S, 🧠)
// — the cells of readview-qa-plan.md §2 that a headless window can reach —
// against the built frontend
// (frontend/dist) and the REAL line filter: the Filter* bindings go to a Go
// helper (go test -run TestFilterE2EServer, linefilter_e2e_test.go) that calls
// App.FilterStart/Rows/… on the real engine and relays its progress events.
// The other bindings (session, tags, files) are faked on the Node side, like
// tags-e2e.cjs. Data files are real files in a temp folder (the engine reads them).
//
//   cd frontend && npm run build && node tests/readview-e2e.cjs
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
  const st = { session: "", tags: null, calls: [], files: {}, sizes: {}, scan: null, openFiles: [], tooBigSave: 0 };
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
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: false, canceled: false };
    },
    ReadFileAs: (p, enc) => ({ ...impl.ReadFile(p), encoding: enc }),
    StatFile: (p) => {
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
      st.calls.push({ name, args, t: Date.now() });
      if (delay[name]) await sleep(delay[name]);
      if (FILTER.has(name)) return goPost(name, args);
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
// 「📂 디렉토리 열기」(10-28) no longer turns the multi view on with a pane per
// server; these steps look at a bundle file in a pane, so they start in a
// one-pane multi view (what opening the bundle used to make).
const MULTI1 = { multi: { on: true, count: 1, slots: Array.from({ length: 6 }, () => ({ tabId: "", mode: "read", server: "" })), bundle: null } };
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

// grep -B A -A B over lines (1-based), the way the engine lays out rows
function refRows(lines, isHit, A, B) {
  const n = lines.length;
  const ivs = [];
  for (let i = 1; i <= n; i++) {
    if (!isHit(lines[i - 1])) continue;
    const lo = Math.max(1, i - A);
    const hi = Math.min(n, i + B);
    const last = ivs[ivs.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else ivs.push({ lo, hi });
  }
  const out = [];
  let prev = 0;
  for (const iv of ivs) {
    if (iv.lo > prev + 1) out.push(`⋯ ${(iv.lo - prev - 1).toLocaleString("en-US")}줄 생략`);
    for (let x = iv.lo; x <= iv.hi; x++) out.push(`${x}:${lines[x - 1]}`);
    prev = iv.hi;
  }
  if (prev < n) out.push(`⋯ ${(n - prev).toLocaleString("en-US")}줄 생략`);
  return out;
}
// rows on screen, in order: "line:text" or the gap text
const shownRows = (page, scope = "") =>
  page.$$eval(scope + " .lines-view .lv-row[data-row]", (els) =>
    els
      .map((e) => ({ row: +e.dataset.row, line: +(e.dataset.line || 0), text: e.querySelector(".lv-text").textContent }))
      .sort((a, b) => a.row - b.row)
      .map((r) => (r.line ? `${r.line}:${r.text}` : r.text))
  );
const viewData = (page, scope = "") => page.$eval(scope + " .lines-view", (e) => ({ ...e.dataset }));
const notes = (page) => page.$$eval(".lv-note", (els) => els.map((e) => e.textContent));
const calls = (be, name) => be.st.calls.filter((c) => c.name === name);
const waitDone = (page, scope = "") => until(async () => (await viewData(page, scope)).state === "done", 15000);
async function waitRows(page, want, scope = "", ms = 8000) {
  let got;
  await until(async () => {
    got = await shownRows(page, scope);
    return JSON.stringify(got) === JSON.stringify(want);
  }, ms);
  return got;
}
async function setCtx(page, above, below) {
  await page.fill(".lv-ctx:nth-of-type(1) input", String(above));
  await page.fill(".lv-ctx:nth-of-type(2) input", String(below));
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

// ONLY=1,8,10a … runs just those sections (all when unset)
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readview-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const MB = 1 << 20;
  // a log: 400 lines, ERROR every 37th, "noise" every 5th
  const lines = [];
  for (let i = 1; i <= 400; i++)
    lines.push(
      i % 37 === 0
        ? `2026-10-28 12:00:${String(i % 60).padStart(2, "0")} ERROR failed ${i}`
        : `2026-10-28 12:00:00 INFO ${i % 5 === 0 ? "noise " : ""}line ${i}`
    );
  const big = (n) => P(n);
  for (const n of ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log", "edge.log", "under.log"]) fs.writeFileSync(P(n), lines.join("\n"));
  const NOISE = lines.filter((l) => l.includes("noise")).length;
  const allRows = (hide) => lines.map((l, i) => `${i + 1}:${l}`).filter((r) => !hide || !hide(r));
  const tabStates = (page) => page.$$eval(".lines-seg.big", (els) => els.map((e) => e.dataset.state));
  const seg = (page, k) => page.click(`.lines-seg.big button:nth-child(${k})`);
  const mode = (page) => page.$eval(".lines-view", (e) => e.dataset.mode).catch(() => null);
  const flashText = () => page_.$eval(".st-flash", (e) => e.textContent).catch(() => "");
  let page_ = null;
  const memText = (page) => page.$eval(".st-mem", (e) => e.textContent).catch(() => "");
  // the window's longest stall while doing fn (PerformanceObserver longtask)
  async function stall(page, fn) {
    await page.evaluate(() => {
      window.__lt = 0;
      if (!window.__ltObs) {
        window.__ltObs = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt = Math.max(window.__lt, e.duration);
        });
        window.__ltObs.observe({ entryTypes: ["longtask"] });
      }
    });
    await fn();
    await sleep(100);
    return page.evaluate(() => window.__lt);
  }
  try {
    // =============== 1. 100MB+ opens as 📖 at once · every line · switch · chips hide · find · colours ===========
    if (want("1")) {
      console.log("1. 큰 파일 = 확인 창 없이 📖 읽기 · 모든 줄 · 📖↔🏷 즉시 · 제외 = 숨김 · 찾기 · 색");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 300 * MB;
      be.st.openFiles = [P("a.log")];
      const { ctx, page } = await openPage(browser, url, be);
      page_ = page;
      await page.keyboard.press("Control+o");
      await page.waitForSelector(".lines-view", { timeout: 8000 }).catch(() => {});
      ok("300MB 열기 → 확인 창 없음", (await page.$(".big-ask")) === null && page.__dialogs.length === 0, page.__dialogs);
      ok("기본 보기 = 📖 읽기(R)", (await mode(page)) === "all" && JSON.stringify(await tabStates(page)) === '["R"]', await tabStates(page));
      await waitDone(page);
      ok("행 = 파일의 모든 줄(원래 줄 번호)", JSON.stringify(await waitRows(page, allRows().slice(0, (await shownRows(page)).length))) === JSON.stringify(allRows().slice(0, (await shownRows(page)).length)), (await shownRows(page)).slice(0, 3));
      ok("편집기로 읽지 않음(ReadFile·EditOpen 없음)", calls(be, "ReadFile").length + calls(be, "EditOpenBegin").length === 0);
      const st0 = calls(be, "FilterStart")[0];
      ok("엔진 요청 = 모드 all · 규칙 없음", st0 && st0.args[0].mode === "all" && st0.args[0].rules.length === 0, st0 && st0.args[0]);
      ok("상태: 400줄 / 전체 400줄", /^400줄 \/ 전체 400줄/.test(await page.$eval(".lv-stat", (e) => e.textContent)), await page.$eval(".lv-stat", (e) => e.textContent));
      ok("태그 체크·위아래 칸 없음, ✏️ 편집으로 열기 있음", (await page.$(".lv-tag")) === null && (await page.$(".lv-ctx")) === null && (await page.$(".lv-edit")) !== null);
      // Enter / double-click opens nothing (it is the whole file already)
      await page.click('.lv-row[data-line="3"] .lv-text');
      await page.keyboard.press("Enter");
      await page.dblclick('.lv-row[data-line="4"] .lv-text');
      await sleep(300);
      ok("R: Enter·두 번 누르기 → 그대로(편집기 안 열림)", (await mode(page)) === "all" && (await page.$(".cm-editor")) === null);
      // typing / Ctrl+S
      await page.keyboard.type("xyz");
      await page.keyboard.press("Control+s");
      await sleep(200);
      ok("R: 글자 입력 무시 · 저장 → 안내만", calls(be, "SaveFile").length === 0 && (await flashText()).includes("저장할 것이 없습니다"), await flashText());
      // 📖 → 🏷 → 📖: at once, the same job reused
      const t0 = Date.now();
      let lt = await stall(page, async () => {
        await seg(page, 2);
        await until(async () => (await mode(page)) === "lines", 4000, 10);
        await waitDone(page);
      });
      const tL = Date.now() - t0;
      ok(`R → 🏷 줄만 즉시 (${tL}ms, 막힘 최대 ${Math.round(lt)}ms)`, (await mode(page)) === "lines" && tL < 2000 && lt < 2000, { tL, lt });
      ok("L: 걸린 줄만 (ERROR)", (await shownRows(page)).some((r) => r.startsWith("37:")), (await shownRows(page)).slice(0, 4));
      const n0 = calls(be, "FilterStart").length;
      const t1 = Date.now();
      await seg(page, 1);
      await until(async () => (await mode(page)) === "all", 4000, 10);
      await waitDone(page);
      ok(`L → 📖 읽기 즉시 (${Date.now() - t1}ms)`, Date.now() - t1 < 2000);
      const back = calls(be, "FilterStart").slice(n0);
      ok("다시 📖 = 캐시된 작업(다시 안 훑음)", back.length === 1, back.length);
      // chips hide lines in 📖
      lt = await stall(page, async () => {
        await page.click(".lv-ex-plus");
        await page.fill(".lv-ex-in", "noise");
        await page.keyboard.press("Enter");
        await until(async () => (await viewData(page)).count === String(400 - NOISE), 6000);
      });
      ok(`제외 칩 「noise」 → 그 글자가 든 줄 ${NOISE}개 숨김 (막힘 최대 ${Math.round(lt)}ms)`, (await viewData(page)).count === String(400 - NOISE) && lt < 2000, await viewData(page));
      ok(`상태: ${400 - NOISE}줄 (숨김 ${NOISE})`, (await page.$eval(".lv-stat", (e) => e.textContent)).startsWith(`${400 - NOISE}줄 (숨김 ${NOISE})`), await page.$eval(".lv-stat", (e) => e.textContent));
      const hidden = (r) => r.includes("noise");
      const shown = await shownRows(page);
      ok("행 = 숨긴 줄을 뺀 원본 줄", JSON.stringify(shown) === JSON.stringify(allRows(hidden).slice(0, shown.length)), shown.slice(0, 6));
      await page.click('.lv-chip[data-ex="0"] .lv-chip-t');
      await until(async () => (await viewData(page)).count === "400", 6000);
      ok("칩 끄기 → 다시 400줄", (await viewData(page)).count === "400");
      await page.click('.lv-chip[data-ex="0"] .lv-chip-t');
      await until(async () => (await viewData(page)).count === String(400 - NOISE), 6000);
      // find over every visible line (Go)
      await page.focus(".lv-scroll");
      lt = await stall(page, async () => {
        await page.keyboard.press("Control+f");
        await page.waitForSelector(".lv-find-input");
        await page.fill(".lv-find-input", "ERROR");
        await until(async () => /줄$/.test(await page.$eval(".lv-find-count", (e) => e.textContent)), 6000);
      });
      const wantFind = allRows(hidden).filter((r) => r.includes("ERROR")).length;
      const fc = await page.$eval(".lv-find-count", (e) => e.textContent);
      ok(`찾기 「ERROR」 = 보이는 줄 중 ${wantFind}줄 (막힘 최대 ${Math.round(lt)}ms)`, fc === `${wantFind}줄` && lt < 2000, fc);
      ok("찾기는 Go(FilterFind)", calls(be, "FilterFind").length > 0);
      await page.keyboard.press("Enter");
      await until(async () => (await page.$eval(".lv-find-count", (e) => e.textContent)).startsWith("1 / "), 4000);
      const selLine = await page.$eval(".lv-row.sel", (e) => e.dataset.line).catch(() => null);
      ok("Enter → 첫 찾은 줄(37) 선택", selLine === "37", selLine);
      const red = await page.$$eval(`.lv-row[data-line="37"] span[style*="color: ${rgb("#ff6b6b")}"]`, (els) => els.map((e) => e.textContent));
      ok("로그 색: ERROR 를 오류 색으로(편집기와 같은 칠)", red.includes("ERROR"), { red, row37: await page.$eval('.lv-row[data-line="37"]', (e) => e.innerHTML).catch(() => null) });
      await page.keyboard.press("Escape");
      // session
      await sleep(700);
      const saved = (JSON.parse(be.st.session).tabs.find((t) => t.path === P("a.log")) || {}).lines;
      ok("세션: on·read·big·칩 저장", saved && saved.on && saved.read && saved.big && saved.ex.length === 1, saved);
      ok("🧠 표시줄: 앱·화면·편집 0/768MB", /^🧠 앱\(Go\) .+ · 화면 .+ · 편집 0\/768MB$/.test(await memText(page)), await memText(page));
      await page.dispatchEvent(".st-mem", "mousedown");
      await page.waitForSelector(".mem-pop");
      const memRows = (await page.$$eval(".mem-pop tr", (els) => els.map((e) => [e.dataset.mode, e.textContent]))).filter((r) => r[1].startsWith("a.log"));
      ok("🧠 누르면 탭별: a.log 📖 읽기 · 편집 —", memRows.length === 1 && memRows[0][0] === "read" && memRows[0][1].includes("📖 읽기") && memRows[0][1].endsWith("—"), memRows);
      await shot(page, "readview-1.png");
      await page.dispatchEvent(".st-mem", "mousedown");
      await ctx.close();
    }

    // =============== 2. ✏️: C (question) → W (pieces, cancel) → E; E→📖 frees; L keeps; D asks ==========
    if (want("2")) {
      console.log("2. ✏️ 편집으로 열기: 확인 창(C) · 여는 중(W) 막힘·취소 · E · 📖 로 돌아가기 · D 저장/버리기/취소");
      const be = makeBackend();
      // 100MB 이상은 읽기 전용(user 10-28 밤) — ✏️ 는 100MB 미만 📖 탭(예산을 넘어 📖 로 연 파일)에서
      be.st.sizes[P("a.log")] = 60 * MB;
      be.st.sizes[P("b.log")] = 60 * MB;
      const R = (id, p) => tab(id, p, { lines: { on: true, read: true, big: true, above: 0, below: 3, off: [], ex: [] } });
      be.st.session = session([R("t1", P("a.log")), R("t2", P("b.log"))], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      page_ = page;
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await waitDone(page);
      // C
      await page.click(".lv-edit");
      await page.waitForSelector('.choice-ask[data-kind="edit"]');
      const txt = await page.$eval(".choice-ask", (e) => e.textContent);
      ok("확인 창: 시간·응답 없음·메모리·768MB(지금 0)·저장·읽기 권함", /약 6초/.test(txt) && txt.includes("응답하지 않") && txt.includes("GB") && txt.includes("768.0MB") && txt.includes("지금 0B") && txt.includes("저장도 오래") && txt.includes("📖 읽기 보기"), txt);
      // C owns the keys: Ctrl+S / Ctrl+W do nothing, the tab does not change
      await page.keyboard.press("Control+s");
      await page.keyboard.press("Control+w");
      await sleep(200);
      ok("C: 단축키(저장·탭 닫기) 막힘", (await page.$$(".tabs-scroll .tab")).length === 2 && !(await flashText()).includes("저장할 것"), await flashText());
      await page.keyboard.press("Escape");
      await sleep(200);
      ok("C: 취소(Esc) → 그대로 R", (await page.$(".choice-ask")) === null && JSON.stringify(await tabStates(page)) === '["R"]' && calls(be, "EditOpenBegin").length === 0);
      // C → W (pieces held back so W lasts)
      be.delay.EditOpenChunk = 400;
      await page.click(".lv-edit");
      await page.waitForSelector('.choice-ask [data-choice="edit"]');
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      ok("확인 → W: 「⏳ 편집용으로 여는 중 N%」 + 취소", (await page.$eval(".rv-wait .empty-title", (e) => e.textContent)).startsWith("⏳ 편집용으로 여는 중") && (await page.$(".rv-cancel")) !== null);
      const segDis = await page.$$eval(".lines-seg.big button", (els) => els.map((e) => e.disabled));
      ok("W: 이 탭 보기 전환 막힘(📖·🏷·✏️ 꺼짐)", JSON.stringify(segDis) === "[true,true,true]" && JSON.stringify(await tabStates(page)) === '["W"]', segDis);
      ok("🧠 편집: W 는 시작부터 셈(60/768MB)", (await until(async () => (await memText(page)).includes("편집 60/768MB"), 3000)) === true, await memText(page));
      // the other tab's ✏️ is blocked (and says why)
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      const why2 = await page.$eval(".lv-edit", (e) => [e.disabled, e.title]);
      ok("W 중 다른 탭 ✏️ 꺼짐 「앞 파일(…)을 편집용으로 여는 중 N%」", why2[0] === true && /앞 파일\(a\.log\)을 편집용으로 여는 중 \(\d+%\)/.test(why2[1]), why2);
      const typed0 = await stall(page, async () => {
        await page.focus(".lv-scroll");
        await page.keyboard.press("PageDown");
      });
      ok(`W 중에도 다른 탭은 쓸 수 있음(막힘 최대 ${Math.round(typed0)}ms)`, typed0 < 2000);
      await page.click(".tabs-scroll .tab:nth-child(1)");
      await page.click(".rv-cancel");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      ok("W 취소 → R, 작업 정리(EditOpenEnd)", JSON.stringify(await tabStates(page)) === '["R"]' && calls(be, "EditOpenEnd").length >= 1);
      ok("W 취소 → 예산 풀림(편집 0)", (await until(async () => (await memText(page)).includes("편집 0/768MB"), 3000)) === true, await memText(page));
      // W → E for real
      be.delay.EditOpenChunk = 0;
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      ok("W 끝 → ✏️ 편집(E): 편집기에 파일 전체", JSON.stringify(await tabStates(page)) === '["E"]' && (await page.$eval(".cm-content", (e) => e.textContent.includes("line 1"))), await tabStates(page));
      ok("🧠 편집 = 읽어 들인 크기", /편집 0\/768MB/.test(await memText(page)) === false || lines.join("\n").length < MB, await memText(page));
      // E → 🏷 (text kept) → ✏️ at once (no question)
      await seg(page, 2);
      await page.waitForSelector('.lines-view[data-mode="lines"]');
      const asks0 = calls(be, "EditOpenBegin").length;
      await seg(page, 3);
      await page.waitForSelector(".cm-editor");
      ok("E → 🏷 → ✏️: 확인 창 없이 바로(글자 그대로)", (await page.$(".choice-ask")) === null && calls(be, "EditOpenBegin").length === asks0);
      // D
      await page.click(".cm-content");
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" EDITED");
      await until(async () => JSON.stringify(await tabStates(page)) === '["D"]', 3000);
      ok("글자 입력 → D", JSON.stringify(await tabStates(page)) === '["D"]', await tabStates(page));
      await seg(page, 1);
      await page.waitForSelector('.choice-ask[data-kind="dirty"]');
      ok("D → 📖: 「저장 / 버리기 / 취소」", JSON.stringify(await page.$$eval(".choice-ask button", (els) => els.map((e) => e.dataset.choice))) === '["save","discard","cancel"]');
      await page.click('.choice-ask [data-choice="cancel"]');
      await sleep(200);
      ok("취소 → D 그대로(고친 글자 남음)", JSON.stringify(await tabStates(page)) === '["D"]' && (await page.$eval(".cm-content", (e) => e.textContent.includes("EDITED"))));
      // tab close of D: the same question
      await page.click(".tabs-scroll .tab:nth-child(1) .tab-close").catch(() => {});
      const closeAsk = await page.waitForSelector('.choice-ask[data-kind="dirty"]', { timeout: 3000 }).catch(() => null);
      ok("D 탭 닫기 → 「저장 / 버리기 / 취소」", closeAsk !== null);
      if (closeAsk) await page.click('.choice-ask [data-choice="cancel"]');
      await sleep(150);
      ok("탭 닫기 취소 → 탭 남음", (await page.$$(".tabs-scroll .tab")).length === 2);
      // 저장 then 📖
      await seg(page, 1);
      await page.click('.choice-ask [data-choice="save"]');
      await page.waitForSelector('.lines-view[data-mode="all"]');
      const sv = calls(be, "SaveFile");
      ok("저장 → SaveFile 한 번(고친 글자) → R", sv.length === 1 && sv[0].args[1].endsWith(" EDITED") && JSON.stringify(await tabStates(page)) === '["R"]', sv.length);
      ok("E→📖: 예산 풀림(편집 0)", (await until(async () => (await memText(page)).includes("편집 0/768MB"), 3000)) === true, await memText(page));
      // 버리기
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      await page.click(".cm-content");
      await page.keyboard.type("Z");
      await until(async () => JSON.stringify(await tabStates(page)) === '["D"]', 3000);
      await seg(page, 1);
      await page.click('.choice-ask [data-choice="discard"]');
      await page.waitForSelector('.lines-view[data-mode="all"]');
      ok("버리기 → R, 저장 안 함", calls(be, "SaveFile").length === 1 && JSON.stringify(await tabStates(page)) === '["R"]');
      ok("버리기 → 예산 풀림(편집 0)", (await until(async () => (await memText(page)).includes("편집 0/768MB"), 1500)) === true, await memText(page));
      await shot(page, "readview-2.png");
      // W then tab close: asks (confirm), stops the read, closes
      be.delay.EditOpenChunk = 400;
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".rv-wait");
      const d0 = page.__dialogs.length;
      const ends0 = calls(be, "EditOpenEnd").length;
      await page.keyboard.press("Control+w");
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 1, 4000);
      ok("W 탭 닫기 → 묻고(여는 것 버림) 닫힘", page.__dialogs.slice(d0).some((d) => d.includes("편집용으로 여는 중")) && (await page.$$(".tabs-scroll .tab")).length === 1, page.__dialogs.slice(d0));
      await until(() => calls(be, "EditOpenEnd").length > ends0, 4000);
      ok("닫힌 W 의 읽기 정리(EditOpenEnd)", calls(be, "EditOpenEnd").length > ends0);
      be.delay.EditOpenChunk = 0;
      await ctx.close();
    }

    // =============== 3. session: R/L as they were, a big ✏️ tab back to ✏️ (budget) — six 📖 panes =========
    if (want("3")) {
      console.log("3. 세션 복원 · 6칸 동시 📖 · 경계(100MB 바로 아래/위)");
      const be = makeBackend();
      const names = ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log"];
      for (const n of names) be.st.sizes[P(n)] = 300 * MB;
      be.st.sizes[P("a.log")] = 60 * MB; // the ✏️ tab: under 100MB (100MB+ comes back 📖 — fixr1-e2e A)
      const E = tab("tE", P("a.log"), { lines: { on: false, read: false, big: true, above: 0, below: 3, off: [], ex: [] } });
      const tabsS = [E, ...names.slice(1).map((n, k) => tab("t" + k, P(n), { lines: { on: true, read: k % 2 === 0, big: true, above: 0, below: 3, off: [], ex: k === 0 ? [{ pattern: "noise", kind: "text", caseSensitive: false, on: true }] : [] } }))];
      be.st.session = session(tabsS, "tE", {
        multi: { on: true, count: 6, slots: tabsS.map((t) => ({ tabId: t.id, mode: "read", server: "" })), bundle: null },
      });
      const { ctx, page } = await openPage(browser, url, be);
      page_ = page;
      await until(async () => (await page.$$(".lines-view")).length >= 5, 10000);
      await until(async () => (await page.$$eval(".lines-view", (els) => els.every((e) => e.dataset.state === "done"))), 15000);
      const modes = await page.$$eval(".lines-view", (els) => els.map((e) => e.dataset.mode));
      ok("복원: R·L 은 그대로 바로(묻지 않음)", JSON.stringify(modes.sort()) === JSON.stringify(["all", "all", "all", "lines", "lines"].sort()) && page.__dialogs.length === 0, modes);
      const cnt = await page.$$eval('.lines-view[data-mode="all"]', (els) => els.map((e) => e.dataset.count));
      ok("📖 칸: 모든 줄(칩 있는 칸은 숨김 반영)", cnt.includes(String(400 - NOISE)) && cnt.filter((x) => x === "400").length === 2, cnt);
      // the E tab (big, budget allows) comes back ✏️ through W
      await page.click('.mpane[data-slot="0"] .mpane-body');
      await until(async () => (await page.$('.mpane[data-slot="0"] .cm-editor')) !== null, 15000);
      ok("복원: 편집(E)이던 큰 탭 → 예산 안 → 다시 ✏️ (조각 읽기)", (await page.$('.mpane[data-slot="0"] .cm-editor')) !== null && calls(be, "EditOpenBegin").length === 1, calls(be, "EditOpenBegin").length);
      // six panes at once: chips and finds in each, the window keeps answering
      const lt = await stall(page, async () => {
        for (let i = 1; i < 6; i++) {
          const sc = `.mpane[data-slot="${i}"]`;
          if (!(await page.$(sc + ' .lines-view[data-mode="all"]'))) continue;
          await page.click(sc + " .lv-ex-plus");
          await page.fill(sc + " .lv-ex-in", "line 1");
          await page.keyboard.press("Enter");
        }
        await until(async () => (await page.$$eval('.lines-view[data-mode="all"]', (els) => els.every((e) => e.dataset.state === "done"))), 8000);
      });
      ok(`6칸: 칸마다 제외 추가 동시 — 막힘 최대 ${Math.round(lt)}ms`, lt < 2000, lt);
      await ctx.close();
      // 100MB boundary: just under = the editor as before, at = 📖
      const be2 = makeBackend();
      be2.st.sizes[P("under.log")] = 100 * MB - 1;
      be2.st.sizes[P("edge.log")] = 100 * MB;
      be2.st.openFiles = [P("under.log")];
      const r2 = await openPage(browser, url, be2);
      page_ = r2.page;
      await r2.page.keyboard.press("Control+o");
      await r2.page.waitForSelector(".cm-editor", { timeout: 8000 }).catch(() => {});
      ok("100MB − 1바이트 → 지금처럼 편집기", (await r2.page.$(".cm-editor")) !== null && (await r2.page.$(".lines-seg.big")) === null);
      be2.st.openFiles = [P("edge.log")];
      await r2.page.keyboard.press("Control+o");
      await r2.page.waitForSelector('.lines-view[data-mode="all"]', { timeout: 8000 }).catch(() => {});
      ok("정확히 100MB → 📖 읽기", (await mode(r2.page)) === "all");
      await r2.ctx.close();
    }

    // =============== 4. S (saving): other ✏️ blocked, tab close waits for the end ========================
    if (want("4")) {
      console.log("4. 저장 중(S): 다른 탭 ✏️ 막힘 · 탭 닫기는 끝난 뒤");
      const be = makeBackend();
      be.st.sizes[P("a.log")] = 60 * MB; // under 100MB: 100MB+ is read-only
      be.st.sizes[P("b.log")] = 60 * MB;
      const R = (id, p) => tab(id, p, { lines: { on: true, read: true, big: true, above: 0, below: 3, off: [], ex: [] } });
      be.st.session = session([R("t1", P("a.log")), R("t2", P("b.log"))], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      page_ = page;
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await page.click(".lv-edit");
      await page.click('.choice-ask [data-choice="edit"]');
      await page.waitForSelector(".cm-editor", { timeout: 15000 });
      await page.click(".cm-content");
      await page.keyboard.type("Q");
      be.delay.SaveFile = 1500;
      await page.keyboard.press("Control+s");
      await until(async () => JSON.stringify(await tabStates(page)) === '["S"]', 2000);
      ok("저장 중 → S, 이 탭 전환 막힘", JSON.stringify(await tabStates(page)) === '["S"]' && (await page.$$eval(".lines-seg.big button", (els) => els.every((e) => e.disabled))));
      await page.click(".cm-content");
      await page.keyboard.type("NOPE");
      ok("S: 글자 입력 막힘(편집기 읽기 전용)", !(await page.$eval(".cm-content", (e) => e.textContent.includes("NOPE"))));
      await page.click(".tabs-scroll .tab:nth-child(2)");
      await page.waitForSelector('.lines-view[data-mode="all"]');
      const w = await page.$eval(".lv-edit", (e) => [e.disabled, e.title]);
      ok("S 중 다른 탭 ✏️ 꺼짐(저장하는 중)", w[0] === true && w[1].includes("저장하는 중"), w);
      await page.click(".tabs-scroll .tab:nth-child(1)");
      await page.keyboard.press("Control+w");
      await sleep(200);
      ok("S 중 탭 닫기 → 아직 남음 + 안내", (await page.$$(".tabs-scroll .tab")).length === 2 && (await flashText()).includes("저장 중"), await flashText());
      await until(async () => (await page.$$(".tabs-scroll .tab")).length === 1, 5000);
      ok("저장 끝 → 닫힘", (await page.$$(".tabs-scroll .tab")).length === 1 && calls(be, "SaveFile").length === 1);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  console.log(`\nreadview-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
