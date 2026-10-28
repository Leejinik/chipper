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
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules"]);
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

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lines-e2e-"));
  const P = (n) => path.join(dir, n);
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    // =============== 1. common only (no tag on the file) · rows · colours · no read =========
    console.log("1. 태그 없는 파일 = common 규칙으로 걸러짐 · 행 · 색 · 파일을 읽지 않음");
    const plain = [];
    for (let i = 1; i <= 60; i++)
      plain.push(i === 10 || i === 30 ? `2026-10-20 10:00:${String(i).padStart(2, "0")} ERROR boom ${i}` : i === 50 ? `10:01 WARN slow ${i}` : `2026-10-20 10:00:00 INFO line ${i}`);
    fs.writeFileSync(P("plain.log"), plain.join("\n"));
    const isErrWarn = (l) => /\b(ERROR|WARN)\b/.test(l);
    if (want("1")) {
      const be = makeBackend();
      be.st.session = session([tab("t1", P("plain.log"), { lines: { on: true, above: 1, below: 2, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const tagsShown = await page.$$eval(".lv-tag", (els) => els.map((e) => e.textContent.trim()));
      ok("태그 체크 = common 만 (태그 없어도 common 적용)", JSON.stringify(tagsShown) === '["common"]', tagsShown);
      const st0 = calls(be, "FilterStart")[0];
      // stage 6: 오류 = 오류(레벨) + 오류·실패 낱말 (괄호 레벨 규칙은 줄만 끔)
      ok("common 의 「줄만」 규칙 4개(오류 레벨·오류 낱말·경고·장애)로 거름", st0 && st0.args[0].rules.length === 4, st0 && st0.args[0].rules.map((r) => r.pattern.slice(0, 20)));
      ok("요청 인코딩 = 탭 인코딩(utf-8)", st0 && st0.args[0].encoding === "utf-8", st0 && st0.args[0].encoding);
      const want = refRows(plain, isErrWarn, 1, 2);
      ok("행 = grep -B1 -A2 (원래 줄 번호·생략 행)", JSON.stringify(await waitRows(page, want)) === JSON.stringify(want), await shownRows(page));
      ok("파일을 편집기로 읽지 않음(ReadFile 없음)", calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 0);
      const red = await page.$$eval(`.lv-row.lv-hit span[style*="color: ${rgb("#ff6b6b")}"]`, (els) => els.map((e) => e.textContent));
      ok("걸린 줄의 ERROR 를 오류 색으로 칠함", red.filter((x) => x === "ERROR").length === 2, red);
      const tint = await page.$eval('.lv-row[data-line="10"]', (e) => e.style.backgroundColor);
      ok("오류 줄 배경(줄 규칙)도 편집기처럼", /rgba\(255, 107, 107/.test(tint), tint);
      const vd = await viewData(page);
      ok("첫 화면 시간 기록(data-first-ms)", vd.firstMs !== undefined, vd);
      const stat = await page.$eval(".lv-stat", (e) => e.textContent);
      ok("상태: 걸린 줄 3 · 행 수 · 전체 줄 수", /걸린 줄 3 · \d+행 \/ 전체 60줄/.test(stat), stat);
      await shot(page, "lines-1.png");

      // ---- 7. context sizes: redraw without a new scan --------------------------------------
      console.log("7. 위·아래 N 바꾸기 — 다시 훑지 않고 다시 그림");
      const startsBefore = calls(be, "FilterStart").length;
      await setCtx(page, 0, 0);
      let w = refRows(plain, isErrWarn, 0, 0);
      ok("위 0 아래 0", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      await setCtx(page, 3, 5);
      w = refRows(plain, isErrWarn, 3, 5);
      ok("위 3 아래 5 (위·아래 따로)", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      ok("N 바꿔도 FilterStart 다시 안 부름", calls(be, "FilterStart").length === startsBefore);
      const rd = await until(async () => (await viewData(page)).redrawMs, 3000);
      ok(`다시 그린 시간 기록 (${rd}ms)`, rd !== undefined && +rd < 1000, rd);
      await sleep(600); // autosave
      const saved = JSON.parse(be.st.session).tabs[0].lines;
      ok("세션에 위·아래 저장", saved && saved.above === 3 && saved.below === 5 && saved.on === true, saved);

      // ---- 6. jump to the whole file, same colours ---------------------------------------------
      console.log("6. 행 → 전체 보기의 그 줄 · 같은 색");
      const spansOf = (sel) =>
        page.$$eval(sel + " span[style*=color]", (els) => els.map((e) => [e.textContent, getComputedStyle(e).color]));
      const inView = await spansOf('.lv-row[data-line="30"] .lv-text');
      await page.dblclick('.lv-row[data-line="30"] .lv-text');
      await page.waitForSelector(".cm-editor");
      await until(async () => (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "30", 4000);
      const gut = await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "");
      ok("두 번 누르면 전체 보기로 · 그 줄(30)에 커서", gut === "30", gut);
      const inEditor = await spansOf(".cm-activeLine");
      ok("같은 줄의 색이 편집기와 같음", inView.length > 0 && JSON.stringify(inView) === JSON.stringify(inEditor), { inView, inEditor });
      ok("전체 보기로 갈 때 파일을 읽음", calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 1);
      // back to 「태그 줄만」: comes back where it was
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      ok("다시 「줄만」 → 위 3 아래 5 그대로", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w));
      // Enter on a selected row, click on a line number
      await page.click('.lv-row[data-line="50"] .lv-text');
      await page.focus(".lv-scroll");
      await page.keyboard.press("Enter");
      await until(async () => (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "50", 4000);
      ok("Enter → 그 줄(50)", (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "50");
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await page.click('.lv-row[data-line="10"] .lv-no');
      await until(async () => (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "10", 4000);
      ok("줄 번호 누르기 → 그 줄(10)", (await page.$eval(".cm-activeLineGutter", (e) => e.textContent).catch(() => "")) === "10");
      // a gap row stands for its first line
      await page.click(".lines-seg button:nth-child(2)");
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await setCtx(page, 0, 0);
      await waitRows(page, refRows(plain, isErrWarn, 0, 0));
      const gapTitle = await page.$eval(".lv-row.lv-gap", (e) => e.getAttribute("title"));
      ok("생략 행 풍선 = 줄 범위", /줄 1–9 생략/.test(gapTitle), gapTitle);
      // copy selected rows
      await page.click('.lv-row[data-line="10"] .lv-text');
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.up("Shift");
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await page.keyboard.press("Control+c");
      const clip = await until(() => page.evaluate(() => window.__clip), 2000);
      ok("Shift+↓ 로 고른 행 복사 (생략 행 포함)", clip === `${plain[9]}\n⋯ 19줄 생략\n${plain[29]}`, clip);
      await ctx.close();
    }

    // =============== 2. tab encoding goes to the engine; never-read tab = detect ==============
    console.log("2. 탭 인코딩을 엔진에 넘김");
    if (want("2")) {
      // a real CP949 file: 「오류」 lines
      const kr = ["시작", "오류 발생 1", "정상", "오류 발생 2", "끝"].join("\n");
      execFileSync("python", ["-c", `open(r'${P("kr.log")}','wb').write(${JSON.stringify(kr)}.encode('cp949'))`]);
      const be = makeBackend();
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [{ name: "common", rules: [{ id: "k", on: true, label: "오류", pattern: "오류", kind: "text", caseSensitive: false, color: "#cc0101", line: false, filter: true }], updated: "" }],
        assign: { dir: {}, file: {}, name: {} },
      });
      be.st.session = session(
        [
          tab("t1", P("kr.log"), { encoding: "cp949", lines: { on: true, above: 0, below: 0, off: [] } }),
          tab("t2", P("plain.log"), { encAuto: true, lines: { on: true, above: 0, below: 0, off: [] } }),
        ],
        "t1"
      );
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const s = calls(be, "FilterStart");
      ok("CP949 탭 → encoding cp949 로 요청", s[0] && s[0].args[0].encoding === "cp949", s[0] && s[0].args[0].encoding);
      const w = refRows(kr.split("\n"), (l) => l.includes("오류"), 0, 0);
      ok("한글 규칙이 CP949 파일에서 걸림", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      // the never-read tab (opened straight into 「태그 줄만」): "" = engine detects
      await page.click(".tab:nth-child(2)");
      await until(() => calls(be, "FilterStart").length >= 2);
      ok("읽은 적 없는 탭 → encoding \"\" (엔진이 판별)", calls(be, "FilterStart")[1]?.args[0].encoding === "", calls(be, "FilterStart")[1]?.args[0].encoding);
      const encBtn = await page.$eval(".st-enc", (e) => e.textContent);
      ok("상태 표시줄 인코딩 = 자동 판별", encBtn.includes("자동 판별"), encBtn);
      // 「다른 인코딩으로 다시 열기」 on such a tab: no read, filter again with that encoding
      await page.dispatchEvent(".st-enc", "mousedown");
      await page.click('.enc-menu .menu-item:has-text("UTF-16 LE") >> nth=1');
      await until(() => calls(be, "FilterStart").length >= 3);
      ok("인코딩 바꾸기 → 그 인코딩으로 다시 거름", calls(be, "FilterStart")[2]?.args[0].encoding === "utf-16le", calls(be, "FilterStart").map((c) => c.args[0].encoding));
      ok("인코딩 바꿔도 파일을 편집기로 읽지 않음", calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 0);
      await ctx.close();
    }

    // =============== 3. appended lines: the end is fetched again; rewrite = start again ========
    console.log("3. 덧붙음(version) → 끝부분 다시 받기 · 다시 쓰기(changed) → 처음부터");
    if (want("3")) {
      const base = ["a1", "ERROR one", "a3", "a4", "a5", "a6", "ERROR tail"];
      fs.writeFileSync(P("grow.log"), base.join("\n"));
      const be = makeBackend();
      be.st.session = session([tab("t1", P("grow.log"), { lines: { on: true, above: 1, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const isErr = (l) => /\bERROR\b/.test(l);
      let w = refRows(base, isErr, 1, 1);
      ok("처음 행", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      // append: the old last hit gets a line below it, and a new hit + gap appear
      const grown = [...base.slice(0, -1), "ERROR tail and more", "b1", "b2", "b3", "ERROR two", "b5", "b6", "b7"];
      fs.appendFileSync(P("grow.log"), " and more\nb1\nb2\nb3\nERROR two\nb5\nb6\nb7");
      w = refRows(grown, isErr, 1, 1);
      const got = await waitRows(page, w, "", 6000);
      ok("덧붙인 뒤 행 = 새 파일의 grep (끝부분 낡지 않음)", JSON.stringify(got) === JSON.stringify(w), { got, w });
      ok("덧붙음은 다시 시작 안 함(FilterStart 1번)", calls(be, "FilterStart").length === 1, calls(be, "FilterStart").length);
      // again, with a different N in between
      await setCtx(page, 0, 2);
      const grown2 = [...grown, "c1", "ERROR three", "c3"];
      fs.appendFileSync(P("grow.log"), "\nc1\nERROR three\nc3");
      w = refRows(grown2, isErr, 0, 2);
      ok("N 바꾼 뒤 덧붙음도 맞음", JSON.stringify(await waitRows(page, w, "", 6000)) === JSON.stringify(w), await shownRows(page));
      // rewrite (not an append)
      const rewritten = ["x1", "x2", "WARN new start", "x4"];
      fs.writeFileSync(P("grow.log"), rewritten.join("\n"));
      w = refRows(rewritten, isErrWarn, 0, 2);
      ok("다시 쓴 파일 → 처음부터 다시 거름", JSON.stringify(await waitRows(page, w, "", 6000)) === JSON.stringify(w), await shownRows(page));
      ok("다시 쓰면 FilterStart 다시", calls(be, "FilterStart").length === 2, calls(be, "FilterStart").length);
      ok("「파일 내용이 바뀌어」 안내", (await notes(page)).some((n) => n.includes("파일 내용이 바뀌어")), await notes(page));
      await ctx.close();
    }

    // =============== 4. saved tag rules → filter again (after the save, not per keystroke) =======
    console.log("4. 태그 규칙이 바뀌어 저장되면 다시 거름 · common 끄기");
    if (want("4")) {
      const lines = ["start", "kafka connect", "ERROR x", "rebalance begin", "y", "kafka rebalance done", "z"];
      fs.writeFileSync(P("t.log"), lines.join("\n"));
      const be = makeBackend();
      const tags = {
        version: 1,
        tags: [
          { name: "common", rules: [{ id: "error", on: true, label: "오류", pattern: "\\bERROR\\b", kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true }], updated: "" },
          { name: "collector", rules: [{ id: "c1", on: true, label: "", pattern: "rebalance", kind: "text", caseSensitive: false, color: "#00aa00", line: false, filter: true }], updated: "" },
        ],
        assign: { dir: {}, file: {}, name: { "t.log": ["collector"] } },
      };
      be.st.tags = JSON.stringify(tags);
      be.st.session = session([tab("t1", P("t.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const tagsShown = await page.$$eval(".lv-tag", (els) => els.map((e) => e.textContent.trim()));
      ok("적용 태그 = common + collector", JSON.stringify(tagsShown) === '["common","collector"]', tagsShown);
      let w = refRows(lines, (l) => /\bERROR\b/.test(l) || /rebalance/i.test(l), 0, 0);
      ok("collector·common 규칙 둘 다", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      const green = await page.$$eval(`.lv-row span[style*="color: ${rgb("#00aa00")}"]`, (els) => els.map((e) => e.textContent));
      ok("태그 규칙 색", green.length === 2, green);
      // common off in the view
      await page.click('.lv-tag:has-text("common") input');
      w = refRows(lines, (l) => /rebalance/i.test(l), 0, 0);
      ok("common 끄면 collector 규칙만", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      ok("끈 태그는 줄 그어 보임", await page.$eval('.lv-tag:has-text("common")', (e) => e.classList.contains("off")));
      await page.click('.lv-tag:has-text("common") input');
      await waitRows(page, refRows(lines, (l) => /\bERROR\b/.test(l) || /rebalance/i.test(l), 0, 0));
      // add a rule in the tag window
      await openTagWindow(page);
      ok("태그 창이 collector 로 열림", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "collector");
      const n0 = calls(be, "FilterStart").length;
      await page.click(".rule-add");
      const rows = await page.$$(".tags-dialog .rule-row");
      const last = rows[rows.length - 1];
      await (await last.$(".rule-pattern")).type("kafka", { delay: 40 });
      await sleep(900); // past the tag save debounce
      ok("입력하는 동안(적용 전)에는 다시 거르지 않음", calls(be, "FilterStart").length === n0, calls(be, "FilterStart").length - n0);
      await page.click(".tags-dialog .tags-apply"); // 적용(10-28): 줄만 보기는 적용 뒤에만 다시 거름
      await until(() => calls(be, "FilterStart").length > n0, 4000);
      const save = calls(be, "SaveTags").pop();
      const restart = calls(be, "FilterStart")[n0];
      ok("저장된 뒤 다시 거름 (SaveTags → FilterStart)", save && restart && save.t <= restart.t + 5, { save: save && save.t, restart: restart && restart.t });
      ok("새 규칙 포함 3개", restart && restart.args[0].rules.length === 3, restart && restart.args[0].rules.map((r) => r.pattern));
      await page.keyboard.press("Escape");
      w = refRows(lines, (l) => /\bERROR\b/.test(l) || /rebalance|kafka/i.test(l), 0, 0);
      ok("새 규칙에 걸린 줄이 보임", JSON.stringify(await waitRows(page, w)) === JSON.stringify(w), await shownRows(page));
      // colour only: no new scan, colours change at once
      const n1 = calls(be, "FilterStart").length;
      await openTagWindow(page);
      const rows2 = await page.$$(".tags-dialog .rule-row");
      await (await rows2[0].$("input[type=color]")).evaluate((e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "#0000cc");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click(".tags-dialog .tags-ok"); // 확인(10-28): Esc 는 이제 버림
      await sleep(900);
      const blue = await page.$$eval(`.lv-row span[style*="color: ${rgb("#0000cc")}"]`, (els) => els.map((e) => e.textContent));
      ok("색만 바꿔 확인하면 바로 칠함", blue.length === 2, blue);
      ok("색만 바꾸면 다시 거르지 않음", calls(be, "FilterStart").length === n1, calls(be, "FilterStart").length - n1);
      await ctx.close();
    }

    // =============== 5. slow rules / caps (engine with small limits) ==========================
    console.log("5. 느린 규칙 알림 · 상한 안내");
    if (want("5")) {
      const many = [];
      for (let i = 1; i <= 40; i++) many.push(i % 2 ? `ERROR line ${i} abc12x` : `ok ${i}`);
      fs.writeFileSync(P("many.log"), many.join("\n"));
      const run = async (q, check) => {
        await goGet("/reset?" + q);
        const be = makeBackend();
        be.st.tags = JSON.stringify({
          version: 1,
          tags: [
            {
              name: "common",
              rules: [
                { id: "e", on: true, label: "오류", pattern: "ERROR", kind: "text", caseSensitive: true, color: "#ff6b6b", line: false, filter: true },
                { id: "x", on: true, label: "폭발", pattern: "[a-z].{0,25}[0-9]{2}[^0-9]", kind: "regex", caseSensitive: false, color: "#aaaaaa", line: false, filter: true },
              ],
              updated: "",
            },
          ],
          assign: { dir: {}, file: {}, name: {} },
        });
        be.st.session = session([tab("t1", P("many.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await page.waitForSelector(".lines-view");
        await waitDone(page);
        await sleep(300);
        await check(page);
        await ctx.close();
      };
      await run("dfaMemory=600", async (page) => {
        const n = await notes(page);
        ok("느린 규칙 알림 (DFA 를 포기한 규칙 이름)", n.some((x) => x.includes("느린 규칙") && x.includes("폭발")), n);
      });
      await run("maxRows=5", async (page) => {
        const n = await notes(page);
        ok("20만 줄 상한(시험값 5) → 앞부분만 안내", n.some((x) => x.includes("걸린 줄이 5줄을 넘어 앞부분만")), n);
        const stat = await page.$eval(".lv-stat", (e) => e.textContent);
        ok("상태: 걸린 줄 5+", stat.includes("걸린 줄 5+"), stat);
        ok("행 수 = 5", (await shownRows(page)).filter((r) => !r.startsWith("⋯")).length === 5, await shownRows(page));
      });
      await run("maxBytes=120", async (page) => {
        const n = await until(async () => {
          const x = await notes(page);
          return x.some((y) => y.includes("결과가 64MB 를 넘어")) && x;
        }, 3000);
        ok("64MB 상한(시험값 120B) → 앞 몇 행까지만 안내", !!n, await notes(page));
      });
      await goGet("/reset");
    }

    // =============== 8. big file from the tree: 「태그 줄만 열기」 · .gz ==========================
    console.log("8. 큰 파일 확인 창의 「태그 줄만 열기」 · .gz");
    if (want("8")) {
      const root = P("bundle");
      fs.mkdirSync(path.join(root, "server1", "modules", "lizcollector"), { recursive: true });
      const big = path.join(root, "server1", "modules", "lizcollector", "collector.log");
      const blines = [];
      for (let i = 1; i <= 300; i++) blines.push(i % 50 === 0 ? `kafka rebalance ${i}` : i % 70 === 0 ? `ERROR e${i}` : `info ${i}`);
      fs.writeFileSync(big, blines.join("\n"));
      const gz = path.join(root, "server1", "modules", "lizcollector", "collector.log.1.gz");
      fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(blines.join("\n"))));
      // a 100–384MB log in the same folder: the one that can still be opened whole
      const mid = path.join(root, "server1", "modules", "lizcollector", "mid.log");
      fs.writeFileSync(mid, blines.join("\n"));
      const be = makeBackend();
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          { name: "common", rules: [{ id: "error", on: true, label: "오류", pattern: "\\bERROR\\b", kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true }], updated: "" },
          { name: "collector", rules: [{ id: "c1", on: true, label: "", pattern: "rebalance", kind: "text", caseSensitive: false, color: "#00aa00", line: false, filter: true }], updated: "" },
        ],
        assign: { dir: { "modules/lizcollector": ["collector"] }, file: {}, name: {} },
      });
      be.st.sizes[big] = 726 << 20; // the scan and StatFile say it is big: over the 384MB open limit
      be.st.sizes[mid] = 200 << 20;
      be.st.scan = {
        root,
        servers: [
          {
            name: "server1",
            files: [
              { rel: "modules/lizcollector/collector.log", size: 726 << 20, compressed: false },
              { rel: "modules/lizcollector/mid.log", size: 200 << 20, compressed: false },
              { rel: "modules/lizcollector/collector.log.1.gz", size: 1000, compressed: true },
            ],
            truncated: false,
            unreadable: 0,
          },
        ],
      };
      be.st.session = session([], "");
      const { ctx, page } = await openPage(browser, url, be);
      await page.click('button:has-text("📦 로그 묶음")');
      await page.waitForSelector(".bundle-tree");
      await page.fill(".bt-filter", "collector.log"); // opens the folders
      await page.click('.bt-row.file:has-text("collector.log") >> nth=0');
      await page.waitForSelector(".big-ask");
      const btns = await page.$$eval(".big-ask button", (els) => els.map((e) => e.textContent.trim()));
      ok("726MB 확인 창: 태그 줄만 / 취소 (전체 열기 없음)", JSON.stringify(btns) === '["🏷 태그 줄만 열기","취소"]', btns);
      const title = await page.$eval(".big-ask h3", (e) => e.textContent);
      ok("확인 창에 크기", title.includes("726.0MB"), title);
      const askText = await page.$eval(".big-ask p", (e) => e.textContent);
      ok("확인 창: 전체로는 열 수 없다고 알림", askText.includes("전체로 열 수 없") && askText.includes("384MB"), askText);
      ok("「너무 커서 열 수 없습니다」 알림 없이 물음", !page.__dialogs.some((d) => d.includes("너무 커서")), page.__dialogs);
      await shot(page, "lines-big-ask.png");
      await page.click('.big-ask button:has-text("태그 줄만")');
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      ok("큰 파일을 읽지 않고 줄만 보기", calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 0);
      const tagsShown = await page.$$eval(".lv-tag", (els) => els.map((e) => e.textContent.trim()));
      ok("묶음 폴더 태그 = common + collector", JSON.stringify(tagsShown) === '["common","collector"]', tagsShown);
      const isHit = (l) => /\bERROR\b/.test(l) || /rebalance/i.test(l);
      let w = refRows(blines, isHit, 0, 3);
      // a pane shows part of the rows (virtual list): the rows on screen = the start of grep's
      const head = await until(async () => {
        const r = await shownRows(page);
        return r.length > 20 && JSON.stringify(r) === JSON.stringify(w.slice(0, r.length)) && r;
      }, 6000);
      ok(`기본 위 0 아래 3 (보이는 ${head ? head.length : 0}행 / 전체 ${w.length}행)`, !!head, (await shownRows(page)).slice(0, 8));
      ok("행 수 = grep 행 수", +(await viewData(page)).count === w.length, (await viewData(page)).count);
      await shot(page, "lines-bundle.png");
      ok("칸 아래 [전체|줄만] 에서 줄만이 켜짐", await page.$eval(".mpane-foot .lines-seg button.on", (e) => e.textContent.includes("줄만")));
      // whole file of a file over the open limit: refused, the view stays
      await page.click('.lv-btn:has-text("전체")');
      await until(() => page.__dialogs.length > 0, 3000);
      ok("726MB → 「전체」 는 거절 (이 판 문구)", page.__dialogs.some((d) => d.includes("너무 커서") && d.includes("태그 줄만") && !d.includes("다음 버전")), page.__dialogs);
      ok("거절 뒤 줄만 보기 그대로 · 읽지 않음", !!(await page.$(".lines-view")) && !(await page.$(".big-ask")) && calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 0);
      // a 200MB log of the same folder: 3 choices; its whole file then asks (no 「태그 줄만」 choice), cancel keeps the view
      await page.fill(".bt-filter", "mid.log");
      await page.click('.bt-row.file:has-text("mid.log") >> nth=0');
      await page.waitForSelector(".big-ask");
      const btnsM = await page.$$eval(".big-ask button", (els) => els.map((e) => e.textContent.trim()));
      ok("200MB 확인 창: 태그 줄만 / 전체 / 취소", JSON.stringify(btnsM) === '["🏷 태그 줄만 열기","전체 열기","취소"]', btnsM);
      ok("확인 창에 크기 (200MB)", (await page.$eval(".big-ask h3", (e) => e.textContent)).includes("200.0MB"));
      await page.click('.big-ask button:has-text("태그 줄만")');
      await until(async () => (calls(be, "FilterStart").pop() || { args: [{}] }).args[0].path === mid, 4000);
      await waitDone(page);
      await page.click('.lv-btn:has-text("전체")');
      await page.waitForSelector(".big-ask");
      const btns2 = await page.$$eval(".big-ask button", (els) => els.map((e) => e.textContent.trim()));
      ok("전체로 갈 때도 확인 (전체 / 취소)", JSON.stringify(btns2) === '["전체 열기","취소"]', btns2);
      await page.keyboard.press("Escape");
      await sleep(200);
      ok("Esc = 취소 → 줄만 보기 그대로", !!(await page.$(".lines-view")) && !(await page.$(".big-ask")));
      await page.click('.lv-btn:has-text("전체")');
      await page.click('.big-ask button:has-text("전체 열기")');
      await page.waitForSelector(".mpane .cm-editor");
      ok("「전체 열기」 → 읽어서 편집기", calls(be, "ReadFile").length + calls(be, "ReadFileAs").length === 1);
      // .gz through 「📂 파일 열기」 of an empty pane (multi view)
      await page.click(".mp-x"); // empty the pane
      const readsBeforeGz = calls(be, "ReadFile").length + calls(be, "ReadFileAs").length;
      be.st.openFiles = [gz];
      await page.click('.mpane .empty-actions button:has-text("파일 열기")');
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      const sGz = calls(be, "FilterStart").pop();
      const readCalls = [...calls(be, "ReadFile"), ...calls(be, "ReadFileAs")];
      const gzRead = readCalls.some((x) => x.args[0] === gz);
      ok(".gz → 줄만 보기 탭(읽지 않음, 인코딩 자동)", sGz.args[0].path === gz && sGz.args[0].encoding === "" && !gzRead, { request: sGz.args[0], readsBeforeGz, readCount: readCalls.length, gzRead, reads: readCalls.map((x) => x.args[0]) });
      w = refRows(blines, (l) => /\bERROR\b/.test(l), 0, 3); // common only: outside the folder tag? no — same folder
      const shownGz = (await until(async () => {
        const r = await shownRows(page);
        return r.some((x) => x.startsWith("70:")) && r;
      }, 5000)) || (await shownRows(page));
      ok(".gz 풀린 내용으로 거름", shownGz.some((r) => r.startsWith("50:kafka rebalance 50")) && shownGz.some((r) => r.startsWith("70:ERROR e70")), shownGz.slice(0, 8));
      await page.click('.lv-btn:has-text("전체")');
      await sleep(200);
      ok(".gz 는 전체 보기 안 됨 (안내)", page.__dialogs.some((d) => d.includes("압축(.gz)")), page.__dialogs);
      await ctx.close();
    }

    // =============== 9. a long result: virtual rows, scrolling, End, N keeps the place ============
    console.log("9. 긴 결과: 가상 목록·스크롤·End·N 바꿀 때 자리 유지");
    if (want("9")) {
      const L = [];
      for (let i = 1; i <= 200000; i++) L.push(i % 7 === 0 ? `ERROR at ${i}` : `line ${i} some text here`);
      fs.writeFileSync(P("long.log"), L.join("\n"));
      const isErr = (l) => l.startsWith("ERROR");
      const be = makeBackend();
      be.st.session = session([tab("t1", P("long.log"), { lines: { on: true, above: 1, below: 1, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page, "");
      const ref = refRows(L, isErr, 1, 1);
      const vd = await viewData(page);
      ok(`행 수 = grep 행 수 (${ref.length})`, +vd.count === ref.length, vd);
      const dom = await page.$$eval(".lv-row", (els) => els.length);
      ok(`화면에 그린 행은 보이는 만큼만 (${dom}개)`, dom < 120, dom);
      // scroll to the middle
      await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight / 2));
      await sleep(50);
      const mid = await until(async () => {
        const r = await shownRows(page);
        return r.length > 10 && r.every((x) => !x.includes("…")) && r;
      }, 3000);
      const firstRow = await page.$eval(".lv-row[data-row]", (e) => +e.dataset.row);
      const rowsNow = await page.$$eval(".lv-row[data-row]", (els) => els.map((e) => +e.dataset.row).sort((a, b) => a - b));
      ok("가운데로 스크롤한 행 = grep 의 같은 자리", mid && rowsNow.every((r, k) => mid[k] === ref[r]), { first: firstRow, mid: mid && mid.slice(0, 3), ref: ref.slice(rowsNow[0], rowsNow[0] + 3) });
      // scroll frames
      const frames = await page.evaluate(async () => {
        const el = document.querySelector(".lv-scroll");
        const ts = [];
        for (let i = 0; i < 40; i++) {
          const t0 = performance.now();
          el.scrollTop += 600;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b) => a - b);
        return { med: ts[20], max: ts[39] };
      });
      ok(`스크롤 한 번 → 두 프레임 (중앙 ${frames.med.toFixed(1)}ms, 최대 ${frames.max.toFixed(1)}ms)`, frames.med < 50, frames);
      // End
      await page.focus(".lv-scroll");
      await page.keyboard.press("End");
      const tail = await until(async () => {
        const r = await shownRows(page);
        return r[r.length - 1] === ref[ref.length - 1] && r;
      }, 4000);
      ok("End → 마지막 행", !!tail, (await shownRows(page)).slice(-2));
      // N change keeps the top line
      await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight * 0.3));
      await sleep(300);
      const topLine = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".lv-row[data-line]")].sort((a, b) => a.dataset.row - b.dataset.row);
        return +rows[0].dataset.line;
      });
      await setCtx(page, 3, 0);
      await until(async () => (await viewData(page)).redrawMs, 4000);
      const after = await page.evaluate(() => {
        const el = document.querySelector(".lv-scroll");
        const rows = [...document.querySelectorAll(".lv-row[data-row]")].sort((a, b) => a.dataset.row - b.dataset.row);
        const top = rows.find((r) => r.offsetTop + r.offsetHeight > el.scrollTop);
        return { line: +(top.dataset.line || 0), text: top.textContent };
      });
      ok(`N 바꿔도 보던 줄(${topLine}) 근처`, Math.abs(after.line - topLine) <= 7 || after.line === 0, { topLine, after });
      const redraw = +(await viewData(page)).redrawMs;
      ok(`20만 줄 파일 N 바꾸기 다시 그림 ${redraw}ms`, redraw < 1000, redraw);
      ok("N 바꿔도 다시 거르지 않음", calls(be, "FilterStart").length === 1);
      await shot(page, "lines-long.png");
      await ctx.close();
    }

    // =============== 10. 2단계 수정 (f2): big files every way · restored tabs · multi panes ==========
    const TAGS1 = JSON.stringify({
      version: 1,
      tags: [{ name: "common", rules: [{ id: "error", on: true, label: "오류", pattern: "\\bERROR\\b", kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true }], updated: "" }],
      assign: { dir: {}, file: {}, name: {} },
    });
    const small = [];
    for (let i = 1; i <= 300; i++) small.push(i % 70 === 0 ? `ERROR e${i}` : `info ${i}`);
    const reads = (be) => [...calls(be, "ReadFile"), ...calls(be, "ReadFileAs")];
    const askBtns = (page) => page.$$eval(".big-ask button", (els) => els.map((e) => e.textContent.trim()));
    const emptyBtns = (page, scope = "") => page.$$eval(scope + " .empty-actions button", (els) => els.map((e) => e.textContent.trim()));
    const tabCount = (page) => page.$$eval(".tabs-scroll .tab", (els) => els.length);
    const slots6 = (first, mode = "read") => {
      const s = [{ tabId: first, mode, server: "", note: "" }];
      while (s.length < 6) s.push({ tabId: "", mode, server: "", note: "" });
      return s;
    };
    const topOf = (page) =>
      page.evaluate(() => {
        const el = document.querySelector(".lv-scroll");
        const rows = [...document.querySelectorAll(".lv-row[data-row]")].sort((a, b) => a.dataset.row - b.dataset.row);
        // the first line row on screen (「⋯ N줄 생략」 rows have no line)
        const top = rows.find((r) => r.dataset.line && r.offsetTop + r.offsetHeight > el.scrollTop);
        return top ? { row: +top.dataset.row, line: +top.dataset.line } : null;
      });
    const hasRow = async (page, prefix, ms = 5000) => !!(await until(async () => (await shownRows(page)).some((r) => r.startsWith(prefix)), ms));

    // H1 · a file over 384MB through 📂 열기 (single view) and the multi-file dialog
    console.log("10a. 384MB 넘는 파일 — 📂 파일 열기 · 여러 파일 한 번에 · 취소");
    if (want("10a")) {
      const huge = P("huge.log");
      const midF = P("mid10.log");
      fs.writeFileSync(huge, small.join("\n"));
      fs.writeFileSync(midF, small.join("\n"));
      const be = makeBackend();
      be.st.tags = TAGS1;
      be.st.sizes[huge] = 726 << 20;
      be.st.sizes[midF] = 200 << 20;
      be.st.session = session([], "");
      be.st.openFiles = [huge];
      const { ctx, page } = await openPage(browser, url, be);
      await page.click('.empty-actions button:has-text("파일 열기")');
      await until(async () => (await page.$(".big-ask")) || page.__dialogs.length, 3000);
      ok("726MB 📂 열기 → 「태그 줄만 / 취소」 확인 창", JSON.stringify(await askBtns(page)) === '["🏷 태그 줄만 열기","취소"]', { btns: await askBtns(page), dialogs: page.__dialogs });
      ok("726MB 📂 열기 → 「너무 커서」 알림 없음", !page.__dialogs.some((d) => d.includes("너무 커서")), page.__dialogs);
      if (await page.$(".big-ask")) await page.click('.big-ask button:has-text("취소")');
      await sleep(300);
      ok("취소 → 아무것도 안 열림", (await tabCount(page)) === 0 && !(await page.$(".lines-view")) && reads(be).length === 0);
      await page.click('.empty-actions button:has-text("파일 열기")');
      await page.waitForSelector(".big-ask", { timeout: 3000 }).catch(() => {});
      if (await page.$(".big-ask")) await page.click('.big-ask button:has-text("태그 줄만")');
      await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
      ok("「태그 줄만 열기」 → 726MB 줄만 보기 (읽지 않음)", !!(await page.$(".lines-view")) && (await hasRow(page, "70:ERROR e70")) && reads(be).length === 0, reads(be).length);
      await ctx.close();
      // several files at once (multi view, empty pane → 📂 파일 열기): 200MB + 726MB, 「전체 열기」
      const be2 = makeBackend();
      be2.st.tags = TAGS1;
      be2.st.sizes[huge] = 726 << 20;
      be2.st.sizes[midF] = 200 << 20;
      be2.st.session = session([], "", { multi: { on: true, count: 1, slots: slots6("", "edit") } });
      be2.st.openFiles = [midF, huge];
      const r2 = await openPage(browser, url, be2);
      await r2.page.click('.mpane .empty-actions button:has-text("파일 열기")');
      await r2.page.waitForSelector(".big-ask", { timeout: 3000 }).catch(() => {});
      ok("200MB + 726MB 한 번에 → 확인 창 하나 (줄만 / 전체 / 취소)", JSON.stringify(await askBtns(r2.page)) === '["🏷 태그 줄만 열기","전체 열기","취소"]', { btns: await askBtns(r2.page), dialogs: r2.page.__dialogs });
      const t2 = (await r2.page.$eval(".big-ask p", (e) => e.textContent).catch(() => "")) || "";
      ok("확인 창: 726MB 는 줄만으로 열린다고 알림", t2.includes("huge.log") && t2.includes("태그 줄만"), t2);
      if (await r2.page.$(".big-ask")) await r2.page.click('.big-ask button:has-text("전체 열기")');
      await until(async () => (await tabCount(r2.page)) === 2, 3000);
      const rd = reads(be2).map((x) => path.basename(x.args[0]));
      ok("「전체 열기」 → 200MB 는 읽고 726MB 는 줄만 탭", JSON.stringify(rd) === '["mid10.log"]' && (await tabCount(r2.page)) === 2, { rd, tabs: await tabCount(r2.page), dialogs: r2.page.__dialogs });
      await r2.ctx.close();
    }

    // M2 · big .gz: never 「전체 열기」, 「취소」 is kept, no 「너무 커서」 — 📂 열기 and the tree alike
    console.log("10b. 큰 .gz — 확인 창은 「태그 줄만 / 취소」, 취소 지킴 (📂 열기 · 트리)");
    if (want("10b")) {
      const gz = P("big10.log.gz");
      fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(small.join("\n"))));
      for (const sz of [150 << 20, 500 << 20]) {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.sizes[gz] = sz;
        be.st.session = session([], "");
        be.st.openFiles = [gz];
        const { ctx, page } = await openPage(browser, url, be);
        await page.click('.empty-actions button:has-text("파일 열기")');
        await until(async () => (await page.$(".big-ask")) || (await page.$(".lines-view")) || page.__dialogs.length, 3000);
        ok(`.gz ${sz >> 20}MB 📂 열기 → 「태그 줄만 / 취소」`, JSON.stringify(await askBtns(page)) === '["🏷 태그 줄만 열기","취소"]', { btns: await askBtns(page), dialogs: page.__dialogs });
        ok(`.gz ${sz >> 20}MB → 「너무 커서」 알림 없음`, !page.__dialogs.some((d) => d.includes("너무 커서")), page.__dialogs);
        if (await page.$(".big-ask")) await page.click('.big-ask button:has-text("취소")');
        await sleep(400);
        ok(`.gz ${sz >> 20}MB 「취소」 → 열리지 않음`, !(await page.$(".lines-view")) && (await tabCount(page)) === 0);
        await ctx.close();
      }
      // a small .gz: no question, straight to 줄만 보기
      {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.session = session([], "");
        be.st.openFiles = [gz];
        const { ctx, page } = await openPage(browser, url, be);
        await page.click('.empty-actions button:has-text("파일 열기")');
        await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
        ok("작은 .gz → 묻지 않고 줄만 보기", !!(await page.$(".lines-view")) && !(await page.$(".big-ask")) && (await hasRow(page, "70:ERROR e70")));
        await ctx.close();
      }
      // the tree: the same rule; the .gz row says it opens as 줄만 보기
      const root = P("bundle10b");
      fs.mkdirSync(path.join(root, "server1", "m"), { recursive: true });
      const tgz = path.join(root, "server1", "m", "app.log.1.gz");
      const sgz = path.join(root, "server1", "m", "app.log.2.gz");
      fs.writeFileSync(tgz, zlib.gzipSync(Buffer.from(small.join("\n"))));
      fs.writeFileSync(sgz, zlib.gzipSync(Buffer.from(small.join("\n"))));
      const be = makeBackend();
      be.st.tags = TAGS1;
      be.st.sizes[tgz] = 150 << 20;
      be.st.scan = {
        root,
        servers: [
          {
            name: "server1",
            files: [
              { rel: "m/app.log.1.gz", size: 150 << 20, compressed: true },
              { rel: "m/app.log.2.gz", size: 1000, compressed: true },
            ],
            truncated: false,
            unreadable: 0,
          },
        ],
      };
      be.st.session = session([], "");
      const { ctx, page } = await openPage(browser, url, be);
      await page.click('button:has-text("📦 로그 묶음")');
      await page.waitForSelector(".bundle-tree");
      await page.fill(".bt-filter", "app.log");
      const row = await page.waitForSelector('.bt-row.file:has-text("app.log.1.gz")');
      const rowInfo = await row.evaluate((e) => ({ title: e.title, off: e.classList.contains("off"), drag: e.draggable, all: !!e.querySelector(".bt-all") }));
      ok("트리 .gz 행: 흐리지 않음 · 「줄만 보기로 열림」 풍선 · 끌기·⇉", !rowInfo.off && !rowInfo.title.includes("열 수 없습니다") && rowInfo.title.includes("줄만") && rowInfo.drag && rowInfo.all, rowInfo);
      await row.click();
      await until(async () => (await page.$(".big-ask")) || (await page.$(".lines-view")), 3000);
      ok("트리 150MB .gz → 「태그 줄만 / 취소」", JSON.stringify(await askBtns(page)) === '["🏷 태그 줄만 열기","취소"]', await askBtns(page));
      if (await page.$(".big-ask")) await page.click('.big-ask button:has-text("취소")');
      await sleep(400);
      ok("트리 .gz 「취소」 → 칸 그대로 (안 열림)", !(await page.$(".lines-view")));
      await page.click('.bt-row.file:has-text("app.log.2.gz")');
      await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
      ok("트리 작은 .gz → 묻지 않고 줄만 보기", !!(await page.$(".lines-view")) && !(await page.$(".big-ask")));
      await ctx.close();
    }

    // H1 · M3 · restored big tabs (single view): 「🏷 태그 줄만」 in the pane
    console.log("10c. 복원된 큰 탭 (한 칸 보기) — 「🏷 태그 줄만」 · 384MB 넘으면 전체 열기 없음");
    if (want("10c")) {
      const f = P("rest10.log");
      fs.writeFileSync(f, small.join("\n"));
      {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.sizes[f] = 200 << 20;
        be.st.session = session([tab("t1", f)], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await sleep(600);
        const b = await emptyBtns(page);
        ok("200MB 복원 탭: 줄만 / 전체 열기 / 탭 닫기", JSON.stringify(b) === '["🏷 태그 줄만","전체 열기","× 탭 닫기"]', b);
        if (b.some((x) => x.includes("줄만"))) await page.click('.empty-actions button:has-text("태그 줄만")');
        await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
        ok("「🏷 태그 줄만」 → 줄만 보기 (읽지 않음)", !!(await page.$(".lines-view")) && (await hasRow(page, "70:ERROR e70")) && reads(be).length === 0, reads(be).length);
        // and back to the whole file: asks once, then reads
        if (await page.$(".lines-view")) {
          await page.click('.lv-btn:has-text("전체")');
          await page.waitForSelector(".big-ask", { timeout: 3000 }).catch(() => {});
          if (await page.$(".big-ask")) await page.click('.big-ask button:has-text("전체 열기")');
          await page.waitForSelector(".cm-editor", { timeout: 3000 }).catch(() => {});
          ok("줄만 → 전체: 한 번 묻고 읽음", !!(await page.$(".cm-editor")) && reads(be).length === 1, reads(be).length);
        }
        await ctx.close();
      }
      {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.sizes[f] = 726 << 20;
        be.st.session = session([tab("t1", f)], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await sleep(600);
        const b = await emptyBtns(page);
        ok("726MB 복원 탭: 줄만 / 탭 닫기 (전체 열기 없음)", JSON.stringify(b) === '["🏷 태그 줄만","× 탭 닫기"]', b);
        const txt = await page.$eval(".empty", (e) => e.textContent).catch(() => "");
        ok("726MB 복원 탭 문구: 384MB 까지 · 「다음 버전」 없음", txt.includes("384MB") && !txt.includes("다음 버전"), txt);
        if (b.some((x) => x.includes("줄만"))) await page.click('.empty-actions button:has-text("태그 줄만")');
        await page.waitForSelector(".lines-view", { timeout: 3000 }).catch(() => {});
        ok("726MB 복원 탭 → 줄만 보기", !!(await page.$(".lines-view")) && (await hasRow(page, "70:ERROR e70")) && reads(be).length === 0);
        await ctx.close();
      }
    }

    // H1 · H2 · multi view: restored big tabs, a never-read 줄만 tab, the pane's tag chips
    console.log("10d. 멀티 칸 — 복원된 큰 탭 (StatFile 반복 없음·자동 저장) · 줄만 탭 읽지 않음 · 칸 태그 칩");
    if (want("10d")) {
      const f = P("multi10.log");
      fs.writeFileSync(f, small.join("\n"));
      const o = P("other10.log");
      for (const sz of [200 << 20, 726 << 20]) {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.sizes[f] = sz;
        be.st.session = session([tab("t1", f), tab("t2", o, { needsLoad: false, content: "x" })], "t1", { multi: { on: true, count: 2, slots: slots6("t1") } });
        const { ctx, page } = await openPage(browser, url, be);
        await sleep(1000);
        const a = calls(be, "StatFile").length;
        await sleep(1500);
        const b = calls(be, "StatFile").length;
        ok(`멀티 칸 ${sz >> 20}MB 복원 탭: StatFile 이 멈춰 있음`, b - a <= 1, { a, b });
        const btn = (await emptyBtns(page, ".mpane")).filter((x) => !x.includes("파일 열기")); // the other, empty pane
        ok(
          `멀티 칸 ${sz >> 20}MB 복원 탭: 칸 안에 「🏷 태그 줄만」`,
          JSON.stringify(btn) === (sz > 384 << 20 ? '["🏷 태그 줄만","× 탭 닫기"]' : '["🏷 태그 줄만","전체 열기","× 탭 닫기"]'),
          btn
        );
        // a change that the session keeps: the other tab into the focused pane → autosave
        const s0 = calls(be, "SaveSession").length;
        await page.click(".tabs-scroll .tab >> nth=1");
        await sleep(2500);
        ok(`멀티 칸 ${sz >> 20}MB 복원 탭: 세션 자동 저장 됨`, calls(be, "SaveSession").length > s0, { s0, now: calls(be, "SaveSession").length });
        await ctx.close();
      }
      // a never-read 줄만 tab in a pane
      const be = makeBackend();
      be.st.tags = TAGS1;
      be.st.session = session([tab("t1", f, { encAuto: true, lines: { on: true, above: 0, below: 1, off: [] } })], "t1", { multi: { on: true, count: 2, slots: slots6("t1") } });
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await sleep(1200); // autosave
      let t1 = null;
      try {
        t1 = JSON.parse(be.st.session).tabs.find((t) => t.id === "t1");
      } catch {
        /* none */
      }
      ok("멀티 칸 줄만 탭: 파일을 편집기로 읽지 않음", reads(be).length === 0, reads(be).map((x) => x.name));
      ok("멀티 칸 줄만 탭: 인코딩 자동 그대로 (다시 거르지 않음)", t1 && t1.encAuto === true && calls(be, "FilterStart").length === 1, { encAuto: t1 && t1.encAuto, starts: calls(be, "FilterStart").length });
      ok("멀티 칸 줄만 탭(읽은 적 없음): 칸 아래 태그 칩", !!(await page.$(".mpane-foot .mp-tags")));
      await ctx.close();
    }

    // M1 · typing 「12」 into 「위」 fast keeps the place
    console.log("10e. 위·아래 N 을 빠르게 연달아 바꿔도 보던 자리 유지");
    if (want("10e")) {
      const L = [];
      for (let i = 1; i <= 200000; i++) L.push(i % 7 === 0 ? `ERROR at ${i}` : `line ${i} some text here`);
      fs.writeFileSync(P("long10.log"), L.join("\n"));
      for (const d of [0, 150]) {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.session = session([tab("t1", P("long10.log"), { lines: { on: true, above: 3, below: 0, off: [] } })], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await page.waitForSelector(".lines-view");
        await waitDone(page);
        await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight * 0.4));
        await sleep(400);
        const before = await topOf(page);
        be.delay.FilterRowOfLine = d;
        await page.click(".lv-ctx:nth-of-type(1) input", { clickCount: 3 });
        await page.keyboard.type("12", { delay: d ? 30 : 0 });
        await sleep(1500 + d * 4);
        be.delay.FilterRowOfLine = 0;
        const after = await topOf(page);
        ok(`「위」 3 → 「12」 빠르게 (FilterRowOfLine 지연 ${d}ms) → 보던 줄 근처`, before && after && Math.abs(after.line - before.line) <= 20, { before, after });
        await ctx.close();
      }
    }

    // M4 · no hit yet · low: back to a line not scanned yet does not jump · no rules → no scan
    console.log("10f. 아직 걸린 줄 없음 문구 · 안 훑은 곳으로 돌아갈 때 튀지 않음 · 규칙 0개면 안 훑음");
    if (want("10f")) {
      // a ~70MB file and a rule the fast matcher gives up on (slow scan, like 5.)
      const slow = P("slow10.log");
      const chunk = [];
      for (let i = 0; i < 2000; i++) chunk.push(i % 97 === 0 ? `ERROR line ${i} abc12-x` : `ok line ${i} padding padding padding padding padding abc12y`);
      const s = chunk.join("\n") + "\n";
      const fd = fs.openSync(slow, "w");
      for (let k = 0; k < 300; k++) fs.writeSync(fd, s);
      fs.closeSync(fd);
      await goGet("/reset?dfaMemory=600");
      const slowTags = (pattern) =>
        JSON.stringify({
          version: 1,
          tags: [{ name: "common", rules: [{ id: "x", on: true, label: "폭발", pattern, kind: "regex", caseSensitive: false, color: "#aaaaaa", line: false, filter: true }], updated: "" }],
          assign: { dir: {}, file: {}, name: {} },
        });
      {
        const be = makeBackend();
        be.st.tags = slowTags("[a-z].{0,25}[0-9]{2}[^0-9]q"); // never matches
        be.st.session = session([tab("t1", slow, { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await page.waitForSelector(".lines-view");
        const seen = new Set();
        await until(async () => {
          seen.add(await page.$eval(".lv-stat", (e) => e.textContent).catch(() => ""));
          return (await viewData(page)).state === "done";
        }, 30000, 20);
        ok("걸린 줄 없을 때 「훑는 중 N% — 아직 걸린 줄 없음」", [...seen].some((t) => /훑는 중 \d+% — 아직 걸린 줄 없음/.test(t)), [...seen].slice(0, 6));
        ok("끝나면 「걸린 줄이 없습니다.」 (생략 행 하나 아래)",((await page.$eval(".lv-empty", (e) => e.textContent).catch(() => "")) || "").includes("걸린 줄이 없습니다"));
        await ctx.close();
      }
      {
        const be = makeBackend();
        // two tags: turning one off filters again with other rules (a new scan — a finished
        // scan with the same rules would be reused and done at once)
        const t = JSON.parse(slowTags("[a-z].{0,25}[0-9]{2}[^0-9]x")); // the ERROR lines
        t.tags.push({ name: "extra", rules: [{ id: "q", on: true, label: "", pattern: "zzzq", kind: "text", caseSensitive: false, color: "#00aa00", line: false, filter: true }], updated: "" });
        t.assign.name["slow10.log"] = ["extra"];
        be.st.tags = JSON.stringify(t);
        be.st.session = session([tab("t1", slow, { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
        const { ctx, page } = await openPage(browser, url, be);
        await page.waitForSelector(".lines-view");
        await until(async () => (await viewData(page)).state === "done", 30000);
        await until(async () => +(await viewData(page)).count > 10000, 5000);
        await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight * 0.6));
        const before = await until(async () => {
          const x = await topOf(page);
          return x && x.line > 1000 && x;
        }, 5000);
        // the seek goes out once the new scan is part way (its answer = the rows known so far)
        be.delay.FilterRowOfLine = 300;
        await page.click('.lv-tag:has-text("extra") input');
        setTimeout(() => (be.delay.FilterRowOfLine = 0), 100);
        const samples = [];
        await until(async () => {
          const t = await topOf(page).catch(() => null);
          if (t) samples.push(t.line);
          return (await viewData(page)).state === "done" && t && Math.abs(t.line - before.line) <= 200;
        }, 30000, 15);
        await sleep(300);
        const after = await topOf(page);
        const stray = samples.filter((x) => x > 1000 && Math.abs(x - before.line) > 200);
        ok("↻ 다시 거르기 → 보던 줄로 돌아옴", after && Math.abs(after.line - before.line) <= 200, { before, after });
        ok("스캔 중 엉뚱한 자리로 튀지 않음", stray.length === 0, { before: before && before.line, stray: [...new Set(stray)].slice(0, 8), n: samples.length });
        await ctx.close();
      }
      await goGet("/reset");
      {
        const be = makeBackend();
        be.st.tags = TAGS1;
        be.st.session = session([tab("t1", P("plain.log"), { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
        if (!fs.existsSync(P("plain.log"))) fs.writeFileSync(P("plain.log"), small.join("\n"));
        const { ctx, page } = await openPage(browser, url, be);
        await page.waitForSelector(".lines-view");
        await waitDone(page);
        const n0 = calls(be, "FilterStart").length;
        await page.click('.lv-tag:has-text("common") input');
        await sleep(600);
        ok("규칙 0개 → FilterStart 안 함", calls(be, "FilterStart").length === n0, calls(be, "FilterStart").length - n0);
        ok("규칙 0개 → 「거를 규칙이 없습니다.」", ((await page.$eval(".lv-empty", (e) => e.textContent).catch(() => "")) || "").includes("거를 규칙이 없습니다"));
        await page.click('.lv-tag:has-text("common") input');
        await waitDone(page);
        ok("다시 켜면 거름", calls(be, "FilterStart").length === n0 + 1 && (await shownRows(page)).length > 0);
        await ctx.close();
      }
    }

    // low · a late answer of the old job (seek) does not mark the new view as failed
    console.log("10g. 옛 작업의 늦은 실패가 새 화면을 「오류」로 바꾸지 않음 · 확인 창 겹침");
    if (want("10g")) {
      const f = P("race10.log");
      const lines = [];
      for (let i = 1; i <= 400; i++) lines.push(i % 10 === 0 ? `ERROR boom ${i}` : i % 25 === 0 ? `kafka rebalance ${i}` : `info ${i}`);
      fs.writeFileSync(f, lines.join("\n"));
      const be = makeBackend();
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          { name: "common", rules: [{ id: "error", on: true, label: "오류", pattern: "ERROR", kind: "text", caseSensitive: true, color: "#ff6b6b", line: false, filter: true }], updated: "" },
          { name: "kafka", rules: [{ id: "k", on: true, label: "", pattern: "rebalance", kind: "text", caseSensitive: false, color: "#00aa00", line: false, filter: true }], updated: "" },
        ],
        assign: { dir: {}, file: {}, name: { "race10.log": ["kafka"] } },
      });
      be.st.session = session([tab("t1", f, { lines: { on: true, above: 0, below: 0, off: [] } })], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".lines-view");
      await waitDone(page);
      await page.$eval(".lv-scroll", (e) => (e.scrollTop = e.scrollHeight * 0.5));
      await sleep(300);
      be.delay.FilterRowOfLine = 500;
      await page.fill(".lv-ctx:nth-of-type(1) input", "2"); // seek → FilterRowOfLine held 500ms
      await sleep(50);
      be.delay.FilterRowOfLine = 0;
      await page.click('.lv-tag:has-text("kafka") input'); // new job; the old one is closed before its seek arrives
      await sleep(1200);
      await waitDone(page);
      const vd = await viewData(page);
      const n = await notes(page);
      ok("옛 작업의 늦은 seek 실패 → 새 화면은 오류 아님", vd.state !== "error" && !n.some((x) => x.includes("거르지 못했습니다")), { vd, n });
      await ctx.close();
      // two size questions at once: the newer one wins, the first is answered 「취소」
      const a = P("askA.log");
      const b = P("askB.log");
      fs.writeFileSync(a, small.join("\n"));
      fs.writeFileSync(b, small.join("\n"));
      const be2 = makeBackend();
      be2.st.tags = TAGS1;
      be2.st.sizes[a] = 200 << 20;
      be2.st.sizes[b] = 300 << 20;
      be2.st.session = session([], "");
      be2.st.openFiles = [a];
      const r2 = await openPage(browser, url, be2);
      await r2.page.click('.empty-actions button:has-text("파일 열기")');
      await r2.page.waitForSelector(".big-ask");
      be2.st.openFiles = [b];
      await r2.page.keyboard.press("Control+o");
      await until(async () => ((await r2.page.$eval(".big-ask h3", (e) => e.textContent).catch(() => "")) || "").includes("askB"), 3000);
      const h = await r2.page.$eval(".big-ask h3", (e) => e.textContent).catch(() => "");
      ok("두 번째 확인 창이 앞의 것을 대신함", h.includes("askB") && (await r2.page.$$(".big-ask")).length === 1, h);
      await r2.page.click('.big-ask button:has-text("태그 줄만")');
      await sleep(500);
      const titles = await r2.page.$$eval(".tabs-scroll .tab .tab-title", (els) => els.map((e) => e.textContent));
      ok("앞의 열기는 취소로 끝남 · 뒤의 것만 열림", JSON.stringify(titles) === '["askB.log"]' && !(await r2.page.$(".big-ask")), titles);
      // the first one is not stuck: opening it again asks again
      be2.st.openFiles = [a];
      await r2.page.keyboard.press("Control+o");
      await r2.page.waitForSelector(".big-ask", { timeout: 3000 }).catch(() => {});
      ok("앞의 파일을 다시 열면 다시 물음", ((await r2.page.$eval(".big-ask h3", (e) => e.textContent).catch(() => "")) || "").includes("askA"));
      await r2.ctx.close();
    }

    // 최종 병합 되묻기 ③: the 「저장 뒤 384MB 초과」 question says what the file becomes
    console.log("10h. 저장하면 384MB 를 넘는 파일 — 경고 문구");
    if (want("10h")) {
      const f = P("grow.log");
      fs.writeFileSync(f, small.join("\n"));
      const be = makeBackend();
      be.st.tags = TAGS1;
      be.st.session = session([tab("t1", f)], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await until(() => page.$(".cm-line"), 8000);
      await page.click(".cm-content");
      await page.keyboard.press("Control+End");
      await page.keyboard.type("x");
      be.st.tooBigSave = 400 * 1024 * 1024 + 123; // multi-byte text: only Go knows the size
      const d0 = page.__dialogs.length;
      await page.keyboard.press("Control+s");
      await until(() => calls(be, "SaveFile").length >= 2, 4000);
      const asked = page.__dialogs.slice(d0);
      const q = asked.find((d) => d.includes("저장하면")) || "";
      ok("저장 뒤 크기를 묻는 창이 뜸 (파일 이름·크기)", q.startsWith("confirm:") && q.includes("grow.log") && q.includes("400"), asked);
      ok("문구: 다음부터 전체로 열 수 없고 「🏷 태그 줄만」으로만 볼 수 있음", q.includes("다음부터는 전체로 열 수 없고 「🏷 태그 줄만」으로만 볼 수 있습니다. 저장할까요?"), q);
      ok("옛 문구(「Chipper 로 이 파일을 열 수 없습니다」) 아님", !q.includes("열 수 없습니다. 저장할까요") && !q.includes("Chipper 로 이 파일을"), q);
      const sv = calls(be, "SaveFile");
      ok("「확인」 → allowTooBig 로 다시 저장", sv.length === 2 && !sv[0].args[2].allowTooBig && sv[1].args[2].allowTooBig === true, sv.map((c) => c.args[2] && c.args[2].allowTooBig));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  console.log(`\nlines-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
