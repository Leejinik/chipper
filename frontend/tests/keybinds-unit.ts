// Every app shortcut is user-remappable (keybinds.ts): combos from events (⌘ = Ctrl,
// 한글 IME by physical key), the display (Windows "Ctrl+Shift+S", macOS "⇧⌘S"),
// conflicts, sessions written by earlier builds, the per-pane commands and the
// Ctrl/⌘ + wheel zoom setting (user 10-29).
import {
  COMMANDS,
  DEFAULT_KEYBINDS,
  RESERVED_COMBOS,
  comboFromEvent,
  formatCombo,
  modLabel,
  normalizeKeybinds,
  bindProblem,
  captureCombo,
  matchCommand,
  isZoomWheel,
  normalizeWheelZoom,
  WHEEL_ZOOMS,
  defaultKeybinds,
  formatKeys,
  macEventProblem,
  splitKeybinds,
  type CmdId,
} from "../src/keybinds";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${g}, want ${w}`);
  }
}
const ev = (key: string, code: string, m: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!m.ctrl,
  metaKey: !!m.meta,
  altKey: !!m.alt,
  shiftKey: !!m.shift,
});

// --- combos from events ---------------------------------------------------------------
eq("Ctrl+S", comboFromEvent(ev("s", "KeyS", { ctrl: true })), "ctrl+s");
eq("⌘S folds into ctrl", comboFromEvent(ev("s", "KeyS", { meta: true })), "ctrl+s");
eq("⌃⌘S is still ctrl+s", comboFromEvent(ev("s", "KeyS", { meta: true, ctrl: true })), "ctrl+s");
eq("한글 IME ⌘ㄴ", comboFromEvent(ev("ㄴ", "KeyS", { meta: true })), "ctrl+s");
eq("한글 IME Ctrl+Shift+ㅆ", comboFromEvent(ev("ㅆ", "KeyT", { ctrl: true, shift: true })), "ctrl+shift+t");
eq("Alt+Shift+F3 order", comboFromEvent(ev("F3", "F3", { shift: true, alt: true })), "alt+shift+f3");
eq("modifier only", comboFromEvent(ev("Meta", "MetaLeft", { meta: true })), null);
eq("modifier only (shift)", comboFromEvent(ev("Shift", "ShiftLeft", { shift: true })), null);
eq("space", comboFromEvent(ev(" ", "Space", { ctrl: true })), "ctrl+space");
eq("plain End", comboFromEvent(ev("End", "End")), "end");
eq("⌘↑", comboFromEvent(ev("ArrowUp", "ArrowUp", { meta: true })), "ctrl+arrowup");

// --- display ---------------------------------------------------------------------------
eq("win Ctrl+Shift+S", formatCombo("ctrl+shift+s", false), "Ctrl+Shift+S");
eq("mac ⇧⌘S (Apple order)", formatCombo("ctrl+shift+s", true), "⇧⌘S");
eq("mac ⌘S", formatCombo("ctrl+s", true), "⌘S");
eq("mac ⌥⌘I", formatCombo("ctrl+alt+i", true), "⌥⌘I");
eq("mac ⇧F3", formatCombo("shift+f3", true), "⇧F3");
eq("win Shift+F3", formatCombo("shift+f3", false), "Shift+F3");
eq("win F3", formatCombo("f3", false), "F3");
eq("win PageDown", formatCombo("pagedown", false), "PageDown");
eq("mac End", formatCombo("end", true), "End");
eq("mac arrows", formatCombo("ctrl+arrowup", true), "⌘↑");
eq("win arrows", formatCombo("ctrl+arrowdown", false), "Ctrl+↓");
eq("win Ctrl+Tab", formatCombo("ctrl+tab", false), "Ctrl+Tab");
eq("mac ⌃Tab (⌘Tab is the system app switcher)", formatCombo("ctrl+tab", true), "⌃Tab");
eq("mac ⌃⇧Tab", formatCombo("ctrl+shift+tab", true), "⌃⇧Tab");
eq("mac ⌘0", formatCombo("ctrl+0", true), "⌘0");
eq("win Ctrl+Space", formatCombo("ctrl+space", false), "Ctrl+Space");
eq("win Enter", formatCombo("enter", false), "Enter");
eq("unbound", formatCombo("", false), "없음");
eq("unbound mac", formatCombo("", true), "없음");
eq("modLabel mac ⌘", modLabel("ctrl", true), "⌘");
eq("modLabel mac ⌥", modLabel("alt", true), "⌥");
eq("modLabel win Ctrl", modLabel("ctrl", false), "Ctrl");
eq("modLabel mac ⌃ (real control)", modLabel("control", true), "⌃");
eq("modLabel win meta", modLabel("meta", false), "Win");

// --- the commands --------------------------------------------------------------------------
const ids = COMMANDS.map((c) => c.id);
eq("old 10 commands kept", ["new", "open", "save", "saveAs", "close", "find", "replace", "inClause", "chips", "resetZoom"].every((id) => ids.includes(id as CmdId)), true);
eq("new: find next/prev + lines keys", ["findNext", "findPrev", "lvTop", "lvEnd", "lvPageUp", "lvPageDown", "lvOpen"].every((id) => ids.includes(id as CmdId)), true);
eq("ids unique", new Set(ids).size, ids.length);
eq("old defaults unchanged", [DEFAULT_KEYBINDS.new, DEFAULT_KEYBINDS.save, DEFAULT_KEYBINDS.saveAs, DEFAULT_KEYBINDS.find, DEFAULT_KEYBINDS.resetZoom], ["ctrl+n", "ctrl+s", "ctrl+shift+s", "ctrl+f", "ctrl+0"]);
eq("today's hard-wired keys as defaults", [DEFAULT_KEYBINDS.findNext, DEFAULT_KEYBINDS.findPrev, DEFAULT_KEYBINDS.lvTop, DEFAULT_KEYBINDS.lvEnd, DEFAULT_KEYBINDS.lvPageUp, DEFAULT_KEYBINDS.lvPageDown, DEFAULT_KEYBINDS.lvOpen], ["f3", "shift+f3", "home", "end", "pageup", "pagedown", "enter"]);
eq("every command has a group and a scope", COMMANDS.every((c) => !!c.group && !!c.scope && !!c.label), true);
eq("lines commands are pane-scoped", COMMANDS.filter((c) => c.id.startsWith("lv")).every((c) => c.scope === "lines"), true);
eq("defaults have no problem", COMMANDS.map((c) => bindProblem(c.id, DEFAULT_KEYBINDS[c.id], DEFAULT_KEYBINDS, false)).filter(Boolean), []);
eq("reserved still has copy/paste/undo", ["ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z", "ctrl+y", "ctrl+a", "ctrl+shift+z", "ctrl+d"].every((c) => RESERVED_COMBOS.has(c)), true);
// 10-29 (coordinator): tab moves are settings now
eq("tab moves no longer reserved", RESERVED_COMBOS.has("ctrl+tab") || RESERVED_COMBOS.has("ctrl+shift+tab"), false);
eq("next/prev tab commands", [DEFAULT_KEYBINDS.nextTab, DEFAULT_KEYBINDS.prevTab], ["ctrl+tab", "ctrl+shift+tab"]);
eq("tab commands are app scope", COMMANDS.filter((c) => c.id === "nextTab" || c.id === "prevTab").map((c) => c.scope), ["app", "app"]);
eq("defaultKeybinds(false) = DEFAULT_KEYBINDS", JSON.stringify(defaultKeybinds(false)) === JSON.stringify(DEFAULT_KEYBINDS), true);
const M = defaultKeybinds(true);
eq("mac: ⌃Tab + ⇧⌘]", M.nextTab, "ctrl+tab ctrl+shift+]");
eq("mac: ⌃⇧Tab + ⇧⌘[", M.prevTab, "ctrl+shift+tab ctrl+shift+[");
eq("mac: replace ⌥⌘F (⌘H = Hide)", M.replace, "ctrl+alt+f");
eq("mac: others as Windows", [M.save, M.find, M.findNext, M.lvEnd], ["ctrl+s", "ctrl+f", "f3", "end"]);
eq("mac defaults have no problem", COMMANDS.flatMap((c) => M[c.id].split(" ").map((k, i, a) => bindProblem(c.id, k, M, true, a.filter((_, j) => j !== i)))).filter(Boolean), []);
eq("win formatKeys two", formatKeys("ctrl+tab ctrl+shift+]", false), "Ctrl+Tab · Ctrl+Shift+]");
eq("mac formatKeys two", formatKeys("ctrl+tab ctrl+shift+]", true), "⌃Tab · ⇧⌘]");
eq("formatKeys none", formatKeys("", true), "없음");

// --- sessions from earlier builds ------------------------------------------------------------
eq("no blob → defaults", normalizeKeybinds(undefined), DEFAULT_KEYBINDS);
eq("garbage → defaults", normalizeKeybinds("x"), DEFAULT_KEYBINDS);
const v131 = { new: "ctrl+n", open: "ctrl+o", save: "ctrl+alt+s", saveAs: "ctrl+shift+s", close: "ctrl+w", find: "ctrl+f", replace: "ctrl+h", inClause: "ctrl+i", chips: "ctrl+p", resetZoom: "ctrl+0" };
const r131 = normalizeKeybinds(v131);
eq("v1.3.1 blob: remap kept", r131.save, "ctrl+alt+s");
eq("v1.3.1 blob: new commands get defaults", [r131.findNext, r131.lvEnd, r131.lvOpen], ["f3", "end", "enter"]);
eq("한글-era blob still read", normalizeKeybinds({ save: "ctrl+ㄴ" }).save, "ctrl+s");
eq("unknown ids dropped", Object.keys(normalizeKeybinds({ bogus: "ctrl+q" })).includes("bogus"), false);
eq("non-string dropped", normalizeKeybinds({ save: 5 }).save, "ctrl+s");
eq("explicit unbound kept", normalizeKeybinds({ chips: "" }).chips, "");
// a saved key that its command may not use (app scope needs a modifier) → its default
eq("saved bare F3 on an app command → default", (() => {
  const r = normalizeKeybinds({ inClause: "f3" });
  return [r.inClause, r.findNext];
})(), ["ctrl+i", "f3"]);
eq("mac-style find keys kept", (() => {
  const r = normalizeKeybinds({ findNext: "ctrl+g", findPrev: "ctrl+shift+g" });
  return [r.findNext, r.findPrev];
})(), ["ctrl+g", "ctrl+shift+g"]);
eq("two saved on one key across scopes: first kept, second back to its default", (() => {
  const r = normalizeKeybinds({ save: "ctrl+alt+e", lvEnd: "ctrl+alt+e" });
  return [r.save, r.lvEnd];
})(), ["ctrl+alt+e", "end"]);
eq("two saved commands on one key: first kept, second back to default", (() => {
  const r = normalizeKeybinds({ open: "ctrl+k", save: "ctrl+k" });
  return [r.open, r.save];
})(), ["ctrl+k", "ctrl+s"]);
eq("saved reserved key ignored", normalizeKeybinds({ save: "ctrl+c" }).save, "ctrl+s");
eq("saved lines key without shift", normalizeKeybinds({ lvEnd: "shift+ctrl+arrowdown" }).lvEnd, "end");
eq("saved lines key plain arrow refused", normalizeKeybinds({ lvTop: "arrowup" }).lvTop, "home");
eq("saved lines ⌘↑ ok", normalizeKeybinds({ lvTop: "ctrl+arrowup" }).lvTop, "ctrl+arrowup");
eq("a default that collides with a saved one becomes unbound", (() => {
  const r = normalizeKeybinds({ lvTop: "end" });
  return [r.lvTop, r.lvEnd];
})(), ["end", ""]);

// two keys per command (keybindings + keybindings2 in the session)
eq("second keys read", normalizeKeybinds({ nextTab: "ctrl+tab" }, false, { nextTab: "alt+]" }).nextTab, "ctrl+tab alt+]");
eq("second key alone ignored", normalizeKeybinds({}, false, { save: "ctrl+k" }).save, "ctrl+s");
eq("second key taken → dropped", normalizeKeybinds({ save: "ctrl+s", nextTab: "ctrl+tab" }, false, { nextTab: "ctrl+s" }).nextTab, "ctrl+tab");
eq("second key = first → dropped", normalizeKeybinds({ nextTab: "ctrl+tab" }, false, { nextTab: "ctrl+tab" }).nextTab, "ctrl+tab");
eq("v1.3.1 on mac: tab defaults", normalizeKeybinds(v131, true).nextTab, "ctrl+tab ctrl+shift+]");
eq("v1.3.1 on mac: saved ⌘H (Hide) → ⌥⌘F", normalizeKeybinds({ ...v131, replace: "ctrl+h" }, true).replace, "ctrl+alt+f");
eq("v1.3.1 on Windows: Ctrl+H kept", normalizeKeybinds({ ...v131, replace: "ctrl+h" }, false).replace, "ctrl+h");
eq("split for the session", splitKeybinds({ ...DEFAULT_KEYBINDS, nextTab: "ctrl+tab ctrl+shift+]", chips: "" }), [
  { ...DEFAULT_KEYBINDS, nextTab: "ctrl+tab", chips: "" },
  { nextTab: "ctrl+shift+]" },
]);
eq("split → normalize round trip (mac)", (() => {
  const [a, b] = splitKeybinds(M);
  return JSON.stringify(normalizeKeybinds(a, true, b)) === JSON.stringify(M);
})(), true);

// macOS keys the system or the app menu takes first
eq("mac ⌘Q refused", bindProblem("save", "ctrl+q", DEFAULT_KEYBINDS, true).includes("macOS"), true);
eq("mac ⌘H refused", bindProblem("open", "ctrl+h", { ...DEFAULT_KEYBINDS, replace: "" }, true).includes("macOS"), true);
eq("mac ⌘Space refused", bindProblem("save", "ctrl+space", DEFAULT_KEYBINDS, true) !== "", true);
eq("mac ⇧⌘4 refused", bindProblem("save", "ctrl+shift+4", DEFAULT_KEYBINDS, true) !== "", true);
eq("mac ⌘M refused", bindProblem("save", "ctrl+m", DEFAULT_KEYBINDS, true) !== "", true);
eq("Windows Ctrl+Q fine", bindProblem("save", "ctrl+q", DEFAULT_KEYBINDS, false), "");
eq("Windows Ctrl+M fine", bindProblem("save", "ctrl+m", DEFAULT_KEYBINDS, false), "");
eq("mac ⌘Tab event refused", macEventProblem(ev("Tab", "Tab", { meta: true }), true) !== "", true);
eq("mac ⌃Tab event fine", macEventProblem(ev("Tab", "Tab", { ctrl: true }), true), "");
eq("mac ⌃↑ (Mission Control) refused", macEventProblem(ev("ArrowUp", "ArrowUp", { ctrl: true }), true) !== "", true);
eq("mac ⌘↑ fine", macEventProblem(ev("ArrowUp", "ArrowUp", { meta: true }), true), "");
eq("Windows: no event check", macEventProblem(ev("Tab", "Tab", { meta: true }), false), "");
eq("own other key", bindProblem("nextTab", "ctrl+shift+]", M, true, ["ctrl+shift+]"]) !== "", true);
eq("other command's second key", bindProblem("save", "ctrl+shift+]", M, true).includes("다음 탭"), true);
eq("match second key", matchCommand(ev("}", "BracketRight", { meta: true, shift: true }), "app", M), "nextTab");
eq("match first key", matchCommand(ev("Tab", "Tab", { ctrl: true }), "app", M), "nextTab");
eq("match prev ⇧⌘[ (한글 mode same key)", matchCommand(ev("{", "BracketLeft", { meta: true, shift: true }), "app", M), "prevTab");

// --- capture + problems ----------------------------------------------------------------------
const B = { ...DEFAULT_KEYBINDS };
eq("capture app Ctrl+K", captureCombo("save", ev("k", "KeyK", { ctrl: true })), "ctrl+k");
eq("capture app ⌘K (mac)", captureCombo("save", ev("k", "KeyK", { meta: true })), "ctrl+k");
eq("capture IME ⌘ㅏ", captureCombo("save", ev("ㅏ", "KeyK", { meta: true })), "ctrl+k");
eq("capture lines strips Shift", captureCombo("lvEnd", ev("ArrowDown", "ArrowDown", { meta: true, shift: true })), "ctrl+arrowdown");
eq("capture modifier only → null", captureCombo("save", ev("Control", "ControlLeft", { ctrl: true })), null);
eq("app needs a modifier", bindProblem("save", "k", B, false) !== "", true);
eq("app needs a modifier (mac words)", bindProblem("save", "k", B, true).includes("⌘"), true);
eq("app needs a modifier (win words)", bindProblem("save", "k", B, false).includes("Ctrl"), true);
eq("app Ctrl+K ok", bindProblem("save", "ctrl+k", B, false), "");
eq("reserved refused", bindProblem("save", "ctrl+c", B, false).includes("Ctrl+C"), true);
eq("reserved refused (mac shows ⌘C)", bindProblem("save", "ctrl+c", B, true).includes("⌘C"), true);
eq("conflict names the other", bindProblem("save", "ctrl+o", B, false).includes("열기"), true);
eq("same key on itself is fine", bindProblem("save", "ctrl+s", B, false), "");
eq("find scope: bare F-key ok", bindProblem("findNext", "f4", B, false), "");
eq("find scope: ⌘G ok", bindProblem("findNext", "ctrl+g", B, false), "");
eq("find scope: bare letter refused", bindProblem("findNext", "g", B, false) !== "", true);
eq("find scope: bare Enter refused", bindProblem("findNext", "enter", B, false) !== "", true);
eq("lines: ⌘↑ ok", bindProblem("lvTop", "ctrl+arrowup", B, false), "");
eq("lines: bare arrow refused", bindProblem("lvTop", "arrowdown", B, false) !== "", true);
eq("lines: Esc refused", bindProblem("lvTop", "escape", B, false) !== "", true);
eq("lines: Ctrl+Home is fixed", bindProblem("lvTop", "ctrl+home", B, false) !== "", true);
eq("lines key occupies its Shift variant", bindProblem("save", "ctrl+shift+j", { ...B, lvEnd: "ctrl+j" }, false).includes("맨 끝"), true);
eq("Shift variant of a lines key taken by app key", bindProblem("lvTop", "ctrl+s", { ...B, save: "" }, false).includes("다른 이름"), true);
eq("lines vs lines", bindProblem("lvTop", "end", B, false).includes("맨 끝"), true);
eq("unbound never conflicts", bindProblem("save", "", { ...B, open: "" }, false), "");

// --- matching ----------------------------------------------------------------------------------
eq("app match", matchCommand(ev("s", "KeyS", { ctrl: true }), "app", B), "save");
eq("app match ⌘ + IME", matchCommand(ev("ㄴ", "KeyS", { meta: true }), "app", B), "save");
eq("app scope ignores lines keys", matchCommand(ev("End", "End"), "app", B), null);
eq("app scope ignores find keys", matchCommand(ev("F3", "F3"), "app", B), null);
eq("find scope", matchCommand(ev("F3", "F3", { shift: true }), "find", B), "findPrev");
eq("lines scope End", matchCommand(ev("End", "End"), "lines", B), "lvEnd");
eq("lines scope Shift+End (extend)", matchCommand(ev("End", "End", { shift: true }), "lines", B), "lvEnd");
eq("lines scope Enter", matchCommand(ev("Enter", "Enter"), "lines", B), "lvOpen");
const R = { ...B, lvEnd: "ctrl+j" };
eq("remapped lines key", matchCommand(ev("j", "KeyJ", { ctrl: true }), "lines", R), "lvEnd");
eq("remapped lines key, 한글 IME", matchCommand(ev("ㅓ", "KeyJ", { ctrl: true }), "lines", R), "lvEnd");
eq("old key off after remap", matchCommand(ev("End", "End"), "lines", R), null);
eq("unbound never matches", matchCommand(ev("End", "End"), "lines", { ...B, lvEnd: "" }), null);

// --- wheel zoom -----------------------------------------------------------------------------------
const w = (m: { ctrl?: boolean; meta?: boolean }) => ({ ctrlKey: !!m.ctrl, metaKey: !!m.meta });
eq("modes", WHEEL_ZOOMS, ["both", "ctrl", "meta"]);
eq("both: ctrl", isZoomWheel(w({ ctrl: true }), "both"), true);
eq("both: ⌘", isZoomWheel(w({ meta: true }), "both"), true);
eq("both: none", isZoomWheel(w({}), "both"), false);
eq("ctrl only: ⌘ no", isZoomWheel(w({ meta: true }), "ctrl"), false);
eq("ctrl only: ctrl yes", isZoomWheel(w({ ctrl: true }), "ctrl"), true);
eq("meta only: ctrl no", isZoomWheel(w({ ctrl: true }), "meta"), false);
eq("meta only: ⌘ yes", isZoomWheel(w({ meta: true }), "meta"), true);
eq("old session → both", normalizeWheelZoom(undefined), "both");
eq("bad value → both", normalizeWheelZoom("x"), "both");
eq("kept", normalizeWheelZoom("meta"), "meta");

console.log(`keybinds-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
