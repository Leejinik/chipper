package linefilter

import (
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 「⋯ N줄 생략」 펼치기 (open.go): RowsOpen / RowOfLineOpen / FindOpen.

func collectOpen(t testing.TB, e *Engine, id string, above, below int, open []int64, rng *rand.Rand) ([]Row, Page) {
	t.Helper()
	var rows []Row
	var last Page
	for guard := 0; guard < 1_000_000; guard++ {
		n := 1 + rng.Intn(37)
		if rng.Intn(4) == 0 {
			n = 5000
		}
		p, err := e.RowsOpen(id, above, below, open, len(rows), n)
		if err != nil {
			t.Fatalf("RowsOpen: %v", err)
		}
		rows = append(rows, p.Rows...)
		last = p
		if p.End || p.Changed {
			return rows, last
		}
		if len(p.Rows) == 0 {
			t.Fatalf("no rows and not end: %+v", p)
		}
	}
	t.Fatal("too many pages")
	return nil, last
}

// numbered lines; ERROR on the given lines
func openDoc(n int, errAt ...int) string {
	is := map[int]bool{}
	for _, k := range errAt {
		is[k] = true
	}
	var b strings.Builder
	for i := 1; i <= n; i++ {
		if is[i] {
			fmt.Fprintf(&b, "l%d ERROR\n", i)
		} else {
			fmt.Fprintf(&b, "l%d\n", i)
		}
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func startWait(t testing.TB, e *Engine, p string, rules []Rule, exclude []Rule) string {
	t.Helper()
	res, err := e.Start(Request{Path: p, Rules: rules, Exclude: exclude})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Wait(res.JobID); err != nil {
		t.Fatal(err)
	}
	return res.JobID
}

// shape: one letter per row — G gap, F fold, H hit, C context, O opened line.
func shape(rows []Row) string {
	var b strings.Builder
	for _, r := range rows {
		switch {
		case r.Fold:
			fmt.Fprintf(&b, "F%d@%d ", r.Skip, r.From)
		case r.Line == 0:
			fmt.Fprintf(&b, "G%d@%d ", r.Skip, r.From)
		case r.Hit:
			fmt.Fprintf(&b, "H%d ", r.Line)
		case r.Open:
			fmt.Fprintf(&b, "O%d ", r.Line)
		default:
			fmt.Fprintf(&b, "C%d ", r.Line)
		}
	}
	return strings.TrimSpace(b.String())
}

// The view's buttons on 「⋯ 100줄 생략」 between two hit blocks: ▲ 20 줄 (from
// the top of the gap), ▼ 20 줄 (from its bottom), 전부 — and folding again.
func TestOpenMeaning(t *testing.T) {
	e := newTestEngine(t, Options{Chunk: 7, BufSize: 64})
	// hits 3 and 106 with 1 line around: gap 5..104 (100 lines), lead 1, trail 108..110
	p := writeTemp(t, []byte(openDoc(110, 3, 106)))
	id := startWait(t, e, p, errRule, nil)
	get := func(open ...int64) string {
		rows, _ := collectOpen(t, e, id, 1, 1, open, rand.New(rand.NewSource(1)))
		return shape(rows)
	}
	if g, w := get(), "G1@1 C2 H3 C4 G100@5 C105 H106 C107 G3@108"; g != w {
		t.Fatalf("closed:\n%s\nwant\n%s", g, w)
	}
	// ▲ 20: lines 5..24 below the block above, a fold row on top of them
	if g, w := get(5, 24), "G1@1 C2 H3 C4 F20@5 O5 O6 O7 O8 O9 O10 O11 O12 O13 O14 O15 O16 O17 O18 O19 O20 O21 O22 O23 O24 G80@25 C105 H106 C107 G3@108"; g != w {
		t.Fatalf("▲20:\n%s\nwant\n%s", g, w)
	}
	// ▲ 20 and ▼ 20: the gap row in between holds the rest (60)
	g := get(5, 24, 85, 104)
	if !strings.Contains(g, "O24 G60@25 F20@85 O85") || !strings.HasSuffix(g, "O104 C105 H106 C107 G3@108") {
		t.Fatalf("▲20 ▼20: %s", g)
	}
	// 전부 (given as two touching stretches: merged) — one fold row, no gap
	g = get(5, 50, 51, 104)
	if !strings.HasPrefix(g, "G1@1 C2 H3 C4 F100@5 O5 O6") || !strings.HasSuffix(g, "O104 C105 H106 C107 G3@108") || strings.Contains(g, "G100") {
		t.Fatalf("all: %s", g)
	}
	// the leading and the trailing gap open too (to the file's ends)
	if g, w := get(1, 1, 108, 110), "F1@1 O1 C2 H3 C4 G100@5 C105 H106 C107 F3@108 O108 O109 O110"; g != w {
		t.Fatalf("ends:\n%s\nwant\n%s", g, w)
	}
	// a stretch over a hit block: the block keeps its rows, the rest are two runs
	if g, w := get(1, 6), "F1@1 O1 C2 H3 C4 F2@5 O5 O6 G98@7 C105 H106 C107 G3@108"; g != w {
		t.Fatalf("over a block:\n%s\nwant\n%s", g, w)
	}
	// beyond the file: ignored past its last line
	if g, w := get(109, 500), "G1@1 C2 H3 C4 G100@5 C105 H106 C107 G1@108 F2@109 O109 O110"; g != w {
		t.Fatalf("past the end:\n%s\nwant\n%s", g, w)
	}
	// folded again (no stretch): as before
	if g, w := get(), "G1@1 C2 H3 C4 G100@5 C105 H106 C107 G3@108"; g != w {
		t.Fatalf("folded again:\n%s\nwant\n%s", g, w)
	}
	// the opened lines' text is the file's
	rows, _ := collectOpen(t, e, id, 1, 1, []int64{50, 52}, rand.New(rand.NewSource(1)))
	var texts []string
	for _, r := range rows {
		if r.Open {
			texts = append(texts, r.Text)
		}
	}
	if !reflect.DeepEqual(texts, []string{"l50", "l51", "l52"}) {
		t.Fatalf("texts %v", texts)
	}
	// RowOfLine: an opened line is its own row (not the fold row above it); a
	// line still left out → the gap row standing for it
	for _, c := range []struct {
		line int64
		want int
	}{{5, 5}, {24, 24}, {25, 25}, {84, 25}, {85, 27}, {105, 47}} {
		r, err := e.RowOfLineOpen(id, 1, 1, []int64{5, 24, 85, 104}, c.line)
		if err != nil || r != c.want {
			t.Errorf("RowOfLineOpen(%d) = %d, %v; want %d", c.line, r, err, c.want)
		}
	}
}

// The open stretches are file lines: other rules (a new scan) lay out the same
// stretches, merged with the new hit blocks where they meet.
func TestOpenKeptByLineAcrossRescans(t *testing.T) {
	e := newTestEngine(t, Options{Chunk: 5, BufSize: 32})
	doc := openDoc(60, 10, 40)
	doc = strings.Replace(doc, "l30\n", "l30 WARN\n", 1)
	p := writeTemp(t, []byte(doc))
	open := []int64{25, 34}
	id1 := startWait(t, e, p, errRule, nil)
	rows1, _ := collectOpen(t, e, id1, 0, 0, open, rand.New(rand.NewSource(2)))
	if g, w := shape(rows1), "G9@1 H10 G14@11 F10@25 O25 O26 O27 O28 O29 O30 O31 O32 O33 O34 G5@35 H40 G20@41"; g != w {
		t.Fatalf("ERROR:\n%s\nwant\n%s", g, w)
	}
	// WARN is now a rule too: line 30 is a hit inside the opened stretch,
	// splitting it into two runs around its block
	id2 := startWait(t, e, p, []Rule{errRule[0], {Kind: "text", Pattern: "WARN", CaseSensitive: true}}, nil)
	rows2, _ := collectOpen(t, e, id2, 1, 1, open, rand.New(rand.NewSource(2)))
	if g, w := shape(rows2), "G8@1 C9 H10 C11 G13@12 F4@25 O25 O26 O27 O28 C29 H30 C31 F3@32 O32 O33 O34 G4@35 C39 H40 C41 G19@42"; g != w {
		t.Fatalf("ERROR+WARN:\n%s\nwant\n%s", g, w)
	}
	// ERROR excluded on line 40 by a chip: its block goes, the stretch stays
	id3 := startWait(t, e, p, errRule, []Rule{{Kind: "text", Pattern: "l40 "}})
	rows3, _ := collectOpen(t, e, id3, 0, 0, open, rand.New(rand.NewSource(2)))
	if g, w := shape(rows3), "G9@1 H10 G14@11 F10@25 O25 O26 O27 O28 O29 O30 O31 O32 O33 O34 G26@35"; g != w {
		t.Fatalf("excluded:\n%s\nwant\n%s", g, w)
	}
}

// Opened lines count against MaxRows (20만 행) and MaxBytes (64MB) as the
// others: the notice the view shows must be right with them.
func TestOpenCaps(t *testing.T) {
	doc := openDoc(200, 5, 150)
	// MaxRows 30: 5 (hit) + 29 opened lines of 6.., then capped
	e := newTestEngine(t, Options{Chunk: 9, BufSize: 32, MaxRows: 30})
	p := writeTemp(t, []byte(doc))
	id := startWait(t, e, p, errRule, nil)
	rows, last := collectOpen(t, e, id, 0, 0, []int64{6, 149}, rand.New(rand.NewSource(3)))
	want, wantTrunc := refFilter(doc, errRule, refOpts{maxRows: 30, maxDisplay: 1 << 20, open: []int64{6, 149}})
	diffRows(t, rows, want, nil)
	if !wantTrunc || last.Truncated != "rows" {
		t.Fatalf("rows cap: truncated %q (ref %v)", last.Truncated, wantTrunc)
	}
	if n := len(rows); n != 32 { // G4 H5 F29 O×29
		t.Fatalf("%d rows: %s", n, shape(rows))
	}
	// without the opened lines the same result is not capped
	_, last = collectOpen(t, e, id, 0, 0, nil, rand.New(rand.NewSource(3)))
	if last.Truncated != "" {
		t.Fatalf("closed: truncated %q", last.Truncated)
	}

	// MaxBytes: 100 bytes of text → the rows that fit
	e2 := newTestEngine(t, Options{Chunk: 9, BufSize: 32, MaxBytes: 100})
	id2 := startWait(t, e2, p, errRule, nil)
	rows2, last2 := collectOpen(t, e2, id2, 0, 0, []int64{6, 149}, rand.New(rand.NewSource(3)))
	all, _ := refFilter(doc, errRule, refOpts{maxRows: 1 << 20, maxDisplay: 1 << 20, open: []int64{6, 149}})
	var b int64
	k := 0
	for ; k < len(all); k++ {
		if b+rowBytes(&all[k]) > 100 {
			break
		}
		b += rowBytes(&all[k])
	}
	diffRows(t, rows2, all[:k], nil)
	if last2.Truncated != "bytes" || last2.Total != k {
		t.Fatalf("bytes cap: %q total %d want %d", last2.Truncated, last2.Total, k)
	}
}

// Opening a stretch below the place shown starts the byte count from the
// rows already counted above it (no reading of every row above again), and a
// page asked for far down with a fresh stretch set gives the right rows.
func TestOpenByteMarksInherited(t *testing.T) {
	var errAt []int
	for i := 7; i < 4000; i += 13 {
		errAt = append(errAt, i)
	}
	doc := openDoc(4000, errAt...)
	e := newTestEngine(t, Options{Chunk: 512, BufSize: 64, MaxBytes: 30_000})
	p := writeTemp(t, []byte(doc))
	id := startWait(t, e, p, errRule, nil)
	rng := rand.New(rand.NewSource(4))
	sets := [][]int64{nil, {3000, 3005}, {3000, 3005, 100, 110}, {100, 110}, {100, 110, 3500, 3520}, {1, 4000}}
	for _, open := range sets {
		full, _ := refFilter(doc, errRule, refOpts{above: 1, below: 2, maxRows: 1 << 20, maxDisplay: 1 << 20, open: open})
		want := full
		var b int64
		k := 0
		for ; k < len(want); k++ {
			if b+rowBytes(&want[k]) > 30_000 {
				break
			}
			b += rowBytes(&want[k])
		}
		want = want[:k]
		// a page far down first (the marks of the set before are the start)
		from := rng.Intn(len(want))
		pg, err := e.RowsOpen(id, 1, 2, open, from, 50)
		if err != nil {
			t.Fatal(err)
		}
		diffRows(t, pg.Rows, want[from:min(from+len(pg.Rows), len(want))], nil)
		got, last := collectOpen(t, e, id, 1, 2, open, rng)
		diffRows(t, got, want, nil)
		if (last.Truncated == "bytes") != (k < len(full)) {
			t.Fatalf("open %v: truncated %q", open, last.Truncated)
		}
	}
}

// Random documents (encodings, .gz, line breaks, long lines, chunk sizes) with
// random open stretches against the reference; RowOfLineOpen and FindOpen too.
func TestOpenRandomAgainstReference(t *testing.T) {
	seed := time.Now().UnixNano()
	if s := os.Getenv("LF_SEED"); s != "" {
		fmt.Sscan(s, &seed)
	}
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewSource(seed))
	iters := 300
	if testing.Short() {
		iters = 60
	}
	for it := 0; it < iters; it++ {
		doc := randDoc(rng, rng.Intn(3) == 0)
		if rng.Intn(3) == 0 {
			doc = append(append(doc, '\n'), randDoc(rng, false)...) // longer
		}
		data, enc := encodeDoc(rng, doc)
		var rules []Rule
		for _, r := range randRules {
			if rng.Intn(3) == 0 {
				rules = append(rules, r)
			}
		}
		var exclude []Rule
		if rng.Intn(2) == 0 {
			for _, r := range randExcludes {
				if rng.Intn(4) == 0 {
					exclude = append(exclude, r)
				}
			}
		}
		chunk := []int64{1, 3, 17, 64, 1 << 20}[rng.Intn(5)]
		bufSize := []int{8, 16, 33, 100, 1 << 16}[rng.Intn(5)]
		maxRows := []int{3, 10, 1 << 20}[rng.Intn(3)]
		maxDisplay := []int{5, 1 << 20}[rng.Intn(2)]
		above, below := rng.Intn(3), rng.Intn(3)
		gz := rng.Intn(5) == 0
		e := New(Options{Workers: 1 + rng.Intn(4), Chunk: chunk, BufSize: bufSize, MaxRows: maxRows, MaxLineDisplay: maxDisplay,
			DFAMemory: 1, TempDir: t.TempDir(), WatchEvery: -1})
		fileData := data
		if gz {
			fileData = gzipBytes(data)
		}
		p := writeTemp(t, fileData)
		res, err := e.Start(Request{Path: p, Encoding: enc, Rules: rules, Exclude: exclude})
		if err != nil {
			t.Fatal(err)
		}
		prog, _ := e.Wait(res.JobID)
		func() {
			var open []int64
			defer func() {
				if t.Failed() {
					t.Logf("iter %d chunk=%d buf=%d maxRows=%d disp=%d A=%d B=%d enc=%q gz=%v rules=%+v exclude=%+v open=%v\ndoc=%q", it, chunk, bufSize, maxRows, maxDisplay, above, below, enc, gz, rules, exclude, open, data)
				}
			}()
			if prog.Error != "" {
				t.Fatalf("iter %d: %s", it, prog.Error)
			}
			text := refDecode(data, prog.Encoding)
			nl := len(refLines(text))
			colOK := func(g, w Row) bool { return g.Hit && g.Col == -1 && GiantMax < 1000 }
			// a few open sets in a row (each grows or shrinks the one before, as the view does)
			for step := 0; step < 4; step++ {
				switch {
				case step == 0 || rng.Intn(4) == 0:
					open = nil
				}
				for k := rng.Intn(4); k > 0; k-- {
					lo := int64(rng.Intn(nl+3) - 1)
					open = append(open, lo, lo+int64(rng.Intn(25))-2)
				}
				got, last := collectOpen(t, e, res.JobID, above, below, open, rng)
				want, wantTrunc := refFilter(text, rules, refOpts{above: above, below: below, maxRows: maxRows, maxDisplay: maxDisplay, exclude: exclude, open: open})
				diffRows(t, got, want, colOK)
				if t.Failed() {
					return
				}
				if (last.Truncated == "rows") != wantTrunc {
					t.Fatalf("truncated=%q want %v", last.Truncated, wantTrunc)
				}
				// RowOfLineOpen: the first row showing a line ≥ x, or the gap row covering x
				for x := int64(1); x <= int64(nl); x++ {
					r, err := e.RowOfLineOpen(res.JobID, above, below, open, x)
					if err != nil {
						t.Fatal(err)
					}
					w := len(want)
					for i, row := range want {
						if (row.Line >= x) || (row.Line == 0 && !row.Fold && row.From+row.Skip-1 >= x) {
							w = i
							break
						}
					}
					if wantTrunc && w == len(want) {
						continue // past the cap: any row at the end
					}
					if r != w {
						t.Fatalf("RowOfLineOpen(%d) = %d want %d (rows %s)", x, r, w, shape(want))
					}
				}
				// FindOpen: opened lines are searched too, gap / fold rows never
				q := Rule{Kind: "text", Pattern: []string{"a", "e", "ERR", "1"}[rng.Intn(4)]}
				fr, err := e.FindOpen(res.JobID, above, below, open, q)
				if err != nil {
					t.Fatal(err)
				}
				var wf []int
				for i, row := range want {
					if row.Line > 0 && strings.Contains(strings.ToLower(row.Text), strings.ToLower(q.Pattern)) {
						wf = append(wf, i)
					}
				}
				if !reflect.DeepEqual(fr.Rows, wf) && !(len(fr.Rows) == 0 && len(wf) == 0) {
					t.Fatalf("FindOpen %q = %v want %v", q.Pattern, fr.Rows, wf)
				}
			}
		}()
		e.CloseAll(time.Second)
		if t.Failed() {
			return
		}
	}
}

// A growing log: lines appended after an open stretch reaching the old end.
// The stretch is file lines, so the new lines come after it; a stretch past the
// old end (opened while the file was shorter) takes the new lines in as they
// come, its fold row growing (the view drops from that fold row).
func TestOpenAppend(t *testing.T) {
	e := newTestEngine(t, Options{Chunk: 7, BufSize: 32})
	doc := openDoc(30, 5)
	p := writeTemp(t, []byte(doc+"\n"))
	id := startWait(t, e, p, errRule, nil)
	open := []int64{20, 31, 40, 45}
	rows, _ := collectOpen(t, e, id, 0, 0, open, rand.New(rand.NewSource(5)))
	want, _ := refFilter(doc+"\n", errRule, refOpts{maxRows: 1 << 20, maxDisplay: 1 << 20, open: open})
	diffRows(t, rows, want, nil)
	time.Sleep(2 * time.Millisecond)
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("l31\nl32 ERROR\nl33\nl34\nl35\nl36\nl37\nl38\nl39\nl40\nl41\nl42")
	f.Close()
	v, _ := e.view(id)
	v.j.checkFile(true)
	if _, err := e.Wait(id); err != nil {
		t.Fatal(err)
	}
	all := doc + "\nl31\nl32 ERROR\nl33\nl34\nl35\nl36\nl37\nl38\nl39\nl40\nl41\nl42"
	rows, _ = collectOpen(t, e, id, 0, 0, open, rand.New(rand.NewSource(5)))
	want, _ = refFilter(all, errRule, refOpts{maxRows: 1 << 20, maxDisplay: 1 << 20, open: open})
	diffRows(t, rows, want, nil)
	if g := shape(rows); !strings.Contains(g, "F12@20 O20") || !strings.Contains(g, "H32 G7@33 F3@40 O40 O41 O42") {
		t.Fatalf("after the append: %s", g)
	}
}
