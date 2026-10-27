// Writes tests/translate-corpus.json: JS regex patterns (hand-picked + random,
// fixed seed) whose JS→RE2 translation must be identical in the Go line filter
// (internal/linefilter translateJS) and in src/jsRegex.ts.
//   node tests/gen-translate-corpus.cjs
// The Go side's answers live in tests/translate-go.json, one per case:
//   { out, reason } = translateJS(js, ci)
//   filter          = the reason compileOne(Rule{Kind:"regex", Pattern:js,
//                     CaseSensitive:!ci}) gives ("" = usable)
// Made by a throwaway test in internal/linefilter (stage 1):
//   in, _ := os.ReadFile(CORPUS); json.Unmarshal(in, &cases)
//   for each case: o, why := translateJS(c.JS, c.CI); _, fr := compileOne(...)
//   os.WriteFile(OUT, json.Marshal(results))
// Regenerate both files whenever translateJS changes on either side; once the
// branches are merged, a Go test can check this file directly.
const fs = require("fs");
const path = require("path");

const hand = [
  String.raw`\s`, String.raw`[\s]x`, String.raw`\S`, String.raw`[^\S]`, String.raw`a.b`, String.raw`x[]`, String.raw`x[^]y`,
  String.raw`\u0041\x42`, String.raw`\uD83D\uDE00`, String.raw`\uD800`, String.raw`\uDC00x`, String.raw`\cJ`, String.raw`\cI`, String.raw`\c`, String.raw`[\c_]`,
  String.raw`\e\q`, String.raw`a{2}`, String.raw`{abc}`, String.raw`x{,3}`, String.raw`x{2,}`, String.raw`x{2,5}?`, String.raw`a]`, String.raw`[[]`,
  String.raw`[\d-z]`, String.raw`[\b]`, String.raw`(?<year>\d{4})-x`, String.raw`(?<$n>a)`, String.raw`(?<a>x)(?<a>y)`, String.raw`(?<a`,
  String.raw`(?i:abc)D`, String.raw`(?-i:abc)D`, String.raw`(?s:a.b)`, String.raw`(?ii:a)`, String.raw`(?x)a`, String.raw`(?:)`,
  String.raw`\/path\/`, String.raw`\-\ \가`, String.raw`a??b+?`, String.raw`^ERROR$`, "kafka", String.raw`[a-z]+s`, String.raw`[^k]`,
  "é", String.raw`\w`, String.raw`\W`, "ß", "ſ", "\u212a", String.raw`[z-a]`, String.raw`(?<=x)y`, String.raw`(?<!x)y`, String.raw`x(?=y)`,
  String.raw`x(?!y)`, String.raw`(a)\1`, String.raw`(?<n>a)\k<n>`, String.raw`\k<n>`, String.raw`a{1001}`, String.raw`\u{41}`, String.raw`\012`, String.raw`\0`,
  String.raw`[\1]`, "(a", "a)", "[abc", "x\\", "a*", String.raw`\b`,
  // default rules
  String.raw`\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`,
  String.raw`\bWARN(ING)?\b`, String.raw`\b(INFO|NOTICE)\b|\[Note\]`, String.raw`\b(DEBUG|TRACE|VERBOSE)\b`,
  String.raw`\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`,
  String.raw`Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`,
  // the review's examples
  String.raw`(a+){4}$`, String.raw`(.*,){4}X`, String.raw`(\w+\s?){4}!`, String.raw`(ab?|b)+$`, String.raw`.*a.*b`, String.raw`(a|aa)+$`,
  String.raw`(\w|-)+`, String.raw`(\d|\.)+`, String.raw`(,|\s)*`, String.raw`(\w|\.)+@`, String.raw`([a-z]|\d)+`, String.raw`(\d{1,3}\.){3}\d{1,3}`,
  "가나다", "한글 Kafka 로그", String.raw`[가-힣]+`, String.raw`[À-ÿ]`, String.raw`[Α-Ω]+`, String.raw`[ǅ]`, "ǅ", String.raw`[\u0100-\u017f]`,
  String.raw`[^\u0000-\u007f]`, "😀", String.raw`[😀]`, "\t", "\u00a0", "\u3000x", String.raw`\x7f\x00`, "a\u0085b",
];

// random patterns from a token alphabet (seeded LCG)
let seed = 20261027;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const tokens = [
  "a", "b", "K", "k", "s", "S", "é", "ß", "가", "-", "_", ".", " ", "\\d", "\\w", "\\s", "\\S", "\\W", "\\D", "\\b", "\\B", "\\.", "\\(",
  "\\)", "\\[", "\\]", "\\{", "\\}", "\\-", "\\t", "\\x41", "\\u00e9", "\\u212a", "\\cA", "[a-z]", "[^a-z]", "[\\d.]", "[\\w-]", "[k-s]",
  "[À-Þ]", "[^\\s]", "[\\s\\S]", "[]", "[^]", "(", ")", "(?:", "(?<g>", "(?i:", "(?-i:", "(?s:", "|", "*", "+", "?", "*?", "+?", "{2}",
  "{1,3}", "{2,}", "{", "}", "^", "$", ",", ":", "/", "=", "\\/", "@", "\u00a0", "\u3000", "😀", "Ǆ", "ǆ", "ſ",
];
const rand = [];
const seen = new Set(hand);
while (rand.length < 1500) {
  const len = 1 + rnd(9);
  let p = "";
  for (let i = 0; i < len; i++) p += tokens[rnd(tokens.length)];
  if (!seen.has(p)) {
    seen.add(p);
    rand.push(p);
  }
}

const cases = [];
for (const p of [...hand, ...rand]) for (const ci of [false, true]) cases.push({ js: p, ci });
const out = path.join(__dirname, "translate-corpus.json");
fs.writeFileSync(out, JSON.stringify(cases) + "\n");
console.log(`${cases.length} cases → ${out}`);
