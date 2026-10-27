// JavaScript regex source → RE2 (Go regexp / re2js) source with the same
// meaning on one log line.
//
// This is a line-for-line port of translateJS in the Go line filter
// (internal/linefilter/rules.go, stage 1). Both sides must agree: the editor
// colours a rule with re2js on the translated source, and the "태그 줄만 보기"
// filter runs Go's RE2 on the same translation — so a line is coloured exactly
// when the filter keeps it. tests/translate-go.json holds the Go output for a
// corpus of patterns (tests/gen-translate-corpus.cjs); tests/tags-unit.ts
// checks this port against it.
//
// Rule patterns are written in JavaScript syntax (as in v1.2.0) and compiled
// as the editor always did: flags "g" or "gi", no u/m/s. Case-insensitivity is
// written out as explicit classes of JavaScript case partners (JS folding is
// not RE2's (?i): "k" does not match the Kelvin sign U+212A in JS).
// `reason` is non-empty when RE2 cannot express the pattern (look-ahead,
// look-behind, back-references, …).

export interface Translation {
  out: string;
  reason: string;
}

// ---- JavaScript case folding (ECMAScript Canonicalize, non-u mode) -----------

// Canonicalize(ch): toUpperCase(ch) unless that is not one code unit, or maps
// a non-ASCII character to ASCII. Uses the running engine's own tables, so it
// is exactly what the editor's /…/i regexes do.
function jsCanon(cp: number): number {
  if (cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) return cp;
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp;
  const u = String.fromCharCode(cp).toUpperCase();
  if (u.length !== 1) return cp;
  const uc = u.charCodeAt(0);
  return uc < 0x80 ? cp : uc;
}

let foldClass: Map<number, number[]> | null = null; // canonical → members (≥ 2), sorted
let cased: number[] = []; // sorted: characters with at least one other equivalent

function foldInit() {
  if (foldClass) return;
  const cls = new Map<number, number[]>();
  for (let r = 0; r <= 0xffff; r++) {
    if (r >= 0xd800 && r <= 0xdfff) continue;
    const c = jsCanon(r);
    if (c !== r) {
      const a = cls.get(c);
      if (a) a.push(r);
      else cls.set(c, [r]);
    }
  }
  foldClass = new Map();
  for (const [c, ms0] of cls) {
    const ms = jsCanon(c) === c ? [...ms0, c] : ms0;
    if (ms.length < 2) continue;
    ms.sort((a, b) => a - b);
    foldClass.set(c, ms);
    cased.push(...ms);
  }
  cased.sort((a, b) => a - b);
}

// Every character equal to r under JS case-insensitive matching (r included).
export function jsEquiv(r: number): number[] {
  if (r < 0x80) {
    // ASCII letters fold only with each other (a non-ASCII character never
    // canonicalizes to ASCII), so skip building the table.
    if (r >= 0x41 && r <= 0x5a) return [r, r + 0x20];
    if (r >= 0x61 && r <= 0x7a) return [r - 0x20, r];
    return [r];
  }
  foldInit();
  const ms = foldClass!.get(jsCanon(r));
  if (ms && ms.includes(r)) return ms;
  return [r];
}

function foldExtras(dst: number[], lo: number, hi: number): number[] {
  if (hi < 0x80) {
    for (let r = Math.max(lo, 0x41); r <= hi; r++) if ((r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a)) dst.push(...jsEquiv(r));
    return dst;
  }
  foldInit();
  let i = 0;
  let j = cased.length;
  while (i < j) {
    const m = (i + j) >> 1;
    if (cased[m] < lo) i = m + 1;
    else j = m;
  }
  for (; i < cased.length && cased[i] <= hi; i++) dst.push(...jsEquiv(cased[i]));
  return dst;
}

// ---- writing RE2 source ------------------------------------------------------

const JS_SPACE: [number, number][] = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const MAX_RUNE = 0x10ffff;
const hex = (r: number) => r.toString(16);
function rangesClassBody(rs: [number, number][]): string {
  let b = "";
  for (const [lo, hi] of rs) b += lo === hi ? `\\x{${hex(lo)}}` : `\\x{${hex(lo)}}-\\x{${hex(hi)}}`;
  return b;
}
function complementRanges(rs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of rs) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_RUNE) out.push([next, MAX_RUNE]);
  return out;
}
const SPACE_BODY = rangesClassBody(JS_SPACE);
const NON_SPACE_BODY = rangesClassBody(complementRanges(JS_SPACE));

const isHex = (c: string | undefined) => !!c && /^[0-9a-fA-F]$/.test(c);
const isASCIIAlnum = (r: number) => (r >= 0x30 && r <= 0x39) || (r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a);
const GRAPHIC = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u; // Go unicode.IsGraphic
const SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/; // Go unicode.IsSpace
const plainNonASCII = (r: number) => {
  if (r < 0x80) return false;
  const s = String.fromCodePoint(r);
  return GRAPHIC.test(s) && !SPACE.test(s);
};

function litRune(r: number): string {
  if (isASCIIAlnum(r) || r === 0x5f || plainNonASCII(r)) return String.fromCodePoint(r);
  return `\\x{${hex(r)}}`;
}
function classRune(r: number): string {
  if (isASCIIAlnum(r) || plainNonASCII(r)) return String.fromCodePoint(r);
  return `\\x{${hex(r)}}`;
}
function foldChar(r: number, ci: boolean): string {
  if (ci) {
    const eq = jsEquiv(r);
    if (eq.length > 1) return "[" + eq.map(classRune).join("") + "]";
  }
  return litRune(r);
}

// The RE2 source for the literal text s (case-insensitive the JS way when ci).
export function jsQuote(s: string, ci: boolean): string {
  let b = "";
  for (const ch of s) b += foldChar(ch.codePointAt(0)!, ci);
  return b;
}

// ---- the translator ------------------------------------------------------------

interface Atom {
  char: number;
  isClass?: boolean;
  inner?: string; // class escape text inside a class
  outer?: string; // … outside a class
  assert?: string; // \b \B outside a class
}

const cp = (s: string) => s.codePointAt(0)!;

class Translator {
  rs: string[];
  n: number;
  i = 0;
  b = "";
  hasNamed: boolean;
  ci: boolean;
  dot = false;
  stack: [boolean, boolean][] = [];
  names = new Set<string>();
  constructor(src: string, ci: boolean) {
    this.rs = Array.from(src);
    this.n = this.rs.length;
    this.ci = ci;
    this.hasNamed = src.replaceAll("(?<=", "").replaceAll("(?<!", "").includes("(?<");
  }

  // "\X" at this.i → [atom, reason]
  escape(inClass: boolean): [Atom, string] {
    const { rs, n } = this;
    if (this.i + 1 >= n) return [{ char: 0 }, "정규식 끝에 \\ 가 홀로 있습니다"];
    const c = rs[this.i + 1];
    this.i += 2;
    let i = this.i;
    switch (c) {
      case "d":
      case "D":
      case "w":
      case "W":
        return [{ char: 0, isClass: true, inner: "\\" + c, outer: "\\" + c }, ""];
      case "s":
        return [{ char: 0, isClass: true, inner: SPACE_BODY, outer: "[" + SPACE_BODY + "]" }, ""];
      case "S":
        return [{ char: 0, isClass: true, inner: NON_SPACE_BODY, outer: "[" + NON_SPACE_BODY + "]" }, ""];
      case "b":
        return inClass ? [{ char: 8 }, ""] : [{ char: 0, assert: "\\b" }, ""];
      case "B":
        return inClass ? [{ char: cp("B") }, ""] : [{ char: 0, assert: "\\B" }, ""];
      case "f":
        return [{ char: 0x0c }, ""];
      case "n":
        return [{ char: 0x0a }, ""];
      case "r":
        return [{ char: 0x0d }, ""];
      case "t":
        return [{ char: 0x09 }, ""];
      case "v":
        return [{ char: 0x0b }, ""];
      case "0":
        if (i < n && rs[i] >= "0" && rs[i] <= "9") return [{ char: 0 }, `8진수 이스케이프(\\0${rs[i]}…)는 지원하지 않습니다`];
        return [{ char: 0 }, ""];
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        if (inClass) return [{ char: 0 }, `글자 묶음 안의 8진수 이스케이프(\\${c})는 지원하지 않습니다`];
        return [{ char: 0 }, `역참조 \\${c} 는 Go(RE2) 정규식에서 지원하지 않습니다`];
      case "k":
        if (this.hasNamed) return [{ char: 0 }, "이름 역참조 \\k<…> 는 Go(RE2) 정규식에서 지원하지 않습니다"];
        return [{ char: cp("k") }, ""];
      case "x":
        if (i + 1 < n && isHex(rs[i]) && isHex(rs[i + 1])) {
          const v = parseInt(rs[i] + rs[i + 1], 16);
          this.i += 2;
          return [{ char: v }, ""];
        }
        return [{ char: cp("x") }, ""];
      case "u":
        if (i + 3 < n && isHex(rs[i]) && isHex(rs[i + 1]) && isHex(rs[i + 2]) && isHex(rs[i + 3])) {
          const v = parseInt(rs.slice(i, i + 4).join(""), 16);
          this.i += 4;
          i = this.i;
          const sur = () => [{ char: 0 }, `짝 없는 서러게이트 \\u${v.toString(16).toUpperCase().padStart(4, "0")} 는 지원하지 않습니다`] as [Atom, string];
          if (v >= 0xd800 && v <= 0xdbff) {
            if (i + 5 < n && rs[i] === "\\" && rs[i + 1] === "u" && isHex(rs[i + 2]) && isHex(rs[i + 3]) && isHex(rs[i + 4]) && isHex(rs[i + 5])) {
              const lo = parseInt(rs.slice(i + 2, i + 6).join(""), 16);
              if (lo >= 0xdc00 && lo <= 0xdfff) {
                this.i += 6;
                return [{ char: 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00) }, ""];
              }
            }
            return sur();
          }
          if (v >= 0xdc00 && v <= 0xdfff) return sur();
          return [{ char: v }, ""];
        }
        if (i < n && rs[i] === "{") return [{ char: 0 }, "\\u{…} 표기는 지원하지 않습니다 (\\uXXXX 를 쓰세요)"];
        return [{ char: cp("u") }, ""];
      case "c": {
        const x = rs[i];
        if (i < n && /^[a-zA-Z]$/.test(x)) {
          this.i++;
          return [{ char: cp(x) % 32 }, ""];
        }
        if (inClass && i < n && /^[0-9_]$/.test(x)) {
          this.i++;
          return [{ char: cp(x) % 32 }, ""];
        }
        // Annex B: a lone "\c" is a backslash; the "c" is read again as itself.
        this.i--;
        return [{ char: 0x5c }, ""];
      }
    }
    return [{ char: cp(c) }, ""]; // identity escape (\e = "e", \/ = "/", \가 = "가")
  }

  run(): string {
    const { rs, n } = this;
    let depth = 0;
    let lastAtom = false; // a quantifier may follow (for "{" handling)
    while (this.i < n) {
      const c = rs[this.i];
      switch (c) {
        case "\\": {
          const [a, why] = this.escape(false);
          if (why) return why;
          if (a.assert) this.b += a.assert;
          else if (a.isClass) this.b += a.outer;
          else this.b += foldChar(a.char, this.ci);
          lastAtom = true;
          continue;
        }
        case "(": {
          this.stack.push([this.ci, this.dot]);
          if (this.i + 1 < n && rs[this.i + 1] === "?") {
            const rest = rs.slice(this.i + 2).join("");
            if (rest.startsWith(":")) {
              this.b += "(?:";
              this.i += 3;
            } else if (rest.startsWith("=") || rest.startsWith("!")) {
              return "앞보기 (?= / (?! 는 Go(RE2) 정규식에서 지원하지 않습니다";
            } else if (rest.startsWith("<=") || rest.startsWith("<!")) {
              return "뒤돌아보기 (?<= / (?<! 는 Go(RE2) 정규식에서 지원하지 않습니다";
            } else if (rest.startsWith("<")) {
              const end = rest.indexOf(">");
              if (end < 0) return "이름 그룹 (?<이름> 이 닫히지 않았습니다";
              // Names are irrelevant here (no back-references), but JS refuses
              // a name used twice.
              const name = rest.slice(1, end);
              if (this.names.has(name)) return "같은 이름의 그룹이 두 번 있습니다 (" + name + ")";
              this.names.add(name);
              this.b += "(?:";
              this.i += 2 + Array.from(rest.slice(0, end + 1)).length;
            } else {
              // JS modifiers: (?ims-ims:...)
              let j = this.i + 2;
              let on = "";
              let off = "";
              let neg = false;
              const seen = new Set<string>();
              while (j < n && (rs[j] === "i" || rs[j] === "m" || rs[j] === "s" || (rs[j] === "-" && !neg))) {
                if (rs[j] === "-") neg = true;
                else {
                  if (seen.has(rs[j])) return "그룹 표기 (? 에 같은 글자가 두 번 있습니다";
                  seen.add(rs[j]);
                  if (neg) off += rs[j];
                  else on += rs[j];
                }
                j++;
              }
              if (j >= n || rs[j] !== ":" || (on === "" && off === "")) return "알 수 없는 그룹 표기 (? 입니다";
              if (on.includes("i")) this.ci = true;
              if (off.includes("i")) this.ci = false;
              if (on.includes("s")) this.dot = true;
              if (off.includes("s")) this.dot = false;
              this.b += "(?:";
              this.i = j + 1;
            }
          } else {
            this.b += "(";
            this.i++;
          }
          depth++;
          lastAtom = false;
          continue;
        }
        case ")": {
          if (depth === 0) return "괄호 짝이 맞지 않습니다";
          depth--;
          const top = this.stack.pop()!;
          [this.ci, this.dot] = top;
          this.b += ")";
          this.i++;
          lastAtom = true;
          continue;
        }
        case "[": {
          const why = this.cls();
          if (why) return why;
          lastAtom = true;
          continue;
        }
        case ".":
          this.b += this.dot ? "[\\x00-\\x{10ffff}]" : "[^\\n\\r\\x{2028}\\x{2029}]";
          this.i++;
          lastAtom = true;
          continue;
        case "{": {
          // A valid quantifier after an atom passes through; anything else is
          // a literal brace in JS (Annex B).
          let j = this.i + 1;
          while (j < n && rs[j] >= "0" && rs[j] <= "9") j++;
          const valid = j > this.i + 1;
          if (valid && j < n && rs[j] === ",") {
            j++;
            while (j < n && rs[j] >= "0" && rs[j] <= "9") j++;
          }
          if (valid && j < n && rs[j] === "}" && lastAtom) {
            this.b += rs.slice(this.i, j + 1).join("");
            this.i = j + 1;
            if (this.i < n && rs[this.i] === "?") {
              this.b += "?";
              this.i++;
            }
            lastAtom = false;
            continue;
          }
          this.b += litRune(0x7b);
          this.i++;
          lastAtom = true;
          continue;
        }
        case "*":
        case "+":
        case "?":
          this.b += c;
          this.i++;
          if (this.i < n && rs[this.i] === "?") {
            this.b += "?";
            this.i++;
          }
          lastAtom = false;
          continue;
        case "|":
          this.b += "|";
          this.i++;
          lastAtom = false;
          continue;
        case "^":
        case "$":
          this.b += c;
          this.i++;
          lastAtom = false;
          continue;
      }
      this.b += foldChar(cp(c), this.ci);
      this.i++;
      lastAtom = true;
    }
    if (depth !== 0) return "괄호 짝이 맞지 않습니다";
    return "";
  }

  // a JS character class at this.i ('[')
  cls(): string {
    const { rs, n } = this;
    // JS: "[]" never matches, "[^]" matches anything.
    if (this.i + 1 < n && rs[this.i + 1] === "]") {
      this.b += "[^\\x00-\\x{10ffff}]";
      this.i += 2;
      return "";
    }
    if (this.i + 2 < n && rs[this.i + 1] === "^" && rs[this.i + 2] === "]") {
      this.b += "[\\x00-\\x{10ffff}]";
      this.i += 3;
      return "";
    }
    this.i++;
    let neg = false;
    if (this.i < n && rs[this.i] === "^") {
      neg = true;
      this.i++;
    }
    let body = "";
    let extra: number[] = [];
    const addChar = (r: number) => {
      body += classRune(r);
      if (this.ci) extra.push(...jsEquiv(r));
    };
    const atom = (): [Atom, string] => {
      if (rs[this.i] === "\\") return this.escape(true);
      const r = cp(rs[this.i]);
      this.i++;
      return [{ char: r }, ""];
    };
    for (;;) {
      if (this.i >= n) return "글자 묶음 [ 이 닫히지 않았습니다";
      if (rs[this.i] === "]") {
        this.i++;
        break;
      }
      const [a, why] = atom();
      if (why) return why;
      if (this.i + 1 < n && rs[this.i] === "-" && rs[this.i + 1] !== "]") {
        this.i++; // '-'
        const [b, why2] = atom();
        if (why2) return why2;
        if (!a.isClass && !b.isClass) {
          if (a.char > b.char)
            return "글자 범위의 순서가 잘못되었습니다 (" + String.fromCodePoint(a.char) + "-" + String.fromCodePoint(b.char) + ")";
          body += classRune(a.char) + "-" + classRune(b.char);
          if (this.ci) extra = foldExtras(extra, a.char, b.char);
          continue;
        }
        // Annex B: a class escape next to "-" is a union with a literal "-".
        for (const x of [a, { char: 0x2d } as Atom, b]) {
          if (x.isClass) body += x.inner;
          else addChar(x.char);
        }
        continue;
      }
      if (a.isClass) body += a.inner;
      else addChar(a.char);
    }
    this.b += "[" + (neg ? "^" : "") + body;
    if (extra.length) {
      extra.sort((x, y) => x - y);
      for (let k = 0; k < extra.length; ) {
        const lo = extra[k];
        let hi = lo;
        k++;
        while (k < extra.length && extra[k] <= hi + 1) {
          if (extra[k] > hi) hi = extra[k];
          k++;
        }
        this.b += classRune(lo);
        if (hi > lo) this.b += "-" + classRune(hi);
      }
    }
    this.b += "]";
    return "";
  }
}

// translateJS(src, ci): the RE2 source, or the reason RE2 cannot express it.
export function translateJS(src: string, ci: boolean): Translation {
  const t = new Translator(src, ci);
  const why = t.run();
  return why ? { out: "", reason: why } : { out: t.b, reason: "" };
}
