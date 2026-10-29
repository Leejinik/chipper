// linesOfParts / textOfParts / ropeOf (editParts.ts): the pieces of a big file
// give the same editor document as the whole string, wherever they are cut.
import { EditorState } from "@codemirror/state";
import { linesOfParts, ropeOf, textOfParts } from "../src/editParts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}
let seed = 12345;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const alpha = ["a", "b", "가", "😀", " ", "\n", "\r\n", "\r", "x", "\r", "\n"];
function cut(s: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < s.length) {
    let n = 1 + rnd(7);
    // never inside a surrogate pair (Go cuts on character boundaries)
    if (at + n < s.length && /[\uDC00-\uDFFF]/.test(s[at + n])) n++;
    out.push(s.slice(at, at + n));
    at += n;
  }
  return out;
}
for (let k = 0; k < 2000; k++) {
  let s = "";
  const len = rnd(40);
  for (let i = 0; i < len; i++) s += alpha[rnd(alpha.length)];
  const parts = cut(s);
  const want = EditorState.create({ doc: s }).doc;
  const got = textOfParts(parts);
  if (!got.eq(want) || got.lines !== want.lines) {
    ok("무작위 " + k, false, { s, parts, want: want.toJSON(), got: got.toJSON() });
    break;
  }
  ok("rope", ropeOf(parts) === s);
}
ok("빈 조각 목록 → 빈 줄 하나", JSON.stringify(linesOfParts([])) === '[""]');
ok("CRLF 가 두 조각에 걸침", JSON.stringify(linesOfParts(["a\r", "\nb"])) === '["a","b"]');
ok("CR 뒤 다음 조각이 LF 아님", JSON.stringify(linesOfParts(["a\r", "b"])) === '["a","b"]');
ok("CR 조각 + LF 만 든 조각 + LF", JSON.stringify(linesOfParts(["a\r", "\n", "\nb"])) === '["a","","b"]');
ok("빈 조각은 건너뜀(CR 짝 유지)", JSON.stringify(linesOfParts(["a\r", "", "\nb"])) === '["a","b"]');
console.log(`editparts-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
