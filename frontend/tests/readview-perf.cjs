// Performance of 「📖 읽기 보기」 (readview): six synthetic 300MB logs opened at
// once (no question), 📖↔🏷 in every pane, find, exclude (hide), End, and ✏️
// off (100MB+ is read-only) — times and the window's longest stall (longtask / a 50ms
// timer's lateness = how long input would wait). Acceptance (user 10-28): no
// stall over 2s while opening, switching, finding or excluding in 📖.
// The real engine (Go helper, as lines-e2e); the files stay in PERF_DIR.
//   cd frontend && npm run build && node tests/readview-perf.cjs
//   PERF_MB=300 PERF_DIR=<folder> PERF_OUT=<json>
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

// ---- synthetic 300MB logs (kept between runs) -------------------------------------
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
      if (i % 1000003 === 0) line += " rare-token-zq";
      parts.push(line);
    }
    const s = parts.join("\n") + "\n";
    fs.writeSync(fd, s);
    n += Buffer.byteLength(s);
  }
  fs.closeSync(fd);
}

async function main() {
  const dir = process.env.PERF_DIR || path.join(os.tmpdir(), "chipper-readview-perf");
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
  const LIMIT = 2000;
  const bad = [];
  try {
    const be = makeBackend();
    be.st.session = session([], "", { multi: { on: true, count: 6, slots: Array.from({ length: 6 }, () => ({ tabId: "", mode: "read", server: "" })), bundle: null } });
    be.st.openFiles = files;
    const { ctx, page } = await openPage(browser, url, be, { width: 1600, height: 1000 });
    await page.evaluate(() => {
      window.__lt = 0;
      window.__ltObs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt = Math.max(window.__lt, e.duration);
      });
      window.__ltObs.observe({ entryTypes: ["longtask"] });
      // a probe: how late a 50ms timer fires (input would wait as long)
      window.__late = 0;
      let t = performance.now();
      setInterval(() => {
        const now = performance.now();
        window.__late = Math.max(window.__late, now - t - 50);
        t = now;
      }, 50);
    });
    const reset = () => page.evaluate(() => ((window.__lt = 0), (window.__late = 0)));
    const lt = () => page.evaluate(() => Math.max(window.__lt, window.__late));
    const allDone = (sel = ".lines-view") => page.$$eval(sel, (els) => els.length === 6 && els.every((e) => e.dataset.state === "done"));
    // 1. six at once
    await reset();
    let t0 = Date.now();
    await page.click('.mpane[data-slot="0"] .empty-actions button:has-text("파일 열기")');
    await until(() => allDone('.lines-view[data-mode="all"]'), 120000, 20);
    await until(() => page.$$eval(".lines-view", (els) => els.every((e) => e.dataset.firstMs)), 5000);
    const firsts = await page.$$eval(".lines-view", (els) => els.map((e) => +e.dataset.firstMs));
    let L = await lt();
    rec("6개 동시 📖 열기(누름 → 6칸 끝)", Date.now() - t0, L, `칸별 첫 화면 ${Math.min(...firsts)}~${Math.max(...firsts)}ms`);
    if (L > LIMIT) bad.push("열기");
    const counts = await page.$$eval(".lines-view", (els) => els.map((e) => +e.dataset.count));
    console.log(`  줄 수: ${counts.map((n) => n.toLocaleString("en-US")).join(", ")}`);
    // memory
    const mem = async () => {
      const m = await goPost("MemInfo", []);
      const h = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
      return `Go ${(m.goWorkingSet / (1 << 20)).toFixed(0)}MB · JS 힙 ${(h / (1 << 20)).toFixed(0)}MB`;
    };
    console.log("  메모리(6칸 📖): " + (await mem()));
    res.push({ what: "메모리 6칸 📖", ms: 0, lt: 0, extra: await mem() });
    // 2. switch 📖 → 🏷 → 📖 in every pane
    for (const [to, label] of [[2, "🏷 줄만"], [1, "📖 읽기"]]) {
      await reset();
      t0 = Date.now();
      for (let i = 0; i < 6; i++) await page.click(`.mpane[data-slot="${i}"] .lines-seg button:nth-child(${to})`);
      await until(async () => (await page.$$eval(`.lines-view[data-mode="${to === 2 ? "lines" : "all"}"]`, (e) => e.length)) === 6 && (await allDone()), 120000, 20);
      L = await lt();
      rec(`6칸 → ${label} 전환`, Date.now() - t0, L);
      if (L > LIMIT) bad.push("전환 " + label);
    }
    // 3. find in each pane
    for (const q of ["Cannot parse", "rare-token-zq"]) {
      await reset();
      t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        await page.focus(`.mpane[data-slot="${i}"] .lv-scroll`);
        await page.keyboard.press("Control+f");
        await page.waitForSelector(`.mpane[data-slot="${i}"] .lv-find-input`);
        await page.fill(`.mpane[data-slot="${i}"] .lv-find-input`, q);
      }
      await until(async () => (await page.$$eval(".lv-find-count", (els) => els.length === 6 && els.every((e) => /^(\d[\d,]* \/ )?[\d,]+줄( \(|$)|^없음$/.test(e.textContent)))), 120000, 20);
      L = await lt();
      const fc = await page.$$eval(".lv-find-count", (els) => els.map((e) => e.textContent));
      rec(`6칸 찾기 「${q}」`, Date.now() - t0, L, fc[0]);
      if (L > LIMIT) bad.push("찾기 " + q);
      for (let i = 0; i < 6; i++) {
        await page.focus(`.mpane[data-slot="${i}"] .lv-find-input`);
        await page.keyboard.press("Escape");
      }
    }
    // 4. exclude (hide) in each pane
    await reset();
    t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      await page.click(`.mpane[data-slot="${i}"] .lv-ex-plus`);
      await page.fill(`.mpane[data-slot="${i}"] .lv-ex-in`, "Cannot parse");
      await page.keyboard.press("Enter");
    }
    await until(async () => (await page.$$eval(".lines-view", (els) => els.every((e) => e.dataset.state === "done" && /숨김/.test(e.querySelector(".lv-stat").textContent)))), 120000, 20);
    L = await lt();
    rec("6칸 제외 칩 「Cannot parse」(숨김)", Date.now() - t0, L, await page.$eval(".lv-stat", (e) => e.textContent));
    if (L > LIMIT) bad.push("제외");
    // chip off / on (cached)
    await reset();
    t0 = Date.now();
    for (let i = 0; i < 6; i++) await page.click(`.mpane[data-slot="${i}"] .lv-chip[data-ex="0"] .lv-chip-t`);
    await until(async () => (await page.$$eval(".lines-view", (els) => els.every((e) => e.dataset.state === "done" && !/숨김/.test(e.querySelector(".lv-stat").textContent)))), 60000, 20);
    L = await lt();
    rec("6칸 제외 끄기(캐시)", Date.now() - t0, L);
    // scroll: End, middle
    await reset();
    t0 = Date.now();
    await page.focus('.mpane[data-slot="0"] .lv-scroll');
    await page.keyboard.press("End");
    await until(async () => (await page.$$('.mpane[data-slot="0"] .lv-row[data-line]')).length > 5 && !(await page.$('.mpane[data-slot="0"] .lv-wait')), 10000, 20);
    L = await lt();
    rec("📖 End (마지막 줄로)", Date.now() - t0, L, await page.$eval('.mpane[data-slot="0"] .lv-row[data-line]:last-child', (e) => "줄 " + e.dataset.line).catch(() => ""));
    console.log("  메모리(작업 뒤): " + (await mem()));
    res.push({ what: "메모리 작업 뒤", ms: 0, lt: 0, extra: await mem() });
    // 5. 100MB 이상은 읽기 전용(user 10-28 밤): ✏️ 는 꺼진 채 이유 — 예전 「✏️ 300MB(조각) → 편집기」 측정은 없어짐
    await reset();
    const ed = await page.$eval('.mpane[data-slot="0"] .lv-edit', (b) => [b.disabled, b.title]);
    rec("✏️ 300MB → 읽기 전용(꺼짐)", 0, 0, ed[0] ? "꺼짐: " + ed[1] : "켜져 있음(틀림)");
    // the 📖 panes still answer
    await reset();
    t0 = Date.now();
    await page.focus('.mpane[data-slot="1"] .lv-scroll');
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await sleep(300);
    L = await lt();
    rec("📖 칸 PageDown", Date.now() - t0, L);
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  const out = process.env.PERF_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(`\nreadview-perf: 2초 넘게 막힘 ${bad.length}건${bad.length ? " — " + bad.join(", ") : ""}`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
