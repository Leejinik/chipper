// Shortcut keys must not depend on the input language (한글 mode gave "ctrl+ㄴ").
import { comboKey, normalizeCombo } from "../src/keyCombo";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// 한글 mode: key is the jamo, code is the physical key
eq("ㄴ+KeyS", comboKey({ key: "ㄴ", code: "KeyS" }), "s");
eq("ㅆ(shift)+KeyT", comboKey({ key: "ㅆ", code: "KeyT" }), "t");
eq("ㅗ+KeyH", comboKey({ key: "ㅗ", code: "KeyH" }), "h");
// English mode unchanged
eq("s+KeyS", comboKey({ key: "s", code: "KeyS" }), "s");
eq("S(shift)+KeyS", comboKey({ key: "S", code: "KeyS" }), "s");
// digits by position (shift+1 gives "!")
eq("0+Digit0", comboKey({ key: "0", code: "Digit0" }), "0");
eq("!+Digit1", comboKey({ key: "!", code: "Digit1" }), "1");
// no code (synthetic event): jamo still mapped
eq("ㄴ no code", comboKey({ key: "ㄴ" }), "s");
// non-letter keys keep their key name
eq("Tab", comboKey({ key: "Tab", code: "Tab" }), "tab");
eq("F5", comboKey({ key: "F5", code: "F5" }), "f5");
eq("Control", comboKey({ key: "Control", code: "ControlLeft" }), "control");
eq("space", comboKey({ key: " ", code: "Space" }), " ");
eq("=", comboKey({ key: "=", code: "Equal" }), "=");

// stored bindings from earlier builds
eq("ctrl+ㄴ", normalizeCombo("ctrl+ㄴ"), "ctrl+s");
eq("ctrl+shift+ㅆ", normalizeCombo("ctrl+shift+ㅆ"), "ctrl+shift+t");
eq("ctrl+s", normalizeCombo("ctrl+s"), "ctrl+s");
eq("ctrl+f5", normalizeCombo("ctrl+f5"), "ctrl+f5");

console.log(`keycombo-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
