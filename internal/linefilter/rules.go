// Package linefilter is the "태그 줄만 보기" engine: it reads a log file straight
// from disk and keeps only the lines a rule matches, plus N lines above/below.
// The whole file is never loaded; work is split into line-aligned chunks that
// are scanned in parallel, and the hit list is cached so changing N re-reads
// only the lines around the hits.
//
// Line numbers follow CodeMirror: "\r\n", a lone "\r" and "\n" each end one
// line, and a file always has (line breaks + 1) lines.
package linefilter

import (
	"bytes"
	"fmt"
	"regexp"
	"regexp/syntax"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Rule is the filter's view of a frontend LogRule (frontend/src/logHighlight.ts).
// A LogRule object can be passed as-is: unknown fields (label, color, line) are
// ignored, and a rule without "kind" keeps the old meaning of the regex flag.
type Rule struct {
	ID            string `json:"id,omitempty"`
	Kind          string `json:"kind,omitempty"` // "text" | "word" | "regex"; "" → regex ? "regex" : "word"
	Pattern       string `json:"pattern"`
	Regex         bool   `json:"regex,omitempty"`
	CaseSensitive bool   `json:"caseSensitive"`
	On            *bool  `json:"on,omitempty"` // nil = on
	// Filter is the rule's "줄만 보기에 씀" flag (stage 3): false = the filter
	// skips it like a disabled rule; nil = used.
	Filter *bool `json:"filter,omitempty"`
}

// RuleIssue says why one rule cannot be used by the filter. The other rules
// keep working.
type RuleIssue struct {
	Index  int    `json:"index"` // position in the request's Rules
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"` // Korean, shown to the user
}

const (
	kindText = iota
	kindWord
	kindRegex
)

// MaxActiveRules is the number of enabled rules one filter can use (hit masks
// are a uint64).
const MaxActiveRules = 64

func (r Rule) kind() int {
	switch r.Kind {
	case "text":
		return kindText
	case "word":
		return kindWord
	case "regex":
		return kindRegex
	}
	if r.Regex {
		return kindRegex
	}
	return kindWord
}

func (r Rule) enabled() bool {
	return (r.On == nil || *r.On) && (r.Filter == nil || *r.Filter)
}

// lit is a byte string every match must contain. fold = compare after ASCII
// lower-casing (s is already lower-case then). Never contains '\r' or '\n'.
type lit struct {
	s    []byte
	fold bool
}

// compiledRule is one enabled, usable rule.
type compiledRule struct {
	index int // index in the request's Rules
	bit   uint64
	// litOnly: a text/word rule whose case folding is plain ASCII lower-casing.
	// An occurrence of needle (with ASCII word boundaries for word rules) is a
	// hit by itself and its position is the match position.
	litOnly bool
	needle  []byte
	fold    bool
	word    bool
	// lits: litOnly → {needle}; otherwise a prefilter (a line with none of them
	// cannot match), or none with unfiltered = the rule runs on every line.
	lits       []lit
	unfiltered bool
	// emptyToo: the regex can also match the empty string somewhere (e.g. \bx?).
	// The editor only colours non-empty matches, so these lines are confirmed
	// with the standard library (slow but exact; such rules are rare).
	emptyToo bool
	// lineSrc decides one line on its own for every kind (Go syntax, no (?i), no
	// '\r'/'\n'); the DFAs and the fallback lineRe run it.
	lineSrc string
	lineRe  *regexp.Regexp
	// dfaSrc is what the DFAs run: lineSrc, or for emptyToo rules only its
	// non-empty matches (a prefilter the stdlib then confirms).
	dfaSrc string
	// wordStart: for a word rule outside the literal path, the regexp that tells
	// whether the core pattern starts right at the beginning of the line.
	wordStart *regexp.Regexp
}

// Validate reports the rules the filter cannot use. Disabled and empty rules are
// skipped silently (the editor ignores them too).
func Validate(rules []Rule) []RuleIssue {
	_, issues := compileRules(rules)
	return issues
}

func compileRules(rules []Rule) ([]compiledRule, []RuleIssue) {
	var out []compiledRule
	var issues []RuleIssue
	for i, r := range rules {
		if !r.enabled() || r.Pattern == "" {
			continue
		}
		cr, reason := compileOne(r)
		if reason != "" {
			issues = append(issues, RuleIssue{Index: i, ID: r.ID, Reason: issuePrefix + reason})
			continue
		}
		if len(out) >= MaxActiveRules {
			issues = append(issues, RuleIssue{Index: i, ID: r.ID, Reason: fmt.Sprintf(issuePrefix+"켜진 규칙은 %d개까지만 씁니다", MaxActiveRules)})
			continue
		}
		cr.index = i
		cr.bit = 1 << uint(len(out))
		out = append(out, cr)
	}
	return out, issues
}

const issuePrefix = "줄만 보기에서 쓸 수 없음: "

const wordBefore, wordAfter = `(?:^|[^0-9A-Za-z_])`, `(?:[^0-9A-Za-z_]|$)`

func compileOne(r Rule) (compiledRule, string) {
	k := r.kind()
	cr := compiledRule{}
	ci := !r.CaseSensitive
	var goSrc string
	if k != kindRegex {
		if strings.ContainsAny(r.Pattern, "\r\n") {
			return cr, "줄바꿈이 들어 있어 어느 줄에도 걸리지 않습니다"
		}
		core := jsQuote(r.Pattern, ci)
		goSrc = core
		if k == kindWord {
			// JS: (?<![\w])pat(?![\w]). For "does this line match" consuming the
			// neighbour is equivalent, and RE2 has no look-around.
			goSrc = wordBefore + core + wordAfter
		}
		// A broken byte shows (and matches) as U+FFFD but is not stored as its
		// UTF-8 bytes, so a pattern with U+FFFD cannot be a byte search.
		if (!ci || jsFoldTrivial(r.Pattern)) && !strings.ContainsRune(r.Pattern, utf8.RuneError) {
			needle := []byte(r.Pattern)
			if ci {
				needle = asciiLower(needle)
			}
			cr.litOnly, cr.needle, cr.fold, cr.word = true, needle, ci, k == kindWord
			cr.lits = []lit{{s: needle, fold: ci}}
		} else if k == kindWord {
			cr.wordStart = regexp.MustCompile(`^(?:` + core + `)` + wordAfter)
		}
	} else {
		src, why := translateJS(r.Pattern, ci)
		if why != "" {
			return cr, why
		}
		goSrc = src
	}
	re, err := regexp.Compile(goSrc)
	if err != nil {
		return cr, goErrorReason(err)
	}
	if k == kindRegex && re.MatchString("") {
		// The editor refuses these too (compileRule: re.test("") → invalid).
		return cr, "빈 글자에도 걸리는 정규식입니다"
	}
	ast, err := syntax.Parse(goSrc, syntax.Perl)
	if err != nil {
		return cr, goErrorReason(err)
	}
	before := analyze(ast)
	ast = stripNL(ast)
	info := analyze(ast)
	switch {
	case !before.matchable:
		return cr, "어떤 글자에도 걸리지 않는 정규식입니다"
	case !info.matchable:
		return cr, "줄바꿈이 꼭 들어가야 하는 정규식이라 어느 줄에도 걸리지 않습니다"
	case !info.consumes:
		return cr, `빈 일치만 나는 정규식이라 줄을 고를 수 없습니다 (예: \b, ^, $ 만 있는 식)`
	}
	cr.emptyToo = info.minLen == 0
	// The line regex is the translated source as is: '\r'/'\n' never occur in a
	// line, so what stripNL removed cannot match anyway, and printing a tree
	// back to text (syntax.Regexp.String) is very slow for big classes. The
	// stripped tree only feeds the analysis above and the prefilter below.
	simp := ast.Simplify()
	cr.lineSrc, cr.lineRe, cr.dfaSrc = goSrc, re, goSrc
	if cr.emptyToo {
		if ne := nonEmpty(simp); ne != nil {
			src := ne.String()
			if _, err := regexp.Compile(src); err == nil {
				cr.dfaSrc = src
			}
		}
	}
	if !cr.litOnly {
		lits, ok := requiredLits(simp)
		lits = dropBreakLits(lits)
		if !ok || len(lits) == 0 || len(lits) > 64 || minLitLen(lits) < 2 {
			cr.unfiltered = true
		} else {
			cr.lits = dedupLits(lits)
		}
	}
	return cr, ""
}

func goErrorReason(err error) string {
	se, ok := err.(*syntax.Error)
	if !ok {
		return "정규식을 해석할 수 없습니다"
	}
	var why string
	switch se.Code {
	case syntax.ErrInvalidCharClass:
		why = "잘못된 글자 묶음입니다"
	case syntax.ErrInvalidCharRange:
		why = "글자 범위가 잘못되었습니다"
	case syntax.ErrInvalidEscape:
		why = "잘못된 이스케이프입니다"
	case syntax.ErrInvalidNamedCapture:
		why = "잘못된 이름 그룹입니다"
	case syntax.ErrInvalidPerlOp:
		why = "알 수 없는 그룹 표기 (? 입니다"
	case syntax.ErrInvalidRepeatOp:
		why = "반복 기호를 잘못 썼습니다"
	case syntax.ErrInvalidRepeatSize:
		why = "반복 횟수는 1000 이하만 됩니다"
	case syntax.ErrInvalidUTF8:
		why = "잘못된 UTF-8 글자가 있습니다"
	case syntax.ErrMissingBracket:
		why = "글자 묶음 [ 이 닫히지 않았습니다"
	case syntax.ErrMissingParen, syntax.ErrUnexpectedParen:
		why = "괄호 짝이 맞지 않습니다"
	case syntax.ErrMissingRepeatArgument:
		why = "반복할 대상이 없습니다"
	case syntax.ErrTrailingBackslash:
		why = `정규식 끝에 \ 가 홀로 있습니다`
	case syntax.ErrNestingDepth:
		why = "괄호가 너무 깊습니다"
	case syntax.ErrLarge:
		why = "정규식이 너무 큽니다"
	default:
		why = "정규식을 해석할 수 없습니다"
	}
	if se.Expr != "" && len(se.Expr) <= 40 {
		why += " (" + se.Expr + ")"
	}
	return why
}

func asciiLower(b []byte) []byte {
	out := make([]byte, len(b))
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return out
}

// ---- regex analysis on the syntax tree ----------------------------------------

type reInfo struct {
	matchable bool // some input matches
	consumes  bool // some match is non-empty
	minLen    int  // shortest match in runes (0 when it can be empty)
}

func analyze(re *syntax.Regexp) reInfo {
	switch re.Op {
	case syntax.OpNoMatch:
		return reInfo{}
	case syntax.OpEmptyMatch, syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText,
		syntax.OpWordBoundary, syntax.OpNoWordBoundary:
		return reInfo{matchable: true}
	case syntax.OpLiteral:
		return reInfo{matchable: true, consumes: len(re.Rune) > 0, minLen: len(re.Rune)}
	case syntax.OpCharClass:
		if len(re.Rune) == 0 {
			return reInfo{}
		}
		return reInfo{matchable: true, consumes: true, minLen: 1}
	case syntax.OpAnyChar, syntax.OpAnyCharNotNL:
		return reInfo{matchable: true, consumes: true, minLen: 1}
	case syntax.OpCapture, syntax.OpPlus:
		return analyze(re.Sub[0])
	case syntax.OpStar, syntax.OpQuest:
		s := analyze(re.Sub[0])
		return reInfo{matchable: true, consumes: s.matchable && s.consumes}
	case syntax.OpRepeat:
		s := analyze(re.Sub[0])
		switch {
		case re.Max == 0:
			return reInfo{matchable: true}
		case re.Min == 0:
			return reInfo{matchable: true, consumes: s.matchable && s.consumes}
		}
		return reInfo{matchable: s.matchable, consumes: s.matchable && s.consumes, minLen: s.minLen * re.Min}
	case syntax.OpConcat:
		out := reInfo{matchable: true}
		for _, sub := range re.Sub {
			s := analyze(sub)
			out.matchable = out.matchable && s.matchable
			out.consumes = out.consumes || s.consumes
			out.minLen += s.minLen
		}
		out.consumes = out.consumes && out.matchable
		return out
	case syntax.OpAlternate:
		out := reInfo{minLen: 1 << 30}
		for _, sub := range re.Sub {
			s := analyze(sub)
			if !s.matchable {
				continue
			}
			out.matchable = true
			out.consumes = out.consumes || s.consumes
			if s.minLen < out.minLen {
				out.minLen = s.minLen
			}
		}
		if !out.matchable {
			out.minLen = 0
		}
		return out
	}
	return reInfo{matchable: true, consumes: true, minLen: 1}
}

// emptyPart / nonEmpty split a (simplified) regex into the part that matches
// only the empty string and the part that matches only non-empty strings (nil:
// no such match). The editor colours only non-empty matches, so the DFA of a
// rule that can also match empty runs nonEmpty.
func emptyPart(re *syntax.Regexp) *syntax.Regexp {
	switch re.Op {
	case syntax.OpNoMatch, syntax.OpCharClass, syntax.OpAnyChar, syntax.OpAnyCharNotNL:
		return nil
	case syntax.OpLiteral:
		if len(re.Rune) > 0 {
			return nil
		}
		return &syntax.Regexp{Op: syntax.OpEmptyMatch}
	case syntax.OpEmptyMatch, syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText,
		syntax.OpWordBoundary, syntax.OpNoWordBoundary:
		return re
	case syntax.OpCapture, syntax.OpPlus:
		return emptyPart(re.Sub[0])
	case syntax.OpStar, syntax.OpQuest:
		return &syntax.Regexp{Op: syntax.OpEmptyMatch}
	case syntax.OpConcat:
		subs := make([]*syntax.Regexp, 0, len(re.Sub))
		for _, s := range re.Sub {
			e := emptyPart(s)
			if e == nil {
				return nil
			}
			subs = append(subs, e)
		}
		return &syntax.Regexp{Op: syntax.OpConcat, Sub: subs}
	case syntax.OpAlternate:
		var subs []*syntax.Regexp
		for _, s := range re.Sub {
			if e := emptyPart(s); e != nil {
				subs = append(subs, e)
			}
		}
		return altOf(subs)
	}
	return nil
}

func altOf(subs []*syntax.Regexp) *syntax.Regexp {
	switch len(subs) {
	case 0:
		return nil
	case 1:
		return subs[0]
	}
	return &syntax.Regexp{Op: syntax.OpAlternate, Sub: subs}
}

func nonEmpty(re *syntax.Regexp) *syntax.Regexp {
	switch re.Op {
	case syntax.OpNoMatch, syntax.OpEmptyMatch, syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText,
		syntax.OpWordBoundary, syntax.OpNoWordBoundary:
		return nil
	case syntax.OpLiteral:
		if len(re.Rune) == 0 {
			return nil
		}
		return re
	case syntax.OpCharClass:
		if len(re.Rune) == 0 {
			return nil
		}
		return re
	case syntax.OpAnyChar, syntax.OpAnyCharNotNL:
		return re
	case syntax.OpCapture, syntax.OpQuest:
		return nonEmpty(re.Sub[0])
	case syntax.OpStar, syntax.OpPlus:
		n := nonEmpty(re.Sub[0])
		if n == nil {
			return nil
		}
		star := &syntax.Regexp{Op: syntax.OpStar, Flags: re.Flags, Sub: []*syntax.Regexp{re.Sub[0]}}
		return &syntax.Regexp{Op: syntax.OpConcat, Sub: []*syntax.Regexp{star, n, star}}
	case syntax.OpConcat:
		var alts []*syntax.Regexp
		for i, s := range re.Sub {
			n := nonEmpty(s)
			if n != nil {
				parts := make([]*syntax.Regexp, 0, len(re.Sub))
				ok := true
				for _, p := range re.Sub[:i] {
					e := emptyPart(p)
					if e == nil {
						ok = false
						break
					}
					parts = append(parts, e)
				}
				if ok {
					parts = append(parts, n)
					parts = append(parts, re.Sub[i+1:]...)
					alts = append(alts, &syntax.Regexp{Op: syntax.OpConcat, Sub: parts})
				}
			}
			if emptyPart(s) == nil {
				break // later parts cannot be the first non-empty one
			}
		}
		return altOf(alts)
	case syntax.OpAlternate:
		var subs []*syntax.Regexp
		for _, s := range re.Sub {
			if n := nonEmpty(s); n != nil {
				subs = append(subs, n)
			}
		}
		return altOf(subs)
	}
	return re
}

// stripNL removes '\r' and '\n' from everything a match can consume. A line
// never contains them, so the result decides every line exactly like the
// original — but it can no longer hand the prefilter a literal with a line
// break in it (that broke line numbers on CRLF files).
func stripNL(re *syntax.Regexp) *syntax.Regexp {
	noMatch := func() *syntax.Regexp { return &syntax.Regexp{Op: syntax.OpNoMatch} }
	switch re.Op {
	case syntax.OpLiteral:
		for _, r := range re.Rune {
			if r == '\n' || r == '\r' {
				return noMatch()
			}
		}
		return re
	case syntax.OpCharClass:
		rs := removeBreaks(re.Rune)
		if len(rs) == 0 {
			return noMatch()
		}
		c := *re
		c.Rune = rs
		return &c
	case syntax.OpAnyChar, syntax.OpAnyCharNotNL:
		return &syntax.Regexp{Op: syntax.OpCharClass, Flags: re.Flags, Rune: []rune{0, 9, 11, 12, 14, unicode.MaxRune}}
	case syntax.OpCapture, syntax.OpStar, syntax.OpPlus, syntax.OpQuest, syntax.OpRepeat, syntax.OpConcat, syntax.OpAlternate:
		c := *re
		c.Sub = make([]*syntax.Regexp, len(re.Sub))
		for i, s := range re.Sub {
			c.Sub[i] = stripNL(s)
		}
		c.Sub0 = [1]*syntax.Regexp{}
		return &c
	}
	return re
}

func removeBreaks(rs []rune) []rune {
	var out []rune
	for i := 0; i+1 < len(rs); i += 2 {
		lo, hi := rs[i], rs[i+1]
		// split [lo,hi] around 10 and 13
		segs := [][2]rune{{lo, hi}}
		for _, x := range []rune{'\n', '\r'} {
			var next [][2]rune
			for _, s := range segs {
				if x < s[0] || x > s[1] {
					next = append(next, s)
					continue
				}
				if s[0] < x {
					next = append(next, [2]rune{s[0], x - 1})
				}
				if x < s[1] {
					next = append(next, [2]rune{x + 1, s[1]})
				}
			}
			segs = next
		}
		for _, s := range segs {
			out = append(out, s[0], s[1])
		}
	}
	return out
}

// ---- literal prefilter ------------------------------------------------------------

func minLitLen(ls []lit) int {
	m := 1 << 30
	for _, l := range ls {
		if len(l.s) < m {
			m = len(l.s)
		}
	}
	return m
}

func dedupLits(ls []lit) []lit {
	var out []lit
	for _, l := range ls {
		dup := false
		for _, o := range out {
			if o.fold == l.fold && bytes.Equal(o.s, l.s) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, l)
		}
	}
	return out
}

func dropBreakLits(ls []lit) []lit {
	for _, l := range ls {
		if bytes.ContainsRune(l.s, utf8.RuneError) {
			return nil // matches broken bytes too: no byte prefilter
		}
		if bytes.ContainsAny(l.s, "\r\n") {
			return nil // cannot happen after stripNL; refuse to prefilter if it does
		}
	}
	return ls
}

// asciiFoldOK: under the regex's case folding, r matches only itself and its
// ASCII case partner — so searching an ASCII-lower-cased copy finds every match.
// Not true for k and s, whose Go fold orbits include U+212A and U+017F.
func asciiFoldOK(r rune) bool {
	if r >= utf8.RuneSelf {
		return unicode.SimpleFold(r) == r
	}
	f := unicode.SimpleFold(r)
	return f == r || (f < utf8.RuneSelf && unicode.SimpleFold(f) == r)
}

// litPiece reports whether one node of a concatenation is a fixed string that
// can join its neighbours in a literal: a plain literal, a case-folded literal
// of ASCII-safe letters, or a two-letter class [kK] / [sS] (how the translator
// writes letters that Go would otherwise fold beyond ASCII).
func litPiece(re *syntax.Regexp) ([]byte, bool, bool) {
	switch re.Op {
	case syntax.OpLiteral:
		if re.Flags&syntax.FoldCase == 0 {
			return []byte(string(re.Rune)), false, len(re.Rune) > 0
		}
		for _, r := range re.Rune {
			if !asciiFoldOK(r) {
				return nil, false, false
			}
		}
		return asciiLower([]byte(string(re.Rune))), true, len(re.Rune) > 0
	case syntax.OpCharClass:
		rs := re.Rune
		if len(rs) == 4 && rs[0] == rs[1] && rs[2] == rs[3] && 'A' <= rs[0] && rs[0] <= 'Z' && rs[2] == rs[0]+'a'-'A' {
			return []byte{byte(rs[2])}, true, true
		}
	}
	return nil, false, false
}

// requiredLits returns a set of literals such that every match of re contains
// at least one of them (ok=false when no such set is known).
func requiredLits(re *syntax.Regexp) ([]lit, bool) {
	switch re.Op {
	case syntax.OpNoMatch:
		return nil, true // no match at all: nothing required
	case syntax.OpLiteral:
		if s, fold, ok := litPiece(re); ok {
			return []lit{{s: s, fold: fold}}, true
		}
		// Case-folded with letters that fold beyond ASCII: longest safe run.
		best, cur := []rune(nil), []rune(nil)
		for _, r := range re.Rune {
			if asciiFoldOK(r) {
				cur = append(cur, r)
				if len(cur) > len(best) {
					best = append(best[:0:0], cur...)
				}
			} else {
				cur = cur[:0]
			}
		}
		if len(best) == 0 {
			return nil, false
		}
		return []lit{{s: asciiLower([]byte(string(best))), fold: true}}, true
	case syntax.OpCharClass:
		if s, fold, ok := litPiece(re); ok {
			return []lit{{s: s, fold: fold}}, true
		}
		return nil, false
	case syntax.OpCapture, syntax.OpPlus:
		return requiredLits(re.Sub[0])
	case syntax.OpRepeat:
		if re.Min >= 1 {
			return requiredLits(re.Sub[0])
		}
		return nil, false
	case syntax.OpConcat:
		var cands [][]lit
		var run []byte
		runFold, runN := false, 0
		flush := func() {
			if runN > 0 {
				s := append([]byte(nil), run...)
				if runFold {
					s = asciiLower(s)
				}
				cands = append(cands, []lit{{s: s, fold: runFold}})
			}
			run, runFold, runN = run[:0], false, 0
		}
		for _, s := range re.Sub {
			if b, fold, ok := litPiece(s); ok {
				run = append(run, b...)
				runFold = runFold || fold
				runN++
				continue
			}
			flush()
			if ls, ok := requiredLits(s); ok {
				cands = append(cands, ls)
			}
		}
		flush()
		var best []lit
		found := false
		for _, ls := range cands {
			if !found || betterLits(ls, best) {
				best, found = ls, true
			}
		}
		return best, found
	case syntax.OpAlternate:
		var all []lit
		for _, s := range re.Sub {
			if analyze(s).matchable == false {
				continue
			}
			ls, ok := requiredLits(s)
			if !ok {
				return nil, false
			}
			all = append(all, ls...)
		}
		return all, true
	}
	return nil, false
}

func betterLits(a, b []lit) bool {
	if len(a) == 0 {
		return false
	}
	if len(b) == 0 {
		return true
	}
	ma, mb := minLitLen(a), minLitLen(b)
	if ma != mb {
		return ma > mb
	}
	return len(a) < len(b)
}

// ---- JS → RE2 translation -----------------------------------------------------

// JS \s (ECMAScript WhiteSpace + LineTerminator). Go's \s is only [\t\n\f\r ].
var jsSpaceRanges = [][2]rune{
	{0x09, 0x0d}, {0x20, 0x20}, {0xa0, 0xa0}, {0x1680, 0x1680}, {0x2000, 0x200a},
	{0x2028, 0x2029}, {0x202f, 0x202f}, {0x205f, 0x205f}, {0x3000, 0x3000}, {0xfeff, 0xfeff},
}

func rangesClassBody(rs [][2]rune) string {
	var b strings.Builder
	for _, r := range rs {
		if r[0] == r[1] {
			fmt.Fprintf(&b, `\x{%x}`, r[0])
		} else {
			fmt.Fprintf(&b, `\x{%x}-\x{%x}`, r[0], r[1])
		}
	}
	return b.String()
}

var (
	jsSpaceBody    = rangesClassBody(jsSpaceRanges)
	jsNonSpaceBody = rangesClassBody(complementRanges(jsSpaceRanges))
)

func complementRanges(rs [][2]rune) [][2]rune {
	var out [][2]rune
	next := rune(0)
	for _, r := range rs {
		if r[0] > next {
			out = append(out, [2]rune{next, r[0] - 1})
		}
		next = r[1] + 1
	}
	if next <= unicode.MaxRune {
		out = append(out, [2]rune{next, unicode.MaxRune})
	}
	return out
}

func isHex(c rune) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

func isASCIIAlnum(r rune) bool {
	return ('0' <= r && r <= '9') || ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z')
}

// writeLitRune writes r as a literal outside a class.
func writeLitRune(b *strings.Builder, r rune) {
	switch {
	case isASCIIAlnum(r) || r == '_':
		b.WriteRune(r)
	case r >= utf8.RuneSelf && unicode.IsGraphic(r) && !unicode.IsSpace(r):
		b.WriteRune(r)
	default:
		fmt.Fprintf(b, `\x{%x}`, r)
	}
}

// writeClassRune writes r inside a class.
func writeClassRune(b *strings.Builder, r rune) {
	if isASCIIAlnum(r) || (r >= utf8.RuneSelf && unicode.IsGraphic(r) && !unicode.IsSpace(r)) {
		b.WriteRune(r)
		return
	}
	fmt.Fprintf(b, `\x{%x}`, r)
}

// writeFoldChar writes one character outside a class; with ci it becomes the
// class of its JS case partners.
func writeFoldChar(b *strings.Builder, r rune, ci bool) {
	if ci {
		if eq := jsEquiv(r); len(eq) > 1 {
			b.WriteByte('[')
			for _, e := range eq {
				writeClassRune(b, e)
			}
			b.WriteByte(']')
			return
		}
	}
	writeLitRune(b, r)
}

// jsQuote is the Go regex for the literal text s, case-insensitive the JS way
// when ci.
func jsQuote(s string, ci bool) string {
	var b strings.Builder
	for _, r := range s {
		writeFoldChar(&b, r, ci)
	}
	return b.String()
}

// jsAtom is one escape: a character, or a class escape (\d \s ...).
type jsAtom struct {
	char    rune
	isClass bool
	in, out string // class escape text inside / outside a character class
	assert  string // \b, \B outside a class
}

type jsTranslator struct {
	rs       []rune
	n, i     int
	b        strings.Builder
	hasNamed bool
	ci, dot  bool // case-insensitive, dotAll (JS modifiers (?i: (?s:)
	stack    [][2]bool
	names    map[string]bool
}

// translateJS rewrites a JavaScript regex source (as the editor compiles it:
// flags "g" or "gi", no u/m/s) into Go syntax with the same meaning on a single
// line. Case-insensitivity (ci, and (?i:...) modifier groups) is written out as
// explicit JS case classes. reason is non-empty when RE2 cannot express it.
func translateJS(src string, ci bool) (out string, reason string) {
	t := &jsTranslator{rs: []rune(src), ci: ci}
	t.n = len(t.rs)
	t.hasNamed = strings.Contains(strings.ReplaceAll(strings.ReplaceAll(src, "(?<=", ""), "(?<!", ""), "(?<")
	if why := t.run(); why != "" {
		return "", why
	}
	return t.b.String(), ""
}

// escape reads "\X" at t.i.
func (t *jsTranslator) escape(inClass bool) (jsAtom, string) {
	rs, n := t.rs, t.n
	if t.i+1 >= n {
		return jsAtom{}, `정규식 끝에 \ 가 홀로 있습니다`
	}
	c := rs[t.i+1]
	t.i += 2
	i := t.i
	switch c {
	case 'd', 'D', 'w', 'W':
		s := `\` + string(c)
		return jsAtom{isClass: true, in: s, out: s}, ""
	case 's':
		return jsAtom{isClass: true, in: jsSpaceBody, out: "[" + jsSpaceBody + "]"}, ""
	case 'S':
		return jsAtom{isClass: true, in: jsNonSpaceBody, out: "[" + jsNonSpaceBody + "]"}, ""
	case 'b':
		if inClass {
			return jsAtom{char: 8}, ""
		}
		return jsAtom{assert: `\b`}, ""
	case 'B':
		if inClass {
			return jsAtom{char: 'B'}, ""
		}
		return jsAtom{assert: `\B`}, ""
	case 'f':
		return jsAtom{char: '\f'}, ""
	case 'n':
		return jsAtom{char: '\n'}, ""
	case 'r':
		return jsAtom{char: '\r'}, ""
	case 't':
		return jsAtom{char: '\t'}, ""
	case 'v':
		return jsAtom{char: '\v'}, ""
	case '0':
		if i < n && rs[i] >= '0' && rs[i] <= '9' {
			return jsAtom{}, `8진수 이스케이프(\0` + string(rs[i]) + `…)는 지원하지 않습니다`
		}
		return jsAtom{char: 0}, ""
	case '1', '2', '3', '4', '5', '6', '7', '8', '9':
		if inClass {
			return jsAtom{}, `글자 묶음 안의 8진수 이스케이프(\` + string(c) + `)는 지원하지 않습니다`
		}
		return jsAtom{}, `역참조 \` + string(c) + ` 는 Go(RE2) 정규식에서 지원하지 않습니다`
	case 'k':
		if t.hasNamed {
			return jsAtom{}, `이름 역참조 \k<…> 는 Go(RE2) 정규식에서 지원하지 않습니다`
		}
		return jsAtom{char: 'k'}, ""
	case 'x':
		if i+1 < n && isHex(rs[i]) && isHex(rs[i+1]) {
			var v rune
			fmt.Sscanf(string(rs[i:i+2]), "%x", &v)
			t.i += 2
			return jsAtom{char: v}, ""
		}
		return jsAtom{char: 'x'}, ""
	case 'u':
		if i+3 < n && isHex(rs[i]) && isHex(rs[i+1]) && isHex(rs[i+2]) && isHex(rs[i+3]) {
			var v rune
			fmt.Sscanf(string(rs[i:i+4]), "%x", &v)
			t.i += 4
			i = t.i
			if v >= 0xD800 && v <= 0xDBFF {
				if i+5 < n && rs[i] == '\\' && rs[i+1] == 'u' && isHex(rs[i+2]) && isHex(rs[i+3]) && isHex(rs[i+4]) && isHex(rs[i+5]) {
					var lo rune
					fmt.Sscanf(string(rs[i+2:i+6]), "%x", &lo)
					if lo >= 0xDC00 && lo <= 0xDFFF {
						t.i += 6
						return jsAtom{char: 0x10000 + (v-0xD800)<<10 + (lo - 0xDC00)}, ""
					}
				}
				return jsAtom{}, `짝 없는 서러게이트 \u` + fmt.Sprintf("%04X", v) + ` 는 지원하지 않습니다`
			}
			if v >= 0xDC00 && v <= 0xDFFF {
				return jsAtom{}, `짝 없는 서러게이트 \u` + fmt.Sprintf("%04X", v) + ` 는 지원하지 않습니다`
			}
			return jsAtom{char: v}, ""
		}
		if i < n && rs[i] == '{' {
			return jsAtom{}, `\u{…} 표기는 지원하지 않습니다 (\uXXXX 를 쓰세요)`
		}
		return jsAtom{char: 'u'}, ""
	case 'c':
		if i < n && (('a' <= rs[i] && rs[i] <= 'z') || ('A' <= rs[i] && rs[i] <= 'Z')) {
			v := rs[i] % 32
			t.i++
			return jsAtom{char: v}, ""
		}
		if inClass && i < n && (('0' <= rs[i] && rs[i] <= '9') || rs[i] == '_') {
			v := rs[i] % 32
			t.i++
			return jsAtom{char: v}, ""
		}
		// Annex B: a lone "\c" is a backslash; the "c" is read again as itself.
		t.i--
		return jsAtom{char: '\\'}, ""
	}
	return jsAtom{char: c}, "" // identity escape (\e = "e", \/ = "/", \가 = "가")
}

func (t *jsTranslator) run() string {
	rs, n := t.rs, t.n
	depth := 0
	lastAtom := false // a quantifier may follow (for "{" handling)
	for t.i < n {
		c := rs[t.i]
		switch c {
		case '\\':
			a, why := t.escape(false)
			if why != "" {
				return why
			}
			switch {
			case a.assert != "":
				t.b.WriteString(a.assert)
			case a.isClass:
				t.b.WriteString(a.out)
			default:
				writeFoldChar(&t.b, a.char, t.ci)
			}
			lastAtom = true
			continue
		case '(':
			t.stack = append(t.stack, [2]bool{t.ci, t.dot})
			if t.i+1 < n && rs[t.i+1] == '?' {
				rest := string(rs[t.i+2:])
				switch {
				case strings.HasPrefix(rest, ":"):
					t.b.WriteString("(?:")
					t.i += 3
				case strings.HasPrefix(rest, "="), strings.HasPrefix(rest, "!"):
					return "앞보기 (?= / (?! 는 Go(RE2) 정규식에서 지원하지 않습니다"
				case strings.HasPrefix(rest, "<="), strings.HasPrefix(rest, "<!"):
					return "뒤돌아보기 (?<= / (?<! 는 Go(RE2) 정규식에서 지원하지 않습니다"
				case strings.HasPrefix(rest, "<"):
					end := strings.IndexRune(rest, '>')
					if end < 0 {
						return "이름 그룹 (?<이름> 이 닫히지 않았습니다"
					}
					// Names are irrelevant here (no back-references), but JS
					// refuses a name used twice.
					name := rest[1:end]
					if t.names == nil {
						t.names = map[string]bool{}
					}
					if t.names[name] {
						return "같은 이름의 그룹이 두 번 있습니다 (" + name + ")"
					}
					t.names[name] = true
					t.b.WriteString("(?:")
					t.i += 2 + utf8.RuneCountInString(rest[:end+1])
				default:
					// JS modifiers: (?ims-ims:...)
					j := t.i + 2
					on, off, neg, seen := "", "", false, map[rune]bool{}
					for j < n && (rs[j] == 'i' || rs[j] == 'm' || rs[j] == 's' || (rs[j] == '-' && !neg)) {
						if rs[j] == '-' {
							neg = true
						} else {
							if seen[rs[j]] {
								return "그룹 표기 (? 에 같은 글자가 두 번 있습니다"
							}
							seen[rs[j]] = true
							if neg {
								off += string(rs[j])
							} else {
								on += string(rs[j])
							}
						}
						j++
					}
					if j >= n || rs[j] != ':' || (on == "" && off == "") {
						return "알 수 없는 그룹 표기 (? 입니다"
					}
					if strings.ContainsRune(on, 'i') {
						t.ci = true
					}
					if strings.ContainsRune(off, 'i') {
						t.ci = false
					}
					if strings.ContainsRune(on, 's') {
						t.dot = true
					}
					if strings.ContainsRune(off, 's') {
						t.dot = false
					}
					t.b.WriteString("(?:")
					t.i = j + 1
				}
			} else {
				t.b.WriteByte('(')
				t.i++
			}
			depth++
			lastAtom = false
			continue
		case ')':
			if depth == 0 {
				return "괄호 짝이 맞지 않습니다"
			}
			depth--
			top := t.stack[len(t.stack)-1]
			t.stack = t.stack[:len(t.stack)-1]
			t.ci, t.dot = top[0], top[1]
			t.b.WriteByte(')')
			t.i++
			lastAtom = true
			continue
		case '[':
			if why := t.class(); why != "" {
				return why
			}
			lastAtom = true
			continue
		case '.':
			if t.dot {
				t.b.WriteString(`[\x00-\x{10ffff}]`)
			} else {
				t.b.WriteString(`[^\n\r\x{2028}\x{2029}]`)
			}
			t.i++
			lastAtom = true
			continue
		case '{':
			// A valid quantifier after an atom passes through; anything else is
			// a literal brace in JS (Annex B).
			j := t.i + 1
			for j < n && rs[j] >= '0' && rs[j] <= '9' {
				j++
			}
			valid := j > t.i+1
			if valid && j < n && rs[j] == ',' {
				j++
				for j < n && rs[j] >= '0' && rs[j] <= '9' {
					j++
				}
			}
			if valid && j < n && rs[j] == '}' && lastAtom {
				t.b.WriteString(string(rs[t.i : j+1]))
				t.i = j + 1
				if t.i < n && rs[t.i] == '?' {
					t.b.WriteByte('?')
					t.i++
				}
				lastAtom = false
				continue
			}
			writeLitRune(&t.b, '{')
			t.i++
			lastAtom = true
			continue
		case '*', '+', '?':
			t.b.WriteRune(c)
			t.i++
			if t.i < n && rs[t.i] == '?' {
				t.b.WriteByte('?')
				t.i++
			}
			lastAtom = false
			continue
		case '|':
			t.b.WriteByte('|')
			t.i++
			lastAtom = false
			continue
		case '^', '$':
			t.b.WriteRune(c)
			t.i++
			lastAtom = false
			continue
		}
		writeFoldChar(&t.b, c, t.ci)
		t.i++
		lastAtom = true
	}
	if depth != 0 {
		return "괄호 짝이 맞지 않습니다"
	}
	return ""
}

// class reads a JS character class at t.i ('[').
func (t *jsTranslator) class() string {
	rs, n := t.rs, t.n
	// JS: "[]" never matches, "[^]" matches anything.
	if t.i+1 < n && rs[t.i+1] == ']' {
		t.b.WriteString(`[^\x00-\x{10ffff}]`)
		t.i += 2
		return ""
	}
	if t.i+2 < n && rs[t.i+1] == '^' && rs[t.i+2] == ']' {
		t.b.WriteString(`[\x00-\x{10ffff}]`)
		t.i += 3
		return ""
	}
	t.i++
	neg := false
	if t.i < n && rs[t.i] == '^' {
		neg = true
		t.i++
	}
	var body strings.Builder
	var extra []rune
	addChar := func(r rune) {
		writeClassRune(&body, r)
		if t.ci {
			extra = append(extra, jsEquiv(r)...)
		}
	}
	atom := func() (jsAtom, string) {
		if rs[t.i] == '\\' {
			return t.escape(true)
		}
		r := rs[t.i]
		t.i++
		return jsAtom{char: r}, ""
	}
	for {
		if t.i >= n {
			return "글자 묶음 [ 이 닫히지 않았습니다"
		}
		if rs[t.i] == ']' {
			t.i++
			break
		}
		a, why := atom()
		if why != "" {
			return why
		}
		if t.i+1 < n && rs[t.i] == '-' && rs[t.i+1] != ']' {
			t.i++ // '-'
			b, why := atom()
			if why != "" {
				return why
			}
			if !a.isClass && !b.isClass {
				if a.char > b.char {
					return "글자 범위의 순서가 잘못되었습니다 (" + string(a.char) + "-" + string(b.char) + ")"
				}
				writeClassRune(&body, a.char)
				body.WriteByte('-')
				writeClassRune(&body, b.char)
				if t.ci {
					extra = jsFoldExtras(extra, a.char, b.char)
				}
				continue
			}
			// Annex B: a class escape next to "-" is a union with a literal "-".
			for _, x := range []jsAtom{a, {char: '-'}, b} {
				if x.isClass {
					body.WriteString(x.in)
				} else {
					addChar(x.char)
				}
			}
			continue
		}
		if a.isClass {
			body.WriteString(a.in)
		} else {
			addChar(a.char)
		}
	}
	t.b.WriteByte('[')
	if neg {
		t.b.WriteByte('^')
	}
	t.b.WriteString(body.String())
	if len(extra) > 0 {
		sort.Slice(extra, func(i, j int) bool { return extra[i] < extra[j] })
		for k := 0; k < len(extra); {
			lo := extra[k]
			hi := lo
			k++
			for k < len(extra) && extra[k] <= hi+1 {
				if extra[k] > hi {
					hi = extra[k]
				}
				k++
			}
			writeClassRune(&t.b, lo)
			if hi > lo {
				t.b.WriteByte('-')
				writeClassRune(&t.b, hi)
			}
		}
	}
	t.b.WriteByte(']')
	return ""
}
