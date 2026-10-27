package linefilter

import (
	"errors"
	"io"
	"os"
	"sort"
	"sync"
	"time"
	"unicode/utf8"
)

// Row is one row of the filtered view: a line of the file, or a gap row
// standing for lines left out.
type Row struct {
	Line          int64  `json:"line"`                    // 1-based line number in the file (as the editor counts); 0 = gap row
	Text          string `json:"text"`                    // the line without its line break (invalid UTF-8 bytes → U+FFFD each)
	Hit           bool   `json:"hit,omitempty"`           // a rule matched this line (otherwise it is above/below context)
	Rules         []int  `json:"rules,omitempty"`         // hit rows: indexes into the request's Rules that matched
	Col           int32  `json:"col"`                     // hit rows: editor column (UTF-16 units) where the first match starts; -1 otherwise / unknown
	TruncatedLine bool   `json:"truncatedLine,omitempty"` // Text is only the start of a longer line (MaxLineDisplay)
	Skip          int64  `json:"skip,omitempty"`          // gap rows: how many lines are left out here
	From          int64  `json:"from,omitempty"`          // gap rows: the first line left out
}

// Page answers FilterRows.
type Page struct {
	JobID     string   `json:"jobId"`
	From      int      `json:"from"`
	Rows      []Row    `json:"rows"`
	Available int      `json:"available"`           // rows that can be fetched right now (row 0 .. Available-1)
	Total     int      `json:"total"`               // final row count, -1 while rows can still be added
	End       bool     `json:"end"`                 // no row will ever exist after From+len(Rows) (in this version)
	Truncated string   `json:"truncated,omitempty"` // "rows" (MaxRows lines) or "bytes" (MaxBytes of text) — rows after this were left out
	Changed   bool     `json:"changed,omitempty"`   // the file's content changed on disk: start a new job
	Version   int      `json:"version"`             // see Progress.Version
	Progress  Progress `json:"progress"`
}

type interval struct {
	lo, hi   int64 // lines shown, inclusive
	h0, h1   int   // hits[h0:h1] lie in [lo, hi]
	gap      int64 // lines left out just before lo (0 = no gap row)
	rowStart int   // row of the gap row, or of line lo when there is none
}

type layout struct {
	nh       int
	scanned  int64
	done     bool
	version  int
	ivs      []interval
	avail    int
	total    int // -1 = not final
	capped   bool
	trailGap int64
	trailAt  int64 // first line of the trailing gap
	at       time.Time
}

type byteMarks struct {
	mu      sync.Mutex
	version int
	rows    []int
	bytes   []int64
	capRow  int // -1 = MaxBytes not reached (so far)
}

// layoutLocked computes the row layout for (above, below) from the hits found
// so far. j.mu must be held.
func (j *job) layoutLocked(above, below int64) *layout {
	done := j.done && !j.following
	if l := j.lay; l != nil && l.version == j.version && l.done == done && j.layA == above && j.layB == below {
		if l.nh == len(j.hits) && l.scanned == j.scannedLines {
			return l
		}
		// While the scan runs, a layout a few ms old is good enough (it is a
		// prefix of the newer one): recomputing it on every page call costs
		// O(hits) each time.
		if !done && time.Since(l.at) < 20*time.Millisecond {
			return l
		}
	}
	hits := j.hits
	limit := j.scannedLines
	l := &layout{nh: len(hits), scanned: j.scannedLines, done: done, version: j.version, total: -1, at: time.Now()}
	for i, h := range hits {
		lo := h.line - above
		if lo < 1 {
			lo = 1
		}
		hi := h.line + below
		if hi > limit {
			hi = limit
		}
		if n := len(l.ivs); n > 0 && lo <= l.ivs[n-1].hi+1 {
			if hi > l.ivs[n-1].hi {
				l.ivs[n-1].hi = hi
			}
			l.ivs[n-1].h1 = i + 1
			continue
		}
		l.ivs = append(l.ivs, interval{lo: lo, hi: hi, h0: i, h1: i + 1})
	}
	maxRows := j.e.opt.MaxRows
	row, lines := 0, 0
	var prevHi int64
	for idx := range l.ivs {
		iv := &l.ivs[idx]
		iv.gap = iv.lo - prevHi - 1
		iv.rowStart = row
		if iv.gap > 0 {
			row++
		}
		cnt := int(iv.hi - iv.lo + 1)
		if lines+cnt > maxRows {
			cnt = maxRows - lines
			iv.hi = iv.lo + int64(cnt) - 1
			for iv.h1 > iv.h0+1 && hits[iv.h1-1].line > iv.hi {
				iv.h1--
			}
			if hits[iv.h0].line > iv.hi {
				iv.h1 = iv.h0 // only context lines above the first hit fit
			}
			l.capped = true
		}
		row += cnt
		lines += cnt
		prevHi = iv.hi
		if !l.capped && lines == maxRows && (idx < len(l.ivs)-1 || j.truncated) {
			l.capped = true
		}
		if l.capped {
			l.ivs = l.ivs[:idx+1]
			break
		}
	}
	if done || l.capped {
		if done && !l.capped && !j.truncated && j.err == nil && !j.canceled && prevHi < j.totalLines {
			l.trailGap = j.totalLines - prevHi
			l.trailAt = prevHi + 1
			row++
		}
		l.total = row
	}
	// Rows already laid out never change while the version stays: a later hit
	// can only extend the last block at its end or start a new block after it.
	l.avail = row
	j.lay, j.layA, j.layB = l, above, below
	return l
}

// rowAtLine: the first row showing a line ≥ x, or the gap row that covers one.
func (l *layout) rowAtLine(x int64) int {
	k := sort.Search(len(l.ivs), func(i int) bool { return l.ivs[i].hi >= x })
	if k < len(l.ivs) {
		iv := &l.ivs[k]
		g := 0
		if iv.gap > 0 {
			if iv.lo-1 >= x {
				return iv.rowStart
			}
			g = 1
		}
		y := x
		if y < iv.lo {
			y = iv.lo
		}
		return iv.rowStart + g + int(y-iv.lo)
	}
	if l.trailGap > 0 {
		return l.avail - 1
	}
	return l.avail
}

func clampCtx(n int) int64 {
	if n < 0 {
		return 0
	}
	if n > MaxContext {
		return MaxContext
	}
	return int64(n)
}

// Rows returns rows [from, from+count) of the filtered view with `above` lines
// before and `below` lines after each hit (grep -B / -A). Changing above/below
// never rescans the file: only the lines around the hits are read. A page may
// hold fewer rows than asked (MaxPageBytes, or rows not found yet): ask again
// from from+len(rows) until End.
func (e *Engine) Rows(id string, above, below, from, count int) (Page, error) {
	v, err := e.view(id)
	if err != nil {
		return Page{}, err
	}
	j := v.j
	j.checkFile(false)
	if from < 0 {
		from = 0
	}
	if count <= 0 {
		count = 1000
	}
	if count > MaxPageRows {
		count = MaxPageRows
	}
	A, B := clampCtx(above), clampCtx(below)
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
	lay := j.layoutLocked(A, B)
	hits := j.hits[:lay.nh:lay.nh]
	longs := j.longs[:len(j.longs):len(j.longs)]
	readPath, dataStart, size := j.readPath, j.dataStart, j.size
	bm := j.marks[[2]int64{A, B}]
	if bm == nil {
		bm = &byteMarks{version: j.version, rows: []int{0}, bytes: []int64{0}, capRow: -1}
		j.marks[[2]int64{A, B}] = bm
	}
	version := j.version
	changeLine := int64(-1)
	j.mu.Unlock()
	page.Available, page.Total = lay.avail, lay.total
	if lay.capped {
		page.Truncated = "rows"
	}

	j.content.RLock()
	defer j.content.RUnlock()
	rd := &rowReader{j: j, lay: lay, hits: hits, longs: longs, path: readPath, dataStart: dataStart, size: size, maxText: e.opt.MaxLineDisplay}
	defer rd.close()

	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.version != version {
		// Lines from the append's first changed line (minus the context above)
		// may have changed rows; byte marks before them still hold.
		j.mu.Lock()
		if bm.version < len(j.appendLines) {
			changeLine = j.appendLines[bm.version]
		}
		j.mu.Unlock()
		keepTo := 0
		if changeLine > 0 {
			keepTo = lay.rowAtLine(changeLine - A)
		}
		k := sort.SearchInts(bm.rows, keepTo+1)
		bm.rows, bm.bytes = bm.rows[:k], bm.bytes[:k]
		if bm.capRow > keepTo {
			bm.capRow = -1
		}
		bm.version = version
	}
	before, err := rd.bytesBefore(bm, from)
	if err != nil {
		return page, err
	}
	capRow := bm.capRow
	if capRow >= 0 && from >= capRow {
		page.End, page.Truncated = true, "bytes"
		page.Total = capRow
		return page, nil
	}
	to := from + count
	if to > lay.avail {
		to = lay.avail
	}
	if capRow >= 0 && to > capRow {
		to = capRow
	}
	if from < to {
		rows, err := rd.rows(from, to, e.opt.MaxPageBytes)
		if err != nil {
			return page, err
		}
		for i := range rows {
			b := rowBytes(&rows[i])
			if before+b > e.opt.MaxBytes {
				bm.capRow = from + i
				rows = rows[:i]
				break
			}
			before += b
		}
		page.Rows = rows
		bm.addMark(from+len(rows), before)
	}
	end := from + len(page.Rows)
	if bm.capRow >= 0 && end >= bm.capRow {
		page.End, page.Truncated, page.Total = true, "bytes", bm.capRow
	} else if lay.total >= 0 && end >= lay.total {
		page.End = true
	}
	return page, nil
}

func rowBytes(r *Row) int64 { return int64(len(r.Text)) + 1 }

func (bm *byteMarks) addMark(row int, b int64) {
	i := sort.SearchInts(bm.rows, row)
	if i < len(bm.rows) && bm.rows[i] == row {
		return
	}
	bm.rows = append(bm.rows, 0)
	bm.bytes = append(bm.bytes, 0)
	copy(bm.rows[i+1:], bm.rows[i:])
	copy(bm.bytes[i+1:], bm.bytes[i:])
	bm.rows[i], bm.bytes[i] = row, b
}

type rowReader struct {
	j         *job
	lay       *layout
	hits      []hit
	longs     []longLine
	path      string
	dataStart int64
	size      int64
	maxText   int
	f         *os.File
	lr        *lineReader
	back      []byte
	backLo    int64
	backN     int
}

func (rd *rowReader) close() {
	if rd.f != nil {
		rd.f.Close()
	}
}

func (rd *rowReader) file() (*os.File, error) {
	if rd.f == nil {
		if rd.path == "" {
			return nil, errInternal
		}
		f, err := os.Open(rd.path)
		if err != nil {
			return nil, err
		}
		rd.f = f
	}
	return rd.f, nil
}

// bytesBefore: text bytes of rows [0, from), from the nearest mark (reading the
// rows in between if the caller skipped ahead). Also notes MaxBytes on the way.
func (rd *rowReader) bytesBefore(bm *byteMarks, from int) (int64, error) {
	i := sort.SearchInts(bm.rows, from+1) - 1 // last mark ≤ from
	row, b := bm.rows[i], bm.bytes[i]
	if row == from || (bm.capRow >= 0 && row >= bm.capRow) {
		return b, nil
	}
	to := from
	if to > rd.lay.avail {
		to = rd.lay.avail
	}
	for row < to {
		end := row + 5000
		if end > to {
			end = to
		}
		rows, err := rd.rows(row, end, 0)
		if err != nil {
			return 0, err
		}
		for k := range rows {
			rb := rowBytes(&rows[k])
			if b+rb > rd.j.e.opt.MaxBytes {
				bm.capRow = row + k
				return b, nil
			}
			b += rb
		}
		row = end
		bm.addMark(row, b)
	}
	return b, nil
}

// rows materializes rows [from, to) (to ≤ layout.avail), stopping early once
// they hold maxBytes of text (0 = no limit; at least one row).
func (rd *rowReader) rows(from, to int, maxBytes int64) ([]Row, error) {
	ivs := rd.lay.ivs
	out := make([]Row, 0, min(to-from, 4096))
	r := from
	var got int64
	full := func() bool { return maxBytes > 0 && got >= maxBytes }
	idx := sort.Search(len(ivs), func(i int) bool { return ivs[i].rowStart > r }) - 1
	if idx < 0 {
		idx = 0
	}
	for r < to && !full() {
		if idx >= len(ivs) {
			out = append(out, Row{Skip: rd.lay.trailGap, From: rd.lay.trailAt, Col: -1})
			r++
			continue
		}
		iv := &ivs[idx]
		g := 0
		if iv.gap > 0 {
			g = 1
		}
		if g == 1 && r == iv.rowStart {
			out = append(out, Row{Skip: iv.gap, From: iv.lo - iv.gap, Col: -1})
			r++
			continue
		}
		x := iv.lo + int64(r-iv.rowStart-g)
		if x > iv.hi {
			idx++
			continue
		}
		n := iv.hi - x + 1
		if rem := int64(to - r); rem < n {
			n = rem
		}
		if maxBytes > 0 && n > 256 {
			n = 256 // check the page size between batches
		}
		k := len(out)
		var err error
		out, err = rd.readLines(out, iv, x, n)
		if err != nil {
			return nil, err
		}
		for i := k; i < len(out); i++ {
			got += rowBytes(&out[i])
			if full() {
				return out[:i+1], nil
			}
		}
		r += int(n)
		if x+n-1 >= iv.hi {
			idx++
		}
	}
	return out, nil
}

var errInternal = errors.New("내부 오류: 줄 위치가 맞지 않습니다")

func (rd *rowReader) longAt(pos int64) (longLine, bool) {
	k := sort.Search(len(rd.longs), func(i int) bool { return rd.longs[i].start >= pos })
	if k < len(rd.longs) && rd.longs[k].start == pos {
		return rd.longs[k], true
	}
	return longLine{}, false
}

func (rd *rowReader) longByNext(pos int64) (longLine, bool) {
	k := sort.Search(len(rd.longs), func(i int) bool { return rd.longs[i].next >= pos })
	if k < len(rd.longs) && rd.longs[k].next == pos {
		return rd.longs[k], true
	}
	return longLine{}, false
}

func (rd *rowReader) readLines(out []Row, iv *interval, x, n int64) ([]Row, error) {
	f, err := rd.file()
	if err != nil {
		return nil, err
	}
	hits := rd.hits
	// The nearest hit at or above line x gives a known line start.
	hk := sort.Search(iv.h1-iv.h0, func(i int) bool { return hits[iv.h0+i].line > x }) + iv.h0 - 1
	var off int64
	var skip int64
	if hk >= iv.h0 {
		off, skip = hits[hk].start, x-hits[hk].line
	} else {
		off, err = rd.backLines(hits[iv.h0].start, hits[iv.h0].line-x)
		if err != nil {
			return nil, err
		}
	}
	if rd.lr == nil {
		rd.lr = &lineReader{f: f, size: rd.size, buf: make([]byte, 256<<10), base: off, rd: rd}
	} else {
		rd.lr.seek(off)
	}
	lr := rd.lr
	for ; skip > 0; skip-- {
		if _, _, err := lr.next(0); err != nil {
			return nil, err
		}
	}
	hp := hk + 1
	if hk >= iv.h0 && hits[hk].line == x {
		hp = hk
	}
	for i := int64(0); i < n; i++ {
		ln := x + i
		start := lr.pos()
		text, cut, err := lr.next(rd.maxText)
		if err != nil {
			return nil, err
		}
		row := Row{Line: ln, Text: text, TruncatedLine: cut, Col: -1}
		if hp < iv.h1 && hits[hp].line == ln {
			if hits[hp].start != start {
				return nil, errInternal
			}
			row.Hit = true
			row.Rules = rd.j.maskRules(hits[hp].mask)
			row.Col = hits[hp].col
			hp++
		}
		out = append(out, row)
	}
	return out, nil
}

func (j *job) maskRules(m uint64) []int {
	var out []int
	for _, r := range j.m.rules {
		if m&r.bit != 0 {
			out = append(out, r.index)
		}
	}
	return out
}

// byteAt reads one byte through a 64KB window ending at the asked position
// (reading goes backwards).
func (rd *rowReader) byteAt(p int64) (byte, error) {
	if p >= rd.backLo && p < rd.backLo+int64(rd.backN) {
		return rd.back[p-rd.backLo], nil
	}
	if rd.back == nil {
		rd.back = make([]byte, 64<<10)
	}
	lo := p + 1 - int64(len(rd.back))
	if lo < rd.dataStart {
		lo = rd.dataStart
	}
	n := p + 1 - lo
	f, err := rd.file()
	if err != nil {
		return 0, err
	}
	if k, err := f.ReadAt(rd.back[:n], lo); int64(k) < n {
		if err == nil || err == io.EOF {
			err = errShrunk
		}
		rd.backN = 0
		return 0, err
	}
	rd.backLo, rd.backN = lo, int(n)
	return rd.back[p-lo], nil
}

// backLines returns the start of the line k lines above the line starting at
// from. Recorded long lines are jumped over.
func (rd *rowReader) backLines(from, k int64) (int64, error) {
	pos := from
	for i := int64(0); i < k && pos > rd.dataStart; i++ {
		if l, ok := rd.longByNext(pos); ok {
			pos = l.start
			continue
		}
		q := pos - 1 // last byte of the previous line's break
		b, err := rd.byteAt(q)
		if err != nil {
			return 0, err
		}
		if b == '\n' && q-1 >= rd.dataStart {
			if c, err := rd.byteAt(q - 1); err != nil {
				return 0, err
			} else if c == '\r' {
				q--
			}
		}
		s := rd.dataStart
		for p := q - 1; p >= rd.dataStart; p-- {
			c, err := rd.byteAt(p)
			if err != nil {
				return 0, err
			}
			if c == '\n' || c == '\r' {
				s = p + 1
				break
			}
		}
		pos = s
	}
	return pos, nil
}

// lineReader reads lines forward from a line start.
type lineReader struct {
	rd   *rowReader
	acc  []byte
	f    *os.File
	size int64
	buf  []byte
	r, w int
	base int64 // file offset of buf[0]
	eof  bool
}

func (lr *lineReader) pos() int64 { return lr.base + int64(lr.r) }

// seek moves to off, keeping the buffered bytes when off lies inside them.
func (lr *lineReader) seek(off int64) {
	if off >= lr.base && off <= lr.base+int64(lr.w) {
		lr.r = int(off - lr.base)
		return
	}
	lr.base, lr.r, lr.w, lr.eof = off, 0, 0, false
}

func (lr *lineReader) fill() (bool, error) {
	if lr.eof {
		return false, nil
	}
	copy(lr.buf, lr.buf[lr.r:lr.w])
	lr.base += int64(lr.r)
	lr.w -= lr.r
	lr.r = 0
	off := lr.base + int64(lr.w)
	want := int64(len(lr.buf) - lr.w)
	if off+want > lr.size {
		want = lr.size - off
	}
	if want <= 0 {
		lr.eof = true
		return false, nil
	}
	n, err := lr.f.ReadAt(lr.buf[lr.w:lr.w+int(want)], off)
	lr.w += n
	if n == 0 {
		lr.eof = true
		if err != nil && err != io.EOF {
			return false, err
		}
		return false, nil
	}
	return true, nil
}

// next returns the next line's text (at most maxText bytes, cut on a UTF-8
// boundary) and whether it was cut. maxText 0: skip the line.
func (lr *lineReader) next(maxText int) (string, bool, error) {
	if l, ok := lr.rd.longAt(lr.pos()); ok {
		cut := false
		var text string
		if maxText > 0 {
			n := l.end - l.start
			if n > int64(maxText) {
				n, cut = int64(maxText), true
			}
			b := make([]byte, n)
			if k, err := lr.f.ReadAt(b, l.start); int64(k) < n {
				if err == nil || err == io.EOF {
					err = errShrunk
				}
				return "", false, err
			}
			if cut {
				b = trimPartialRune(b)
			}
			text = sanitizeUTF8(b)
		}
		lr.seek(l.next)
		return text, cut, nil
	}
	acc := lr.acc[:0]
	defer func() { lr.acc = acc[:0] }()
	cut := false
	for {
		data := lr.buf[lr.r:lr.w]
		k := indexBreak(data, true)
		end := k
		if k < 0 {
			end = len(data)
		}
		piece := data[:end]
		if room := maxText - len(acc); room >= len(piece) {
			acc = append(acc, piece...)
		} else {
			if room > 0 {
				acc = append(acc, piece[:room]...)
			}
			cut = true
		}
		if k >= 0 {
			if data[k] == '\r' && k+1 == len(data) {
				lr.r += k + 1
				ok, err := lr.fill()
				if err != nil {
					return "", false, err
				}
				if ok && lr.r < lr.w && lr.buf[lr.r] == '\n' {
					lr.r++
				}
			} else if data[k] == '\r' && data[k+1] == '\n' {
				lr.r += k + 2
			} else {
				lr.r += k + 1
			}
			break
		}
		lr.r = lr.w
		ok, err := lr.fill()
		if err != nil {
			return "", false, err
		}
		if !ok {
			break
		}
	}
	if maxText <= 0 {
		return "", false, nil
	}
	if cut {
		acc = trimPartialRune(acc)
	}
	return sanitizeUTF8(acc), cut, nil
}

func trimPartialRune(b []byte) []byte {
	j := len(b) - 1
	for j >= 0 && j >= len(b)-4 && !utf8.RuneStart(b[j]) {
		j--
	}
	if j >= 0 && !utf8.FullRune(b[j:]) {
		return b[:j]
	}
	return b
}
