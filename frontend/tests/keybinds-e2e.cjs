// Headless test of 「⌨ 단축키 설정」 (keybinds.ts, user 10-29): every app shortcut is
// remappable, macOS shows ⌘, and Ctrl/⌘ + wheel zooms (macOS: ⌃ only / ⌘ only / both).
// Runs the same steps in chromium AND webkit (the macOS engine), each as Windows
// and as macOS (GetPlatform), against the built frontend; 「🏷 줄만 보기」 uses the
// REAL line filter through the Go helper of lines-e2e.cjs.
//
//   cd frontend && npm run build && node tests/keybinds-e2e.cjs
//   BROWSERS=chromium,webkit (default both)   PLATFORMS=windows,darwin (default both)
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder> → keybinds-<browser>-<platform>.png
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const pw = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const ROOT = path.join(__dirname, "..", "..");
const SHOTS = process.env.SHOTS || "";
const BROWSERS = (process.env.BROWSERS || "chromium,webkit").split(",").filter(Boolean);
const PLATFORMS = (process.env.PLATFORMS || "windows,darwin").split(",").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
let where = "";
function ok(name, cond, extra) {
  name = `[${where}] ${name}`;
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
  const addrFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-e2e-")), "addr");
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
function makeBackend(platform) {
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
    GetPlatform: () => platform,
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  const FILTER = new Set(["FilterStart", "FilterRows", "FilterStatus", "FilterCancel", "FilterClose", "FilterRowOfLine", "ValidateFilterRules", "FilterFind", "MemInfo"]);
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
      ClipboardSetText: async (t) => {
        window.__clip = t;
        return true;
      },
    },
    { get: (t, name) => t[name] || (() => undefined) }
  );
};

async function openPage(browser, url, be, viewport = { width: 1300, height: 820 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
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
        /* page closing */
      }
      await sleep(25);
    }
  })();
  ctx.on("close", () => (stop = true));
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(300);
  return { ctx, page };
}

const tab = (id, p, extra = {}) => ({
  id,
  title: p ? p.split(/[\\/]/).pop() : "find.txt",
  path: p,
  lang: "plaintext",
  content: "",
  dirty: false,
  view: "editor",
  mtime: 1,
  encoding: "utf-8",
  reloadSeq: 0,
  needsLoad: !!p,
  loadError: "",
  label: "",
  logColors: "",
  ...extra,
});
const session = (tabs, activeId, extra = {}) => JSON.stringify({ version: 3, tabs, activeId, splitRatio: 0.5, fontSize: 14, ...extra });
const calls = (be, name) => be.st.calls.filter((c) => c.name === name);

// ---- page helpers ----------------------------------------------------------------------------
const bindText = (page, id) => page.$eval(`.keys-row[data-cmd="${id}"] .keys-bind`, (e) => e.textContent.trim());
const keyError = (page) => page.$eval(".keys-error", (e) => e.textContent.trim());
async function openKeys(page) {
  await page.click("button:has-text('⌨ 단축키')");
  await page.waitForSelector(".keys-dialog");
}
async function closeKeys(page) {
  await page.click(".keys-dialog .chips-actions .tb-btn.primary");
  await until(async () => !(await page.$(".keys-dialog")), 3000);
}
// A key press as an IME in 한글 mode sends it: key = the jamo, code = the physical key.
const imeKey = (page, sel, key, code, mods) =>
  page.evaluate(
    ([sel, key, code, mods]) => {
      const t = sel === "window" ? window : document.querySelector(sel);
      t.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));
    },
    [sel, key, code, mods]
  );
const fontPx = (page) => page.$eval(".st-font", (e) => parseInt(e.textContent, 10));
async function modWheel(page, mod, dy) {
  const box = await page.$eval(".workspace .cm-content", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + Math.min(200, r.width / 2), y: r.top + 40 };
  });
  await page.mouse.move(box.x, box.y);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.wheel(0, dy);
  await sleep(120);
  if (mod) await page.keyboard.up(mod);
  await sleep(80);
}
// which line (1-based) the editor's selection (the found match) is on: the
// drawn selection box against the line boxes
const selMatchLine = (page) =>
  page.evaluate(() => {
    const m = document.querySelector(".workspace .cm-selectionLayer .cm-selectionBackground");
    if (!m) return 0;
    const y = m.getBoundingClientRect().top + 2;
    const lines = [...document.querySelectorAll(".workspace .cm-content .cm-line")];
    return lines.findIndex((l) => {
      const r = l.getBoundingClientRect();
      return y >= r.top && y < r.bottom;
    }) + 1;
  });
const lastRowShown = (page) => page.$eval(".lines-view", (e) => {
  const rows = [...e.querySelectorAll(".lv-row[data-line]")].map((r) => +r.dataset.line);
  return rows.length ? Math.max(...rows) : 0;
});
const firstRowShown = (page) =>
  page.$eval(".lines-view", (e) => {
    const sc = e.querySelector(".lv-scroll");
    const rows = [...e.querySelectorAll(".lv-row[data-line]")].filter((r) => r.offsetTop + r.offsetHeight > sc.scrollTop);
    return rows.length ? Math.min(...rows.map((r) => +r.dataset.line)) : 0;
  });

async function run(browserName, platform, url, dir) {
  const mac = platform === "darwin";
  const MOD = mac ? "Meta" : "Control";
  const modFlag = mac ? { metaKey: true } : { ctrlKey: true };
  where = `${browserName}·${mac ? "mac" : "win"}`;
  console.log(`\n=== ${where} ===`);
  const browser = await pw[browserName].launch({ headless: true });
  const findText = ["alpha", "foo one", "beta", "foo two", "gamma", "foo three", "delta"].join("\n");
  const logLines = [];
  for (let i = 1; i <= 400; i++) logLines.push(`2026-10-29 10:00:00 ERROR row ${i}`);
  const logPath = path.join(dir, "keys.log");
  fs.writeFileSync(logPath, logLines.join("\n"));
  try {
    // ======= A. the settings window: groups, scopes, mac symbols, wheel choice ==========
    console.log("A. 설정 화면 — 묶음·범위·표시");
    const be = makeBackend(platform);
    be.st.session = session(
      [tab("t1", "", { content: findText }), tab("t2", logPath, { lines: { on: true, above: 0, below: 0, off: [] } })],
      "t1"
    );
    const { ctx, page } = await openPage(browser, url, be);
    await page.waitForSelector(".cm-editor");
    const saveTip = await page.$eval("button[title^='저장 (']", (e) => e.title);
    ok(`툴바 저장 풍선 = ${mac ? "⌘S" : "Ctrl+S"}`, saveTip.startsWith(`저장 (${mac ? "⌘S" : "Ctrl+S"})`), saveTip);
    const saveAsTip = await page.$eval("button[title^='다른 이름으로 저장']", (e) => e.title);
    ok(`다른 이름으로 = ${mac ? "⇧⌘S" : "Ctrl+Shift+S"}`, saveAsTip.includes(mac ? "(⇧⌘S)" : "(Ctrl+Shift+S)"), saveAsTip);
    const fontTip = await page.$eval(".st-font", (e) => e.title);
    ok(`글자 크기 풍선 = ${mac ? "⌃/⌘+휠 · ⌘0" : "Ctrl+휠 · Ctrl+0"}`, mac ? fontTip.includes("⌃/⌘+휠") && fontTip.includes("⌘0") : fontTip.includes("Ctrl+휠") && fontTip.includes("Ctrl+0"), fontTip);
    const closeTip = await page.$eval(".tab .tab-close, .tab [title^='닫기']", (e) => e.title).catch(() => "");
    ok(`탭 닫기 풍선 = ${mac ? "⌘W" : "Ctrl+W"}`, closeTip.includes(mac ? "⌘W" : "Ctrl+W"), closeTip);
    const hint = await page.$eval(".pane-hint", (e) => e.textContent).catch(() => "");
    ok(`편집기 안내 = ${mac ? "⌥+드래그 · ⌘D" : "Alt+드래그 · Ctrl+D"}`, mac ? hint.includes("⌥+드래그") && hint.includes("⌘D") : hint.includes("Alt+드래그") && hint.includes("Ctrl+D"), hint);

    await openKeys(page);
    const groups = await page.$$eval(".keys-group", (els) => els.map((e) => e.dataset.group));
    ok("묶음: 파일·찾기·도구·줄 목록·확대·고정", JSON.stringify(groups) === '["file","find","tools","lines","zoom","fixed"]', groups);
    const rows = await page.$$eval(".keys-row[data-cmd]", (els) => els.map((e) => e.dataset.cmd));
    ok("바꿀 수 있는 기능 17개 + 휠", rows.length === 18 && rows.includes("findNext") && rows.includes("lvEnd") && rows.includes("wheelZoom"), rows);
    ok(`저장 = ${mac ? "⌘S" : "Ctrl+S"}`, (await bindText(page, "save")) === (mac ? "⌘S" : "Ctrl+S"), await bindText(page, "save"));
    ok(`다른 이름 = ${mac ? "⇧⌘S" : "Ctrl+Shift+S"}`, (await bindText(page, "saveAs")) === (mac ? "⇧⌘S" : "Ctrl+Shift+S"));
    ok(`이전 찾기 = ${mac ? "⇧F3" : "Shift+F3"}`, (await bindText(page, "findPrev")) === (mac ? "⇧F3" : "Shift+F3"));
    ok("맨 끝 줄로 = End", (await bindText(page, "lvEnd")) === "End");
    const scope = await page.$eval('.keys-row[data-cmd="lvEnd"] .keys-scope', (e) => e.textContent);
    ok("줄 목록 키의 범위가 보임", scope.includes("줄 목록 칸 안"), scope);
    const note = await page.$eval('.keys-group[data-group="lines"] .keys-note', (e) => e.textContent);
    ok("줄 목록 묶음 안내(Shift = 넓히기)", note.includes("Shift"), note);
    const fixed = await page.$eval('.keys-group[data-group="fixed"]', (e) => e.textContent);
    ok(`고정 키 목록에 ${mac ? "⌘C · ⌃Tab(⌘Tab 아님)" : "Ctrl+C · Ctrl+Tab"}`, mac ? fixed.includes("⌘C") && fixed.includes("⌃Tab") && !fixed.includes("⌘Tab") && fixed.includes("⌥+드래그") : fixed.includes("Ctrl+C") && fixed.includes("Ctrl+Tab"), fixed.slice(0, 200));
    const sel = await page.$('.keys-row[data-cmd="wheelZoom"] select');
    ok(mac ? "휠 선택(⌃·⌘·둘 다)이 있음" : "윈도우: 휠 선택 없이 Ctrl+휠 표시", mac ? !!sel : !sel && (await page.$eval('.keys-row[data-cmd="wheelZoom"]', (e) => e.textContent)).includes("Ctrl+휠"));
    if (mac) {
      const opts = await page.$$eval('.keys-row[data-cmd="wheelZoom"] option', (els) => els.map((e) => e.textContent));
      ok("휠 선택지 3개", opts.length === 3 && opts[0].includes("둘 다") && opts[1].includes("⌃") && opts[2].includes("⌘"), opts);
    }
    if (SHOTS) {
      await page.screenshot({ path: path.join(SHOTS, `keybinds-${browserName}-${mac ? "mac" : "win"}.png`) });
      await page.$eval('.keys-group[data-group="lines"]', (e) => e.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: path.join(SHOTS, `keybinds-${browserName}-${mac ? "mac" : "win"}-lines.png`) });
      await page.$eval(".keys-list", (e) => (e.scrollTop = e.scrollHeight));
      await page.screenshot({ path: path.join(SHOTS, `keybinds-${browserName}-${mac ? "mac" : "win"}-fixed.png`) });
      await page.$eval(".keys-list", (e) => (e.scrollTop = 0));
    }

    // ======= B. conflicts, reserved, capture with 한글 IME =================================
    console.log("B. 충돌·예약 키 · 한글 IME 로 잡기");
    await page.click('.keys-row[data-cmd="lvTop"] .keys-bind');
    await page.keyboard.press("End");
    ok("맨 위 ← End: 「맨 끝」과 충돌", (await keyError(page)).includes("맨 끝"), await keyError(page));
    await page.keyboard.press("Escape");
    await page.click('.keys-row[data-cmd="save"] .keys-bind');
    await page.keyboard.press(`${MOD}+c`);
    ok(`저장 ← ${mac ? "⌘C" : "Ctrl+C"}: 표준 키`, (await keyError(page)).includes(mac ? "⌘C" : "Ctrl+C") && (await keyError(page)).includes("표준"), await keyError(page));
    await page.keyboard.press("k");
    ok(`저장 ← K: ${mac ? "⌘·⌥" : "Ctrl·Alt"} 필요`, (await keyError(page)).includes(mac ? "⌘ 또는 ⌥" : "Ctrl 또는 Alt"), await keyError(page));
    await page.keyboard.press("Escape");
    ok("Esc = 그만두기, 저장은 그대로", (await bindText(page, "save")) === (mac ? "⌘S" : "Ctrl+S"));
    ok("Esc 한 번으로는 창이 안 닫힘", !!(await page.$(".keys-dialog")));
    await page.click('.keys-row[data-cmd="findNext"] .keys-bind');
    await page.keyboard.press("g");
    ok("다음 찾기 ← G: 글자 키는 안 됨", (await keyError(page)) !== "", await keyError(page));
    // the real key, then the IME one
    await page.keyboard.press(`${MOD}+g`);
    ok(`다음 찾기 ← ${mac ? "⌘G" : "Ctrl+G"}`, (await bindText(page, "findNext")) === (mac ? "⌘G" : "Ctrl+G"), await bindText(page, "findNext"));
    await page.click('.keys-row[data-cmd="lvEnd"] .keys-bind');
    await imeKey(page, "window", "ㅓ", "KeyJ", modFlag); // 한글 mode: key "ㅓ", physical J
    ok(`맨 끝 ← 한글 IME ${mac ? "⌘ㅓ" : "Ctrl+ㅓ"} = ${mac ? "⌘J" : "Ctrl+J"}`, (await bindText(page, "lvEnd")) === (mac ? "⌘J" : "Ctrl+J"), await bindText(page, "lvEnd"));
    await page.click('.keys-row[data-cmd="lvTop"] .keys-bind');
    await page.keyboard.press("Shift+End");
    ok("맨 위 ← Shift+End: Shift 는 빼고 End", (await bindText(page, "lvTop")) === "End", await bindText(page, "lvTop"));
    await page.click('.keys-row[data-cmd="new"] .keys-bind');
    await imeKey(page, "window", "ㅏ", "KeyK", { ...modFlag, altKey: true });
    ok(`새 파일 ← 한글 IME ${mac ? "⌥⌘ㅏ" : "Ctrl+Alt+ㅏ"}`, (await bindText(page, "new")) === (mac ? "⌥⌘K" : "Ctrl+Alt+K"), await bindText(page, "new"));
    const changed = await page.$$eval(".keys-bind.changed", (els) => els.length);
    ok("바꾼 줄 표시 4개", changed === 4, changed);
    await closeKeys(page);
    await sleep(600);
    const saved = JSON.parse(be.st.session);
    ok("세션에 저장 (새 기능 포함)", saved.keybindings.lvEnd === "ctrl+j" && saved.keybindings.findNext === "ctrl+g" && saved.keybindings.lvTop === "end" && saved.keybindings.new === "ctrl+alt+k", saved.keybindings);
    ok("세션에 휠 설정(기본 both)", saved.wheelZoom === "both", saved.wheelZoom);

    // ======= C. remapped keys work; the old ones do not ===================================
    console.log("C. 바꾼 키로 동작");
    const tabs0 = (await page.$$(".tabs-scroll .tab")).length;
    await page.click(".cm-content");
    await imeKey(page, ".cm-content", "ㅏ", "KeyK", { ...modFlag, altKey: true });
    await until(async () => (await page.$$(".tabs-scroll .tab")).length === tabs0 + 1, 3000);
    ok("새 파일: 한글 IME 로 바꾼 키", (await page.$$(".tabs-scroll .tab")).length === tabs0 + 1);
    await page.keyboard.press(`${MOD}+n`);
    await sleep(300);
    ok("옛 키(N)는 이제 아무것도 안 함", (await page.$$(".tabs-scroll .tab")).length === tabs0 + 1);
    await page.keyboard.press(`${MOD}+w`); // close the new tab
    await until(async () => (await page.$$(".tabs-scroll .tab")).length === tabs0, 3000);
    await page.click(".tabs-scroll .tab >> nth=0");
    await page.waitForSelector(".cm-editor");
    await page.click(".cm-content");
    await page.keyboard.press(`${MOD}+f`);
    await page.waitForSelector(".find-input");
    await page.fill(".find-input", "foo");
    await page.keyboard.press("Enter");
    const m1 = await until(() => selMatchLine(page), 3000);
    await page.keyboard.press(`${MOD}+g`);
    const m2 = await until(async () => ((await selMatchLine(page)) !== m1 ? selMatchLine(page) : 0), 3000);
    ok(`찾기 칸: ${mac ? "⌘G" : "Ctrl+G"} = 다음 찾기`, m1 === 2 && m2 === 4, { m1, m2 });
    await page.keyboard.press("F3");
    await sleep(200);
    ok("찾기 칸: 옛 F3 는 안 먹음", (await selMatchLine(page)) === 4, await selMatchLine(page));
    const nextTip = await page.$eval(".find-btn[title^='다음 찾기']", (e) => e.title);
    ok("다음 찾기 풍선에 바꾼 키", nextTip.includes(mac ? "⌘G" : "Ctrl+G"), nextTip);
    await page.click(".cm-content .cm-line >> nth=0");
    await page.keyboard.press(`${MOD}+g`);
    await sleep(200);
    ok(`편집기: ${mac ? "⌘G" : "Ctrl+G"} = 다음 찾기`, (await selMatchLine(page)) === 2, await selMatchLine(page));
    await page.keyboard.press("Shift+F3");
    await sleep(200);
    ok("편집기: 이전 찾기(Shift+F3) 그대로", (await selMatchLine(page)) === 6, await selMatchLine(page));

    // 🏷 줄만 보기 with the remapped End
    await page.click(".tabs-scroll .tab >> nth=1");
    await page.waitForSelector(".lines-view");
    await until(async () => (await page.$eval(".lines-view", (e) => e.dataset.state)) === "done", 15000);
    await until(async () => (await page.$$(".lv-row[data-line]")).length > 5, 5000);
    await page.focus(".lv-scroll");
    await page.keyboard.press("End");
    await sleep(400);
    ok("줄만 보기: End 는 맨 위 줄로(바꾼 대로)", (await firstRowShown(page)) === 1 && (await lastRowShown(page)) < 400, { first: await firstRowShown(page), last: await lastRowShown(page) });
    await imeKey(page, ".lv-scroll", "ㅓ", "KeyJ", modFlag);
    const tail = await until(async () => (await lastRowShown(page)) === 400, 4000);
    ok(`줄만 보기: 한글 IME ${mac ? "⌘ㅓ" : "Ctrl+ㅓ"} = 맨 끝`, !!tail, await lastRowShown(page));
    await page.keyboard.press("End");
    await until(async () => (await firstRowShown(page)) === 1, 4000);
    ok("줄만 보기: End(이제 맨 위) → 첫 줄", (await firstRowShown(page)) === 1, await firstRowShown(page));
    await page.keyboard.press(`Shift+${MOD}+j`);
    await until(async () => (await lastRowShown(page)) === 400, 4000);
    const selN = await page.$$eval(".lv-row.sel", (els) => els.length);
    ok(`줄만 보기: Shift+${mac ? "⌘J" : "Ctrl+J"} = 끝까지 넓혀 고름`, (await lastRowShown(page)) === 400 && selN > 5, { selN, last: await lastRowShown(page) });
    await page.keyboard.press(`${MOD}+Home`);
    await until(async () => (await firstRowShown(page)) === 1, 4000);
    ok(`줄만 보기: ${mac ? "⌘" : "Ctrl+"}Home(고정) → 첫 줄`, (await firstRowShown(page)) === 1, await firstRowShown(page));

    // ======= D. wheel zoom ==================================================================
    console.log("D. 휠 확대");
    await page.click(".tabs-scroll .tab >> nth=0");
    await page.waitForSelector(".cm-editor");
    const f0 = await fontPx(page);
    await modWheel(page, "Control", -100);
    const f1 = await fontPx(page);
    ok("Ctrl+휠 위 = 키움", f1 === f0 + 1, { f0, f1 });
    await modWheel(page, "Meta", -100);
    const f2 = await fontPx(page);
    ok(`${mac ? "⌘" : "Win"}+휠 위 = 키움 (기본 「둘 다」)`, f2 === f1 + 1, { f1, f2 });
    await modWheel(page, "", -100);
    ok("수식키 없는 휠 = 그대로", (await fontPx(page)) === f2);
    if (mac) {
      await openKeys(page);
      await page.selectOption('.keys-row[data-cmd="wheelZoom"] select', "ctrl");
      await closeKeys(page);
      await modWheel(page, "Meta", -100);
      ok("「⌃ 만」: ⌘+휠은 안 됨", (await fontPx(page)) === f2, await fontPx(page));
      await modWheel(page, "Control", -100);
      const f3 = await fontPx(page);
      ok("「⌃ 만」: ⌃+휠은 됨", f3 === f2 + 1, f3);
      ok("풍선 = ⌃+휠", (await page.$eval(".st-font", (e) => e.title)).includes("⌃+휠"));
      await openKeys(page);
      await page.selectOption('.keys-row[data-cmd="wheelZoom"] select', "meta");
      await closeKeys(page);
      await modWheel(page, "Control", 100);
      ok("「⌘ 만」: ⌃+휠은 안 됨", (await fontPx(page)) === f3, await fontPx(page));
      await modWheel(page, "Meta", 100);
      ok("「⌘ 만」: ⌘+휠 아래 = 줄임", (await fontPx(page)) === f3 - 1, await fontPx(page));
      await sleep(600);
      ok("세션에 휠 설정 meta", JSON.parse(be.st.session).wheelZoom === "meta");
    }
    // the 🏷 list and the preview follow the same size
    const fz = await fontPx(page);
    await page.click(".tabs-scroll .tab >> nth=1");
    await page.waitForSelector(".lv-scroll");
    const lvFont = await page.$eval(".lv-scroll", (e) => parseInt(e.style.fontSize, 10));
    ok("줄 목록 글자도 같은 크기", lvFont === fz, { lvFont, fz });
    // ⌘/Ctrl + wheel over the list zooms, and does not scroll it
    const top0 = await page.$eval(".lv-scroll", (e) => e.scrollTop);
    const box = await page.$eval(".lv-scroll", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + 100, y: r.top + 80 };
    });
    await page.mouse.move(box.x, box.y);
    await page.keyboard.down(mac ? "Meta" : "Control");
    await page.mouse.wheel(0, 300);
    await sleep(150);
    await page.keyboard.up(mac ? "Meta" : "Control");
    await sleep(150);
    ok("줄 목록 위 휠 = 줄임, 목록은 안 움직임", (await fontPx(page)) === fz - 1 && (await page.$eval(".lv-scroll", (e) => e.scrollTop)) === top0, { f: await fontPx(page), top0 });

    // ======= E. back to the defaults ========================================================
    console.log("E. 기본값으로");
    await openKeys(page);
    await page.click(".keys-dialog .chips-actions .tb-btn:not(.primary)");
    ok("기본값: 저장·새 파일·다음 찾기·맨 끝", (await bindText(page, "new")) === (mac ? "⌘N" : "Ctrl+N") && (await bindText(page, "findNext")) === "F3" && (await bindText(page, "lvEnd")) === "End" && (await bindText(page, "lvTop")) === "Home");
    if (mac) ok("기본값: 휠 둘 다", (await page.$eval('.keys-row[data-cmd="wheelZoom"] select', (e) => e.value)) === "both");
    // ✕ clears one key
    await page.click('.keys-row[data-cmd="chips"] .keys-clear');
    ok("✕ = 키 없음", (await bindText(page, "chips")) === "없음", await bindText(page, "chips"));
    await closeKeys(page);
    await sleep(600);
    const s2 = JSON.parse(be.st.session);
    ok("세션: chips = \"\" · 나머지 기본", s2.keybindings.chips === "" && s2.keybindings.lvEnd === "end" && s2.wheelZoom === "both", s2.keybindings);
    await ctx.close();

    // ======= F. a session from v1.3.1 =========================================================
    console.log("F. v1.3.1 세션 그대로 읽기");
    const be2 = makeBackend(platform);
    be2.st.session = session([tab("t1", "", { content: "x" })], "t1", {
      keybindings: { new: "ctrl+alt+n", open: "ctrl+o", save: "ctrl+s", saveAs: "ctrl+shift+s", close: "ctrl+w", find: "ctrl+f", replace: "ctrl+h", inClause: "ctrl+i", chips: "ctrl+p", resetZoom: "ctrl+0" },
    });
    const p2 = await openPage(browser, url, be2);
    await p2.page.waitForSelector(".cm-editor");
    await openKeys(p2.page);
    ok("옛 바꾼 키 그대로", (await bindText(p2.page, "new")) === (mac ? "⌥⌘N" : "Ctrl+Alt+N"));
    ok("새 기능은 기본값", (await bindText(p2.page, "findNext")) === "F3" && (await bindText(p2.page, "lvOpen")) === "Enter");
    await closeKeys(p2.page);
    const n0 = (await p2.page.$$(".tabs-scroll .tab")).length;
    await p2.page.click(".cm-content");
    await p2.page.keyboard.press(`${MOD}+Alt+n`);
    await until(async () => (await p2.page.$$(".tabs-scroll .tab")).length === n0 + 1, 3000);
    ok("옛 바꾼 키로 새 파일", (await p2.page.$$(".tabs-scroll .tab")).length === n0 + 1);
    await p2.ctx.close();

    // ======= G. the first-run welcome table =====================================================
    console.log("G. 환영 문서 단축키 표");
    const be3 = makeBackend(platform);
    const p3 = await openPage(browser, url, be3);
    await p3.page.waitForSelector(".cm-editor");
    const doc = await p3.page.$eval(".cm-content", (e) => e.textContent);
    ok(`환영 문서: 새 파일 = ${mac ? "⌘N" : "Ctrl + N"}`, mac ? doc.includes("`⌘N`") && doc.includes("`⇧⌘S`") : doc.includes("`Ctrl` + `N`") && doc.includes("`Ctrl` + `Shift` + `S`"), doc.slice(0, 600));
    await p3.ctx.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keybinds-e2e-"));
  const go = await startGo();
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    for (const b of BROWSERS) for (const p of PLATFORMS) await run(b, p, url, dir);
  } finally {
    srv.close();
    await goGet("/quit").catch(() => {});
    setTimeout(() => go.kill(), 3000).unref();
  }
  console.log(`\nkeybinds-e2e: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log(fails.map((f) => " - " + f).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
