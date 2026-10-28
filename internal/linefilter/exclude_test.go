package linefilter

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 「🚫 제외」 (Request.Exclude): a matched line that an exclude rule also matches
// is not a hit — no row of its own, no context around it, not counted in Hits
// or RuleHits (Progress.Excluded counts it). Lines shown as context of other
// hits stay. The random comparisons (ref_test.go, stage6_test.go) cover the
// paths; these pin the meaning down with readable cases.

func runEx(t *testing.T, e *Engine, p string, rules, exclude []Rule, A, B int) ([]Row, Progress, StartResult) {
	t.Helper()
	res, err := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules, Exclude: exclude})
	if err != nil {
		t.Fatal(err)
	}
	prog, err := e.Wait(res.JobID)
	if err != nil {
		t.Fatal(err)
	}
	var rows []Row
	for {
		pg, err := e.Rows(res.JobID, A, B, len(rows), 5000)
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, pg.Rows...)
		if pg.End {
			break
		}
	}
	return rows, prog, res
}

// "line:text" or "gap N" per row
func rowStrings(rows []Row) []string {
	var out []string
	for _, r := range rows {
		if r.Line == 0 {
			out = append(out, fmt.Sprintf("gap %d", r.Skip))
			continue
		}
		h := " "
		if r.Hit {
			h = "*"
		}
		out = append(out, fmt.Sprintf("%s%d:%s", h, r.Line, r.Text))
	}
	return out
}

var exDoc = strings.Join([]string{
	"1 start",
	"2 abc commonConnection ok", // hit by abc, excluded
	"3 after 2",
	"4 plain",
	"5 def payload", // hit
	"6 abc CommonConnection", // excluded only when case is ignored
	"7 plain",
	"8 plain",
	"9 def commonConnection", // excluded, but line 9 is within 3 below of... nothing
	"10 plain",
	"11 abc",                       // hit
	"12 abc commonConnection near", // excluded; shown as context of 11 (below 1)
	"13 tail",
}, "\n")

func TestExcludeMeaning(t *testing.T) {
	e := newTestEngine(t, Options{Chunk: 16, BufSize: 64})
	p := writeTemp(t, []byte(exDoc))
	rules := []Rule{{Kind: "text", Pattern: "abc"}, {Kind: "text", Pattern: "def"}}
	ex := []Rule{{Kind: "text", Pattern: "commonConnection", CaseSensitive: true}}

	rows, prog, _ := runEx(t, e, p, rules, ex, 0, 1)
	// line 6 matches abc and (case-sensitive) not the exclude: a hit
	want := []string{"gap 4", "*5:5 def payload", "*6:6 abc CommonConnection", " 7:7 plain", "gap 3", "*11:11 abc", " 12:12 abc commonConnection near", "gap 1"}
	if got := rowStrings(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("case-sensitive exclude, below 1:\n got %q\nwant %q", got, want)
	}
	if prog.Hits != 3 || prog.Excluded != 3 || !reflect.DeepEqual(prog.RuleHits, []int64{2, 1}) {
		t.Fatalf("counts hits %d excluded %d ruleHits %v", prog.Hits, prog.Excluded, prog.RuleHits)
	}
	// the excluded line 2 brings no context: line 3 (its below 1) is not shown,
	// line 1 neither with above 1
	rows, _, _ = runEx(t, e, p, rules, ex, 1, 0)
	want = []string{"gap 3", " 4:4 plain", "*5:5 def payload", "*6:6 abc CommonConnection", "gap 3", " 10:10 plain", "*11:11 abc", "gap 2"}
	if got := rowStrings(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("above 1:\n got %q\nwant %q", got, want)
	}
	// ignoring case: line 6 is excluded too
	exCI := []Rule{{Kind: "text", Pattern: "commonconnection"}}
	rows, prog, _ = runEx(t, e, p, rules, exCI, 0, 0)
	want = []string{"gap 4", "*5:5 def payload", "gap 5", "*11:11 abc", "gap 2"}
	if got := rowStrings(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("case-insensitive:\n got %q\nwant %q", got, want)
	}
	if prog.Hits != 2 || prog.Excluded != 4 {
		t.Fatalf("hits %d excluded %d", prog.Hits, prog.Excluded)
	}
	// a switched-off exclude rule, an empty one: nothing excluded
	rows, prog, _ = runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "commonConnection", On: on(false)}, {Kind: "text", Pattern: ""}}, 0, 0)
	if prog.Excluded != 0 || prog.Hits != 6 {
		t.Fatalf("off/empty exclude: hits %d excluded %d", prog.Hits, prog.Excluded)
	}
	// several exclude rules: any one is enough
	_, prog, _ = runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "payload"}, {Kind: "word", Pattern: "near"}, {Kind: "regex", Pattern: `^6 `}}, 0, 0)
	if prog.Hits != 3 || prog.Excluded != 3 {
		t.Fatalf("three excludes: hits %d excluded %d", prog.Hits, prog.Excluded)
	}
	// Excluding a line no rule matches changes nothing
	_, prog, _ = runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "plain"}}, 0, 0)
	if prog.Hits != 6 || prog.Excluded != 0 {
		t.Fatalf("exclude on non-hits: hits %d excluded %d", prog.Hits, prog.Excluded)
	}
}

func TestExcludeIssuesAndCache(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte(exDoc))
	rules := []Rule{{Kind: "text", Pattern: "abc"}}
	ex := []Rule{{Kind: "regex", Pattern: `(?<=x)y`}, {Kind: "text", Pattern: "commonConnection"}}
	_, prog, res := runEx(t, e, p, rules, ex, 0, 0)
	if len(res.ExcludeIssues) != 1 || res.ExcludeIssues[0].Index != 0 || !strings.HasPrefix(res.ExcludeIssues[0].Reason, issuePrefixRegex) {
		t.Fatalf("exclude issues %+v", res.ExcludeIssues)
	}
	if len(res.Issues) != 0 {
		t.Fatalf("rule issues %+v", res.Issues)
	}
	if prog.Hits != 1 || prog.Excluded != 3 {
		t.Fatalf("the usable exclude still works: hits %d excluded %d", prog.Hits, prog.Excluded)
	}
	// cache: no exclude = the scan without excludes; with them = another scan;
	// back without = the first one again (toggling a chip off is instant)
	r0, _ := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules})
	e.Wait(r0.JobID)
	r1, _ := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules, Exclude: ex[1:]})
	e.Wait(r1.JobID)
	r2, _ := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules, Exclude: []Rule{}})
	r3, _ := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules, Exclude: ex[1:]})
	if r1.Cached || !r2.Cached || !r3.Cached {
		t.Fatalf("cached: with exclude %v, without again %v, with again %v", r1.Cached, r2.Cached, r3.Cached)
	}
	if r2.Progress.Excluded != 0 || r3.Progress.Excluded != 3 {
		t.Fatalf("cached progress excluded %d / %d", r2.Progress.Excluded, r3.Progress.Excluded)
	}
	if k0, k1 := cacheKey(p, fileState{1, 2}, "", rules, nil), cacheKey(p, fileState{1, 2}, "", rules, []Rule{}); k0 != k1 || strings.Contains(k0, "\x00x") {
		t.Fatalf("no exclude must keep the old key: %q %q", k0, k1)
	}
}

// Excluded lines do not count towards the hit cap: the scan goes on.
func TestExcludeAndHitCap(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 100; i++ {
		if i%25 == 0 {
			fmt.Fprintf(&b, "ERROR keep %d\n", i)
		} else {
			fmt.Fprintf(&b, "ERROR commonConnection %d\n", i)
		}
	}
	p := writeTemp(t, []byte(b.String()))
	rules := []Rule{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}}
	for _, chunk := range []int64{16, 64, 1 << 20} {
		e := newTestEngine(t, Options{MaxRows: 5, Chunk: chunk, BufSize: 64})
		_, prog, _ := runEx(t, e, p, rules, nil, 0, 0)
		if !prog.Truncated || prog.Hits != 6 {
			t.Fatalf("chunk %d without exclude: truncated %v hits %d", chunk, prog.Truncated, prog.Hits)
		}
		rows, prog, _ := runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "commonConnection"}}, 0, 0)
		if prog.Truncated || prog.Hits != 4 || prog.Excluded != 96 {
			t.Fatalf("chunk %d with exclude: truncated %v hits %d excluded %d", chunk, prog.Truncated, prog.Hits, prog.Excluded)
		}
		if got := lineNos(rows); !reflect.DeepEqual(got, []int64{25, 50, 75, 100}) {
			t.Fatalf("chunk %d rows: %v", chunk, got)
		}
		// the cap reached among the kept hits: only the excluded lines before
		// the 6th kept hit count. Excluded: 1-49 but 25; kept 25, 50, 51, …:
		// the 6th is line 54.
		_, prog, _ = runEx(t, e, p, rules, []Rule{{Kind: "regex", Pattern: `commonConnection [1-4]?\d$`}}, 0, 0)
		if !prog.Truncated || prog.Hits != 6 || prog.Excluded != 48 {
			t.Fatalf("chunk %d cap with early kept hits: truncated %v hits %d excluded %d", chunk, prog.Truncated, prog.Hits, prog.Excluded)
		}
	}
}

// Appended lines go through the excludes; a last line that grows into an
// excluded one stops being a hit, and the counts follow.
func TestExcludeAppend(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("1 ERROR a\n2 ERROR commonConnection\n3 ERROR grows"))
	rules := []Rule{{Kind: "word", Pattern: "ERROR", CaseSensitive: true}}
	ex := []Rule{{Kind: "text", Pattern: "commonConnection"}}
	_, prog, res := runEx(t, e, p, rules, ex, 0, 0)
	if prog.Hits != 2 || prog.Excluded != 1 {
		t.Fatalf("before: hits %d excluded %d", prog.Hits, prog.Excluded)
	}
	time.Sleep(5 * time.Millisecond)
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(" commonConnection\n4 ERROR new\n5 ERROR commonconnection\n")
	f.Close()
	v, _ := e.view(res.JobID)
	v.j.checkFile(true)
	prog, _ = e.Wait(res.JobID)
	if prog.Version != 1 {
		t.Fatalf("not taken as an append: %+v", prog)
	}
	if prog.Hits != 2 || prog.Excluded != 3 || !reflect.DeepEqual(prog.RuleHits, []int64{2}) {
		t.Fatalf("after: hits %d excluded %d ruleHits %v", prog.Hits, prog.Excluded, prog.RuleHits)
	}
	var rows []Row
	pg, _ := e.Rows(res.JobID, 0, 0, 0, 100)
	rows = pg.Rows
	if got := lineNos(rows); !reflect.DeepEqual(got, []int64{1, 4}) {
		t.Fatalf("hits after the append %v", got)
	}
}

// Find looks at the rows of the view: an excluded line is there only as
// context of another hit.
func TestExcludeFind(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte(exDoc))
	rules := []Rule{{Kind: "text", Pattern: "abc"}, {Kind: "text", Pattern: "def"}}
	res, _ := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules, Exclude: []Rule{{Kind: "text", Pattern: "commonConnection", CaseSensitive: true}}})
	e.Wait(res.JobID)
	fr := findRows(t, e, res.JobID, 0, 1, Rule{Kind: "text", Pattern: "commonConnection", CaseSensitive: true})
	// rows: gap 4, 5, 6, 7, gap 3, 11, 12(context), gap 1 → only row 6 (line 12)
	if fr.Total != 1 || !reflect.DeepEqual(fr.Rows, []int{6}) {
		t.Fatalf("find %+v", fr)
	}
}

// Lines with ANSI colour codes: the excludes see the line without them, like
// the rules (and the editor).
func TestExcludeANSI(t *testing.T) {
	doc := strings.Join([]string{
		red + "ERROR" + reset + " kafka " + bred + "rebalance" + reset + " done",
		red + "ERROR" + reset + " other",
		"ERROR plain kafka rebalance",
	}, "\n")
	for _, lp := range []int{0, 1000} {
		restore := setKnobs(knobs{litPass: lp, group: 64, minMem: dfaMinMem, giant: GiantMax, decSizes: decodeChunkSizes, dec1: decodeChunk1})
		e := newTestEngine(t, Options{})
		p := writeTemp(t, []byte(doc))
		rules := []Rule{{Kind: "word", Pattern: "ERROR", CaseSensitive: true}}
		_, prog, _ := runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "kafka rebalance"}}, 0, 0)
		if prog.Hits != 1 || prog.Excluded != 2 {
			t.Errorf("litPass %d: across codes: hits %d excluded %d", lp, prog.Hits, prog.Excluded)
		}
		// a pattern holding a code never matches (codes are not text)
		_, prog, _ = runEx(t, e, p, rules, []Rule{{Kind: "text", Pattern: "\x1b[0m other"}}, 0, 0)
		if prog.Hits != 3 || prog.Excluded != 0 {
			t.Errorf("litPass %d: code in the pattern: hits %d excluded %d", lp, prog.Hits, prog.Excluded)
		}
		restore()
	}
}
