package linefilter

import (
	"errors"
	"math/bits"
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode/utf8"
)

// A set DFA runs several rules in one pass over a line and reports which of
// them matched (like RE2::Set): the rules are compiled separately and merged
// into one program whose Match instructions stay apart, and a state remembers
// which rules' matches ended on the way into it. It never stops at the first
// match, so one pass decides every rule of the group — the rules' own DFAs are
// then only needed to find where a match starts (the column).

// newSetProgInfo builds the merged program of srcs (at most 64).
func newSetProgInfo(srcs []string) (*progInfo, error) {
	if len(srcs) == 0 || len(srcs) > 64 {
		return nil, errors.New("set size")
	}
	merged := &syntax.Prog{}
	var starts []int
	var matchBit []uint64
	for i, src := range srcs {
		p, err := syntax.Parse(src, syntax.Perl)
		if err != nil {
			return nil, err
		}
		sub, err := syntax.Compile(p.Simplify())
		if err != nil {
			return nil, err
		}
		base := uint32(len(merged.Inst))
		for _, in := range sub.Inst {
			switch in.Op {
			case syntax.InstAlt, syntax.InstAltMatch:
				in.Out += base
				in.Arg += base
			case syntax.InstMatch, syntax.InstFail:
			default:
				in.Out += base
			}
			if in.Op == syntax.InstMatch {
				matchBit = append(matchBit, 1<<uint(i))
			} else {
				matchBit = append(matchBit, 0)
			}
			merged.Inst = append(merged.Inst, in)
		}
		starts = append(starts, int(base)+sub.Start)
	}
	// Alternation over the starts: Alt(s0, Alt(s1, ... s_n-1)).
	start := starts[len(starts)-1]
	for i := len(starts) - 2; i >= 0; i-- {
		merged.Inst = append(merged.Inst, syntax.Inst{Op: syntax.InstAlt, Out: uint32(starts[i]), Arg: uint32(start)})
		matchBit = append(matchBit, 0)
		start = len(merged.Inst) - 1
	}
	merged.Start = start
	alt := make([]string, len(srcs))
	for i, s := range srcs {
		alt[i] = "(?:" + s + ")"
	}
	re, err := regexp.Compile(strings.Join(alt, "|"))
	if err != nil {
		return nil, err
	}
	pi := &progInfo{src: re.String(), prog: merged, re: re, matchBit: matchBit}
	if err := pi.buildClasses(); err != nil {
		return nil, err
	}
	return pi, nil
}

// matchSet runs a set DFA over line: the mask of rules (bit k = the group's
// k-th rule) with a match, and in ends[k] where rule k's first match was seen
// (every match ending first starts at or before it). Check d.failed after.
func (d *dfa) matchSet(line []byte, ends *[64]int32) uint64 {
	if d.stale {
		d.stale = false
		d.reset()
	}
	s := d.start[0]
	d.lastI = 0
	var mask uint64
	note := func(mm uint64, i int) {
		for nb := mm &^ mask; nb != 0; nb &= nb - 1 {
			k := trailingZeros64(nb)
			ends[k] = int32(i)
		}
		mask |= mm
	}
	ascii := &d.pi.ascii
	for i := 0; i < len(line); {
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
			if ns.mm != 0 && ns.mm&^mask != 0 {
				note(ns.mm, i)
			}
			s = ns
			i++
		}
		if i >= len(line) {
			break
		}
		ns, w := d.next(s, line, i)
		if d.failed {
			return 0
		}
		if ns.mm != 0 && ns.mm&^mask != 0 {
			note(ns.mm, i)
		}
		s = ns
		i += w
	}
	d.work += int64(len(line) - d.lastI)
	if s.end == 0 {
		d.step(s, endOfText)
		s.endMask = d.lastMM
		s.end = 2
	}
	if s.endMask&^mask != 0 {
		note(s.endMask, len(line))
	}
	return mask
}

func trailingZeros64(x uint64) int { return bits.TrailingZeros64(x) }
