package linefilter

import (
	"errors"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

var errCanceled = errors.New("취소됨")
var errShrunk = errors.New("파일이 읽는 도중 짧아졌습니다")

// region is a run of whole lines of the scanned file: it starts at a line
// start and ends at a line start (or the end of the file).
type region struct{ start, end int64 }

type chunkResult struct {
	lines       int64
	hits        []hit
	ext         []uint64 // the hits' rules past the 64th (see hit.ext)
	longs       []longLine
	full        bool    // stopped at MaxRows+1 hits (the rest of the region was not scanned)
	invalid     int64   // bytes that are not UTF-8 (UTF-8 files only)
	invalidLine int64   // region-local index of the first line with one, -1 none
	excluded    int64   // matched lines left out by the exclude rules (whole region scanned so far)
	exBefore    []int64 // per hit: excluded lines before it in the region (with exclude rules only)
	err         error
}

// workBuf is one worker's read window. A bounded pool caps the memory.
type workBuf struct {
	buf  []byte
	fold []byte // ASCII-lower-cased copy (literal path)
}

// scanRun scans one file (or its UTF-8 temp copy) from `from` to the end. The
// bytes may still be arriving (a decoder or gunzip writes the copy): wm is how
// far they can be read, prodDone says no more will come. Regions are planned
// as data arrives, scanned in parallel and published strictly in file order.
type scanRun struct {
	j           *job
	path        string
	from        int64
	linesBefore int64
	checkUTF8   bool

	mu        sync.Mutex
	cond      *sync.Cond
	wm        int64
	prodDone  bool
	prodErr   error
	pf        *os.File
	probe     []byte
	pos       int64
	regions   []region
	results   map[int]*chunkResult
	next      int
	published int
	quit      bool
	failed    error
	linesDone int64
	maxAhead  int
	wakers    []func() // producers waiting on their own conditions
}

func (sr *scanRun) addWaker(f func()) {
	sr.mu.Lock()
	sr.wakers = append(sr.wakers, f)
	sr.mu.Unlock()
}

func (sr *scanRun) wakeProducers() {
	sr.mu.Lock()
	ws := append([]func(){}, sr.wakers...)
	sr.mu.Unlock()
	for _, f := range ws {
		f()
	}
}

func newScanRun(j *job, path string, from, linesBefore int64, checkUTF8 bool) *scanRun {
	sr := &scanRun{j: j, path: path, from: from, linesBefore: linesBefore, checkUTF8: checkUTF8,
		pos: from, wm: from, results: map[int]*chunkResult{}}
	sr.cond = sync.NewCond(&sr.mu)
	w := j.e.opt.Workers
	sr.maxAhead = w + w/2 + 1
	return sr
}

// setWM: the producer made bytes up to wm readable (done: no more will come).
func (sr *scanRun) setWM(wm int64, done bool, err error) {
	sr.mu.Lock()
	if wm > sr.wm {
		sr.wm = wm
	}
	if done {
		sr.prodDone = true
	}
	if err != nil && sr.prodErr == nil {
		sr.prodErr = err
	}
	sr.j.mu.Lock()
	if sr.wm > sr.j.size {
		sr.j.size = sr.wm
	}
	sr.j.mu.Unlock()
	sr.cond.Broadcast()
	sr.mu.Unlock()
}

func (sr *scanRun) wake() {
	sr.mu.Lock()
	sr.cond.Broadcast()
	sr.mu.Unlock()
	sr.wakeProducers()
}

const (
	planOK = iota
	planNone
	planWait
)

func (sr *scanRun) planLocked() (region, int, error) {
	if sr.pos >= sr.wm {
		if sr.prodDone {
			return region{}, planNone, nil
		}
		return region{}, planWait, nil
	}
	chunk := sr.j.e.opt.Chunk
	if k := len(sr.regions); k < 4 {
		chunk >>= uint(4 - k)
		if chunk < 1 {
			chunk = 1
		}
	}
	n := sr.pos + chunk
	if n >= sr.wm {
		if sr.prodDone {
			return region{sr.pos, sr.wm}, planOK, nil
		}
		return region{}, planWait, nil
	}
	if sr.pf == nil {
		f, err := os.Open(sr.path)
		if err != nil {
			return region{}, planNone, err
		}
		sr.pf = f
		sr.probe = make([]byte, 64<<10)
	}
	b, found, err := alignForward(sr.pf, n, sr.wm, sr.prodDone, sr.probe)
	if err != nil {
		return region{}, planNone, err
	}
	if !found {
		if sr.prodDone {
			return region{sr.pos, sr.wm}, planOK, nil
		}
		return region{}, planWait, nil
	}
	return region{sr.pos, b}, planOK, nil
}

// alignForward returns the first line start ≥ n (n > 0) below limit. found is
// false when no break lies in [n-1, limit) — or the last one is a '\r' right
// at limit while more data may follow (it could be "\r\n").
func alignForward(f *os.File, n, limit int64, final bool, probe []byte) (int64, bool, error) {
	off := n - 1
	for off < limit {
		want := int64(len(probe))
		if limit-off < want {
			want = limit - off
		}
		got, err := f.ReadAt(probe[:want], off)
		if int64(got) < want {
			if err == nil || err == io.EOF {
				err = errShrunk
			}
			return 0, false, err
		}
		j := indexBreak(probe[:got], true)
		if j < 0 {
			off += int64(got)
			continue
		}
		t := off + int64(j)
		if probe[j] == '\r' {
			if t+1 >= limit {
				if final {
					return t + 1, true, nil
				}
				return 0, false, nil
			}
			var nb [1]byte
			if _, err := f.ReadAt(nb[:], t+1); err != nil {
				return 0, false, err
			}
			if nb[0] == '\n' {
				return t + 2, true, nil
			}
		}
		return t + 1, true, nil
	}
	return 0, false, nil
}

// take hands a worker the next region (planning it if needed). ok=false: no
// more work for this worker.
func (sr *scanRun) take() (int, region, bool) {
	sr.mu.Lock()
	defer sr.mu.Unlock()
	for {
		if sr.quit || sr.j.stop.Load() {
			return 0, region{}, false
		}
		if sr.prodErr != nil {
			if sr.failed == nil {
				sr.failed = sr.prodErr
			}
			sr.quit = true
			sr.cond.Broadcast()
			return 0, region{}, false
		}
		if sr.next < len(sr.regions) {
			if sr.next >= sr.published+sr.maxAhead {
				sr.cond.Wait()
				continue
			}
			k := sr.next
			sr.next++
			return k, sr.regions[k], true
		}
		reg, st, err := sr.planLocked()
		if err != nil {
			if sr.failed == nil {
				sr.failed = err
			}
			sr.quit = true
			sr.cond.Broadcast()
			return 0, region{}, false
		}
		switch st {
		case planOK:
			sr.regions = append(sr.regions, reg)
			sr.pos = reg.end
		case planNone:
			return 0, region{}, false
		case planWait:
			sr.cond.Wait()
		}
	}
}

// deposit stores a region's result and publishes every result that is next in
// file order. Hits are kept up to exactly MaxRows+1 in file order: the job is
// then truncated (the cut is certain) and nothing after it is published, so the
// result is the same on every run.
func (sr *scanRun) deposit(k int, res *chunkResult) {
	sr.mu.Lock()
	defer sr.mu.Unlock()
	sr.results[k] = res
	j := sr.j
	for !sr.quit {
		r := sr.results[sr.published]
		if r == nil {
			break
		}
		delete(sr.results, sr.published)
		if r.err != nil {
			if !errors.Is(r.err, errCanceled) && sr.failed == nil {
				sr.failed = r.err
			}
			sr.quit = true
			break
		}
		reg := sr.regions[sr.published]
		base := sr.linesBefore + sr.linesDone + 1 // region-local 0 → file line number
		j.mu.Lock()
		room := j.capHits() - len(j.hits)
		hs := r.hits
		trunc := false
		if len(hs) >= room {
			hs, trunc = hs[:room], true
		}
		if need := len(j.hits) + len(hs); need > cap(j.hits) {
			// grow by doubling (append grows 1.25x for big slices: 5x the
			// final size allocated in total)
			nc := max(2*cap(j.hits), 1024, need)
			if lim := j.capHits(); nc > lim {
				nc = max(lim, need)
			}
			nh := make([]hit, len(j.hits), nc)
			copy(nh, j.hits)
			j.hits = nh
		}
		for _, h := range hs {
			h.line += base
			j.m.eachRule(h, r.ext, func(k int) { j.ruleHits[j.m.rules[k].index]++ })
			if h.ext != 0 {
				// move the entry from the region's arena to the job's (append
				// only: rows being read keep a snapshot of the slice)
				w := j.m.extWords
				j.ext = append(j.ext, r.ext[int(h.ext-1)*w:int(h.ext)*w]...)
				h.ext = uint32(len(j.ext) / w)
			}
			j.hits = append(j.hits, h)
		}
		lastLine := int64(-1)
		if trunc && len(hs) > 0 {
			lastLine = hs[len(hs)-1].line + base
		}
		for _, l := range r.longs {
			l.line += base
			if lastLine >= 0 && l.line > lastLine {
				break
			}
			j.longs = append(j.longs, l)
		}
		j.invalid += r.invalid
		if r.invalidLine >= 0 && j.invalidLine == 0 {
			j.invalidLine = r.invalidLine + base
		}
		if j.ex != nil {
			if trunc {
				// only the lines before the last hit kept count as scanned
				if len(hs) > 0 {
					j.excluded += r.exBefore[len(hs)-1]
				}
			} else {
				j.excluded += r.excluded
			}
		}
		if j.all {
			j.notePosLocked(base, reg.start)
		}
		if trunc {
			j.truncated = true
			if lastLine >= 0 {
				j.scannedLines = lastLine
			}
			j.scannedOff = hs[len(hs)-1].end
			sr.quit = true
		} else {
			sr.linesDone += r.lines
			j.scannedLines = sr.linesBefore + sr.linesDone
			j.scannedOff = reg.end
		}
		if len(hs) > 0 && j.firstHit < 0 {
			j.firstHit = time.Since(j.started)
			j.emitLocked(true)
		} else {
			j.emitLocked(sr.published == 0)
		}
		j.cond.Broadcast()
		j.mu.Unlock()
		putHits(r.hits)
		sr.published++
	}
	sr.cond.Broadcast()
}

var hitsPool sync.Pool

func getHits() []hit {
	if p, ok := hitsPool.Get().(*[]hit); ok {
		return (*p)[:0]
	}
	return make([]hit, 0, 1024)
}

func putHits(h []hit) {
	if cap(h) > 0 && cap(h) <= 1<<18 {
		h = h[:0]
		hitsPool.Put(&h)
	}
}

// run scans with Workers goroutines until the data ends, the hit cap is
// reached, the job is stopped or something fails.
func (sr *scanRun) run() error {
	j := sr.j
	nw := j.e.opt.Workers
	var wg sync.WaitGroup
	mem := j.e.opt.DFAMemory / nw
	for w := 0; w < nw; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sr.worker(mem)
		}()
	}
	wg.Wait()
	sr.mu.Lock()
	if sr.pf != nil {
		sr.pf.Close()
		sr.pf = nil
	}
	failed := sr.failed
	if failed == nil && sr.prodErr != nil {
		failed = sr.prodErr
	}
	sr.mu.Unlock()
	if failed != nil {
		return failed
	}
	if j.stop.Load() {
		return errCanceled
	}
	return nil
}

func (sr *scanRun) worker(mem int) {
	j := sr.j
	wb := <-j.e.pool
	if wb == nil || cap(wb.buf) < j.e.opt.BufSize {
		wb = &workBuf{buf: make([]byte, 0, j.e.opt.BufSize)}
	}
	defer func() { j.e.pool <- wb }()
	ws := newWState(j.m, mem)
	if j.ex != nil {
		ws.ex = newWState(j.ex, mem/4)
	}
	ws.fold = wb.fold
	defer func() {
		if cap(ws.fold) <= cap(wb.buf) {
			wb.fold = ws.fold
		}
	}()
	var f *os.File
	defer func() {
		if f != nil {
			f.Close()
		}
	}()
	for {
		k, reg, ok := sr.take()
		if !ok {
			return
		}
		if f == nil {
			var err error
			if f, err = os.Open(sr.path); err != nil {
				sr.deposit(k, &chunkResult{err: err})
				return
			}
		}
		res := sr.processRegion(f, ws, wb, reg)
		res.ext, ws.ext = ws.ext, nil
		res.excluded, res.exBefore = ws.exN, ws.exBefore
		ws.exN, ws.exBefore = 0, nil
		ws.clearHi()
		sr.deposit(k, res)
	}
}

// excludedIn counts the matched lines the exclude rules leave out in [from,
// to) of the scanned file, judged exactly as a scan of that region does (the
// last line ends at `to`). Used before an append scans that part again.
func (j *job) excludedIn(path string, from, to int64) int64 {
	if j.ex == nil || to <= from {
		return 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	wb := <-j.e.pool
	if wb == nil || cap(wb.buf) < j.e.opt.BufSize {
		wb = &workBuf{buf: make([]byte, 0, j.e.opt.BufSize)}
	}
	defer func() { j.e.pool <- wb }()
	mem := j.e.opt.DFAMemory / j.e.opt.Workers
	ws := newWState(j.m, mem)
	ws.ex = newWState(j.ex, mem/4)
	ws.fold = wb.fold
	sr := newScanRun(j, path, from, 0, false)
	res := sr.processRegion(f, ws, wb, region{from, to})
	if cap(ws.fold) <= cap(wb.buf) {
		wb.fold = ws.fold
	}
	putHits(res.hits)
	if res.err != nil {
		return 0
	}
	return ws.exN
}

// processRegion scans one region with the worker's buffer.
func (sr *scanRun) processRegion(f *os.File, ws *wstate, wb *workBuf, r region) *chunkResult {
	j := sr.j
	res := &chunkResult{hits: getHits(), invalidLine: -1}
	capHits := j.capHits()
	buf := wb.buf[:0]
	capb := cap(wb.buf)
	off := r.start
	bufBase := r.start
	var lineBase int64
	for {
		if j.stop.Load() {
			res.err = errCanceled
			return res
		}
		want := int64(capb - len(buf))
		if rem := r.end - off; rem < want {
			want = rem
		}
		if want > 0 {
			n, err := f.ReadAt(buf[len(buf):len(buf)+int(want)], off)
			if int64(n) < want {
				if err == nil || err == io.EOF {
					err = errShrunk
				}
				res.err = err
				return res
			}
			buf = buf[:len(buf)+n]
			off += int64(n)
		}
		atEnd := off >= r.end
		cut := len(buf)
		if !atEnd {
			cut = lastLineCut(buf)
		}
		if cut == 0 && !atEnd {
			// One line longer than the whole buffer.
			next, err := sr.giantLine(f, ws, res, buf, bufBase, r.end, lineBase)
			if err != nil {
				res.err = err
				return res
			}
			if res.full {
				return res
			}
			lineBase++
			off = next
			buf = wb.buf[:0]
			bufBase = off
			if off >= r.end {
				break
			}
			continue
		}
		data := buf[:cut]
		if sr.checkUTF8 {
			if n, first := invalidUTF8(data); n > 0 {
				res.invalid += n
				if res.invalidLine < 0 {
					res.invalidLine = lineBase + countBreaks(data[:first], true)
				}
			}
		}
		var n int64
		var full bool
		res.hits, n, full = ws.scanBuf(data, bufBase, res.hits, lineBase, capHits, &res.longs)
		if full {
			res.full = true
			return res
		}
		lineBase += n
		rest := copy(wb.buf[:capb], buf[cut:])
		buf = wb.buf[:rest]
		bufBase += int64(cut)
		if atEnd {
			break
		}
	}
	res.lines = lineBase
	return res
}

// GiantMax: a line up to this long is read whole into memory (one at a time per
// engine) and judged like any other line. Longer lines are judged piece by
// piece; their match column is then unknown (-1). A var for tests.
var GiantMax = 32 << 20

// giantLine judges the line starting at lineStart, which does not fit the
// worker's buffer (buf holds its first bytes). Returns the next line start.
func (sr *scanRun) giantLine(f *os.File, ws *wstate, res *chunkResult, buf []byte, lineStart, limit int64, lineIdx int64) (int64, error) {
	var le, next int64
	if buf[len(buf)-1] == '\r' {
		le = lineStart + int64(len(buf)) - 1
		next = le + 1
		if next < limit {
			var nb [1]byte
			if _, err := f.ReadAt(nb[:], next); err != nil {
				return 0, err
			}
			if nb[0] == '\n' {
				next++
			}
		}
	} else {
		var err error
		le, next, err = skipToLineEnd(f, lineStart+int64(len(buf)), limit, buf[:cap(buf)], &sr.j.stop)
		if err != nil {
			return 0, err
		}
	}
	res.longs = append(res.longs, longLine{line: lineIdx, start: lineStart, end: le, next: next})
	n := le - lineStart
	j := sr.j
	if n <= int64(GiantMax) {
		j.e.giant <- struct{}{}
		defer func() { <-j.e.giant }()
		line := make([]byte, n)
		if _, err := f.ReadAt(line, lineStart); err != nil {
			return 0, err
		}
		if sr.checkUTF8 {
			if c, _ := invalidUTF8(line); c > 0 {
				res.invalid += c
				if res.invalidLine < 0 {
					res.invalidLine = lineIdx
				}
			}
		}
		var full bool
		res.hits, _, full = ws.scanBuf(line, lineStart, res.hits, lineIdx, j.capHits(), nil)
		res.full = full
		ws.fold, ws.low, ws.lowPtr = nil, nil, nil // do not keep a giant copy around
		return next, nil
	}
	mask, inv, err := ws.streamLine(f, lineStart, le, buf[:cap(buf)], &j.stop)
	if err != nil {
		ws.clearHi()
		return 0, err
	}
	if sr.checkUTF8 && inv > 0 {
		res.invalid += inv
		if res.invalidLine < 0 {
			res.invalidLine = lineIdx
		}
	}
	if ws.lineHit(mask) && ws.ex != nil {
		// the exclude rules also judge the line piece by piece
		xm, _, err := ws.ex.streamLine(f, lineStart, le, buf[:cap(buf)], &j.stop)
		excl := ws.ex.lineHit(xm)
		ws.ex.clearHi()
		if err != nil {
			ws.clearHi()
			return 0, err
		}
		if excl {
			ws.clearHi()
			ws.exN++
			mask = 0
		}
	}
	if ws.lineHit(mask) {
		res.hits = ws.addHit(res.hits, hit{line: lineIdx, start: lineStart, end: le, mask: mask, col: -1})
		if len(res.hits) >= j.capHits() {
			res.full = true
		}
	}
	return next, nil
}

// skipToLineEnd finds the end of the line that continues at off. It gives up
// with errCanceled once stop is set.
func skipToLineEnd(f *os.File, off, limit int64, scratch []byte, stop *atomic.Bool) (int64, int64, error) {
	for off < limit {
		if stop.Load() {
			return 0, 0, errCanceled
		}
		want := int64(len(scratch))
		if limit-off < want {
			want = limit - off
		}
		n, err := f.ReadAt(scratch[:want], off)
		if int64(n) < want {
			if err == nil || err == io.EOF {
				err = errShrunk
			}
			return 0, 0, err
		}
		j := indexBreak(scratch[:n], true)
		if j < 0 {
			off += int64(n)
			continue
		}
		e := off + int64(j)
		if scratch[j] == '\r' {
			if e+1 < limit {
				var nb [1]byte
				if _, err := f.ReadAt(nb[:], e+1); err != nil {
					return 0, 0, err
				}
				if nb[0] == '\n' {
					return e, e + 2, nil
				}
			}
		}
		return e, e + 1, nil
	}
	return limit, limit, nil
}

// streamLine judges a line too long for memory, piece by piece, with each
// rule's DFA (a DFA that gives up falls back to the stdlib on a stream).
// Returns the rule mask (rules past the 64th in ws.hi) and the number of bytes
// that are not UTF-8. Once stop is set it gives up with errCanceled: it checks
// before each rule's piece and, in the stdlib fallback, every 64KB read.
func (ws *wstate) streamLine(f *os.File, start, end int64, scratch []byte, stop *atomic.Bool) (uint64, int64, error) {
	m := ws.m
	type st struct {
		d    *dfa
		s    *dstate
		done bool
		std  bool
	}
	sts := make([]st, len(m.rules))
	for ri := range m.rules {
		if m.progs[ri] == nil {
			sts[ri].std = true
			continue
		}
		d := newDFA(m.progs[ri], false, ws.rLimit)
		sts[ri] = st{d: d, s: d.streamBegin()}
	}
	var mask uint64
	var invalid int64
	carry := 0
	for pos := start; pos < end; {
		want := int64(len(scratch) - carry)
		if end-pos < want {
			want = end - pos
		}
		n, err := f.ReadAt(scratch[carry:carry+int(want)], pos)
		if int64(n) < want {
			if err == nil || err == io.EOF {
				err = errShrunk
			}
			return 0, 0, err
		}
		pos += int64(n)
		data := scratch[:carry+n]
		cut := len(data)
		if pos < end {
			cut = runeCut(data)
		}
		piece := data[:cut]
		c, _ := invalidUTF8(piece)
		invalid += c
		for ri := range sts {
			x := &sts[ri]
			if x.done || x.std {
				continue
			}
			if stop.Load() {
				return 0, 0, errCanceled
			}
			ns, ok := x.d.feed(x.s, piece)
			if x.d.failed {
				x.std = true
				continue
			}
			if ok {
				x.done = true
				ws.setRule(&mask, ri)
				continue
			}
			x.s = ns
		}
		carry = copy(scratch, data[cut:])
	}
	for ri := range sts {
		x := &sts[ri]
		r := &m.rules[ri]
		if x.done {
			continue
		}
		if x.std {
			sec := io.NewSectionReader(f, start, end-start)
			re := r.lineRe
			if r.emptyToo && m.progs[ri] != nil {
				re = m.progs[ri].re // non-empty matches only
			}
			rr := &runeReader{r: sec, stop: stop}
			matched := re.MatchReader(rr)
			if rr.canceled {
				return 0, 0, errCanceled
			}
			if matched {
				ws.setRule(&mask, ri)
			}
			continue
		}
		if x.d.feedEnd(x.s) {
			ws.setRule(&mask, ri)
		}
	}
	return mask, invalid, nil
}

// runeReader is a buffered io.RuneReader (invalid bytes read as U+FFFD, width 1).
// When stop is set it ends the input early (canceled says so), so a regexp
// reading it returns soon.
type runeReader struct {
	r        io.Reader
	stop     *atomic.Bool
	canceled bool
	buf      []byte
	i, n     int
	eof      bool
}

func (rr *runeReader) ReadRune() (rune, int, error) {
	if rr.buf == nil {
		rr.buf = make([]byte, 64<<10)
	}
	if rr.n-rr.i < 4 && !rr.eof {
		copy(rr.buf, rr.buf[rr.i:rr.n])
		rr.n -= rr.i
		rr.i = 0
		if rr.stop != nil && rr.stop.Load() {
			rr.canceled, rr.eof, rr.n = true, true, 0
			return 0, 0, io.EOF
		}
		for rr.n < 4 && !rr.eof {
			k, err := rr.r.Read(rr.buf[rr.n:])
			rr.n += k
			if err != nil {
				rr.eof = true
			}
		}
	}
	if rr.i >= rr.n {
		return 0, 0, io.EOF
	}
	r, w := utf8.DecodeRune(rr.buf[rr.i:rr.n])
	rr.i += w
	return r, w, nil
}
