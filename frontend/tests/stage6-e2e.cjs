// Stage 6 headless test (stage6-impl.md): 「이 글자로 로그 색 규칙 만들기…」, common
// default rules revision 2 (and bringing an old tags.json up to it), ANSI codes,
// 줄만 보기 = 편집기 색, 줄만 보기 안 찾기 (Ctrl+F, Go FilterFind), 태그 창 느린 규칙.
// Harness copied from lines-e2e.cjs:
// Headless test of 「🏷 태그 줄만」 (LinesView) against the built frontend
// (frontend/dist) and the REAL line filter: the Filter* bindings go to a Go
// helper (go test -run TestFilterE2EServer, linefilter_e2e_test.go) that calls
// App.FilterStart/Rows/… on the real engine and relays its progress events.
// The other bindings (session, tags, files) are faked on the Node side, like
// tags-e2e.cjs. Data files are real files in a temp folder (the engine reads them).
//
//   cd frontend && npm run build && node tests/lines-e2e.cjs
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
  const st = { session: "", tags: null, calls: [], files: {}, sizes: {}, scan: null, openFiles: [] };
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
    OpenFolderDialog: () => (st.scan ? st.scan.root : ""),
    OpenFilesDialog: () => st.openFiles,
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules", "FilterFind"]);
  return {
    st,
    call: async (name, args) => {
      st.calls.push({ name, args, t: Date.now() });
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


// ---- stage 6 helpers -----------------------------------------------------------------------
const ESC = "\x1b";
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function note(s) {
  console.log("  NOTE " + s);
}
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const tagsJSON = (tags, assign = {}, extra = {}) => JSON.stringify({ version: 1, tags, assign: { dir: {}, file: {}, name: {}, ...assign }, ...extra });
// Select `text` (first occurrence) in the editor the way a drag would, then right-click on it.
async function selectInEditor(page, text, scope = "") {
  const box = await page.evaluate(
    ({ text, scope }) => {
      const root = document.querySelector(scope + " .cm-content");
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      // whole text of the lines with the node starts, to find text across spans
      const nodes = [];
      let all = "";
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        nodes.push([n, all.length]);
        all += n.data;
      }
      const at = all.indexOf(text);
      if (at < 0) return null;
      const pos = (p) => {
        let k = 0;
        while (k + 1 < nodes.length && nodes[k + 1][1] <= p) k++;
        return [nodes[k][0], p - nodes[k][1]];
      };
      const r = document.createRange();
      const [a, ao] = pos(at);
      const [b, bo] = pos(at + text.length - 1);
      r.setStart(a, ao);
      r.setEnd(b, bo + 1);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      const rc = r.getBoundingClientRect();
      return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
    },
    { text, scope }
  );
  await sleep(150); // CodeMirror reads the DOM selection
  return box;
}
async function rightClick(page, box) {
  await page.mouse.click(box.x, box.y, { button: "right" });
  await page.waitForSelector(".ctx-menu");
}
const ruleItem = (page) => page.$(".ctx-menu .rule-from-text-item");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage6-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    // =============== A. 「이 글자로 로그 색 규칙 만들기…」 ====================================
    console.log("A. 편집기 글자 선택 → 우클릭 「이 글자로 로그 색 규칙 만들기…」");
    {
      const app = [
        "10-22 00:00:03 INFO  Kafka.run : kafka rebalance started",
        "10-22 00:00:04 ERROR Kafka.run : rebalance failed",
        "10-22 00:00:05 INFO  other line",
        "10-22 00:00:06 INFO  Kafka.run : Kafka Rebalance done",
      ];
      fs.writeFileSync(P("app.log"), app.join("\n"));
      const be = makeBackend();
      be.st.tags = tagsJSON(
        [
          { name: "common", rules: [], updated: "" },
          { name: "collector", rules: [], updated: "" },
          { name: "admin", rules: [], updated: "" },
        ],
        { name: { "app.log": ["collector"] } },
        { defaults: 2 }
      );
      be.st.session = session([tab("t1", P("app.log"), { needsLoad: true })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".cm-content");
      await until(async () => (await page.textContent(".cm-content")).includes("Rebalance done"));
      // nothing selected → disabled
      const first = await page.$eval(".cm-line", (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2 };
      });
      await page.mouse.click(first.x, first.y);
      await rightClick(page, first);
      let item = await ruleItem(page);
      ok("선택 없음 → 메뉴 꺼짐 + 이유", item && (await item.isDisabled()) && (await item.getAttribute("title")).includes("먼저 고르세요"), item && (await item.getAttribute("title")));
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      // two lines → disabled
      const two = await selectInEditor(page, "kafka rebalance started10-22");
      if (two) {
        await rightClick(page, two);
        item = await ruleItem(page);
        ok("여러 줄 선택 → 꺼짐 + 이유", (await item.isDisabled()) && (await item.getAttribute("title")).includes("여러 줄"), await item.getAttribute("title"));
        await page.keyboard.press("Escape");
      } else note("여러 줄 선택을 만들지 못함(줄 사이 텍스트 노드 없음) — 단위 시험으로 대신");
      // the text
      const box = await selectInEditor(page, "kafka rebalance");
      ok("(앞 조건) 글자 선택", !!box);
      await rightClick(page, box);
      item = await ruleItem(page);
      ok("메뉴 켜짐 「이 글자로 로그 색 규칙 만들기…」", item && !(await item.isDisabled()) && (await item.textContent()).includes("이 글자로 로그 색 규칙 만들기"));
      await item.click();
      await page.waitForSelector(".rule-from-text");
      ok("창: 글자 = 고른 글자", (await page.inputValue(".rft-pattern")) === "kafka rebalance");
      ok("창: 태그 기본 = 이 파일에 붙은 태그(collector)", (await page.inputValue(".rft-tag")) === "collector");
      ok("창: 종류 기본 = 글자 그대로", (await page.inputValue(".rft-kind")) === "text");
      ok("창: 포커스가 창 안", await page.evaluate(() => !!document.activeElement.closest(".rule-from-text")));
      await page.selectOption(".rft-tag", "admin");
      ok("붙지 않은 태그 고르면 안내", (await page.textContent(".rule-from-text")).includes("「admin」 태그가 붙어 있지 않아"));
      await page.selectOption(".rft-tag", "collector");
      await page.$eval(".rft-color", (e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "#00aaff");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.check(".rft-line");
      const saves0 = calls(be, "SaveTags").length;
      await page.click(".rft-ok");
      ok("만들기 → 창 닫힘", !(await page.$(".rule-from-text")));
      await until(() => calls(be, "SaveTags").length > saves0, 3000);
      const st1 = savedTags(be);
      const col = st1.tags.find((t) => t.name === "collector");
      const r1 = col && col.rules[0];
      ok(
        "tags.json: collector 에 글자 그대로·색·줄 배경·줄만 켬",
        col.rules.length === 1 && r1.pattern === "kafka rebalance" && r1.kind === "text" && r1.color === "#00aaff" && r1.line === true && r1.filter === true && r1.caseSensitive === false,
        col
      );
      ok("다른 태그는 그대로", st1.tags.find((t) => t.name === "common").rules.length === 0 && st1.tags.find((t) => t.name === "admin").rules.length === 0);
      const blue = await until(async () => {
        const x = await page.$$eval(`.cm-content span[style*="color: ${rgb("#00aaff")}"]`, (els) => els.map((e) => e.textContent));
        return x.length >= 2 && x;
      }, 3000);
      ok("편집기에 바로 칠함 (대소문자 무시 → 두 줄)", eq(blue, ["kafka rebalance", "Kafka Rebalance"]), blue);
      const tint = await page.$$eval(".cm-line", (els) => els.map((e) => e.style.backgroundColor || ""));
      ok("줄 배경도", /0, 170, 255/.test(tint[0]) && /0, 170, 255/.test(tint[3]) && !tint[2], tint);
      ok("창 닫은 뒤 편집기로 포커스", await until(() => page.evaluate(() => !!document.activeElement.closest(".cm-editor")), 1000));
      // again: the same rule → change it, no twin
      const box2 = await selectInEditor(page, "kafka rebalance");
      await rightClick(page, box2);
      await (await ruleItem(page)).click();
      await page.waitForSelector(".rule-from-text");
      ok("같은 규칙이 있으면 알림 + 「같은 규칙 고치기」", (await page.textContent(".rft-ok")).includes("같은 규칙 고치기") && (await page.textContent(".rule-from-text")).includes("이미 있습니다"));
      await page.$eval(".rft-color", (e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "#ff00ff");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const saves1 = calls(be, "SaveTags").length;
      await page.keyboard.press("Enter");
      await until(() => calls(be, "SaveTags").length > saves1, 3000);
      const col2 = savedTags(be).tags.find((t) => t.name === "collector");
      ok("Enter = 만들기 · 두 번째는 고치기(규칙 1개, 색만 바뀜)", col2.rules.length === 1 && col2.rules[0].color === "#ff00ff" && col2.rules[0].id === r1.id, col2.rules);
      // Esc closes without a change
      const box3 = await selectInEditor(page, "other line");
      await rightClick(page, box3);
      await (await ruleItem(page)).click();
      await page.waitForSelector(".rule-from-text");
      const saves2 = calls(be, "SaveTags").length;
      await page.keyboard.press("Escape");
      await sleep(700);
      ok("Esc → 닫힘·저장 없음", !(await page.$(".rule-from-text")) && calls(be, "SaveTags").length === saves2);
      // a regex that RE2 can't do → refused, button off
      await rightClick(page, box3);
      await (await ruleItem(page)).click();
      await page.waitForSelector(".rule-from-text");
      await page.selectOption(".rft-kind", "regex");
      await page.fill(".rft-pattern", "(?<=x)other");
      ok("쓸 수 없는 정규식 → 이유 + 만들기 꺼짐", (await page.textContent(".rule-from-text")).includes("뒤돌아보기") && (await page.isDisabled(".rft-ok")));
      await page.keyboard.press("Escape");
      await ctx.close();
    }
    {
      // log colours off on the tab → turned on by creating a rule
      const be = makeBackend();
      fs.writeFileSync(P("plain.txt"), "hello world\nsecond\n");
      be.st.tags = tagsJSON([{ name: "common", rules: [], updated: "" }], {}, { defaults: 2 });
      be.st.session = session([tab("t1", P("plain.txt"), { logColors: "off" })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await until(async () => (await page.textContent(".cm-content")).includes("second"));
      const box = await selectInEditor(page, "world");
      await rightClick(page, box);
      await (await ruleItem(page)).click();
      await page.waitForSelector(".rule-from-text");
      ok("로그 색 꺼진 탭 → 「만들면 켭니다」", (await page.textContent(".rule-from-text")).includes("로그 색이 꺼져"));
      ok("붙은 태그 없는 파일 → 기본 common", (await page.inputValue(".rft-tag")) === "common");
      await page.click(".rft-ok");
      const on = await until(async () => {
        const x = await page.$$eval(`.cm-content span[style*="color: ${rgb("#c678dd")}"]`, (els) => els.map((e) => e.textContent));
        return x.length && x;
      }, 3000);
      ok("탭 로그 색이 켜지고 칠해짐", eq(on, ["world"]), on);
      await ctx.close();
    }

    // =============== B. common: old tags.json brought up to the new defaults =================
    console.log("B. 기존 tags.json 의 common 갱신 (사용자가 고친 규칙은 그대로)");
    const V1 = [
      { id: "error", on: true, label: "오류", pattern: String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`, kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true },
      { id: "warn", on: true, label: "경고", pattern: String.raw`\bWARN(ING)?\b`, kind: "regex", caseSensitive: false, color: "#e5c07b", line: false, filter: true },
      { id: "info", on: true, label: "정보", pattern: String.raw`\b(INFO|NOTICE)\b|\[Note\]`, kind: "regex", caseSensitive: false, color: "#61afef", line: false, filter: false },
      { id: "debug", on: true, label: "디버그", pattern: String.raw`\b(DEBUG|TRACE|VERBOSE)\b`, kind: "regex", caseSensitive: false, color: "#7f848e", line: false, filter: false },
      { id: "time", on: true, label: "시각", pattern: String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`, kind: "regex", caseSensitive: true, color: "#56b6c2", line: false, filter: false },
      { id: "mk119", on: true, label: "장애 신호 (클러스터·프로세스)", pattern: String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`, kind: "regex", caseSensitive: true, color: "#ff9e64", line: true, filter: true },
    ];
    const LOG = [
      "10-22 00:00:03 ERROR JedisSentinelPool.run : Lost connection to Sentinel", // 1 level → tint
      "10-22 00:00:04 INFO  Redis.run : failed to connect (unknown error)", // 2 body → no tint
      "2026.10.22 00:10:52.033122 [ 132580 ] {BgSchPool::4dfe25b9-236d-44fd-9909-c57fda5770d0} <Error> liz.checkvalue", // 3 <Error> → tint
      "INFO: I/O exception (java.net.NoRouteToHostException) caught when processing", // 4 → no tint
      "[2026-10-22 00:07:36,193] WARN [Controller id=1] slow", // 5
      `${ESC}[31m2026-10-20 09:32:56${ESC}[0m [${ESC}[1;31mWARN${ESC}[0m] colour codes`, // 6 ANSI
      "plain line without anything", // 7
      "Oct 18 23:00:00 server01 kernel: Out of memory: Killed process 123", // 8
    ];
    fs.writeFileSync(P("mix.log"), LOG.join("\n"));
    {
      const be = makeBackend();
      const mine = { id: "u1", on: true, label: "내 규칙", pattern: "Sentinel", kind: "text", caseSensitive: false, color: "#00ff00", line: false, filter: true };
      be.st.tags = tagsJSON([{ name: "common", rules: [...V1, mine], updated: "" }]);
      be.st.session = session([tab("t1", P("mix.log"))], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await until(async () => (await page.textContent(".cm-content")).includes("colour codes"));
      await until(() => calls(be, "SaveTags").length > 0, 3000);
      const st = savedTags(be);
      const ids = st.tags[0].rules.map((r) => r.id);
      ok("손대지 않은 v1 common → 새 판(오류 3개로) · 내 규칙은 끝에 그대로", eq(ids, ["error", "error-ck", "fail", "warn", "info", "debug", "time", "mk119", "u1"]), ids);
      ok("revision 2 기록", st.defaults === 2, st.defaults);
      const tints = await page.$$eval(".cm-line", (els) => els.map((e) => e.style.backgroundColor || ""));
      const red = (t) => /255, 107, 107/.test(t);
      ok("레벨 자리 ERROR 줄 → 배경", red(tints[0]), tints[0]);
      ok("INFO 줄의 failed·(unknown error) → 배경 없음", !tints[1], tints[1]);
      ok("ClickHouse <Error>(90자 뒤) → 배경", red(tints[2]), tints[2]);
      ok("INFO: I/O exception → 배경 없음", !tints[3], tints[3]);
      ok("장애 신호 줄 → 배경(주황)", /255, 158, 100/.test(tints[7]), tints[7]);
      const cyan = await page.$$eval(`.cm-content span[style*="color: ${rgb("#56b6c2")}"]`, (els) => els.map((e) => e.textContent));
      ok("시각: liz·ClickHouse·kafka·ANSI 줄·syslog", eq(cyan, ["10-22 00:00:03", "10-22 00:00:04", "2026.10.22 00:10:52.033122", "2026-10-22 00:07:36,193", "2026-10-20 09:32:56", "Oct 18 23:00:00"]), cyan);
      const yellow = await page.$$eval(`.cm-content span[style*="color: ${rgb("#e5c07b")}"]`, (els) => els.map((e) => e.textContent));
      ok("ANSI 줄의 WARN 도 경고 색", eq(yellow, ["WARN", "WARN"]), yellow);
      const dim = await page.$$eval(".cm-content .cm-ansi", (els) => els.length);
      ok("ANSI 코드 4개는 흐리게(.cm-ansi)", dim >= 4, dim);
      const red2 = await page.$$eval(`.cm-content span[style*="color: ${rgb("#ff6b6b")}"]`, (els) => els.map((e) => e.textContent));
      ok("본문 failed·error·Exception 은 글자색", ["failed", "error", "exception", "NoRouteToHostException", "ERROR"].every((w) => red2.includes(w)), red2);
      const ckRed = await page.$$eval(`.cm-line:nth-child(3) span[style*="color: ${rgb("#ff6b6b")}"]`, (els) => els.map((e) => e.textContent).join(""));
      ok("<Error> 도 빨갛게", ckRed === "<Error>", ckRed);
      await openTagWindow(page);
      const notice = await page.textContent(".tags-dialog");
      ok("태그 창에 갱신 알림", notice.includes("common 기본 규칙을 새 판으로 바꿨습니다"), notice.slice(0, 300));
      const heads = await page.$$eval(".tags-dialog .rule-row", (rows) => rows.map((r) => (r.querySelector(".rule-head") ? r.querySelector(".rule-head").value : null)));
      ok("오류(레벨) 줄에 「줄 배경 자리 60」 칸", heads[0] === "60" && heads[1] === "" && heads[2] === null, heads);
      const savesH = calls(be, "SaveTags").length;
      await page.fill(".tags-dialog .rule-row:nth-of-type(1) .rule-head", "");
      await page.click(".tags-dialog .tags-apply"); // 적용(10-28)
      await until(() => calls(be, "SaveTags").length > savesH, 3000);
      ok("칸을 비우면 lineHead 없음(어디서든 줄 배경)으로 저장", savedTags(be).tags[0].rules[0].lineHead === undefined, savedTags(be).tags[0].rules[0]);
      await page.fill(".tags-dialog .rule-row:nth-of-type(1) .rule-head", "60");
      await page.click(".tags-dialog .tags-apply"); // 적용(10-28)
      await until(() => savedTags(be).tags[0].rules[0].lineHead === 60, 3000);
      ok("다시 60 → 저장", savedTags(be).tags[0].rules[0].lineHead === 60);
      await page.keyboard.press("Escape");

      // ---- C. 줄만 보기 keeps exactly the lines the editor colours with 「줄만」 rules ----
      console.log("C. 줄만 보기 = 편집기에서 「줄만」 규칙으로 칠해진 줄 (ANSI 포함)");
      // 오류(레벨)·오류 낱말 / 경고 / 장애 / 내 규칙 — error-ck(빨강, 줄만 끔)의 글자는 오류 낱말에도 걸림
      const filterColours = ["#ff6b6b", "#e5c07b", "#ff9e64", "#00ff00"].map(rgb);
      const coloured = await page.$$eval(
        ".cm-line",
        (els, cs) => els.map((e, i) => ([...e.querySelectorAll("span[style]")].some((s) => cs.includes(s.style.color)) ? i + 1 : 0)).filter(Boolean),
        filterColours
      );
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await setCtx(page, 0, 0);
      await sleep(400);
      const kept = (await shownRows(page)).filter((r) => !r.startsWith("⋯")).map((r) => +r.split(":")[0]);
      ok("줄만 보기에 남은 줄 = 편집기에서 줄만 규칙 색이 칠해진 줄", eq(kept, coloured), { kept, coloured });
      ok("ANSI WARN 줄(6)도 걸림", kept.includes(6), kept);
      const tintRows = await page.$$eval(".lv-row[data-line]", (els) => els.filter((e) => e.style.backgroundColor).map((e) => +e.dataset.line));
      ok("줄만 보기 줄 배경 = 편집기와 같음 (1·3·8)", eq(tintRows, [1, 3, 8]), tintRows);
      const lvDim = await page.$$eval('.lv-row[data-line="6"] span[style*="opacity"]', (els) => els.length);
      ok("줄만 보기에서도 ANSI 코드 흐리게", lvDim === 4, lvDim);
      await ctx.close();
    }
    {
      // the user changed 오류's colour: kept, named; a second start writes nothing
      const be = makeBackend();
      const v1 = V1.map((r) => (r.id === "error" ? { ...r, color: "#ff0000" } : r));
      be.st.tags = tagsJSON([{ name: "common", rules: v1, updated: "" }]);
      be.st.session = session([tab("t1", P("mix.log"))], "t1");
      let { ctx, page } = await openPage(browser, url, be);
      await until(() => calls(be, "SaveTags").length > 0, 3000);
      let st = savedTags(be);
      ok("고친 오류는 그대로(색·패턴), 시각은 새 판", st.tags[0].rules[0].color === "#ff0000" && st.tags[0].rules[0].pattern === V1[0].pattern && st.tags[0].rules.find((r) => r.id === "time").pattern !== V1[4].pattern, st.tags[0].rules.map((r) => r.id));
      await openTagWindow(page);
      ok("알림: 고친 기본 규칙 「오류」 그대로", (await page.textContent(".tags-dialog")).includes("직접 고친 기본 규칙 1개(「오류」)"));
      await ctx.close();
      const n = calls(be, "SaveTags").length;
      ({ ctx, page } = await openPage(browser, url, be));
      await until(async () => (await page.textContent(".cm-content")).includes("colour codes"));
      await sleep(900);
      ok("다시 켜면 tags.json 안 씀(한 번만)", calls(be, "SaveTags").length === n, calls(be, "SaveTags").length - n);
      ok("다시 켜면 알림 없음", !(await page.$(".st-tags-warn")));
      await ctx.close();
    }

    // =============== D. 줄만 보기 안 찾기 (Ctrl+F) ===========================================
    console.log("D. 줄만 보기 안 찾기 (Ctrl+F) — 결과 전체(Go)");
    {
      const big = [];
      for (let i = 1; i <= 30000; i++) big.push(i % 10 === 0 ? `2026-10-20 ERROR dev-${i} lost` : i % 10 === 1 ? `next ${i} Dev-${i - 1} retry` : `info ${i}`);
      big.push("2026-10-20 ERROR last-one-needle");
      fs.writeFileSync(P("big.log"), big.join("\n"));
      const be = makeBackend();
      be.st.tags = tagsJSON([{ name: "common", rules: [{ id: "e", on: true, label: "오류", pattern: "ERROR", kind: "text", caseSensitive: true, color: "#ff6b6b", line: false, filter: true }], updated: "" }], {}, { defaults: 2 });
      be.st.session = session([tab("t1", P("big.log"), { lines: { on: true, above: 0, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await page.focus(".lv-scroll");
      await page.keyboard.press("Control+f");
      await page.waitForSelector(".lv-find");
      ok("Ctrl+F → 줄만 보기 찾기 칸 (편집기 찾기 창 아님)", !(await page.$(".find-panel")) && (await page.evaluate(() => document.activeElement.classList.contains("lv-find-input"))));
      await page.fill(".lv-find-input", "dev-29");
      const stat = await until(async () => {
        const t = await page.textContent(".lv-find-count");
        return /줄/.test(t) && t;
      }, 5000);
      // rows (above 0, below 1): every ERROR line + its next line; dev-29xx(x) in both
      const want = big.filter((l, i) => /ERROR/.test(l) || (i > 0 && /ERROR/.test(big[i - 1]))).filter((l) => l.toLowerCase().includes("dev-29")).length;
      ok(`개수 = 결과 전체에서 센 수 (${want}줄)`, stat === `${want}줄`, stat);
      const t0 = Date.now();
      await page.keyboard.press("Enter");
      const sel1 = await until(async () => page.$eval(".lv-row.sel", (e) => ({ row: +e.dataset.row, text: e.querySelector(".lv-text").textContent })).catch(() => null), 3000);
      ok("Enter → 첫 일치 행 선택(첫 화면 밖 행)", sel1 && /dev-290/i.test(sel1.text) && sel1.row > 50, sel1);
      ok(`… 화면에 보임 (${Date.now() - t0}ms)`, sel1 && Date.now() - t0 < 3000);
      ok("「1 / N줄」", (await page.textContent(".lv-find-count")) === `1 / ${want}줄`, await page.textContent(".lv-find-count"));
      await page.keyboard.press("Enter");
      const sel2 = await until(async () => {
        const s = await page.$eval(".lv-row.sel", (e) => +e.dataset.row).catch(() => -1);
        return s > sel1.row && s;
      }, 3000);
      ok("Enter → 다음", !!sel2 && (await page.textContent(".lv-find-count")) === `2 / ${want}줄`);
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.press("Shift+Enter");
      const sel3 = await until(async () => {
        const s = await page.$eval(".lv-row.sel", (e) => +e.dataset.row).catch(() => -1);
        return s > sel2 && s;
      }, 3000);
      ok("Shift+Enter 두 번 → 처음 앞이라 마지막으로 돌아감", !!sel3 && (await page.textContent(".lv-find-count")) === `${want} / ${want}줄`, await page.textContent(".lv-find-count"));
      const hl = await page.evaluate(() => (CSS.highlights.get("lv-find") ? CSS.highlights.get("lv-find").size : 0));
      const cur = await page.evaluate(() => (CSS.highlights.get("lv-find-cur") ? [...CSS.highlights.get("lv-find-cur")].map((r) => r.toString()) : []));
      ok("화면의 일치 글자 강조(CSS Highlight)", hl > 0, hl);
      ok("지금 행의 일치는 따로 강조", cur.length === 1 && /dev-29/i.test(cur[0]), cur);
      // case / word / regex
      await page.check(".lv-find-opt:nth-of-type(1) input");
      await until(async () => /줄|없음/.test(await page.textContent(".lv-find-count")));
      await sleep(400);
      const wantCs = big.filter((l, i) => /ERROR/.test(l) || (i > 0 && /ERROR/.test(big[i - 1]))).filter((l) => l.includes("dev-29")).length;
      ok(`대소문자 구분 → ${wantCs}줄`, (await page.textContent(".lv-find-count")).endsWith(`${wantCs}줄`), await page.textContent(".lv-find-count"));
      await page.uncheck(".lv-find-opt:nth-of-type(1) input");
      await page.check(".lv-find-opt:nth-of-type(3) input");
      await page.fill(".lv-find-input", "(?<=x)a");
      await until(async () => (await page.textContent(".lv-find-count")).includes("쓸 수 없음"));
      ok("정규식 뒤돌아보기 → 「쓸 수 없음: 이유」", (await page.textContent(".lv-find-count")).includes("뒤돌아보기"), await page.textContent(".lv-find-count"));
      await page.fill(".lv-find-input", String.raw`needle$`);
      await until(async () => (await page.textContent(".lv-find-count")).includes("1줄"), 4000);
      await page.keyboard.press("Enter");
      const last = await until(async () => page.$eval(".lv-row.sel", (e) => e.querySelector(".lv-text").textContent).catch(() => null), 3000);
      ok("정규식 needle$ → 맨 끝 행으로", last && last.includes("last-one-needle"), last);
      // N change → found again for the new rows
      const fc0 = calls(be, "FilterFind").length;
      await setCtx(page, 0, 0);
      await until(() => calls(be, "FilterFind").length > fc0, 3000);
      ok("위·아래 N 바꾸면 다시 찾음", calls(be, "FilterFind").length > fc0);
      ok("N 바꿔도 다시 거르지 않음", calls(be, "FilterStart").length === 1);
      // Esc → closed, focus back to the rows
      await page.focus(".lv-find-input");
      await page.keyboard.press("Escape");
      ok("Esc → 찾기 닫힘 · 행 목록으로 포커스", !(await page.$(".lv-find")) && (await page.evaluate(() => document.activeElement.classList.contains("lv-scroll"))));
      const hl2 = await page.evaluate(() => !!CSS.highlights.get("lv-find"));
      ok("닫으면 강조 지움", !hl2);
      // the toolbar's 찾기 button with the lines view → its find bar, not the editor's
      await page.click('button[title^="찾기/바꾸기"]');
      await page.waitForSelector(".lv-find", { timeout: 2000 }).catch(() => {});
      ok("툴바 찾기 → 줄만 보기 찾기 칸", !!(await page.$(".lv-find")) && !(await page.$(".find-panel")));
      await ctx.close();
    }

    // =============== E. 태그 창에 느린 규칙 ===================================================
    console.log("E. 태그 창에 느린 규칙 표시");
    {
      const many = [];
      for (let i = 1; i <= 40; i++) many.push(i % 2 ? `ERROR line ${i} abc12x` : `ok ${i}`);
      fs.writeFileSync(P("many.log"), many.join("\n"));
      await goGet("/reset?dfaMemory=600");
      const be = makeBackend();
      be.st.tags = tagsJSON(
        [
          {
            name: "common",
            rules: [
              { id: "e", on: true, label: "오류", pattern: "ERROR", kind: "text", caseSensitive: true, color: "#ff6b6b", line: false, filter: true },
              { id: "x", on: true, label: "폭발", pattern: "[a-z].{0,25}[0-9]{2}[^0-9]", kind: "regex", caseSensitive: false, color: "#aaaaaa", line: false, filter: true },
            ],
            updated: "",
          },
        ],
        {},
        { defaults: 2 }
      );
      be.st.session = session([tab("t1", P("many.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await until(async () => (await notes(page)).some((x) => x.includes("느린 규칙")), 3000);
      await openTagWindow(page);
      // the engine reports what fell back to the slow matcher (with a 600B DFA budget the
      // whole group can: then every rule of it) — the window shows exactly those
      const reported = await page.$$eval(".lv-note", (els) => els.map((e) => e.textContent).find((t) => t.includes("느린 규칙")) || "");
      const slowNames = ["오류", "폭발"].filter((n) => reported.includes(`「common · ${n}」`));
      const slow = await page.$$eval(".tags-dialog .rule-slow", (els) => els.map((e) => e.textContent));
      ok(`태그 창: 줄만 보기가 알린 느린 규칙(${slowNames.join("·")})마다 「🐢 느림」`, slowNames.includes("폭발") && slow.length === slowNames.length && slow.every((t) => t.includes("줄만 보기에서 느린 방식")), { slow, reported });
      const rows = await page.$$eval(".tags-dialog .rules-list > *", (els) => els.map((e) => e.className));
      ok("…해당 규칙 줄 바로 아래", rows.every((c, i) => c !== "rule-problem rule-slow" || rows[i - 1].startsWith("rule-row")) && rows[rows.length - 1] === "rule-problem rule-slow", rows);
      ok(`태그 창 위 요약 「느렸던 규칙 ${slowNames.length}개」`, (await page.textContent(".tags-dialog")).includes(`느렸던 규칙 ${slowNames.length}개`));
      // edit the pattern → its note goes (the new pattern has not run yet)
      const pat = (await page.$$(".tags-dialog .rule-pattern"))[1];
      await pat.fill("[a-z].{0,25}[0-9]{2}[^0-9]x");
      ok("패턴을 고치면 그 규칙의 「느림」 사라짐", (await page.$$(".tags-dialog .rule-slow")).length === slowNames.length - 1);
      await page.keyboard.press("Escape");
      await ctx.close();
      await goGet("/reset");
    }
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  console.log(`\nstage6-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
