// Headless test of tag export / import (stage 5 + stage 5 fix) against the
// built frontend. The Go side is faked in Node (state survives reloads); the OS
// file dialogs are replaced by ExportTagsDialog / ImportTagsDialog fakes. The
// fake import parser mirrors tags_io.go's envelope checks closely enough for
// these scenarios (the real one is covered by tags_io_test.go /
// tags_io_fix_test.go).
//
//   cd frontend && npm run build && node tests/tags-io-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder>  → screenshots of the export panel, a clash question, the result, the backups
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

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  let exported1 = null; // the multi-tag export from home A, imported into home B
  try {
    // =============== 1. export ===============================================
    await section("1. 내보내기", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = "kafka rebalance\nERROR x\n";
      be.st.tags = storeJSON(
        [
          { name: "common", rules: [rule("e", "ERROR", "#ee0001", { line: true })], updated: "" },
          { name: "collector", rules: [rule("k", "kafka rebalance", "#ee0002", { label: "카프카" })], updated: "" },
          { name: "Collector", rules: [rule("K", "UPPER", "#ee0003")], updated: "" },
          { name: "admin", rules: [rule("a", "login", "#ee0004", { kind: "word" })], updated: "" },
        ],
        { dir: { "modules/lizcollector": ["collector"], "modules/both": ["collector", "admin"] } }
      );
      be.st.session = session([tab("t1", "D:\\logs\\a.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      await page.click('.tag-item[data-tag="collector"]');
      await page.click(".tags-export");
      await page.waitForSelector(".tags-export-panel");
      const checked = await page.$$eval(".tags-export-item input:checked", (es) => es.map((e) => e.getAttribute("data-tag")));
      ok("내보내기 창: 고른 태그(collector)가 체크된 채", JSON.stringify(checked) === '["collector"]', checked);
      ok("파일 이름 = 태그 이름", (await page.$eval(".tags-export-file", (e) => e.value)) === "collector");
      ok("미리보기 collector.chipper-tags.json", (await page.$eval(".tags-export-preview", (e) => e.textContent)) === "collector.chipper-tags.json");
      ok("「붙인 곳도 같이」 기본 꺼짐 · 2곳", !(await page.$eval(".tags-export-assign-box", (e) => e.checked)) && (await page.$eval(".tags-export-assign", (e) => e.textContent)).includes("2곳"));
      ok("내보내기 창이 열리면 포커스는 그 안 (파일 이름 칸)", await focusIn(page, ".tags-export-panel"));
      await page.click(".tags-export-go");
      await sleep(200);
      const ex = be.st.exports[0];
      ok("대화상자에 기본 이름 전달", ex && ex.defaultName === "collector.chipper-tags.json", ex && ex.defaultName);
      const v = ex ? JSON.parse(ex.data) : {};
      ok("형식: format·version·exported", v.format === "chipper-tags" && v.version === 1 && typeof v.exported === "string" && !isNaN(Date.parse(v.exported)));
      ok("collector 하나만", JSON.stringify((v.tags || []).map((t) => t.name)) === '["collector"]');
      ok("규칙에 id 있음(기본 규칙 id 보존) · label 있음", v.tags && v.tags[0].rules[0].id === "k" && v.tags[0].rules[0].label === "카프카");
      ok("체크 안 하면 지정 정보(assign) 없음 · updated 없음", !("assign" in v) && v.tags && !("updated" in v.tags[0]));
      const msg = await ioMsg(page);
      ok("내보낸 경로 안내", msg.includes("C:\\out\\collector.chipper-tags.json") && msg.includes("1개"), msg);
      ok("내보낸 뒤 창 닫힘", !(await page.$(".tags-export-panel")));

      // with places: only the exported tag's
      await page.click(".tags-export");
      await page.check(".tags-export-assign-box");
      await page.click(".tags-export-go");
      await sleep(200);
      const va = JSON.parse(be.st.exports[be.st.exports.length - 1].data);
      ok(
        "「붙인 곳도 같이」: 그 태그의 곳만, 다른 태그 이름은 뺌",
        JSON.stringify(va.assign) === JSON.stringify({ dir: { "modules/lizcollector": ["collector"], "modules/both": ["collector"] }, file: {}, name: {} }),
        va.assign
      );
      ok("안내에 붙인 곳 수", (await ioMsg(page)).includes("붙인 곳 2곳"), await ioMsg(page));

      // the name was completed and that file exists: asked; 「취소」 → nothing written
      be.st.exportConfirm = true;
      await page.click(".tags-export");
      page.__dismiss = true;
      const w0 = Object.keys(be.st.written).length;
      await page.click(".tags-export-go");
      await sleep(250);
      ok("이미 있는 파일 → 덮어쓸지 물음", page.__dialogs.some((d) => d.includes("이미 있습니다. 덮어쓸까요?")), page.__dialogs);
      ok("「취소」 → 쓰지 않음 · 안내", calls(be, "ExportTagsTo").length === 0 && Object.keys(be.st.written).length === w0 && (await ioMsg(page)).includes("그만뒀습니다"));
      // 「확인」 → ExportTagsTo
      await page.click(".tags-export-go");
      await sleep(250);
      ok("「확인」 → 덮어씀(ExportTagsTo)", calls(be, "ExportTagsTo").length === 1 && (await ioMsg(page)).includes("내보냈습니다"));
      be.st.exportConfirm = false;

      // several tags: needs a name
      await page.click(".tags-export");
      for (const t of ["common", "Collector", "admin"]) await page.check(`.tags-export-item input[data-tag="${t}"]`);
      ok("여러 개면 이름이 비고 내보내기 막힘", (await page.$eval(".tags-export-file", (e) => e.value)) === "" && (await page.$eval(".tags-export-go", (e) => e.disabled)));
      await page.fill(".tags-export-file", "팀 공용");
      ok("이름 넣으면 풀림", !(await page.$eval(".tags-export-go", (e) => e.disabled)));
      await shot(page, "stage5-export.png");
      // canceled save dialog: nothing happens, panel stays
      be.st.exportCancel = true;
      const msgBefore = await ioMsg(page);
      await page.click(".tags-export-go");
      await sleep(200);
      ok("저장 대화상자 취소 → 창 그대로 · 새 안내 없음", !!(await page.$(".tags-export-panel")) && (await ioMsg(page)) === msgBefore);
      be.st.exportCancel = false;
      await page.click(".tags-export-go");
      await sleep(200);
      const ex2 = be.st.exports[be.st.exports.length - 1];
      exported1 = ex2.data;
      ok("여러 개: 기본 이름 「팀 공용.chipper-tags.json」", ex2.defaultName === "팀 공용.chipper-tags.json", ex2.defaultName);
      ok("여러 개: 태그 4개, 목록 순서, common 포함", JSON.stringify(JSON.parse(ex2.data).tags.map((t) => t.name)) === '["common","collector","Collector","admin"]');
      // Esc closes only the export panel, and the focus goes back to the button
      await page.focus(".tags-export");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".tags-export-panel");
      await page.keyboard.press("Escape");
      await sleep(100);
      ok("Esc: 내보내기 창만 닫힘", !(await page.$(".tags-export-panel")) && !!(await page.$(".tags-dialog")));
      ok("Esc: 포커스가 「내보내기…」 버튼으로 돌아옴", await page.evaluate(() => document.activeElement?.classList.contains("tags-export")));
      // none checked → blocked
      await page.click(".tags-export");
      await page.uncheck('.tags-export-item input[data-tag="collector"]');
      ok("하나도 안 고르면 막힘", await page.$eval(".tags-export-go", (e) => e.disabled));
      // Tab stays in the export panel
      const outside = [];
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        if (!(await focusIn(page, ".tags-export-panel"))) outside.push(i);
      }
      ok("내보내기 창: Tab 이 창 밖으로 안 나감", outside.length === 0, outside);
      await ctx.close();
    }
    });

    // =============== 2. import into another home: clash questions ===========
    await section("2. 다른 홈에서 가져오기 — 없음/같음/다름(덮어쓰기·다른 이름·건너뛰기)·대소문자·차이 표시", async () => {
    const beB = makeBackend();
    {
      beB.st.files["D:\\logs\\app.log"] = "kafka rebalance\nERROR boom\nUPPER case\nWARN w\n";
      const before = storeJSON(
        [
          { name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "x" },
          { name: "collector", rules: [rule("m", "mine only", "#bb0002")], updated: "x" },
          // same rule as exported admin but another label → asked now (label counts)
          { name: "admin", rules: [rule("zz", "login", "#ee0004", { kind: "word", label: "다른 이름표" })], updated: "x" },
        ],
        { name: { "app.log": ["Collector"] } } // Collector doesn't exist here yet
      );
      beB.st.tags = before;
      beB.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, beB);
      ok("가져오기 전: 상태 표시줄 common 만 (Collector 없음)", (await statusTags(page)) === "🏷 common", await statusTags(page));
      ok("가져오기 전: WARN 색", (await spansWith(page, "#bb0001")).includes("WARN"));
      await openTags(page);
      beB.st.importQueue.push([{ name: "팀 공용.chipper-tags.json", text: exported1 }]);
      const saves0 = calls(beB, "SaveTags").length;
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      const q1 = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      ok("첫 질문 = common 덮어쓰기", q1 === "「common」 태그가 이미 있습니다. 덮어쓰시겠습니까?", q1);
      const sub1 = await page.$eval(".tags-conflict-text", (e) => e.textContent);
      ok("common 질문에 「모든 로그」 경고", sub1.includes("모든 로그의 색이 바뀝니다"));
      ok("질문 문구: .bak 대신 tags-backup 약속", sub1.includes("tags-backup") && !sub1.includes(".bak"), sub1);
      const diff1 = await page.$eval(".tags-conflict-diff", (e) => e.textContent);
      ok("규칙 차이: 추가 1 · 빠짐 1 · 바뀜 0, 무엇인지", diff1.includes("규칙 차이: 추가 1 · 빠짐 1 · 바뀜 0") && diff1.includes("+ 「ERROR」") && diff1.includes("− 「WARN」"), diff1);
      ok("「나머지 2개도 모두 같게」 (collector·admin 남음)", ((await page.$eval(".tags-conflict-all", (e) => e.textContent).catch(() => "")) || "").includes("나머지 2개"));
      ok("다른 이름 버튼에 새 이름", (await page.$eval(".tags-c-rename", (e) => e.textContent)).includes("common (2)"));
      ok("질문 창 aria-modal", (await page.$eval(".tags-conflict", (e) => e.getAttribute("aria-modal"))) === "true");
      await shot(page, "stage5-conflict.png");
      await page.click(".tags-c-overwrite");
      await page.waitForSelector(".tags-conflict");
      const q2 = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      ok("둘째 질문 = collector", q2 === "「collector」 태그가 이미 있습니다. 덮어쓰시겠습니까?", q2);
      await page.click(".tags-c-rename");
      await page.waitForSelector(".tags-conflict");
      const q3 = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      ok("셋째 질문 = admin (이름표만 다름)", q3 === "「admin」 태그가 이미 있습니다. 덮어쓰시겠습니까?", q3);
      const diff3 = await page.$eval(".tags-conflict-diff", (e) => e.textContent);
      ok("admin 차이 = 이름표 바뀜", diff3.includes("바뀜 1") && diff3.includes("이름표 「다른 이름표」 → 「」"), diff3);
      ok("마지막 질문엔 「모두 같게」 없음", !(await page.$(".tags-conflict-all")));
      await page.click(".tags-c-skip");
      await page.waitForSelector(".tags-import-result");
      await sleep(100);
      ok("질문은 세 번 (Collector 새것은 안 물음)", !(await page.$(".tags-conflict")));
      ok("요약 줄", (await resultLine(page)) === "추가 1 · 덮어씀 1 · 건너뜀 1 · 이름 바꿔 추가 1 · 잘못된 규칙 0", await resultLine(page));
      const det = await resultDetails(page);
      ok(
        "요약 자세히",
        det.includes("추가: 「Collector」") &&
          det.includes("덮어씀: 「common」") &&
          det.includes("건너뜀(고르신 대로): 「admin」") &&
          det.includes("이름 바꿔 추가: 「collector」 → 「collector (2)」"),
        det
      );
      const bk = calls(beB, "BackupTagsBefore");
      ok("가져오기 직전 태그를 tags-backup 에 한 번 남김 (그 직전 내용)", bk.length === 1 && bk[0].args[0] === "import" && JSON.parse(bk[0].args[1]).tags[0].rules[0].pattern === "WARN");
      ok("결과 띠: 백업 파일 이름 그대로", det.some((d) => d.includes("tags-backup 폴더의 " + beB.st.backups[0].file)), det);
      await shot(page, "stage5-result.png");
      const names = await listNames(page);
      ok("목록에 collector·Collector·collector (2) 모두", JSON.stringify(names) === JSON.stringify(["common", "collector", "admin", "collector (2)", "Collector"]), names);
      ok("가져온 첫 태그(Collector)가 선택됨", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "Collector");
      await sleep(100);
      ok("가져오기는 저장 한 번 (곧바로)", calls(beB, "SaveTags").length === saves0 + 1);
      ok("tags.json.bak = 가져오기 직전 내용", beB.st.bak === before);
      const sv = savedTags(beB);
      ok("저장: common 덮어씀 · 기본 id 그대로(e)", JSON.stringify(sv.tags[0].rules.map((r) => r.pattern)) === '["ERROR"]' && sv.tags[0].rules[0].id === "e");
      ok("저장: 내 collector 그대로 · (2) 는 가져온 것", sv.tags[1].rules[0].pattern === "mine only" && sv.tags[3].name === "collector (2)" && sv.tags[3].rules[0].pattern === "kafka rebalance");
      ok("저장: admin 은 내 것 그대로 (id·이름표)", sv.tags[2].rules[0].id === "zz" && sv.tags[2].rules[0].label === "다른 이름표");
      ok("저장: 지정 정보 그대로", JSON.stringify(sv.assign.name) === '{"app.log":["Collector"]}');
      // colouring follows at once
      await page.click(".tags-dialog .chips-actions >> text=닫기");
      await sleep(200);
      ok("가져온 뒤 상태 표시줄 common + Collector", (await statusTags(page)) === "🏷 common + Collector", await statusTags(page));
      ok("가져온 Collector 색 칠함", (await spansWith(page, "#ee0003")).includes("UPPER"));
      ok("덮어쓴 common 색 (ERROR) · 옛 WARN 색 사라짐", (await spansWith(page, "#ee0001")).includes("ERROR") && (await spansWith(page, "#bb0001")).length === 0);
      await ctx.close();

      // restart: still there
      const r = await openPage(browser, url, beB);
      ok("다시 켜도 유지: 상태 표시줄", (await statusTags(r.page)) === "🏷 common + Collector", await statusTags(r.page));
      ok("다시 켜도 유지: 색", (await spansWith(r.page, "#ee0003")).includes("UPPER"));
      await openTags(r.page);
      ok("다시 켜도 유지: 목록", (await listNames(r.page)).join() === "common,collector,admin,collector (2),Collector");
      await r.ctx.close();
    }
    });

    // =============== 3. undo ==================================================
    await section("3. 되돌리기", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "UPPER\nWARN\n";
      const before = storeJSON([{ name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "x" }], { name: { "app.log": ["Collector"] } });
      be.st.tags = before;
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.importQueue.push([{ name: "팀 공용.chipper-tags.json", text: exported1 }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      await page.click(".tags-c-overwrite"); // common
      await page.waitForSelector(".tags-import-result");
      await sleep(150);
      ok("가져옴: 4개 태그", (await listNames(page)).length === 4);
      ok("되돌리기 버튼 켜짐", !(await page.$eval(".tags-undo", (e) => e.disabled)));
      await page.click(".tags-undo");
      await sleep(200);
      ok("되돌리면 목록 원래대로", (await listNames(page)).join() === "common");
      ok("되돌림 안내", (await ioMsg(page)).includes("되돌렸습니다"));
      ok("되돌린 것이 저장됨 (common 만, WARN)", JSON.stringify(tagNames(be)) === '["common"]' && savedTags(be).tags[0].rules[0].pattern === "WARN");
      await page.click(".tags-dialog .chips-actions >> text=닫기");
      await sleep(200);
      ok("되돌린 뒤 색도 원래대로", (await spansWith(page, "#ee0003")).length === 0 && (await spansWith(page, "#bb0001")).includes("WARN"));
      // after an edit, undo is no longer offered
      await openTags(page);
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "new1", rules: [{ pattern: "a" }] }] }) }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-import-result");
      await page.click(".rule-add"); // edit something
      await sleep(100);
      ok("가져온 뒤 고치면 되돌리기 꺼짐", await page.$eval(".tags-undo", (e) => e.disabled));
      await ctx.close();
    }
    });

    // =============== 4. 「나머지도 모두 같게」 · Esc · several files · bad rules ===
    await section("4. 모두 같게 · Esc 그만두기 · 여러 파일 · 잘못된 규칙", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([
        { name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "x" },
        { name: "a", rules: [rule("1", "a", "#bb0002")], updated: "x" },
        { name: "b", rules: [rule("2", "b", "#bb0003")], updated: "x" },
      ]);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      const clash = JSON.stringify({
        format: "chipper-tags",
        version: 1,
        tags: [
          { name: "common", rules: [] },
          { name: "a", rules: [{ pattern: "A" }] },
          { name: "b", rules: [{ pattern: "B" }] },
        ],
      });
      // Esc → nothing changes
      const tagsBefore = be.st.tags;
      be.st.importQueue.push([{ name: "c.chipper-tags.json", text: clash }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      await page.click(".tags-c-overwrite"); // answer the first …
      await page.waitForSelector(".tags-conflict");
      await page.keyboard.press("Escape"); // … then stop
      await sleep(200);
      ok("Esc: 질문 닫힘 · 태그 창은 그대로", !(await page.$(".tags-conflict")) && !!(await page.$(".tags-dialog")));
      ok("Esc: 그만뒀다는 안내", (await ioMsg(page)).includes("그만뒀습니다"));
      await sleep(600);
      ok("Esc: 앞서 고른 덮어쓰기도 반영 안 됨 · 백업도 안 만듦", be.st.tags === tagsBefore && (await listNames(page)).join() === "common,a,b" && be.st.backups.length === 0);
      // all the same: one question
      be.st.importQueue.push([{ name: "c.chipper-tags.json", text: clash }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      ok("「나머지 2개도 모두 같게」", (await page.$eval(".tags-conflict-all", (e) => e.textContent)).includes("나머지 2개"));
      await page.check(".tags-conflict-all input");
      await page.click(".tags-c-skip");
      await page.waitForSelector(".tags-import-result");
      ok("모두 같게(건너뛰기): 질문 한 번", !(await page.$(".tags-conflict")));
      ok("모두 같게: 요약 건너뜀 3", (await resultLine(page)) === "추가 0 · 덮어씀 0 · 건너뜀 3 · 이름 바꿔 추가 0 · 잘못된 규칙 0", await resultLine(page));
      ok("바뀐 것 없으면 되돌리기 버튼·백업 없음", !(await page.$(".tags-undo")) && be.st.backups.length === 0);
      // all overwrite, including emptied common
      be.st.importQueue.push([{ name: "c.chipper-tags.json", text: clash }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      await page.check(".tags-conflict-all input");
      await page.click(".tags-c-overwrite");
      await page.waitForSelector(".tags-import-result");
      await sleep(150);
      ok("모두 덮어쓰기: 덮어씀 3", (await resultLine(page)).startsWith("추가 0 · 덮어씀 3"), await resultLine(page));
      ok("비운 common 도 덮어씀 (common 비우는 사람)", savedTags(be).tags[0].rules.length === 0);

      // several files at once + bad rules + a file that is not a tag file
      const f1 = JSON.stringify({
        format: "chipper-tags",
        version: 1,
        tags: [
          { name: "kafka", rules: [{ pattern: "rebalance", color: "#0a0" }, { pattern: "(?<=x)a", kind: "regex" }, { pattern: "x", color: "red" }] },
          { name: "dead", rules: [{ pattern: "(", kind: "regex" }] },
          { name: " space", rules: [] },
        ],
      });
      const f2 = JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "zoo", rules: [{ pattern: "z", kind: "word", unknownField: 1 }] }], futureField: true });
      be.st.importQueue.push([
        { name: "one.chipper-tags.json", text: f1 },
        { name: "two.chipper-tags.json", text: f2 },
        { name: "notes.txt", text: "그냥 메모" },
        { name: "newer.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 9, tags: [] }) },
      ]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-import-result");
      await sleep(150);
      ok(
        "여러 파일: 요약",
        (await resultLine(page)) === "추가 2 · 덮어씀 0 · 건너뜀 0 · 이름 바꿔 추가 0 · 잘못된 규칙 3 · 가져오지 못함 4",
        await resultLine(page)
      );
      const d = await resultDetails(page);
      ok("잘못된 규칙 이유: RE2 로 못 쓰는 정규식(뒤돌아보기) — 태그 창과 같은 문구", d.some((x) => x.includes("one.chipper-tags.json · kafka · 2번째 규칙") && x.includes("뒤돌아보기 (?<= / (?<! 는 Go(RE2) 정규식에서 지원하지 않습니다")), d);
      ok("잘못된 규칙 이유: 잘못된 색", d.some((x) => x.includes("잘못된 색 「red」")), d);
      ok("규칙이 모두 잘못된 태그는 안 가져옴", d.some((x) => x.includes("「dead」 는 규칙이 모두 잘못돼")), d);
      ok("이상한 이름 거름", d.some((x) => x.includes("one.chipper-tags.json") && x.includes("이름이 잘못돼")), d);
      ok("태그 파일이 아닌 것", d.some((x) => x.startsWith("가져오지 못함: notes.txt: JSON 형식이 아닙니다")), d);
      ok("더 새 버전 파일", d.some((x) => x.includes("newer.chipper-tags.json") && x.includes("더 새 버전")), d);
      const sv = savedTags(be);
      const kafka = sv.tags.find((t) => t.name === "kafka");
      ok("좋은 규칙만 들어옴 · #rgb 색 펼침", kafka && kafka.rules.length === 1 && kafka.rules[0].color === "#00aa00", kafka);
      ok("모르는 필드 무시", sv.tags.find((t) => t.name === "zoo")?.rules[0].unknownField === undefined);
      ok("가져온 규칙 id 있음·서로 다름", new Set(sv.tags.flatMap((t) => t.rules.map((r) => r.id))).size === sv.tags.reduce((a, t) => a + t.rules.length, 0));

      // dialog canceled (no files) → nothing
      const n0 = be.st.calls.length;
      await page.click(".tags-import");
      await sleep(200);
      ok("파일 안 고르면 아무 일 없음", be.st.calls.slice(n0).every((c) => c.name !== "SaveTags") && !!(await page.$(".tags-import-result")));
      await ctx.close();
    }
    });

    // =============== 5. import save refused → back to before =================
    await section("5. 가져온 뒤 저장 거부 → 가져오기 전으로", async () => {
    for (const [what, failSave, hint] of [
      ["디스크가 더 새 버전 (오류 코드)", "[TAGS_NEWER_ON_DISK] 디스크의 태그 파일이 더 새 버전의 chipper 가 만든 것이라 덮어쓰지 않았습니다", true],
      ["그 밖의 실패", "디스크가 가득 찼습니다 (version 2 라는 말이 들어가도)", false],
    ]) {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([{ name: "common", rules: [], updated: "" }]);
      const disk = be.st.tags;
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.failSave = failSave;
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "n", rules: [] }] }) }]);
      await page.click(".tags-import");
      await sleep(400);
      const m = await ioMsg(page);
      ok(`${what}: 「저장하지 못해 가져오기 전으로 되돌렸습니다」`, m.includes("저장하지 못해 가져오기 전으로 되돌렸습니다") && m.includes("바뀐 것 없음"), m);
      ok(`${what}: 업데이트 안내는 오류 코드로만 (${hint ? "있음" : "없음"})`, m.includes("업데이트") === hint, m);
      ok(`${what}: 오류 코드 글자는 안 보임`, !m.includes("[TAGS_"), m);
      ok(`${what}: 화면에도 안 들어옴 · 결과 띠 없음`, !(await listNames(page)).includes("n") && !(await page.$(".tags-import-result")));
      ok(`${what}: 디스크 그대로`, be.st.tags === disk);
      await ctx.close();
    }
    });

    // =============== 6. pre-import save fails → stop ==========================
    await section("6. 가져오기 전 저장 실패 → 멈춤", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([{ name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "" }]);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.failSave = "[TAGS_BACKUP_FAILED] 직전 태그 파일(.bak)을 남기지 못해 저장하지 않았습니다";
      await page.click(".rule-add"); // an unsaved edit
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "n", rules: [] }] }) }]);
      await page.click(".tags-import");
      await sleep(300);
      const m = await ioMsg(page);
      ok("먼저 저장 실패 → 「가져오지 않았습니다」", m.includes("먼저 저장하지 못해 가져오지 않았습니다") && m.includes(".bak"), m);
      ok("파일 고르기 창을 열지 않음 · 질문·백업 없음", calls(be, "ImportTagsDialog").length === 0 && be.st.backups.length === 0 && !(await page.$(".tags-conflict")));
      await ctx.close();
    }
    });

    // =============== 7. backup fails → stop ===================================
    await section("7. 가져오기 직전 백업 실패 → 멈춤", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([{ name: "common", rules: [], updated: "" }]);
      const disk = be.st.tags;
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.failBackup = "디스크가 가득 찼습니다";
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "n", rules: [] }] }) }]);
      await page.click(".tags-import");
      await sleep(300);
      const m = await ioMsg(page);
      ok("백업 실패 → 「백업하지 못해 가져오지 않았습니다」", m.includes("백업하지 못해 가져오지 않았습니다"), m);
      ok("백업 실패 → 저장 안 함 · 화면 그대로", be.st.tags === disk && !(await listNames(page)).includes("n"));
      await ctx.close();
    }
    });

    // =============== 8. the clash question holds the keyboard ================
    await section("8. 질문 창 포커스 가두기 (뒤 태그 창 편집 불가)", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([
        { name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "x" },
        { name: "a", rules: [rule("1", "a", "#bb0002")], updated: "x" },
      ]);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      await page.click('.tag-item[data-tag="common"]');
      be.st.importQueue.push([{ name: "c.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "a", rules: [{ pattern: "A" }] }] }) }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      ok("질문이 뜨면 포커스는 질문 창 안", await focusIn(page, ".tags-conflict"));
      const outside = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        if (!(await focusIn(page, ".tags-conflict"))) outside.push(await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName));
      }
      ok("Tab 12번: 전부 질문 창 안", outside.length === 0, outside);
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Tab");
      ok("Shift+Tab 도 창 안", await focusIn(page, ".tags-conflict"));
      ok("뒤 태그 창은 inert", await page.$eval(".tags-dialog .tags-body", (e) => e.hasAttribute("inert")));
      // try to edit the common rule under the question by keyboard
      await page.evaluate(() => document.querySelector(".tags-main .rule-pattern")?.focus());
      await page.keyboard.type("EDITED");
      await sleep(100);
      ok("뒤 규칙 칸에 글자가 안 들어감", (await page.$eval(".tags-main .rule-pattern", (e) => e.value)) === "WARN");
      await page.click(".tags-c-overwrite");
      await page.waitForSelector(".tags-import-result");
      await sleep(600);
      ok("가져온 뒤: common 그대로 WARN (몰래 고친 것 없음) · a 덮어씀", savedTags(be).tags[0].rules[0].pattern === "WARN" && savedTags(be).tags[1].rules[0].pattern === "A");
      ok("질문이 닫히면 inert 풀림", !(await page.$eval(".tags-dialog .tags-body", (e) => e.hasAttribute("inert"))));
      await ctx.close();
    }
    });

    // =============== 9. places come along (「붙인 곳도 같이」) ================
    await section("9. 붙인 곳도 같이 — 내보내기 → 다른 홈에서 가져오기", async () => {
    {
      // home A: collector put on app.log (outside a bundle) and on modules/x
      const a = makeBackend();
      a.st.files["D:\\logs\\app.log"] = "kafka rebalance\n";
      a.st.tags = storeJSON(
        [
          { name: "common", rules: [], updated: "" },
          { name: "collector", rules: [rule("k", "kafka rebalance", "#ee0002")], updated: "" },
          { name: "admin", rules: [rule("a", "login", "#ee0004")], updated: "" },
        ],
        { name: { "app.log": ["collector"] }, dir: { "modules/x": ["collector", "admin"] } }
      );
      a.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      let r = await openPage(browser, url, a);
      await openTags(r.page);
      await r.page.click('.tag-item[data-tag="collector"]');
      await r.page.click(".tags-export");
      await r.page.check(".tags-export-assign-box");
      await r.page.click(".tags-export-go");
      await sleep(200);
      const file = a.st.exports[0].data;
      ok("A: 내보낸 파일에 collector 의 곳만", JSON.stringify(JSON.parse(file).assign) === JSON.stringify({ dir: { "modules/x": ["collector"] }, file: {}, name: { "app.log": ["collector"] } }));
      await r.ctx.close();

      // home B: has its own assignment at modules/x
      const b = makeBackend();
      b.st.files["D:\\logs\\app.log"] = "kafka rebalance\n";
      b.st.tags = storeJSON([{ name: "common", rules: [], updated: "" }, { name: "mine", rules: [], updated: "" }], { dir: { "modules/x": ["mine"] } });
      b.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      r = await openPage(browser, url, b);
      ok("B 가져오기 전: common 만", (await statusTags(r.page)) === "🏷 common");
      await openTags(r.page);
      b.st.importQueue.push([{ name: "collector.chipper-tags.json", text: file }]);
      await r.page.click(".tags-import");
      await r.page.waitForSelector(".tags-import-result");
      await sleep(150);
      ok("요약: 붙인 곳 1개 추가 · 1개는 내 지정이 있어 건너뜀", (await resultLine(r.page)) === "추가 1 · 덮어씀 0 · 건너뜀 0 · 이름 바꿔 추가 0 · 잘못된 규칙 0 · 붙인 곳 1개 추가 · 1개는 내 지정이 있어 건너뜀", await resultLine(r.page));
      const sv = savedTags(b);
      ok("저장: app.log → collector 추가, modules/x 는 내 것(mine) 유지", JSON.stringify(sv.assign.name) === '{"app.log":["collector"]}' && JSON.stringify(sv.assign.dir) === '{"modules/x":["mine"]}', sv.assign);
      ok("백업에도 지정 정보", JSON.parse(b.st.backups[0].data).assign.dir["modules/x"][0] === "mine");
      await r.page.click(".tags-dialog .chips-actions >> text=닫기");
      await sleep(200);
      ok("가져오자마자 색: 상태 표시줄 common + collector", (await statusTags(r.page)) === "🏷 common + collector", await statusTags(r.page));
      ok("가져오자마자 색: kafka rebalance", (await spansWith(r.page, "#ee0002")).includes("kafka rebalance"));
      // undo takes the place away too
      await openTags(r.page);
      // (the result band went with the closed window: use the backups)
      await r.page.click(".tags-restore");
      await r.page.waitForSelector(".tags-restore-item");
      await shot(r.page, "stage5-backups.png");
      const items = await r.page.$$eval(".tags-restore-item", (es) => es.map((e) => e.textContent));
      ok("백업 목록: 가져오기 직전 1개 (태그 2개 · 붙인 곳 1곳)", items.length === 1 && items[0].includes("가져오기 직전") && items[0].includes("태그 2개") && items[0].includes("붙인 곳 1곳"), items);
      await r.page.click(".tags-restore-go");
      await sleep(300);
      ok("되돌리기 전에 물음", r.page.__dialogs.some((d) => d.includes("가져오기 직전 상태로 되돌릴까요?")), r.page.__dialogs);
      const sv2 = savedTags(b);
      ok("백업으로 되돌림: 태그·지정 모두 가져오기 전", JSON.stringify(sv2.tags.map((t) => t.name)) === '["common","mine"]' && JSON.stringify(sv2.assign.name) === "{}");
      ok("되돌리기 직전 상태도 백업(before-restore)", b.st.backups.length === 2 && b.st.backups[1].kind === "restore" && JSON.parse(b.st.backups[1].data).assign.name["app.log"][0] === "collector");
      ok("안내에 두 파일 이름", (await ioMsg(r.page)).includes(b.st.backups[0].file) && (await ioMsg(r.page)).includes(b.st.backups[1].file), await ioMsg(r.page));
      await r.page.click(".tags-dialog .chips-actions >> text=닫기");
      await sleep(200);
      ok("되돌린 뒤 색도 원래대로", (await statusTags(r.page)) === "🏷 common" && (await spansWith(r.page, "#ee0002")).length === 0);
      // 「취소」 to the question → nothing
      await openTags(r.page);
      await r.page.click(".tags-restore");
      await r.page.waitForSelector(".tags-restore-item");
      r.page.__dismiss = true;
      const s0 = calls(b, "SaveTags").length;
      await r.page.click(".tags-restore-item >> nth=0 >> .tags-restore-go");
      await sleep(200);
      ok("되돌리기 질문에 취소 → 아무 일 없음", calls(b, "SaveTags").length === s0 && b.st.backups.length === 2);
      await r.page.keyboard.press("Escape");
      await sleep(100);
      ok("Esc: 백업 창만 닫힘", !(await r.page.$(".tags-restore-panel")) && !!(await r.page.$(".tags-dialog")));
      await r.ctx.close();
    }
    });

    // =============== 10. a tag from an earlier file of the same import ========
    await section("10. 같은 가져오기에서 앞 파일로 들어온 태그", async () => {
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([
        { name: "common", rules: [], updated: "" },
        { name: "collector", rules: [rule("m", "mine", "#bb0002")], updated: "" },
      ]);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.importQueue.push([
        { name: "A.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", tags: [{ name: "collector", rules: [{ pattern: "a" }] }, { name: "kafka", rules: [{ pattern: "1" }] }] }) },
        { name: "B.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", tags: [{ name: "kafka", rules: [{ pattern: "2" }] }] }) },
      ]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      ok("첫 질문에 「나머지 1개」 (B 의 kafka 가 A 의 kafka 와 부딪힘)", ((await page.$eval(".tags-conflict-all", (e) => e.textContent).catch(() => "")) || "").includes("나머지 1개"));
      await page.click(".tags-c-skip");
      await page.waitForSelector(".tags-conflict");
      const q = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      const t = await page.$eval(".tags-conflict-text", (e) => e.textContent);
      ok("둘째 질문: 「방금 가져온」 태그로 부름", q === "「kafka」 태그를 방금 가져왔습니다. 덮어쓰시겠습니까?" && t.includes("방금 A.chipper-tags.json 에서 가져온 「kafka」"), [q, t]);
      await page.click(".tags-c-overwrite");
      await page.waitForSelector(".tags-import-result");
      await ctx.close();
    }
    });
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(`\nio-e2e: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log("FAIL " + f);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
