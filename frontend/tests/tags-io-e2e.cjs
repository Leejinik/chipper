// Headless test of tag export / import (stage 5) against the built frontend.
// The Go side is faked in Node (state survives reloads); the OS file dialogs are
// replaced by ExportTagsDialog / ImportTagsDialog fakes. The fake import parser
// mirrors tags_io.go's envelope checks closely enough for these scenarios (the
// real one is covered by tags_io_test.go).
//
//   cd frontend && npm run build && node tests/tags-io-e2e.cjs
//   PLAYWRIGHT=<path to playwright package>  (default D:/QA/workspace/playwright/node_modules/playwright)
//   SHOTS=<folder>  → screenshots of the export panel, a clash question, the result
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const DIST = path.join(__dirname, "..", "dist");
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
  const out = { path: "C:\\in\\" + name, file: name, error: "", tags: [], problems: [], tagsJson: false };
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
  return out;
}

function makeBackend() {
  const st = { session: "", tags: null, bak: null, calls: [], files: {}, failSave: null, exports: [], exportCancel: false, importQueue: [] };
  const impl = {
    LoadSession: () => st.session,
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
      if (st.exportCancel) return "";
      const v = JSON.parse(data);
      if (v.format !== "chipper-tags") throw new Error("not an export");
      return "C:\\out\\" + defaultName;
    },
    ImportTagsDialog: () => (st.importQueue.shift() || []).map((f) => fakeParse(f.name, f.text)),
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
  page.on("dialog", async (d) => {
    page.__dialogs.push(d.type() + ": " + d.message());
    await d.accept();
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
const openTags = async (page) => {
  await page.dispatchEvent(".st-tags", "mousedown");
  await page.waitForSelector(".tags-dialog");
};
const resultLine = (page) => page.$eval(".tags-import-line", (e) => e.textContent).catch(() => null);
const resultDetails = (page) => page.$$eval(".tags-import-details li", (es) => es.map((e) => e.textContent));
const shot = async (page, name) => {
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, name) });
};

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  let exported1 = null; // the multi-tag export from home A, imported into home B
  try {
    // =============== 1. export ===============================================
    console.log("1. 내보내기");
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\a.log"] = "kafka rebalance\nERROR x\n";
      be.st.tags = storeJSON([
        { name: "common", rules: [rule("e", "ERROR", "#ee0001", { line: true })], updated: "" },
        { name: "collector", rules: [rule("k", "kafka rebalance", "#ee0002", { label: "카프카" })], updated: "" },
        { name: "Collector", rules: [rule("K", "UPPER", "#ee0003")], updated: "" },
        { name: "admin", rules: [rule("a", "login", "#ee0004", { kind: "word" })], updated: "" },
      ], { dir: { "modules/lizcollector": ["collector"] } });
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
      await page.click(".tags-export-go");
      await sleep(200);
      const ex = be.st.exports[0];
      ok("대화상자에 기본 이름 전달", ex && ex.defaultName === "collector.chipper-tags.json", ex && ex.defaultName);
      const v = ex ? JSON.parse(ex.data) : {};
      ok("형식: format·version·exported", v.format === "chipper-tags" && v.version === 1 && typeof v.exported === "string" && !isNaN(Date.parse(v.exported)));
      ok("collector 하나만", JSON.stringify((v.tags || []).map((t) => t.name)) === '["collector"]');
      ok("규칙에 id 없음 · label 있음", v.tags && !("id" in v.tags[0].rules[0]) && v.tags[0].rules[0].label === "카프카");
      ok("지정 정보(assign)·updated 없음", !("assign" in v) && v.tags && !("updated" in v.tags[0]));
      const msg = await page.$eval(".tags-io-msg", (e) => e.textContent).catch(() => "");
      ok("내보낸 경로 안내", msg.includes("C:\\out\\collector.chipper-tags.json") && msg.includes("1개"), msg);
      ok("내보낸 뒤 창 닫힘", !(await page.$(".tags-export-panel")));

      // several tags: needs a name
      await page.click(".tags-export");
      for (const t of ["common", "Collector", "admin"]) await page.check(`.tags-export-item input[data-tag="${t}"]`);
      ok("여러 개면 이름이 비고 내보내기 막힘", (await page.$eval(".tags-export-file", (e) => e.value)) === "" && (await page.$eval(".tags-export-go", (e) => e.disabled)));
      await page.fill(".tags-export-file", "팀 공용");
      ok("이름 넣으면 풀림", !(await page.$eval(".tags-export-go", (e) => e.disabled)));
      await shot(page, "stage5-export.png");
      // canceled save dialog: nothing happens, panel stays
      be.st.exportCancel = true;
      await page.click(".tags-export-go");
      await sleep(200);
      ok("저장 대화상자 취소 → 창 그대로 · 안내 없음", !!(await page.$(".tags-export-panel")) && !(await page.$(".tags-io-msg")));
      be.st.exportCancel = false;
      await page.click(".tags-export-go");
      await sleep(200);
      const ex2 = be.st.exports[be.st.exports.length - 1];
      exported1 = ex2.data;
      ok("여러 개: 기본 이름 「팀 공용.chipper-tags.json」", ex2.defaultName === "팀 공용.chipper-tags.json", ex2.defaultName);
      ok("여러 개: 태그 4개, 목록 순서, common 포함", JSON.stringify(JSON.parse(ex2.data).tags.map((t) => t.name)) === '["common","collector","Collector","admin"]');
      // Esc closes only the export panel
      await page.click(".tags-export");
      await page.keyboard.press("Escape");
      await sleep(100);
      ok("Esc: 내보내기 창만 닫힘", !(await page.$(".tags-export-panel")) && !!(await page.$(".tags-dialog")));
      // none checked → blocked
      await page.click(".tags-export");
      await page.uncheck('.tags-export-item input[data-tag="collector"]');
      ok("하나도 안 고르면 막힘", await page.$eval(".tags-export-go", (e) => e.disabled));
      await ctx.close();
    }

    // =============== 2. import into another home: clash questions ===========
    console.log("2. 다른 홈에서 가져오기 — 없음/같음/다름(덮어쓰기·다른 이름)·대소문자");
    const beB = makeBackend();
    {
      beB.st.files["D:\\logs\\app.log"] = "kafka rebalance\nERROR boom\nUPPER case\nWARN w\n";
      const before = storeJSON(
        [
          { name: "common", rules: [rule("w", "WARN", "#bb0001")], updated: "x" },
          { name: "collector", rules: [rule("m", "mine only", "#bb0002")], updated: "x" },
          // same content as exported admin, other id / label → skipped silently
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
      const saves0 = beB.st.calls.filter((c) => c.name === "SaveTags").length;
      await page.click(".tags-import");
      await page.waitForSelector(".tags-conflict");
      const q1 = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      ok("첫 질문 = common 덮어쓰기", q1 === "「common」 태그가 이미 있습니다. 덮어쓰시겠습니까?", q1);
      ok("common 질문에 「모든 로그」 경고", (await page.$eval(".tags-conflict .chips-sub", (e) => e.textContent)).includes("모든 로그의 색이 바뀝니다"));
      ok("「나머지 1개도 모두 같게」 (collector 남음)", ((await page.$eval(".tags-conflict-all", (e) => e.textContent).catch(() => "")) || "").includes("나머지 1개"));
      ok("다른 이름 버튼에 새 이름", (await page.$eval(".tags-c-rename", (e) => e.textContent)).includes("common (2)"));
      await shot(page, "stage5-conflict.png");
      await page.click(".tags-c-overwrite");
      await page.waitForSelector(".tags-conflict");
      const q2 = await page.$eval(".tags-conflict-q", (e) => e.textContent);
      ok("둘째 질문 = collector", q2 === "「collector」 태그가 이미 있습니다. 덮어쓰시겠습니까?", q2);
      ok("마지막 질문엔 「모두 같게」 없음", !(await page.$(".tags-conflict-all")));
      await page.click(".tags-c-rename");
      await page.waitForSelector(".tags-import-result");
      await sleep(100);
      ok("질문은 두 번뿐 (admin 같음·Collector 새것은 안 물음)", !(await page.$(".tags-conflict")));
      ok("요약 줄", (await resultLine(page)) === "추가 1 · 덮어씀 1 · 건너뜀 1 · 이름 바꿔 추가 1 · 잘못된 규칙 0", await resultLine(page));
      const det = await resultDetails(page);
      ok(
        "요약 자세히",
        det.includes("추가: 「Collector」") &&
          det.includes("덮어씀: 「common」") &&
          det.includes("건너뜀(내 태그와 내용이 같음): 「admin」") &&
          det.includes("이름 바꿔 추가: 「collector」 → 「collector (2)」"),
        det
      );
      await shot(page, "stage5-result.png");
      const names = await listNames(page);
      ok("목록에 collector·Collector·collector (2) 모두", JSON.stringify(names) === JSON.stringify(["common", "collector", "admin", "collector (2)", "Collector"]), names);
      ok("가져온 첫 태그(Collector)가 선택됨", (await page.$eval(".tag-item.sel .tag-name", (e) => e.textContent)) === "Collector");
      await sleep(100);
      ok("가져오기는 저장 한 번 (곧바로)", beB.st.calls.filter((c) => c.name === "SaveTags").length === saves0 + 1);
      ok("tags.json.bak = 가져오기 직전 내용", beB.st.bak === before);
      const sv = savedTags(beB);
      ok("저장: common 덮어씀", JSON.stringify(sv.tags[0].rules.map((r) => r.pattern)) === '["ERROR"]');
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

    // =============== 3. undo ==================================================
    console.log("3. 되돌리기");
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
      ok("되돌림 안내", ((await page.$eval(".tags-io-msg", (e) => e.textContent).catch(() => "")) || "").includes("되돌렸습니다"));
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

    // =============== 4. 「나머지도 모두 같게」 · Esc · several files · bad rules ===
    console.log("4. 모두 같게 · Esc 그만두기 · 여러 파일 · 잘못된 규칙");
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
      ok("Esc: 그만뒀다는 안내", ((await page.$eval(".tags-io-msg", (e) => e.textContent).catch(() => "")) || "").includes("그만뒀습니다"));
      await sleep(600);
      ok("Esc: 앞서 고른 덮어쓰기도 반영 안 됨", be.st.tags === tagsBefore && (await listNames(page)).join() === "common,a,b");
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
      ok("바뀐 것 없으면 되돌리기 버튼 없음", !(await page.$(".tags-undo")));
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
          { name: "kafka", rules: [{ pattern: "rebalance", color: "#0a0" }, { pattern: "(a|aa)+$", kind: "regex" }, { pattern: "x", color: "red" }] },
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
      ok("잘못된 규칙 이유: 위험 정규식", d.some((x) => x.includes("one.chipper-tags.json · kafka · 2번째 규칙") && x.includes("화면을 멈출 수 있는 정규식")), d);
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

    // =============== 5. save refused (newer tags.json on disk) ================
    console.log("5. 저장 거부");
    {
      const be = makeBackend();
      be.st.files["D:\\logs\\app.log"] = "x\n";
      be.st.tags = storeJSON([{ name: "common", rules: [], updated: "" }]);
      be.st.session = session([tab("t1", "D:\\logs\\app.log")], "t1");
      const { ctx, page } = await openPage(browser, url, be);
      await openTags(page);
      be.st.failSave = "디스크의 태그 파일이 더 새 버전(version 2)이라 저장하지 않았습니다";
      be.st.importQueue.push([{ name: "x.chipper-tags.json", text: JSON.stringify({ format: "chipper-tags", version: 1, tags: [{ name: "n", rules: [] }] }) }]);
      await page.click(".tags-import");
      await page.waitForSelector(".tags-import-result");
      await sleep(150);
      const se = await page.$eval(".tags-import-save", (e) => e.textContent).catch(() => "");
      ok("저장 실패 문구 (사라짐 경고 + 업데이트 안내)", se.includes("저장하지 못했습니다") && se.includes("다시 켜면 사라집니다") && se.includes("업데이트"), se);
      ok("저장 실패해도 화면엔 들어옴", (await listNames(page)).includes("n"));
      await ctx.close();
    }
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
