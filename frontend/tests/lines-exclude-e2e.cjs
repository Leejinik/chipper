// Headless test of 「🚫 제외」 chips in 「🏷 태그 줄만」 (LinesView), copied set-up of lines-e2e.cjs:
// Headless test of 「🏷 태그 줄만」 (LinesView) against the built frontend
// (frontend/dist) and the REAL line filter: the Filter* bindings go to a Go
// helper (go test -run TestFilterE2EServer, linefilter_e2e_test.go) that calls
// App.FilterStart/Rows/… on the real engine and relays its progress events.
// The other bindings (session, tags, files) are faked on the Node side, like
// tags-e2e.cjs. Data files are real files in a temp folder (the engine reads them).
//
//   cd frontend && npm run build && node tests/lines-exclude-e2e.cjs   (ONLY=A,B,C)
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
const TALL = { width: 1400, height: 2000 }; // the whole 60-line result on screen (rows are virtual)
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lines-ex-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const timings = {};
  try {
    // 60 lines: abc / def hits, some with commonConnection (excluded), one
    // excluded line right above a kept hit (shown as its context)
    const lines = [];
    for (let i = 1; i <= 60; i++) {
      if (i === 21) lines.push(`${i} abc commonConnection keepalive`); // excluded; context (above 1) of 22
      else if (i === 22) lines.push(`${i} abc data`);
      else if (i % 7 === 0) lines.push(`${i} abc commonConnection keepalive`);
      else if (i % 9 === 0) lines.push(`${i} def CommonConnection upper`);
      else if (i % 10 === 3) lines.push(`${i} def payload`);
      else lines.push(`${i} plain`);
    }
    fs.writeFileSync(P("ex.log"), lines.join("\n"));
    const hitRe = /abc|def/;
    const isHit = (ex) => (l) => hitRe.test(l) && !ex.some((f) => f(l));
    const cc = (l) => l.includes("commonConnection"); // case-sensitive chip
    const cci = (l) => l.toLowerCase().includes("commonconnection");
    const tags = tagsJSON([R("a", "abc"), R("d", "def")]);

    // =============== A. chips: add · counts · rows · context · on/off · remove ===============
    if (want("A")) {
      console.log("A. 제외 칩: 추가 · 걸린 줄·제외 수 · 행 · 위아래 줄 · 끄고 켜기 · 지우기");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("ex.log"), { lines: { on: true, above: 1, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      ok("머리에 「🚫 제외:」 줄 + [+ 추가]", (await page.textContent(".lv-ex .lv-ex-title")).includes("🚫 제외") && !!(await page.$(".lv-ex .lv-ex-plus")));
      let w = refRows(lines, isHit([]), 1, 1);
      ok("처음: 제외 없음 = abc/def 걸린 줄", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      ok("첫 요청에 exclude 없음(빈 칩)", !(lastStart(be).args[0].exclude || []).length, lastStart(be).args[0]);
      const st0 = await stat(page);
      ok("상태에 (제외 …) 없음 (칩이 없으면)", !/제외/.test(st0), st0);
      const hits0 = lines.filter(isHit([])).length;

      const n0 = calls(be, "FilterStart").length;
      const t0 = Date.now();
      await addChip(page, "commonConnection", { cs: true });
      w = refRows(lines, isHit([cc]), 1, 1);
      const gotA = await waitRows(page, w);
      timings.addChip = Date.now() - t0;
      ok("칩 추가 → 다시 거름 · 행 = 참조(제외 반영)", JSON.stringify(gotA) === JSON.stringify(w), { gotA, w });
      ok("칩 하나 생김(켜짐, Aa)", eq(await chips(page), [{ t: "commonConnection Aa", on: true, bad: false }]), await chips(page));
      const s1 = lastStart(be).args[0];
      ok("요청에 exclude = [commonConnection, 대소문자 구분, 글자 그대로]", calls(be, "FilterStart").length === n0 + 1 && eq(s1.exclude, [{ kind: "text", pattern: "commonConnection", caseSensitive: true, on: true }]), s1.exclude);
      ok("요청의 걸러 규칙은 그대로", eq(s1.rules.map((r) => r.pattern), ["abc", "def"]));
      await waitDone(page);
      const nEx = lines.filter((l) => hitRe.test(l) && cc(l)).length;
      const nHit = lines.filter(isHit([cc])).length;
      const s = await stat(page);
      ok(`상태 「걸린 줄 ${nHit} (제외 ${nEx})」`, s.startsWith(`걸린 줄 ${nHit} (제외 ${nEx}) ·`), s);
      const title = await page.$eval(".lv-stat", (e) => e.getAttribute("title"));
      const abcLeft = lines.filter((l) => /abc/.test(l) && !cc(l)).length;
      ok("풍선: 규칙별 수는 남은 줄 기준 + 제외로 뺀 줄", title.includes(`abc: ${abcLeft}줄`) && title.includes(`제외로 뺀 걸린 줄: ${nEx}줄`), title);
      // context: line 21 is excluded but shown (above 1) for the hit on 22; line 14 (excluded) brings no 13/15
      const shown = await shownRows(page);
      ok("뺀 줄도 다른 걸린 줄의 위·아래 줄로는 남음 (21 → 22 의 위 줄)", shown.includes(`21:${lines[20]}`) && !(await page.$('.lv-row.lv-hit[data-line="21"]')));
      ok("뺀 걸린 줄 때문에 붙던 위·아래 줄은 사라짐 (49 와 그 위아래 48·50)", !shown.includes(`48:${lines[47]}`) && !shown.includes(`50:${lines[49]}`) && !shown.includes(`49:${lines[48]}`), shown);
      await shotSmall(page, "lines-exclude-1.png");

      // off (cached scan without it), on again (cached), remove
      let t1 = Date.now();
      await page.click(".lv-chip-t");
      w = refRows(lines, isHit([]), 1, 1);
      ok("칩 누르기 → 꺼짐(흐림) · 제외 안 함", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w) && eq(await chips(page), [{ t: "commonConnection Aa", on: false, bad: false }]));
      timings.chipOff = Date.now() - t1;
      ok("끈 요청 = exclude 없음", !(lastStart(be).args[0].exclude || []).length);
      ok("끈 결과는 앞서 훑은 작업(캐시) 그대로", lastStart(be).result && lastStart(be).result.cached === true, lastStart(be).result);
      await waitDone(page);
      ok("끄면 상태에 (제외 …) 없음", !/제외/.test(await stat(page)) && (await stat(page)).startsWith(`걸린 줄 ${hits0} ·`), await stat(page));
      t1 = Date.now();
      await page.click(".lv-chip-t");
      w = refRows(lines, isHit([cc]), 1, 1);
      ok("다시 누르기 → 켜짐 · 제외", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w));
      timings.chipOn = Date.now() - t1;
      ok("다시 켠 결과도 캐시", lastStart(be).result && lastStart(be).result.cached === true);
      // a second chip, ignoring case, then remove the first
      await addChip(page, "commonconnection");
      w = refRows(lines, isHit([cc, cci]), 1, 1);
      ok("칩 둘 (대소문자 무시) → 둘 중 하나라도 들면 뺌", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      ok("추가 칸은 열린 채 비워짐(연달아 넣기)", (await page.inputValue(".lv-ex-in")) === "");
      await page.press(".lv-ex-in", "Escape");
      ok("Esc → 추가 칸 닫힘", !(await page.$(".lv-ex-in")) && !!(await page.$(".lv-ex-plus")));
      await addChip(page, "commonConnection", { cs: true });
      ok("같은 칩을 또 넣으면 쌍둥이 없음", (await chips(page)).length === 2);
      await page.press(".lv-ex-in", "Escape");
      await page.click('.lv-chip[data-ex="1"] .lv-chip-x');
      w = refRows(lines, isHit([cc]), 1, 1);
      ok("× → 그 칩만 지움", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w) && eq(await chips(page), [{ t: "commonConnection Aa", on: true, bad: false }]));
      // N change keeps the chips (no new scan)
      const nStart = calls(be, "FilterStart").length;
      await setCtx(page, 0, 2);
      w = refRows(lines, isHit([cc]), 0, 2);
      ok("위·아래 바꿔도 제외 그대로 · 다시 안 훑음", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w) && calls(be, "FilterStart").length === nStart);
      // session
      await sleep(700);
      const saved = JSON.parse(be.st.session).tabs[0].lines;
      ok("세션에 칩 저장(탭마다)", eq(saved.ex, [{ pattern: "commonConnection", kind: "text", caseSensitive: true, on: true }]), saved);
      await page.click(".lv-chip-t"); // off
      await sleep(700);
      ok("끈 칩도 꺼진 채 저장", JSON.parse(be.st.session).tabs[0].lines.ex[0].on === false);
      await page.click(".lv-chip-t"); // on again
      await sleep(700);
      // find: an excluded line is found only where it shows as context
      await page.focus(".lv-scroll");
      await page.keyboard.press("Control+f");
      await page.waitForSelector(".lv-find");
      await page.fill(".lv-find-input", "commonConnection");
      await page.check(".lv-find-opt:nth-of-type(1) input");
      const fc = await until(async () => {
        const t = await page.textContent(".lv-find-count");
        return /줄/.test(t) && t;
      }, 5000);
      const rowsNow = refRows(lines, isHit([cc]), 0, 2).filter((r) => /^\d+:/.test(r) && r.includes("commonConnection")).length;
      ok(`찾기 = 제외 반영된 결과 안에서 (${rowsNow}줄, 위·아래 줄로 남은 것만)`, fc === `${rowsNow}줄`, fc);
      await ctx.close();

      // reopen with the saved session: chips back, filtered with them
      const be2 = makeBackend();
      be2.st.tags = tags;
      be2.st.session = be.st.session;
      const o2 = await openPage(browser, url, be2, TALL);
      await o2.page.waitForSelector(".lines-view");
      await waitDone(o2.page);
      ok("다시 켜면 칩 복원", eq(await chips(o2.page), [{ t: "commonConnection Aa", on: true, bad: false }]), await chips(o2.page));
      ok("… 첫 요청부터 제외", eq((lastStart(be2).args[0].exclude || []).map((r) => r.pattern), ["commonConnection"]));
      w = refRows(lines, isHit([cc]), 0, 2);
      ok("… 행도 제외 반영", JSON.stringify(await waitRows(o2.page, w)) === JSON.stringify(w));
      await o2.ctx.close();
    }

    // =============== B. old session (no ex) · unusable chip · kinds ===========================
    if (want("B")) {
      console.log("B. 옛 세션 · 쓸 수 없는 칩 · 단어/정규식");
      const be = makeBackend();
      be.st.tags = tags;
      // v1.3.0 wrote lines without ex
      be.st.session = session([tab("t1", P("ex.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      ok("옛 세션(ex 없음) → 칩 없음 · 그대로 거름", (await chips(page)).length === 0 && JSON.stringify(await shownRows(page)) === JSON.stringify(refRows(lines, isHit([]), 0, 0)));
      await page.click(".lv-ex-plus");
      await page.fill(".lv-ex-in", "(?<=abc )commonConnection");
      await page.selectOption(".lv-ex-kind", "regex");
      const why = await until(() => page.$eval(".lv-ex-why", (e) => e.textContent).catch(() => ""), 2000);
      ok("뒤돌아보기 정규식 → 「쓸 수 없음」 + [추가] 꺼짐 (태그 규칙과 같은 사유)", /쓸 수 없음/.test(why) && (await page.$eval(".lv-ex-add .lv-btn", (b) => b.disabled)), why);
      await page.selectOption(".lv-ex-kind", "text");
      ok("글자 그대로로 바꾸면 그 글자 그대로 넣을 수 있음", !(await page.$(".lv-ex-why")) && !(await page.$eval(".lv-ex-add .lv-btn", (b) => b.disabled)));
      await page.fill(".lv-ex-in", "keep");
      await page.selectOption(".lv-ex-kind", "word");
      await page.press(".lv-ex-in", "Enter");
      // 「keep」 as a word: "keepalive" is not the word keep → nothing excluded
      await until(async () => (await chips(page)).length === 1);
      await waitDone(page);
      ok("단어 「keep」 → keepalive 는 안 뺌", JSON.stringify(await waitRows(page, refRows(lines, isHit([]), 0, 0))) === JSON.stringify(refRows(lines, isHit([]), 0, 0)) && /\(제외 0\)/.test(await stat(page)), await stat(page));
      await page.fill(".lv-ex-in", "^\\d*[05] ");
      await page.selectOption(".lv-ex-kind", "regex");
      await page.press(".lv-ex-in", "Enter");
      const re5 = (l) => /^\d*[05] /.test(l);
      const w = refRows(lines, isHit([re5]), 0, 0);
      ok("정규식 칩 → 5·0 으로 끝나는 줄 번호의 걸린 줄을 뺌", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      ok("칩 글자: 단어 ‹›, 정규식 //", eq((await chips(page)).map((c) => c.t), ["‹keep›", "/^\\d*[05] /"]), await chips(page));
      await ctx.close();

      // a chip RE2 cannot run arrives from a session: the engine leaves it out and says so
      const be3 = makeBackend();
      be3.st.tags = tags;
      be3.st.session = session(
        [tab("t1", P("ex.log"), { lines: { on: true, above: 0, below: 0, off: [], ex: [{ pattern: "(?<=abc )commonConnection", kind: "regex", caseSensitive: true, on: true }, { pattern: "payload", kind: "text", caseSensitive: false, on: true }] } })],
        "t1"
      );
      const o3 = await openPage(browser, url, be3, TALL);
      await o3.page.waitForSelector(".lines-view");
      await waitDone(o3.page);
      const c3 = await chips(o3.page);
      ok("쓸 수 없는 칩은 노란 표시, 다른 칩은 그대로 씀", c3[0].bad && !c3[1].bad, c3);
      const nt = await notes(o3.page);
      ok("안내: 「제외에 쓸 수 없는 칩 1개(빼고 거름)」 + 사유", nt.some((t) => /제외에 쓸 수 없는 칩 1개\(빼고 거름\)/.test(t) && /뒤돌아보기/.test(t)), nt);
      const w3 = refRows(lines, isHit([(l) => /payload/i.test(l)]), 0, 0);
      ok("… payload 칩만으로 거름", JSON.stringify(await waitRows(o3.page, w3)) === JSON.stringify(w3));
      await shotSmall(o3.page, "lines-exclude-2.png");
      await o3.ctx.close();
    }

    // =============== C. keep the place · big file · toggle response ===========================
    if (want("C")) {
      console.log("C. 큰 파일: 칩 켜고 끌 때 보던 자리 유지 · 응답 시간");
      const big = [];
      for (let i = 1; i <= 200000; i++) {
        if (i % 3 === 0) big.push(`2026-10-28 10:00:00 INFO abc commonConnection keepalive ${i}`);
        else if (i % 5 === 0) big.push(`2026-10-28 10:00:00 WARN def request ${i}`);
        else big.push(`2026-10-28 10:00:00 INFO plain ${i}`);
      }
      fs.writeFileSync(P("big.log"), big.join("\n"));
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("big.log"), { lines: { on: true, above: 0, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      // go to the middle: line ~100,000
      const row = await goPost("FilterRowOfLine", [lastStart(be).result.jobId, 0, 1, 100000]).catch(() => -1);
      await page.evaluate((r) => {
        const sc = document.querySelector(".lv-scroll");
        const h = parseFloat(getComputedStyle(document.querySelector(".lv-row")).height);
        sc.scrollTop = r * h;
      }, row);
      await sleep(400);
      const before = await until(() => topLine(page), 3000);
      ok("가운데로 감 (줄 ~100,000)", before > 99000 && before < 101000, before);
      let t0 = Date.now();
      await addChip(page, "commonConnection", { cs: true });
      await until(async () => (await viewData(page)).state === "done" && /제외/.test(await stat(page)), 8000);
      const after = await until(async () => {
        const l = await topLine(page);
        return l > 1 && l;
      }, 5000);
      timings.bigAdd = Date.now() - t0;
      ok(`칩 추가 뒤에도 보던 자리 근처 (${before} → ${after})`, after >= before - 5 && after <= before + 10, { before, after });
      ok("… 그 근처 행이 제외 반영 (3의 배수 줄은 걸린 줄 아님)", !(await page.$$eval(".lv-row.lv-hit[data-line]", (els) => els.some((e) => +e.dataset.line % 3 === 0))));
      t0 = Date.now();
      await page.press(".lv-ex-in", "Escape");
      await page.click(".lv-chip-t");
      await until(async () => (await viewData(page)).state === "done" && !/제외/.test(await stat(page)), 8000);
      const back = await until(async () => {
        const l = await topLine(page);
        return l > 1 && l;
      }, 5000);
      timings.bigOff = Date.now() - t0;
      ok(`칩 끄기 뒤에도 자리 유지 (${after} → ${back})`, back >= after - 5 && back <= after + 10, { after, back });
      ok("… 끈 결과는 캐시", lastStart(be).result.cached === true);
      t0 = Date.now();
      await page.click(".lv-chip-t");
      await until(async () => (await viewData(page)).state === "done" && /제외/.test(await stat(page)), 8000);
      const again = await until(async () => {
        const l = await topLine(page);
        return l > 1 && l;
      }, 5000);
      timings.bigOn = Date.now() - t0;
      ok(`다시 켜도 자리 유지 (${back} → ${again})`, again >= back - 5 && again <= back + 10, { back, again });
      // again and again (both scans cached now): never a jump (10-28: once seen at the last row)
      let cur = again;
      const jumps = [];
      for (let k = 0; k < 8; k++) {
        await page.click(".lv-chip-t");
        const exOn = k % 2 === 1;
        await until(async () => (await viewData(page)).state === "done" && /제외/.test(await stat(page)) === exOn, 8000);
        await sleep(150);
        const l = await until(async () => {
          const x = await topLine(page);
          return x > 1 && x;
        }, 5000);
        if (!(l >= cur - 5 && l <= cur + 10)) jumps.push([cur, l]);
        cur = l;
      }
      ok("켜고 끄기 8번 더 (캐시) — 자리 튐 없음", jumps.length === 0 && cur > 99000 && cur < 101000, { jumps, cur });
      const s = await stat(page);
      const nEx = big.filter((l) => /abc|def/.test(l) && l.includes("commonConnection")).length;
      ok(`20만 줄: 상태 (제외 ${nEx.toLocaleString("en-US")})`, s.includes(`(제외 ${nEx.toLocaleString("en-US")})`), s);
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
  console.log(`\nlines-exclude-e2e: ${pass} passed, ${fails.length} failed`);
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
