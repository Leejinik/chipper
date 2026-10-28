// Headless test of 「⋯ N줄 생략」 펼치기·접기 in 「🏷 태그 줄만」 (LinesView), set-up copied from lines-exclude-e2e.cjs:
// Headless test of 「🏷 태그 줄만」 (LinesView) against the built frontend
// (frontend/dist) and the REAL line filter: the Filter* bindings go to a Go
// helper (go test -run TestFilterE2EServer, linefilter_e2e_test.go) that calls
// App.FilterStart/Rows/… on the real engine and relays its progress events.
// The other bindings (session, tags, files) are faked on the Node side, like
// tags-e2e.cjs. Data files are real files in a temp folder (the engine reads them).
//
//   cd frontend && npm run build && node tests/lines-expand-e2e.cjs   (ONLY=A,B,C,D)
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
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules", "FilterFind"]);
  // delay[name] = ms: hold that call before it goes out (late answers, races)
  const delay = {};
  return {
    st,
    delay,
    call: async (name, args) => {
      const c = { name, args, t: Date.now() };
      st.calls.push(c);
      if (delay[name]) await sleep(delay[name]);
      if (FILTER.has(name)) return (c.result = await goPost(name, args)); // results kept (StartResult.cached)
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

const tagsJSON = (rules) =>
  JSON.stringify({ version: 1, tags: [{ name: "common", rules, updated: "" }], assign: { dir: {}, file: {}, name: {} }, defaults: 2 });
const R = (id, pattern, o = {}) => ({ id, on: true, label: pattern, pattern, kind: "text", caseSensitive: true, color: "#61afef", line: false, filter: true, ...o });
const chips = (page) =>
  page.$$eval(".lv-ex .lv-chip", (els) => els.map((e) => ({ t: e.querySelector(".lv-chip-t").textContent, on: !e.classList.contains("off"), bad: e.classList.contains("bad") })));
const stat = (page) => page.$eval(".lv-stat", (e) => e.textContent);
const lastStart = (be) => calls(be, "FilterStart").slice(-1)[0];
async function addChip(page, text, o = {}) {
  if (!(await page.$(".lv-ex-in"))) await page.click(".lv-ex-plus");
  await page.fill(".lv-ex-in", text);
  await page.setChecked(".lv-ex-cs input", !!o.cs); // the box keeps its state between adds
  if (o.kind) await page.selectOption(".lv-ex-kind", o.kind);
  await page.press(".lv-ex-in", "Enter");
}
// the file line at the top of the list
const topLine = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".lv-scroll");
    const top = sc.getBoundingClientRect().top;
    const rows = [...document.querySelectorAll(".lv-row[data-line]")].filter((e) => e.getBoundingClientRect().bottom > top + 2);
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows.length ? +rows[0].dataset.line : 0;
  });

async function shotSmall(page, name) {
  if (!SHOTS) return;
  await page.setViewportSize({ width: 1000, height: 600 });
  await sleep(300);
  await shot(page, name);
  await page.setViewportSize(TALL);
  await sleep(200);
}

// ---- 「⋯ 생략」 펼치기 -------------------------------------------------------------------------
// rows on screen with the fold rows ("▾ 접기 · 펼친 N줄") and the opened lines marked "o"
const shownX = (page, scope = "") =>
  page.$$eval(scope + " .lines-view .lv-row[data-row]", (els) =>
    els
      .map((e) => ({
        row: +e.dataset.row,
        line: +(e.dataset.line || 0),
        text: (e.querySelector(".lv-text") || e.querySelector(".lv-fold-btn")).textContent,
        open: e.classList.contains("lv-open"),
      }))
      .sort((a, b) => a.row - b.row)
      .map((r) => (r.line ? `${r.line}${r.open ? "o" : ""}:${r.text}` : r.text))
  );
// what the view must show: grep -B A -A B, plus the opened stretches ([lo, hi] file lines)
function refOpen(lines, isHit, A, B, open = []) {
  const n = lines.length;
  const show = new Array(n + 2).fill(0); // 1 = hit block, 2 = opened only
  for (let i = 1; i <= n; i++) if (isHit(lines[i - 1])) for (let k = Math.max(1, i - A); k <= Math.min(n, i + B); k++) show[k] = 1;
  for (const [lo, hi] of open) for (let k = Math.max(1, lo); k <= Math.min(n, hi); k++) if (!show[k]) show[k] = 2;
  const out = [];
  let gap = 0;
  for (let x = 1; x <= n; x++) {
    if (!show[x]) {
      gap++;
      continue;
    }
    if (gap) out.push(`⋯ ${gap.toLocaleString("en-US")}줄 생략`);
    gap = 0;
    if (show[x] === 2 && show[x - 1] !== 2) {
      let k = x;
      while (k <= n && show[k] === 2) k++;
      out.push(`▾ 접기 · 펼친 ${(k - x).toLocaleString("en-US")}줄`);
    }
    out.push(`${x}${show[x] === 2 ? "o" : ""}:${lines[x - 1]}`);
  }
  if (gap) out.push(`⋯ ${gap.toLocaleString("en-US")}줄 생략`);
  return out;
}
// The rows on screen are the reference's rows from where the view starts
// (keeping the place after a change may scroll a row or two): the same rows
// in order, to the end of the reference or filling the screen. On a match the
// reference itself is returned (callers compare with it), else what is shown.
const fitsRef = (got, want) => {
  if (!got.length) return !want.length;
  const k = want.indexOf(got[0]);
  if (k < 0 || k > 3) return false;
  return JSON.stringify(want.slice(k, k + got.length)) === JSON.stringify(got) && (k + got.length === want.length || got.length >= 60);
};
async function waitX(page, want, scope = "", ms = 8000) {
  let got;
  const hit = await until(async () => {
    got = await shownX(page, scope);
    return fitsRef(got, want);
  }, ms);
  return hit ? want : got;
}
// the gap row whose text is `⋯ N줄 생략`
const gapRow = (n) => `.lv-row.lv-gap:has(.lv-text:text-is("⋯ ${n.toLocaleString("en-US")}줄 생략"))`;
const foldRow = (from) => `.lv-row.lv-fold[data-from="${from}"]`;
const savedOpen = (be) => {
  try {
    return JSON.parse(be.st.session).tabs[0].lines.open;
  } catch {
    return "?";
  }
};
const scrollTop = (page) => page.$eval(".lv-scroll", (e) => e.scrollTop);
const lastRows = (be) => calls(be, "FilterRows").slice(-1)[0];

const TALL = { width: 1400, height: 2400 }; // ~100 rows on screen (rows are virtual)
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lines-expand-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const timings = {};
  try {
    // 600 lines: abc on 10 and 100, def on 590; "needle" on 20 (opened later) and 300 (never)
    const lines = [];
    for (let i = 1; i <= 600; i++) {
      if (i === 10 || i === 100) lines.push(`${i} abc hit`);
      else if (i === 590) lines.push(`${i} def hit`);
      else if (i === 20 || i === 300) lines.push(`${i} needle here`);
      else lines.push(`${i} plain ${i % 3 ? "INFO" : "WARN"}`);
    }
    fs.writeFileSync(P("base.log"), lines.join("\n"));
    const isHit = (l) => /abc|def/.test(l);
    const tags = tagsJSON([R("a", "abc"), R("d", "def"), R("w", "WARN", { filter: false, color: "#e5c07b" })]);

    // =============== A. buttons · ▲ · ▼ · one group folds · double-click · keys · session ===============
    if (want("A")) {
      console.log("A. 생략 줄 버튼 · ▲/▼ · 묶음 접기 · 두 번 누르기 · 키 · 세션");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("base.log"), { lines: { on: true, above: 1, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      let w = refOpen(lines, isHit, 1, 1);
      ok("처음: 펼친 곳 없음 = 걸린 줄·위아래 줄", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      const btns = await page.$$eval(".lv-row.lv-gap", (els) => els.map((e) => [...e.querySelectorAll(".lv-open-btn")].map((b) => b.textContent)));
      ok(
        "생략 줄 버튼: 큰 구간 [▲ 위로 20줄][전부 펼치기][▼ 아래로 20줄], 20줄 이하는 [전부 펼치기]만",
        eq(btns[0], ["전부 펼치기"]) && eq(btns[1], ["▲ 위로 20줄", "전부 펼치기", "▼ 아래로 20줄"]),
        btns
      );
      const starts0 = calls(be, "FilterStart").length;
      const top0 = await scrollTop(page);

      // ▲: lines 12..31 under the block above, the gap keeps 32..98
      let t0 = Date.now();
      await page.click(gapRow(87) + ' .lv-open-btn[data-open="up"]');
      w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok("▲ 위로 20줄 → 위쪽 끝(12)부터 20줄 + 「▾ 접기」 줄, 남은 생략 67줄", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      timings.up = Date.now() - t0;
      ok("파일을 다시 훑지 않음(FilterStart 그대로)", calls(be, "FilterStart").length === starts0);
      ok("요청 마지막 인자 = 펼친 구간 [12,31]", eq(lastRows(be).args[5], [12, 31]), lastRows(be).args);
      ok("보던 자리 그대로(스크롤 안 움직임)", (await scrollTop(page)) === top0);
      ok("펼친 줄 표시(lv-open)·걸린 줄과 구분", !!(await page.$('.lv-row.lv-open[data-line="12"]')) && !(await page.$('.lv-row.lv-open[data-line="10"]')));
      const bg = await page.$eval('.lv-row.lv-open[data-line="12"]', (e) => getComputedStyle(e).backgroundImage);
      ok("펼친 줄 옅은 배경", /gradient/.test(bg), bg);
      // log colours still on opened lines (WARN on 15, colour rule)
      const warnSpan = await page.$eval('.lv-row[data-line="15"] .lv-text', (e) => [...e.querySelectorAll("span")].map((s) => [s.textContent, getComputedStyle(s).color]));
      ok("펼친 줄에도 로그 색(WARN)", warnSpan.some(([t, c]) => t === "WARN" && c === rgb("#e5c07b")), warnSpan);
      await shot(page, "expand-up.png");

      // ▼: lines 79..98 above the next block, the gap keeps 32..78
      t0 = Date.now();
      await page.click(gapRow(67) + ' .lv-open-btn[data-open="down"]');
      w = refOpen(lines, isHit, 1, 1, [[12, 31], [79, 98]]);
      ok("▼ 아래로 20줄 → 아래쪽 끝(98)에서 20줄, 남은 생략 47줄", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      timings.down = Date.now() - t0;
      await sleep(700); // autosave
      ok("세션에 펼친 곳 저장 (줄 번호 · 같은 묶음)", eq(savedOpen(be), [[12, 31, 0], [79, 98, 0]]), savedOpen(be));
      await shot(page, "expand-up-down.png");

      // 「▾ 접기」 on the ▼ piece folds the ▲ piece too (one group)
      t0 = Date.now();
      await page.click(foldRow(79) + " .lv-fold-btn");
      w = refOpen(lines, isHit, 1, 1);
      ok("▼ 조각의 「▾ 접기」 → 같은 생략 줄에서 펼친 ▲ 조각까지 한꺼번에 접힘", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      timings.fold = Date.now() - t0;
      await sleep(700);
      ok("세션: 접으면 펼친 곳 없음", (savedOpen(be) || []).length === 0, savedOpen(be));

      // double-click: 87 lines ≤ 2,000 → all
      await page.dblclick(gapRow(87) + " .lv-text");
      w = refOpen(lines, isHit, 1, 1, [[12, 98]]);
      ok("생략 줄 두 번 누르기(2,000줄 이하) → 전부 펼침 (전체 보기로 안 감)", JSON.stringify(await waitX(page, w)) === JSON.stringify(w) && !(await page.$(".cm-editor")), await shownX(page));
      // double-click on ▲ = one ▲ (the 2nd click lands on the fold row: not 「접기」)
      await sleep(600); // (「접기」 right after opening is taken for that 2nd click)
      await page.click(foldRow(12) + " .lv-fold-btn");
      await waitX(page, refOpen(lines, isHit, 1, 1));
      await page.dblclick(gapRow(87) + ' .lv-open-btn[data-open="up"]');
      await sleep(400);
      w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok("▲ 를 두 번 눌러도 펼친 뒤 바로 접히지 않음", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      // ▲ again: the run above grows — its 「▾ 접기」 count too (the row above the change)
      await page.click(gapRow(67) + ' .lv-open-btn[data-open="up"]');
      w = refOpen(lines, isHit, 1, 1, [[12, 51]]);
      ok("▲ 한 번 더 → 같은 구간이 40줄로 · 위의 「▾ 접기 · 펼친 40줄」도 바뀜", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await sleep(600);
      await page.click(foldRow(12) + " .lv-fold-btn");
      await waitX(page, refOpen(lines, isHit, 1, 1));

      // keys: → / + open the selected gap row, ← / - fold (fold row, opened line, gap row)
      await page.click(gapRow(87) + " .lv-text");
      await page.keyboard.press("ArrowRight");
      w = refOpen(lines, isHit, 1, 1, [[12, 98]]);
      ok("생략 줄 고르고 → → 펼침", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      ok("→ 뒤 고른 줄 = 「▾ 접기」 줄(그 자리)", !!(await until(() => page.$(".lv-row.lv-fold.sel"), 2000)));
      await page.click('.lv-row[data-line="50"] .lv-text');
      await page.keyboard.press("ArrowLeft");
      w = refOpen(lines, isHit, 1, 1);
      ok("펼친 줄 고르고 ← → 접힘", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      ok("← 뒤 고른 줄 = 다시 생긴 생략 줄", !!(await until(() => page.$(gapRow(87) + ".sel"), 2000)));
      await page.keyboard.press("+");
      w = refOpen(lines, isHit, 1, 1, [[12, 98]]);
      ok("+ → 펼침", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await page.keyboard.press("-");
      w = refOpen(lines, isHit, 1, 1);
      ok("- (접기 줄에서) → 접힘", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      // ← on a plain line does nothing; ↑↓ still move
      await page.click('.lv-row[data-line="10"] .lv-text');
      await page.keyboard.press("ArrowLeft");
      await sleep(300);
      ok("걸린 줄에서 ← 는 아무것도 안 함", JSON.stringify(await shownX(page)) === JSON.stringify(w));

      // the line number of an opened line / Enter still open the whole file there
      await page.click(gapRow(87) + ' .lv-open-btn[data-open="up"]');
      await waitX(page, refOpen(lines, isHit, 1, 1, [[12, 31]]));
      await page.click('.lv-row[data-line="15"] .lv-no');
      await until(async () => (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "15", 6000);
      ok("펼친 줄의 줄 번호 누르기 → 전체 보기 그 줄(15)", (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "15");
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok("줄만으로 돌아오면 펼친 곳 그대로", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await page.click(gapRow(67) + " .lv-text");
      await until(() => page.$(gapRow(67) + ".sel"), 2000);
      await page.focus(".lv-scroll");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".cm-editor", { timeout: 15000 }).catch(() => {});
      await until(async () => (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "32", 6000);
      ok("생략 줄 Enter → 전체 보기 그 자리(32)", (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "32");
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);

      // find: opened lines are searched, lines still left out are not
      await page.focus(".lv-scroll");
      await page.keyboard.press("Control+f");
      await page.waitForSelector(".lv-find input");
      await page.fill(".lv-find input", "needle");
      const fs1 = await until(async () => {
        const t = await page.$eval(".lv-find", (e) => e.textContent).catch(() => "");
        return /1줄/.test(t) && t;
      }, 5000);
      ok("찾기: 펼친 줄(20)은 찾고 생략된 줄(300)은 안 찾음 → 1줄", !!fs1, await page.$eval(".lv-find", (e) => e.textContent).catch(() => ""));
      await page.click(gapRow(487) + ' .lv-open-btn[data-open="all"]');
      const fs2 = await until(async () => {
        const t = await page.$eval(".lv-find", (e) => e.textContent).catch(() => "");
        return /2줄/.test(t) && t;
      }, 5000);
      ok("다른 생략 줄을 펼치면 찾기 다시 → 2줄(300 포함)", !!fs2, await page.$eval(".lv-find", (e) => e.textContent).catch(() => ""));
      await page.keyboard.press("Escape");
      await sleep(600);
      await page.click(foldRow(102) + " .lv-fold-btn");
      w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok("(뒤 단계 준비) 그 구간 접기", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));

      // copying: the fold row is not copied, opened lines are
      await page.click(foldRow(12), { position: { x: 4, y: 4 } });
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.up("Shift");
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await page.keyboard.press("Control+c");
      const clip = await until(() => page.evaluate(() => window.__clip), 2000);
      ok("복사: 「▾ 접기」 줄은 빼고 펼친 줄 글자만", clip === `${lines[11]}\n${lines[12]}`, clip);

      // chips change (new scan): the opened lines stay (file lines), merged with the new blocks
      await addChip(page, "100 abc");
      const isHit2 = (l) => isHit(l) && !l.includes("100 abc");
      w = refOpen(lines, isHit2, 1, 1, [[12, 31]]);
      ok("제외 칩 추가(다시 훑음) → 펼친 곳(줄 12–31) 그대로", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      ok("새 훑기 요청 뒤에도 펼친 구간 전달", eq(lastRows(be).args[5], [12, 31]), lastRows(be).args);
      await page.click(".lv-chip-x");
      w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok("칩 지우면 원래대로 + 펼친 곳 그대로", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      // context change: opened lines that the context now covers become context rows
      await setCtx(page, 3, 3);
      w = refOpen(lines, isHit, 3, 3, [[12, 31]]);
      ok("위·아래 3 → 펼친 줄 중 문맥이 된 줄(12·13)은 문맥 줄로 합쳐짐", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await ctx.close();
    }

    // =============== B. a gap of 4,986 lines: double-click 20+20 · all · the row cap ===============
    if (want("B")) {
      console.log("B. 큰 생략(4,986줄): 두 번 누르기 = 위·아래 20줄 · 전부 · 행 상한 안내");
      const big = [];
      for (let i = 1; i <= 5000; i++) big.push(i === 3 ? "3 abc first" : i === 4990 ? "4990 def last" : `${i} filler line`);
      fs.writeFileSync(P("big.log"), big.join("\n"));
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("big.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      let w = refOpen(big, isHit, 0, 0);
      ok("처음", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      const gt = await page.$eval(gapRow(4986), (e) => e.getAttribute("title"));
      ok("큰 생략 줄 풍선: 두 번 누르면 위·아래 20줄씩", /위·아래 20줄씩/.test(gt), gt);
      await page.dblclick(gapRow(4986) + " .lv-text");
      w = refOpen(big, isHit, 0, 0, [[4, 23], [4970, 4989]]);
      ok("두 번 누르기(2,000줄 넘음) → 위 20줄 + 아래 20줄", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await shot(page, "expand-big-dbl.png");
      const t0 = Date.now();
      await page.click(gapRow(4946) + ' .lv-open-btn[data-open="all"]');
      await until(async () => +(await viewData(page)).count === 4991, 8000);
      timings.allBig = Date.now() - t0;
      ok("[전부 펼치기] → 4,991행 (생략 없음)", +(await viewData(page)).count === 4991, await viewData(page));
      w = refOpen(big, isHit, 0, 0, [[4, 4989]]);
      ok("위쪽 화면 = 참조", JSON.stringify(await waitX(page, w.slice(0, 60))) !== "" && eq((await shownX(page)).slice(0, 60), w.slice(0, 60)), (await shownX(page)).slice(0, 8));
      await page.focus(".lv-scroll");
      await page.keyboard.press("End");
      const tail = await until(async () => {
        const s = await shownX(page);
        return s[s.length - 1] === w[w.length - 1] && s;
      }, 5000);
      ok("End → 끝 화면 = 참조(4990 걸린 줄·끝 생략)", !!tail && eq(tail, w.slice(w.length - tail.length)), (tail || (await shownX(page))).slice(-4));
      await sleep(700);
      ok("세션: 한 묶음 [4, 4989]", eq(savedOpen(be), [[4, 4989, 0]]), savedOpen(be));
      await ctx.close();

      // the 20만-row cap counts opened lines: a 60-row engine, the tab opened from the session
      await goGet("/reset?maxRows=60");
      const be2 = makeBackend();
      be2.st.tags = tags;
      be2.st.session = session([tab("t1", P("big.log"), { lines: { on: true, above: 0, below: 0, off: [], open: [[4, 4989, 0]] } })], "t1");
      const o2 = await openPage(browser, url, be2, TALL);
      await o2.page.waitForSelector(".lines-view");
      await waitDone(o2.page);
      const ns = await until(async () => {
        const x = await notes(o2.page);
        return x.some((y) => y.includes("펼친 줄")) && x;
      }, 6000);
      ok("세션에서 펼친 채로 열림 + 행 상한 안내가 펼친 줄을 셈", !!ns && ns.some((y) => /펼친 줄\)이 200,000행을 넘어/.test(y) && y.includes("접거나")), ns || (await notes(o2.page)));
      ok("행 수 = 60줄 + 생략·접기 행", +(await viewData(o2.page)).count === 62, await viewData(o2.page));
      await o2.ctx.close();
      await goGet("/reset");
    }

    // =============== C. .gz · CP949 · a growing log ===============
    if (want("C")) {
      console.log("C. .gz · CP949 · 덧붙는 로그");
      fs.writeFileSync(P("base.log.gz"), zlib.gzipSync(Buffer.from(lines.join("\n"))));
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("base.log.gz"), { lines: { on: true, above: 1, below: 1, off: [], open: [[12, 31, 0]] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      let w = refOpen(lines, isHit, 1, 1, [[12, 31]]);
      ok(".gz: 펼친 줄 글자 = 원문", JSON.stringify(await waitX(page, w)) === JSON.stringify(w), await shownX(page));
      await ctx.close();

      // CP949: Korean text in opened lines (bytes written by hand: 가 = B0A1, 나 = B3AA)
      const ko = [];
      const kb = [];
      for (let i = 1; i <= 120; i++) {
        const isH = i === 5 || i === 110;
        ko.push(isH ? `${i} abc 가나` : `${i} 가나`);
        kb.push(Buffer.concat([Buffer.from(isH ? `${i} abc ` : `${i} `), Buffer.from([0xb0, 0xa1, 0xb3, 0xaa])]));
      }
      fs.writeFileSync(P("ko.log"), Buffer.concat(kb.flatMap((b, k) => (k ? [Buffer.from("\n"), b] : [b]))));
      const be3 = makeBackend();
      be3.st.tags = tags;
      be3.st.session = session([tab("t1", P("ko.log"), { encoding: "cp949", lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const o3 = await openPage(browser, url, be3, TALL);
      await o3.page.waitForSelector(".lines-view");
      await waitDone(o3.page);
      await o3.page.click(gapRow(104) + ' .lv-open-btn[data-open="down"]');
      const kw = refOpen(ko, isHit, 0, 0, [[90, 109]]);
      ok("CP949: 펼친 줄 한글 = 원문", JSON.stringify(await waitX(o3.page, kw)) === JSON.stringify(kw), await shownX(o3.page));
      await o3.ctx.close();

      // a growing log, its end opened: the new lines come after (the opened stretch is file lines)
      const base = ["1 abc first", "2 plain", "3 plain", "4 plain", "5 plain"];
      fs.writeFileSync(P("tail.log"), base.join("\n") + "\n");
      const be4 = makeBackend();
      be4.st.tags = tags;
      be4.st.session = session([tab("t1", P("tail.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const o4 = await openPage(browser, url, be4, TALL);
      await o4.page.waitForSelector(".lines-view");
      await waitDone(o4.page);
      let all = [...base, ""];
      w = refOpen(all, isHit, 0, 0);
      ok("덧붙기 전", JSON.stringify(await waitX(o4.page, w)) === JSON.stringify(w), await shownX(o4.page));
      await o4.page.click(gapRow(5) + ' .lv-open-btn[data-open="all"]');
      w = refOpen(all, isHit, 0, 0, [[2, 6]]);
      ok("끝 생략 펼침", JSON.stringify(await waitX(o4.page, w)) === JSON.stringify(w), await shownX(o4.page));
      await sleep(50);
      fs.appendFileSync(P("tail.log"), "6 plain\n7 def new\n8 plain");
      all = [...base, "6 plain", "7 def new", "8 plain"];
      w = refOpen(all, isHit, 0, 0, [[2, 6]]);
      ok("덧붙은 뒤: 펼친 2–6 그대로, 새 걸린 줄 7, 끝 생략", JSON.stringify(await waitX(o4.page, w, "", 10000)) === JSON.stringify(w), await shownX(o4.page));
      ok("FilterStart 한 번(덧붙음만)", calls(be4, "FilterStart").length === 1);
      await o4.ctx.close();
    }

    // =============== D. 📖 읽기 보기: no gaps, no buttons (unchanged) ===============
    if (want("D")) {
      console.log("D. 📖 읽기 보기는 그대로");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("base.log"), { lines: { on: true, read: true, big: true, above: 0, below: 0, off: [], open: [[12, 31, 0]] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector('.lines-view[data-mode="all"]');
      await waitDone(page);
      ok("📖: 생략 줄·펼치기 단추·접기 줄 없음", !(await page.$(".lv-gap")) && !(await page.$(".lv-open-btn")) && !(await page.$(".lv-fold")));
      const r = calls(be, "FilterRows");
      ok("📖: 펼친 구간을 엔진에 안 보냄", r.length > 0 && r.every((c) => eq(c.args[5], [])), r.slice(-1)[0] && r.slice(-1)[0].args);
      ok("📖: 600줄 그대로", +(await viewData(page)).count === 600);
      await ctx.close();
    }
  } finally {
    console.log("시간(ms):", JSON.stringify(timings));
    await browser.close();
    srv.close();
    try {
      await fetch(`http://${goAddr}/quit`);
    } catch {}
    go.kill();
  }
  console.log(`\nlines-expand-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log("  FAIL " + f);
    process.exit(1);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
