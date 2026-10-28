// Headless test of multi-view pane resizing (MultiGrid.tsx / paneSizes.ts)
// against the built frontend (frontend/dist). Bindings are faked on the Node
// side like tags-e2e.cjs; the 「🏷 태그 줄만」 pane uses the REAL line filter
// through the Go helper of lines-e2e.cjs (go test -run TestFilterE2EServer).
//
//   cd frontend && npm run build && node tests/multiview-resize-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder> → screenshots mv-*.png
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const ROOT = path.join(__dirname, "..", "..");
const SHOTS = process.env.SHOTS || "";
const GAP = 6;
const MIN_W = 260;
const MIN_H = 150;
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
const near = (a, b, e = 1.5) => Math.abs(a - b) <= e;

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

// ---- the Go helper (real line filter) ---------------------------------------------
let goAddr = "";
async function startGo() {
  const addrFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mv-e2e-")), "addr");
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

function makeBackend() {
  const st = { session: "", tags: null, calls: [] };
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
      const c = fs.readFileSync(p, "utf8");
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: false, canceled: false };
    },
    ReadFileAs: (p, enc) => ({ ...impl.ReadFile(p), encoding: enc }),
    StatFile: (p) => (fs.existsSync(p) ? { exists: true, modTime: 1, size: fs.statSync(p).size } : { exists: false, modTime: 0, size: 0 }),
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules"]);
  return {
    st,
    call: async (name, args) => {
      st.calls.push({ name, args });
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
    },
    { get: (t, name) => t[name] || (() => undefined) }
  );
};

async function openPage(browser, url, be, viewport = { width: 1400, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("  [pageerror]", e.message);
  });
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
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
        /* closing */
      }
      await sleep(25);
    }
  })();
  ctx.on("close", () => (stop = true));
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(300);
  return { ctx, page, errors };
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
const slot = (tabId) => ({ tabId, mode: "read", server: "", note: "" });
function sessionWith(files, count, extra = {}) {
  const tabs = files.map((f, i) => tab("t" + (i + 1), f.path, f.lines ? { lines: { on: true, above: 0, below: 0, off: [] } } : {}));
  const slots = Array.from({ length: 6 }, (_, i) => slot(tabs[i] ? tabs[i].id : ""));
  return JSON.stringify({ version: 3, tabs, activeId: "t1", splitRatio: 0.5, fontSize: 14, multi: { on: true, count, slots, bundle: null }, ...extra });
}

// ---- page helpers -------------------------------------------------------------------
const rects = (page) =>
  page.$$eval(".multi-grid > .mpane", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { slot: +e.dataset.slot, x: r.x, y: r.y, w: r.width, h: r.height };
    })
  );
const gridRect = (page) => page.$eval(".multi-grid", (e) => e.getBoundingClientRect().toJSON());
const barBox = (page, sel) => page.$eval(sel, (e) => e.getBoundingClientRect().toJSON());
async function drag(page, sel, dx, dy, opts = {}) {
  const b = await barBox(page, sel);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = opts.steps || 8;
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(x + (dx * k) / steps, y + (dy * k) / steps);
    if (opts.during && k === Math.ceil(steps / 2)) await opts.during();
  }
  if (opts.beforeUp) await opts.beforeUp();
  await page.mouse.up();
  await sleep(80);
}
async function saved(page, be) {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(700);
  return JSON.parse(be.st.session);
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};
// Does pane `slot`'s editor fill its pane, with lines drawn down to its bottom?
const editorFit = (page, s) =>
  page.$eval(`.mpane[data-slot="${s}"]`, (p) => {
    const pr = p.getBoundingClientRect();
    const ed = p.querySelector(".cm-editor");
    const sc = p.querySelector(".cm-scroller");
    if (!ed || !sc) return null;
    const er = ed.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    const lines = [...p.querySelectorAll(".cm-line")].map((l) => l.getBoundingClientRect());
    const lastBottom = Math.max(...lines.map((l) => l.bottom));
    const longLine = [...p.querySelectorAll(".cm-line")].find((l) => l.textContent.startsWith("LONG"));
    return {
      paneW: pr.width,
      edW: er.width,
      paneBottom: pr.bottom,
      scBottom: sr.bottom,
      linesToBottom: lastBottom >= sr.bottom - 2,
      longH: longLine ? longLine.getBoundingClientRect().height : 0,
    };
  });
const linesFit = (page, s) =>
  page.$eval(`.mpane[data-slot="${s}"]`, (p) => {
    const sc = p.querySelector(".lv-scroll");
    if (!sc) return null;
    const sr = sc.getBoundingClientRect();
    const rows = [...sc.querySelectorAll(".lv-row[data-row]")].map((r) => r.getBoundingClientRect());
    return { h: sr.height, w: sr.width, rows: rows.length, toBottom: rows.length ? Math.max(...rows.map((r) => r.bottom)) >= sr.bottom - 2 : false };
  });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-files-"));
  const files = [];
  const long = "LONG " + "abcdefghij ".repeat(60);
  for (let i = 1; i <= 6; i++) {
    const lines = [long];
    for (let k = 1; k <= 400; k++) lines.push(`2026-10-28 10:00:${String(k % 60).padStart(2, "0")} ${k % 3 ? "INFO" : "ERROR"} pane${i} line ${k}`);
    const p = path.join(dir, `p${i}.log`);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    files.push({ path: p, lines: i === 3 }); // pane 3 (slot 2, bottom row of 4) = 🏷 줄만
  }
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const go = await startGo();
  const browser = await chromium.launch({ headless: true });
  try {
    // ===================== 1. four panes =====================================
    console.log("1. 4칸: 경계 끌기");
    const be = makeBackend();
    be.st.session = sessionWith(files, 4);
    let { ctx, page, errors } = await openPage(browser, url, be);
    await until(() => page.$(`.mpane[data-slot="0"] .cm-line`), 10000);
    await until(() => page.$(`.mpane[data-slot="2"] .lv-row[data-row]`), 15000);
    await sleep(300);
    const g = await gridRect(page);
    let r = await rects(page);
    ok("4칸 처음엔 균등 (가로)", r.every((p) => near(p.w, (g.width - GAP) / 2)), r);
    ok("4칸 처음엔 균등 (세로)", r.every((p) => near(p.h, (g.height - GAP) / 2)), r);
    ok("경계 막대: 줄마다 1개 + 위아래 1개", (await page.$$(".mv-col")).length === 2 && (await page.$$(".mv-row")).length === 1);
    const bar = await barBox(page, '[data-mv-col="0-0"]');
    ok("막대는 두 칸 사이 6px", near(bar.width, GAP, 0.01) && near(bar.x, r[0].x + r[0].w, 0.5) && near(bar.x + bar.width, r[1].x, 0.5), { bar, r0: r[0], r1: r[1] });
    ok("막대 커서 = col-resize / row-resize", (await page.$eval(".mv-col", (e) => getComputedStyle(e).cursor)) === "col-resize" && (await page.$eval(".mv-row", (e) => getComputedStyle(e).cursor)) === "row-resize");
    ok("막대 모양 = 한 칸 보기의 .resizer 색", (await page.$eval(".mv-col", (e) => getComputedStyle(e).backgroundColor)) === (await page.$eval(".multi-grid", (e) => getComputedStyle(e).backgroundColor)));
    await shot(page, "mv-4-before.png");
    // mark the editors: a drag must not remount them
    await page.$$eval(".mpane .cm-editor", (els) => els.forEach((e) => (e.__mark = 1)));
    const fit0 = await editorFit(page, 0);
    let during = null;
    let savesBefore = be.st.calls.filter((c) => c.name === "SaveSession").length;
    await drag(page, '[data-mv-col="0-0"]', 250, 0, {
      during: async () => {
        await sleep(120); // a frame + CodeMirror's ResizeObserver
        during = { r: await rects(page), fit: await editorFit(page, 0), cursor: await page.evaluate(() => document.body.style.cursor) };
      },
    });
    ok("끄는 중에 칸 너비가 따라감", during && during.r[0].w > r[0].w + 60 && near(during.r[0].w + during.r[1].w, r[0].w + r[1].w, 1), during && during.r);
    ok("끄는 중에 편집기가 칸 너비를 채움", during && near(during.fit.edW, during.fit.paneW, 1), during && during.fit);
    ok("끄는 중에 긴 줄이 다시 감김 (높이 줄어듦)", during && during.fit.longH < fit0.longH, { before: fit0.longH, during: during && during.fit.longH });
    ok("끄는 중 커서 col-resize", during && during.cursor === "col-resize");
    await sleep(200);
    let r2 = await rects(page);
    ok("놓은 뒤: 왼쪽 칸 +250px", near(r2[0].w, r[0].w + 250, 2), [r[0].w, r2[0].w]);
    ok("놓은 뒤: 오른쪽 칸 -250px", near(r2[1].w, r[1].w - 250, 2));
    ok("아래 줄은 그대로", near(r2[2].w, r[2].w) && near(r2[3].w, r[3].w));
    ok("놓은 뒤 커서 복구", (await page.evaluate(() => document.body.style.cursor)) === "");
    const fit1 = await editorFit(page, 0);
    ok("놓은 뒤 편집기 너비 = 칸 너비, 아래까지 줄이 그려짐", near(fit1.edW, fit1.paneW, 1) && fit1.linesToBottom, fit1);
    ok("편집기를 다시 만들지 않음 (끌기)", (await page.$$eval(".mpane .cm-editor", (els) => els.filter((e) => e.__mark === 1).length)) === 3);
    let s = await saved(page, be);
    ok("세션에 4칸 비율 저장", s.paneSizes && s.paneSizes["4"] && near(s.paneSizes["4"].cols[0][0] * (g.width - GAP), r2[0].w, 2), s.paneSizes);
    ok("세션 버전 그대로 3", s.version === 3);
    ok("끄는 동안엔 저장 안 함, 놓은 뒤 저장", be.st.calls.filter((c) => c.name === "SaveSession").length > savesBefore);

    // rows: the 🏷 줄만 pane (slot 2) is in the bottom row
    const lv0 = await linesFit(page, 2);
    ok("줄만 보기 칸: 처음에 행이 아래까지", lv0 && lv0.toBottom, lv0);
    let lvDuring = null;
    await drag(page, ".mv-row", 0, 220, {
      during: async () => {
        await sleep(150);
        lvDuring = await linesFit(page, 2);
      },
    });
    await sleep(200);
    r2 = await rects(page);
    ok("위아래 경계: 위 줄 +220px", near(r2[0].h, r[0].h + 220, 2) && near(r2[1].h, r2[0].h, 0.5), [r[0].h, r2[0].h]);
    ok("위아래 경계: 아래 줄 -220px", near(r2[2].h, r[2].h - 220, 2) && near(r2[3].h, r2[2].h, 0.5));
    ok("줄만 보기 칸: 끄는 중 높이 따라감", lvDuring && lvDuring.h < lv0.h - 100, [lv0.h, lvDuring && lvDuring.h]);
    await drag(page, ".mv-row", 0, -380);
    await sleep(300);
    const lv1 = await linesFit(page, 2);
    r2 = await rects(page);
    ok("줄만 보기 칸: 다시 키우면 행이 새 바닥까지 그려짐", lv1 && lv1.h > lv0.h + 100 && lv1.toBottom && lv1.rows > lv0.rows, { lv0, lv1 });
    ok("위 줄 최소 높이 지킴", r2[0].h >= MIN_H - 0.5, r2[0].h);
    ok("위 줄 높이 = 처음 -160px (+220 뒤 -380)", near(r2[0].h, Math.max(MIN_H, r[0].h - 160), 2), r2[0].h);
    // bottom row (the 🏷 줄만 pane) at its minimum height still shows rows
    await drag(page, ".mv-row", 0, 2000);
    await sleep(250);
    const lvLow = await linesFit(page, 2);
    r2 = await rects(page);
    ok("아래 줄 최소 높이 지킴 (150px)", near(r2[2].h, MIN_H, 1), r2[2].h);
    ok("최소 높이의 줄만 칸에도 행이 보임", lvLow && lvLow.rows >= 2 && lvLow.h >= 60, lvLow);
    await drag(page, ".mv-row", 0, -2000);
    await drag(page, ".mv-row", 0, 300);
    await shot(page, "mv-4-after.png");

    // min width
    await drag(page, '[data-mv-col="1-0"]', 2000, 0);
    r2 = await rects(page);
    ok("오른쪽 칸 최소 너비 지킴 (260px)", near(r2[3].w, MIN_W, 1), r2[3].w);
    const head = await page.$eval('.mpane[data-slot="3"] .mpane-foot', (f) => {
      const fr = f.getBoundingClientRect();
      const need = [".mp-num", ".lines-seg", ".mp-modes"].map((q) => f.querySelector(q)?.getBoundingClientRect());
      const kids = [...f.children].map((c) => ({ c: c.className, w: Math.round(c.getBoundingClientRect().width), r: Math.round(c.getBoundingClientRect().right) }));
      return { ok: need.every((b) => b && b.right <= fr.right + 0.5 && b.width > 0), fr: Math.round(fr.right), kids };
    });
    ok("최소 너비에서도 칸 번호·전체/줄만·모드 버튼 보임", head.ok, head);
    // the 🏷 줄만 pane (slot 2) at its minimum width: its head wraps, rows stay visible
    await drag(page, '[data-mv-col="1-0"]', -3000, 0);
    const lvMin = await page.$eval('.mpane[data-slot="2"]', (p) => ({
      w: p.getBoundingClientRect().width,
      head: p.querySelector(".lv-head").getBoundingClientRect().height,
      sc: p.querySelector(".lv-scroll").getBoundingClientRect().height,
    }));
    console.log("    (줄만 칸 최소 너비:", JSON.stringify(lvMin), ")");
    ok("줄만 칸 최소 너비: 머리가 줄바꿈돼도 행 보이는 자리 남음", lvMin.sc >= 60, lvMin);
    await drag(page, '[data-mv-col="1-0"]', 3000, 0);
    await drag(page, '[data-mv-col="1-0"]', -3000, 0);
    r2 = await rects(page);
    ok("왼쪽 칸도 최소 너비 지킴", near(r2[2].w, MIN_W, 1), r2[2].w);

    // double-click → equal
    await page.dblclick('[data-mv-col="1-0"]');
    await sleep(150);
    r2 = await rects(page);
    ok("아래 줄 막대 두 번 누름 → 아래 줄 균등", near(r2[2].w, r2[3].w, 1));
    ok("위 줄은 그대로 (끈 값)", !near(r2[0].w, r2[1].w, 20));
    await page.dblclick(".mv-row");
    await sleep(150);
    r2 = await rects(page);
    ok("위아래 막대 두 번 누름 → 위아래 균등", near(r2[0].h, r2[2].h, 1));

    // window resize keeps ratios
    const ratio = (rr) => rr[0].w / (rr[0].w + rr[1].w);
    const before = ratio(r2);
    await page.setViewportSize({ width: 1000, height: 700 });
    await sleep(400);
    const r3 = await rects(page);
    ok("창을 줄여도 비율 유지", near(ratio(r3), before, 0.003), [before, ratio(r3)]);
    const g3 = await gridRect(page);
    ok("창을 줄여도 칸이 그리드를 꽉 채움", near(r3[1].x + r3[1].w, g3.x + g3.width, 0.6) && near(r3[2].y + r3[2].h, g3.y + g3.height, 0.6), { r3, g3 });
    const fit3 = await editorFit(page, 0);
    ok("창 크기 변경 뒤 편집기도 칸에 맞춤", near(fit3.edW, fit3.paneW, 1) && fit3.linesToBottom, fit3);
    await page.setViewportSize({ width: 1400, height: 900 });
    await sleep(300);

    // ===================== 2. pane counts ======================================
    console.log("2. 칸 수 바꾸기");
    const four = await rects(page);
    await page.click('.seg-btn[title="6칸"]');
    await sleep(500);
    await until(() => page.$(`.mpane[data-slot="5"] .cm-line`), 10000);
    await sleep(200);
    let r6 = await rects(page);
    const g6 = await gridRect(page);
    ok("6칸: 저장값 없음 → 균등", r6.length === 6 && r6.every((p) => near(p.w, (g6.width - 2 * GAP) / 3) && near(p.h, (g6.height - GAP) / 2)), r6);
    ok("칸 수를 바꿔도 남은 칸의 편집기는 그대로", (await page.$$eval(".mpane .cm-editor", (els) => els.filter((e) => e.__mark === 1).length)) === 3);
    ok("6칸 막대: 위 2 + 아래 2 + 위아래 1", (await page.$$(".mv-col")).length === 4 && (await page.$$(".mv-row")).length === 1);
    await shot(page, "mv-6-before.png");
    await drag(page, '[data-mv-col="0-1"]', 150, 0);
    await drag(page, '[data-mv-col="1-0"]', -120, 0);
    await drag(page, ".mv-row", 0, -100);
    await sleep(200);
    r6 = await rects(page);
    ok("6칸 위 줄: 2·3번 칸만 바뀜", near(r6[0].w, (g6.width - 2 * GAP) / 3) && near(r6[1].w, (g6.width - 2 * GAP) / 3 + 150, 2) && near(r6[2].w, (g6.width - 2 * GAP) / 3 - 150, 2), r6);
    ok("6칸 아래 줄: 4·5번 칸만 바뀜", near(r6[3].w, (g6.width - 2 * GAP) / 3 - 120, 2) && near(r6[4].w, (g6.width - 2 * GAP) / 3 + 120, 2) && near(r6[5].w, (g6.width - 2 * GAP) / 3), r6);
    ok("6칸 위아래", near(r6[0].h, (g6.height - GAP) / 2 - 100, 2));
    for (const sl of [0, 1, 2, 3, 4, 5]) {
      const f = sl === 2 ? await linesFit(page, sl) : await editorFit(page, sl);
      if (sl === 2) ok(`6칸 ${sl + 1}번(줄만) 칸 다시 그려짐`, f && f.toBottom && near(f.w, r6[sl].w, 1), f);
      else ok(`6칸 ${sl + 1}번 칸 편집기 다시 그려짐`, f && near(f.edW, f.paneW, 1) && f.linesToBottom, f);
    }
    await shot(page, "mv-6-after.png");
    await page.click('.seg-btn[title="4칸"]');
    await sleep(400);
    const back4 = await rects(page);
    ok("4칸으로 돌아오면 4칸 저장값", back4.every((p, k) => near(p.w, four[k].w, 1) && near(p.h, four[k].h, 1)), { four, back4 });
    await page.click('.seg-btn[title="3칸"]');
    await sleep(400);
    const r3c = await rects(page);
    ok("3칸: 한 줄 균등, 위아래 막대 없음", r3c.length === 3 && r3c.every((p) => near(p.w, (g6.width - 2 * GAP) / 3)) && (await page.$$(".mv-row")).length === 0);
    await page.click('.seg-btn[title="1칸"]');
    await sleep(300);
    ok("1칸: 막대 없음, 칸이 그리드 전체", (await page.$$(".mv-bar")).length === 0 && near((await rects(page))[0].w, g6.width, 0.5));
    await page.click('.seg-btn[title="6칸"]');
    await sleep(400);
    const back6 = await rects(page);
    ok("6칸으로 돌아오면 6칸 저장값", back6.every((p, k) => near(p.w, r6[k].w, 1) && near(p.h, r6[k].h, 1)));
    s = await saved(page, be);
    ok("세션: 4칸·6칸 따로 저장", s.paneSizes && s.paneSizes["4"] && s.paneSizes["6"] && !s.paneSizes["3"], s.paneSizes && Object.keys(s.paneSizes));
    ok("세션 multi 형식 그대로 (필드 추가 없음)", JSON.stringify(Object.keys(s.multi).sort()) === JSON.stringify(["bundle", "count", "on", "slots"]));
    ok("페이지 오류 없음 (1·2)", errors.length === 0, errors);
    await ctx.close();

    // ===================== 3. restore ==========================================
    console.log("3. 다시 열기: 세션에서 복원");
    ({ ctx, page, errors } = await openPage(browser, url, be));
    await until(() => page.$(`.mpane[data-slot="5"] .cm-line`), 10000);
    await sleep(300);
    const re6 = await rects(page);
    ok("다시 열면 6칸 크기 복원", re6.every((p, k) => near(p.w, back6[k].w, 1) && near(p.h, back6[k].h, 1)), { back6, re6 });
    await page.click('.seg-btn[title="4칸"]');
    await sleep(400);
    const re4 = await rects(page);
    ok("다시 열면 4칸 크기 복원", re4.every((p, k) => near(p.w, four[k].w, 1) && near(p.h, four[k].h, 1)), { four, re4 });
    ok("페이지 오류 없음 (3)", errors.length === 0, errors);
    await ctx.close();

    // ===================== 4. old session / broken value ======================
    console.log("4. 옛 세션 · 깨진 값");
    const old = makeBackend();
    old.st.session = sessionWith(files, 4);
    ({ ctx, page, errors } = await openPage(browser, url, old));
    await until(() => page.$(`.mpane[data-slot="0"] .cm-line`), 10000);
    const go4 = await gridRect(page);
    const ro = await rects(page);
    ok("옛 세션(필드 없음) → 균등", ro.every((p) => near(p.w, (go4.width - GAP) / 2) && near(p.h, (go4.height - GAP) / 2)));
    await page.click('.seg-btn[title="3칸"]');
    s = await saved(page, old);
    ok("끌지 않으면 세션에 paneSizes 안 씀", !("paneSizes" in s), Object.keys(s));
    await ctx.close();
    const bad = makeBackend();
    bad.st.session = sessionWith(files, 4, { paneSizes: { "4": { cols: [[0.5, 0.5]], rows: [1] }, "3": { cols: [[0, 0, 0]], rows: [1] }, x: 1 } });
    ({ ctx, page, errors } = await openPage(browser, url, bad));
    await until(() => page.$(`.mpane[data-slot="0"] .cm-line`), 10000);
    const rb = await rects(page);
    const gb = await gridRect(page);
    ok("깨진 저장값 → 균등, 오류 없음", rb.length === 4 && rb.every((p) => near(p.w, (gb.width - GAP) / 2)) && errors.length === 0, { rb, errors });
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
    go.kill();
  }
  console.log(`\nmultiview-resize-e2e: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  if (fails.length) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
