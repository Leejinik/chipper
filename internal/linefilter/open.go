package linefilter

import (
	"encoding/binary"
	"sort"
)

// 「⋯ N줄 생략」 펼치기: a view can open stretches of the lines left out (the
// Open argument of RowsOpen / RowOfLineOpen / FindOpen — file line numbers,
// so they hold whatever the rules or the chips are). Opened lines are laid out
// with the hit blocks: nothing is scanned again, a line is read from the file
// only when its row is asked for (as for the context lines), and the layout
// costs O(hit blocks + stretches). A stretch of opened lines that no hit block
// covers ("open run") gets a fold row (Row.Fold) just above it — 「▾ 접기」 in
// the view — and its lines come as Row.Open. Where a hit block meets an opened
// stretch the block wins (its lines stay hit / context rows), so the run is
// what is left of the stretch around the blocks.
//
// Opened lines count against MaxRows and MaxBytes like the others.

type span struct{ lo, hi int64 }

// MaxOpen: stretches one request can hold open (the rest are ignored).
const MaxOpen = 10_000

// openSet: a request's open stretches, sorted and merged (none overlap or
// touch), and a key naming them (layout and byte-mark caches).
type openSet struct {
	spans []span
	key   string
}

// normOpen reads the flat [lo0, hi0, lo1, hi1, …] list (1-based, inclusive).
func normOpen(flat []int64) openSet {
	var sp []span
	for i := 0; i+1 < len(flat); i += 2 {
		lo, hi := flat[i], flat[i+1]
		if lo < 1 {
			lo = 1
		}
		if hi < lo {
			continue
		}
		sp = append(sp, span{lo, hi})
	}
	if len(sp) == 0 {
		return openSet{}
	}
	sort.Slice(sp, func(a, b int) bool { return sp[a].lo < sp[b].lo })
	out := sp[:1]
	for _, s := range sp[1:] {
		last := &out[len(out)-1]
		if s.lo <= last.hi+1 {
			if s.hi > last.hi {
				last.hi = s.hi
			}
			continue
		}
		out = append(out, s)
	}
	if len(out) > MaxOpen {
		out = out[:MaxOpen]
	}
	b := make([]byte, 0, len(out)*8)
	for _, s := range out {
		b = binary.AppendVarint(b, s.lo)
		b = binary.AppendVarint(b, s.hi)
	}
	return openSet{spans: out, key: string(b)}
}

// firstDiff: the first line opened in one set and not in the other (-1: the
// same lines). Both are normalized (merged), so the sets are equal iff the
// lists are.
func firstDiff(a, b []span) int64 {
	for i := 0; ; i++ {
		switch {
		case i >= len(a) && i >= len(b):
			return -1
		case i >= len(a):
			return b[i].lo
		case i >= len(b):
			return a[i].lo
		case a[i] == b[i]:
			continue
		case a[i].lo != b[i].lo:
			return min(a[i].lo, b[i].lo)
		default:
			return min(a[i].hi, b[i].hi) + 1
		}
	}
}

// mergeOpen lays the open runs (the stretches minus the hit blocks, up to line
// limit) between the hit blocks. nh: hits laid out (an open run's h0 = h1 =
// the first hit after it).
func mergeOpen(blocks []interval, spans []span, limit int64, nh int) []interval {
	out := make([]interval, 0, len(blocks)+len(spans)+8)
	k := 0 // next block to place
	run := func(lo, hi int64) {
		for k < len(blocks) && blocks[k].lo < lo {
			out = append(out, blocks[k])
			k++
		}
		h := nh
		if k < len(blocks) {
			h = blocks[k].h0
		}
		out = append(out, interval{lo: lo, hi: hi, h0: h, h1: h, open: true})
	}
	b := 0 // first block that can meet the stretch
	for _, s := range spans {
		if s.lo > limit {
			break
		}
		hi := min(s.hi, limit)
		for b < len(blocks) && blocks[b].hi < s.lo {
			b++
		}
		cur := s.lo
		for cur <= hi {
			if b < len(blocks) && blocks[b].lo <= hi {
				if blocks[b].lo > cur {
					run(cur, blocks[b].lo-1)
				}
				if blocks[b].hi+1 > cur {
					cur = blocks[b].hi + 1
				}
				if blocks[b].hi <= hi {
					b++
				}
				continue
			}
			run(cur, hi)
			break
		}
	}
	return append(out, blocks[k:]...)
}

// startNear: the known line start nearest at or before line x — a hit, a
// region start (cps), a line met while reading rows (seen), a long line.
func (rd *rowReader) startNear(x int64, hk int) linePos {
	best := linePos{1, rd.dataStart}
	if hk >= 0 {
		best = linePos{rd.hits[hk].line, rd.hits[hk].start}
	}
	if k := sort.Search(len(rd.cps), func(i int) bool { return rd.cps[i].line > x }) - 1; k >= 0 && rd.cps[k].line > best.line {
		best = rd.cps[k]
	}
	if k := sort.Search(len(rd.seen), func(i int) bool { return rd.seen[i].line > x }) - 1; k >= 0 && rd.seen[k].line > best.line {
		best = rd.seen[k]
	}
	if k := sort.Search(len(rd.longs), func(i int) bool { return rd.longs[i].line > x }) - 1; k >= 0 && rd.longs[k].line > best.line {
		best = linePos{rd.longs[k].line, rd.longs[k].start}
	}
	return best
}

// inherit: byte marks of a new open set start from those of the set it was
// made from (same context sizes): rows before the first line that differs are
// the same rows, so their marks hold — opening a stretch does not read again
// every row above it. bm.mu is held; parent is older than bm (lock order).
func (bm *byteMarks) inherit() {
	p, keepTo := bm.parent, bm.keepTo
	bm.parent = nil
	if p == nil || keepTo <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.version != bm.version {
		return
	}
	k := sort.SearchInts(p.rows, keepTo+1)
	bm.rows = append([]int(nil), p.rows[:k]...)
	bm.bytes = append([]int64(nil), p.bytes[:k]...)
	if p.capRow >= 0 && p.capRow < keepTo {
		bm.capRow = p.capRow
	}
}

// pickParent: of the byte marks for (A, B) with another open set, the one
// sharing the longest prefix of rows with lay (j.mu held).
func (j *job) pickParent(A, B int64, op openSet, lay *layout) (*byteMarks, int) {
	var best *byteMarks
	bestTo := 0
	for k, m := range j.marks {
		if k.A != A || k.B != B || k.open == op.key || m.version != j.version {
			continue
		}
		d := firstDiff(m.open, op.spans)
		if d < 0 {
			continue
		}
		// rows before the row of line d — less its fold row and the gap row
		// above, which can differ — are the same in both layouts
		to := lay.rowAtLine(d) - 2
		if to > bestTo {
			best, bestTo = m, to
		}
	}
	return best, bestTo
}
