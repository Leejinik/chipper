// Multi view 「같이 움직임」 (syncNav.ts) knows the macOS ⌘ + arrow keys (user 10-29):
// ⌘←/⌘→ = line start/end, ⌘↑/⌘↓ = document start/end, as CodeMirror does there.
import {
  cursorDocEnd,
  cursorDocStart,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  cursorLineDown,
  cursorPageDown,
  selectDocEnd,
  selectDocStart,
  selectLineBoundaryLeft,
  selectLineBoundaryRight,
  selectLineDown,
} from "@codemirror/commands";
import { syncedNavCommand } from "../src/syncNav";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${(got as any)?.name ?? got}, want ${(want as any)?.name ?? want}`);
  }
}
const k = (key: string, m: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ key, ctrlKey: !!m.ctrl, metaKey: !!m.meta, altKey: !!m.alt, shiftKey: !!m.shift }) as KeyboardEvent;

// unchanged everywhere
eq("PageDown", syncedNavCommand(k("PageDown")), cursorPageDown);
eq("ArrowDown", syncedNavCommand(k("ArrowDown"), true), cursorLineDown);
eq("Shift+ArrowDown", syncedNavCommand(k("ArrowDown", { shift: true }), true), selectLineDown);
eq("Home", syncedNavCommand(k("Home")), cursorLineBoundaryBackward);
eq("End (mac)", syncedNavCommand(k("End"), true), cursorLineBoundaryForward);
eq("Ctrl+Home", syncedNavCommand(k("Home", { ctrl: true })), cursorDocStart);
eq("Ctrl+End (mac)", syncedNavCommand(k("End", { ctrl: true }), true), cursorDocEnd);
// macOS ⌘ + arrows
eq("mac ⌘↑", syncedNavCommand(k("ArrowUp", { meta: true }), true), cursorDocStart);
eq("mac ⌘↓", syncedNavCommand(k("ArrowDown", { meta: true }), true), cursorDocEnd);
eq("mac ⇧⌘↑", syncedNavCommand(k("ArrowUp", { meta: true, shift: true }), true), selectDocStart);
eq("mac ⇧⌘↓", syncedNavCommand(k("ArrowDown", { meta: true, shift: true }), true), selectDocEnd);
eq("mac ⌘←", syncedNavCommand(k("ArrowLeft", { meta: true }), true), cursorLineBoundaryLeft);
eq("mac ⌘→", syncedNavCommand(k("ArrowRight", { meta: true }), true), cursorLineBoundaryRight);
eq("mac ⇧⌘←", syncedNavCommand(k("ArrowLeft", { meta: true, shift: true }), true), selectLineBoundaryLeft);
eq("mac ⇧⌘→", syncedNavCommand(k("ArrowRight", { meta: true, shift: true }), true), selectLineBoundaryRight);
// not synced
eq("mac ⌘PageDown", syncedNavCommand(k("PageDown", { meta: true }), true), null);
eq("mac ⌥⌘↑", syncedNavCommand(k("ArrowUp", { meta: true, alt: true }), true), null);
eq("Windows: Win+↑ not synced", syncedNavCommand(k("ArrowUp", { meta: true }), false), null);
eq("Windows default arg", syncedNavCommand(k("ArrowUp", { meta: true })), null);
eq("Alt+↓", syncedNavCommand(k("ArrowDown", { alt: true }), true), null);
eq("mac ⌃⌘↑ not synced", syncedNavCommand(k("ArrowUp", { meta: true, ctrl: true }), true), null);

console.log(`syncnav-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
