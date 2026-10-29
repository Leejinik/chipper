package linefilter

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"github.com/klauspost/compress/gzip"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Producers put the text to scan into a UTF-8 file:
//   - UTF-8 files are scanned in place (nothing to produce);
//   - CP949 / UTF-16 files are decoded in parallel chunks (cut where a character
//     ends on its own, so each chunk decodes exactly as the whole file would)
//     and written in order to a temp copy;
//   - .gz files are inflated as a stream (inflating cannot be split) into the
//     temp copy, decoded on the way when they are CP949 / UTF-16.
// The scan reads the copy while it grows (scanRun.setWM).

// decodeChunkSizes: the first chunks are small so the first results come fast;
// then decodeChunk1 each. Vars for tests.
var (
	decodeChunkSizes       = []int64{64 << 10, 256 << 10, 1 << 20}
	decodeChunk1     int64 = 1 << 20
)

func decodeNominal(k int) int64 {
	if k < len(decodeChunkSizes) {
		return decodeChunkSizes[k]
	}
	return decodeChunk1
}

// diskMargin: keep at least this much free on the temp volume.
const diskMargin = 256 << 20

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1fGB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.0fMB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%dKB", n>>10)
}

// lowDisk: while writing a temp copy, the volume is down to the margin even
// after the idle cached copies gave way.
func (j *job) lowDisk() (uint64, bool) {
	free, err := j.e.diskFree(j.e.opt.TempDir)
	if err != nil || free >= diskMargin {
		return free, false
	}
	if j.e.freeIdleTemps(j) {
		if f2, err := j.e.diskFree(j.e.opt.TempDir); err == nil {
			free = f2
		}
	}
	return free, free < diskMargin
}

// checkDisk fails when the temp volume has less than need + margin free.
func (j *job) checkDisk(need int64) error {
	if err := os.MkdirAll(j.e.opt.TempDir, 0o700); err != nil {
		return fmt.Errorf("임시 폴더를 만들 수 없습니다: %v", err)
	}
	free, err := j.e.diskFree(j.e.opt.TempDir)
	if err != nil {
		return nil // cannot tell: try anyway
	}
	if int64(free) < need+diskMargin && j.e.freeIdleTemps(j) {
		// copies of finished scans nobody looks at (other chips / tags of a
		// .gz or CP949 log: a copy each) gave way — look again
		if f2, err := j.e.diskFree(j.e.opt.TempDir); err == nil {
			free = f2
		}
	}
	if int64(free) < need+diskMargin {
		return fmt.Errorf("임시 폴더(%s)의 디스크 여유 공간이 부족합니다: 필요 약 %s, 남은 %s", j.e.opt.TempDir, humanBytes(need+diskMargin), humanBytes(int64(free)))
	}
	return nil
}

func (j *job) createTemp() (*os.File, error) {
	if err := os.MkdirAll(j.e.opt.TempDir, 0o700); err != nil {
		return nil, fmt.Errorf("임시 폴더를 만들 수 없습니다: %v", err)
	}
	tmp := filepath.Join(j.e.opt.TempDir, j.id+".utf8")
	f, err := os.Create(tmp)
	if err != nil {
		return nil, fmt.Errorf("임시 사본을 만들 수 없습니다: %v", err)
	}
	j.mu.Lock()
	j.tempFile = tmp
	j.mu.Unlock()
	return f, nil
}

// commit is one piece of the temp copy: its end and the source offset it
// corresponds to (progress and append bookkeeping).
type commit struct{ tmpEnd, srcEnd int64 }

type decoded struct {
	k        int
	data     []byte
	srcStart int64
	srcEnd   int64
	srcNL    int64 // source offset just past the chunk's last newline, -1
}

// freeList recycles the ~1MB chunk buffers of one pipe (a sync.Pool is
// emptied at every GC, which made the copies allocate constantly).
type freeList struct {
	ch   chan []byte
	size int
}

func newFreeList(n, size int) *freeList { return &freeList{ch: make(chan []byte, n), size: size} }

func (f *freeList) get(n int) []byte {
	select {
	case b := <-f.ch:
		if cap(b) >= n {
			return b[:n]
		}
	default:
	}
	return make([]byte, n, max(n, f.size))
}

func (f *freeList) put(b []byte) {
	if cap(b) > 4*f.size {
		return
	}
	select {
	case f.ch <- b[:0]:
	default:
	}
}

// orderedWriter writes decoded chunks to the temp copy strictly in order.
type orderedWriter struct {
	j        *job
	sr       *scanRun
	f        *os.File
	mu       sync.Mutex
	cond     *sync.Cond
	pending  map[int]*decoded
	next     int
	busy     bool
	off      int64
	err      error
	lockFrom bool // append run: the first write overwrites bytes readers may read
	written  int64
	maxAhead int
	decFree  *freeList
}

func newOrderedWriter(j *job, sr *scanRun, f *os.File, off int64, lockFirst bool) *orderedWriter {
	w := &orderedWriter{j: j, sr: sr, f: f, pending: map[int]*decoded{}, off: off, lockFrom: lockFirst, maxAhead: j.e.opt.Workers + 2}
	w.cond = sync.NewCond(&w.mu)
	return w
}

// waitTurn blocks while chunk k is too far ahead of the writer.
func (w *orderedWriter) waitTurn(k int, stopped func() bool) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k >= w.next+w.maxAhead && w.err == nil && !stopped() {
		w.cond.Wait()
	}
	return w.err == nil && !stopped()
}

func (w *orderedWriter) fail(err error) {
	w.mu.Lock()
	if w.err == nil {
		w.err = err
	}
	w.cond.Broadcast()
	w.mu.Unlock()
}

func (w *orderedWriter) deposit(d *decoded) {
	w.mu.Lock()
	w.pending[d.k] = d
	if w.busy {
		w.mu.Unlock()
		return
	}
	w.busy = true
	for {
		x, ok := w.pending[w.next]
		if !ok || w.err != nil {
			w.busy = false
			w.cond.Broadcast()
			w.mu.Unlock()
			return
		}
		delete(w.pending, w.next)
		w.next++
		off := w.off
		w.off += int64(len(x.data))
		w.mu.Unlock()
		err := w.write(x, off)
		w.mu.Lock()
		if err != nil && w.err == nil {
			w.err = err
		}
		w.cond.Broadcast()
	}
}

func (w *orderedWriter) write(x *decoded, off int64) error {
	j := w.j
	if x.k == 0 && w.lockFrom {
		j.content.Lock()
	}
	_, err := w.f.WriteAt(x.data, off)
	if x.k == 0 && w.lockFrom {
		j.content.Unlock()
	}
	end := off + int64(len(x.data))
	if err == nil {
		w.written += int64(len(x.data))
		if w.written>>28 != (w.written-int64(len(x.data)))>>28 { // every 256MB
			if free, low := j.lowDisk(); low {
				err = fmt.Errorf("임시 폴더(%s)의 디스크 여유 공간이 부족해 멈췄습니다 (남은 %s)", j.e.opt.TempDir, humanBytes(int64(free)))
			}
		}
	}
	if err != nil {
		w.sr.setWM(off, false, err)
	} else {
		j.mu.Lock()
		j.commits = append(j.commits, commit{tmpEnd: end, srcEnd: x.srcEnd})
		if nl := bytes.LastIndexByte(x.data, '\n'); nl >= 0 && x.srcNL >= 0 {
			j.nlTmp, j.nlSrc = off+int64(nl)+1, x.srcNL
		}
		j.srcDone = x.srcEnd
		j.mu.Unlock()
		w.sr.setWM(end, false, nil)
	}
	if w.decFree != nil {
		w.decFree.put(x.data)
	}
	return err
}

// srcChunk is a run of whole characters of the source.
type srcChunk struct {
	k                int
	data             []byte
	srcStart, srcEnd int64
}

// decodePipe decodes srcChunks with Workers goroutines into the writer.
type decodePipe struct {
	j       *job
	sr      *scanRun
	enc     string
	in      chan srcChunk
	w       *orderedWriter
	wg      sync.WaitGroup
	srcFree *freeList
}

func (sr *scanRun) stopped() bool {
	if sr.j.stop.Load() {
		return true
	}
	sr.mu.Lock()
	q := sr.quit
	sr.mu.Unlock()
	return q
}

func newDecodePipe(j *job, sr *scanRun, enc string, w *orderedWriter) *decodePipe {
	n := 2*j.e.opt.Workers + 4
	p := &decodePipe{j: j, sr: sr, enc: enc, in: make(chan srcChunk, j.e.opt.Workers), w: w,
		srcFree: newFreeList(n, int(decodeChunk1)+64<<10)}
	w.decFree = newFreeList(n, int(decodeChunk1)*3/2+64)
	sr.addWaker(func() {
		w.mu.Lock()
		w.cond.Broadcast()
		w.mu.Unlock()
	})
	for i := 0; i < j.e.opt.Workers; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			dec := newDecoder(enc)
			for c := range p.in {
				if !w.waitTurn(c.k, sr.stopped) {
					continue // drain
				}
				out := decodeChunk(dec, w.decFree.get(0), c.data)
				nl := int64(-1)
				if k := lastNewline(enc, c.data); k >= 0 {
					nl = c.srcStart + int64(k)
				}
				p.srcFree.put(c.data)
				w.deposit(&decoded{k: c.k, data: out, srcStart: c.srcStart, srcEnd: c.srcEnd, srcNL: nl})
			}
		}()
	}
	return p
}

// finish waits for the decoders and reports the end to the scan.
func (p *decodePipe) finish(feedErr error) {
	close(p.in)
	p.wg.Wait()
	p.w.mu.Lock()
	err := p.w.err
	end := p.w.off
	p.w.mu.Unlock()
	if err == nil {
		err = feedErr
	}
	p.sr.setWM(end, true, err)
}

// transcodeFile decodes the source [from, end) of a CP949 / UTF-16 file into
// the temp copy starting at tmpFrom.
func (j *job) transcodeFile(sr *scanRun, src *os.File, tmp *os.File, enc string, from, end, tmpFrom int64, appending bool) {
	w := newOrderedWriter(j, sr, tmp, tmpFrom, appending)
	p := newDecodePipe(j, sr, enc, w)
	var feedErr error
	probe := make([]byte, 64<<10)
	pos := from
	for k := 0; pos < end; k++ {
		if sr.stopped() {
			break
		}
		b := end
		n := pos + decodeNominal(k)
		if enc != EncCP949 && (n-from)%2 == 1 {
			n++ // UTF-16: cut only at even offsets from the text start
		}
		if n < end {
			b = -1
			for at := n; at < end; {
				m := int64(len(probe))
				if end-at < m {
					m = end - at
				}
				got, err := src.ReadAt(probe[:m], at)
				if int64(got) < m {
					if err == nil || err == io.EOF {
						err = errShrunk
					}
					feedErr = err
					break
				}
				if sp := splitPoint(enc, probe[:m], 0); sp >= 0 {
					b = at + int64(sp)
					break
				}
				at += m
			}
			if feedErr != nil {
				break
			}
			if b < 0 {
				b = end
			}
		}
		data := p.srcFree.get(int(b - pos))
		if got, err := src.ReadAt(data, pos); int64(got) < b-pos {
			if err == nil || err == io.EOF {
				err = errShrunk
			}
			feedErr = err
			break
		}
		p.in <- srcChunk{k: k, data: data, srcStart: pos, srcEnd: b}
		pos = b
	}
	p.finish(feedErr)
}

// gzip ---------------------------------------------------------------------------

// isGzip: the file starts with the gzip magic.
func isGzip(f *os.File) bool {
	var b [3]byte
	n, _ := f.ReadAt(b[:], 0)
	return n == 3 && b[0] == 0x1f && b[1] == 0x8b && b[2] == 8
}

// gzipSizeHint: the uncompressed size stored in the last member's trailer
// (modulo 4GB), or 0.
func gzipSizeHint(f *os.File, size int64) int64 {
	if size < 18 {
		return 0
	}
	var b [4]byte
	if _, err := f.ReadAt(b[:], size-4); err != nil {
		return 0
	}
	return int64(binary.LittleEndian.Uint32(b[:]))
}

type countingReader struct {
	r  io.Reader
	mu sync.Mutex
	n  int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.mu.Lock()
	c.n += int64(n)
	c.mu.Unlock()
	return n, err
}

func (c *countingReader) count() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

func gzipError(err error) error {
	switch {
	case errors.Is(err, gzip.ErrHeader):
		return errors.New("압축 파일(.gz)의 머리 부분이 잘못되었습니다")
	case errors.Is(err, gzip.ErrChecksum):
		return errors.New("압축 파일(.gz)이 손상되었습니다 (검사합이 맞지 않음)")
	case errors.Is(err, io.ErrUnexpectedEOF):
		return errors.New("압축 파일(.gz)이 중간에 잘려 있습니다")
	}
	return fmt.Errorf("압축 파일(.gz)을 풀 수 없습니다: %v", err)
}

// gzipHead: the inflated head read before anything else (encoding detection).
// gzipSniffMax: how far the head is extended when it holds no multi-byte
// character and the encoding is detected (still decided once, before the scan).
const (
	gzipHead     = 4 << 20
	gzipSniffMax = 32 << 20
)

// gzipSource opens the stream and reads its head (for encoding detection).
type gzipSource struct {
	cr   *countingReader
	zr   *gzip.Reader
	head []byte
	eof  bool
}

func openGzip(f *os.File, size int64) (*gzipSource, error) {
	cr := &countingReader{r: io.NewSectionReader(f, 0, size)}
	zr, err := gzip.NewReader(bufio.NewReaderSize(cr, 1<<20))
	if err != nil {
		return nil, gzipError(err)
	}
	g := &gzipSource{cr: cr, zr: zr}
	if _, err := g.extendHead(gzipHead); err != nil {
		return nil, err
	}
	return g, nil
}

// extendHead inflates more of the stream into head, up to max bytes in all,
// and returns the bytes added.
func (g *gzipSource) extendHead(max int) ([]byte, error) {
	have := len(g.head)
	if g.eof || have >= max {
		return nil, nil
	}
	nh := make([]byte, max)
	copy(nh, g.head)
	n, err := io.ReadFull(g.zr, nh[have:])
	g.head = nh[:have+n]
	switch err {
	case nil:
	case io.EOF, io.ErrUnexpectedEOF:
		if err == io.ErrUnexpectedEOF && have+n == 0 {
			return nil, gzipError(err)
		}
		g.eof = true
		// ReadFull reports a short stream as ErrUnexpectedEOF even when the gzip
		// stream ended cleanly; a corrupt one fails on the next Read too.
		if _, e := g.zr.Read(make([]byte, 1)); e != nil && e != io.EOF {
			return nil, gzipError(e)
		}
	default:
		return nil, gzipError(err)
	}
	return g.head[have:], nil
}

// inflate runs the stream into the temp copy: as is (UTF-8), or through the
// decoders (CP949 / UTF-16, after skip bytes of BOM).
func (j *job) inflate(sr *scanRun, g *gzipSource, tmp *os.File, enc string, skip int) {
	limit := j.e.opt.MaxInflate
	if !needsTranscode(enc) {
		// Inflating is the bottleneck and cannot be split: keep this goroutine
		// inflating only, and let a writer goroutine copy to the temp file.
		type piece struct {
			b   []byte
			src int64
		}
		pieces := make(chan piece, 4)
		free := make(chan []byte, 6)
		for i := 0; i < 6; i++ {
			free <- make([]byte, 1<<20)
		}
		var werr error
		var wmu sync.Mutex
		failed := func() bool {
			wmu.Lock()
			defer wmu.Unlock()
			return werr != nil
		}
		var off int64
		done := make(chan struct{})
		go func() {
			defer close(done)
			for pc := range pieces {
				if !failed() {
					var err error
					if _, err = tmp.WriteAt(pc.b, off); err == nil {
						before := off
						off += int64(len(pc.b))
						if off>>28 != before>>28 {
							if free, low := j.lowDisk(); low {
								err = fmt.Errorf("임시 폴더(%s)의 디스크 여유 공간이 부족해 멈췄습니다 (남은 %s)", j.e.opt.TempDir, humanBytes(int64(free)))
							}
						}
					}
					if err != nil {
						wmu.Lock()
						if werr == nil {
							werr = err
						}
						wmu.Unlock()
					} else {
						j.mu.Lock()
						j.commits = append(j.commits, commit{tmpEnd: off, srcEnd: pc.src})
						j.srcDone = pc.src
						j.mu.Unlock()
						sr.setWM(off, false, nil)
					}
				}
				if cap(pc.b) == 1<<20 {
					free <- pc.b[:cap(pc.b)]
				}
			}
		}()
		var err error
		total := int64(len(g.head))
		if total > limit {
			err = fmt.Errorf("압축을 푼 크기가 상한(%s)을 넘어 멈췄습니다", humanBytes(limit))
		} else {
			pieces <- piece{b: g.head, src: g.cr.count()}
			g.head = nil // up to gzipSniffMax: let it go once written
		}
		for err == nil && !g.eof && !sr.stopped() && !failed() {
			buf := <-free
			n, rerr := io.ReadFull(g.zr, buf)
			if n > 0 {
				total += int64(n)
				if total > limit {
					err = fmt.Errorf("압축을 푼 크기가 상한(%s)을 넘어 멈췄습니다", humanBytes(limit))
					break
				}
				pieces <- piece{b: buf[:n], src: g.cr.count()}
			} else {
				free <- buf
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				// distinguish a clean end from a truncated stream
				var one [1]byte
				if _, e := g.zr.Read(one[:]); e != nil && e != io.EOF {
					err = gzipError(e)
				}
				break
			}
			if rerr != nil {
				err = gzipError(rerr)
				break
			}
		}
		close(pieces)
		<-done
		if err == nil {
			err = werr
		}
		sr.setWM(off, true, err)
		return
	}
	w := newOrderedWriter(j, sr, tmp, 0, false)
	p := newDecodePipe(j, sr, enc, w)
	var feedErr error
	carry := append([]byte(nil), g.head[skip:]...)
	var total int64 = int64(len(g.head) - skip)
	g.head = nil // up to gzipSniffMax: do not keep two copies
	srcPos := int64(skip)
	buf := make([]byte, 1<<20)
	eof := g.eof
	k := 0
	for !sr.stopped() {
		if !eof && len(carry) < int(decodeNominal(k)) {
			n, rerr := io.ReadFull(g.zr, buf)
			carry = append(carry, buf[:n]...)
			total += int64(n)
			if total > limit {
				feedErr = fmt.Errorf("압축을 푼 크기가 상한(%s)을 넘어 멈췄습니다", humanBytes(limit))
				break
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				eof = true
				if _, e := g.zr.Read(buf[:1]); e != nil && e != io.EOF {
					feedErr = gzipError(e)
					break
				}
			} else if rerr != nil {
				feedErr = gzipError(rerr)
				break
			}
			continue
		}
		if len(carry) == 0 {
			break
		}
		cut := len(carry)
		if !eof {
			from := int(decodeNominal(k))
			if from > len(carry) {
				from = len(carry)
			}
			sp := splitPoint(enc, carry, from-from%2)
			if sp < 0 {
				// no safe cut yet: read more (or everything at the end)
				if len(carry) > 64<<20 {
					feedErr = errors.New("압축을 푼 내용에서 글자 경계를 찾지 못했습니다")
					break
				}
				n, rerr := io.ReadFull(g.zr, buf)
				carry = append(carry, buf[:n]...)
				total += int64(n)
				if rerr != nil {
					eof = true
				}
				continue
			}
			cut = sp
		}
		data := append(p.srcFree.get(0), carry[:cut]...)
		if len(carry)-cut > 4<<20 {
			carry = carry[cut:] // a long sniffed head: do not move it for every piece
		} else {
			carry = append(carry[:0], carry[cut:]...)
		}
		srcEnd := g.cr.count()
		p.in <- srcChunk{k: k, data: data, srcStart: srcPos, srcEnd: srcEnd}
		srcPos += int64(cut)
		k++
	}
	p.finish(feedErr)
}
