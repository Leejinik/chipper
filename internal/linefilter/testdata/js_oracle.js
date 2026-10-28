// JS oracle for TestJSOracle: replays frontend/src/logHighlight.ts compileRule +
// build() (empty matches skipped) on the corpus the Go test wrote, and compares
// which lines get a colour and where the first coloured match starts (UTF-16).
const fs = require("fs");
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function riskyRegex(src) {
  const s = src.replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "x");
  const groups = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") groups.push(false);
    else if (c === ")") {
      const inner = groups.pop() ?? false;
      const next = s[i + 1];
      const repeated = next === "*" || next === "+" || next === "{";
      if (inner && repeated) return true;
      if (groups.length && (inner || repeated)) groups[groups.length - 1] = true;
    } else if ((c === "*" || c === "+" || c === "{") && groups.length) groups[groups.length - 1] = true;
  }
  return false;
}
function compile(r) {
  const isRe = r.kind === "regex";
  if (!r.pattern) return null;
  if (isRe && riskyRegex(r.pattern)) return "risky";
  try {
    let src;
    if (isRe) src = r.pattern;
    else if (r.kind === "word") src = `(?<![\\w])${escapeRe(r.pattern)}(?![\\w])`;
    else src = escapeRe(r.pattern);
    const re = new RegExp(src, r.caseSensitive ? "g" : "gi");
    return re.test("") ? null : re;
  } catch { return null; }
}
// The editor matches on the line without its ANSI codes (logHighlight.ts
// stripAnsi, the same regex) and reports positions in the line as stored.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
function firstColourRaw(re, text) {
  re.lastIndex = 0; let m;
  while ((m = re.exec(text))) { if (!m[0]) { re.lastIndex++; continue; } return m.index; }
  return -1;
}
function firstColour(re, line) {
  if (line.indexOf("\x1b") < 0) return firstColourRaw(re, line);
  const raw = []; let vis = ""; let at = 0; let m;
  ANSI_RE.lastIndex = 0;
  const keep = (a, b) => { vis += line.slice(a, b); for (let i = a; i < b; i++) raw.push(i); };
  while ((m = ANSI_RE.exec(line))) { keep(at, m.index); at = m.index + m[0].length; }
  keep(at, line.length);
  const p = firstColourRaw(re, vis);
  return p < 0 ? -1 : raw[p];
}
const st = { rules: 0, both: 0, editorRisky: 0, goOnly: 0, editorOnly: [], lineChecks: 0, lineMismatch: 0, colChecks: 0, colMismatch: 0, knownAstral: 0, knownModifier: 0 };
// Known differences, counted apart: characters outside the BMP (JS without the
// u flag works on UTF-16 halves, Go on whole characters) and V8's handling of
// (?i: ...) modifier groups with alternatives (e.g. /(?i:O|[a-z])/ misses "E").
const astral = (ln) => /[\uD800-\uDBFF]/.test(ln);
const modifier = (r) => r.kind === "regex" && /\(\?[-ims]/.test(r.pattern);
const ex = [];
for (const c of cases) {
  const res = c.rules.map(compile);
  c.rules.forEach((r, ri) => {
    st.rules++;
    const re = res[ri];
    const goIssue = c.issues[ri];
    if (re === "risky") { st.editorRisky++; return; }
    if (!re && !goIssue && modifier(r)) { st.knownModifier++; return; } // older V8: no (?i:) modifiers
    if (!re && !goIssue) { st.goOnly++; if (ex.length < 20) ex.push({ kind: "go accepts, editor refuses", r }); return; }
    if (re && goIssue) { st.editorOnly.push(goIssue.replace(/^.*: /, "").slice(0, 30)); return; }
    if (!re) return;
    st.both++;
    c.lines.forEach((ln, li) => {
      st.lineChecks++;
      const js = firstColour(re, ln) >= 0;
      const go = (c.hits[li + 1] || []).includes(ri);
      if (js !== go && astral(ln)) { st.knownAstral++; return; }
      if (js !== go && modifier(r)) { st.knownModifier++; return; }
      if (js !== go) { st.lineMismatch++; if (ex.length < 20) ex.push({ kind: "line", r, ln, js, go }); }
    });
  });
  // first colour of the whole line (any rule both accept) vs the engine's col
  c.lines.forEach((ln, li) => {
    const hit = c.hits[li + 1];
    if (!hit) return;
    let best = -1, allBoth = true;
    hit.forEach((ri) => { const re = res[ri]; if (!re || re === "risky") { allBoth = false; return; } const p = firstColour(re, ln); if (p >= 0 && (best < 0 || p < best)) best = p; });
    if (!allBoth || astral(ln) || hit.some((i) => modifier(c.rules[i]))) return;
    st.colChecks++;
    if (best !== c.cols[li + 1]) { st.colMismatch++; if (ex.length < 20) ex.push({ kind: "col", ln, js: best, go: c.cols[li + 1], rules: hit.map((i) => c.rules[i]) }); }
  });
}
const counts = {};
st.editorOnly.forEach((k) => (counts[k] = (counts[k] || 0) + 1));
st.editorOnly = counts;
console.log(JSON.stringify(st));
for (const e of ex) console.log(JSON.stringify(e));
