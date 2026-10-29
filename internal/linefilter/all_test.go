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

// 「📖 읽기 보기」 (Request.Mode "all"): every line of the file, the lines an
// Exclude rule matches hidden — compared with the reference split (the
// editor's lines) on random documents, encodings, .gz, appends and tiny
// regions / buffers.

// refAll: the rows a mode "all" view must show, the hidden count, and per row
// the line it shows.
func refAll(text string, exclude []Rule, maxDisplay int) ([]Row, int64) {
	lines := refLines(text)
	xbad := map[int]bool{}
	for _, is := range Validate(exclude) {
		xbad[is.Index] = true
	}
	var rows []Row
	var hidden int64
	for li, ln := range lines {
		judge, _ := refStripANSI(ln)
		hide := false
		for ri, r := range exclude {
			if xbad[ri] || !r.enabled() || r.Pattern == "" {
				continue
			}
			if ok, _ := refMatch(r, judge); ok {
				hide = true
				break
			}
		}
		if hide {
			hidden++
			continue
		}
		t, cut := refText(ln, maxDisplay)
		rows = append(rows, Row{Line: int64(li + 1), Text: t, TruncatedLine: cut, Col: -1})
	}
	return rows, hidden
}

// refFindAll: the rows (of the visible ones) whose line q matches.
func refFindAll(rows []Row, text string, q Rule) []int {
	lines := refLines(text)
	out := []int{}
	for i, r := range rows {
		judge, _ := refStripANSI(lines[r.Line-1])
		if ok, _ := refMatch(q, judge); ok {
			out = append(out, i)
		}
	}
	return out
}

func startAll(t testing.TB, e *Engine, p, enc string, exclude []Rule) (StartResult, Progress) {
	t.Helper()
	res, err := e.Start(Request{Path: p, Encoding: enc, Exclude: exclude, Mode: ModeAll})
	if err != nil {
		t.Fatal(err)
	}
	prog, err := e.Wait(res.JobID)
	if err != nil {
		t.Fatal(err)
	}
	return res, prog
}

func TestAllRandomAgainstReference(t *testing.T) {
	seed := time.Now().UnixNano()
	if s := os.Getenv("LF_SEED"); s != "" {
		fmt.Sscan(s, &seed)
	}
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewSource(seed))
	iters := 400
	if testing.Short() {
		iters = 80
	}
	for it := 0; it < iters; it++ {
		doc := randDoc(rng, rng.Intn(3) == 0)
		ansi := rng.Intn(6) == 0
		if ansi {
			// ANSI colour codes: judged without them, shown as they are
			doc = []byte(strings.ReplaceAll(string(doc), "ERROR", "\x1b[31mERROR\x1b[0m"))
		}
		data, enc := encodeDoc(rng, doc)
		var exclude []Rule
		if rng.Intn(4) > 0 {
			for _, r := range randExcludes {
				if rng.Intn(4) == 0 {
					exclude = append(exclude, r)
				}
			}
		}
		k := knobs{
			litPass:  []int{0, 4, 1000}[rng.Intn(3)],
			group:    []int{1, 2, 3, 8}[rng.Intn(4)],
			minMem:   []int{64 << 10, 64 << 10, 600}[rng.Intn(3)],
			giant:    []int{1 << 30, 1 << 30, 20}[rng.Intn(3)],
			decSizes: [][]int64{{64 << 10, 256 << 10, 1 << 20}, {1, 3, 7}, {}}[rng.Intn(3)],
			dec1:     []int64{1 << 20, 5, 64}[rng.Intn(3)],
		}
		if ansi {
			// a line past GiantMax is judged piece by piece, ANSI codes and all
			// (known since v1.3.0, the same in 「🏷 줄만」)
			k.giant = 1 << 30
		}
		restore := setKnobs(k)
		chunk := []int64{1, 3, 17, 64, 1 << 20}[rng.Intn(5)]
		bufSize := []int{8, 16, 33, 100, 1 << 16}[rng.Intn(5)]
		maxDisplay := []int{5, 1 << 20}[rng.Intn(2)]
		pageBytes := []int64{1, 64, 4 << 20}[rng.Intn(3)]
		gz := rng.Intn(5) == 0
		appendSplit := -1
		if !gz && rng.Intn(4) == 0 && len(data) > 0 {
			appendSplit = rng.Intn(len(data) + 1)
		}
		e := New(Options{Workers: 1 + rng.Intn(4), Chunk: chunk, BufSize: bufSize, MaxRows: 3, MaxBytes: 10, MaxLineDisplay: maxDisplay,
			MaxPageBytes: pageBytes, DFAMemory: 1, TempDir: t.TempDir(), WatchEvery: -1})
		fileData := data
		if gz {
			fileData = gzipBytes(data)
		}
		first := fileData
		if appendSplit >= 0 {
			first = fileData[:appendSplit]
		}
		p := writeTemp(t, first)
		res, prog := startAll(t, e, p, enc, exclude)
		if appendSplit >= 0 && prog.Error == "" {
			collect(t, e, res.JobID, 0, 0, rng)
			time.Sleep(2 * time.Millisecond)
			f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
			f.Write(fileData[appendSplit:])
			f.Close()
			v, _ := e.view(res.JobID)
			v.j.checkFile(true)
			prog, _ = e.Wait(res.JobID)
		}
		func() {
			defer restore()
			defer func() {
				if t.Failed() {
					t.Logf("iter %d chunk=%d buf=%d disp=%d page=%d knobs=%+v enc=%q gz=%v appendAt=%d exclude=%+v\ndoc=%q", it, chunk, bufSize, maxDisplay, pageBytes, k, enc, gz, appendSplit, exclude, data)
				}
			}()
			if prog.Error != "" {
				t.Fatalf("iter %d: %s", it, prog.Error)
			}
			if prog.Mode != ModeAll {
				t.Fatalf("mode %q", prog.Mode)
			}
			text := refDecode(data, prog.Encoding)
			want, hidden := refAll(text, exclude, maxDisplay)
			// the context sizes mean nothing here, and the 「🏷 줄만」 caps (3
			// rows, 10 bytes) do not apply
			got, last := collect(t, e, res.JobID, rng.Intn(3), rng.Intn(3), rng)
			diffRows(t, got, want, func(Row, Row) bool { return false })
			if last.Total != len(want) || last.Truncated != "" {
				t.Fatalf("total %d trunc %q want %d", last.Total, last.Truncated, len(want))
			}
			total := int64(len(refLines(text)))
			if prog.TotalLines != total || prog.Excluded != hidden || prog.Hits != total-hidden || prog.Truncated {
				t.Fatalf("progress lines %d hidden %d shown %d trunc %v; want %d %d %d", prog.TotalLines, prog.Excluded, prog.Hits, prog.Truncated, total, hidden, total-hidden)
			}
			// pages from anywhere (a jump) say the same rows
			for k := 0; k < 5 && len(want) > 0; k++ {
				from := rng.Intn(len(want))
				pg, err := e.Rows(res.JobID, 0, 0, from, 1+rng.Intn(7))
				if err != nil {
					t.Fatal(err)
				}
				for i, r := range pg.Rows {
					if !reflect.DeepEqual(normRows([]Row{r}), normRows([]Row{want[from+i]})) {
						t.Fatalf("page from %d row %d: %+v want %+v", from, i, r, want[from+i])
					}
				}
			}
			// RowOfLine: the row showing the line, or the first after it
			for k := 0; k < 5; k++ {
				L := int64(1 + rng.Intn(int(total)+1))
				row, err := e.RowOfLine(res.JobID, 0, 0, L)
				if err != nil {
					t.Fatal(err)
				}
				w := len(want)
				for i, r := range want {
					if r.Line >= L {
						w = i
						break
					}
				}
				if row != w {
					t.Fatalf("RowOfLine(%d) = %d want %d", L, row, w)
				}
			}
			// Find: the visible rows a query matches (over the whole file)
			for k := 0; k < 3; k++ {
				q := randRules[rng.Intn(len(randRules))]
				q.On, q.Filter = nil, nil
				fr, err := e.Find(res.JobID, 0, 0, q)
				if err != nil {
					t.Fatal(err)
				}
				if len(Validate([]Rule{q})) > 0 {
					if fr.Issue == "" {
						t.Fatalf("find %+v: no issue", q)
					}
					continue
				}
				wr := refFindAll(want, text, q)
				if fr.Issue != "" || fr.Total != len(wr) || !reflect.DeepEqual(fr.Rows, wr) || fr.Partial || fr.Searched != len(want) {
					t.Fatalf("find %+v: %+v want %v", q, fr, wr)
				}
			}
		}()
		e.CloseAll(time.Second)
		if t.Failed() {
			return
		}
	}
}

// A mode "all" job is not shared with a 「🏷 줄만」 job of the same rules (and
// the other way round), and switching back reuses the cached one.
func TestAllCacheSeparateFromLines(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("a ERROR\nb\nc ERROR\n"))
	ex := []Rule{{Kind: "text", Pattern: "ERROR"}}
	r1, _ := startAll(t, e, p, "", ex)
	l, err := e.Start(Request{Path: p, Rules: ex})
	if err != nil {
		t.Fatal(err)
	}
	if l.Cached {
		t.Fatal("a 줄만 job reused the 읽기 job")
	}
	e.Wait(l.JobID)
	rows, _ := collect(t, e, r1.JobID, 0, 0, rand.New(rand.NewSource(1)))
	if got := rowStrings(rows); !reflect.DeepEqual(got, []string{" 2:b", " 4:"}) {
		t.Fatalf("all rows %v", got)
	}
	e.Close(r1.JobID)
	r2, err := e.Start(Request{Path: p, Exclude: ex, Mode: ModeAll})
	if err != nil {
		t.Fatal(err)
	}
	if !r2.Cached {
		t.Fatal("switching back did not reuse the 읽기 job")
	}
	if _, err := e.Start(Request{Path: p, Mode: "bogus"}); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

// Rules are not used in mode "all"; an exclude rule RE2 cannot run is reported
// as an exclude issue (the chip says why).
func TestAllIssuesAreExcludeIssues(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("xy\nzz\n"))
	res, err := e.Start(Request{Path: p, Rules: []Rule{{Kind: "text", Pattern: "zz"}}, Exclude: []Rule{{Kind: "regex", Pattern: `(?<=x)y`}, {Kind: "text", Pattern: "zz"}}, Mode: ModeAll})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Issues) != 0 || len(res.ExcludeIssues) != 1 || res.ExcludeIssues[0].Index != 0 {
		t.Fatalf("issues %+v exclude %+v", res.Issues, res.ExcludeIssues)
	}
	e.Wait(res.JobID)
	rows, _ := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(1)))
	if got := rowStrings(rows); !reflect.DeepEqual(got, []string{" 1:xy", " 3:"}) {
		t.Fatalf("rows %v", got)
	}
}

// A big file: no 20만-row or 64MB cap, pages from the middle are quick (a
// region start is near), and the job holds only its region list.
func TestAllBigNoCaps(t *testing.T) {
	var b strings.Builder
	n := 300_000
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "2026-10-28 12:00:00 INFO line %d %s\n", i, strings.Repeat("x", i%300))
	}
	p := writeTemp(t, []byte(b.String()))
	e := newTestEngine(t, Options{Chunk: 1 << 20})
	res, prog := startAll(t, e, p, "", nil)
	if prog.TotalLines != int64(n+1) || prog.Hits != int64(n+1) {
		t.Fatalf("lines %d shown %d", prog.TotalLines, prog.Hits)
	}
	t0 := time.Now()
	pg, err := e.Rows(res.JobID, 0, 0, 250_000, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(pg.Rows) != 100 || pg.Rows[0].Line != 250_001 || !strings.Contains(pg.Rows[0].Text, " line 250001 ") || pg.Total != n+1 {
		t.Fatalf("page %+v", pg.Rows[0])
	}
	if d := time.Since(t0); d > 500*time.Millisecond {
		t.Fatalf("page from the middle took %v", d)
	}
	fr, err := e.Find(res.JobID, 0, 0, Rule{Kind: "text", Pattern: "line 29999"})
	if err != nil {
		t.Fatal(err)
	}
	// 29999, 299990..299999
	if fr.Total != 11 || fr.Rows[0] != 29998 || fr.Rows[10] != 299998 {
		t.Fatalf("find %+v", fr)
	}
	// hide every line with "1 x": the rows close up
	res2, prog2 := startAll(t, e, p, "", []Rule{{Kind: "text", Pattern: "line 1"}})
	want := int64(0)
	for i := 1; i <= n; i++ {
		if strings.HasPrefix(fmt.Sprint(i), "1") {
			want++
		}
	}
	if prog2.Excluded != want || prog2.Hits != int64(n+1)-want {
		t.Fatalf("hidden %d want %d", prog2.Excluded, want)
	}
	pg2, _ := e.Rows(res2.JobID, 0, 0, 0, 3)
	if got := rowStrings(pg2.Rows); len(got) != 3 || !strings.HasPrefix(got[0], " 2:") || !strings.HasPrefix(got[2], " 4:") {
		t.Fatalf("rows %v", got)
	}
}
