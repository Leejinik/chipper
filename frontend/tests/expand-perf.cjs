// Performance of 「⋯ N줄 생략」 펼치기·접기 in 「🏷 줄만」: synthetic 300MB logs with
// 159,999-line gaps — [▲ 위로 20줄], [▼ 아래로 20줄], [전부 펼치기], scrolling in
// the opened stretch, folding, the same in six panes at once, and changing chips /
// context / tags with 60 opened stretches. Time = click → the pane's rows all on
// screen; with the window's longest stall (longtask / a 50ms timer's lateness).
// Bar (user 10-28): 3s, goal 0.3s. The real engine (Go helper, as lines-e2e).
//   cd frontend && npm run build && node tests/expand-perf.cjs
//   PERF_MB=300 PERF_DIR=<folder> PERF_OUT=<json> SHOTS=<folder>
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


// ---- synthetic 300MB logs with known gaps (kept between runs) -----------------------
// Line i (1-based): "BIGMARK" when i % 160000 === 80000 (gaps of 159,999 lines
// between them with no context), "SMALLMARK" when i % 5000 === 2500 (gaps of
// ~5,000 lines: 50+ gaps for the many-stretches case).
function makeLog(file, bytes, seed) {
  if (fs.existsSync(file) && fs.statSync(file).size >= bytes) return;
  const fd = fs.openSync(file, "w");
  let n = 0;
  let i = 0;
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x);
  while (n < bytes) {
    const parts = [];
    for (let k = 0; k < 20000; k++) {
      i++;
      const r = rnd() % 100;
      const ts = `2026-10-15 13:${String((i >> 12) % 60).padStart(2, "0")}:${String((i >> 6) % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}`;
      let line;
      if (r < 15) line = `${ts} ERROR [pool-${i % 13}] LizSystemDatabaseMonitorService.run : Cannot parse the query result (id=${i})`;
      else if (r < 25) line = `${ts} INFO  [nio-${i % 7}] AbstractMonitorForTCP.operationComplete : connection timed out 10.0.${i % 255}.${(i >> 8) % 255}:502`;
      else if (r < 28) line = `${ts} WARN  [main] commonConnection retry ${i % 5} of 5`;
      else line = `${ts} DEBUG [worker-${i % 31}] collector polled device ${i % 9973} point ${i % 211} value=${rnd() % 100000}`;
      if (i % 160000 === 80000) line += " BIGMARK";
      if (i % 5000 === 2500) line += " SMALLMARK";
      parts.push(line);
    }
    const s = parts.join("\n") + "\n";
    fs.writeSync(fd, s);
    n += Buffer.byteLength(s);
  }
  fs.closeSync(fd);
}

const tagsJSON = (rules) =>
  JSON.stringify({ version: 1, tags: [{ name: "common", rules, updated: "" }], assign: { dir: {}, file: {}, name: {} }, defaults: 2 });
const R = (id, pattern, o = {}) => ({ id, on: true, label: pattern, pattern, kind: "text", caseSensitive: true, color: "#61afef", line: false, filter: true, ...o });
const gapSel = (scope, n) => `${scope} .lv-row.lv-gap:has(.lv-text:text-is("⋯ ${n.toLocaleString("en-US")}줄 생략"))`;

async function main() {
  const dir = process.env.PERF_DIR || path.join(os.tmpdir(), "chipper-expand-perf");
  fs.mkdirSync(dir, { recursive: true });
  const SIZE = (+process.env.PERF_MB || 300) << 20;
  const files = [1, 2, 3, 4, 5, 6].map((k) => path.join(dir, `collector${k}.log`));
  const tg = Date.now();
  files.forEach((f, k) => makeLog(f, SIZE, 7 + k));
  console.log(`파일 준비 ${((Date.now() - tg) / 1000).toFixed(1)}초: ${files.map((f) => (fs.statSync(f).size / (1 << 20)).toFixed(0) + "MB").join(", ")}`);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
  const res = [];
  const rec = (what, ms, lt, extra = "") => {
    res.push({ what, ms: Math.round(ms), lt: Math.round(lt), extra });
    console.log(`  ${what}: ${Math.round(ms)}ms · 창 막힘 최대 ${Math.round(lt)}ms ${extra}`);
  };
  const LIMIT = 3000; // the user's bar (goal 300ms)
  const bad = [];
  const probe = async (page) =>
    page.evaluate(() => {
      window.__lt = 0;
      window.__ltObs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt = Math.max(window.__lt, e.duration);
      });
      window.__ltObs.observe({ entryTypes: ["longtask"] });
      window.__late = 0;
      let t = performance.now();
      setInterval(() => {
        const now = performance.now();
        window.__late = Math.max(window.__late, now - t - 50);
        t = now;
      }, 50);
    });
  // settled: the pane's rows on screen are all there (no 「…」 waiting row), and cond holds
  const settled = (page, scope, cond) =>
    page.evaluate(
      ([scope, cond]) => {
        const v = document.querySelector(scope + " .lines-view");
        if (!v || v.dataset.holding || v.querySelector(".lv-wait")) return false;
        return new Function("v", "return (" + cond + ")")(v);
      },
      [scope, cond]
    );
  const timeIt = async (page, scopes, act, cond, what, ms = 60000) => {
    await page.evaluate(() => ((window.__lt = 0), (window.__late = 0)));
    const t0 = Date.now();
    await act();
    const okk = await until(async () => {
      for (const s of scopes) if (!(await settled(page, s, cond))) return false;
      return true;
    }, ms, 5);
    const d = Date.now() - t0;
    const L = await page.evaluate(() => Math.max(window.__lt, window.__late));
    rec(what, d, L, okk ? "" : "(조건 못 맞춤)");
    if (!okk || d > LIMIT) bad.push(what);
    return d;
  };
  try {
    // ===== 1. one pane: a 159,999-line gap — ▲ 20, ▼ 20, all, scroll in it, fold =====
    if (want("1")) {
      const be = makeBackend();
      be.st.tags = tagsJSON([R("b", "BIGMARK")]);
      be.st.session = session([tab("t1", files[0], { lines: { on: true, read: false, big: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 1400, height: 900 });
      await probe(page);
      await page.waitForSelector(".lines-view");
      await until(async () => (await page.$eval(".lines-view", (e) => e.dataset.state)) === "done", 120000, 50);
      const st = await page.$eval(".lv-stat", (e) => e.textContent);
      console.log("  줄만: " + st);
      const S = "";
      const gap = gapSel(S, 159999);
      ok("16만 줄 생략 행 있음(⋯ 159,999줄 생략)", !!(await page.$(gap)));
      await timeIt(page, [S], () => page.click(gap + ' .lv-open-btn[data-open="up"]'), `!!v.querySelector('.lv-fold') && !!v.querySelector('.lv-row.lv-open')`, "▲ 위로 20줄 (16만 줄 생략)");
      await timeIt(page, [S], () => page.click(gapSel(S, 159979) + ' .lv-open-btn[data-open="down"]'), `v.querySelectorAll('.lv-fold').length >= 2`, "▼ 아래로 20줄");
      await timeIt(page, [S], () => page.click(gapSel(S, 159959) + ' .lv-open-btn[data-open="all"]'), `!v.querySelector('.lv-gap .lv-text') || ![...v.querySelectorAll('.lv-gap .lv-text')].some(e => e.textContent === '⋯ 159,959줄 생략')`, "[전부 펼치기] 15만 9,959줄");
      const cnt = +(await page.$eval(".lines-view", (e) => e.dataset.count));
      console.log(`  행 수: ${cnt.toLocaleString("en-US")}`);
      // scroll into the middle of the opened stretch (lines read from the nearest region start)
      // (settled = the rows drawn are those of the new scroll position, all fetched)
      const scrollTo = (f) =>
        page.$eval(
          ".lv-scroll",
          (e, f) => {
            e.scrollTop = e.scrollHeight * f;
            window.__exp = Math.floor(e.scrollTop / parseFloat(e.querySelector(".lv-row").style.height));
          },
          f
        );
      const atExp = `Math.min(...[...v.querySelectorAll('.lv-row[data-row]')].map(e => +e.dataset.row)) >= window.__exp - 2 && v.querySelectorAll('.lv-row.lv-open').length > 10`;
      await timeIt(page, [S], () => scrollTo(0.5), atExp, "펼친 구간 한가운데(8만 줄째)로 스크롤");
      await timeIt(page, [S], () => scrollTo(0.83), atExp, "펼친 구간 다른 곳(13만 줄째)으로 스크롤");
      await timeIt(page, [S], () => scrollTo(0.2), atExp, "펼친 구간 앞쪽(3만 줄째)으로 스크롤");
      // fold from inside the run (← on an opened line: the place is kept by line)
      await page.click(".lv-row.lv-open .lv-text");
      await timeIt(page, [S], () => page.keyboard.press("ArrowLeft"), `[...v.querySelectorAll('.lv-gap .lv-text')].some(e => e.textContent === '⋯ 159,999줄 생략')`, "접기 (펼친 줄에서 ←)");
      // ▼ then fold from the 「▾ 접기」 row
      await page.click(gapSel(S, 159999) + ' .lv-open-btn[data-open="all"]');
      await until(() => settled(page, S, `!!v.querySelector('.lv-fold')`), 10000, 5);
      await page.$eval(".lv-scroll", (e) => (e.scrollTop = 0));
      await sleep(700);
      await timeIt(page, [S], () => page.click(".lv-fold .lv-fold-btn"), `!v.querySelector('.lv-fold')`, "접기 (▾ 접기 누름)");
      await shot(page, "expand-perf-1.png");
      await ctx.close();
    }

    // ===== 2. six panes at once: ▲ / 전부 / fold in all six =====
    if (want("2")) {
      const be = makeBackend();
      be.st.tags = tagsJSON([R("b", "BIGMARK")]);
      be.st.session = session([], "", { multi: { on: true, count: 6, slots: Array.from({ length: 6 }, () => ({ tabId: "", mode: "lines", server: "" })), bundle: null } });
      be.st.openFiles = files;
      const { ctx, page } = await openPage(browser, url, be, { width: 1600, height: 1000 });
      await probe(page);
      await page.click('.mpane[data-slot="0"] .empty-actions button:has-text("파일 열기")');
      await until(() => page.$$eval(".lines-view", (els) => els.length === 6 && els.every((e) => e.dataset.state === "done")), 180000, 50);
      // every pane in 🏷 (a 300MB file opens in 📖)
      for (let i = 0; i < 6; i++) await page.click(`.mpane[data-slot="${i}"] .lines-seg button:nth-child(2)`);
      await until(() => page.$$eval('.lines-view[data-mode="lines"]', (els) => els.length === 6 && els.every((e) => e.dataset.state === "done")), 180000, 50);
      const scopes = [0, 1, 2, 3, 4, 5].map((i) => `.mpane[data-slot="${i}"]`);
      const has = await Promise.all(scopes.map((s) => page.$(gapSel(s, 159996))));
      ok("6칸 모두 16만 줄 생략 행", has.every(Boolean), await page.$$eval(".lines-view", (els) => els.map((e) => [e.dataset.mode, e.dataset.state, e.dataset.count, [...e.querySelectorAll(".lv-gap .lv-text")].map((x) => x.textContent).slice(0, 3)])));
      await shot(page, "expand-perf-6-before.png");
      await timeIt(
        page,
        scopes,
        async () => {
          for (const s of scopes) await page.click(gapSel(s, 159996) + ' .lv-open-btn[data-open="up"]');
        },
        `!!v.querySelector('.lv-fold')`,
        "6칸 ▲ 위로 20줄 (연달아 누름 → 6칸 다 그림)"
      );
      await sleep(700);
      // (a pane is ~20 rows high: the rest of the gap went below — fold, then 전부 on the whole gap)
      const fold6 = (what) =>
        timeIt(
          page,
          scopes,
          async () => {
            for (const s of scopes) await page.click(s + " .lv-fold .lv-fold-btn");
          },
          `!v.querySelector('.lv-fold')`,
          what
        );
      await fold6("6칸 접기 (▲ 20줄)");
      await timeIt(
        page,
        scopes,
        async () => {
          for (const s of scopes) await page.click(gapSel(s, 159996) + ' .lv-open-btn[data-open="all"]');
        },
        `!!v.querySelector('.lv-fold') && v.querySelectorAll('.lv-row.lv-open').length > 5`,
        "6칸 [전부 펼치기] (15만 9,996줄씩 · 새 탭 아래 3)"
      );
      await shot(page, "expand-perf-6.png");
      await sleep(700);
      await fold6("6칸 접기 (전부)");
      await ctx.close();
    }

    // ===== 3. 50+ opened stretches: changing chips / tags stays quick =====
    if (want("3")) {
      const open = [];
      // ▲ 20 on 60 gaps of ~5,000 lines (SMALLMARK every 5,000 lines)
      for (let k = 1; k <= 60; k++) open.push([k * 5000 - 2500 + 1, k * 5000 - 2500 + 20, k]);
      const be = makeBackend();
      be.st.tags = tagsJSON([R("s", "SMALLMARK"), R("b", "BIGMARK")]);
      be.st.session = session([tab("t1", files[0], { lines: { on: true, read: false, big: true, above: 1, below: 1, off: [], open } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 1400, height: 900 });
      await probe(page);
      await page.waitForSelector(".lines-view");
      await until(async () => (await page.$eval(".lines-view", (e) => e.dataset.state)) === "done", 120000, 50);
      await until(() => settled(page, "", "true"), 10000);
      const folds = await page.$$eval(".lv-fold", (e) => e.length);
      ok("세션에서 펼친 구간 60개로 열림(화면의 접기 줄 ≥ 1)", folds >= 1, folds);
      // a chip (new scan, cached afterwards) and back, with the 60 stretches
      const chip = async (on) => {
        if (on) {
          await page.click(".lv-ex-plus");
          await page.fill(".lv-ex-in", "commonConnection");
          await page.keyboard.press("Enter");
        } else await page.click(".lv-chip-t");
      };
      await timeIt(page, [""], () => chip(true), `v.dataset.state === 'done' && /제외/.test(v.querySelector('.lv-stat').textContent)`, "펼친 구간 60개 + 제외 칩 추가(다시 훑음)");
      await timeIt(page, [""], () => chip(false), `v.dataset.state === 'done' && !/제외/.test(v.querySelector('.lv-stat').textContent)`, "펼친 구간 60개 + 칩 끄기(캐시)");
      await timeIt(page, [""], () => page.click(".lv-chip-t"), `v.dataset.state === 'done' && /제외/.test(v.querySelector('.lv-stat').textContent)`, "펼친 구간 60개 + 칩 다시 켜기(캐시)");
      await timeIt(
        page,
        [""],
        () => page.fill(".lv-ctx:nth-of-type(1) input", "3"),
        `v.dataset.state === 'done'`,
        "펼친 구간 60개 + 위 3 (다시 배치)"
      );
      // (the only tag off = no rule: nothing scanned, nothing to time) — off, then on again timed
      await page.click('.lv-tag:has-text("common") input');
      await sleep(300);
      await timeIt(page, [""], () => page.click('.lv-tag:has-text("common") input'), `v.dataset.state === 'done' && !!v.querySelector('.lv-row[data-line]')`, "펼친 구간 60개 + 태그 껐다 다시 켜기(다시 훑음)");
      // end of the result: the byte marks inherited from the layout before
      await page.focus(".lv-scroll");
      await timeIt(page, [""], () => page.keyboard.press("End"), `v.querySelectorAll('.lv-row[data-line]').length > 5`, "펼친 구간 60개 + End");
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  const out = process.env.PERF_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(`\nexpand-perf: 3초 넘음 ${bad.length}건${bad.length ? " — " + bad.join(", ") : ""} · 확인 실패 ${fails.length}건`);
  if (bad.length || fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
