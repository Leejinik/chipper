// Headless test of what the real-log run (10-28, six 300MB collector logs on the
// test PC — realtest-progress.md) found in 「🏷 태그 줄만」 + 「🚫 제외」, against
// the built frontend and the REAL line filter (set-up copied from lines-exclude-e2e.cjs):
//   R1 the place is kept when a 「⋯ 생략」 row is on top (chips on/off)
//   R2 찾기 다음 after a chip change starts from the screen, not the first match
//   R3 the engine's word about a chip stays on that chip when an off chip before it is removed
//   R4 chip spaces kept + the full text in the tip
//   R5 a short pane keeps rows visible (chips and notes give way)
//   R6 six 300MB files at once: no 「전체 열기」 (the whole-file total)
//
//   cd frontend && npm run build && node tests/realtest-e2e.cjs   (ONLY=R1,R2…)
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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// (a click / chip is handled on the page's next turn: give it that before
// looking, or the old, already settled view is taken for the new one)
const settled = (page, scope = "") =>
  sleep(150).then(() => until(async () => {
    const d = await viewData(page, scope);
    const wait = await page.$$eval(scope + " .lv-row.lv-wait", (e) => e.length);
    return d.state === "done" && !d.holding && !wait;
  }, 15000));
// the row on top: its line, or the gap's range
const topRow = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".lv-scroll");
    const top = sc.getBoundingClientRect().top;
    const rows = [...document.querySelectorAll(".lv-row[data-row]")].filter((e) => e.getBoundingClientRect().bottom > top + 2);
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const r = rows[0];
    if (!r) return null;
    if (r.dataset.line) return { line: +r.dataset.line };
    const m = /줄 ([\d,]+)(?:–([\d,]+))?/.exec(r.title || "");
    const a = m ? +m[1].replace(/,/g, "") : 0;
    return { gap: [a, m && m[2] ? +m[2].replace(/,/g, "") : a] };
  });
const shows = (t, line) => !!t && (t.line ? Math.abs(t.line - line) <= 1 : t.gap[0] <= line && line <= t.gap[1]);
async function scrollToLine(page, be, line) {
  const job = lastStart(be).result.jobId;
  const row = await goPost("FilterRowOfLine", [job, 0, 0, line]);
  await page.evaluate((r) => {
    const sc = document.querySelector(".lv-scroll");
    const h = parseFloat(getComputedStyle(document.querySelector(".lv-row")).height);
    sc.scrollTop = r * h;
  }, row);
  await sleep(400);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    // 100,000 lines, all hits of 「abc」; 30,001–70,000 also hold 「zap」
    const lines = [];
    for (let i = 1; i <= 100000; i++) lines.push(i > 30000 && i <= 70000 ? `abc zap ${i}` : `abc ${i}`);
    fs.writeFileSync(P("gap.log"), lines.join("\n"));
    const tags = tagsJSON([R("a", "abc")]);
    const L0 = 50000;

    // =============== R1. a 「⋯ 생략」 row on top: the place stays (real logs: 28/54 lost) =========
    if (want("R1")) {
      console.log("R1. 맨 위가 「⋯ 생략」 행일 때 칩을 바꿔도 보던 줄");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("gap.log"), { lines: { on: true, above: 0, below: 0, off: [], ex: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 1200, height: 700 });
      await page.waitForSelector(".lines-view");
      await settled(page);
      await scrollToLine(page, be, L0);
      ok("가운데(줄 50,000)", shows(await topRow(page), L0), await topRow(page));
      await addChip(page, "zap");
      await settled(page);
      let t = await topRow(page);
      ok("「zap」 추가 → 맨 위 「⋯ 생략」 행이 50,000 을 덮음", !!t && !!t.gap && shows(t, L0), t);
      await addChip(page, "nothing-matches-this");
      await settled(page);
      t = await topRow(page);
      ok("아무 줄도 안 빼는 칩 하나 더(새로 훑음) → 그대로 그 생략 행", shows(t, L0), t);
      await page.press(".lv-ex-in", "Escape");
      await page.click(".lv-chip-t"); // zap off
      await settled(page);
      t = await topRow(page);
      ok("「zap」 끄기 → 다시 줄 50,000 (생략 행의 첫 줄 30,001 이 아님)", !!t && !!t.line && Math.abs(t.line - L0) <= 1, t);
      await page.click(".lv-chip-t"); // zap on
      await settled(page);
      await page.click(".lv-chip-t"); // off
      await settled(page);
      t = await topRow(page);
      ok("켜고 끄기 한 번 더 → 50,000", !!t && !!t.line && Math.abs(t.line - L0) <= 1, t);
      // the user scrolls (wheel): that is the new place
      const box = await page.$eval(".lv-scroll", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(box.x, box.y);
      for (let k = 0; k < 5; k++) {
        await page.mouse.wheel(0, 2000);
        await sleep(60);
      }
      await sleep(400);
      const here = (await topRow(page)).line;
      ok("휠로 옮김", here > L0 + 100, here);
      await page.click(".lv-chip-t"); // zap on (cached)
      await settled(page);
      t = await topRow(page);
      ok(`사용자가 옮긴 뒤(${here}) 칩 → 옮긴 곳 (옛 50,000 아님)`, shows(t, here), { here, t });
      await ctx.close();
    }

    // =============== R2. 찾기 다음 after a chip change: from the screen ================================
    if (want("R2")) {
      console.log("R2. 찾기 연 채 칩을 바꾼 뒤 Enter → 화면 근처 다음 결과");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("gap.log"), { lines: { on: true, above: 0, below: 0, off: [], ex: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 1200, height: 700 });
      await page.waitForSelector(".lines-view");
      await settled(page);
      await scrollToLine(page, be, 80000);
      await page.click(".lv-scroll", { position: { x: 600, y: 60 } });
      await page.keyboard.press("Control+F");
      await page.fill(".lv-find-input", "abc 8");
      await until(async () => /줄/.test(await page.textContent(".lv-find-count")), 8000);
      await addChip(page, "zap");
      await settled(page);
      await page.press(".lv-ex-in", "Escape");
      await until(async () => /줄/.test(await page.textContent(".lv-find-count")), 8000);
      const top = (await topRow(page)).line;
      await page.focus(".lv-find-input");
      await page.keyboard.press("Enter");
      await sleep(400);
      const sel = await page.$eval(".lv-row.sel[data-line]", (e) => +e.dataset.line).catch(() => 0);
      ok(`칩 바꾼 뒤 Enter → 화면(${top}) 아래 첫 「abc 8…」 (줄 8 같은 맨 앞이 아님)`, sel >= top && sel < top + 50 && /^abc 8/.test(lines[sel - 1]), { top, sel });
      await page.keyboard.press("Shift+Enter");
      await sleep(300);
      const prev = await page.$eval(".lv-row.sel[data-line]", (e) => +e.dataset.line).catch(() => 0);
      ok("Shift+Enter → 그 앞 결과 (화면 위쪽)", prev > 0 && prev < sel && /^abc 8/.test(lines[prev - 1]), { sel, prev });
      await ctx.close();
    }

    // =============== R3. the engine's word stays on its chip ======================================
    if (want("R3")) {
      console.log("R3. 꺼진 칩을 지워도 「쓸 수 없음」 안내는 그 칩에");
      fs.writeFileSync(P("small.log"), "abc 1\nabc yy 2\nabc 3\n");
      const be = makeBackend();
      be.st.tags = tags;
      const ex = [
        { pattern: "first-off", kind: "text", caseSensitive: false, on: false },
        { pattern: "(?<=x)y", kind: "regex", caseSensitive: false, on: true }, // RE2 cannot
        { pattern: "fine", kind: "text", caseSensitive: false, on: true },
      ];
      be.st.session = session([tab("t1", P("small.log"), { lines: { on: true, above: 0, below: 0, off: [], ex } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await settled(page);
      let c = await chips(page);
      ok("처음: 정규식 칩만 「쓸 수 없음」", c.length === 3 && !c[0].bad && c[1].bad && !c[2].bad, c);
      await page.click('.lv-chip[data-ex="0"] .lv-chip-x'); // remove the off chip: no new scan
      await sleep(400);
      c = await chips(page);
      ok("꺼진 첫 칩 지움 → 안내는 여전히 그 정규식 칩, 「fine」 은 멀쩡", c.length === 2 && c[0].bad && !c[1].bad, c);
      const n = (await notes(page)).join(" / ");
      ok("안내 문구가 그 칩 이름", n.includes("(?<=x)y"), n);
      await ctx.close();
    }

    // =============== R4. chip spaces + full text =====================================================
    if (want("R4")) {
      console.log("R4. 칩 공백 그대로 · 풍선에 원문");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("gap.log"), { lines: { on: true, above: 0, below: 0, off: [], ex: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 1200, height: 700 });
      await page.waitForSelector(".lines-view");
      await settled(page);
      await addChip(page, " zap ");
      await settled(page);
      const ws = await page.$eval(".lv-chip-t", (e) => [getComputedStyle(e).whiteSpace, e.getAttribute("title")]);
      ok("칩 글자 공백 보존(white-space: pre)", ws[0] === "pre", ws);
      ok("풍선 첫 줄에 원문 「 zap 」", ws[1].startsWith("「 zap 」"), ws[1]);
      await ctx.close();
    }

    // =============== R5. a short pane keeps rows ======================================================
    if (want("R5")) {
      console.log("R5. 낮은 칸: 칩 줄이 길어도 목록이 보임");
      const be = makeBackend();
      be.st.tags = tags;
      const ex = ["LizSystemDatabaseMonitorService", "failed to connect", "Protocol Error Occurred", "Modbus error", "operationComplete", "judgeDriverParseResultFinally", "Cannot parse the query result"].map((p) => ({ pattern: p, kind: "text", caseSensitive: false, on: true }));
      be.st.session = session([tab("t1", P("gap.log"), { lines: { on: true, above: 0, below: 0, off: [], ex } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, { width: 420, height: 330 });
      await page.waitForSelector(".lines-view");
      await settled(page);
      await page.focus(".lv-scroll");
      await page.keyboard.press("Control+F");
      await sleep(300);
      const h = await page.$eval(".lv-scroll", (e) => e.clientHeight);
      ok(`좁고 낮은 창(420×330)에 칩 7개 + 찾기 → 목록 높이 ${h}px ≥ 80`, h >= 80, h);
      const rows = await page.$$eval(".lv-row[data-line]", (e) => e.filter((x) => x.getBoundingClientRect().height > 0).length);
      ok("행이 보임", rows >= 3, rows);
      // room enough: the chips are not squeezed (the rows' height must not shrink them)
      await page.setViewportSize({ width: 420, height: 900 });
      await sleep(300);
      const exH = await page.$eval(".lv-ex", (e) => [e.scrollHeight, e.clientHeight]);
      ok(`높은 창(420×900): 칩 줄이 잘리지 않음 (${exH[0]} ≤ ${exH[1]})`, exH[0] <= exH[1] + 1, exH);
      await ctx.close();
    }

    // =============== R6. six 300MB at once: no 「전체 열기」 ==============================================
    if (want("R6")) {
      // readview (user 10-28): 100MB 이상은 확인 창 없이 「📖 읽기 보기」 — 예전 R6 의
      // 「🏷 태그 줄만 열기 / 취소」 확인 창과 「두 개는 전체 열기」는 이 기능으로 바뀜
      console.log("R6. 300MB 여섯 개 한 번에 → 확인 창 없이 6칸 📖 읽기 · ✏️ 확인 창 안내");
      const six = [1, 2, 3, 4, 5, 6].map((k) => P(`collector${k}.log`));
      for (const f of six) fs.writeFileSync(f, "abc 1\nabc 2\n");
      const emptySix = session([], "", { multi: { on: true, count: 6, slots: Array.from({ length: 6 }, () => ({ tabId: "", mode: "read", server: "" })), bundle: null } });
      const be = makeBackend();
      be.st.tags = tags;
      for (const f of six) be.st.sizes[f] = 300 * 1024 * 1024;
      be.st.openFiles = six;
      be.st.session = emptySix;
      const { ctx, page } = await openPage(browser, url, be, { width: 1400, height: 900 });
      await page.click('.mpane[data-slot="0"] .empty-actions button:has-text("파일 열기")');
      await until(async () => (await page.$$eval(".lines-view", (e) => e.length)) === 6, 15000);
      ok("확인 창 없음", !(await page.$(".big-ask")));
      ok("6칸 모두 📖 읽기", (await page.$$eval('.lines-view[data-mode="all"]', (e) => e.length)) === 6);
      ok("파일을 읽지 않음(ReadFile 0)", calls(be, "ReadFile").length === 0, calls(be, "ReadFile").length);
      // ✏️ of one: the question says how long and that the window stops at the end
      await page.click('.mpane[data-slot="0"] .lv-edit');
      await page.waitForSelector(".choice-ask");
      const t2 = await page.$eval(".choice-ask p", (e) => e.textContent);
      ok("✏️ 확인 창: 걸리는 시간(약 30초)·응답하지 않음·768MB", t2.includes("약 30초") && t2.includes("응답하지 않") && t2.includes("768.0MB"), t2);
      await page.click('.choice-ask button:has-text("취소")');
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    try {
      await goGet("/quit");
    } catch {
      /* gone */
    }
    go.kill();
  }
  console.log(`\nrealtest-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log("  FAIL " + f);
    process.exit(1);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
