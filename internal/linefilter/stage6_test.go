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

// ---- ANSI colour codes (ansi.go) --------------------------------------------------

const (
	red   = "\x1b[31m"
	bred  = "\x1b[1;31m"
	reset = "\x1b[0m"
)

// The lines the verification found uncoloured (claude2 report2 S4) and their
// friends: judged without the codes, in the literal and in the DFA path.
func TestANSILinesJudgedWithoutCodes(t *testing.T) {
	lines := []string{
		red + "2026-10-20 09:32:56" + reset + " [" + bred + "WARN" + reset + "] slow", // 1: WARN behind ESC[1;31m
		"plain WARN line",                                 // 2
		"x" + bred + "ERROR" + reset + "y",                // 3: ERROR glued to x/y once the codes are out → no word
		red + "ERROR" + reset + ": boom",                  // 4
		"mWARN no",                                        // 5: no codes — "mWARN" is not the word WARN
		"half WARN \x1b[31",                               // 6: an incomplete sequence at the end stays (no final byte)
		"\x1b[38;5;196mkafka" + reset + " rebalance done", // 7: text rule across a code
		"nothing here",                                    // 8
		"seq \x1b[31 WARN",                                // 9: ESC [ 3 1 space W is one whole sequence (final byte W): "ARN" is left
	}
	doc := strings.Join(lines, "\n")
	cases := []struct {
		name  string
		rules []Rule
		hits  []int64
		cols  map[int64]int32
	}{
		{"word WARN (literal)", []Rule{{Kind: "word", Pattern: "WARN", CaseSensitive: true}}, []int64{1, 2, 6}, map[int64]int32{1: int32(strings.Index(lines[0], "WARN")), 6: int32(strings.Index(lines[5], "WARN"))}},
		{"regex \\bWARN\\b", []Rule{{Kind: "regex", Pattern: `\bWARN\b`, CaseSensitive: true}}, []int64{1, 2, 6}, nil},
		{"word ERROR", []Rule{{Kind: "word", Pattern: "ERROR", CaseSensitive: true}}, []int64{4}, map[int64]int32{4: int32(len(red))}},
		{"regex ^2026", []Rule{{Kind: "regex", Pattern: `^2026`, CaseSensitive: true}}, []int64{1}, map[int64]int32{1: int32(len(red))}},
		{"text mWARN (codes are not text)", []Rule{{Kind: "text", Pattern: "mWARN", CaseSensitive: true}}, []int64{5}, nil},
		{"text kafka rebalance across a code", []Rule{{Kind: "text", Pattern: "kafka rebalance"}}, []int64{7}, map[int64]int32{7: int32(len("\x1b[38;5;196m"))}},
		{"text [31 of an incomplete code", []Rule{{Kind: "text", Pattern: "[31", CaseSensitive: true}}, []int64{6}, nil},
	}
	for _, lp := range []int{0, 1000} { // 0 = DFA path, 1000 = literal path
		restore := setKnobs(knobs{litPass: lp, group: 64, minMem: dfaMinMem, giant: GiantMax, decSizes: decodeChunkSizes, dec1: decodeChunk1})
		for _, buf := range []int{8, 64, 1 << 16} {
			e := newTestEngine(t, Options{BufSize: buf, Chunk: 7})
			for _, c := range cases {
				// a few more rules so the DFA path really runs a set
				rules := append([]Rule{}, c.rules...)
				rows, _, _ := run(t, e, []byte(doc), "utf-8", rules, 0, 0)
				if got := lineNos(rows); !reflect.DeepEqual(got, c.hits) {
					t.Errorf("litPass=%d buf=%d %s: hits %v want %v", lp, buf, c.name, got, c.hits)
				}
				for _, r := range rows {
					if want, ok := c.cols[r.Line]; ok && r.Hit && r.Col != want {
						t.Errorf("litPass=%d buf=%d %s: line %d col %d want %d", lp, buf, c.name, r.Line, r.Col, want)
					}
					if r.Hit && r.Text != lines[r.Line-1] {
						t.Errorf("%s: row text changed (codes must stay in the shown text): %q", c.name, r.Text)
					}
				}
			}
		}
		restore()
	}
}

// Documents with ANSI codes everywhere, against the reference (which strips
// them independently, ref_test.go refStripANSI), in every engine path that
// sees a whole line (literal / DFA, small buffers → giantLine, encodings, gz).
func TestANSIRandomAgainstReference(t *testing.T) {
	seed := time.Now().UnixNano()
	if s := os.Getenv("LF_SEED"); s != "" {
		fmt.Sscan(s, &seed)
	}
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewSource(seed))
	codes := []string{red, bred, reset, "\x1b[38;5;196m", "\x1b[K", "\x1b[2J", "\x1b[31", "\x1b", "\x1b[", "\x1b[?25l"}
	iters := 300
	if testing.Short() {
		iters = 80
	}
	for it := 0; it < iters; it++ {
		base := randDoc(rng, rng.Intn(4) == 0)
		// sprinkle codes between and inside words
		var b strings.Builder
		for _, c := range string(base) {
			if rng.Intn(7) == 0 {
				b.WriteString(codes[rng.Intn(len(codes))])
			}
			b.WriteRune(c)
		}
		doc := []byte(b.String())
		data, enc := encodeDoc(rng, doc)
		var rules []Rule
		for _, r := range randRules {
			if rng.Intn(3) == 0 {
				rules = append(rules, r)
			}
		}
		k := knobs{
			litPass:  []int{0, 4, 1000}[rng.Intn(3)],
			group:    []int{1, 2, 8}[rng.Intn(3)],
			minMem:   []int{64 << 10, 600}[rng.Intn(2)],
			giant:    1 << 30, // pieces of a giant line (streamLine) keep their codes: not compared here
			decSizes: [][]int64{{64 << 10, 256 << 10, 1 << 20}, {1, 3, 7}, {}}[rng.Intn(3)],
			dec1:     []int64{1 << 20, 5}[rng.Intn(2)],
		}
		var exclude []Rule // 「🚫 제외」 judges the line without its codes too
		if rng.Intn(2) == 0 {
			for _, r := range randExcludes {
				if rng.Intn(4) == 0 {
					exclude = append(exclude, r)
				}
			}
		}
		restore := setKnobs(k)
		chunk := []int64{3, 17, 1 << 20}[rng.Intn(3)]
		bufSize := []int{8, 33, 1 << 16}[rng.Intn(3)]
		above, below := rng.Intn(3), rng.Intn(3)
		gz := rng.Intn(5) == 0
		e := New(Options{Workers: 1 + rng.Intn(3), Chunk: chunk, BufSize: bufSize, MaxLineDisplay: 1 << 20, DFAMemory: 1, TempDir: t.TempDir(), WatchEvery: -1})
		fileData := data
		if gz {
			fileData = gzipBytes(data)
		}
		p := writeTemp(t, fileData)
		res, err := e.Start(Request{Path: p, Encoding: enc, Rules: rules, Exclude: exclude})
		if err != nil {
			restore()
			t.Fatal(err)
		}
		prog, _ := e.Wait(res.JobID)
		func() {
			defer restore()
			defer func() {
				if t.Failed() {
					t.Logf("iter %d chunk=%d buf=%d knobs=%+v enc=%q gz=%v rules=%+v exclude=%+v\ndoc=%q", it, chunk, bufSize, k, enc, gz, rules, exclude, doc)
				}
			}()
			if prog.Error != "" {
				t.Fatalf("iter %d: %s", it, prog.Error)
			}
			text := refDecode(data, prog.Encoding)
			got, _ := collect(t, e, res.JobID, above, below, rng)
			want, _ := refFilter(text, rules, refOpts{above: above, below: below, maxRows: 1 << 20, maxDisplay: 1 << 20, exclude: exclude})
			diffRows(t, got, want, nil)
			if wh, wx, _, _ := refCounts(text, rules, refOpts{maxRows: 1 << 20, exclude: exclude}); prog.Hits != wh || prog.Excluded != wx {
				t.Fatalf("hits %d excluded %d, want %d %d", prog.Hits, prog.Excluded, wh, wx)
			}
		}()
		e.CloseAll(time.Second)
		if t.Failed() {
			return
		}
	}
}

// ---- Find (find.go) ------------------------------------------------------------------

func findRows(t *testing.T, e *Engine, id string, A, B int, q Rule) FindResult {
	t.Helper()
	r, err := e.Find(id, A, B, q)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// The rows Find lists = the rows of the view (as Rows gives them) whose text
// matches, gap rows excluded — over the whole result, not one page.
func TestFindOverWholeResult(t *testing.T) {
	var lines []string
	for i := 1; i <= 3000; i++ {
		switch {
		case i%10 == 0:
			lines = append(lines, fmt.Sprintf("2026-10-20 ERROR dev-%d failed", i))
		case i%10 == 1:
			lines = append(lines, fmt.Sprintf("next line of %d: Dev-%d retry", i-1, i-1))
		default:
			lines = append(lines, fmt.Sprintf("info %d", i))
		}
	}
	doc := strings.Join(lines, "\n")
	e := newTestEngine(t, Options{BufSize: 4096, Chunk: 9000})
	p := writeTemp(t, []byte(doc))
	res, err := e.Start(Request{Path: p, Rules: errRule})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait(res.JobID)
	for _, ctx := range [][2]int{{0, 0}, {0, 1}, {2, 3}} {
		all, _ := collect(t, e, res.JobID, ctx[0], ctx[1], rand.New(rand.NewSource(3)))
		check := func(name string, q Rule, pred func(string) bool) {
			t.Helper()
			var want []int
			for i, r := range all {
				if r.Line > 0 && pred(r.Text) {
					want = append(want, i)
				}
			}
			got := findRows(t, e, res.JobID, ctx[0], ctx[1], q)
			if want == nil {
				want = []int{}
			}
			if !reflect.DeepEqual(got.Rows, want) || got.Total != len(want) || got.Issue != "" || got.Partial || got.Canceled {
				t.Errorf("ctx %v %s: got %d rows (total %d, issue %q) want %d — first got %v want %v", ctx, name, len(got.Rows), got.Total, got.Issue, len(want), head(got.Rows), head(want))
			}
			if got.Searched != len(all) {
				t.Errorf("ctx %v %s: searched %d rows of %d", ctx, name, got.Searched, len(all))
			}
		}
		check("text ci", Rule{Kind: "text", Pattern: "dev-2"}, func(s string) bool { return strings.Contains(strings.ToLower(s), "dev-2") })
		check("text cs", Rule{Kind: "text", Pattern: "Dev-", CaseSensitive: true}, func(s string) bool { return strings.Contains(s, "Dev-") })
		check("word", Rule{Kind: "word", Pattern: "retry"}, func(s string) bool { return strings.HasSuffix(s, " retry") })
		check("regex", Rule{Kind: "regex", Pattern: `dev-\d*00\b`}, func(s string) bool {
			f := strings.Fields(strings.ToLower(s))
			for _, w := range f {
				w = strings.TrimSuffix(w, ":")
				if strings.HasPrefix(w, "dev-") && strings.HasSuffix(w, "00") {
					return true
				}
			}
			return false
		})
		check("no match", Rule{Kind: "text", Pattern: "zzz"}, func(string) bool { return false })
		check("gap rows are not searched", Rule{Kind: "text", Pattern: "생략"}, func(string) bool { return false })
	}
	if r := findRows(t, e, res.JobID, 0, 0, Rule{Kind: "regex", Pattern: `(?<=x)y`}); r.Issue == "" || len(r.Rows) != 0 {
		t.Errorf("look-behind query: want an issue, got %+v", r)
	}
	if r := findRows(t, e, res.JobID, 0, 0, Rule{Kind: "regex", Pattern: `a*`}); !strings.Contains(r.Issue, "빈 글자") {
		t.Errorf("empty-matching query: want 「빈 글자」 issue, got %+v", r)
	}
	if r := findRows(t, e, res.JobID, 0, 0, Rule{Kind: "text", Pattern: ""}); r.Total != 0 || r.Issue != "" {
		t.Errorf("empty query: %+v", r)
	}
	// An empty query is how 찾기 (closed or cleared) stops a running Find: it must
	// take over the view's find seq so the older Find sees itself stale.
	if v, err := e.view(res.JobID); err != nil {
		t.Errorf("view: %v", err)
	} else {
		before := v.findSeq.Load()
		findRows(t, e, res.JobID, 0, 0, Rule{Kind: "text", Pattern: ""})
		if v.findSeq.Load() == before {
			t.Errorf("empty query did not stop the running Find (seq still %d)", before)
		}
	}
	e.Close(res.JobID)
	if _, err := e.Find(res.JobID, 0, 0, Rule{Kind: "text", Pattern: "x"}); err == nil {
		t.Errorf("Find on a closed view: no error")
	}
}

func head(a []int) []int {
	if len(a) > 5 {
		return a[:5]
	}
	return a
}

// Rows after the 64MB-style byte cap are never shown, so Find does not list
// them; MaxFind caps the list but not the count.
func TestFindCaps(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 400; i++ {
		fmt.Fprintf(&b, "ERROR %03d needle\n", i)
	}
	e := newTestEngine(t, Options{MaxBytes: 1000})
	p := writeTemp(t, []byte(b.String()))
	res, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(res.JobID)
	shown, last := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(1)))
	if last.Truncated != "bytes" {
		t.Fatalf("want a byte-capped view, got %q", last.Truncated)
	}
	r := findRows(t, e, res.JobID, 0, 0, Rule{Kind: "text", Pattern: "needle"})
	if r.Total != len(shown) || len(r.Rows) != len(shown) || r.Rows[len(r.Rows)-1] != len(shown)-1 {
		t.Errorf("byte cap: found %d rows (last %v), the view shows %d", r.Total, r.Rows[len(r.Rows)-1:], len(shown))
	}
}

// A newer Find on the same view stops the older one.
func TestFindNewerStopsOlder(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 200_000; i++ {
		fmt.Fprintf(&b, "ERROR %d some text to search through\n", i)
	}
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte(b.String()))
	res, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(res.JobID)
	done := make(chan FindResult, 1)
	go func() {
		r, _ := e.Find(res.JobID, 0, 0, Rule{Kind: "regex", Pattern: `zz\d+q`})
		done <- r
	}()
	time.Sleep(time.Millisecond)
	r2 := findRows(t, e, res.JobID, 0, 0, Rule{Kind: "text", Pattern: "ERROR 1999"})
	r1 := <-done
	if r2.Canceled || r2.Total != 111 { // ERROR 1999, 19990…19999, 199900…199999
		t.Errorf("newer find: %+v", r2)
	}
	if !r1.Canceled && r1.Searched != 200_001 {
		t.Errorf("older find neither canceled nor complete: %+v", r1)
	}
	t.Logf("older canceled=%v searched=%d", r1.Canceled, r1.Searched)
}
