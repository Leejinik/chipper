// Tree speed with a big bundle (stage 4 fix): a filter that opens every line,
// clearing it, ↓ on the tree, a click on a file line. Fake Go side as in the
// other E2E tests; 3 servers × NDIR folders × NFILE files ≈ 10,000 lines.
//
//   cd frontend && npm run build && node tests/tree-perf.cjs
//   DIST=<dist>        measure another build (default ../dist)
//   V120_DIST=<dist>   also measure a v1.2.0 build and compare the filter
//   NDIR=33 NFILE=75   size (default ≈ 10,000 lines with the filter on)
//   CHECK=0            only print numbers (no pass/fail)
//
// Targets (plan.md 「4단계 검토 판정」): ↓ once ≤ 30 ms on a 10,000-line tree
// (key press → new line focused and painted), filter input not slower than v1.2.0.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.resolve(process.env.DIST || path.join(__dirname, "..", "dist"));
const V120 = process.env.V120_DIST ? path.resolve(process.env.V120_DIST) : "";
const NDIR = +(process.env.NDIR || 33);
const NFILE = +(process.env.NFILE || 75);
const CHECK = process.env.CHECK !== "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r1 = (x) => Math.round(x * 10) / 10;

function serve(dist) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(dist, p);
    if (!f.startsWith(dist) || !fs.existsSync(f)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

const R = "C:\\b\\bromo";
const servers = ["s1", "s2", "s3"];
const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
function backend() {
  const st = { files: {}, session: "", tags: null };
  const scanFiles = {};
  for (const sv of servers) {
    scanFiles[sv] = [];
    for (let d = 0; d < NDIR; d++)
      for (let f = 0; f < NFILE; f++) {
        const rel = `modules/d${d}/f${f % 25}.log${f >= 25 ? "." + Math.floor(f / 25) : ""}`;
        scanFiles[sv].push({ rel, size: 10, compressed: false });
        st.files[P(sv, rel)] = "x\n";
      }
  }
  const scan = { root: R, servers: servers.map((name) => ({ name, files: scanFiles[name], truncated: false, unreadable: 0 })) };
  st.tags = JSON.stringify({
    version: 1,
    tags: [
      { name: "common", rules: [], updated: "" },
      { name: "collector", rules: [], updated: "" },
      { name: "admin", rules: [], updated: "" },
    ],
    assign: { dir: { "": ["collector"], "modules/d3": ["admin"], "modules/d7": [] }, file: { "modules/d1/f5.log": ["admin"] }, name: {} },
  });
  const tab = (id, p) => ({ id, title: p.split("\\").pop(), path: p, lang: "plaintext", content: "", dirty: false, view: "editor", mtime: 1, encoding: "utf-8", reloadSeq: 0, needsLoad: true, loadError: "", label: "", logColors: "" });
  const slots = [0, 1, 2].map((i) => ({ tabId: i === 0 ? "t0" : "", mode: "read", server: servers[i] }));
  while (slots.length < 6) slots.push({ tabId: "", mode: "read", server: "" });
  st.session = JSON.stringify({ version: 3, tabs: [tab("t0", P("s1", "modules/d0/f0.log"))], activeId: "t0", splitRatio: 0.5, fontSize: 14, multi: { on: true, count: 3, slots, bundle: { root: R, servers } } });
  const impl = {
    LoadSession: () => ({ data: st.session, notice: "", detail: "", blocked: false }),
    SaveSession: () => {},
    CloseWithSession: () => {},
    LoadTags: () => ({ data: st.tags, exists: true, restored: false, broken: "", problem: "", newer: false }),
    SaveTags: (js) => {
      st.tags = js;
    },
    ReadFile: (p) => ({ path: p, name: p.split("\\").pop(), content: st.files[p] ?? "", modTime: 1, size: 2, encoding: "utf-8", binary: false, canceled: false }),
    ReadFileAs: (p) => impl.ReadFile(p),
    StatFile: () => ({ exists: true, modTime: 1, size: 2 }),
    ScanBundle: () => scan,
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
  };
  return impl;
}
const INIT = () => {
  window.__events = {};
  const call = (name) => (...args) => window.__goCall(name, args);
  window.go = { main: { App: new Proxy({}, { get: (_, name) => call(String(name)) }) } };
  window.runtime = new Proxy({ EventsOnMultiple: () => () => {} }, { get: (t, n) => t[n] || (() => undefined) });
};

// One build: returns medians in ms.
async function measure(browser, dist, label) {
  const srv = await serve(dist);
  const impl = backend();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (n, a) => (impl[n] ? impl[n](...a) : null));
  await page.addInitScript(INIT);
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForSelector(".bt-filter", { timeout: 20000 });
  await sleep(800);
  // work = event → React's commit (microtasks drained); frame = until the next paint
  const setFilter = (v) =>
    page.evaluate(async (v) => {
      const el = document.querySelector(".bt-filter");
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const t0 = performance.now();
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      const work = performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return { work, frame: performance.now() - t0 };
    }, v);
  const out = { label };
  const fw = [], ff = [], cw = [], cf = [];
  for (let i = 0; i < 5; i++) {
    const a = await setFilter("f");
    fw.push(a.work);
    ff.push(a.frame);
    const b = await setFilter("");
    cw.push(b.work);
    cf.push(b.frame);
  }
  out.filterWork = med(fw);
  out.filterFrame = med(ff);
  out.clearWork = med(cw);
  out.clearFrame = med(cf);
  await setFilter("f");
  await sleep(300);
  out.lines = await page.evaluate(() => {
    // lines the tree has (all, also those not drawn by a windowed list)
    const b = document.querySelector(".bt-body");
    return +(b?.getAttribute("data-rows") || document.querySelectorAll(".bt-row").length);
  });
  out.drawn = await page.$$eval(".bt-row", (e) => e.length);
  const keys = !!(await page.$('.bt-row[tabindex="0"]'));
  if (keys) {
    await page.focus('.bt-row[tabindex="0"]');
    const dw = [], df = [];
    for (let i = 0; i < 12; i++) {
      const r = await page.evaluate(async () => {
        const el = document.activeElement;
        const before = el?.getAttribute("data-key");
        const t0 = performance.now();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        await Promise.resolve();
        const work = performance.now() - t0;
        // until the next line holds the focus, checked once per frame (≤ 2 s)
        let frame = 0;
        for (let k = 0; k < 120; k++) {
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
          const now = document.activeElement?.getAttribute("data-key");
          if (now && now !== before) {
            frame = performance.now() - t0;
            break;
          }
        }
        return { work, frame };
      });
      dw.push(r.work);
      df.push(r.frame || 9999);
    }
    out.downWork = med(dw);
    out.downFrame = med(df);
    out.downMax = Math.max(...df);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    // wait for the last move to land
    await page.waitForFunction(() => document.activeElement?.classList.contains("bt-row"), null, { timeout: 30000 });
    out.down20Wall = Date.now() - t0;
    // a click on a file line (focus + open), synchronous part
    const cl = [];
    for (let i = 0; i < 4; i++)
      cl.push(
        await page.evaluate(async (i) => {
          const rows = [...document.querySelectorAll(".bt-row.file")];
          const el = rows[Math.min(rows.length - 1, 10 + i * 3)];
          const t0 = performance.now();
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.focus();
          el.click();
          await Promise.resolve();
          const t1 = performance.now() - t0;
          await new Promise((r) => setTimeout(r, 800));
          return t1;
        }, i)
      );
    out.clickWork = med(cl);
  }
  await ctx.close();
  srv.close();
  for (const k of Object.keys(out)) if (typeof out[k] === "number" && k !== "lines" && k !== "drawn") out[k] = r1(out[k]);
  return out;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    const now = await measure(browser, DIST, "this build");
    console.log(JSON.stringify(now));
    let v = null;
    if (V120) {
      v = await measure(browser, V120, "v1.2.0");
      console.log(JSON.stringify(v));
    }
    if (CHECK) {
      const ok = (name, cond, extra) => {
        if (!cond) failed++;
        console.log((cond ? "  ok   " : "  FAIL ") + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
      };
      ok(`(앞 조건) 거르기로 펼친 줄 수 ≥ 9,000`, now.lines >= 9000, now.lines);
      ok("↓ 한 번 (눌러서 다음 줄에 포커스·그리기까지) 중앙값 ≤ 30ms", now.downFrame <= 30, now.downFrame);
      ok("↓ 한 번 작업 시간 중앙값 ≤ 15ms", now.downWork <= 15, now.downWork);
      if (v) {
        ok("거르기 입력이 v1.2.0 보다 느리지 않음 (그리기까지)", now.filterFrame <= v.filterFrame, [now.filterFrame, v.filterFrame]);
        ok("거르기 지우기가 v1.2.0 보다 느리지 않음 (그리기까지)", now.clearFrame <= v.clearFrame * 1.1 + 5, [now.clearFrame, v.clearFrame]);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(failed ? `\ntree perf: ${failed} failed` : "\ntree perf: all targets met");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
