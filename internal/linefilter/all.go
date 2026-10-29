package linefilter

import (
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// 「📖 읽기 보기」 (Request.Mode "all"): every line of the file is a row, but the
// lines an Exclude rule matches, which are hidden. The job is an ordinary scan
// whose rules are those Exclude rules, so its hits are the hidden lines (sorted,
// with their offsets); besides them it keeps where every region starts (cps) —
// a line start every ~2MB. A page of rows is read from the file: from the
// nearest known line start (a region, a hidden line, a line met while reading
// earlier pages) forward to the asked line, then line by line, skipping hidden
// ones. Nothing grows with the file but the region list (150 entries for 300MB)
// and the hidden lines, and the 20만-row / 64MB caps of 「🏷 줄만」 do not apply.
//
// Row r (0-based) ↔ line L: L − 1 − (hidden lines before L) = r.

type linePos struct{ line, off int64 }

// notePosLocked: a published region starts at line `line`, offset off.
func (j *job) notePosLocked(line, off int64) {
	if n := len(j.cps); n > 0 && j.cps[n-1].line >= line {
		return
	}
	j.cps = append(j.cps, linePos{line, off})
}

// cutPos keeps the positions of lines before `line` (a new slice: readers may
// still hold the old one).
func cutPos(ps []linePos, line int64) []linePos {
	k := sort.Search(len(ps), func(i int) bool { return ps[i].line >= line })
	return append([]linePos(nil), ps[:k]...)
}

const maxSeen = 4096

// noteSeen remembers a line start met while reading rows.
func (j *job) noteSeen(line, off int64, version int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.version != version || line < 1 {
		return
	}
	k := sort.Search(len(j.seen), func(i int) bool { return j.seen[i].line >= line })
	if k < len(j.seen) && j.seen[k].line == line {
		return
	}
	if len(j.seen) >= maxSeen {
		j.seen = nil
		k = 0
	}
	ns := make([]linePos, 0, len(j.seen)+1)
	ns = append(ns, j.seen[:k]...)
	ns = append(ns, linePos{line, off})
	ns = append(ns, j.seen[k:]...)
	j.seen = ns
}

// allLinesLocked: the lines that can be shown now — all of them once the scan
// is over (the editor's count: a last empty line after a final break), the
// lines scanned so far before.
func (j *job) allLinesLocked() int64 {
	if j.done && !j.following && !j.truncated && j.err == nil && !j.canceled && j.totalLines > 0 {
		return j.totalLines
	}
	return j.scannedLines
}

// allSnap is what a page read needs, taken under j.mu.
type allSnap struct {
	hidden    []hit
	lines     int64
	final     bool
	cps, seen []linePos
	longs     []longLine
	path      string
	dataStart int64
	size      int64
	end       int64 // scanned part of the read file
	version   int
}

func (j *job) allSnapLocked() allSnap {
	s := allSnap{
		hidden: j.hits[:len(j.hits):len(j.hits)], lines: j.allLinesLocked(), final: j.done && !j.following,
		cps: j.cps[:len(j.cps):len(j.cps)], seen: j.seen[:len(j.seen):len(j.seen)], longs: j.longs[:len(j.longs):len(j.longs)],
		path: j.readPath, dataStart: j.dataStart, size: j.size, end: j.scannedOff, version: j.version,
	}
	if s.final {
		s.end = j.size
	}
	return s
}

func (s *allSnap) rows() int64 { return s.lines - int64(len(s.hidden)) }

// lineOfRow: the line shown by row r (0-based) and the index of the first
// hidden line after it.
func (s *allSnap) lineOfRow(r int64) (int64, int) {
	h := s.hidden
	k := sort.Search(len(h), func(i int) bool { return h[i].line-int64(i) > r+1 })
	return r + 1 + int64(k), k
}

// rowOfLine: the row showing line L, or the first row after it when L is hidden.
func (s *allSnap) rowOfLine(L int64) int64 {
	h := s.hidden
	k := sort.Search(len(h), func(i int) bool { return h[i].line >= L })
	return L - 1 - int64(k)
}

// startNear: the known line start closest at or before line L.
func (s *allSnap) startNear(L int64) linePos {
	best := linePos{1, s.dataStart}
	if k := sort.Search(len(s.cps), func(i int) bool { return s.cps[i].line > L }) - 1; k >= 0 {
		best = s.cps[k]
	}
	if k := sort.Search(len(s.seen), func(i int) bool { return s.seen[i].line > L }) - 1; k >= 0 && s.seen[k].line > best.line {
		best = s.seen[k]
	}
	if k := sort.Search(len(s.hidden), func(i int) bool { return s.hidden[i].line > L }) - 1; k >= 0 && s.hidden[k].line > best.line {
		best = linePos{s.hidden[k].line, s.hidden[k].start}
	}
	if k := sort.Search(len(s.longs), func(i int) bool { return s.longs[i].line > L }) - 1; k >= 0 && s.longs[k].line > best.line {
		best = linePos{s.longs[k].line, s.longs[k].start}
	}
	return best
}

// allRows answers Rows for a mode "all" job.
func (e *Engine) allRows(id string, j *job, from, count int) (Page, error) {
	page := Page{JobID: id, From: from, Rows: []Row{}}
	j.mu.Lock()
	page.Progress = j.progressLocked()
	page.Progress.JobID = id
	page.Version = j.version
	if j.changed {
		page.Changed = true
		page.Total = -1
		j.mu.Unlock()
		return page, nil
	}
	j.lastUse = time.Now()
	s := j.allSnapLocked()
	truncated := j.truncated
	j.mu.Unlock()
	n := s.rows()
	page.Available, page.Total = int(n), -1
	if s.final {
		page.Total = int(n)
	}
	if truncated {
		page.Truncated = "rows"
	}
	to := int64(from + count)
	if to > n {
		to = n
	}
	if int64(from) < to {
		j.content.RLock()
		rows, err := e.readAllRows(j, &s, int64(from), to)
		j.content.RUnlock()
		if err != nil {
			return page, err
		}
		page.Rows = rows
	}
	if page.Total >= 0 && from+len(page.Rows) >= page.Total {
		page.End = true
	}
	return page, nil
}

// readAllRows reads rows [from, to), stopping early at MaxPageBytes of text.
func (e *Engine) readAllRows(j *job, s *allSnap, from, to int64) ([]Row, error) {
	if s.path == "" {
		return nil, errInternal
	}
	f, err := os.Open(s.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	L, hp := s.lineOfRow(from)
	at := s.startNear(L)
	rd := &rowReader{j: j, longs: s.longs, path: s.path, dataStart: s.dataStart, size: s.size, maxText: e.opt.MaxLineDisplay, f: f}
	lr := &lineReader{f: f, size: s.size, buf: make([]byte, 256<<10), base: at.off, rd: rd}
	rd.lr = lr
	for ln := at.line; ln < L; ln++ {
		if _, _, err := lr.next(0); err != nil {
			return nil, err
		}
	}
	if L-at.line > 64 {
		j.noteSeen(L, lr.pos(), s.version)
	}
	out := make([]Row, 0, min(to-from, 4096))
	var got int64
	for r := from; r < to; L++ {
		if hp < len(s.hidden) && s.hidden[hp].line == L {
			if s.hidden[hp].start != lr.pos() {
				return nil, errInternal
			}
			hp++
			if _, _, err := lr.next(0); err != nil {
				return nil, err
			}
			continue
		}
		text, cut, err := lr.next(e.opt.MaxLineDisplay)
		if err != nil {
			return nil, err
		}
		out = append(out, Row{Line: L, Text: text, TruncatedLine: cut, Col: -1})
		r++
		if got += rowBytes(&out[len(out)-1]); got >= e.opt.MaxPageBytes {
			break
		}
	}
	if to-from > 64 {
		j.noteSeen(L, lr.pos(), s.version)
	}
	return out, nil
}

// allRowOfLine answers RowOfLine for a mode "all" job.
func (j *job) allRowOfLine(line int64) int {
	j.mu.Lock()
	s := j.allSnapLocked()
	j.mu.Unlock()
	if line < 1 {
		line = 1
	}
	return int(s.rowOfLine(line))
}

// allFind answers Find for a mode "all" job: the file's regions are searched
// in parallel with the scan's matcher (the fast DFA — a whole 300MB log, not
// the 20만 rows of 「🏷 줄만」), hidden lines left out.
func (e *Engine) allFind(v *view, j *job, cr []compiledRule, stale func() bool) (FindResult, error) {
	out := FindResult{Rows: []int{}}
	j.checkFile(false)
	j.mu.Lock()
	out.Version = j.version
	if j.changed {
		out.Changed = true
		j.mu.Unlock()
		return out, nil
	}
	j.lastUse = time.Now()
	s := j.allSnapLocked()
	j.mu.Unlock()
	out.Partial = !s.final
	out.Searched = int(s.rows())
	if s.path == "" || len(s.cps) == 0 {
		return out, nil
	}
	type seg struct {
		r    region
		line int64
	}
	segs := make([]seg, len(s.cps))
	for i, c := range s.cps {
		end := s.end
		if i+1 < len(s.cps) {
			end = s.cps[i+1].off
		}
		segs[i] = seg{region{c.off, end}, c.line}
	}
	fj := &job{e: e, m: newMatcher(cr), all: true}
	sr := newScanRun(fj, s.path, 0, 0, false)
	j.content.RLock()
	defer j.content.RUnlock()

	nw := e.opt.Workers
	batch := nw * 2
	mem := e.opt.DFAMemory / nw
	for b0 := 0; b0 < len(segs); b0 += batch {
		if stale() {
			out.Canceled = true
			return out, nil
		}
		b1 := min(b0+batch, len(segs))
		res := make([][]int64, b1-b0)
		var errMu sync.Mutex
		var firstErr error
		fail := func(err error) {
			errMu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			errMu.Unlock()
		}
		var next atomic.Int64
		next.Store(int64(b0))
		var wg sync.WaitGroup
		for w := 0; w < nw && w < b1-b0; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				wb := <-e.pool
				if wb == nil || cap(wb.buf) < e.opt.BufSize {
					wb = &workBuf{buf: make([]byte, 0, e.opt.BufSize)}
				}
				defer func() { e.pool <- wb }()
				ws := newWState(fj.m, mem)
				ws.fold = wb.fold
				defer func() {
					if cap(ws.fold) <= cap(wb.buf) {
						wb.fold = ws.fold
					}
				}()
				f, err := os.Open(s.path)
				if err != nil {
					fail(err)
					return
				}
				defer f.Close()
				for {
					k := int(next.Add(1) - 1)
					if k >= b1 {
						return
					}
					if stale() {
						fj.stop.Store(true)
						return
					}
					sg := segs[k]
					r := sr.processRegion(f, ws, wb, sg.r)
					ws.clearHi()
					if r.err != nil {
						fail(r.err)
						putHits(r.hits)
						return
					}
					lines := make([]int64, 0, len(r.hits))
					for _, h := range r.hits {
						lines = append(lines, sg.line+h.line)
					}
					putHits(r.hits)
					res[k-b0] = lines
				}
			}()
		}
		wg.Wait()
		if stale() {
			out.Canceled = true
			return out, nil
		}
		if firstErr != nil {
			return out, firstErr
		}
		for _, lines := range res {
			for _, L := range lines {
				if L > s.lines {
					break
				}
				k := sort.Search(len(s.hidden), func(i int) bool { return s.hidden[i].line >= L })
				if k < len(s.hidden) && s.hidden[k].line == L {
					continue // hidden
				}
				out.Total++
				if len(out.Rows) < MaxFind {
					out.Rows = append(out.Rows, int(L-1-int64(k)))
				} else {
					out.Capped = true
				}
			}
		}
	}
	return out, nil
}
