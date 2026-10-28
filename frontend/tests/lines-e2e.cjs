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
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules"]);
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
    {
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
    {
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
    {
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
    {
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
      await sleep(120);
      ok("입력하는 동안에는 다시 거르지 않음", calls(be, "FilterStart").length === n0, calls(be, "FilterStart").length - n0);
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
      await page.keyboard.press("Escape");
      await sleep(900);
      const blue = await page.$$eval(`.lv-row span[style*="color: ${rgb("#0000cc")}"]`, (els) => els.map((e) => e.textContent));
      ok("색만 바꾸면 바로 칠함", blue.length === 2, blue);
      ok("색만 바꾸면 다시 거르지 않음", calls(be, "FilterStart").length === n1, calls(be, "FilterStart").length - n1);
      await ctx.close();
    }

    // =============== 5. slow rules / caps (engine with small limits) ==========================
    console.log("5. 느린 규칙 알림 · 상한 안내");
    {
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
    {
      const root = P("bundle");
      fs.mkdirSync(path.join(root, "server1", "modules", "lizcollector"), { recursive: true });
      const big = path.join(root, "server1", "modules", "lizcollector", "collector.log");
      const blines = [];
      for (let i = 1; i <= 300; i++) blines.push(i % 50 === 0 ? `kafka rebalance ${i}` : i % 70 === 0 ? `ERROR e${i}` : `info ${i}`);
      fs.writeFileSync(big, blines.join("\n"));
      const gz = path.join(root, "server1", "modules", "lizcollector", "collector.log.1.gz");
      fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(blines.join("\n"))));
      const be = makeBackend();
      be.st.tags = JSON.stringify({
        version: 1,
        tags: [
          { name: "common", rules: [{ id: "error", on: true, label: "오류", pattern: "\\bERROR\\b", kind: "regex", caseSensitive: false, color: "#ff6b6b", line: true, filter: true }], updated: "" },
          { name: "collector", rules: [{ id: "c1", on: true, label: "", pattern: "rebalance", kind: "text", caseSensitive: false, color: "#00aa00", line: false, filter: true }], updated: "" },
        ],
        assign: { dir: { "modules/lizcollector": ["collector"] }, file: {}, name: {} },
      });
      be.st.sizes[big] = 200 << 20; // the common 100–384MB open gate offers line-only view
      be.st.scan = {
        root,
        servers: [
          {
            name: "server1",
            files: [
              { rel: "modules/lizcollector/collector.log", size: 200 << 20, compressed: false },
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
      ok("확인 창: 태그 줄만 / 전체 / 취소", JSON.stringify(btns) === '["🏷 태그 줄만 열기","전체 열기","취소"]', btns);
      const title = await page.$eval(".big-ask h3", (e) => e.textContent);
      ok("확인 창에 크기", title.includes("200.0MB"), title);
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
      // whole file of a big never-read tab: asks (no 「태그 줄만」 choice), cancel keeps the view
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
    {
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
