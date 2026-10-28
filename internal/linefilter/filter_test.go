package linefilter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	stdunicode "unicode"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
)

func newTestEngine(t testing.TB, o Options) *Engine {
	if o.TempDir == "" {
		o.TempDir = t.TempDir()
	}
	if o.WatchEvery == 0 {
		o.WatchEvery = -1
	}
	e := New(o)
	t.Cleanup(func() { e.CloseAll(2 * time.Second) })
	return e
}

// run filters data and returns every row plus the final page and progress.
func run(t testing.TB, e *Engine, data []byte, enc string, rules []Rule, above, below int) ([]Row, Page, Progress) {
	t.Helper()
	p := writeTemp(t, data)
	return runPath(t, e, p, enc, rules, above, below)
}

func runPath(t testing.TB, e *Engine, p string, enc string, rules []Rule, above, below int) ([]Row, Page, Progress) {
	t.Helper()
	res, err := e.Start(Request{Path: p, Encoding: enc, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	prog, err := e.Wait(res.JobID)
	if err != nil {
		t.Fatal(err)
	}
	rows, last := collect(t, e, res.JobID, above, below, rand.New(rand.NewSource(1)))
	return rows, last, prog
}

func lineNos(rows []Row) []int64 {
	var out []int64
	for _, r := range rows {
		if r.Hit {
			out = append(out, r.Line)
		}
	}
	return out
}

func hitMap(rows []Row) map[int64][]int {
	m := map[int64][]int{}
	for _, r := range rows {
		if r.Hit {
			m[r.Line] = r.Rules
		}
	}
	return m
}

var errRule = []Rule{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}}

func TestLineBreakKinds(t *testing.T) {
	e := newTestEngine(t, Options{Chunk: 3, BufSize: 64})
	cases := []struct {
		name  string
		doc   string
		hits  []int64
		lines int64
	}{
		{"LF", "a\nERROR\nb\nERROR\n", []int64{2, 4}, 5},
		{"CRLF", "a\r\nERROR\r\nb\r\nERROR\r\n", []int64{2, 4}, 5},
		{"CR only", "a\rERROR\rb\rERROR\r", []int64{2, 4}, 5},
		{"mixed", "a\r\nERROR\rb\nERROR\r\n\r\nERROR", []int64{2, 4, 6}, 6},
		{"CR then LF lines", "\r\r\nERROR\n\rERROR", []int64{3, 5}, 5},
		{"no final break", "x\nERROR", []int64{2}, 2},
		{"empty", "", nil, 1},
		{"only break", "\n", nil, 2},
		{"first line", "ERROR\nx", []int64{1}, 2},
	}
	for _, c := range cases {
		rows, _, prog := run(t, e, []byte(c.doc), "", errRule, 0, 0)
		if got := lineNos(rows); !reflect.DeepEqual(got, c.hits) {
			t.Errorf("%s: hits %v want %v", c.name, got, c.hits)
		}
		if prog.TotalLines != c.lines {
			t.Errorf("%s: TotalLines %d want %d", c.name, prog.TotalLines, c.lines)
		}
		for _, r := range rows {
			if strings.ContainsAny(r.Text, "\r\n") {
				t.Errorf("%s: row text has a line break: %q", c.name, r.Text)
			}
		}
	}
}

// Rows(id, above, below, ...): above = lines BEFORE a hit (grep -B), below =
// lines AFTER (grep -A). Gap rows say which lines they stand for.
func TestAboveBelowMeaning(t *testing.T) {
	doc := "l1\nl2\nl3\nERROR\nl5\nl6\nl7\nl8\nl9\nERROR\nl11\nl12"
	e := newTestEngine(t, Options{Chunk: 5, BufSize: 16})
	p := writeTemp(t, []byte(doc))
	res, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(res.JobID)
	page, err := e.Rows(res.JobID, 1, 2, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	type rr struct {
		Line, Skip, From int64
		Hit              bool
	}
	var got []rr
	for _, r := range page.Rows {
		got = append(got, rr{r.Line, r.Skip, r.From, r.Hit})
	}
	want := []rr{{0, 2, 1, false}, {3, 0, 0, false}, {4, 0, 0, true}, {5, 0, 0, false}, {6, 0, 0, false}, {0, 2, 7, false}, {9, 0, 0, false}, {10, 0, 0, true}, {11, 0, 0, false}, {12, 0, 0, false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
	if !page.End || page.Total != len(want) {
		t.Fatalf("End=%v Total=%d", page.End, page.Total)
	}
	page, _ = e.Rows(res.JobID, 3, 3, 0, 100)
	for _, r := range page.Rows {
		if r.Skip > 0 {
			t.Fatalf("merge: gap %+v", r)
		}
	}
	if len(page.Rows) != 12 {
		t.Fatalf("merge: %d rows", len(page.Rows))
	}
	// Adjacent blocks merge too: 2-7 and 8-12.
	page, _ = e.Rows(res.JobID, 2, 3, 0, 100)
	if page.Rows[0].Skip != 1 || page.Rows[0].From != 1 || len(page.Rows) != 12 {
		t.Fatalf("adjacent merge: %+v", page.Rows)
	}
	// Trailing gap: lines after the last block.
	page, _ = e.Rows(res.JobID, 0, 0, 0, 100)
	last := page.Rows[len(page.Rows)-1]
	if last.Line != 0 || last.From != 11 || last.Skip != 2 {
		t.Fatalf("trailing gap %+v", last)
	}
}

func TestFirstLastLineContext(t *testing.T) {
	doc := "ERROR first\na\nb\nc\nd\nERROR last"
	e := newTestEngine(t, Options{Chunk: 4, BufSize: 16})
	rows, _, _ := run(t, e, []byte(doc), "", errRule, 3, 3)
	if len(rows) != 6 || rows[0].Line != 1 || rows[5].Line != 6 {
		t.Fatalf("%+v", rows)
	}
	rows, _, _ = run(t, e, []byte("ERROR\n"), "", errRule, 0, 5)
	if len(rows) != 2 || rows[1].Line != 2 || rows[1].Text != "" {
		t.Fatalf("%+v", rows)
	}
}

func TestChunkBoundaries(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 50; i++ {
		b.WriteString("kafka rebalance start\r\n")
		b.WriteString("x\r")
		b.WriteString("nothing here\n")
	}
	data := []byte(b.String())
	rules := []Rule{{Kind: "text", Pattern: "kafka rebalance"}, {Regex: true, Pattern: `^x$`, CaseSensitive: true}}
	want, _ := refFilter(string(data), rules, refOpts{above: 1, maxRows: 1 << 20, maxDisplay: 1 << 20})
	for chunk := int64(1); chunk <= 60; chunk++ {
		for _, bs := range []int{30, 31, 64} {
			e := newTestEngine(t, Options{Chunk: chunk, BufSize: bs, Workers: 3})
			got, _, _ := run(t, e, data, "", rules, 1, 0)
			diffRows(t, got, want, nil)
		}
	}
}

func TestKindsAndCase(t *testing.T) {
	doc := "Kafka Rebalance done\nrebalanced\nREBALANCE!\nmy_rebalance\nRe-balance\n가나다 오류\n\u212Aafka with Kelvin\nſtatus\n"
	e := newTestEngine(t, Options{Chunk: 8, BufSize: 64})
	cases := []struct {
		r    Rule
		hits []int64
	}{
		{Rule{Kind: "text", Pattern: "rebalance"}, []int64{1, 2, 3, 4}},
		{Rule{Kind: "text", Pattern: "rebalance", CaseSensitive: true}, []int64{2, 4}},
		{Rule{Kind: "word", Pattern: "rebalance"}, []int64{1, 3}},
		{Rule{Pattern: "REBALANCE", CaseSensitive: true}, []int64{3}}, // legacy word
		{Rule{Kind: "text", Pattern: "kafka rebalance"}, []int64{1}},
		{Rule{Kind: "regex", Pattern: `re-?balance\b`}, []int64{1, 3, 4, 5}},
		{Rule{Regex: true, Pattern: `^re`, CaseSensitive: true}, []int64{2}},
		{Rule{Kind: "text", Pattern: "오류"}, []int64{6}},
		{Rule{Kind: "word", Pattern: "가나다"}, []int64{6}},
		// JS folding: k ≠ U+212A, s ≠ ſ (Go's (?i) would match both)
		{Rule{Kind: "text", Pattern: "kafka"}, []int64{1}},
		{Rule{Kind: "regex", Pattern: `kafka`}, []int64{1}},
		{Rule{Kind: "regex", Pattern: `^status`}, nil},
		{Rule{Kind: "regex", Pattern: `[k]afka`}, []int64{1}},
	}
	for _, c := range cases {
		rows, _, _ := run(t, e, []byte(doc), "", []Rule{c.r}, 0, 0)
		if got := lineNos(rows); !reflect.DeepEqual(got, c.hits) {
			t.Errorf("%+v: %v want %v", c.r, got, c.hits)
		}
	}
}

func TestMultipleRulesIndexes(t *testing.T) {
	doc := "ERROR a\nWARN b\nERROR WARN\nnone\n"
	rules := []Rule{
		{Kind: "text", Pattern: "ERROR", CaseSensitive: true},
		{Kind: "text", Pattern: "x", On: on(false)},
		{Kind: "regex", Pattern: `(?<!x)WARN`}, // RE2 cannot → issue
		{Kind: "word", Pattern: "warn"},
	}
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte(doc))
	res, err := e.Start(Request{Path: p, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Issues) != 1 || res.Issues[0].Index != 2 || !strings.Contains(res.Issues[0].Reason, "뒤돌아보기") {
		t.Fatalf("issues %+v", res.Issues)
	}
	prog, _ := e.Wait(res.JobID)
	if !reflect.DeepEqual(prog.RuleHits, []int64{2, 0, 0, 2}) {
		t.Fatalf("ruleHits %v", prog.RuleHits)
	}
	page, _ := e.Rows(res.JobID, 0, 0, 0, 10)
	var got [][]int
	for _, r := range page.Rows {
		if r.Hit {
			got = append(got, r.Rules)
		}
	}
	if !reflect.DeepEqual(got, [][]int{{0}, {3}, {0, 3}}) {
		t.Fatalf("rules %v", got)
	}
}

func TestEncodings(t *testing.T) {
	doc := "첫 줄\r\n오류 발생 ERROR\n셋째\r넷째 오류\n"
	rules := []Rule{{Kind: "text", Pattern: "오류"}}
	wantHits := []int64{2, 4}
	cp949, err := korean.EUCKR.NewEncoder().Bytes([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	le, _ := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().Bytes([]byte(doc))
	be, _ := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewEncoder().Bytes([]byte(doc))
	leNoBOM, _ := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder().Bytes([]byte("abc ERROR 오류\nline2\n"))
	cases := []struct {
		name, enc, wantEnc string
		data               []byte
		hits               []int64
	}{
		{"utf-8", "", EncUTF8, []byte(doc), wantHits},
		{"utf-8 BOM", "", EncUTF8BOM, append([]byte{0xEF, 0xBB, 0xBF}, doc...), wantHits},
		{"cp949 detected", "", EncCP949, cp949, wantHits},
		{"cp949 given", "cp949", EncCP949, cp949, wantHits},
		{"utf-16le BOM", "", EncUTF16LE, le, wantHits},
		{"utf-16be BOM", "", EncUTF16BE, be, wantHits},
		{"utf-16le no BOM", "", EncUTF16LE, leNoBOM, []int64{1}},
		{"utf-16le given, BE BOM wins", "utf-16le", EncUTF16BE, be, wantHits},
	}
	for _, c := range cases {
		for _, gz := range []bool{false, true} {
			e := newTestEngine(t, Options{Chunk: 5, BufSize: 40})
			data := c.data
			if gz {
				data = gzipBytes(data)
			}
			rows, _, prog := run(t, e, data, c.enc, rules, 0, 0)
			if prog.Error != "" {
				t.Errorf("%s gz=%v: %s", c.name, gz, prog.Error)
				continue
			}
			if prog.Encoding != c.wantEnc {
				t.Errorf("%s gz=%v: encoding %s want %s", c.name, gz, prog.Encoding, c.wantEnc)
			}
			if gz != (prog.Compressed == "gzip") {
				t.Errorf("%s: compressed %q", c.name, prog.Compressed)
			}
			if got := lineNos(rows); !reflect.DeepEqual(got, c.hits) {
				t.Errorf("%s gz=%v: hits %v want %v", c.name, gz, got, c.hits)
			}
			for _, r := range rows {
				if r.Line == 2 && c.hits[0] == 2 && r.Text != "오류 발생 ERROR" {
					t.Errorf("%s: text %q", c.name, r.Text)
				}
				if r.Line == 1 && strings.HasPrefix(r.Text, "\ufeff") {
					t.Errorf("%s: BOM leaked into text", c.name)
				}
			}
		}
	}
}

// Detection is decided once from samples. A plain-ASCII head followed by
// CP949 text (later samples) is CP949.
func TestDetectLateCP949(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 3<<20 {
		b.WriteString("plain ascii start-up line\n")
	}
	ga, _ := korean.EUCKR.NewEncoder().Bytes([]byte("가 오류 한글 메시지\n"))
	for i := 0; i < 2000; i++ {
		b.Write(ga)
	}
	e := newTestEngine(t, Options{})
	rows, _, prog := run(t, e, b.Bytes(), "", []Rule{{Kind: "text", Pattern: "오류"}}, 0, 0)
	if prog.Encoding != EncCP949 || len(lineNos(rows)) != 2000 {
		t.Fatalf("enc %s hits %d", prog.Encoding, len(lineNos(rows)))
	}
}

func TestUnknownEncodingName(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("x"))
	for _, enc := range []string{"UTF-8", "euc-kr", "latin1"} {
		if _, err := e.Start(Request{Path: p, Encoding: enc, Rules: errRule}); err == nil || !strings.Contains(err.Error(), "알 수 없는 인코딩") {
			t.Errorf("%q: %v", enc, err)
		}
	}
}

func TestRowAndByteCaps(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("ERROR 0123456789\n")
	}
	data := []byte(b.String())
	e := newTestEngine(t, Options{MaxRows: 10, Chunk: 64})
	rows, last, prog := run(t, e, data, "", errRule, 0, 0)
	if len(rows) != 10 || last.Truncated != "rows" || !prog.Truncated || prog.Hits != 11 {
		t.Fatalf("rows %d trunc %q prog.Truncated %v hits %d", len(rows), last.Truncated, prog.Truncated, prog.Hits)
	}
	if prog.ScannedBytes >= int64(len(data)) {
		t.Fatalf("expected an early stop, scanned %d of %d", prog.ScannedBytes, len(data))
	}
	e2 := newTestEngine(t, Options{MaxRows: 100, Chunk: 64})
	_, last, _ = run(t, e2, data, "", errRule, 0, 0)
	if last.Truncated != "" {
		t.Fatalf("exactly MaxRows hits reported truncated %q", last.Truncated)
	}
	e3 := newTestEngine(t, Options{MaxBytes: 18 * 7, Chunk: 64})
	rows, last, _ = run(t, e3, data, "", errRule, 0, 0)
	if len(rows) != 7 || last.Truncated != "bytes" || !last.End {
		t.Fatalf("bytes cap: %d rows, %q", len(rows), last.Truncated)
	}
	p, _ := e3.Rows(last.JobID, 0, 0, 50, 10)
	if len(p.Rows) != 0 || p.Truncated != "bytes" {
		t.Fatalf("after cap: %+v", p)
	}
}

// One answer holds at most MaxPageBytes of text (not the end: ask again).
func TestPageByteCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("ERROR " + strings.Repeat("x", 94) + "\n")
	}
	e := newTestEngine(t, Options{MaxPageBytes: 1000})
	p := writeTemp(t, []byte(b.String()))
	res, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(res.JobID)
	pg, _ := e.Rows(res.JobID, 0, 0, 0, 100)
	if len(pg.Rows) == 0 || len(pg.Rows) >= 100 || pg.End {
		t.Fatalf("page of %d rows end=%v", len(pg.Rows), pg.End)
	}
	rows, _ := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(2)))
	if len(rows) != 101 { // 100 lines + trailing empty line gap
		t.Fatalf("all rows: %d", len(rows))
	}
}

// Lines longer than the buffer are judged whole: no miss after the buffer end,
// no false "$" at the cut. Text is cut for display only.
func TestLongLines(t *testing.T) {
	long := strings.Repeat("a", 300) + " ERROR " + strings.Repeat("가", 100)
	doc := "short\n" + long + "\nend"
	e := newTestEngine(t, Options{MaxLineDisplay: 101, BufSize: 1000, Chunk: 16})
	rows, _, _ := run(t, e, []byte(doc), "", errRule, 0, 0)
	if len(rows) != 3 || !rows[1].Hit || !rows[1].TruncatedLine || len(rows[1].Text) != 101 || rows[1].Col != 301 {
		t.Fatalf("%+v", rows)
	}
	e2 := newTestEngine(t, Options{MaxLineDisplay: 100})
	rows, _, _ = run(t, e2, []byte(strings.Repeat("가", 60)+"ERROR"), "", errRule, 0, 0)
	if len(rows) != 1 || len(rows[0].Text) != 99 || !rows[0].TruncatedLine || rows[0].Col != 60 {
		t.Fatalf("utf8 cut: %+v", rows[0])
	}
	for _, giant := range []int{1 << 30, 30} {
		restore := setKnobs(knobs{litPassLimit, groupSize, dfaMinMem, giant, decodeChunkSizes, decodeChunk1})
		e3 := newTestEngine(t, Options{BufSize: 64, Chunk: 16})
		doc3 := strings.Repeat("b", 100) + "ERROR\nERROR\n" + strings.Repeat("c", 10) + "ERROR" + strings.Repeat("d", 100) + "\nERROR"
		for _, rs := range [][]Rule{errRule, {{Regex: true, Pattern: `ERROR`, CaseSensitive: true}, {Regex: true, Pattern: `\d{9}`}}} {
			rows, _, _ = run(t, e3, []byte(doc3), "", rs, 0, 0)
			if got := lineNos(rows); !reflect.DeepEqual(got, []int64{1, 2, 3, 4}) {
				t.Fatalf("giant=%d giant lines: %v", giant, got)
			}
		}
		restore()
	}
}

func TestCancel(t *testing.T) {
	var b bytes.Buffer
	line := []byte("2026-10-21 00:00:00 INFO something happened with value 12345\n")
	for b.Len() < 40<<20 {
		b.Write(line)
	}
	p := writeTemp(t, b.Bytes())
	e := newTestEngine(t, Options{Workers: 1, Chunk: 1 << 20})
	rules := []Rule{{Regex: true, Pattern: `[A-Z]{3}\d{3}`, CaseSensitive: true}} // no literal, no match
	res, err := e.Start(Request{Path: p, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	e.Cancel(res.JobID)
	prog, _ := e.Wait(res.JobID)
	if !prog.Canceled || !prog.Done || prog.ScannedBytes >= int64(b.Len()) {
		t.Fatalf("cancel: %+v", prog)
	}
	res2, _ := e.Start(Request{Path: p, Rules: rules})
	if res2.Cached {
		t.Fatal("a canceled job must not be reused")
	}
	e.Cancel(res2.JobID)
}

func TestCacheAndInvalidation(t *testing.T) {
	p := writeTemp(t, []byte("a\nERROR\nb\n"))
	e := newTestEngine(t, Options{})
	r1, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(r1.JobID)
	r2, _ := e.Start(Request{Path: p, Rules: errRule})
	if !r2.Cached || r2.JobID == r1.JobID {
		t.Fatalf("same request should share the scan under its own id: %+v", r2)
	}
	r3, _ := e.Start(Request{Path: p, Rules: []Rule{{Kind: "text", Pattern: "ERROR"}}})
	if r3.Cached {
		t.Fatal("different rules must not reuse")
	}
	r4, _ := e.Start(Request{Path: p, Encoding: "cp949", Rules: errRule})
	if r4.Cached {
		t.Fatal("different encoding must not reuse")
	}
	// Rewrite the file (same size, other content): changed.
	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(p, []byte("ERROR\na\nERROR\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pg, err := e.Rows(r1.JobID, 0, 0, 0, 10)
	if err != nil || !pg.Changed || !pg.Progress.Changed {
		t.Fatalf("expected Changed, got %+v %v", pg, err)
	}
	r5, _ := e.Start(Request{Path: p, Rules: errRule})
	if r5.Cached {
		t.Fatal("changed file must rescan")
	}
	e.Wait(r5.JobID)
	pg, _ = e.Rows(r5.JobID, 0, 0, 0, 10)
	if got := lineNos(pg.Rows); !reflect.DeepEqual(got, []int64{1, 3}) {
		t.Fatalf("after change: %v", got)
	}
}

// Rows offered while the scan runs never change later.
func TestProgressiveRowsAreStable(t *testing.T) { progressive(t, false, "") }

// Every line hits: the single block grows until the end of the scan and must
// still be served while it grows.
func TestProgressiveGrowingBlock(t *testing.T) { progressive(t, true, "") }

// The same with a CP949 file decoded in parallel while it is scanned.
func TestProgressiveCP949(t *testing.T) { progressive(t, false, "cp949") }

func progressive(t *testing.T, everyLine bool, enc string) {
	var b bytes.Buffer
	rng := rand.New(rand.NewSource(7))
	for b.Len() < 24<<20 {
		if rng.Intn(500) == 0 {
			b.WriteString("x ERROR y 오류\n")
		} else {
			b.WriteString("2026-10-21 00:00:00 INFO plain log line with some words in it 정상\n")
		}
	}
	data := b.Bytes()
	if enc == "cp949" {
		data, _ = korean.EUCKR.NewEncoder().Bytes(data)
	}
	p := writeTemp(t, data)
	var evMu sync.Mutex
	var events []Progress
	e := newTestEngine(t, Options{Workers: 2, Chunk: 1 << 20, MaxRows: 1 << 30, OnProgress: func(p Progress) {
		evMu.Lock()
		events = append(events, p)
		evMu.Unlock()
	}})
	rules := []Rule{{Regex: true, Pattern: `\bERROR\b`, CaseSensitive: true}, {Regex: true, Pattern: `[A-Z]{3}\d`, CaseSensitive: true}}
	if everyLine {
		rules = []Rule{{Kind: "text", Pattern: "line"}}
	}
	res, _ := e.Start(Request{Path: p, Encoding: enc, Rules: rules})
	var early []Row
	sawPartial := false
	for {
		pg, err := e.Rows(res.JobID, 2, 2, len(early), 5000)
		if err != nil {
			t.Fatal(err)
		}
		early = append(early, pg.Rows...)
		if !pg.Progress.Done && len(early) > 0 {
			sawPartial = true
		}
		if pg.End {
			break
		}
		if len(pg.Rows) == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	e.Wait(res.JobID)
	final, _ := collect(t, e, res.JobID, 2, 2, rng)
	diffRows(t, early, final, nil)
	if !sawPartial {
		t.Error("scan finished before any partial page was served")
	}
	time.Sleep(50 * time.Millisecond)
	evMu.Lock()
	defer evMu.Unlock()
	if len(events) < 2 || !events[len(events)-1].Done {
		t.Fatalf("progress events: %d, last must be done", len(events))
	}
	for i := 1; i < len(events); i++ {
		if events[i].ScannedLines < events[i-1].ScannedLines || events[i-1].Done || events[i].JobID != res.JobID {
			t.Fatalf("events out of order at %d: %+v then %+v", i, events[i-1], events[i])
		}
	}
}

func TestNoUsableRules(t *testing.T) {
	e := newTestEngine(t, Options{})
	rows, last, prog := run(t, e, []byte("a\nb\nc"), "", []Rule{{Regex: true, Pattern: `\1`}}, 0, 0)
	if len(rows) != 1 || rows[0].Skip != 3 || rows[0].From != 1 || !last.End || prog.TotalLines != 3 {
		t.Fatalf("%+v %+v", rows, prog)
	}
}

// The match column is in editor units (UTF-16), from the first match of any
// rule on the line, counting broken bytes as one U+FFFD each.
func TestMatchColumn(t *testing.T) {
	doc := "😀 x ERROR\n가나 kafka ERR\n\xff\xfe zz ERROR\nab\tWARN déjà ERROR\n"
	rules := []Rule{
		{Kind: "text", Pattern: "ERROR", CaseSensitive: true},
		{Kind: "regex", Pattern: `\bWARN\b|kafka`},
		{Kind: "word", Pattern: "DÉJÀ"},
	}
	for _, lp := range []int{0, 1000} {
		restore := setKnobs(knobs{lp, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1})
		e := newTestEngine(t, Options{})
		rows, _, _ := run(t, e, []byte(doc), "", rules, 0, 0)
		restore()
		got := map[int64]int32{}
		for _, r := range rows {
			if r.Hit {
				got[r.Line] = r.Col
			}
		}
		want := map[int64]int32{1: 5, 2: 3, 3: 6, 4: 3}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("litPass=%d cols %v want %v", lp, got, want)
		}
		if rows[2].Text != "\uFFFD\uFFFD zz ERROR" {
			t.Fatalf("broken bytes text %q", rows[2].Text)
		}
	}
}

func TestTranslateJS(t *testing.T) {
	type tc struct {
		js      string
		ci      bool
		issue   string // substring of the reason; "" = must translate
		match   []string
		noMatch []string
	}
	cases := []tc{
		{js: `\s`, match: []string{"\u00a0", "\u3000", "\v", "\ufeff"}, noMatch: []string{"a"}},
		{js: `[\s]x`, match: []string{"\u00a0x"}},
		{js: `\S`, match: []string{"a"}, noMatch: []string{"\u00a0", " "}},
		{js: `[^\S]`, match: []string{"\u2003"}, noMatch: []string{"a"}},
		{js: `a.b`, match: []string{"axb"}, noMatch: []string{"a\u2028b"}},
		{js: `x[]`, issue: "어떤 글자에도"},
		{js: `x[^]y`, match: []string{"x\u2028y", "x-y"}},
		{js: `\u0041\x42`, match: []string{"AB"}},
		{js: `\uD83D\uDE00`, match: []string{"😀"}},
		{js: `\cJ`, issue: "줄바꿈"},
		{js: `\cI`, match: []string{"\t"}},
		{js: `\e\q`, match: []string{"eq"}},
		{js: `a{2}`, match: []string{"aa"}, noMatch: []string{"a"}},
		{js: `{abc}`, match: []string{"{abc}"}},
		{js: `x{,3}`, match: []string{"x{,3}"}},
		{js: `a]`, match: []string{"a]"}},
		{js: `[[]`, match: []string{"["}},
		{js: `[\d-z]`, match: []string{"-", "z", "5"}, noMatch: []string{"y"}},
		{js: `[\b]`, match: []string{"\b"}},
		{js: `(?<year>\d{4})-x`, match: []string{"2026-x"}},
		{js: `(?<$n>a)`, match: []string{"a"}},
		{js: `(?i:abc)D`, match: []string{"ABCD"}, noMatch: []string{"ABCd"}},
		{js: `(?-i:abc)D`, ci: true, match: []string{"abcd"}, noMatch: []string{"ABCD"}},
		{js: `\/path\/`, match: []string{"/path/"}},
		{js: `\-\ \가`, match: []string{"- 가"}},
		{js: `a??b+?`, match: []string{"ab"}},
		{js: `^ERROR$`, match: []string{"ERROR"}, noMatch: []string{"xERROR"}},
		{js: `kafka`, ci: true, match: []string{"KAFKA", "Kafka"}, noMatch: []string{"\u212Aafka"}},
		{js: `[a-z]+s`, ci: true, match: []string{"ABS"}, noMatch: []string{"ABſ"}},
		{js: `[^k]`, ci: true, noMatch: []string{"k", "K"}, match: []string{"\u212A"}},
		{js: `é`, ci: true, match: []string{"É"}},
		{js: `\w`, ci: true, noMatch: []string{"\u212A", "ſ"}},
		{js: `\W`, ci: true, match: []string{"\u212A"}},
		{js: `ß`, ci: true, noMatch: []string{"ẞ"}},
		{js: `(?s:a.b)`, match: []string{"a\u2028b"}},
		{js: `[z-a]`, issue: "순서"},
		{js: `(?<=x)y`, issue: "뒤돌아보기"},
		{js: `(?<!x)y`, issue: "뒤돌아보기"},
		{js: `x(?=y)`, issue: "앞보기"},
		{js: `x(?!y)`, issue: "앞보기"},
		{js: `(a)\1`, issue: "역참조"},
		{js: `(?<n>a)\k<n>`, issue: "이름 역참조"},
		{js: `a{1001}`, issue: "1000"},
		{js: `\u{41}`, issue: `\u{`},
		{js: `\012`, issue: "8진수"},
		{js: `(a`, issue: "괄호"},
		{js: `a)`, issue: "괄호"},
		{js: `[abc`, issue: "닫히지"},
		{js: `x\`, issue: `\`},
		{js: `a*`, issue: "빈 글자"},
		{js: `(?x)a`, issue: "그룹"},
		{js: `\b`, issue: "빈 일치"},
		{js: `^`, issue: "빈 글자"},
		{js: `\nfoo`, issue: "줄바꿈"},
		{js: `\r?\n\tat `, issue: "줄바꿈"},
		{js: `*a`, issue: "반복"},
	}
	for _, c := range cases {
		cr, reason := compileOne(Rule{Kind: "regex", Pattern: c.js, CaseSensitive: !c.ci})
		if c.issue != "" {
			if reason == "" || !strings.Contains(reason, c.issue) {
				t.Errorf("%s: want issue containing %q, got %q", c.js, c.issue, reason)
			}
			continue
		}
		if reason != "" {
			t.Errorf("%s: unexpected issue %q", c.js, reason)
			continue
		}
		for _, s := range c.match {
			if !cr.lineRe.MatchString(s) {
				t.Errorf("%s (→ %s): should match %q", c.js, cr.lineRe, s)
			}
		}
		for _, s := range c.noMatch {
			if cr.lineRe.MatchString(s) {
				t.Errorf("%s (→ %s): should not match %q", c.js, cr.lineRe, s)
			}
		}
	}
}

// The default editor rules all translate, and get literal prefilters where one
// exists.
func TestDefaultRulesCompile(t *testing.T) {
	defaults := defaultLogRules()
	rules, issues := compileRules(defaults)
	if len(issues) != 0 || len(rules) != 8 {
		t.Fatalf("issues %+v", issues)
	}
	if _, is := compileRules(defaultLogRulesV1()); len(is) != 0 {
		t.Fatalf("v1 defaults: issues %+v", is)
	}
	var pre []string
	for _, r := range rules {
		var ls []string
		for _, l := range r.lits {
			ls = append(ls, string(l.s))
		}
		pre = append(pre, strings.Join(ls, ","))
		if !r.unfiltered && len(r.lits) == 0 {
			t.Fatalf("rule %d has neither literals nor unfiltered", r.index)
		}
	}
	t.Logf("prefilters: %q", pre)
	if !rules[6].unfiltered {
		t.Fatalf("time rule should run on every line")
	}
	lines := []string{"x FAILED y", "NullPointerException", "Failure", "crit!", "EMERGENCY", "warning:", "[Note] ok", "notice", "trace", "Oct 20 17:03:00 x", "2026-10-20  0:49:54", "Entering FAULT STATE", "code=killed", "info", "information",
		"10-22 00:00:03 ERROR x", "2026.10.20 19:07:03.039812 [ 1 ] {} <Error> y", "[2026-10-22 00:07:36,193] DEBUG z", "2026-10-21 23:41:12,974 [myid:] - INFO", "<Fatal>", "<error>"}
	for i := range rules {
		m := newMatcher(rules[i : i+1])
		ws := newWState(m, 1<<20)
		for _, ln := range lines {
			hits, _, _ := ws.scanBuf([]byte(ln), 0, nil, 0, 100, nil)
			if (len(hits) > 0) != rules[i].lineRe.MatchString(ln) {
				t.Errorf("rule %d line %q: engine %v regex %v", rules[i].index, ln, len(hits) > 0, rules[i].lineRe.MatchString(ln))
			}
		}
	}
}

// defaultLogRules mirrors DEFAULT_LOG_RULES in frontend/src/logHighlight.ts
// (revision 2, stage 6: 오류 split into the level words and 실패·예외, the
// ClickHouse <Error> line tint, two more time formats).
func defaultLogRules() []Rule {
	return []Rule{
		{ID: "error", Regex: true, CaseSensitive: true, Pattern: `\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC)\b`},
		{ID: "error-ck", Regex: true, CaseSensitive: true, Pattern: `<(Fatal|Critical|Error)>|\[(emerg|alert|crit|error)\]`},
		{ID: "fail", Regex: true, Pattern: `\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`},
		{ID: "warn", Regex: true, Pattern: `\bWARN(ING)?\b`},
		{ID: "info", Regex: true, Pattern: `\b(INFO|NOTICE)\b|\[Note\]`},
		{ID: "debug", Regex: true, Pattern: `\b(DEBUG|TRACE|VERBOSE)\b`},
		{ID: "time", Regex: true, CaseSensitive: true, Pattern: `\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?|\b\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d(\.\d+)?|\b\d\d-\d\d \d\d:\d\d:\d\d([.,]\d+)?`},
		{ID: "mk119", Regex: true, CaseSensitive: true, Pattern: `Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`},
	}
}

// defaultLogRulesV1 mirrors DEFAULT_LOG_RULES_V1 (revision 1, v1.2.0 … stage 5);
// the stage-1 benchmarks were measured with these.
func defaultLogRulesV1() []Rule {
	return []Rule{
		{ID: "error", Regex: true, Pattern: `\b(FATAL|EMERG(ENCY)?|ALERT|CRIT(ICAL)?|ERROR|ERR|SEVERE|PANIC|FAIL(ED|URE)?)\b|\b\w*Exception\b`},
		{ID: "warn", Regex: true, Pattern: `\bWARN(ING)?\b`},
		{ID: "info", Regex: true, Pattern: `\b(INFO|NOTICE)\b|\[Note\]`},
		{ID: "debug", Regex: true, Pattern: `\b(DEBUG|TRACE|VERBOSE)\b`},
		{ID: "time", Regex: true, CaseSensitive: true, Pattern: `\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b|\b\d{4}-\d\d-\d\d[ T] ?\d{1,2}:\d\d:\d\d([.,]\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d(\.\d+)?`},
		{ID: "mk119", Regex: true, CaseSensitive: true, Pattern: `Entering (FAULT|BACKUP) STATE|NON_PRIM|WSREP: forgetting|Out of memory|Killed process|Main process exited|code=killed`},
	}
}

func TestDefaultRulesMatchTS(t *testing.T) {
	src, err := os.ReadFile("../../frontend/src/logHighlight.ts")
	if err != nil {
		t.Skip("frontend source not found")
	}
	re := regexp.MustCompile("pattern: String\\.raw`([^`]*)`")
	ms := re.FindAllStringSubmatch(string(src), -1)
	d := append(defaultLogRules(), defaultLogRulesV1()...) // DEFAULT_LOG_RULES, then DEFAULT_LOG_RULES_V1
	if len(ms) != len(d) {
		t.Fatalf("logHighlight.ts has %d patterns, test copy %d", len(ms), len(d))
	}
	for i, m := range ms {
		if m[1] != d[i].Pattern {
			t.Errorf("rule %d differs from logHighlight.ts:\n ts   %s\n test %s", i, m[1], d[i].Pattern)
		}
	}
}

func TestValidate(t *testing.T) {
	is := Validate([]Rule{
		{Kind: "regex", Pattern: `ok`},
		{Kind: "regex", Pattern: `(?<=a)b`, ID: "lb"},
		{Kind: "text", Pattern: "a\nb"},
		{Kind: "regex", Pattern: `(?<=a)b`, On: on(false)},
		{Kind: "regex", Pattern: ""},
		{Kind: "regex", Pattern: `(?:\b|^)`},
		{Kind: "regex", Pattern: `(`},
	})
	if len(is) != 4 || is[0].Index != 1 || is[0].ID != "lb" || is[1].Index != 2 || is[2].Index != 5 || is[3].Index != 6 {
		t.Fatalf("%+v", is)
	}
	for _, i := range is {
		// the plan's wording; a text rule is not a regex
		want := "줄만 보기에서는 쓸 수 없는 정규식: "
		if i.Index == 2 {
			want = "줄만 보기에서는 쓸 수 없는 규칙: "
		}
		if !strings.HasPrefix(i.Reason, want) {
			t.Fatalf("reason %q", i.Reason)
		}
		if strings.Contains(i.Reason, "error parsing") {
			t.Fatalf("English reason %q", i.Reason)
		}
	}
}

func TestLowerASCII(t *testing.T) {
	var src []byte
	for c := 0; c < 256; c++ {
		src = append(src, byte(c))
	}
	src = append(src, []byte("Hello WORLD 가나 ÀÉ @[`{")...)
	for off := 0; off < 9; off++ {
		s := src[off:]
		dst := make([]byte, len(s))
		lowerASCII(dst, s)
		if !bytes.Equal(dst, asciiLower(s)) {
			t.Fatalf("offset %d mismatch", off)
		}
	}
}

func TestFileShrinksDuringScan(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 40<<20 {
		b.WriteString("2026-10-21 00:00:00 INFO something ERROR happened 12345\n")
	}
	p := writeTemp(t, b.Bytes())
	e := newTestEngine(t, Options{Workers: 1, Chunk: 1 << 20})
	rules := []Rule{{Regex: true, Pattern: `[A-Z]{3}\d{3}`, CaseSensitive: true}}
	res, _ := e.Start(Request{Path: p, Rules: rules})
	time.Sleep(10 * time.Millisecond)
	if err := os.Truncate(p, 1<<20); err != nil {
		t.Skipf("cannot truncate an open file here: %v", err)
	}
	prog, _ := e.Wait(res.JobID)
	pg, err := e.Rows(res.JobID, 0, 0, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if prog.Error == "" && !pg.Changed {
		t.Fatalf("shrink not noticed: %+v %+v", prog, pg)
	}
	r2, _ := e.Start(Request{Path: p, Rules: rules})
	if r2.Cached {
		t.Fatal("must rescan after the change")
	}
}

func TestCanceledJobKeepsRows(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 40<<20 {
		b.WriteString("x ERROR plain line that keeps the scanner busy for a while\n")
	}
	p := writeTemp(t, b.Bytes())
	e := newTestEngine(t, Options{Workers: 1, Chunk: 1 << 20, MaxRows: 1 << 30})
	rules := []Rule{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}, {Regex: true, Pattern: `[A-Z]{3}\d`, CaseSensitive: true}}
	res, _ := e.Start(Request{Path: p, Rules: rules})
	for {
		st, _ := e.Status(res.JobID)
		if st.Hits > 0 || st.Done {
			break
		}
		time.Sleep(time.Millisecond)
	}
	e.Cancel(res.JobID)
	prog, _ := e.Wait(res.JobID)
	if !prog.Canceled {
		t.Skip("scan finished before the cancel")
	}
	rows, last := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(3)))
	if len(rows) == 0 || int64(len(rows)) != prog.Hits || !last.End || last.Truncated != "" {
		t.Fatalf("rows %d hits %d end %v", len(rows), prog.Hits, last.End)
	}
	for i, r := range rows {
		if r.Line != int64(i+1) || !r.Hit {
			t.Fatalf("row %d: %+v", i, r)
		}
	}
}

// Many lines hit: the kept hits are exactly the first MaxRows+1 in file order,
// the same on every run whatever the timing (ruleHits, invalid bytes too).
func TestCapIsDeterministic(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 8<<20 {
		b.WriteString("1234 \xff\n")
	}
	p := writeTemp(t, b.Bytes())
	var first Progress
	for trial := 0; trial < 8; trial++ {
		e := newTestEngine(t, Options{MaxRows: 1000, Chunk: 64 << 10, Workers: 2 + trial%6})
		res, _ := e.Start(Request{Path: p, Rules: []Rule{{Regex: true, Pattern: `\d`, CaseSensitive: true}, {Kind: "text", Pattern: "34"}}})
		prog, _ := e.Wait(res.JobID)
		if prog.Hits != 1001 || !prog.Truncated {
			t.Fatalf("hits %d truncated %v", prog.Hits, prog.Truncated)
		}
		prog.ElapsedMs, prog.FirstHitMs, prog.JobID = 0, 0, ""
		if trial == 0 {
			first = prog
			continue
		}
		if !reflect.DeepEqual(prog, first) {
			t.Fatalf("trial %d differs:\n%+v\n%+v", trial, prog, first)
		}
	}
}

// Two views of the same file and rules share one scan but have their own
// ids: closing or canceling one leaves the other working.
func TestViewsShareScan(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 16<<20 {
		b.WriteString("plain line with a few words ERROR 12345\n")
	}
	p := writeTemp(t, b.Bytes())
	e := newTestEngine(t, Options{Workers: 2, MaxRows: 1 << 30})
	r1, _ := e.Start(Request{Path: p, Rules: errRule})
	r2, _ := e.Start(Request{Path: p, Rules: errRule})
	if r1.JobID == r2.JobID || !r2.Cached {
		t.Fatalf("ids %s %s cached %v", r1.JobID, r2.JobID, r2.Cached)
	}
	e.Cancel(r1.JobID) // the other view still wants it
	e.Close(r1.JobID)
	prog, err := e.Wait(r2.JobID)
	if err != nil || prog.Canceled || !prog.Done || prog.TotalLines == 0 {
		t.Fatalf("view 2 after view 1 left: %+v %v", prog, err)
	}
	if _, err := e.Rows(r1.JobID, 0, 0, 0, 1); err == nil {
		t.Fatal("closed view still answers")
	}
	pg, err := e.Rows(r2.JobID, 0, 0, 0, 5)
	if err != nil || len(pg.Rows) != 5 {
		t.Fatalf("view 2 rows: %v %d", err, len(pg.Rows))
	}
}

// Appended lines are filtered from the old last line on; rows before stay;
// rewriting the file is "changed".
func TestAppendFollow(t *testing.T) {
	for _, enc := range []string{"", "cp949", "utf-16le"} {
		t.Run(enc, func(t *testing.T) {
			encode := func(s string) []byte {
				switch enc {
				case "cp949":
					b, _ := korean.EUCKR.NewEncoder().Bytes([]byte(s))
					return b
				case "utf-16le":
					b, _ := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder().Bytes([]byte(s))
					return b
				}
				return []byte(s)
			}
			p := writeTemp(t, encode("a\nERROR 1 오류\nb\nlast ERR"))
			var evMu sync.Mutex
			var events []Progress
			e := newTestEngine(t, Options{WatchEvery: 20 * time.Millisecond, OnProgress: func(p Progress) {
				evMu.Lock()
				events = append(events, p)
				evMu.Unlock()
			}})
			res, _ := e.Start(Request{Path: p, Encoding: enc, Rules: errRule})
			prog, _ := e.Wait(res.JobID)
			if prog.TailLine != 4 || prog.Version != 0 {
				t.Fatalf("tail %d version %d", prog.TailLine, prog.Version)
			}
			f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
			f.Write(encode("OR 2\nc\nERROR 3\n"))
			f.Close()
			deadline := time.Now().Add(5 * time.Second)
			for {
				st, _ := e.Status(res.JobID)
				if st.Version == 1 && st.Done {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("append not followed: %+v", st)
				}
				time.Sleep(5 * time.Millisecond)
			}
			rows, _ := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(1)))
			if got := lineNos(rows); !reflect.DeepEqual(got, []int64{2, 4, 6}) {
				t.Fatalf("after append hits %v (%+v)", got, rows)
			}
			for _, r := range rows {
				if r.Line == 4 && r.Text != "last ERROR 2" {
					t.Fatalf("continued line %q", r.Text)
				}
			}
			st, _ := e.Status(res.JobID)
			if st.TotalLines != 7 || st.TailLine != 7 || st.RuleHits[0] != 3 {
				t.Fatalf("after append %+v", st)
			}
			// A rewrite with the same size is a change.
			cur, _ := os.ReadFile(p)
			time.Sleep(20 * time.Millisecond)
			os.WriteFile(p, bytes.Replace(cur, encode("a"), encode("z"), 1), 0o644)
			deadline = time.Now().Add(5 * time.Second)
			for {
				st, _ = e.Status(res.JobID)
				if st.Changed {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("rewrite not noticed")
				}
				time.Sleep(5 * time.Millisecond)
			}
			evMu.Lock()
			defer evMu.Unlock()
			sawAppend, sawChanged := false, false
			for _, ev := range events {
				sawAppend = sawAppend || ev.Version == 1
				sawChanged = sawChanged || ev.Changed
			}
			if !sawAppend || !sawChanged {
				t.Fatalf("events: append %v changed %v", sawAppend, sawChanged)
			}
		})
	}
}

// The temp copy goes away even when a reader had it open during Close, and on
// CloseAll.
func TestTempCopyRemoved(t *testing.T) {
	dir := t.TempDir()
	e := New(Options{TempDir: dir, WatchEvery: -1})
	enc, _ := korean.EUCKR.NewEncoder().Bytes([]byte(strings.Repeat("오류 ERROR 한글\n", 1000)))
	p := writeTemp(t, enc)
	res, err := e.Start(Request{Path: p, Encoding: "cp949", Rules: errRule})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait(res.JobID)
	v, _ := e.view(res.JobID)
	tmp := v.j.tempFile
	v.j.content.RLock() // a FilterRows call in flight
	h, err := os.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := e.Start(Request{Path: p, Encoding: "cp949", Rules: []Rule{{Kind: "text", Pattern: "x1"}}})
	e.Wait(r2.JobID)
	e.Close(res.JobID)
	closed := make(chan struct{})
	go func() { e.CloseAll(5 * time.Second); close(closed) }()
	time.Sleep(150 * time.Millisecond)
	if _, err := os.Stat(tmp); err != nil {
		t.Fatal("copy deleted while a reader holds it")
	}
	h.Close()
	v.j.content.RUnlock()
	<-closed
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Fatalf("temp files left: %d", len(ents))
	}
}

func TestGzipErrors(t *testing.T) {
	e := newTestEngine(t, Options{})
	full := gzipBytes(bytes.Repeat([]byte("line ERROR\n"), 100000))
	_, _, prog := run(t, e, full[:len(full)/2], "", errRule, 0, 0)
	if !strings.Contains(prog.Error, "잘려") && !strings.Contains(prog.Error, "압축") {
		t.Fatalf("truncated gzip: %q", prog.Error)
	}
	bad := append([]byte(nil), full...)
	bad[len(bad)-6] ^= 0xff // CRC
	_, _, prog = run(t, e, bad, "", errRule, 0, 0)
	if !strings.Contains(prog.Error, "손상") {
		t.Fatalf("bad crc: %q", prog.Error)
	}
	// size limit and disk space
	e2 := newTestEngine(t, Options{MaxInflate: 100000})
	_, _, prog = run(t, e2, full, "", errRule, 0, 0)
	if !strings.Contains(prog.Error, "상한") {
		t.Fatalf("inflate cap: %q", prog.Error)
	}
	e3 := newTestEngine(t, Options{DiskFree: func(string) (uint64, error) { return 1 << 20, nil }})
	_, _, prog = run(t, e3, full, "", errRule, 0, 0)
	if !strings.Contains(prog.Error, "여유 공간") {
		t.Fatalf("disk: %q", prog.Error)
	}
}

func TestGzipMultiMember(t *testing.T) {
	a := gzipBytes([]byte("one ERROR\ntwo\n"))
	b := gzipBytes([]byte("three\nfour ERROR\n"))
	e := newTestEngine(t, Options{})
	rows, _, prog := run(t, e, append(a, b...), "", errRule, 0, 0)
	if got := lineNos(rows); !reflect.DeepEqual(got, []int64{1, 4}) || prog.TotalLines != 5 {
		t.Fatalf("%v %+v", got, prog)
	}
}

func TestDFAThrashFallsBackCorrectly(t *testing.T) {
	var b strings.Builder
	rng := rand.New(rand.NewSource(5))
	for i := 0; i < 20000; i++ {
		for k := 0; k < 60; k++ {
			b.WriteByte("abcxyz0123456789 ."[rng.Intn(18)])
		}
		b.WriteByte('\n')
	}
	var rules []Rule
	for _, w := range strings.Split("abcxyz", "") {
		rules = append(rules, Rule{Regex: true, Pattern: w + `.{0,25}[0-9]{2}[^0-9]`})
	}
	rules = append(rules, Rule{Kind: "text", Pattern: "zz"})
	want, _ := refFilter(b.String(), rules, refOpts{maxRows: 1 << 30, maxDisplay: 1 << 20})
	for _, mm := range []int{64 << 10, 2000} {
		restore := setKnobs(knobs{0, 8, mm, GiantMax, decodeChunkSizes, decodeChunk1})
		e := newTestEngine(t, Options{DFAMemory: 1, MaxRows: 1 << 30})
		got, _, _ := run(t, e, []byte(b.String()), "", rules, 0, 0)
		restore()
		diffRows(t, got, want, nil)
	}
}

func TestJSCanonAgainstNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found")
	}
	out := filepath.Join(t.TempDir(), "jscanon.json")
	if b, err := exec.Command(node, "testdata/jscanon.js", out).CombinedOutput(); err != nil {
		t.Fatalf("node: %v\n%s", err, b)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var pairs [][2]int
	if err := json.Unmarshal(data, &pairs); err != nil {
		t.Fatal(err)
	}
	m := map[rune]rune{}
	for _, p := range pairs {
		m[rune(p[0])] = rune(p[1])
	}
	bad, versionGap := 0, 0
	for r := rune(0); r <= 0xffff; r++ {
		if r >= 0xd800 && r <= 0xdfff {
			continue
		}
		want := r
		if c, ok := m[r]; ok {
			want = c
		}
		if got := jsCanon(r); got != want {
			// Characters Go's Unicode tables do not know a case for (newer
			// Unicode in this Node, or older in this Go) are a version gap,
			// not a translation error.
			if stdunicode.SimpleFold(r) == r && stdunicode.SimpleFold(want) == want {
				versionGap++
				continue
			}
			bad++
			if bad < 10 {
				t.Errorf("jsCanon(%U) = %U, node %U", r, got, want)
			}
		}
	}
	t.Logf("Unicode version gaps (ignored): %d", versionGap)
	t.Logf("%d mappings checked, %d differ", len(pairs), bad)
}

var _ = fmt.Sprint
