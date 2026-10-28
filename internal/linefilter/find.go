package linefilter

import (
	"sync/atomic"
	"time"
)

// Find: 「찾기」 (Ctrl+F) inside the 「태그 줄만」 view. The view holds only the
// pages on screen, so the search runs here, over the whole filtered result:
// every row the view can show (gap rows excluded), in the text the view shows
// (Row.Text — invalid bytes as U+FFFD, long lines cut at MaxLineDisplay), the
// way the frontend highlights it (the same rule kinds and translation as the
// tag rules: text / word / regex). Rows after the result's byte cap (MaxBytes,
// which the view never shows) are not searched.

// MaxFind: rows listed by one Find (Total keeps counting past it).
const MaxFind = 100_000

// FindResult answers Find.
type FindResult struct {
	Rows     []int  `json:"rows"`               // matching rows of the view, in order (at most MaxFind)
	Total    int    `json:"total"`              // matching rows (more than len(Rows) when Capped)
	Capped   bool   `json:"capped,omitempty"`   // more than MaxFind rows match
	Searched int    `json:"searched"`           // rows 0 … Searched-1 were searched
	Partial  bool   `json:"partial,omitempty"`  // the scan is still running: rows may be added, search again later
	Canceled bool   `json:"canceled,omitempty"` // a newer Find (or Close) on this view took over; the result is incomplete
	Issue    string `json:"issue,omitempty"`    // the query cannot be used: why (Korean); nothing searched
	Version  int    `json:"version"`            // Progress.Version the rows belong to
	Changed  bool   `json:"changed,omitempty"`  // the file was rewritten: the view starts again
}

var findSeq atomic.Int64

// Find lists the rows of view id (with above/below context lines, as Rows)
// whose text matches q (kind, pattern, caseSensitive of a LogRule). A newer
// Find on the same view stops this one (Canceled).
func (e *Engine) Find(id string, above, below int, q Rule) (FindResult, error) {
	v, err := e.view(id)
	if err != nil {
		return FindResult{}, err
	}
	out := FindResult{Rows: []int{}}
	if q.Pattern == "" {
		// An empty query is also how the view stops a running Find (찾기 closed
		// or its text cleared): taking a new seq makes the older one stale.
		v.findSeq.Store(findSeq.Add(1))
		return out, nil
	}
	q.On, q.Filter = nil, nil
	cr, why := compileOne(q)
	if why != "" {
		out.Issue = why
		return out, nil
	}
	match := func(s string) bool {
		if cr.emptyToo {
			return firstNonEmpty(cr.lineRe, []byte(s)) >= 0
		}
		return cr.lineRe.MatchString(s)
	}
	seq := findSeq.Add(1)
	v.findSeq.Store(seq)
	stale := func() bool { return v.findSeq.Load() != seq }

	j := v.j
	j.checkFile(false)
	A, B := clampCtx(above), clampCtx(below)
	j.mu.Lock()
	out.Version = j.version
	if j.changed {
		out.Changed = true
		j.mu.Unlock()
		return out, nil
	}
	j.lastUse = time.Now()
	lay := j.layoutLocked(A, B)
	hits := j.hits[:lay.nh:lay.nh]
	ext := j.ext[:len(j.ext):len(j.ext)]
	longs := j.longs[:len(j.longs):len(j.longs)]
	readPath, dataStart, size := j.readPath, j.dataStart, j.size
	j.mu.Unlock()
	out.Partial = lay.total < 0

	j.content.RLock()
	defer j.content.RUnlock()
	rd := &rowReader{j: j, lay: lay, hits: hits, ext: ext, longs: longs, path: readPath, dataStart: dataStart, size: size, maxText: e.opt.MaxLineDisplay}
	defer rd.close()

	const batch = 2000
	var used int64
	for from := 0; from < lay.avail; {
		if stale() {
			out.Canceled = true
			return out, nil
		}
		to := from + batch
		if to > lay.avail {
			to = lay.avail
		}
		rows, err := rd.rows(from, to, 0)
		if err != nil {
			return out, err
		}
		if len(rows) == 0 {
			break
		}
		for i := range rows {
			r := &rows[i]
			if used += rowBytes(r); used > e.opt.MaxBytes {
				// the view stops here (Page.Truncated "bytes"): nothing after it is shown
				out.Searched = from + i
				out.Partial = false
				return out, nil
			}
			if r.Line == 0 || !match(r.Text) {
				continue
			}
			out.Total++
			if len(out.Rows) < MaxFind {
				out.Rows = append(out.Rows, from+i)
			} else {
				out.Capped = true
			}
		}
		from += len(rows)
		out.Searched = from
	}
	return out, nil
}
