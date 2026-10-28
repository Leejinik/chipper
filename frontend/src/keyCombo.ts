// Shortcut key names that do not depend on the input language.
//
// With a Korean IME on, KeyboardEvent.key for Ctrl+S is "ㄴ" (WebKit on macOS,
// and Windows when the IME is in 한글 mode), so a shortcut recorded that way was
// stored as "ctrl+ㄴ" and the default "ctrl+s" stopped firing in 한글 mode. Letters
// and digits are therefore named by their physical key (KeyboardEvent.code).

// 두벌식 jamo → the Latin key it sits on (shifted jamo map to the same key).
const JAMO_KEY: Record<string, string> = {
  ㅂ: "q", ㅈ: "w", ㄷ: "e", ㄱ: "r", ㅅ: "t", ㅛ: "y", ㅕ: "u", ㅑ: "i", ㅐ: "o", ㅔ: "p",
  ㅁ: "a", ㄴ: "s", ㅇ: "d", ㄹ: "f", ㅎ: "g", ㅗ: "h", ㅓ: "j", ㅏ: "k", ㅣ: "l",
  ㅋ: "z", ㅌ: "x", ㅊ: "c", ㅍ: "v", ㅠ: "b", ㅜ: "n", ㅡ: "m",
  ㅃ: "q", ㅉ: "w", ㄸ: "e", ㄲ: "r", ㅆ: "t", ㅒ: "o", ㅖ: "p",
};

// Lower-case key name for a combo: the physical letter/digit when the event
// says which key it was, else the (lower-cased) key value, with a lone jamo
// mapped back to its Latin key.
export function comboKey(e: { key: string; code?: string }): string {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const key = e.key.toLowerCase();
  return JAMO_KEY[key] ?? key;
}

// A stored combo with its key part de-Koreanized ("ctrl+ㄴ" → "ctrl+s"), so
// bindings saved by earlier builds keep working and show as Ctrl+S.
export function normalizeCombo(combo: string): string {
  const parts = combo.split("+");
  const last = parts[parts.length - 1];
  if (JAMO_KEY[last]) parts[parts.length - 1] = JAMO_KEY[last];
  return parts.join("+");
}
