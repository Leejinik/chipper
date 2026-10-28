package linefilter

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/bits"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"
	"unsafe"
)

// hit is one matched line. In a region result, line is the 0-based index
// within the region; once published, the 1-based line number in the file.
type hit struct {
	line  int64
	start int64 // offset in the scanned file of the line's first byte
	end   int64 // offset just past the line's text (before its line break)
	// mask: the matching rules — bit k = matcher.rules[k] for k < 64. With more
	// rules, ext (when not 0) is the 1-based entry of the rules' other words
	// (k ≥ 64) in the hit list's ext arena: words [(ext-1)*W, ext*W) with
	// W = matcher.extWords. ext fits in the struct's padding.
	mask uint64
	col  int32 // UTF-16 column of the first match (editor units); -1 unknown
	ext  uint32
}

// longLine records a line of at least LongLineMin bytes so readers can jump
// over it instead of searching for its end.
type longLine struct {
	line             int64
	start, end, next int64
}

// LongLineMin: lines this long are recorded at scan time.
const LongLineMin = 64 << 10

type litEntry struct {
	s      []byte
	fold   bool
	word   bool
	verify bool // regex prefilter: the rule still has to confirm
	rule   int  // index into matcher.rules
}

// litPassLimit: with more literal passes than this (or any rule that must run
// on every line anyway) the DFA path is cheaper. Measured in stage 1; a var
// for tests.
var litPassLimit = 3

// groupSize: rules per set DFA in the DFA path (measured: one set DFA for
// all rules is fastest unless its states explode — then it is split). A var
// for tests.
var groupSize = 64

type matcher struct {
	rules    []compiledRule
	litMode  bool
	lits     []litEntry
	needFold bool
	groups   [][]int
	progs    []*progInfo // per rule (nil: the rule always uses the stdlib)

	// extWords: words per hit beyond the first 64 rules (0 with ≤ 64 rules).
	extWords int

	mu     sync.Mutex
	gprogs map[string]*progInfo
	slow   []atomic.Bool // per rule: its DFA gave up somewhere
}

// noteSlow records rules that fell back to the (much slower) stdlib.
func (m *matcher) noteSlow(rules []int) {
	for _, ri := range rules {
		m.slow[ri].Store(true)
	}
}

// eachRule calls fn with the position (in m.rules) of every rule of hit h;
// ext is the arena h.ext points into.
func (m *matcher) eachRule(h hit, ext []uint64, fn func(k int)) {
	for b := h.mask; b != 0; b &= b - 1 {
		fn(bits.TrailingZeros64(b))
	}
	if h.ext == 0 {
		return
	}
	w := m.extWords
	for i, x := range ext[int(h.ext-1)*w : int(h.ext)*w] {
		for b := x; b != 0; b &= b - 1 {
			fn(64*(i+1) + bits.TrailingZeros64(b))
		}
	}
}

func newMatcher(rules []compiledRule) *matcher {
	m := &matcher{rules: rules, gprogs: map[string]*progInfo{}}
	m.slow = make([]atomic.Bool, len(rules))
	if len(rules) > 64 {
		m.extWords = (len(rules) - 1) / 64
	}
	m.progs = make([]*progInfo, len(rules))
	for i := range rules {
		if pi, err := newProgInfo(rules[i].dfaSrc); err == nil {
			m.progs[i] = pi
		}
	}
	unf := false
	for ri, r := range rules {
		if r.unfiltered || len(r.lits) == 0 {
			unf = true
		}
		for _, l := range r.lits {
			m.lits = append(m.lits, litEntry{s: l.s, fold: l.fold, word: r.litOnly && r.word, verify: !r.litOnly, rule: ri})
		}
	}
	m.litMode = len(rules) > 0 && !unf && len(m.lits) <= litPassLimit
	if m.litMode {
		for _, l := range m.lits {
			if l.fold {
				m.needFold = true
			}
		}
	} else {
		m.lits = nil
		for i := 0; i < len(rules); i += groupSize {
			g := make([]int, 0, groupSize)
			for k := i; k < i+groupSize && k < len(rules); k++ {
				g = append(g, k)
			}
			m.groups = append(m.groups, g)
		}
	}
	return m
}

// groupProg returns the combined program of a group of rules (shared by all
// workers), or nil when it cannot be built.
func (m *matcher) groupProg(g []int) *progInfo {
	key := fmt.Sprint(g)
	m.mu.Lock()
	defer m.mu.Unlock()
	if pi, ok := m.gprogs[key]; ok {
		return pi
	}
	src := make([]string, len(g))
	for i, ri := range g {
		src[i] = m.rules[ri].dfaSrc
	}
	pi, err := newSetProgInfo(src)
	if err != nil {
		pi = nil
	}
	m.gprogs[key] = pi
	return pi
}

// ---- per-worker state -----------------------------------------------------------

type wgroup struct {
	rules []int
	d     *dfa
	re    *regexp.Regexp // the DFA gave up: stdlib on the group's regex
	limit int            // this group's DFA memory (halved on each split)
}

type wstate struct {
	m      *matcher
	groups []wgroup
	rd, ad []*dfa
	rstd   []bool // the rule's DFA gave up: stdlib
	astd   []bool
	cands  []cand
	fold   []byte
	low    []byte
	lowPtr *byte
	lowLen int
	gLimit int
	rLimit int
	ends   [64]int32
	// Rules past the 64th: the line being judged sets their bits in hi (hiSet
	// says one is set); addHit moves them into ext, this region's arena.
	hi    []uint64
	hiSet bool
	ext   []uint64
	// a line without its ANSI sequences, and where each byte came from (ansi.go)
	ansiBuf []byte
	ansiPos []int32
}

// setRule marks rule k (position in m.rules) as matching the current line:
// in *mask for the first 64 rules, in ws.hi for the others.
func (ws *wstate) setRule(mask *uint64, k int) {
	if k < 64 {
		*mask |= 1 << uint(k)
		return
	}
	ws.hi[k/64-1] |= 1 << uint(k%64)
	ws.hiSet = true
}

// hasRule: rule k is already marked for the current line.
func (ws *wstate) hasRule(mask uint64, k int) bool {
	if k < 64 {
		return mask&(1<<uint(k)) != 0
	}
	return ws.hi[k/64-1]&(1<<uint(k%64)) != 0
}

// lineHit: the current line matched at least one rule.
func (ws *wstate) lineHit(mask uint64) bool { return mask != 0 || ws.hiSet }

// clearHi forgets the current line's bits past the 64th rule.
func (ws *wstate) clearHi() {
	if ws.hiSet {
		clear(ws.hi)
		ws.hiSet = false
	}
}

// addHit appends h (whose rules are mask plus ws.hi) to out.
func (ws *wstate) addHit(out []hit, h hit) []hit {
	if ws.hiSet {
		ws.ext = append(ws.ext, ws.hi...)
		h.ext = uint32(len(ws.ext) / len(ws.hi))
		ws.clearHi()
	}
	return append(out, h)
}

// newWState: mem is this worker's DFA memory budget.
func newWState(m *matcher, mem int) *wstate {
	ws := &wstate{m: m}
	if m.extWords > 0 {
		ws.hi = make([]uint64, m.extWords)
	}
	n := len(m.rules)
	ws.rd, ws.ad = make([]*dfa, n), make([]*dfa, n)
	ws.rstd, ws.astd = make([]bool, n), make([]bool, n)
	for ri := range m.rules {
		if m.progs[ri] == nil {
			ws.rstd[ri], ws.astd[ri] = true, true
		}
	}
	ng := len(m.groups)
	if ng == 0 {
		ng = 1
	}
	ws.gLimit = mem / 2 / ng
	for _, g := range m.groups {
		ws.groups = append(ws.groups, wgroup{rules: g, limit: ws.gLimit})
	}
	if n > 0 {
		ws.rLimit = mem / 4 / n
	}
	return ws
}

func (ws *wstate) ruleDFA(ri int) *dfa {
	d := ws.rd[ri]
	if d == nil {
		d = newDFA(ws.m.progs[ri], false, ws.rLimit)
		ws.rd[ri] = d
	}
	return d
}

func (ws *wstate) anchDFA(ri int) *dfa {
	d := ws.ad[ri]
	if d == nil {
		d = newDFA(ws.m.progs[ri], true, ws.rLimit)
		ws.ad[ri] = d
	}
	return d
}

// groupMatch runs group gi on line. retry: the group was just split or
// replaced; run index gi again.
// groupMatch runs group gi on line: the mask of the group's rules (bit k =
// k-th rule) that may match, with ws.ends holding their earliest match ends
// (-1 = unknown). retry: the group was just split or replaced; run gi again.
func (ws *wstate) groupMatch(gi int, line []byte) (mask uint64, retry bool) {
	g := &ws.groups[gi]
	if g.re != nil {
		if !g.re.Match(line) {
			return 0, false
		}
		for k := range g.rules {
			ws.ends[k] = -1
		}
		return 1<<uint(len(g.rules)) - 1, false // every rule of the group is a candidate
	}
	if g.d == nil {
		pi := ws.m.groupProg(g.rules)
		if pi == nil {
			ws.split(gi)
			return 0, true
		}
		g.d = newDFA(pi, false, g.limit)
	}
	mask = g.d.matchSet(line, &ws.ends)
	if g.d.failed {
		ws.split(gi)
		return 0, true
	}
	return mask, false
}

// split replaces a group whose DFA gave up: big groups are halved (the state
// explosion usually comes from combining independent rules), small ones run the
// stdlib on their combined regex.
func (ws *wstate) split(gi int) {
	g := ws.groups[gi]
	if len(g.rules) > 4 {
		h := len(g.rules) / 2
		a := wgroup{rules: g.rules[:h:h], limit: g.limit / 2}
		b := wgroup{rules: g.rules[h:], limit: g.limit / 2}
		ws.groups = slices.Replace(ws.groups, gi, gi+1, a, b)
		return
	}
	ws.m.noteSlow(g.rules)
	src := make([]string, len(g.rules))
	for i, ri := range g.rules {
		src[i] = "(?:" + ws.m.rules[ri].dfaSrc + ")"
	}
	ws.groups[gi] = wgroup{rules: g.rules, re: regexp.MustCompile(strings.Join(src, "|"))}
}

// lowerLine returns line ASCII-lower-cased (cached for the same slice).
func (ws *wstate) lowerLine(line []byte) []byte {
	if len(line) == 0 {
		return line
	}
	p := unsafe.SliceData(line)
	if p == ws.lowPtr && len(line) == ws.lowLen {
		return ws.low[:len(line)]
	}
	if cap(ws.low) < len(line) {
		ws.low = make([]byte, len(line))
	}
	low := ws.low[:len(line)]
	lowerASCII(low, line)
	ws.lowPtr, ws.lowLen = p, len(line)
	return low
}

// litFind: first occurrence of a literal rule's needle in line (word rules:
// with ASCII word boundaries), or -1.
func (ws *wstate) litFind(ri int, line []byte) int {
	r := &ws.m.rules[ri]
	h := line
	if r.fold {
		h = ws.lowerLine(line)
	}
	return findNeedle(h, r.needle, r.word)
}

func findNeedle(h, needle []byte, word bool) int {
	i := 0
	for i+len(needle) <= len(h) {
		j := bytes.Index(h[i:], needle)
		if j < 0 {
			return -1
		}
		p := i + j
		q := p + len(needle)
		if word && ((p > 0 && isWordByte(h[p-1])) || (q < len(h) && isWordByte(h[q]))) {
			i = p + 1
			continue
		}
		return p
	}
	return -1
}

// firstNonEmpty: start of the first non-empty match the editor would colour
// (it skips empty matches), or -1.
func firstNonEmpty(re *regexp.Regexp, line []byte) int {
	for _, loc := range re.FindAllIndex(line, -1) {
		if loc[1] > loc[0] {
			return loc[0]
		}
	}
	return -1
}

// ruleStart decides rule ri on line and, when it matches, where its first
// match starts — exactly if that is before best, otherwise any value ≥ best.
// e ≥ 0 is a known earliest match end from a DFA that already ran (or -1).
func (ws *wstate) ruleStart(ri int, line []byte, best int, e int) (bool, int) {
	r := &ws.m.rules[ri]
	if r.litOnly {
		p := ws.litFind(ri, line)
		return p >= 0, p
	}
	if r.emptyToo {
		if e < 0 && !ws.rstd[ri] {
			d := ws.ruleDFA(ri)
			ok, _ := d.match(line)
			if d.failed {
				ws.rstd[ri] = true
				ws.m.noteSlow([]int{ri})
			} else if !ok {
				return false, 0
			}
		}
		p := firstNonEmpty(r.lineRe, line)
		return p >= 0, p
	}
	if e < 0 {
		if ws.rstd[ri] {
			loc := r.lineRe.FindIndex(line)
			if loc == nil {
				return false, 0
			}
			return true, ws.wordAdjust(ri, line, loc[0])
		}
		d := ws.ruleDFA(ri)
		ok, end := d.match(line)
		if d.failed {
			ws.rstd[ri] = true
			ws.m.noteSlow([]int{ri})
			return ws.ruleStart(ri, line, best, -1)
		}
		if !ok {
			return false, 0
		}
		e = end
	}
	// It matches; find where.
	limit := e
	if best-1 < limit {
		limit = best - 1
	}
	if limit < 0 {
		return true, best
	}
	if !ws.astd[ri] {
		d := ws.anchDFA(ri)
		s, ok := d.firstStart(line, limit, 64*(limit+1)+4096)
		if d.failed {
			ws.astd[ri] = true
		}
		if ok {
			if s < 0 {
				return true, best
			}
			return true, ws.wordAdjust(ri, line, s)
		}
	}
	loc := r.lineRe.FindIndex(line)
	if loc == nil {
		return true, best // cannot happen
	}
	return true, ws.wordAdjust(ri, line, loc[0])
}

// wordAdjust: a word rule outside the literal path matches its neighbour
// character too; the match position is the word itself.
func (ws *wstate) wordAdjust(ri int, line []byte, s int) int {
	r := &ws.m.rules[ri]
	if r.wordStart == nil || s >= len(line) {
		return s
	}
	if s == 0 && r.wordStart.Match(line) {
		return 0
	}
	_, w := utf8.DecodeRune(line[s:])
	return s + w
}

// lineHitDFA decides one line in the DFA path. Returns the rule mask and the
// byte offset of the first match.
// Rules past the 64th go to ws.hi (see lineHit).
func (ws *wstate) lineHitDFA(line []byte) (uint64, int) {
	var mask uint64
	best := len(line) + 1
	for gi := 0; gi < len(ws.groups); gi++ {
		gm, retry := ws.groupMatch(gi, line)
		if retry {
			gi--
			continue
		}
		for k, ri := range ws.groups[gi].rules {
			if gm&(1<<uint(k)) == 0 {
				continue
			}
			if ok, s := ws.ruleStart(ri, line, best, int(ws.ends[k])); ok {
				ws.setRule(&mask, ri)
				if s < best {
					best = s
				}
			}
		}
	}
	return mask, best
}

// utf16Col: editor column (UTF-16 units) of byte offset s in line. Invalid
// bytes count as one U+FFFD each.
func utf16Col(line []byte, s int) int32 {
	if s > len(line) {
		s = len(line)
	}
	n := 0
	for i := 0; i < s; {
		c := line[i]
		if c < utf8.RuneSelf {
			i++
			n++
			continue
		}
		r, w := utf8.DecodeRune(line[i:])
		i += w
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return int32(n)
}

type cand struct {
	pos   int32
	entry int32
}

func isTerm(c byte) bool { return c == '\n' || c == '\r' }

func isWordByte(c byte) bool {
	return c == '_' || ('0' <= c && c <= '9') || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

// countBreaks counts line breaks the way CodeMirror splits lines (\r\n, \r, \n).
// b must not start with the '\n' of a "\r\n" whose '\r' is outside b.
func countBreaks(b []byte, hasCR bool) int64 {
	n := bytes.Count(b, []byte{'\n'})
	if hasCR {
		n += bytes.Count(b, []byte{'\r'}) - bytes.Count(b, []byte("\r\n"))
	}
	return int64(n)
}

// indexBreak returns the index of the first '\r' or '\n' in b, or -1.
func indexBreak(b []byte, hasCR bool) int {
	j := bytes.IndexByte(b, '\n')
	if hasCR {
		lim := b
		if j >= 0 {
			lim = b[:j]
		}
		if r := bytes.IndexByte(lim, '\r'); r >= 0 {
			return r
		}
	}
	return j
}

// lastBreak returns the index of the last '\r' or '\n' in b, or -1.
func lastBreak(b []byte, hasCR bool) int {
	j := bytes.LastIndexByte(b, '\n')
	if hasCR {
		if r := bytes.LastIndexByte(b[j+1:], '\r'); r >= 0 {
			j = j + 1 + r
		}
	}
	return j
}

// lineEnd: for the line starting at ls, the end of its text and the start of the
// next line.
func lineEnd(data []byte, ls int, hasCR bool) (int, int) {
	j := indexBreak(data[ls:], hasCR)
	if j < 0 {
		return len(data), len(data)
	}
	e := ls + j
	if data[e] == '\r' && e+1 < len(data) && data[e+1] == '\n' {
		return e, e + 2
	}
	return e, e + 1
}

// lineStartBefore: start of the line containing p, searching no further back
// than from (a line start). p must not be a line break character.
func lineStartBefore(data []byte, from, p int, hasCR bool) int {
	return from + lastBreak(data[from:p], hasCR) + 1
}

// lastLineCut: length of the longest prefix of b made of complete lines. A '\r'
// at the very end does not complete a line (a '\n' may follow).
func lastLineCut(b []byte) int {
	if len(b) > 0 && b[len(b)-1] == '\r' {
		b = b[:len(b)-1]
	}
	return lastBreak(b, true) + 1
}

const (
	lo7  = 0x7f7f7f7f7f7f7f7f
	hi8  = 0x8080808080808080
	ones = 0x0101010101010101
)

// lowerASCII writes src with A-Z lowered into dst (same length). Bytes ≥ 0x80
// are copied unchanged, so offsets and UTF-8 sequences are preserved.
func lowerASCII(dst, src []byte) {
	n := len(src)
	i := 0
	for ; i+8 <= n; i += 8 {
		x := binary.LittleEndian.Uint64(src[i:])
		h := x & lo7
		geA := h + (0x80-'A')*ones // high bit set where byte >= 'A'
		gtZ := h + (0x80-'Z'-1)*ones
		up := (geA &^ gtZ) &^ x & hi8 // ASCII upper-case letters
		binary.LittleEndian.PutUint64(dst[i:], x|(up>>2))
	}
	for ; i < n; i++ {
		c := src[i]
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		dst[i] = c
	}
}

func (ws *wstate) findLits(data, hay []byte, hasCR bool) {
	m := ws.m
	c := ws.cands[:0]
	for ei := range m.lits {
		e := &m.lits[ei]
		h := data
		if e.fold {
			h = hay
		}
		needle := e.s
		i := 0
		for i+len(needle) <= len(h) {
			j := bytes.Index(h[i:], needle)
			if j < 0 {
				break
			}
			p := i + j
			q := p + len(needle)
			if e.word && ((p > 0 && isWordByte(h[p-1])) || (q < len(h) && isWordByte(h[q]))) {
				i = p + 1
				continue
			}
			c = append(c, cand{pos: int32(p), entry: int32(ei)})
			// One candidate per line and literal is enough: skip to next line.
			k := indexBreak(h[q:], hasCR)
			if k < 0 {
				break
			}
			i = q + k + 1
		}
	}
	if len(m.lits) > 1 && len(c) > 1 {
		slices.SortFunc(c, func(a, b cand) int { return int(a.pos) - int(b.pos) })
	}
	ws.cands = c
}

// findLongLines appends the lines of data (complete lines) that are at least
// LongLineMin bytes long. Local line indexes start at lineBase.
func findLongLines(data []byte, base int64, lineBase int64, hasCR bool, out []longLine) []longLine {
	if len(data) < LongLineMin {
		return out
	}
	pos := 0
	for pos+LongLineMin <= len(data) {
		w := data[pos : pos+LongLineMin]
		if q := lastBreak(w, hasCR); q >= 0 {
			pos += q + 1
			continue
		}
		// No break in LongLineMin bytes: the line starting at pos is long. (pos
		// never sits on the '\n' of a "\r\n": w would contain that '\n'.)
		le, next := lineEnd(data, pos, hasCR)
		idx := countBreaks(data[:pos], hasCR)
		out = append(out, longLine{line: lineBase + idx, start: base + int64(pos), end: base + int64(le), next: base + int64(next)})
		pos = next
	}
	return out
}

// scanBuf matches the complete lines in data (file offset base). The last line
// may lack a line break only at the end of the file. Hits get region-local line
// indexes starting at lineBase. It stops once out holds capHits hits (full).
// Returns the hits, the number of lines, full.
func (ws *wstate) scanBuf(data []byte, base int64, out []hit, lineBase int64, capHits int, longs *[]longLine) ([]hit, int64, bool) {
	if len(data) == 0 {
		return out, 0, false
	}
	hasCR := bytes.IndexByte(data, '\r') >= 0
	nlines := countBreaks(data, hasCR)
	if !isTerm(data[len(data)-1]) {
		nlines++
	}
	if longs != nil {
		*longs = findLongLines(data, base, lineBase, hasCR, *longs)
	}
	ws.lowPtr = nil // the buffer holds new bytes: forget the lower-cased line
	m := ws.m
	if len(m.rules) == 0 {
		return out, nlines, false
	}
	if bytes.IndexByte(data, esc) >= 0 {
		// ANSI colour codes: lines are judged without them, one by one (ansi.go)
		out, full := ws.scanBufLines(data, base, out, lineBase, capHits, hasCR)
		return out, nlines, full
	}
	if !m.litMode {
		var idx int64
		for pos := 0; pos < len(data); idx++ {
			le, next := lineEnd(data, pos, hasCR)
			line := data[pos:le]
			if mask, s := ws.lineHitDFA(line); ws.lineHit(mask) {
				out = ws.addHit(out, hit{line: lineBase + idx, start: base + int64(pos), end: base + int64(le), mask: mask, col: utf16Col(line, s)})
				if len(out) >= capHits {
					return out, nlines, true
				}
			}
			pos = next
		}
		return out, nlines, false
	}
	hay := data
	if m.needFold {
		if cap(ws.fold) < len(data) {
			ws.fold = make([]byte, len(data))
		}
		hay = ws.fold[:len(data)]
		lowerASCII(hay, data)
	}
	ws.findLits(data, hay, hasCR)
	cands := ws.cands
	if len(cands) == 0 {
		return out, nlines, false
	}
	var idx int64
	curNext := 0
	first := true
	for k := 0; k < len(cands); {
		p := int(cands[k].pos)
		from := 0
		if !first {
			from = curNext
		}
		ls := lineStartBefore(data, from, p, hasCR)
		if first {
			idx = countBreaks(data[:ls], hasCR)
		} else {
			idx += 1 + countBreaks(data[from:ls], hasCR)
		}
		first = false
		curEnd, nx := lineEnd(data, ls, hasCR)
		curNext = nx
		lim := curNext
		if curNext == curEnd { // last line without a break
			lim = len(data) + 1
		}
		line := data[ls:curEnd]
		var got uint64
		best := len(line) + 1
		var need []int
		for k < len(cands) && int(cands[k].pos) < lim {
			e := &m.lits[cands[k].entry]
			if e.verify {
				if !slices.Contains(need, e.rule) {
					need = append(need, e.rule)
				}
			} else if !ws.hasRule(got, e.rule) {
				ws.setRule(&got, e.rule)
				if s := int(cands[k].pos) - ls; s < best {
					best = s
				}
			}
			k++
		}
		for _, ri := range need {
			if ok, s := ws.ruleStart(ri, line, best, -1); ok {
				ws.setRule(&got, ri)
				if s < best {
					best = s
				}
			}
		}
		if ws.lineHit(got) {
			out = ws.addHit(out, hit{line: lineBase + idx, start: base + int64(ls), end: base + int64(curEnd), mask: got, col: utf16Col(line, best)})
			if len(out) >= capHits {
				return out, nlines, true
			}
		}
		if curNext >= len(data) {
			break
		}
	}
	return out, nlines, false
}
