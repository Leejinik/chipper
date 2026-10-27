package linefilter

import (
	"encoding/binary"
	"fmt"
	"regexp"
	"regexp/syntax"
	"slices"
	"unicode"
	"unicode/utf8"
)

// A lazy DFA answering "does this line contain a match, and where does the
// earliest match end?". It runs the RE2 program regexp compiles
// (regexp/syntax), builds DFA states on demand and caches transitions, so a
// cached step is a table lookup per byte instead of the stdlib's NFA (measured
// 4–70µs per log line for the default rules). Empty-width assertions (\b \B ^ $)
// are resolved at transition time, when both neighbouring characters are known.
//
// Transitions are indexed by byte class: characters that every instruction
// treats alike share one class (computed once per program, see progInfo), so a
// state is a few hundred bytes. Each DFA has a memory limit; when the cache is
// full it is flushed (memory stays bounded). If flushes come too often for the
// text processed (fewer than 10 bytes per state, as RE2 decides), the DFA gives
// up (failed) and the caller switches to something else. Each worker has its own
// DFAs (no locking); progInfo is shared and read-only.
//
// Anchored DFAs (no restart at every position) find where the first match
// starts: try each start position up to the earliest match end.

// progInfo is one compiled program plus its byte classes.
type progInfo struct {
	src   string
	prog  *syntax.Prog
	re    *regexp.Regexp // stdlib fallback
	ascii [128]uint16
	hiLo  []rune // starts of the class intervals at or above 0x80
	hiCls []uint16
	ncls  int
	// matchBit (set programs, see newSetProgInfo): for each Match
	// instruction, the bit of the rule it belongs to; nil for one regex.
	matchBit []uint64
}

func newProgInfo(src string) (*progInfo, error) {
	re, err := regexp.Compile(src)
	if err != nil {
		return nil, err
	}
	p, err := syntax.Parse(src, syntax.Perl)
	if err != nil {
		return nil, err
	}
	prog, err := syntax.Compile(p.Simplify())
	if err != nil {
		return nil, err
	}
	pi := &progInfo{src: src, prog: prog, re: re}
	if err := pi.buildClasses(); err != nil {
		return nil, err
	}
	return pi, nil
}

func instMatches(in *syntax.Inst, r rune) bool {
	switch in.Op {
	case syntax.InstRune1:
		return r == in.Rune[0]
	case syntax.InstRune:
		return in.MatchRune(r)
	case syntax.InstRuneAnyNotNL:
		return r != '\n'
	}
	return true
}

func (pi *progInfo) buildClasses() error {
	bs := map[rune]bool{0: true, 0x80: true}
	add := func(lo, hi rune) {
		bs[lo] = true
		if hi < unicode.MaxRune {
			bs[hi+1] = true
		}
	}
	add('0', '9')
	add('A', 'Z')
	add('a', 'z')
	add('_', '_')
	add('\n', '\n')
	var rin []*syntax.Inst
	for i := range pi.prog.Inst {
		in := &pi.prog.Inst[i]
		switch in.Op {
		case syntax.InstRune1:
			add(in.Rune[0], in.Rune[0])
			rin = append(rin, in)
		case syntax.InstRune:
			if len(in.Rune) == 1 {
				r0 := in.Rune[0]
				add(r0, r0)
				if syntax.Flags(in.Arg)&syntax.FoldCase != 0 {
					for f := unicode.SimpleFold(r0); f != r0; f = unicode.SimpleFold(f) {
						add(f, f)
					}
				}
			} else {
				for k := 0; k+1 < len(in.Rune); k += 2 {
					add(in.Rune[k], in.Rune[k+1])
				}
			}
			rin = append(rin, in)
		case syntax.InstRuneAnyNotNL:
			rin = append(rin, in)
		}
	}
	bounds := make([]rune, 0, len(bs))
	for r := range bs {
		bounds = append(bounds, r)
	}
	slices.Sort(bounds)
	nbits := len(rin) + 1
	sig := make([]byte, (nbits+7)/8)
	ids := map[string]uint16{}
	cls := make([]uint16, len(bounds))
	for k, lo := range bounds {
		clear(sig)
		for j, in := range rin {
			if instMatches(in, lo) {
				sig[j/8] |= 1 << (j % 8)
			}
		}
		if isWordRune(lo) {
			sig[len(rin)/8] |= 1 << (len(rin) % 8)
		}
		id, ok := ids[string(sig)]
		if !ok {
			if len(ids) >= 0xffff {
				return fmt.Errorf("too many byte classes")
			}
			id = uint16(len(ids))
			ids[string(sig)] = id
		}
		cls[k] = id
	}
	pi.ncls = len(ids)
	k := 0
	for c := 0; c < 128; c++ {
		for k+1 < len(bounds) && bounds[k+1] <= rune(c) {
			k++
		}
		pi.ascii[c] = cls[k]
	}
	for k, lo := range bounds {
		if lo >= 0x80 {
			pi.hiLo = append(pi.hiLo, lo)
			pi.hiCls = append(pi.hiCls, cls[k])
		}
	}
	return nil
}

// class of a rune ≥ 0x80.
func (pi *progInfo) class(r rune) int {
	lo, hi := 0, len(pi.hiLo)-1
	for lo < hi {
		m := (lo + hi + 1) / 2
		if pi.hiLo[m] <= r {
			lo = m
		} else {
			hi = m - 1
		}
	}
	return int(pi.hiCls[lo])
}

const endOfText = -1

// dfaMinMem is the smallest cache a DFA gets (a var for tests).
var dfaMinMem = 16 << 10

// smallCls classes are kept inline in the state: one memory load per byte.
const smallCls = 64

type dstate struct {
	insts    []uint32
	small    [smallCls]*dstate // transitions by byte class (the first smallCls classes; ASCII comes first)
	big      []*dstate         // classes from smallCls on
	prevWord bool
	bot      bool   // at the beginning of the line
	dead     bool   // anchored: no thread left
	end      int8   // 0 unknown, 1 match at end of line, 2 no match
	mm       uint64 // set DFA: rules whose match ended on the way into this state
	endMask  uint64 // set DFA: rules matching at the end of the line (when end != 0)
}

var dfaAccept = &dstate{}

func (s *dstate) get(cls int) *dstate {
	if cls < smallCls {
		return s.small[cls]
	}
	return s.big[cls-smallCls]
}

func (s *dstate) set(cls int, ns *dstate) {
	if cls < smallCls {
		s.small[cls] = ns
	} else {
		s.big[cls-smallCls] = ns
	}
}

type dfa struct {
	pi       *progInfo
	anchored bool
	cache    map[string]*dstate
	mem      int
	limit    int
	nstates  int
	start    [3]*dstate // line start; mid-line after a non-word / word character (anchored)
	stale    bool       // the cache was flushed: rebuild the start states at the next line
	work     int64      // bytes processed since the last flush
	lastI    int        // position of the last slow step in the current input
	lastMM   uint64     // set DFA: matches found by the last end-of-line step
	live     []*dstate  // states of the current cache
	retired  []*dstate  // states of flushed caches (may be in use until the next reset)
	free     []*dstate  // reusable states
	bails    int
	failed   bool
	Flushes  int
	// scratch
	seen  []uint32 // generation marks per pc
	gen   uint32
	stack []uint32
	set   []uint32
	cur   []uint32
	key   []byte
}

func newDFA(pi *progInfo, anchored bool, limit int) *dfa {
	if limit < dfaMinMem {
		limit = dfaMinMem
	}
	d := &dfa{pi: pi, anchored: anchored, limit: limit, seen: make([]uint32, len(pi.prog.Inst))}
	d.reset()
	return d
}

func (d *dfa) reset() {
	// At a reset (start of a line or of a new DFA) no state is in use any
	// more: every allocated state goes back to the free list, so a DFA whose
	// cache keeps overflowing makes no garbage.
	d.free = append(d.free, d.retired...)
	d.free = append(d.free, d.live...)
	d.retired, d.live = d.retired[:0], d.live[:0]
	if d.cache == nil {
		d.cache = make(map[string]*dstate, 64)
	} else {
		clear(d.cache)
	}
	d.mem, d.nstates = 0, 0
	d.gen++
	d.set = d.set[:0]
	d.addClosure(uint32(d.pi.prog.Start), 0, false)
	base := append([]uint32(nil), d.set...)
	d.start[0] = d.intern(append([]uint32(nil), base...), false, true)
	if d.anchored {
		d.start[1] = d.intern(append([]uint32(nil), base...), false, false)
		d.start[2] = d.intern(base, true, false)
	}
}

// addClosure adds pc and everything reachable without consuming a character.
// With resolve=false an EmptyWidth instruction is kept as is (its condition is
// not known yet); with resolve=true it is followed when flags satisfy it.
func (d *dfa) addClosure(pc uint32, flags syntax.EmptyOp, resolve bool) {
	d.stack = append(d.stack[:0], pc)
	for len(d.stack) > 0 {
		pc := d.stack[len(d.stack)-1]
		d.stack = d.stack[:len(d.stack)-1]
		if d.seen[pc] == d.gen {
			continue
		}
		d.seen[pc] = d.gen
		in := &d.pi.prog.Inst[pc]
		switch in.Op {
		case syntax.InstAlt, syntax.InstAltMatch:
			d.stack = append(d.stack, in.Arg, in.Out)
		case syntax.InstNop, syntax.InstCapture:
			d.stack = append(d.stack, in.Out)
		case syntax.InstEmptyWidth:
			if resolve {
				if syntax.EmptyOp(in.Arg)&^flags == 0 {
					d.stack = append(d.stack, in.Out)
				}
			} else {
				d.set = append(d.set, pc)
			}
		case syntax.InstFail:
		default: // Rune*, Match
			d.set = append(d.set, pc)
		}
	}
}

func (d *dfa) intern(set []uint32, prevWord, bot bool) *dstate {
	return d.internM(set, prevWord, bot, 0)
}

func (d *dfa) internM(set []uint32, prevWord, bot bool, mm uint64) *dstate {
	slices.Sort(set)
	k := d.key[:0]
	var fl byte
	if prevWord {
		fl |= 1
	}
	if bot {
		fl |= 2
	}
	k = append(k, fl)
	if d.pi.matchBit != nil {
		k = binary.LittleEndian.AppendUint64(k, mm)
	}
	for _, pc := range set {
		k = binary.LittleEndian.AppendUint32(k, pc)
	}
	d.key = k
	if s := d.cache[string(k)]; s != nil {
		return s
	}
	cost := 112 + 8*smallCls + 4*len(set) + 2*len(k)
	if d.pi.ncls > smallCls {
		cost += 8 * (d.pi.ncls - smallCls)
	}
	if d.mem+cost > d.limit && d.nstates > 0 {
		// Flush. RE2's rule: giving up beats rebuilding states for every few
		// bytes of text.
		if d.work < int64(10*d.nstates) {
			d.bails++
			if d.bails >= 2 {
				d.failed = true
			}
		} else {
			d.bails = 0
		}
		d.Flushes++
		// The states may still be in use until the end of this line: keep
		// them out of the free list until the next reset.
		d.retired = append(d.retired, d.live...)
		d.live = d.live[:0]
		clear(d.cache)
		d.mem, d.nstates, d.work = 0, 0, 0
		d.stale = true
	}
	var s *dstate
	if n := len(d.free); n > 0 {
		s = d.free[n-1]
		d.free = d.free[:n-1]
		insts, big := s.insts[:0], s.big
		clear(big)
		*s = dstate{insts: append(insts, set...), big: big, prevWord: prevWord, bot: bot, mm: mm}
	} else {
		s = &dstate{insts: append([]uint32(nil), set...), prevWord: prevWord, bot: bot, mm: mm}
		if d.pi.ncls > smallCls {
			s.big = make([]*dstate, d.pi.ncls-smallCls)
		}
	}
	d.live = append(d.live, s)
	s.dead = len(set) == 0
	d.cache[string(k)] = s
	d.mem += cost
	d.nstates++
	return s
}

func isWordRune(r rune) bool {
	return r < utf8.RuneSelf && r >= 0 && isWordByte(byte(r))
}

// step computes the transition of s on r (endOfText for the end of the line).
// Returns dfaAccept when a match has been found (nil at the end of the line
// when there is none).
func (d *dfa) step(s *dstate, r rune) *dstate {
	var flags syntax.EmptyOp
	if s.bot {
		flags |= syntax.EmptyBeginLine | syntax.EmptyBeginText
	}
	nextWord := false
	if r == endOfText {
		flags |= syntax.EmptyEndLine | syntax.EmptyEndText
	} else {
		nextWord = isWordRune(r)
	}
	if s.prevWord != nextWord {
		flags |= syntax.EmptyWordBoundary
	} else {
		flags |= syntax.EmptyNoWordBoundary
	}
	// Resolve assertions now that both neighbours are known.
	d.gen++
	d.set = d.set[:0]
	for _, pc := range s.insts {
		d.addClosure(pc, flags, true)
	}
	d.cur = append(d.cur[:0], d.set...)
	var mm uint64
	for _, pc := range d.cur {
		if d.pi.prog.Inst[pc].Op == syntax.InstMatch {
			if d.pi.matchBit == nil {
				return dfaAccept
			}
			mm |= d.pi.matchBit[pc]
		}
	}
	if r == endOfText {
		d.lastMM = mm
		return nil
	}
	d.gen++
	d.set = d.set[:0]
	for _, pc := range d.cur {
		in := &d.pi.prog.Inst[pc]
		ok := false
		switch in.Op {
		case syntax.InstRune1:
			ok = r == in.Rune[0]
		case syntax.InstRune:
			ok = in.MatchRune(r)
		case syntax.InstRuneAny:
			ok = true
		case syntax.InstRuneAnyNotNL:
			ok = r != '\n'
		}
		if ok {
			d.addClosure(in.Out, 0, false)
		}
	}
	if !d.anchored {
		d.addClosure(uint32(d.pi.prog.Start), 0, false)
	}
	return d.internM(d.set, nextWord, false, mm)
}

// next is one transition from s at line[i:]: the next state and the width read.
// ns == nil with d.failed: the DFA gave up.
func (d *dfa) next(s *dstate, line []byte, i int) (*dstate, int) {
	c := line[i]
	if c < utf8.RuneSelf {
		cls := d.pi.ascii[c]
		if ns := s.get(int(cls)); ns != nil {
			return ns, 1
		}
		d.work += int64(i - d.lastI)
		d.lastI = i
		ns := d.step(s, rune(c))
		s.set(int(cls), ns)
		return ns, 1
	}
	r, w := utf8.DecodeRune(line[i:])
	cls := d.pi.class(r)
	if ns := s.get(cls); ns != nil {
		return ns, w
	}
	d.work += int64(i - d.lastI)
	d.lastI = i
	ns := d.step(s, r)
	s.set(cls, ns)
	return ns, w
}

func (d *dfa) atEnd(s *dstate) bool {
	switch s.end {
	case 1:
		return true
	case 2:
		return false
	}
	ok := d.step(s, endOfText) == dfaAccept
	if ok {
		s.end = 1
	} else {
		s.end = 2
	}
	return ok
}

// match reports whether line (no line breaks) contains a match, and the
// position where the earliest-ending match was detected (every match that ends
// first starts at or before it). Check d.failed after a false result.
func (d *dfa) match(line []byte) (bool, int) {
	if d.stale {
		d.stale = false
		d.reset()
	}
	s := d.start[0]
	d.lastI = 0
	ascii := &d.pi.ascii
	for i := 0; i < len(line); {
		// Fast path: cached ASCII transitions, no call.
		for i < len(line) {
			c := line[i]
			if c >= utf8.RuneSelf {
				break
			}
			cls := ascii[c]
			var ns *dstate
			if cls < smallCls {
				ns = s.small[cls]
			} else {
				ns = s.big[cls-smallCls]
			}
			if ns == nil {
				break
			}
			if ns == dfaAccept {
				d.work += int64(i - d.lastI)
				return true, i
			}
			s = ns
			i++
		}
		if i >= len(line) {
			break
		}
		ns, w := d.next(s, line, i)
		if d.failed {
			return false, -1
		}
		if ns == dfaAccept {
			d.work += int64(i - d.lastI)
			return true, i
		}
		s = ns
		i += w
	}
	d.work += int64(len(line) - d.lastI)
	return d.atEnd(s), len(line)
}

// anchoredAt reports whether a match starts exactly at p. budget counts steps
// across calls; at 0 it gives up (returns false; the caller checks *budget).
func (d *dfa) anchoredAt(line []byte, p int, budget *int) bool {
	if d.stale {
		d.stale = false
		d.reset()
	}
	s := d.start[0]
	if p > 0 {
		// Only ASCII characters are word characters, and an ASCII byte is never
		// part of a longer sequence.
		if isWordByte(line[p-1]) {
			s = d.start[2]
		} else {
			s = d.start[1]
		}
	}
	d.lastI = p
	for i := p; i < len(line); {
		if s.dead {
			return false
		}
		*budget--
		if *budget < 0 {
			return false
		}
		ns, w := d.next(s, line, i)
		if d.failed {
			return false
		}
		if ns == dfaAccept {
			return true
		}
		s = ns
		i += w
	}
	if s.dead {
		return false
	}
	return d.atEnd(s)
}

// firstStart finds the first position ≤ maxStart where a match starts. ok=false:
// the step budget ran out or the DFA gave up (use the stdlib instead).
func (d *dfa) firstStart(line []byte, maxStart int, budget int) (int, bool) {
	if maxStart > len(line) {
		maxStart = len(line)
	}
	for p := 0; p <= maxStart; {
		if p == len(line) {
			if d.anchoredAt(line, p, &budget) {
				return p, true
			}
			break
		}
		if d.anchoredAt(line, p, &budget) {
			return p, true
		}
		if budget < 0 || d.failed {
			return -1, false
		}
		if line[p] < utf8.RuneSelf {
			p++
		} else {
			_, w := utf8.DecodeRune(line[p:])
			p += w
		}
	}
	return -1, true
}

// streamBegin / feed / feedEnd judge a line too long to hold in memory, piece
// by piece. Every piece but the last must end on a character boundary.
func (d *dfa) streamBegin() *dstate {
	if d.stale {
		d.stale = false
		d.reset()
	}
	return d.start[0]
}

func (d *dfa) feed(s *dstate, data []byte) (*dstate, bool) {
	d.lastI = 0
	for i := 0; i < len(data); {
		ns, w := d.next(s, data, i)
		if d.failed {
			return nil, false
		}
		if ns == dfaAccept {
			return dfaAccept, true
		}
		s = ns
		i += w
	}
	d.work += int64(len(data) - d.lastI)
	return s, false
}

func (d *dfa) feedEnd(s *dstate) bool {
	if s == dfaAccept {
		return true
	}
	return d.atEnd(s)
}

// runeCut returns the length of the longest prefix of b that does not end in
// the middle of a (possibly valid) UTF-8 sequence.
func runeCut(b []byte) int {
	n := len(b)
	for k := 1; k <= 3 && k <= n; k++ {
		c := b[n-k]
		if c < utf8.RuneSelf {
			return n
		}
		if utf8.RuneStart(c) {
			if utf8.FullRune(b[n-k:]) {
				return n
			}
			return n - k
		}
	}
	return n
}
