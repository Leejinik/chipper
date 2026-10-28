import { Text } from "@codemirror/state";

// A big file read for the editor in pieces (EditOpenChunk, 4MB each) becomes
// the editor's document without first being joined into one string: a 99MB
// string needs 99MB in one piece of the window's JS memory (and joining makes
// the pieces garbage at once). On the test PC (.18, 10-29) 99MB×7 ✏️ ↔ 📖
// killed the window (「Out of Memory」) with most of the memory being garbage
// the engine had not collected.

// The lines of parts.join(""), split as the editor splits a string (CRLF, CR,
// LF), without joining them. A CRLF may be cut between two parts.
export function linesOfParts(parts: string[]): string[] {
  const out: string[] = [];
  let carry = "";
  let cr = false; // the previous part ended in \r: a \n opening this one is the same break
  for (let p of parts) {
    if (!p) continue;
    if (cr && p.charCodeAt(0) === 10) p = p.slice(1);
    cr = p.length > 0 && p.charCodeAt(p.length - 1) === 13;
    const ls = p.split(/\r\n?|\n/);
    ls[0] = carry + ls[0];
    carry = ls.pop() as string;
    for (const l of ls) out.push(l);
  }
  out.push(carry);
  return out;
}

export const textOfParts = (parts: string[]): Text => Text.of(linesOfParts(parts));

// parts.join("") kept as pieces (a rope: the engine joins it only when someone
// reads it whole — a save, not the editor).
export function ropeOf(parts: string[]): string {
  let s = "";
  for (const p of parts) s += p;
  return s;
}
