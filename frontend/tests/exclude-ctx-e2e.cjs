// Headless test of the right-click 「🚫 제외에 추가」 (ExcludeCtxMenu.tsx / excludeCtx.ts):
//  A. 「🏷 태그 줄만」 rows — text dragged in a row → right-click → a chip (on,
//     글자 그대로, 대소문자 무시) and the view filters again; the same chip only
//     switched on; several lines / none / the 「⋯ 생략」 row / too long → off + why;
//     복사; Esc; the session.
//  B. the whole-file editor's menu — 「🚫 줄만 보기 제외에 추가」 → the tab's
//     lines.ex (+ the status bar line), applied once the tab shows 「🏷 줄만」.
// Set-up copied from lines-exclude-e2e.cjs: the built frontend (frontend/dist),
// the REAL line filter through the Go helper (TestFilterE2EServer), the other
// bindings faked on the Node side.
//
//   cd frontend && npm run build && node tests/exclude-ctx-e2e.cjs   (ONLY=A,B)
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder> → exclude-ctx.png
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


const TALL = { width: 1400, height: 2000 }; // the whole 60-line result on screen (rows are virtual)

// ---- selecting in the rows / the editor ------------------------------------------------------
// Selects from the start of `a.text` inside `a.q` to the end of `b.text` inside
// `b.q` (b = a by default; `b.end` = to the end of that element) the way a drag
// would, and returns a point on the selection to right-click.
async function selectSpan(page, a, b) {
  return page.evaluate(
    ({ a, b }) => {
      const textNodes = (q) => {
        const el = document.querySelector(q);
        if (!el) return null;
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let all = "";
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          nodes.push([n, all.length]);
          all += n.data;
        }
        return { nodes, all };
      };
      const pos = (nodes, p) => {
        let k = 0;
        while (k + 1 < nodes.length && nodes[k + 1][1] <= p) k++;
        return [nodes[k][0], p - nodes[k][1]];
      };
      const A = textNodes(a.q);
      const B0 = b || a;
      const B = textNodes(B0.q);
      if (!A || !B || !A.nodes.length || !B.nodes.length) return null;
      const pa = A.all.indexOf(a.text);
      if (pa < 0) return null;
      const r = document.createRange();
      const [sa, so] = pos(A.nodes, pa);
      r.setStart(sa, so);
      if (B0.end) {
        const [n] = B.nodes[B.nodes.length - 1];
        r.setEnd(n, n.data.length);
      } else {
        const pb = B0 === a ? pa : B.all.indexOf(B0.text);
        if (pb < 0) return null;
        const [eb, eo] = pos(B.nodes, pb + B0.text.length - 1);
        r.setEnd(eb, eo + 1);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      // bring the start into the list's / editor's view (long rows scroll sideways)
      const sc = (r.startContainer.parentElement || r.startContainer).closest(".lv-scroll, .cm-scroller");
      if (sc) sc.scrollLeft = Math.max(0, sc.scrollLeft + (r.getClientRects()[0] || r.getBoundingClientRect()).left - sc.getBoundingClientRect().left - 100);
      const rc = r.getClientRects()[0] || r.getBoundingClientRect();
      return { x: Math.min(rc.right - 2, rc.left + Math.min(rc.width / 2, 200)), y: rc.top + rc.height / 2, str: sel.toString() };
    },
    { a, b }
  );
}
const row = (line) => `.lines-view .lv-row[data-line="${line}"] .lv-text`;
async function rightClick(page, box, menuQ) {
  await page.mouse.click(box.x, box.y, { button: "right" });
  await page.waitForSelector(menuQ, { timeout: 3000 });
}
const exMenu = async (page) =>
  page.$eval(".lv-exctx", (m) => {
    const it = m.querySelector(".lv-exctx-add");
    return { text: it.textContent, on: !it.disabled, why: (m.querySelector(".lv-exctx-why") || {}).textContent || "", title: it.getAttribute("title") || "" };
  });
const edMenu = async (page) =>
  page.$eval(".ctx-menu:not(.lv-exctx)", (m) => {
    const it = m.querySelector(".exclude-from-text-item");
    return { text: it.textContent, on: !it.disabled, why: (m.querySelector(".exclude-from-text-why") || {}).textContent || "", title: it.getAttribute("title") || "" };
  });
const savedLines = (be, i = 0) => (be.st.session ? JSON.parse(be.st.session).tabs[i].lines : null);
const C = (pattern, on = true) => ({ pattern, kind: "text", caseSensitive: false, on });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exclude-ctx-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    const lines = [];
    for (let i = 1; i <= 60; i++) {
      if (i === 21) lines.push(`${i} abc commonConnection keepalive`);
      else if (i === 22) lines.push(`${i} abc data`);
      else if (i % 7 === 0) lines.push(`${i} abc commonConnection keepalive`);
      else if (i % 9 === 0) lines.push(`${i} def CommonConnection upper`);
      else if (i % 10 === 3) lines.push(`${i} def payload averyveryverylongtokenname_0123456789 end`);
      else lines.push(`${i} plain`);
    }
    fs.writeFileSync(P("ex.log"), lines.join("\n"));
    const hitRe = /abc|def/;
    const isHit = (ex) => (l) => hitRe.test(l) && !ex.some((f) => f(l));
    const cci = (l) => l.toLowerCase().includes("commonconnection");
    const keep = (l) => l.toLowerCase().includes("keepalive");
    const tags = tagsJSON([R("a", "abc"), R("d", "def")]);

    // =============== A. 「🏷 줄만」 rows ====================================================
    if (want("A")) {
      console.log("A. 줄만 보기: 행 글자 선택 → 우클릭 「🚫 제외에 추가」");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("ex.log"), { lines: { on: true, above: 1, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      let w = refRows(lines, isHit([]), 1, 1);
      ok("(앞 조건) 처음 행 = 제외 없음", eq(await waitRows(page, w), w));

      // nothing selected
      await page.click(row(22));
      let box = await page.$eval(row(22), (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left + 20, y: r.top + r.height / 2 };
      });
      await rightClick(page, box, ".lv-exctx");
      let m = await exMenu(page);
      ok("선택 없음 → 메뉴 뜨고 항목 꺼짐 + 「먼저 고르세요」", !m.on && m.why.includes("먼저 고르세요"), m);
      ok("선택 없으면 복사도 꺼짐", await page.$eval(".lv-exctx-copy", (e) => e.disabled));
      await page.keyboard.press("Escape");
      ok("Esc → 메뉴 닫힘", !(await page.$(".lv-exctx")));

      // the text
      box = await selectSpan(page, { q: row(7), text: "commonConnection" });
      ok("(앞 조건) 7행 「commonConnection」 선택", !!box && box.str === "commonConnection", box);
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("메뉴 켜짐 「🚫 제외에 추가: 「commonConnection」」", m.on && m.text === "🚫 제외에 추가: 「commonConnection」" && !m.why, m);
      ok("우클릭해도 선택 그대로", (await page.evaluate(() => window.getSelection().toString())) === "commonConnection");
      await shot(page, "exclude-ctx-full.png");
      if (SHOTS) {
        // the picture: the view's top part with the menu
        await page.screenshot({ path: path.join(SHOTS, "exclude-ctx.png"), clip: { x: 0, y: 0, width: 1000, height: 560 } });
      }
      const n0 = calls(be, "FilterStart").length;
      await page.click(".lv-exctx-add");
      ok("누르면 메뉴 닫힘 · 선택 풀림", !(await page.$(".lv-exctx")) && (await page.evaluate(() => window.getSelection().isCollapsed)));
      w = refRows(lines, isHit([cci]), 1, 1);
      ok("다시 거름 · 행 = 참조(대소문자 무시 제외)", eq(await waitRows(page, w), w), await shownRows(page));
      ok("칩 하나(켜짐 · 글자 그대로 · Aa 없음)", eq(await chips(page), [{ t: "commonConnection", on: true, bad: false }]), await chips(page));
      ok(
        "요청 exclude = [글자 그대로 · 대소문자 무시]",
        calls(be, "FilterStart").length === n0 + 1 && eq(lastStart(be).args[0].exclude, [{ kind: "text", pattern: "commonConnection", caseSensitive: false, on: true }]),
        lastStart(be).args[0].exclude
      );
      await waitDone(page);
      const nEx = lines.filter((l) => hitRe.test(l) && cci(l)).length;
      ok(`상태 (제외 ${nEx})`, (await stat(page)).includes(`(제외 ${nEx})`), await stat(page));
      await sleep(700);
      ok("세션에 칩 저장", eq(savedLines(be).ex, [C("commonConnection")]), savedLines(be));
      ok("포커스는 줄 목록", await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains("lv-scroll")));

      // the same chip on already: 21 shows as context of 22
      box = await selectSpan(page, { q: row(21), text: "commonConnection" });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("같은 칩이 켜져 있으면 꺼짐 + 「이미」", !m.on && m.why.includes("이미 켜진"), m);
      await page.keyboard.press("Escape");
      // chip off → the same text (case differs) → switched on, no twin
      await page.click(".lv-chip-t");
      w = refRows(lines, isHit([]), 1, 1);
      ok("(앞 조건) 칩 끔 → 9행 다시 보임", eq(await waitRows(page, w), w));
      box = await selectSpan(page, { q: row(9), text: "CommonConnection" });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("꺼진 칩과 대소문자만 다른 글자 → 메뉴 켜짐", m.on && m.text.includes("CommonConnection"), m);
      const n1 = calls(be, "FilterStart").length;
      await page.click(".lv-exctx-add");
      w = refRows(lines, isHit([cci]), 1, 1);
      ok("같은 칩이면 새로 안 만들고 켜기만", eq(await waitRows(page, w), w) && eq(await chips(page), [{ t: "commonConnection", on: true, bad: false }]), await chips(page));
      ok("다시 켠 결과는 캐시", calls(be, "FilterStart").length === n1 + 1 && !!lastStart(be).result && lastStart(be).result.cached === true, lastStart(be).result);

      // two rows
      box = await selectSpan(page, { q: row(22), text: "abc" }, { q: row(23), text: "def" });
      ok("(앞 조건) 두 행에 걸친 선택", !!box && box.str.includes("\n"), box);
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("여러 줄 → 꺼짐 + 이유", !m.on && m.why.includes("여러 줄"), m);
      ok("여러 줄이어도 복사는 됨", !(await page.$eval(".lv-exctx-copy", (e) => e.disabled)));
      await page.click(".lv-exctx-copy");
      ok("복사 = 브라우저 선택 글자", (await page.evaluate(() => window.__clip)) === box.str, await page.evaluate(() => window.__clip));

      // a selection ending at the next row's start (a triple click's range) is one line
      box = await selectSpan(page, { q: row(22), text: "abc data" });
      await page.evaluate(() => {
        const s = window.getSelection();
        const r = s.getRangeAt(0);
        r.setEnd(document.querySelector('.lines-view .lv-row[data-line="23"]'), 0);
        s.removeAllRanges();
        s.addRange(r);
      });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("다음 행 시작에서 끝나는 선택 = 한 줄", m.on && m.text.includes("「abc data」"), m);
      await page.keyboard.press("Escape");

      // line number included: only the line's text
      box = await selectSpan(page, { q: `.lines-view .lv-row[data-line="22"] .lv-no`, text: "22" }, { q: row(22), end: true });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("줄 번호까지 끌어도 줄 글자만 (「22 abc data」)", m.on && m.text === "🚫 제외에 추가: 「22 abc data」", { m, str: box && box.str });
      await page.keyboard.press("Escape");

      // long text in the menu is cut
      box = await selectSpan(page, { q: row(23), text: "payload averyveryverylongtokenname_0123456789" });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("긴 글자는 메뉴에서 24자 + … (풍선엔 전체)", m.on && m.text === "🚫 제외에 추가: 「payload averyveryverylon…」" && m.title.includes("payload averyveryverylongtokenname_0123456789"), m);
      await page.keyboard.press("Escape");

      // the 「⋯ 생략」 row
      box = await selectSpan(page, { q: ".lines-view .lv-row.lv-gap .lv-text", text: "생략" });
      ok("(앞 조건) 생략 행 선택", !!box);
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("「⋯ 생략」 행 → 꺼짐 + 이유", !m.on && m.why.includes("생략"), m);
      await page.keyboard.press("Escape");

      // spaces only
      box = await selectSpan(page, { q: row(22), text: " " });
      await rightClick(page, box, ".lv-exctx");
      m = await exMenu(page);
      ok("공백뿐 → 꺼짐 + 이유", !m.on && m.why.includes("공백뿐"), m);
      await page.mouse.click(5, 5);
      ok("바깥 누르면 닫힘", !(await page.$(".lv-exctx")));

      // after a reload the chip comes back from the session
      await sleep(700);
      const sess = be.st.session;
      await ctx.close();
      const be2 = makeBackend();
      be2.st.tags = tags;
      be2.st.session = sess;
      const o2 = await openPage(browser, url, be2, TALL);
      await o2.page.waitForSelector(".lines-view");
      await waitDone(o2.page);
      w = refRows(lines, isHit([cci]), 1, 1);
      ok("다시 열면 칩 복원 · 제외 그대로", eq(await waitRows(o2.page, w), w) && eq(await chips(o2.page), [{ t: "commonConnection", on: true, bad: false }]));
      await o2.ctx.close();
    }

    // =============== B. whole-file editor menu =================================================
    if (want("B")) {
      console.log("B. 전체 보기 편집기 우클릭 「🚫 줄만 보기 제외에 추가」");
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("ex.log"), { needsLoad: true })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".cm-content");
      await until(async () => (await page.textContent(".cm-content")).includes("60 plain"));
      const first = await page.$eval(".cm-line", (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2 };
      });
      await page.mouse.click(first.x, first.y);
      await rightClick(page, first, ".ctx-menu");
      let m = await edMenu(page);
      ok("선택 없음 → 꺼짐 + 「먼저 고르세요」", !m.on && m.why.includes("먼저 고르세요"), m);
      ok(
        "「🎨 이 글자로 로그 색 규칙 만들기…」 바로 아래",
        await page.$eval(".ctx-menu .rule-from-text-item", (e) => !!e.nextElementSibling && e.nextElementSibling.classList.contains("exclude-from-text-item"))
      );
      await page.keyboard.press("Escape");

      let box = await selectSpan(page, { q: ".cm-content", text: "keepalive" });
      await sleep(150); // CodeMirror reads the DOM selection
      await rightClick(page, box, ".ctx-menu");
      m = await edMenu(page);
      ok("메뉴 켜짐 「🚫 줄만 보기 제외에 추가: 「keepalive」」", m.on && m.text === "🚫 줄만 보기 제외에 추가: 「keepalive」", m);
      await page.click(".ctx-menu .exclude-from-text-item");
      ok("누르면 메뉴 닫힘", !(await page.$(".ctx-menu")));
      const fl = await until(async () => (await page.$(".st-flash")) && (await page.textContent(".st-flash")), 2000);
      ok("상태 표시줄 「…추가했습니다 — 줄만 보기에서 적용됩니다」", !!fl && fl.includes("「keepalive」") && fl.includes("추가했습니다") && fl.includes("줄만 보기에서 적용됩니다"), fl);
      await sleep(700);
      let sl = savedLines(be);
      ok("세션: 탭 lines.ex 에 저장 · 줄만은 꺼진 채", !!sl && sl.on === false && eq(sl.ex, [C("keepalive")]), sl);
      ok("전체 보기에서는 거르지 않음", calls(be, "FilterStart").length === 0);

      // the same again → off + 이미
      box = await selectSpan(page, { q: ".cm-content", text: "keepalive" });
      await sleep(150);
      await rightClick(page, box, ".ctx-menu");
      m = await edMenu(page);
      ok("같은 칩이 켜져 있으면 꺼짐 + 「이미」", !m.on && m.why.includes("이미"), m);
      await page.keyboard.press("Escape");
      // two lines
      box = await selectSpan(page, { q: ".cm-content", text: "1 plain2 plain" });
      await sleep(150);
      if (box) {
        await rightClick(page, box, ".ctx-menu");
        m = await edMenu(page);
        ok("여러 줄 → 꺼짐 + 이유", !m.on && m.why.includes("여러 줄"), m);
        await page.keyboard.press("Escape");
      } else console.log("  NOTE 여러 줄 DOM 선택을 못 만듦 — 단위 시험이 대신");
      // the whole file
      await page.mouse.click(first.x, first.y);
      await page.keyboard.press("Control+a");
      await rightClick(page, first, ".ctx-menu");
      m = await edMenu(page);
      ok("모두 선택 → 꺼짐 + 이유(여러 줄)", !m.on && m.why.includes("여러 줄"), m);
      await page.keyboard.press("Escape");

      // switch to 「🏷 줄만」: the chip applies
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const w = refRows(lines, isHit([keep]), 0, 3);
      ok("줄만으로 바꾸면 칩 적용 · 행 = 참조", eq(await waitRows(page, w), w), await shownRows(page));
      ok("칩 「keepalive」 켜짐", eq(await chips(page), [{ t: "keepalive", on: true, bad: false }]), await chips(page));
      ok("요청 exclude = keepalive", eq(lastStart(be).args[0].exclude, [{ kind: "text", pattern: "keepalive", caseSensitive: false, on: true }]), lastStart(be).args[0].exclude);
      // chip off in 줄만, back to the whole file → the editor menu switches it on
      await page.click(".lv-chip-t");
      await until(async () => eq(await chips(page), [{ t: "keepalive", on: false, bad: false }]));
      await page.click(".lines-seg button:nth-child(1)");
      await page.waitForSelector(".cm-content");
      await until(async () => (await page.textContent(".cm-content")).includes("keepalive"));
      box = await selectSpan(page, { q: ".cm-content", text: "keepalive" });
      await sleep(150);
      await rightClick(page, box, ".ctx-menu");
      m = await edMenu(page);
      ok("꺼진 칩 → 메뉴 켜짐(켜기)", m.on, m);
      await page.click(".ctx-menu .exclude-from-text-item");
      const fl2 = await until(async () => {
        const t = (await page.$(".st-flash")) && (await page.textContent(".st-flash"));
        return t && t.includes("켰습니다") && t;
      }, 2000);
      ok("상태 표시줄 「꺼져 있던 … 켰습니다」", !!fl2, await page.textContent(".statusbar"));
      await sleep(700);
      sl = savedLines(be);
      ok("세션: 칩 하나 · 켜짐(쌍둥이 없음)", eq(sl.ex, [C("keepalive")]), sl);
      await ctx.close();

      // a tab with no file (no 「🏷 줄만」)
      const be3 = makeBackend();
      be3.st.tags = tags;
      be3.st.session = session([tab("u1", "", { title: "새 문서", needsLoad: false, content: "abc keepalive\nzzz" })], "u1");
      const o3 = await openPage(browser, url, be3, TALL);
      await o3.page.waitForSelector(".cm-content");
      await until(async () => (await o3.page.textContent(".cm-content")).includes("keepalive"));
      box = await selectSpan(o3.page, { q: ".cm-content", text: "keepalive" });
      await sleep(150);
      await rightClick(o3.page, box, ".ctx-menu");
      m = await edMenu(o3.page);
      ok("파일 없는 탭 → 꺼짐 + 이유", !m.on && m.why.includes("파일로 저장한 탭"), m);
      await o3.ctx.close();
    }

    // =============== C. long lines ================================================================
    if (want("C")) {
      console.log("C. 긴 줄: 「… 앞 4KB」 안내 빼기 · 1000자 상한 · 편집기 4000자 넘는 선택");
      const L = ["1 abc short", "2 abc " + "x".repeat(5000) + " tail", "3 abc " + "y".repeat(1100) + " end"];
      fs.writeFileSync(P("long.log"), L.join("\n"));
      const be = makeBackend();
      be.st.tags = tags;
      be.st.session = session([tab("t1", P("long.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be, TALL);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await until(async () => !!(await page.$(`.lines-view .lv-row[data-line="2"] .lv-cut`)));
      // the last 20 x of the shown part through the end of the 「… 앞 4KB」 note
      const box = await page.evaluate(() => {
        const t = document.querySelector('.lines-view .lv-row[data-line="2"] .lv-text');
        const cut = t.querySelector(".lv-cut");
        // the line's last text node (before the note; rule colours split the line in spans)
        const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        let tn = null;
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!cut.contains(n)) tn = n;
        const last = cut.lastChild;
        const r = document.createRange();
        r.setStart(tn, tn.data.length - 20);
        r.setEnd(last, last.data.length);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        // the end of a 4KB row is far right: scroll it into the list's view
        const sc = document.querySelector(".lv-scroll");
        sc.scrollLeft += r.getClientRects()[0].left - sc.getBoundingClientRect().left - 200;
        const rc = r.getClientRects()[0];
        return { x: rc.left + 5, y: rc.top + rc.height / 2, str: s.toString(), tail: tn.data.slice(-20) };
      });
      ok("(앞 조건) 선택에 「긴 줄」 안내 포함", box.str.includes("긴 줄"), box);
      await rightClick(page, box, ".lv-exctx");
      let m = await exMenu(page);
      ok("안내 글은 빼고 줄 글자만", m.on && m.text === `🚫 제외에 추가: 「${box.tail.trim()}」`, { m, tail: box.tail });
      await page.keyboard.press("Escape");
      const b3 = await selectSpan(page, { q: row(3), text: "y".repeat(1001) });
      await rightClick(page, b3, ".lv-exctx");
      m = await exMenu(page);
      ok("1000자 넘는 선택 → 꺼짐 + 상한 이유", !m.on && m.why.includes("1000자보다 긴"), m);
      await page.keyboard.press("Escape");
      const b4 = await selectSpan(page, { q: row(3), text: "y".repeat(1000) });
      await rightClick(page, b4, ".lv-exctx");
      m = await exMenu(page);
      ok("1000자 = 됨 (메뉴엔 24자 + …)", m.on && m.text === `🚫 제외에 추가: 「${"y".repeat(24)}…」`, m);
      await page.click(".lv-exctx-add");
      await until(async () => (await chips(page)).length === 1);
      await sleep(700);
      ok("1000자 칩 저장", eq(savedLines(be).ex, [C("y".repeat(1000))]));
      // the editor: a selection over 4000 characters
      await page.click(".lines-seg button:nth-child(1)");
      await page.waitForSelector(".cm-content");
      await until(async () => (await page.textContent(".cm-content")).includes("tail"));
      const b5 = await selectSpan(page, { q: ".cm-content", text: "x".repeat(4500) });
      await sleep(150);
      if (b5) {
        await rightClick(page, b5, ".ctx-menu");
        m = await edMenu(page);
        ok("편집기 4000자 넘는 선택 → 꺼짐 + 「너무 깁니다」", !m.on && m.why.includes("너무 깁니다"), m);
        await page.keyboard.press("Escape");
      } else console.log("  NOTE 편집기에서 긴 줄 DOM 선택을 못 만듦 — 단위 시험이 대신");
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    try {
      await fetch(`http://${goAddr}/quit`);
    } catch {}
    go.kill();
  }
  console.log(`\nexclude-ctx-e2e: ${pass} passed, ${fails.length} failed`);
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
