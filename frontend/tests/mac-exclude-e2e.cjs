// Headless test of 「🚫 제외에 추가」 picked with the mouse the way a Mac user does
// (10-29: a Mac tester's drag → right-click → 제외 「didn't quite apply」 on the
// first chip; Windows was fine). The same steps in chromium, webkit, and webkit
// with MACEMU — what WKWebView on macOS does that WebKit on Windows does not:
//  - a context click (right button, Ctrl+click) sends contextmenu on the press;
//  - a context click not inside the selection first selects the word under it
//    (WebKit EventHandler::sendContextMenuEvent, EditingBehavior Mac).
// Real mouse drags (down / move / up), then right-click / Ctrl+click / a
// two-finger tap (the contextmenu event only) on, beside or away from the text.
//  A. 「🏷 줄만」 rows   B. 「📖 읽기」 rows   C. the whole-file editor's menu
//  D. a big file, in the middle: the place is kept after a quick pick
// Set-up copied from exclude-ctx-e2e.cjs (frontend/dist + the REAL engine via
// the Go helper TestFilterE2EServer, the other bindings faked on the Node side).
//
//   cd frontend && npm run build && node tests/mac-exclude-e2e.cjs
//   MODES=chromium,webkit,webkit+mac (default)   ONLY=A,B,C,D   TABLE=<file> (the comparison as JSON)
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFileSync } = require("child_process");
const PW = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

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

async function openPage(browser, url, be, viewport = { width: 1400, height: 900 }, inits = []) {
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
  for (const f of inits) await page.addInitScript(f); // MACEMU, PROBE
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

// ---- macOS WKWebView, as far as WebKit on Windows does not do it (MACEMU) ----------------------
// WebKit's EventHandler::sendContextMenuEvent, only with EditingBehavior Mac
// (shouldSelectOnContextualMenuClick): before the contextmenu event goes out,
// a press that is not inside the selection selects the word under it when it
// is over text. And macOS sends the context menu on the press (right button,
// Ctrl+click), not on the release as Windows does.
const MACEMU = () => {
  window.__macEmu = true;
  const cls = (c) => (/[\p{L}\p{N}_]/u.test(c) ? "w" : /\s/.test(c) ? "s" : "p:" + c);
  const textAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) return n;
    }
    return null;
  };
  const wordRange = (n, x) => {
    const t = n.data;
    const r = document.createRange();
    let k = -1;
    for (let i = 0; i < t.length; i++) {
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      const q = r.getBoundingClientRect();
      if (x >= q.left && x < q.right) {
        k = i;
        break;
      }
    }
    if (k < 0) return null;
    const c = cls(t[k]);
    let a = k;
    let b = k + 1;
    if (c === "w" || c === "s") {
      while (a > 0 && cls(t[a - 1]) === c) a--;
      while (b < t.length && cls(t[b]) === c) b++;
    }
    r.setStart(n, a);
    r.setEnd(n, b);
    return r;
  };
  const inSel = (x, y) => {
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return false;
    const c = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    if (!c) return false;
    try {
      return s.getRangeAt(0).comparePoint(c.startContainer, c.startOffset) === 0;
    } catch {
      return false;
    }
  };
  // the context menu on the press: the trusted one the engine sends on the release is dropped
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (e.isTrusted) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      if (!inSel(e.clientX, e.clientY)) {
        const n = textAt(e.clientX, e.clientY);
        const r = n && wordRange(n, e.clientX);
        if (r) {
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      }
    },
    true
  );
  // the button is still down (macOS sends it on the press): buttons = 2, or 1 for Ctrl+click
  window.__macCtx = (x, y, ctrl) => {
    const t = document.elementFromPoint(x, y);
    if (t) t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, buttons: ctrl ? 1 : 2, ctrlKey: !!ctrl, view: window }));
  };
  window.addEventListener("mousedown", (e) => {
    if (!e.isTrusted || !(e.button === 2 || (e.button === 0 && e.ctrlKey))) return;
    const { clientX: x, clientY: y, ctrlKey } = e;
    setTimeout(() => window.__macCtx(x, y, ctrlKey), 0); // after the press's own handling, like WebKit
  });
};
// what each step saw (registered after MACEMU: the selection the app reads)
const PROBE = () => {
  window.__log = [];
  const sel = () => String(getSelection());
  for (const ev of ["mousedown", "mouseup", "contextmenu", "click"])
    window.addEventListener(ev, (e) => window.__log.push(`${ev}:${e.button}${e.ctrlKey ? "c" : ""}${e.isTrusted ? "" : "s"}「${sel()}」`), true);
};

// the box of `text` (k-th) in `q`, from its text nodes
const textBox = (page, q, text, k = 0) =>
  page.evaluate(
    ({ q, text, k }) => {
      const el = document.querySelector(q);
      if (!el) return null;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = "";
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        nodes.push([n, all.length]);
        all += n.data;
      }
      let p = -1;
      for (let i = 0; i <= k; i++) p = all.indexOf(text, p + 1);
      if (p < 0) return null;
      const at = (o) => {
        let j = 0;
        while (j + 1 < nodes.length && nodes[j + 1][1] <= o) j++;
        return [nodes[j][0], o - nodes[j][1]];
      };
      const r = document.createRange();
      r.setStart(...at(p));
      const [en, eo] = at(p + text.length - 1);
      r.setEnd(en, eo + 1);
      const b = r.getBoundingClientRect();
      const cw = b.width / text.length;
      return { x0: b.left, x1: b.right, y: b.top + b.height / 2, h: b.height, cw, rowRight: el.closest(".lv-row") ? el.closest(".lv-row").getBoundingClientRect().right : 0 };
    },
    { q, text, k }
  );
const row = (line) => `.lines-view .lv-row[data-line="${line}"] .lv-text`;
async function drag(page, x0, y0, x1, y1) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) await page.mouse.move(x0 + ((x1 - x0) * s) / 8, y0 + ((y1 - y0) * s) / 8);
  await page.mouse.up();
  await sleep(60);
}
// the context menu the user's way: right button, Ctrl+click, or a two-finger tap (the event only)
async function ctxAt(page, how, x, y) {
  await page.mouse.move(x, y);
  if (how === "right") {
    await page.mouse.down({ button: "right" });
    await sleep(30);
    await page.mouse.up({ button: "right" });
  } else if (how === "ctrl") {
    await page.keyboard.down("Control");
    await page.mouse.down();
    await sleep(30);
    await page.mouse.up();
    await page.keyboard.up("Control");
  } else {
    await page.evaluate(({ x, y }) => {
      const t = document.elementFromPoint(x, y);
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, view: window }));
    }, { x, y });
  }
  await sleep(80);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MODES = (process.env.MODES || "chromium,webkit,webkit+mac").split(",");
const topLine = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".lv-scroll");
    const top = sc.getBoundingClientRect().top;
    const rows = [...document.querySelectorAll(".lv-row[data-line]")].filter((e) => e.getBoundingClientRect().bottom > top + 2);
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows.length ? +rows[0].dataset.line : 0;
  });
const menuOf = (page, ed) =>
  page
    .$eval(
      ed ? ".ctx-menu:not(.lv-exctx)" : ".lv-exctx",
      (m, ed) => {
        const it = m.querySelector(ed ? ".exclude-from-text-item" : ".lv-exctx-add");
        const why = m.querySelector(ed ? ".exclude-from-text-why" : ".lv-exctx-why");
        return { text: it.textContent, on: !it.disabled, why: why ? why.textContent : "" };
      },
      ed
    )
    .catch(() => null);
const menuStr = (m, prefix) => (m ? (m.on ? m.text.replace(prefix, "") : "꺼짐: " + m.why) : "(메뉴 없음)");
const selNow = (page) => page.evaluate(() => String(getSelection()));
const C = (pattern) => ({ kind: "text", pattern, caseSensitive: false, on: true });
// the scan asked for last went with the chips that are on (not an old list)
async function sameAsChips(page, be) {
  const on = (await chips(page)).filter((c) => c.on).map((c) => c.t);
  const ls = lastStart(be);
  const req = ls ? (ls.args[0].exclude || []).map((x) => x.pattern) : null;
  return { ok: !!ls && eq(req, on), on, req };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-exclude-e2e-"));
  const P = (n) => path.join(dir, n);
  const lines = [];
  for (let i = 1; i <= 60; i++) {
    if (i === 21) lines.push(`${i} abc commonConnection keepalive`);
    else if (i === 22) lines.push(`${i} abc data`);
    else if (i % 7 === 0) lines.push(`${i} abc commonConnection keepalive`);
    else if (i % 9 === 0) lines.push(`${i} def CommonConnection upper`);
    else lines.push(`${i} plain`);
  }
  fs.writeFileSync(P("ex.log"), lines.join("\n"));
  const big = [];
  for (let i = 1; i <= 200000; i++) {
    if (i % 3 === 0) big.push(`2026-10-28 10:00:00 INFO abc commonConnection keepalive ${i}`);
    else if (i % 5 === 0) big.push(`2026-10-28 10:00:00 WARN def request ${i}`);
    else big.push(`2026-10-28 10:00:00 INFO plain ${i}`);
  }
  fs.writeFileSync(P("big.log"), big.join("\n"));
  const hitRe = /abc|def/;
  const has = (l, ex) => ex.some((f) => l.toLowerCase().includes(f.toLowerCase()));
  const isHit = (ex) => (l) => hitRe.test(l) && !has(l, ex);
  const tags = tagsJSON([R("a", "abc"), R("d", "def")]);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const table = [];
  try {
    for (const mode of MODES) {
      const [eng, flag] = mode.split("+");
      const mac = flag === "mac";
      const browser = await PW[eng].launch({ headless: true });
      const inits = mac ? [MACEMU, PROBE] : [PROBE];
      // a fresh page on ex.log: each step is a first chip
      const fresh = async (lv) => {
        const be = makeBackend();
        be.st.tags = tags;
        be.st.session = session([tab("t1", P("ex.log"), { lines: lv })], "t1");
        const o = await openPage(browser, url, be, TALL, inits);
        return { be, ...o };
      };
      const ready = async (page) => {
        await page.waitForSelector(".lines-view");
        await waitDone(page);
        await until(async () => (await page.$$(row(7))).length > 0);
      };
      const LINES = { on: true, above: 1, below: 1, off: [] };
      const READ = { on: true, read: true, big: true, above: 1, below: 1, off: [], ex: [] };
      try {
        for (const [sec, lv, name] of [
          ["A", LINES, "🏷 줄만"],
          ["B", READ, "📖 읽기"],
        ]) {
          if (!want(sec)) continue;
          console.log(`${sec}. [${mode}] ${name}: 끌어 고르기 → 우클릭 「🚫 제외에 추가」`);
          // 줄만: grep -B1 -A1 of the hits left / 읽기: every line but the hidden ones
          const ref = (ex) => (sec === "A" ? refRows(lines, isHit(ex), 1, 1) : lines.map((l, k) => `${k + 1}:${l}`).filter((r) => !has(r, ex)));
          // where the menu is opened after dragging 「commonConnection」 in line 7
          const cases = [
            { id: "1", name: "놓은 자리에서 우클릭", how: "right", at: (w) => [w.x1 - 1, w.y] },
            { id: "2", name: "가운데 두 손가락 탭(contextmenu 만)", how: "tap", at: (w) => [(w.x0 + w.x1) / 2, w.y] },
            { id: "3", name: "끝에서 반 글자 오른쪽(뒤 공백) 우클릭", how: "right", at: (w) => [w.x1 + w.cw * 0.6, w.y] },
            { id: "4", name: "시작에서 반 글자 왼쪽(앞 공백) 우클릭", how: "right", at: (w) => [w.x0 - w.cw * 0.6, w.y] },
            { id: "5", name: "끝 바로 다음 글자 위 우클릭", how: "right", at: (w) => [w.x1 + w.cw * 1.4, w.y] },
          ];
          if (mac)
            cases.push(
              { id: "6", name: "가운데 Ctrl+클릭(맥의 우클릭)", how: "ctrl", at: (w) => [(w.x0 + w.x1) / 2, w.y] },
              { id: "7", name: "끝 옆 Ctrl+클릭", how: "ctrl", at: (w) => [w.x1 + w.cw * 0.6, w.y] }
            );
          for (const c of cases) {
            const { be, ctx, page } = await fresh(lv);
            await ready(page);
            const w = await textBox(page, row(7), "commonConnection");
            await drag(page, w.x0 + 1, w.y, w.x1 - 1, w.y);
            const picked = await selNow(page);
            ok(`${sec}${c.id} (앞 조건) 끌어서 「commonConnection」 고름`, picked === "commonConnection", picked);
            const [x, y] = c.at(w);
            await ctxAt(page, c.how, x, y);
            const m = await menuOf(page, false);
            const shown = await selNow(page);
            const t = { mode, sec: sec + c.id, step: c.name, shown, menu: menuStr(m, "🚫 제외에 추가: ") };
            table.push(t);
            ok(`${sec}${c.id} ${c.name} → 메뉴 「commonConnection」 켜짐`, !!m && m.on && m.text === "🚫 제외에 추가: 「commonConnection」", m);
            ok(`${sec}${c.id} … 메뉴가 뜬 뒤 보이는 선택도 「commonConnection」`, shown === "commonConnection", shown);
            if (m && m.on) {
              const n0 = calls(be, "FilterStart").length;
              await page.click(".lv-exctx-add");
              const wantR = ref(["commonConnection"]);
              const rowsOk = eq(await waitRows(page, wantR), wantR);
              const ch = await chips(page);
              t.after = ch.map((x) => x.t).join(",");
              ok(
                `${sec}${c.id} … 누르면 칩 하나 · 요청 · 행 = 참조`,
                rowsOk && eq(ch, [{ t: "commonConnection", on: true, bad: false }]) && calls(be, "FilterStart").length === n0 + 1 && eq(lastStart(be).args[0].exclude, [C("commonConnection")]),
                { ch, rows: (await shownRows(page)).slice(0, 8) }
              );
            }
            await ctx.close();
          }
          // away from the text (another row): what is under the pointer, not the old pick
          {
            const { ctx, page } = await fresh(lv);
            await ready(page);
            const w = await textBox(page, row(7), "commonConnection");
            await drag(page, w.x0 + 1, w.y, w.x1 - 1, w.y);
            const k = await textBox(page, row(14), "keepalive");
            await ctxAt(page, "right", (k.x0 + k.x1) / 2, k.y);
            const m = await menuOf(page, false);
            table.push({ mode, sec: sec + "8", step: "고른 글자에서 먼 다른 줄 「keepalive」 위 우클릭", shown: await selNow(page), menu: menuStr(m, "🚫 제외에 추가: ") });
            ok(
              `${sec}8 고른 글자에서 먼 다른 줄 위 우클릭 → 옛 선택을 쓰지 않음 (${mac ? "맥: 그 단어" : "선택 접힘 → 꺼짐"})`,
              !!m && (mac ? m.on && m.text === "🚫 제외에 추가: 「keepalive」" : !m.on && m.why.includes("먼저 고르세요")),
              m
            );
            await ctx.close();
          }
          // past the line end / onto the next row's start / part of a word; then the second chip (d)
          {
            const { be, ctx, page } = await fresh(lv);
            await ready(page);
            const k = await textBox(page, row(7), "keepalive");
            await drag(page, k.x0 + 1, k.y, k.x1 + 60, k.y);
            await ctxAt(page, "right", k.x1 + 60, k.y);
            let m = await menuOf(page, false);
            ok(`${sec}9 줄 끝 넘어 빈칸까지 끌고 그 자리 우클릭 → 「keepalive」`, !!m && m.on && m.text === "🚫 제외에 추가: 「keepalive」", m);
            await page.keyboard.press("Escape");
            const nx = await textBox(page, `.lines-view .lv-row[data-line="8"] .lv-text`, "8 plain");
            await drag(page, k.x0 + 1, k.y, nx.x0 + 1, nx.y);
            await ctxAt(page, "right", (k.x0 + k.x1) / 2, k.y);
            m = await menuOf(page, false);
            ok(`${sec}10 다음 줄 시작에 걸쳐 끌기 → 한 줄 「keepalive」`, !!m && m.on && m.text === "🚫 제외에 추가: 「keepalive」", m);
            await page.keyboard.press("Escape");
            const w = await textBox(page, row(7), "commonConnection");
            await drag(page, w.x0 + 1, w.y, w.x0 + w.cw * 10 - 1, w.y);
            await ctxAt(page, "right", w.x0 + w.cw * 5, w.y);
            m = await menuOf(page, false);
            ok(`${sec}11 단어 일부 「commonConn」`, !!m && m.on && m.text === "🚫 제외에 추가: 「commonConn」", m);
            if (m && m.on) await page.click(".lv-exctx-add");
            let wantR = ref(["commonConn"]);
            ok(`${sec}11 … 첫 칩 「commonConn」 적용 · 행 = 참조`, eq(await waitRows(page, wantR), wantR), (await shownRows(page)).slice(0, 8));
            let sc = await sameAsChips(page, be);
            ok(`${sec}11 … 요청 = 켜진 칩 (옛 목록 아님)`, sc.ok, sc);
            // the second chip: 「data」 in line 22, opened just beside it
            const d = await textBox(page, row(22), "data");
            await drag(page, d.x0 + 1, d.y, d.x1 - 1, d.y);
            await ctxAt(page, "right", d.x1 + d.cw * 0.6, d.y);
            m = await menuOf(page, false);
            ok(`${sec}12 두 번째 칩 「data」 (끝 옆 우클릭)`, !!m && m.on && m.text === "🚫 제외에 추가: 「data」", m);
            if (m && m.on) await page.click(".lv-exctx-add");
            else await page.keyboard.press("Escape");
            wantR = ref(["commonConn", "data"]);
            ok(
              `${sec}12 … 두 칩 모두 적용 · 행 = 참조`,
              eq(await waitRows(page, wantR), wantR) && eq((await chips(page)).map((x) => x.t + (x.on ? "" : "-")), ["commonConn", "data"]),
              { chips: await chips(page), rows: (await shownRows(page)).slice(0, 10) }
            );
            sc = await sameAsChips(page, be);
            ok(`${sec}12 … 요청 = 켜진 칩 둘`, sc.ok && sc.on.length === 2, sc);
            // the first chip off and on again: still applies
            await page.click(".lv-ex .lv-chip-t");
            wantR = ref(["data"]);
            ok(`${sec}13 첫 칩 끄기 → 「data」만`, eq(await waitRows(page, wantR), wantR), (await shownRows(page)).slice(0, 10));
            await page.click(".lv-ex .lv-chip-t");
            wantR = ref(["commonConn", "data"]);
            ok(`${sec}13 첫 칩 다시 켜기 → 둘 다`, eq(await waitRows(page, wantR), wantR), (await shownRows(page)).slice(0, 10));
            sc = await sameAsChips(page, be);
            ok(`${sec}13 … 요청 = 켜진 칩 둘`, sc.ok && sc.on.length === 2, sc);
            await ctx.close();
          }
        }

        // ============ C. the whole-file editor =================================================
        if (want("C")) {
          console.log(`C. [${mode}] 전체 보기 편집기: 끌어 고르기 → 우클릭 「🚫 줄만 보기 제외에 추가」`);
          const cs = [
            { id: "1", name: "놓은 자리 우클릭", how: "right", at: (w) => [w.x1 - 1, w.y], must: true },
            { id: "2", name: "끝에서 반 글자 오른쪽 우클릭", how: "right", at: (w) => [w.x1 + w.cw * 0.6, w.y], must: false },
          ];
          if (mac) cs.push({ id: "3", name: "가운데 Ctrl+클릭", how: "ctrl", at: (w) => [(w.x0 + w.x1) / 2, w.y], must: true });
          for (const c of cs) {
            const { be, ctx, page } = await fresh({ on: false, above: 1, below: 1, off: [], ex: [] });
            await page.waitForSelector(".cm-content");
            await until(async () => (await page.textContent(".cm-content")).includes("60 plain"));
            const w = await textBox(page, ".cm-content", "commonConnection");
            await drag(page, w.x0 + 1, w.y, w.x1 - 1, w.y);
            await sleep(150); // CodeMirror reads the DOM selection
            const [x, y] = c.at(w);
            await ctxAt(page, c.how, x, y);
            const m = await menuOf(page, true);
            table.push({ mode, sec: "C" + c.id, step: "편집기 " + c.name, shown: await selNow(page), menu: menuStr(m, "🚫 줄만 보기 제외에 추가: ") });
            if (c.must) ok(`C${c.id} ${c.name} → 「commonConnection」`, !!m && m.on && m.text === "🚫 줄만 보기 제외에 추가: 「commonConnection」", m);
            else ok(`C${c.id} ${c.name} → 고른 글자이거나 꺼짐 (다른 글자는 아님)`, !!m && (m.on ? m.text === "🚫 줄만 보기 제외에 추가: 「commonConnection」" : m.why.includes("먼저 고르세요")), m);
            if (m && m.on) {
              await page.click(".ctx-menu .exclude-from-text-item");
              await sleep(700);
              await page.click(".lines-seg button:nth-child(2)");
              await page.waitForSelector(".lines-view");
              await waitDone(page);
              const wantR = refRows(lines, isHit(["commonConnection"]), 1, 1);
              ok(`C${c.id} … [🏷 줄만] 에서 첫 칩 적용 · 행 = 참조`, eq(await waitRows(page, wantR), wantR) && eq(await chips(page), [{ t: "commonConnection", on: true, bad: false }]), await chips(page));
              const sc = await sameAsChips(page, be);
              ok(`C${c.id} … 요청 = 켜진 칩`, sc.ok, sc);
            }
            await ctx.close();
          }
        }

        // ============ D. a big file, in the middle: a quick pick keeps the place ===============
        if (want("D")) {
          console.log(`D. [${mode}] 큰 파일 가운데: 끌어 고르고 우클릭 → 바로 추가 (누른 지 300ms 안)`);
          const be = makeBackend();
          be.st.tags = tags;
          be.st.session = session([tab("t1", P("big.log"), { lines: { on: true, above: 0, below: 1, off: [] } })], "t1");
          const { ctx, page } = await openPage(browser, url, be, { width: 1400, height: 900 }, inits);
          await page.waitForSelector(".lines-view");
          await waitDone(page);
          const r0 = await goPost("FilterRowOfLine", [lastStart(be).result.jobId, 0, 1, 100000]);
          await page.evaluate((r) => {
            const sc = document.querySelector(".lv-scroll");
            sc.scrollTop = r * parseFloat(getComputedStyle(document.querySelector(".lv-row")).height);
          }, r0);
          await sleep(500);
          const before = await topLine(page);
          ok("D (앞 조건) 가운데 (줄 ~100,000)", before > 99000 && before < 101000, before);
          const line = before + 9 - ((before + 9) % 3); // a hit with commonConnection a few rows down
          const w = await textBox(page, row(line), "commonConnection");
          await drag(page, w.x0 + 1, w.y, w.x1 - 1, w.y);
          await sleep(400); // a hand: the drag's own press is a while ago
          // a quick hand: the item pressed well within 300ms of the right press
          await page.mouse.move((w.x0 + w.x1) / 2, w.y);
          await page.mouse.down({ button: "right" });
          await page.mouse.up({ button: "right" });
          await page.click(".lv-exctx-add");
          await until(async () => (await viewData(page)).state === "done" && /제외/.test(await stat(page)), 8000);
          const after = await until(async () => {
            await sleep(400);
            const l = await topLine(page);
            return l > 1 && l;
          }, 5000);
          ok(`D 첫 칩 뒤에도 보던 자리 근처 (${before} → ${after})`, after >= before - 5 && after <= before + 10, { before, after });
          ok("D … 그 근처에 걸린 「commonConnection」 줄 없음", !(await page.$$eval(".lv-row.lv-hit[data-line]", (els) => els.some((e) => e.textContent.includes("commonConnection")))));
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    srv.close();
    try {
      await fetch(`http://${goAddr}/quit`);
    } catch {}
    go.kill();
  }
  // chromium / webkit / webkit+mac side by side
  console.log("\n비교표 (메뉴가 뜬 뒤 선택 · 메뉴 · 누른 뒤 칩)");
  for (const k of [...new Set(table.map((r) => r.sec))]) {
    const rs = table.filter((r) => r.sec === k);
    console.log(`  ${k} ${rs[0].step}`);
    for (const r of rs) console.log(`     ${r.mode.padEnd(11)} 선택「${r.shown}」 메뉴 ${r.menu}${r.after !== undefined ? " → 칩 " + r.after : ""}`);
  }
  if (process.env.TABLE) fs.writeFileSync(process.env.TABLE, JSON.stringify(table, null, 1));
  console.log(`\nmac-exclude-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log("  FAIL " + f);
    process.exit(1);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
