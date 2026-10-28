// Headless test of the tag window's 「적용」 button (10-28, testers: 「닫기 하면
// 취소」): changes in the window are a draft until 적용 / 확인; 닫기 · Esc · ×
// throw it away; a click outside does nothing; saves made outside the window
// while it is open (tree 「태그 지정」, import) are kept when the draft is applied.
// Harness = tags-io-e2e.cjs (Go side faked in Node) + a bundle scan.
//
//   cd frontend && npm run build && node tests/tags-apply-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder>  → tags-apply-dirty.png, tags-apply-rebased.png
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = process.env.DIST ? path.resolve(process.env.DIST) : path.join(__dirname, "..", "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
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

// tags_io.go parseTagsImport, reduced
function fakeParse(name, text) {
  const out = { path: "C:\\in\\" + name, file: name, error: "", tags: [], problems: [], tagsJson: false, assign: null };
  let v;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    out.error = text.trim() ? "JSON 형식이 아닙니다: " + e.message : "빈 파일입니다";
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...out, error: "chipper 태그 파일이 아닙니다 (맨 바깥이 { } 가 아님)" };
  if (v.format !== "chipper-tags") return { ...out, error: 'chipper 태그 파일이 아닙니다 ("format": "chipper-tags" 가 없음)' };
  if (v.version > 1) return { ...out, error: `더 새 버전의 chipper 가 만든 태그 파일입니다 (version ${v.version})` };
  const seen = new Set();
  (v.tags || []).forEach((t, i) => {
    if (typeof t.name !== "string" || !t.name || t.name.trim() !== t.name) return out.problems.push(`${i + 1}번째 태그: 이름이 잘못돼 뺐습니다`);
    if (seen.has(t.name)) return out.problems.push(`태그 「${t.name}」 가 이 파일에 두 번 있어 첫 번째만 가져옵니다`);
    seen.add(t.name);
    out.tags.push({ name: t.name, rules: Array.isArray(t.rules) ? t.rules : [] });
  });
  if (!out.tags.length) out.error = "가져올 수 있는 태그가 없습니다";
  if (v.assign && typeof v.assign === "object") out.assign = { dir: v.assign.dir || {}, file: v.assign.file || {}, name: v.assign.name || {} };
  return out;
}

function makeBackend() {
  const st = {
    session: "",
    tags: null,
    bak: null,
    calls: [],
    files: {},
    failSave: null,
    failBackup: null,
    exports: [],
    exportCancel: false,
    exportConfirm: false,
    written: {},
    importQueue: [],
    backups: [], // newest last
    scan: null,
  };
  let seq = 0;
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
      if (st.failSave) throw new Error(st.failSave);
      const v = JSON.parse(js);
      if (v.version !== 1 || !Array.isArray(v.tags)) throw new Error("bad envelope");
      const names = v.tags.map((t) => t.name);
      if (new Set(names).size !== names.length) throw new Error("dup tag name");
      if (st.tags != null && st.tags !== js) st.bak = st.tags;
      st.tags = js;
    },
    ExportTagsDialog: (defaultName, data) => {
      st.exports.push({ defaultName, data });
      if (st.exportCancel) return { path: "", confirm: false };
      const v = JSON.parse(data);
      if (v.format !== "chipper-tags") throw new Error("not an export");
      const p = "C:\\out\\" + defaultName;
      if (st.exportConfirm) return { path: p, confirm: true };
      st.written[p] = data;
      return { path: p, confirm: false };
    },
    ExportTagsTo: (p, data) => {
      st.written[p] = data;
      return p;
    },
    ImportTagsDialog: () => (st.importQueue.shift() || []).map((f) => fakeParse(f.name, f.text)),
    BackupTagsBefore: (kind, data) => {
      if (st.failBackup) throw new Error(st.failBackup);
      const v = JSON.parse(data);
      if (!v.assign) throw new Error("[TAGS_INVALID] not a whole store");
      const file = `before-${kind}-20261027-1530${String(10 + seq++).padStart(2, "0")}.000.json`;
      st.backups.push({ file, kind, data });
      return file;
    },
    ListTagsBackups: () =>
      st.backups
        .slice()
        .reverse()
        .map((b) => {
          const v = JSON.parse(b.data);
          return {
            file: b.file,
            kind: b.kind,
            time: "2026-10-27 15:30:" + b.file.slice(-11, -9),
            tags: v.tags.length,
            names: v.tags.map((t) => t.name).slice(0, 8),
            places: Object.keys(v.assign.dir).length + Object.keys(v.assign.file).length + Object.keys(v.assign.name).length,
            problem: "",
          };
        }),
    ReadTagsBackup: (file) => {
      const b = st.backups.find((x) => x.file === file);
      if (!b) throw new Error("no such backup");
      return b.data;
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
      st.calls.push({ name, args, t: Date.now() });
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.__dismiss = false; // answer the next confirm() with 「취소」
  page.on("dialog", async (d) => {
    page.__dialogs.push(d.type() + ": " + d.message());
    if (page.__dismiss) {
      page.__dismiss = false;
      await d.dismiss();
    } else await d.accept();
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.exposeFunction("__goCall", (name, args) => be.call(name, args));
  await page.addInitScript(INIT);
  await page.goto(url);
  await page.waitForSelector(".statusbar", { timeout: 15000 });
  await sleep(300);
  return { ctx, page };
}

const tab = (id, p) => ({
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
});
const session = (tabs, activeId) => JSON.stringify({ version: 3, tabs, activeId, splitRatio: 0.5, fontSize: 14 });
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const spansWith = (page, color) => page.$$eval(`.cm-content span[style*="color: ${rgb(color)}"]`, (els) => els.map((e) => e.textContent));
const statusTags = (page) => page.$eval(".st-tags", (e) => e.textContent.trim()).catch(() => null);
const savedTags = (be) => (be.st.tags ? JSON.parse(be.st.tags) : null);
const tagNames = (be) => savedTags(be)?.tags.map((t) => t.name);
const listNames = (page) => page.$$eval(".tags-dialog .tag-item .tag-name", (es) => es.map((e) => e.textContent));
const rule = (id, pattern, color, extra = {}) => ({ id, on: true, label: "", pattern, kind: "text", caseSensitive: false, color, line: false, filter: true, ...extra });
const storeJSON = (tags, assign = {}) => JSON.stringify({ version: 1, tags, assign: { dir: {}, file: {}, name: {}, ...assign } }, null, 2);
// 4단계: 상태 표시줄 🏷 는 작은 메뉴를 연다 → 「태그 창 열기」
const openTags = async (page) => {
  await page.dispatchEvent(".st-tags", "mousedown");
  await page.waitForSelector(".tag-menu");
  await page.click(".tag-menu >> text=태그 창 열기");
  await page.waitForSelector(".tags-dialog");
};
const resultLine = (page) => page.$eval(".tags-import-line", (e) => e.textContent).catch(() => null);
const resultDetails = (page) => page.$$eval(".tags-import-details li", (es) => es.map((e) => e.textContent));
const ioMsg = (page) => page.$eval(".tags-io-msg", (e) => e.textContent).catch(() => "");
const calls = (be, name) => be.st.calls.filter((c) => c.name === name);
const shot = async (page, name) => {
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, name) });
};
// where the keyboard focus is: inside the open small window or not
const focusIn = (page, sel) =>
  page.evaluate((s) => {
    const e = document.activeElement;
    return !!(e && e.closest(s));
  }, sel);

// One numbered part of the test: an error inside it is a failure of that part,
// and the parts after it still run.
async function section(title, body) {
  console.log(title);
  try {
    await body();
  } catch (e) {
    ok(title + " — 도중 오류", false, String(e && e.message ? e.message.split("\n")[0] : e));
  }
}

// ---- tag window draft helpers -------------------------------------------------
const dirtyText = (page) => page.$eval(".tags-dirty", (e) => e.textContent).catch(() => null);
const applyOff = (page) => page.$eval(".tags-apply", (e) => e.disabled);
const saves = (be) => calls(be, "SaveTags").length;
const rulePatterns = (page) => page.$$eval(".tags-dialog .rule-row .rule-pattern", (es) => es.map((e) => e.value));
const setColor = (el, hex) =>
  el.evaluate((e, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, v);
    e.dispatchEvent(new Event("input", { bubbles: true }));
  }, hex);
// a new rule at the end of the selected tag: pattern + colour
async function addRule(page, pattern, color) {
  await page.click(".rule-add");
  const rows = await page.$$(".tags-dialog .rule-row");
  const last = rows[rows.length - 1];
  await (await last.$(".rule-pattern")).fill(pattern);
  if (color) await setColor(await last.$("input[type=color]"), color);
  return last;
}
const TAGS_SAVE_WAIT = 900; // past the app's debounced tag save (TAGS_SAVE_MS)
// a tree row by its data-key (BundleTree)
const row = (key) => `.bt-row[data-key="${key}"]`;

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const base = () =>
    storeJSON([
      { name: "common", rules: [rule("e", "ERROR", "#ee0001")], updated: "x" },
      { name: "collector", rules: [rule("k", "kafka rebalance", "#ee0002")], updated: "x" },
    ]);
  const LOG = "2026-10-28 INFO start\nERROR boom\nbanana and kafka rebalance\nWARN later\n";
  try {
    // =============== 1. 닫기 = 취소 ==========================================
    await section("1. 추가 → 닫기 / Esc / × = 버림 (저장 0회)", async () => {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = LOG;
      be.st.tags = base();
      const disk = be.st.tags;
      be.st.session = session([tab("t1", "D:\\logs\\a.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(300);
      const s0 = saves(be);
      await openTags(page);
      ok("열자마자: 적용 꺼짐 · 「적용 안 한 변경」 없음", (await applyOff(page)) && (await dirtyText(page)) === "");
      ok("버튼 셋: 적용 · 확인 · 닫기 (닫기가 끝)", JSON.stringify(await page.$$eval(".tags-actions button", (es) => es.map((e) => e.textContent.trim()))) === '["적용","확인","닫기"]');
      // add a tag and a rule
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "draft-tag");
      await page.press(".tag-rename", "Enter");
      await page.click('.tag-item[data-tag="common"]');
      await addRule(page, "banana", "#ee0009");
      await sleep(TAGS_SAVE_WAIT);
      ok("고치면: 「● 적용 안 한 변경 있음」 · 적용 켜짐", (await dirtyText(page)).includes("적용 안 한 변경 있음") && !(await applyOff(page)), await dirtyText(page));
      ok("창에는 보임 (태그·규칙)", (await listNames(page)).includes("draft-tag") && (await rulePatterns(page)).includes("banana"));
      ok("적용 전: 편집기 색 안 바뀜 (미리보기 없음)", (await spansWith(page, "#ee0009")).length === 0, await spansWith(page, "#ee0009"));
      ok("적용 전: 디바운스 지나도 SaveTags 0회", saves(be) === s0, saves(be) - s0);
      await shot(page, "tags-apply-dirty.png");
      // a click outside the window does not close it
      await page.mouse.click(8, 8);
      await page.mouse.click(1390, 890);
      await sleep(150);
      ok("창 바깥 누르기: 안 닫힘 · 고친 것 그대로", !!(await page.$(".tags-dialog")) && (await rulePatterns(page)).includes("banana"));
      // 닫기 throws it away, without asking
      const dlg0 = page.__dialogs.length;
      await page.click(".tags-dialog .tags-close");
      await sleep(150);
      ok("닫기: 창 닫힘 · 묻지 않음", !(await page.$(".tags-dialog")) && page.__dialogs.length === dlg0, page.__dialogs.slice(dlg0));
      await sleep(TAGS_SAVE_WAIT);
      ok("닫기: SaveTags 0회 · 디스크 그대로", saves(be) === s0 && be.st.tags === disk);
      ok("닫기: 편집기 색 그대로", (await spansWith(page, "#ee0009")).length === 0);
      await openTags(page);
      ok("다시 열면: 추가한 태그·규칙 없음", JSON.stringify(await listNames(page)) === '["common","collector"]' && !(await rulePatterns(page)).includes("banana"), [await listNames(page), await rulePatterns(page)]);
      ok("다시 열면: 적용 꺼짐", await applyOff(page));
      // Esc
      await addRule(page, "esc-rule", "#ee0008");
      await page.keyboard.press("Escape");
      await sleep(150);
      ok("Esc: 창 닫힘", !(await page.$(".tags-dialog")));
      // × (title bar)
      await openTags(page);
      ok("Esc 뒤 다시 열면 없음", !(await rulePatterns(page)).includes("esc-rule"));
      await addRule(page, "x-rule", "#ee0007");
      await page.click(".tags-dialog .tags-x");
      await sleep(150);
      ok("×: 창 닫힘", !(await page.$(".tags-dialog")));
      await openTags(page);
      ok("× 뒤 다시 열면 없음", !(await rulePatterns(page)).includes("x-rule"));
      // add + delete again = no unapplied change
      await page.click(".rule-add");
      await sleep(50);
      const rows = await page.$$(".tags-dialog .rule-row");
      await (await rows[rows.length - 1].$('button[title="이 규칙 지우기"]')).click();
      await sleep(50);
      ok("추가했다 지우면: 적용 안 한 변경 없음 · 적용 꺼짐", (await applyOff(page)) && (await dirtyText(page)) === "");
      // 확인 with nothing changed: closes, no save
      await page.click(".tags-dialog .tags-ok");
      await sleep(TAGS_SAVE_WAIT);
      ok("바뀐 것 없이 확인: 닫힘 · SaveTags 0회", !(await page.$(".tags-dialog")) && saves(be) === s0);
      await ctx.close();
    });

    // =============== 2. 적용 / 확인 ==========================================
    await section("2. 적용 = 저장(창 열린 채) · 확인 = 저장하고 닫기", async () => {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = LOG;
      be.st.tags = base();
      be.st.session = session([tab("t1", "D:\\logs\\a.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(300);
      const s0 = saves(be);
      await openTags(page);
      const last = await addRule(page, "banana", "#ee0009");
      await page.click(".tags-dialog .tags-apply");
      await sleep(250);
      ok("적용: SaveTags 1회", saves(be) === s0 + 1, saves(be) - s0);
      ok("적용: 창은 열린 채", !!(await page.$(".tags-dialog")));
      ok("적용: 저장된 common 에 banana", (savedTags(be).tags[0].rules.map((r) => r.pattern) || []).join() === "ERROR,banana", savedTags(be).tags[0].rules.map((r) => r.pattern));
      ok("적용: 편집기 색 바뀜", JSON.stringify(await spansWith(page, "#ee0009")) === '["banana"]', await spansWith(page, "#ee0009"));
      ok("적용 뒤: 적용 꺼짐 · 「적용 안 한 변경」 없음 · 「적용했습니다」", (await applyOff(page)) && (await dirtyText(page)) === "" && (await page.textContent(".tags-apply-msg")).includes("적용했습니다"));
      await sleep(TAGS_SAVE_WAIT);
      ok("적용 뒤 디바운스 저장이 또 쓰지 않음 (여전히 1회)", saves(be) === s0 + 1, saves(be) - s0);
      // change again, 확인
      await setColor(await last.$("input[type=color]"), "#ee0019");
      ok("다시 고치면 「적용했습니다」 사라지고 적용 켜짐", !(await page.$(".tags-apply-msg")) && !(await applyOff(page)));
      ok("확인 전: 편집기는 앞 색 그대로", JSON.stringify(await spansWith(page, "#ee0009")) === '["banana"]');
      await page.click(".tags-dialog .tags-ok");
      await sleep(250);
      ok("확인: 창 닫힘 · SaveTags +1", !(await page.$(".tags-dialog")) && saves(be) === s0 + 2, saves(be) - s0);
      ok("확인: 새 색이 저장 · 편집기에", savedTags(be).tags[0].rules[1].color === "#ee0019" && JSON.stringify(await spansWith(page, "#ee0019")) === '["banana"]');
      // a tag, a rename and a delete in one 적용
      await openTags(page);
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "admin");
      await page.press(".tag-rename", "Enter");
      await addRule(page, "later", "#ee0005");
      await page.click('.tag-item[data-tag="collector"]');
      await page.dblclick('.tag-item[data-tag="collector"]');
      await page.fill(".tag-rename", "coll");
      await page.press(".tag-rename", "Enter");
      await page.click('.tag-item[data-tag="common"]');
      await page.click(".tags-dialog .tags-apply");
      await sleep(250);
      ok("여러 변경 한 번에 적용 (SaveTags +1)", saves(be) === s0 + 3 && JSON.stringify(tagNames(be)) === '["common","coll","admin"]', tagNames(be));
      ok("새 태그 규칙도 저장", savedTags(be).tags[2].rules.map((r) => r.pattern).join() === "later");
      // a regex the rules can't use: saved as before (shown, not coloured)
      const bad = await addRule(page, "(?<=x)y", "#ee0006");
      await (await bad.$(".rule-kind")).selectOption("regex");
      ok("쓸 수 없는 정규식: 「적용 안 한 변경」 옆에 알림", (await dirtyText(page)).includes("쓸 수 없는 규칙 1개"), await dirtyText(page));
      await page.click(".tags-dialog .tags-apply");
      await sleep(250);
      const savedBad = savedTags(be).tags[0].rules.find((r) => r.pattern === "(?<=x)y");
      ok("쓸 수 없는 정규식도 지금처럼 저장(쓰이지 않음 표시)", !!savedBad && savedBad.kind === "regex" && saves(be) === s0 + 4);
      ok("그 규칙 줄에 「쓸 수 없음」", (await page.$$eval(".rule-problem", (es) => es.map((e) => e.textContent))).some((t) => t.includes("쓸 수 없음")));
      await ctx.close();
    });

    // =============== 3. a save outside the window while it is open ==========
    await section("3. 창 열린 채 밖에서 태그 지정 → 적용해도 그 지정이 살아 있음", async () => {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
      be.st.files[P("s1", "modules/lizcollector/collector.log")] = "kafka rebalance begin\nconsumer lag\n";
      be.st.scan = {
        root: R,
        servers: [{ name: "s1", files: [{ rel: "modules/lizcollector/collector.log", size: 40, compressed: false }], truncated: false, unreadable: 0 }],
      };
      be.st.tags = base();
      const multi = {
        on: true,
        count: 1,
        slots: [{ tabId: "a", mode: "read", server: "s1" }, ...Array.from({ length: 5 }, () => ({ tabId: "", mode: "read", server: "" }))],
        bundle: { root: R, servers: ["s1"] },
      };
      be.st.session = JSON.stringify({
        version: 3,
        tabs: [{ ...tab("a", P("s1", "modules/lizcollector/collector.log")), label: "s1 · collector.log" }],
        activeId: "a",
        splitRatio: 0.5,
        fontSize: 14,
        multi,
      });
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(500);
      ok("처음: collector 색 없음 (붙인 곳 없음)", (await spansWith(page, "#ee0002")).length === 0);
      await openTags(page);
      await page.click('.tag-item[data-tag="collector"]');
      await addRule(page, "consumer", "#ee000a");
      const s0 = saves(be);
      // the tree under the window: 「태그 지정…」 → collector (events sent to the
      // elements: the tag window covers the tree)
      if (!(await page.$(row("d:s1/modules/lizcollector")))) await page.dispatchEvent(row("d:s1/modules"), "click");
      await sleep(100);
      await page.dispatchEvent(row("d:s1/modules/lizcollector"), "contextmenu");
      await page.waitForSelector(".bt-menu");
      await page.dispatchEvent(".bt-menu >> text=태그 지정…", "click");
      await page.waitForSelector(".tag-assign");
      await page.$eval('.ta-tag[data-tag="collector"] input[type=checkbox]', (e) => e.click());
      await page.$eval(".tag-assign .ta-ok", (e) => e.click());
      await sleep(300);
      ok("밖의 지정은 바로 저장", saves(be) === s0 + 1 && JSON.stringify(savedTags(be).assign.dir) === '{"modules/lizcollector":["collector"]}', savedTags(be) && savedTags(be).assign);
      ok("밖의 지정 저장에 창의 초안은 안 들어감", !savedTags(be).tags[1].rules.some((r) => r.pattern === "consumer"));
      ok("창의 「어디에 붙어 있나」에 새 지정 보임", (await page.$$eval(".tags-place", (es) => es.map((e) => e.textContent))).some((t) => t.includes("modules/lizcollector")));
      ok("창의 초안은 그대로 (적용 안 한 변경)", (await rulePatterns(page)).includes("consumer") && (await dirtyText(page)).includes("적용 안 한 변경"));
      ok("겹치지 않는 변경이라 알림 없음", !(await page.$(".tags-draft-notes")));
      ok("지정 색은 바로 · 초안 색은 아직", (await spansWith(page, "#ee0002")).includes("kafka rebalance") && (await spansWith(page, "#ee000a")).length === 0);
      await page.click(".tags-dialog .tags-apply");
      await sleep(300);
      const sv = savedTags(be);
      ok("적용: 지정이 살아 있음", JSON.stringify(sv.assign.dir) === '{"modules/lizcollector":["collector"]}', sv.assign);
      ok("적용: 초안 규칙도 저장", sv.tags[1].rules.map((r) => r.pattern).join() === "kafka rebalance,consumer");
      ok("적용: 초안 색이 칸에", JSON.stringify(await spansWith(page, "#ee000a")) === '["consumer"]', await spansWith(page, "#ee000a"));
      // the window deleted collector (not applied) while it got put somewhere else outside
      await page.click('.tag-item[data-tag="collector"]');
      await page.click(".tags-side-actions >> text=삭제");
      await sleep(100);
      ok("창에서 collector 삭제(적용 전)", !(await listNames(page)).includes("collector"));
      if (!(await page.$(row("f:s1/modules/lizcollector/collector.log")))) await page.dispatchEvent(row("d:s1/modules/lizcollector"), "click");
      await sleep(100);
      await page.dispatchEvent(row("f:s1/modules/lizcollector/collector.log"), "contextmenu");
      await page.waitForSelector(".bt-menu");
      await page.dispatchEvent(".bt-menu >> text=태그 지정…", "click");
      await page.waitForSelector(".tag-assign");
      // a new tag made in the assign window, put on the file
      await page.$eval(".tag-assign .ta-new input", (e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "admin");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.$eval(".tag-assign .ta-new button", (e) => e.click());
      await page.$eval(".tag-assign .ta-ok", (e) => e.click());
      await sleep(300);
      ok("밖에서 새 태그 admin + 파일 지정 저장", tagNames(be).includes("admin") && JSON.stringify(savedTags(be).assign.file) === '{"modules/lizcollector/collector.log":["admin"]}', [tagNames(be), savedTags(be).assign]);
      ok("창 목록에 admin 생김 · collector 는 (초안대로) 없음", JSON.stringify(await listNames(page)) === '["common","admin"]', await listNames(page));
      await page.click(".tags-dialog .tags-ok");
      await sleep(300);
      const sv2 = savedTags(be);
      ok("확인: collector 지움 + admin 지정 살아 있음", JSON.stringify(sv2.tags.map((t) => t.name)) === '["common","admin"]' && JSON.stringify(sv2.assign) === '{"dir":{},"file":{"modules/lizcollector/collector.log":["admin"]},"name":{}}', sv2);
      await ctx.close();
    });

    // =============== 4. same name made in the window and outside ============
    await section("4. 창에서 만든 태그 이름이 밖에서도 생김 → 다른 이름으로 얹고 알림", async () => {
      const be = makeBackend();
      const R = "C:\\b\\bromo";
      const P = (sv, rel) => [R, sv, ...rel.split("/")].join("\\");
      be.st.files[P("s1", "app/x.log")] = "hello\n";
      be.st.scan = { root: R, servers: [{ name: "s1", files: [{ rel: "app/x.log", size: 6, compressed: false }], truncated: false, unreadable: 0 }] };
      be.st.tags = base();
      be.st.session = JSON.stringify({
        version: 3,
        tabs: [tab("a", P("s1", "app/x.log"))],
        activeId: "a",
        splitRatio: 0.5,
        fontSize: 14,
        multi: { on: true, count: 1, slots: [{ tabId: "a", mode: "read", server: "s1" }, ...Array.from({ length: 5 }, () => ({ tabId: "", mode: "read", server: "" }))], bundle: { root: R, servers: ["s1"] } },
      });
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(500);
      await openTags(page);
      await page.click("text=＋ 새 태그");
      await page.fill(".tag-rename", "app");
      await page.press(".tag-rename", "Enter");
      await addRule(page, "hello", "#ee000b");
      await page.dispatchEvent(row("d:s1/app"), "contextmenu");
      await page.waitForSelector(".bt-menu");
      await page.dispatchEvent(".bt-menu >> text=태그 지정…", "click");
      await page.waitForSelector(".tag-assign");
      await page.$eval(".tag-assign .ta-new input", (e) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(e, "app");
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.$eval(".tag-assign .ta-new button", (e) => e.click());
      await page.$eval(".tag-assign .ta-ok", (e) => e.click());
      await sleep(300);
      ok("창 목록: 밖의 app + 창의 「app (2)」", JSON.stringify(await listNames(page)) === '["common","collector","app","app (2)"]', await listNames(page));
      const note = await page.$eval(".tags-draft-notes", (e) => e.textContent).catch(() => "");
      ok("창 위 알림: 「app (2)」 로 바꿨다", note.includes("「app (2)」"), note);
      await shot(page, "tags-apply-rebased.png");
      ok("창의 규칙은 app (2) 에", await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent).then((n) => n === "app (2)") && (await rulePatterns(page)).join() === "hello");
      await page.click(".tags-dialog .tags-apply");
      await sleep(300);
      const sv = savedTags(be);
      ok("적용: 둘 다 저장 · 밖의 지정은 밖의 app 에", JSON.stringify(sv.tags.map((t) => t.name)) === '["common","collector","app","app (2)"]' && JSON.stringify(sv.assign.dir) === '{"app":["app"]}' && sv.tags[3].rules[0].pattern === "hello", sv);
      ok("적용하면 알림 사라짐", !(await page.$(".tags-draft-notes")));
      await ctx.close();
    });

    // =============== 5. import while the window holds a draft ===============
    await section("5. 초안이 있는 채 가져오기 → 가져온 것은 바로 저장 · 초안은 그 위에", async () => {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = LOG;
      be.st.tags = base();
      be.st.session = session([tab("t1", "D:\\logs\\a.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(300);
      await openTags(page);
      await addRule(page, "banana", "#ee0009"); // common, not applied
      await page.click('.tag-item[data-tag="collector"]');
      const k = (await page.$$(".tags-dialog .rule-row"))[0];
      await setColor(await k.$("input[type=color]"), "#ee0012"); // collector's rule, not applied
      const s0 = saves(be);
      be.st.importQueue.push([
        {
          name: "team.chipper-tags.json",
          text: JSON.stringify({
            format: "chipper-tags",
            version: 1,
            tags: [
              { name: "imp", rules: [{ id: "i1", pattern: "WARN", color: "#ee0013" }] },
              { name: "collector", rules: [{ id: "t1", pattern: "theirs", color: "#ee0014" }] },
            ],
          }),
        },
      ]);
      const dlg0 = page.__dialogs.length;
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      const asked = page.__dialogs.slice(dlg0);
      ok("가져오기 전에 「적용 안 한 변경」 안내를 묻는다", asked.length === 1 && asked[0].includes("적용 안 한 변경이 있습니다") && asked[0].includes("[적용]해야 저장"), asked);
      await page.click(".tags-c-overwrite"); // collector: theirs
      await page.waitForSelector(".tags-import-result");
      await sleep(200);
      const sv = savedTags(be);
      ok("가져오기는 곧바로 저장 1회", saves(be) === s0 + 1, saves(be) - s0);
      ok("저장본 = 가져온 것만 (초안 banana 없음)", JSON.stringify(sv.tags.map((t) => t.name)) === '["common","collector","imp"]' && !sv.tags[0].rules.some((r) => r.pattern === "banana") && sv.tags[1].rules.map((r) => r.pattern).join() === "theirs", sv.tags.map((t) => [t.name, t.rules.map((r) => r.pattern)]));
      ok("백업은 초안 없이 저장돼 있던 것", be.st.backups.length === 1 && !be.st.backups[0].data.includes("banana"));
      ok("창: 초안은 그 위에 (적용 안 한 변경 있음)", (await dirtyText(page)).includes("적용 안 한 변경"));
      const note = await page.$eval(".tags-draft-notes", (e) => e.textContent).catch(() => "");
      ok("덮어쓴 collector 의 옛 규칙에 한 색 변경은 못 얹음 → 알림", note.includes("「collector」") && note.includes("얹지 못했습니다"), note);
      await page.click('.tag-item[data-tag="common"]');
      ok("창의 common 에 banana 남음", (await rulePatterns(page)).join() === "ERROR,banana", await rulePatterns(page));
      ok("가져오기 되돌리기 버튼: 초안만 있으면 켜진 채", !(await page.$eval(".tags-undo", (e) => e.disabled)));
      await page.click(".tags-dialog .tags-apply");
      await sleep(300);
      const sv2 = savedTags(be);
      ok("적용: 가져온 것 + 초안", JSON.stringify(sv2.tags.map((t) => [t.name, t.rules.map((r) => r.pattern).join()])) === '[["common","ERROR,banana"],["collector","theirs"],["imp","WARN"]]', sv2.tags.map((t) => [t.name, t.rules.map((r) => r.pattern)]));
      ok("적용 뒤에는 가져오기 되돌리기 꺼짐 (가져온 뒤 고침)", await page.$eval(".tags-undo", (e) => e.disabled));
      // dismissing the question = no import
      await addRule(page, "cherry", "#ee0015");
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "n", rules: [] }] }) }]);
      page.__dismiss = true;
      const n0 = be.st.calls.length;
      await page.click(".tags-import");
      await sleep(250);
      ok("안내에 취소 → 파일 고르기도 안 함 · 초안 그대로", be.st.calls.slice(n0).every((c) => c.name !== "ImportTagsDialog" && c.name !== "SaveTags") && (await rulePatterns(page)).includes("cherry"));
      // export takes what the window shows
      await page.click(".tags-export");
      await page.waitForSelector(".tags-export-panel");
      ok("초안이 있으면 내보내기 창에 안내", (await page.$eval(".tags-export-panel", (e) => e.textContent)).includes("적용 안 한 변경 포함"));
      await page.click(".tags-export-go");
      await sleep(200);
      const ex = be.st.exports[be.st.exports.length - 1];
      ok("내보내기 = 창에 보이는 그대로 (초안 cherry 포함) · tags.json 그대로", !!ex && ex.data.includes("cherry") && !be.st.tags.includes("cherry"));
      await ctx.close();
    });

    // =============== 6. a failed write ======================================
    await section("6. 적용 저장 실패 → 창 열린 채 이유 · 이번 실행엔 쓰임", async () => {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = LOG;
      be.st.tags = base();
      be.st.session = session([tab("t1", "D:\\logs\\a.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await sleep(300);
      await openTags(page);
      await addRule(page, "banana", "#ee0009");
      be.st.failSave = "[TAGS_BACKUP_FAILED] 직전 태그 파일(.bak)을 남기지 못해 저장하지 않았습니다";
      await page.click(".tags-dialog .tags-ok");
      await sleep(300);
      const m = await page.$eval(".tags-apply-msg", (e) => e.textContent).catch(() => "");
      ok("확인 실패: 창 열린 채 · 이유 (오류 코드 글자 없이)", !!(await page.$(".tags-dialog")) && m.includes("저장하지 못했습니다") && m.includes(".bak") && !m.includes("[TAGS_"), m);
      ok("이번 실행엔 쓰임 (편집기 색)", JSON.stringify(await spansWith(page, "#ee0009")) === '["banana"]');
      ok("적용 안 한 변경은 없음 (닫아도 잃지 않음)", (await applyOff(page)) && (await dirtyText(page)) === "");
      be.st.failSave = null;
      await page.click(".tags-dialog .tags-close");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await sleep(400);
      ok("다음 저장 기회(창 밖 flush)에 다시 써짐", (savedTags(be).tags[0].rules.map((r) => r.pattern) || []).includes("banana"));
      await ctx.close();
    });

  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\ntags-apply-e2e: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
