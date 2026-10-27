// "v1.2.0 rules → v1.2.0 colours": renders the same documents with random rule
// sets through v1.2.0's logHighlight.ts (git show main:…) and the current one,
// in real CodeMirror in headless chromium, and compares the computed colour of
// every character and the background of every line.
//
//   cd frontend && node tests/colors-v120.cjs        (needs git and Playwright)
//   PLAYWRIGHT=<path>   OLD_REF=<git ref, default main>   SETS=<rule sets, default 200>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));
const { chromium } = require(process.env.PLAYWRIGHT || "D:/QA/workspace/playwright/node_modules/playwright");

const FRONT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chipper-v120-"));
const oldSrc = execFileSync("git", ["show", `${process.env.OLD_REF || "main"}:frontend/src/logHighlight.ts`], { cwd: FRONT, encoding: "utf8" });
if (!/regex: boolean/.test(oldSrc)) throw new Error("OLD_REF is not the v1.2.0 rule format");
fs.writeFileSync(path.join(tmp, "old.ts"), oldSrc);
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(
  entry,
  `
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import * as OLD from ${JSON.stringify(path.join(tmp, "old.ts"))};
import * as NEW from ${JSON.stringify(path.join(FRONT, "src", "logHighlight.ts"))};
(window as any).usable = (rules: any[]) => rules.map((r) => !!OLD.compileRule(r.old) && !!NEW.compileRule(r.cur));
(window as any).ranges = (rules: any[], line: string) => rules.map((r) => (r.cur.on ? NEW.compileRule(r.cur)!.ranges(line.slice(0, 2000)) : []));
(window as any).paint = (which: "old" | "new", doc: string, rules: any[]) => {
  const parent = document.createElement("div");
  parent.style.height = "4000px";
  document.body.append(parent);
  const ext = which === "old" ? OLD.logHighlighter(rules.map((r) => r.old)) : NEW.logHighlighter(rules.map((r) => r.cur));
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [ext] }), parent });
  const out: string[] = [];
  for (const line of Array.from(view.contentDOM.querySelectorAll(".cm-line")) as HTMLElement[]) {
    const bg = getComputedStyle(line).backgroundColor;
    const chars: string[] = [];
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const c = getComputedStyle((n as Text).parentElement!).color;
      for (let i = 0; i < (n as Text).data.length; i++) chars.push(c);
    }
    out.push(bg + "|" + chars.join(","));
  }
  view.destroy();
  parent.remove();
  return out;
};
`
);
const bundle = path.join(tmp, "bundle.js");
esbuild.buildSync({ entryPoints: [entry], bundle: true, format: "iife", outfile: bundle, nodePaths: [path.join(FRONT, "node_modules")], logLevel: "warning" });

// ---- rule pool and documents ------------------------------------------------------
const pool = [
  // [pattern, regex?]  — v1.2.0 rules: regex true = regex, false = word
  ["\\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\\b|\\b\\w*Exception\\b", true],
  ["\\bWARN(ING)?\\b", true],
  ["\\b(INFO|NOTICE)\\b|\\[Note\\]", true],
  ["\\b\\d{4}-\\d\\d-\\d\\d[ T] ?\\d{1,2}:\\d\\d:\\d\\d([.,]\\d+)?", true],
  ["\\b\\w*Exception\\b", true],
  ["Pointer", false],
  ["Pointer", true],
  ["Timeout", true],
  ["Exception", true],
  ["connect(ion)?", true],
  ["\\d+", true],
  ["\\d{3}", true],
  ["\\d+ms", true],
  ["deviceId: \\d+", true],
  ["\\[[A-Z ]+\\]", true],
  ["\\([^)]*\\)", true],
  ["[A-Z]{3,}", true],
  ["o", true],
  ["oo", true],
  ["on", true],
  ["e.", true],
  ["lizserver\\d+(:\\d+)?", true],
  ["redis", false],
  ["queue", false],
  ["Sentinel", false],
  ["task", false],
  ["10\\.10\\.\\d+\\.\\d+", true],
  ["(\\d{1,3}\\.){3}\\d{1,3}", true],
  ["run", false],
  ["TASK", false],
  ["kafka queue", true],
  ["[a-z]+Task", true],
  ["Lost connection", true],
  ["\\bat\\b", true],
  ["\\s=\\s", true],
  ["null", false],
  ["\\w+\\.\\w+", true],
];
let seed = 20261027;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const color = (i) => "#" + [0x30 + ((i * 53) % 0xc0), 0x30 + ((i * 97) % 0xc0), 0x30 + ((i * 29) % 0xc0)].map((x) => x.toString(16).padStart(2, "0")).join("");
const logPath = process.env.LOG || "C:/Users/logan.lee/Desktop/rtaskmgr-logs-20261022-064653/Bromo_20261922-1/modules/lizcollector/collector.log.2026-10-21_1";
let sample = [];
try {
  const fd = fs.openSync(logPath, "r");
  const buf = Buffer.alloc(200000);
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  sample = buf.toString("utf8").split(/\r?\n/).slice(0, 1500).filter((l) => l.length < 400);
} catch {
  /* no log here: crafted lines only */
}
const crafted = [
  "x NullPointerException y TimeoutException z",
  "ERROR connection Timeout (deviceId: 40) at lizserver03:26379 [RESERVE TASK]",
  "2026-10-20 17:03:00.123 WARN queue = 0 (59/sec) took 120ms",
  "oooo onon eeee e.e. 10.10.90.137:502 port(502)",
  "FAILED: IOException in run() — Pointer null",
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: bundle });
  const SETS = Number(process.env.SETS || 200);
  let compared = 0;
  let sameLines = 0;
  let tieLines = 0;
  let tieChars = 0;
  let skipped = 0;
  const diffs = [];
  for (let k = 0; k < SETS; k++) {
    const n = 2 + rnd(7);
    const rules = [];
    for (let i = 0; i < n; i++) {
      const [pattern, regex] = pool[rnd(pool.length)];
      const caseSensitive = rnd(3) === 0;
      const line = rnd(3) === 0;
      const c = color(k * 10 + i + 1);
      const base = { id: `r${i}`, on: true, label: "", pattern, caseSensitive, color: c, line };
      rules.push({ old: { ...base, regex }, cur: { ...base, kind: regex ? "regex" : "word", filter: true } });
    }
    const usable = await page.evaluate((r) => window.usable(r), rules);
    const kept = rules.filter((_, i) => usable[i]);
    skipped += rules.length - kept.length;
    const lines = [...crafted];
    for (let i = 0; i < 25 && sample.length; i++) lines.push(sample[rnd(sample.length)]);
    const doc = lines.join("\n");
    const [a, b] = await page.evaluate(([d, r]) => [window.paint("old", d, r), window.paint("new", d, r)], [doc, kept]);
    compared++;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) {
        sameLines++;
        continue;
      }
      // A character where v1.2.0 shows a match that has the very same range as
      // another rule's match had no fixed colour in v1.2.0 (CodeMirror's heap
      // order); count those apart. Anything else is a real difference.
      {
        const [abg0, ac0] = a[i].split("|");
        const [bbg0, bc0] = b[i].split("|");
        const A0 = ac0.split(/,(?=rgba?\()/);
        const B0 = bc0.split(/,(?=rgba?\()/);
        const rgbOf = (hex) => `rgb(${[1, 3, 5].map((j) => parseInt(hex.slice(j, j + 2), 16)).join(", ")})`;
        const rr = await page.evaluate(([r, l]) => window.ranges(r, l), [kept, lines[i]]);
        let real = abg0 !== bbg0;
        for (let j = 0; j < A0.length && !real; j++) {
          if (A0[j] === B0[j]) continue;
          tieChars++;
          const covering = [];
          rr.forEach((fs, ri) => {
            for (let x = 0; x < fs.length; x += 2) if (fs[x] <= j && j < fs[x + 1]) covering.push([ri, fs[x], fs[x + 1]]);
          });
          const shown = covering.find(([ri]) => rgbOf(kept[ri].old.color) === A0[j]);
          const tied = shown ? covering.filter(([, f, t]) => f === shown[1] && t === shown[2]) : [];
          // a tie, and the new colour is one of the tied rules (the later one)
          const tie = tied.length > 1 && tied.some(([ri]) => rgbOf(kept[ri].old.color) === B0[j]);
          if (!tie) real = true;
        }
        if (!real) {
          tieLines++;
          continue;
        }
      }
      {
        const [abg, ac] = a[i].split("|");
        const [bbg, bc] = b[i].split("|");
        const A = ac.split(/,(?=rgba?\()/);
        const B = bc.split(/,(?=rgba?\()/);
        let at = A.findIndex((x, j) => x !== B[j]);
        diffs.push({
          set: k,
          rules: kept.map((r) => r.old.pattern + " " + r.old.color + (r.old.line ? " [줄]" : "") + (r.old.caseSensitive ? " [Aa]" : "") + (r.old.regex ? "" : " [단어]")),
          line: lines[i],
          bg: abg === bbg ? "same" : { old: abg, cur: bbg },
          at,
          around: at >= 0 ? lines[i].slice(Math.max(0, at - 10), at + 10) : "",
          oldColor: A[at],
          curColor: B[at],
        });
        break;
      }
    }
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    `colors-v120: ${compared} rule sets × ${crafted.length + (sample.length ? 25 : 0)} lines; same ${sameLines} lines, ` +
      `differ only where v1.2.0 had a tie (same range, two rules) ${tieLines} lines, real differences ${diffs.length}; ${skipped} rules skipped (unusable in one of the two)`
  );
  for (const d of diffs.slice(0, 5)) console.log("DIFF", JSON.stringify(d, null, 1));
  process.exit(diffs.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
