// Headless test of the stage 4 fix (plan.md 「4단계 검토 판정」, 「user 확인 —
// common」, 「통합 판정 ①」): opening from the tree keeps the status bar in step,
// drag & drop, aria-selected, the menu key / Shift+F10 opening the menu once,
// save failures shown outside the assign window, the window's focus trap,
// common shown as a faint chip, 2-file rotation series, the 🏷 menu from the
// keyboard and 「이 폴더에 태그 지정」, Linux paths with Korean and spaces, no
// assigning before tags.json is read, and a big windowed tree.
// Same fake Go side as tags-assign-e2e.cjs.
//
//   cd frontend && npm run build && node tests/tags-assign-fix-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const notes = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}
function note(s) {
  notes.push(s);
  console.log("  note " + s);
}

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

function makeBackend() {
  const st = { session: "", tags: null, bak: null, calls: [], files: {}, scan: null };
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
      const v = JSON.parse(js);
      if (v.version !== 1 || !Array.isArray(v.tags)) throw new Error("bad envelope");
      if (st.tags != null) st.bak = st.tags;
      st.tags = js;
    },
    ReadFile: (p) => {
      const c = st.files[p];
      if (c == null) throw new Error("no such file " + p);
      return { path: p, name: p.split(/[\\/]/).pop(), content: c, modTime: 1, size: c.length, encoding: "utf-8", binary: false, canceled: false };
    },
    ReadFileAs: (p) => impl.ReadFile(p),
    StatFile: (p) => (st.files[p] != null ? { exists: true, modTime: 1, size: st.files[p].length } : { exists: false, modTime: 0, size: 0 }),
    ScanBundle: () => st.scan,
    OpenFolderDialog: () => (st.scan ? st.scan.root : ""),
    FrontendReady: () => [],
    AutoUpdate: () => ({ blocked: false, info: { available: false } }),
    GetPlatform: () => "windows",
    GetPendingReleaseNotes: () => null,
    FileAssociationSupported: () => false,
    SupportedFileTypes: () => [],
    AssociationStatus: () => ({}),
  };
  return {
    st,
    call: (name, args) => {
      st.calls.push({ name, args });
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

async function openPage(browser, url, be) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(500);
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
const spansWith = (page, color) =>
  page.$$eval(`.cm-content span[style*="color: ${rgb(color)}"]`, (els) => els.map((e) => e.textContent));
// coloured spans per pane, in pane order
const paneSpans = (page, color) =>
  page.$$eval(
    ".mpane",
    (panes, c) => panes.map((p) => [...p.querySelectorAll(`.cm-content span[style*="color: ${c}"]`)].map((e) => e.textContent)),
    rgb(color)
  );
const statusTags = (page) => page.$eval(".st-tags", (e) => e.textContent.trim()).catch(() => null);
// status bar text, waiting up to 3 s for it to become `want` (files load asynchronously)
async function statusIs(page, want) {
  let v;
  for (let i = 0; i < 30; i++) {
    v = await statusTags(page);
    if (v === want) return v;
    await sleep(100);
  }
  if (process.env.DIAG) console.log("DIAG", want, v, await page.$$eval(".mpane", (ps) => ps.map((p) => p.className + " | " + p.querySelector(".mp-title")?.textContent)), await page.$eval(".st-path", (e) => e.textContent).catch(() => "?"));
  return v;
}
const paneChips = (page) =>
  page.$$eval(".mpane", (ps) => ps.map((p) => [...p.querySelectorAll(".mp-tag")].map((e) => e.textContent).join(",")));
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const flush = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(600);
};
// a tree row by its data-key (server/rel path keys built by BundleTree)
const row = (key) => `.bt-row[data-key="${key}"]`;
const rowChips = (page, key) =>
  page.$$eval(`${row(key)} .bt-tag`, (es) => es.map((e) => ({ t: e.textContent, c: e.className, title: e.title })));

async function assignVia(page, rowKey, fn) {
  await page.click(row(rowKey), { button: "right" });
  await page.waitForSelector(".bt-menu");
  await page.click(".bt-menu >> text=태그 지정…");
  await page.waitForSelector(".tag-assign");
  const r = await fn();
  return r;
}
const checkTag = (page, name, on = true) => page.setChecked(`.ta-tag[data-tag="${name}"] input[type=checkbox]`, on);
const confirm = async (page) => {
  await page.click(".tag-assign .ta-ok");
  await sleep(250);
};

// ---------------------------------------------------------------------------
// stage 4 fix (plan.md 「4단계 검토 판정」 · 「user 확인 — common」 · 「통합 판정 ①」)

const isTreeRow = () => document.activeElement?.classList.contains("bt-row");
const activeKey = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-key") || document.activeElement?.className || document.activeElement?.tagName);
const kRule = { id: "k", on: true, label: "", pattern: "kafka", kind: "text", caseSensitive: false, color: "#dd0001", line: false, filter: true };
const store = (tags, assign = {}) =>
  JSON.stringify({ version: 1, tags: [{ name: "common", rules: [], updated: "" }, ...tags], assign: { dir: {}, file: {}, name: {}, ...assign } });

// a bundle: servers × [rel, text]; returns helpers
function bundle(be, R, servers, filesOf, sep = "\\") {
  const P = (sv, rel) => [R, sv, ...rel.split("/")].join(sep);
  const files = {};
  for (const sv of servers)
    for (const [rel, text] of filesOf(sv)) {
      be.st.files[P(sv, rel)] = text;
      (files[sv] = files[sv] || []).push({ rel, size: text.length, compressed: false });
    }
  be.st.scan = { root: R, servers: servers.map((name) => ({ name, files: files[name] || [], truncated: false, unreadable: 0 })) };
  return P;
}
const slotsFor = (list) => {
  const slots = list.map(([tabId, server]) => ({ tabId, mode: "read", server }));
  while (slots.length < 6) slots.push({ tabId: "", mode: "read", server: "" });
  return slots;
};

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    // ---------------- 1. 트리에서 열기·끌어다 놓기·aria-selected·메뉴 키 ----------------
    console.log("1. 트리에서 다른 서버 파일 열기 → 상태 표시줄, 끌어다 놓기, aria-selected, 메뉴 키");
    {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const servers = ["s1", "s2", "s3"];
      const P = bundle(be, R, servers, (sv) => ["a", "b", "c", "d"].map((n) => [`modules/col/${n}.log`, `${sv} ${n}\n`]));
      be.st.tags = store([]);
      const tabs = servers.map((sv, i) => tab("t" + i, P(sv, "modules/col/a.log"), { label: `${sv} · a.log` }));
      be.st.session = session(tabs, "t0", { multi: { on: true, count: 3, slots: slotsFor(servers.map((sv, i) => ["t" + i, sv])), bundle: { root: R, servers } } });
      const { ctx, page } = await openPage(browser, url, be);
      await page.fill(".bt-filter", "col");
      await sleep(200);
      const fileRow = (sv, rel) => row(`f:${sv}/${rel}`);
      let bad = 0;
      const seq = [["s2", "b"], ["s3", "c"], ["s1", "d"], ["s2", "c"], ["s3", "b"], ["s1", "b"], ["s3", "d"], ["s2", "d"], ["s1", "c"], ["s2", "a"]];
      for (const [sv, n] of seq) {
        await page.click(fileRow(sv, `modules/col/${n}.log`));
        await sleep(300);
        const st = await page.$eval(".st-path", (e) => e.textContent);
        if (st !== P(sv, `modules/col/${n}.log`)) bad++;
      }
      ok(`트리에서 연 파일 = 상태 표시줄 (${seq.length - bad}/${seq.length})`, bad === 0, bad);
      const sel = await page.$$eval('[role="treeitem"][aria-selected="true"]', (es) => es.map((e) => [e.getAttribute("data-key"), e.tabIndex]));
      ok("aria-selected 는 한 줄, 그 줄이 Tab 정지(tabIndex 0) = 마지막에 누른 줄", sel.length === 1 && sel[0][0] === "f:s2/modules/col/a.log" && sel[0][1] === 0, sel);
      ok("나머지 줄은 aria-selected=false", (await page.$$eval('[role="treeitem"][aria-selected="false"]', (es) => es.length)) > 5);
      // drag a tree file onto pane 3
      await page.evaluate((sel) => {
        const r = document.querySelector(sel);
        const dt = new DataTransfer();
        r.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const pane = document.querySelectorAll(".mpane")[2];
        const tgt = pane.querySelector(".cm-editor") || pane;
        for (const t of ["dragenter", "dragover", "drop"]) tgt.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        r.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      }, fileRow("s1", "modules/col/d.log"));
      await sleep(500);
      ok("끌어다 놓기: 3번 칸에 s1 d.log", (await page.$eval(".mpane >> nth=2 >> .mp-title", (e) => e.textContent)).includes("d.log"));
      ok("끌어다 놓기: 상태 표시줄도 그 파일", (await page.$eval(".st-path", (e) => e.textContent)) === P("s1", "modules/col/d.log"));

      // menu key / Shift+F10: the menu opens once, and the browser's contextmenu that follows does not move it
      await page.evaluate(() => {
        window.__ctx = [];
        window.addEventListener("contextmenu", (e) => window.__ctx.push({ prevented: e.defaultPrevented, cls: e.target.className }), false);
      });
      await page.focus(row("f:s1/modules/col/b.log"));
      for (const how of ["ContextMenu", "Shift+F10"]) {
        await page.keyboard.press(how);
        await sleep(250);
        const n1 = await page.$$eval(".bt-menu", (e) => e.length);
        const box1 = await page.$eval(".bt-menu", (e) => [e.style.left, e.style.top]);
        ok(`${how}: 메뉴 하나, 첫 항목에 포커스`, n1 === 1 && (await page.evaluate(() => document.activeElement?.classList.contains("menu-item"))), n1);
        // what WebView2 may send after the key: contextmenu at the mouse position, on the row or the menu
        const prevented = await page.evaluate(() => {
          const out = [];
          for (const el of [document.querySelector('.bt-row[data-key="f:s1/modules/col/b.log"]'), document.activeElement]) {
            const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 });
            el.dispatchEvent(ev);
            out.push(ev.defaultPrevented);
          }
          return out;
        });
        await sleep(150);
        const box2 = await page.$eval(".bt-menu", (e) => [e.style.left, e.style.top]).catch(() => null);
        ok(`${how}: 뒤따르는 contextmenu 로 메뉴가 다시 열리거나 옮겨지지 않음`, JSON.stringify(box1) === JSON.stringify(box2), [box1, box2]);
        ok(`${how}: 뒤따르는 contextmenu 는 막힘 (WebView2 기본 메뉴 안 뜸)`, prevented.every(Boolean), prevented);
        await page.keyboard.press("Escape");
        await sleep(100);
        ok(`${how}: Esc → 메뉴 닫히고 그 줄로 포커스`, !(await page.$(".bt-menu")) && (await activeKey(page)) === "f:s1/modules/col/b.log", await activeKey(page));
      }
      const realCtx = await page.evaluate(() => window.__ctx);
      note("헤드리스 크로미움에서 키가 실제로 만든 contextmenu: " + JSON.stringify(realCtx.filter((x) => !x.cls.includes?.("menu-item") || true).length) + "건 " + JSON.stringify(realCtx.slice(0, 6)));
      await sleep(900);
      const rb = await page.$eval(row("f:s1/modules/col/c.log"), (e) => {
        const r = e.getBoundingClientRect();
        return [r.left + 30, r.top + 5];
      });
      await page.mouse.click(rb[0], rb[1], { button: "right" });
      await sleep(150);
      const mb = await page.$eval(".bt-menu", (e) => [e.style.left, e.style.top]).catch((e) => String(e).slice(0, 80));
      ok("마우스 우클릭은 그대로 그 자리에 메뉴", Array.isArray(mb) && Math.abs(parseFloat(mb[0]) - rb[0]) < 2, [mb, rb]);
      await page.keyboard.press("Escape");
      await ctx.close();
    }

    // ---------------- 2. 저장 실패 표시 · 지정 창 포커스 가두기 ----------------
    console.log("2. 지정 뒤 저장 실패가 창 밖에 보임 · 지정 창 Tab 가두기·aria-modal");
    {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = bundle(be, R, ["s1", "s2"], () => [["m/x.log", "kafka\n"]]);
      be.st.tags = store([{ name: "k", rules: [kRule], updated: "" }]);
      be.st.session = session([tab("t0", P("s1", "m/x.log"), { label: "s1 · x.log" })], "t0", {
        multi: { on: true, count: 2, slots: slotsFor([["t0", "s1"], ["", "s2"]]), bundle: { root: R, servers: ["s1", "s2"] } },
      });
      let failSave = true;
      const orig = be.call;
      be.call = (name, args) => {
        if (name === "SaveTags" && failSave) {
          be.st.calls.push({ name });
          throw new Error("disk full (test)");
        }
        return orig(name, args);
      };
      const { ctx, page } = await openPage(browser, url, be);
      ok("(앞 조건) 처음엔 저장 경고 없음", !(await page.$(".st-tags-warn")) && !(await page.$(".bt-save-warn")));
      await assignVia(page, "d:s1/m", async () => {
        await checkTag(page, "k");
        await confirm(page);
      });
      await sleep(300); // no blur: 확인 saves at once
      ok("저장을 시도함", be.st.calls.some((c) => c.name === "SaveTags"));
      const warn = await page.$eval(".st-tags-warn", (e) => e.textContent).catch(() => "");
      ok("상태 표시줄에 「⚠ 태그 저장 실패」", warn.includes("태그 저장 실패"), warn);
      ok("트리 위에도 저장 실패 알림", (await page.$eval(".bt-save-warn", (e) => e.textContent).catch(() => "")).includes("저장되지 않았습니다"));
      ok("화면 글자에 「저장 실패」(창 밖)", !(await page.$(".tag-assign")) && (await page.evaluate(() => document.body.innerText)).includes("저장 실패"));
      ok("상태 표시줄 🏷 글자는 그대로 (경고는 따로)", (await statusTags(page)) === "🏷 common + k", await statusTags(page));
      await page.click(".st-tags-warn");
      await page.waitForSelector(".tags-dialog");
      ok("경고를 누르면 태그 창(자세한 이유)", (await page.evaluate(() => document.querySelector(".tags-dialog")?.innerText || "")).includes("disk full"));
      await page.keyboard.press("Escape");
      await sleep(200);
      if (await page.$(".tags-dialog")) await page.click(".tags-dialog .chips-actions button:last-child").catch(() => {});
      await sleep(200);
      // save works again → the warning goes away on the next save
      failSave = false;
      await assignVia(page, "d:s1/m", async () => {
        await checkTag(page, "k", false);
        await confirm(page);
      });
      await sleep(400);
      ok("저장이 다시 되면 경고 사라짐", !(await page.$(".st-tags-warn")) && !(await page.$(".bt-save-warn")));
      ok("저장된 지정 = 상위 따르기 (키 없음)", JSON.stringify(savedTags(be).assign.dir) === "{}", savedTags(be).assign);

      // focus trap, opened from the keyboard
      await page.focus(row("d:s1/m"));
      await page.keyboard.press("Shift+F10");
      await sleep(150);
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tag-assign");
      const dlg = await page.$eval(".tag-assign", (e) => [e.getAttribute("role"), e.getAttribute("aria-modal"), document.getElementById(e.getAttribute("aria-labelledby") || "")?.textContent || ""]);
      ok("지정 창 role=dialog · aria-modal=true · 제목 연결", dlg[0] === "dialog" && dlg[1] === "true" && dlg[2].startsWith("🏷 태그 지정"), dlg);
      const outside = [];
      for (const key of ["Tab", "Shift+Tab"])
        for (let i = 0; i < 14; i++) {
          await page.keyboard.press(key);
          if (!(await page.evaluate(() => !!document.activeElement?.closest(".tag-assign")))) outside.push(key + ":" + (await activeKey(page)));
        }
      ok("Tab·Shift+Tab 28번 모두 창 안", outside.length === 0, outside.slice(0, 4));
      // focus pushed outside by a script also comes back
      await page.evaluate(() => document.querySelector(".bt-filter").focus());
      ok("창 밖으로 옮겨진 포커스는 창 안으로 돌아옴", await page.evaluate(() => !!document.activeElement?.closest(".tag-assign")));
      await page.keyboard.press("Escape");
      await sleep(150);
      ok("Esc → 창 닫고 트리 줄로 포커스", !(await page.$(".tag-assign")) && (await activeKey(page)) === "d:s1/m", await activeKey(page));
      await ctx.close();
    }

    // ---------------- 3. common 칩 · 묶음 줄 2개 · 탭/상태 표시줄 메뉴 ----------------
    console.log("3. common 옅은 칩, 회전 묶음 2개부터, 탭·상태 표시줄 🏷 메뉴(키보드·이 폴더에 태그)");
    {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = bundle(be, R, ["s1", "s2"], (sv) => [
        ["modules/col/a.log", `${sv} kafka a\n`],
        ["modules/col/z.log", "z now\n"],
        ["modules/col/z.log.1", "z old\n"],
        ["modules/col/y.log.1", "y1\n"],
        ["modules/col/y.log.2", "y2\n"],
        ["modules/col/w.log", "w\n"],
        ["top.log", `${sv} kafka top\n`],
      ]);
      be.st.files["D:\\out\\messages"] = "kafka out\n";
      be.st.tags = store([{ name: "k", rules: [kRule], updated: "" }]);
      be.st.session = session(
        [
          tab("t0", P("s1", "modules/col/a.log"), { label: "s1 · a.log" }),
          tab("t1", P("s2", "modules/col/a.log"), { label: "s2 · a.log" }),
          tab("t2", P("s1", "top.log"), { label: "s1 · top.log" }),
          tab("out", "D:\\out\\messages"),
        ],
        "t0",
        { multi: { on: true, count: 2, slots: slotsFor([["t0", "s1"], ["t1", "s2"]]), bundle: { root: R, servers: ["s1", "s2"] } } }
      );
      const { ctx, page } = await openPage(browser, url, be);
      await page.click(row("d:s1/modules"));
      await page.click(row("d:s1/modules/col"));
      await sleep(150);
      // rotation series from 2 files
      ok("z.log + z.log.1 (지금 파일 + 회전 1개) = 묶음 줄", !!(await page.$(row("r:s1/modules/col/z.log"))) && !(await page.$(row("f:s1/modules/col/z.log"))));
      ok("y.log.1 + y.log.2 (회전 파일 2개) = 묶음 줄", !!(await page.$(row("r:s1/modules/col/y.log"))));
      ok("w.log 하나 = 파일 줄", !!(await page.$(row("f:s1/modules/col/w.log"))) && !(await page.$(row("r:s1/modules/col/w.log"))));
      ok("묶음 줄 이름 (2)", (await page.$eval(row("r:s1/modules/col/z.log"), (e) => e.querySelector(".bt-name").textContent)).includes("z.log (2)"));
      // common chip everywhere, but not on lines inside a series
      const commonOn = async (key) => page.$eval(row(key), (e) => !!e.querySelector(".bt-common")).catch(() => null);
      ok("트리: 서버·폴더·파일·묶음 줄에 common 옅은 칩", (await commonOn("s:s1")) && (await commonOn("d:s1/modules/col")) && (await commonOn("f:s1/modules/col/a.log")) && (await commonOn("r:s1/modules/col/z.log")));
      await page.click(row("r:s1/modules/col/z.log"));
      await sleep(100);
      ok("묶음 안 줄에는 칩 없음 (묶음 줄이 보여 줌)", (await commonOn("f:s1/modules/col/z.log.1")) === false);
      await page.click(row("r:s1/modules/col/z.log"));
      ok("칸 아래 줄: 태그가 없어도 common 옅은 칩", (await page.$$eval(".mpane .mp-common", (es) => es.map((e) => e.textContent))).join("|") === "common|common");
      ok("칸 아래 줄: 다른 태그 칩은 없음", (await paneChips(page)).join("|") === "|");

      // 「태그 없음」 keeps common
      await assignVia(page, "r:s1/modules/col/z.log", async () => {
        const w = await page.$eval(".ta-where", (e) => e.textContent);
        ok("2개 묶음 줄 지정 문장 「z.log 와 회전 파일 모두」", w.includes("modules/col/z.log 와 회전 파일 모두"), w);
        ok("common 줄 문구: 「태그 없음」이어도 남음", (await page.$eval(".ta-common", (e) => e.textContent)).includes("「태그 없음」이어도 남습니다"));
        const noneNote = await page.$eval('.ta-modes label:has-text("태그 없음")', (e) => e.textContent);
        ok("「태그 없음」 선택지에 「common 은 그대로 적용」", noneNote.includes("common 은 그대로 적용"), noneNote);
        await page.click('.ta-modes label:has-text("태그 없음") input');
        await confirm(page);
      });
      const zc = await page.$eval(row("r:s1/modules/col/z.log"), (e) => [...e.querySelectorAll(".bt-common, .bt-tag")].map((x) => x.className + ":" + x.textContent));
      ok("태그 없음 줄 = common 칩 + 태그 없음 칩", zc.length === 2 && zc[0].startsWith("bt-common") && zc[1].includes("태그 없음"), zc);
      ok("태그 없음 툴팁에 common 은 항상 적용", (await page.$eval(row("r:s1/modules/col/z.log") + " .bt-tag.none", (e) => e.title)).includes("common 은 항상 적용"));
      ok("저장 키 modules/col/z.log = []", JSON.stringify(savedTags(be).assign.file) === JSON.stringify({ "modules/col/z.log": [] }), savedTags(be).assign.file);

      // common chip opens the tag window at common
      await page.click(".mpane >> nth=0 >> .mp-common");
      await page.waitForSelector(".tags-dialog");
      ok("칸 아래 common 칩 → 태그 창 common", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent).catch(() => "")) === "common");
      await page.keyboard.press("Escape");
      await sleep(200);
      if (await page.$(".tags-dialog")) await page.click(".tags-dialog .chips-actions button:last-child").catch(() => {});
      await sleep(150);

      // status bar 🏷 menu from the keyboard
      await page.click(".mpane >> nth=0 >> .cm-content");
      await page.focus(".st-tags");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tag-menu");
      const roles = await page.$eval(".tag-menu", (m) => [m.getAttribute("role"), [...m.querySelectorAll(".menu-item")].map((b) => b.getAttribute("role") + ":" + b.textContent)]);
      ok("메뉴 role=menu, 항목 role=menuitem", roles[0] === "menu" && roles[1].every((x) => x.startsWith("menuitem:")), roles);
      ok("묶음 파일 메뉴 = 이 파일 / 이 폴더(modules/col) / 태그 창", JSON.stringify(roles[1].map((x) => x.slice(9))) === JSON.stringify(["🏷 이 파일(회전 파일 포함)에 태그 지정…", "🏷 이 폴더(modules/col)에 태그 지정…", "태그 창 열기 (규칙 고치기)"]), roles[1]);
      const focusedItem = () => page.evaluate(() => (document.activeElement?.classList.contains("menu-item") ? [...document.activeElement.parentElement.querySelectorAll(".menu-item")].indexOf(document.activeElement) : -1));
      ok("Enter 로 열면 첫 항목에 포커스", (await focusedItem()) === 0);
      const moves = [];
      for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "End", "Home"]) {
        await page.keyboard.press(k);
        moves.push(await focusedItem());
      }
      ok("↓↓↓(돌아옴) ↑ End Home", JSON.stringify(moves) === JSON.stringify([1, 2, 0, 2, 2, 0]), moves);
      await page.keyboard.press("Escape");
      await sleep(100);
      ok("Esc → 메뉴 닫고 🏷 로 포커스", !(await page.$(".tag-menu")) && (await page.evaluate(() => document.activeElement?.classList.contains("st-tags"))));
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tag-menu");
      await page.keyboard.press("Tab");
      await sleep(100);
      ok("Tab → 메뉴 닫고 🏷 로 포커스", !(await page.$(".tag-menu")) && (await page.evaluate(() => document.activeElement?.classList.contains("st-tags"))));
      // 「이 폴더에 태그 지정」 from the status bar
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tag-menu");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tag-assign");
      ok("이 폴더 → 지정 창 제목 col", (await page.$eval(".tag-assign .chips-title", (e) => e.textContent)) === "🏷 태그 지정 — col");
      ok("이 폴더 → 문장 「모든 서버의 modules/col 폴더」", (await page.$eval(".ta-where", (e) => e.textContent)).includes("모든 서버의 modules/col 폴더와 그 아래 모든 파일"));
      await checkTag(page, "k");
      await confirm(page);
      await sleep(200);
      ok("저장: assign.dir modules/col = [k]", JSON.stringify(savedTags(be).assign.dir) === JSON.stringify({ "modules/col": ["k"] }), savedTags(be).assign.dir);
      ok("트리 폴더 줄 직접 칩 k", (await rowChips(page, "d:s1/modules/col")).some((c) => c.t === "k" && c.c.includes("direct")));
      ok("두 칸 모두 k 색", (await paneSpans(page, "#dd0001")).every((x) => x.includes("kafka")));
      ok("칸 아래 줄 = common + k", (await paneChips(page)).join("|") === "k|k" && (await page.$$(".mpane .mp-common")).length === 2);
      ok("확인 뒤 🏷 로 포커스 복귀", await page.evaluate(() => document.activeElement?.classList.contains("st-tags")));
      const tip = await page.$eval(".mpane >> nth=0 >> .mp-tags", (e) => e.title);
      ok("칸 칩 툴팁 띄어쓰기 「폴더 modules/col 에서 + common」", tip.includes("폴더 modules/col 에서 + common"), tip);

      // tab right-click → assign window → close: focus goes back to that tab
      await page.click(".tab:has-text('s2 · a.log')", { button: "right" });
      await page.waitForSelector(".tag-menu");
      await page.click(".tag-menu >> text=이 파일(회전 파일 포함)에 태그 지정…");
      await page.waitForSelector(".tag-assign");
      await page.click(".tag-assign .chips-actions button:has-text('취소')");
      await sleep(150);
      ok("탭 메뉴에서 연 창을 닫으면 그 탭으로 포커스", await page.evaluate(() => document.activeElement?.classList.contains("tab") && document.activeElement.textContent.includes("s2 · a.log")));
      // a file right under the server folder → 「이 서버 폴더 전체」
      await page.click(".tab:has-text('s1 · top.log')", { button: "right" });
      await page.waitForSelector(".tag-menu");
      const topItems = await page.$$eval(".tag-menu .menu-item", (es) => es.map((e) => e.textContent));
      ok("서버 폴더 바로 아래 파일 → 「이 서버 폴더 전체에 태그 지정…」", topItems.includes("🏷 이 서버 폴더 전체에 태그 지정…"), topItems);
      await page.click(".tag-menu >> text=이 서버 폴더 전체에 태그 지정…");
      await page.waitForSelector(".tag-assign");
      ok("서버 폴더 전체 문장", (await page.$eval(".ta-where", (e) => e.textContent)).startsWith("모든 서버의 서버 폴더 전체"));
      ok("창 제목 「s1 서버 폴더 전체」", (await page.$eval(".tag-assign .chips-title", (e) => e.textContent)) === "🏷 태그 지정 — s1 서버 폴더 전체");
      await page.keyboard.press("Escape");
      await sleep(100);
      // outside the bundle: no folder item
      await page.click(".tab:has-text('messages')", { button: "right" });
      await page.waitForSelector(".tag-menu");
      const outItems = await page.$$eval(".tag-menu .menu-item", (es) => es.map((e) => e.textContent));
      ok("묶음 밖 파일 메뉴엔 폴더 지정 없음", !outItems.some((x) => x.includes("폴더")) && outItems[0].includes("이 이름(messages)"), outItems);
      await page.keyboard.press("Escape");
      // the dialog's "now" line spacing for the server root
      await assignVia(page, "s:s1", async () => {
        await checkTag(page, "k");
        await confirm(page);
      });
      await assignVia(page, "d:s1/modules", async () => {
        const now = await page.$eval(".ta-now", (e) => e.textContent);
        ok("「지금: 서버 폴더 전체에서 물려받는 중」 (띄어쓰기)", now.startsWith("지금: 서버 폴더 전체에서 물려받는 중"), now);
        await page.keyboard.press("Escape");
      });
      await ctx.close();
    }

    // ---------------- 4. 리눅스 경로·한글·공백, 회전 2개 묶음 ----------------
    console.log("4. 리눅스 묶음(한글·공백) · app 1.log + app 1.log.1 묶음에 지정");
    {
      const be = makeBackend();
      const R = "/home/q/묶음 a";
      const servers = ["서버 1", "s2"];
      const P = bundle(be, R, servers, () => [["로그 폴더/app 1.log", "kafka here\n"], ["로그 폴더/app 1.log.1", "kafka old\n"], ["Other/x.log", "kafka x\n"]], "/");
      be.st.tags = store([{ name: "k", rules: [kRule], updated: "" }]);
      const tabs = servers.map((sv, i) => tab("t" + i, P(sv, "로그 폴더/app 1.log"), { label: `${sv} · app 1.log` }));
      be.st.session = session(tabs, "t0", { multi: { on: true, count: 2, slots: slotsFor(servers.map((sv, i) => ["t" + i, sv])), bundle: { root: R, servers } } });
      const { ctx, page } = await openPage(browser, url, be);
      await assignVia(page, "d:서버 1/로그 폴더", async () => {
        await checkTag(page, "k");
        await confirm(page);
      });
      ok("저장 키 「로그 폴더」", JSON.stringify(savedTags(be).assign.dir) === JSON.stringify({ "로그 폴더": ["k"] }), savedTags(be).assign);
      ok("두 서버 칸 모두 k 색", (await paneSpans(page, "#dd0001")).every((x) => x.includes("kafka")));
      ok("다른 서버 트리 줄도 칩", (await rowChips(page, "d:s2/로그 폴더")).some((c) => c.t === "k"));
      await page.click(row("d:서버 1/로그 폴더"));
      ok("app 1.log + app 1.log.1 = 묶음 줄", !!(await page.$(row("r:서버 1/로그 폴더/app 1.log"))));
      await assignVia(page, "r:서버 1/로그 폴더/app 1.log", async () => {
        ok("문장 「로그 폴더/app 1.log 와 회전 파일 모두」", (await page.$eval(".ta-where", (e) => e.textContent)).includes("로그 폴더/app 1.log 와 회전 파일 모두"));
        await page.click('.ta-modes label:has-text("태그 없음") input');
        await confirm(page);
      });
      ok("저장 키 app 1.log = []", JSON.stringify(savedTags(be).assign.file) === JSON.stringify({ "로그 폴더/app 1.log": [] }), savedTags(be).assign.file);
      ok("지금 파일 app 1.log 칸들은 색 꺼짐", (await paneSpans(page, "#dd0001")).every((x) => x.length === 0), await paneSpans(page, "#dd0001"));
      await page.click(row("r:서버 1/로그 폴더/app 1.log"));
      await page.click(row("f:서버 1/로그 폴더/app 1.log.1"));
      ok("회전 파일 app 1.log.1 도 common 만", (await statusIs(page, "🏷 common")) === "🏷 common", await statusTags(page));
      await ctx.close();
    }

    // ---------------- 5. 태그 파일을 읽기 전에는 지정 안 됨 ----------------
    console.log("5. tags.json 을 읽는 동안 지정 메뉴는 꺼짐");
    {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = bundle(be, R, ["s1"], () => [["m/x.log", "kafka\n"]]);
      be.st.tags = store([{ name: "k", rules: [kRule], updated: "" }], { dir: { m: ["k"] } });
      be.st.session = session([tab("t0", P("s1", "m/x.log"), { label: "s1 · x.log" })], "t0", {
        multi: { on: true, count: 1, slots: slotsFor([["t0", "s1"]]), bundle: { root: R, servers: ["s1"] } },
      });
      let release;
      const gate = new Promise((r) => (release = r));
      const orig = be.call;
      be.call = (name, args) => (name === "LoadTags" ? gate.then(() => orig(name, args)) : orig(name, args));
      const { ctx, page } = await openPage(browser, url, be);
      await page.click(".tab", { button: "right" });
      await page.waitForSelector(".tag-menu");
      const items = await page.$$eval(".tag-menu .menu-item", (es) => es.map((e) => [e.textContent, e.disabled, e.title]));
      ok("읽기 전: 이 파일·이 폴더 지정 꺼짐 + 이유", items[0][1] && items[1][1] && items[0][2] === "태그 파일을 읽는 중입니다", items);
      await page.keyboard.press("Escape");
      release();
      await sleep(600);
      await page.click(".tab", { button: "right" });
      await page.waitForSelector(".tag-menu");
      const items2 = await page.$$eval(".tag-menu .menu-item", (es) => es.map((e) => e.disabled));
      ok("읽은 뒤: 켜짐", !items2[0] && !items2[1], items2);
      await page.keyboard.press("Escape");
      ok("읽은 지정이 그대로 (덮어쓰지 않음)", (await statusIs(page, "🏷 common + k")) === "🏷 common + k", await statusTags(page));
      await ctx.close();
    }

    // ---------------- 6. 큰 트리: 보이는 줄만 그려도 키보드·Tab 정지가 맞음 ----------------
    console.log("6. 큰 트리(약 1만 줄): 보이는 줄만 그리기 + 키보드");
    {
      const be = makeBackend();
      const R = "C:\\b\\big";
      const servers = ["s1", "s2", "s3"];
      bundle(be, R, servers, () => {
        const out = [];
        for (let d = 0; d < 33; d++) for (let f = 0; f < 75; f++) out.push([`modules/d${d}/f${f % 25}.log${f >= 25 ? "." + Math.floor(f / 25) : ""}`, "x\n"]);
        return out;
      });
      be.st.tags = store([]);
      be.st.session = session([], "", { multi: { on: true, count: 3, slots: slotsFor(servers.map((sv) => ["", sv])), bundle: { root: R, servers } } });
      const { ctx, page } = await openPage(browser, url, be);
      await page.waitForSelector(".bt-filter");
      await page.fill(".bt-filter", "f");
      await sleep(300);
      const total = await page.$eval(".bt-body", (e) => +e.getAttribute("data-rows"));
      const drawn = await page.$$eval(".bt-row", (e) => e.length);
      ok(`(앞 조건) 줄 ${total.toLocaleString()}개`, total > 9000, total);
      ok(`그리는 줄은 일부 (${drawn})`, drawn < 400, drawn);
      ok("스크롤 높이 = 줄 수 × 줄 높이", Math.abs((await page.$eval(".bt-body", (e) => e.scrollHeight)) - total * 21) <= 12);
      await page.keyboard.press("ArrowDown"); // filter → tree
      ok("거르기 칸 ↓ → 첫 줄", (await activeKey(page)) === "s:s1");
      await page.keyboard.press("End");
      await sleep(50);
      const endKey = await activeKey(page);
      const vis = async () =>
        page.evaluate(() => {
          const b = document.querySelector(".bt-body").getBoundingClientRect();
          const r = document.activeElement.getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        });
      ok("End → 마지막 줄, 화면 안", endKey.startsWith("f:s3/modules/d9/") || endKey.startsWith("f:s3/"), endKey);
      ok("End 뒤 마지막 줄이 보임", await vis());
      for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
      ok("↑ 40번 뒤에도 포커스 줄이 보임", (await vis()) && (await page.evaluate(isTreeRow)));
      await page.keyboard.press("Home");
      ok("Home → 첫 줄", (await activeKey(page)) === "s:s1" && (await vis()));
      for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
      const k60 = await activeKey(page);
      ok("↓ 60번 → 61번째 줄, 보임", (await page.evaluate((k) => [...document.querySelectorAll(".bt-row")].some((e) => e.getAttribute("data-key") === k), k60)) && (await vis()));
      // scroll far away with the mouse wheel; the Tab stop must still exist
      await page.$eval(".bt-body", (e) => (e.scrollTop = e.scrollHeight));
      await sleep(150);
      ok("멀리 스크롤해도 Tab 정지 줄은 남아 있음", (await page.$$eval('.bt-row[tabindex="0"]', (es) => es.map((e) => e.getAttribute("data-key")))).join() === k60);
      ok("멀리 스크롤하면 그 자리 줄이 그려짐", (await page.$$eval(".bt-row", (es) => es.some((e) => e.getAttribute("data-key").startsWith("f:s3/")))));
      await page.focus(".bt-filter");
      await page.keyboard.press("ArrowDown");
      await sleep(50);
      ok("거르기 칸 ↓ → 그 줄로 돌아가 보임", (await activeKey(page)) === k60 && (await vis()));
      const sel = await page.$$eval('[aria-selected="true"]', (es) => es.map((e) => e.getAttribute("data-key")));
      ok("aria-selected 한 줄", sel.length === 1 && sel[0] === k60, sel);
      // right-click menu still works on a windowed line
      await page.keyboard.press("Shift+F10");
      await sleep(150);
      ok("큰 트리에서도 Shift+F10 메뉴", (await page.$$(".bt-menu")).length === 1);
      await page.keyboard.press("Escape");
      await page.fill(".bt-filter", "");
      await sleep(200);
      ok("거르기 지우면 작은 트리 (모두 그림)", (await page.$eval(".bt-body", (e) => +e.getAttribute("data-rows"))) === (await page.$$eval(".bt-row", (e) => e.length)));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
    console.log(`\nassign fix e2e: ${pass} passed, ${fails.length} failed`);
    for (const n of notes) console.log("NOTE " + n);
    for (const f of fails) console.log("FAIL " + f);
    if (fails.length) process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
