package linefilter

// The stage-1 reviewer's reproductions (stage1-review.md, RV1–RV10) and
// fuzzers, kept as regression tests. Each RV test failed on the stage-1 code.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
)

// RV1: a regex with a line break in it (never matches a line) shifted the
// line numbers of other rules' hits on CRLF files.
func TestRV1_NewlineLiteralShiftsLineNumbers(t *testing.T) {
	e := newTestEngine(t, Options{})
	doc := "a\r\nfoo\r\nzzz ERR\r\nyyy\r\nERR again\r\n"
	rules := []Rule{
		{Kind: "regex", Pattern: `\nfoo`, CaseSensitive: true},
		{Kind: "text", Pattern: "ERR", CaseSensitive: true},
	}
	rows, _, _ := run(t, e, []byte(doc), "", rules, 0, 0)
	if got := fmt.Sprint(lineNos(rows)); got != "[3 5]" {
		t.Errorf("RV1 hit lines = %v, want [3 5]", got)
	}
	if is := Validate(rules); len(is) != 1 || !strings.Contains(is[0].Reason, "줄바꿈") {
		t.Errorf("RV1 the \\n rule should be reported: %+v", is)
	}
}

// RV2: the same case-insensitive rule gave different lines depending on how
// many other rules there were (literal path vs DFA path folded the Kelvin sign
// differently). JS /kafka/gi does not match "Kafka".
func TestRV2_KelvinPathDependent(t *testing.T) {
	doc := "Kafka down\nkafka down\nnothing\n"
	r0 := Rule{Kind: "regex", Pattern: `kafka`, CaseSensitive: false}
	e := newTestEngine(t, Options{})
	rowsA, _, _ := run(t, e, []byte(doc), "", []Rule{r0}, 0, 0)
	more := []Rule{r0,
		{Kind: "text", Pattern: "qqq1", CaseSensitive: true},
		{Kind: "text", Pattern: "qqq2", CaseSensitive: true},
		{Kind: "text", Pattern: "qqq3", CaseSensitive: true},
		{Kind: "text", Pattern: "qqq4", CaseSensitive: true},
	}
	rowsB, _, _ := run(t, e, []byte(doc), "", more, 0, 0)
	a, b := fmt.Sprint(lineNos(rowsA)), fmt.Sprint(lineNos(rowsB))
	if a != "[2]" || b != "[2]" {
		t.Errorf("RV2 1 rule: %v, 5 rules: %v, want [2] both", a, b)
	}
}

// RV3: a regex that only ever matches the empty string (\b) was accepted and
// hit lines the editor never colours.
func TestRV3_EmptyMatchOnlyRule(t *testing.T) {
	is := Validate([]Rule{{Kind: "regex", Pattern: `\b`, CaseSensitive: true}})
	if len(is) != 1 || !strings.Contains(is[0].Reason, "빈 일치") {
		t.Errorf("RV3 \\b: %+v", is)
	}
	// A rule that can match empty but also non-empty: only non-empty matches count.
	e := newTestEngine(t, Options{})
	rows, _, _ := run(t, e, []byte("ERR x\nERRx\n---\n"), "", []Rule{{Kind: "regex", Pattern: `(ERR)?\b`, CaseSensitive: true}}, 0, 0)
	if got := fmt.Sprint(lineNos(rows)); got != "[1]" {
		t.Errorf("RV3 (ERR)?\\b hits %v, editor colours only line 1", got)
	}
}

// RV4: (?i)\W must not match k or s (JS /\W/i does not).
func TestRV4_FoldedNotWord(t *testing.T) {
	e := newTestEngine(t, Options{})
	rows, _, _ := run(t, e, []byte("errorkcode\nerrorscode\nerror code\n"), "", []Rule{{Kind: "regex", Pattern: `error\Wcode`}}, 0, 0)
	if fmt.Sprint(lineNos(rows)) != "[3]" {
		t.Errorf("RV4 hits %v, JS gives [3]", lineNos(rows))
	}
}

// RV5: a line longer than the buffer: a match after the buffer was missed, and
// foo$ / word foo matched falsely at the cut.
func TestRV5_LongLineCut(t *testing.T) {
	for _, giant := range []int{1 << 30, 50} {
		restore := setKnobs(knobs{litPassLimit, groupSize, dfaMinMem, giant, decodeChunkSizes, decodeChunk1})
		e := newTestEngine(t, Options{Chunk: 64, BufSize: 72})
		long := strings.Repeat("x", 100) + " ERROR tail"
		cutFoo := strings.Repeat("y", 69) + "foo" + "barbarbarbar"
		doc := "first\n" + long + "\n" + cutFoo + "\nlast\n"
		rules := []Rule{
			{Kind: "text", Pattern: "ERROR", CaseSensitive: true},
			{Kind: "regex", Pattern: `foo$`, CaseSensitive: true},
			{Kind: "word", Pattern: "foo", CaseSensitive: true},
		}
		rows, _, _ := run(t, e, []byte(doc), "", rules, 0, 0)
		restore()
		m := hitMap(rows)
		if _, ok := m[2]; !ok {
			t.Errorf("RV5a giant=%d: ERROR after the buffer limit missed (line 2)", giant)
		}
		if _, ok := m[3]; ok {
			t.Errorf("RV5b giant=%d: false hit at the cut on line 3: rules %v", giant, m[3])
		}
	}
}

// RV6: one stray byte after the sample re-read a UTF-8 file as CP949 and lost
// every Korean match; the encoding also depended on the rules.
func TestRV6_LateStrayByteKillsKoreanRules(t *testing.T) {
	var b bytes.Buffer
	for b.Len() < 3<<20 {
		b.WriteString("2026-10-21 10:00:00 연결 실패ERROR 서버 응답 없음\n")
	}
	nLines := strings.Count(b.String(), "\n")
	b.WriteString("broken \xff byte\n")
	rules := []Rule{
		{Kind: "text", Pattern: "연결 실패", CaseSensitive: true},
		{Kind: "text", Pattern: "ERROR", CaseSensitive: true},
	}
	e := newTestEngine(t, Options{MaxRows: 1 << 30})
	_, _, prog := run(t, e, b.Bytes(), "", rules, 0, 0)
	if prog.Encoding != EncUTF8 || prog.RuleHits[0] != int64(nLines) || prog.RuleHits[1] != int64(nLines) {
		t.Errorf("RV6 encoding=%s ruleHits=%v want utf-8 %d/%d", prog.Encoding, prog.RuleHits, nLines, nLines)
	}
	if prog.InvalidBytes != 1 || prog.InvalidLine != int64(nLines+1) {
		t.Errorf("RV6 invalid bytes %d at line %d", prog.InvalidBytes, prog.InvalidLine)
	}
	e2 := newTestEngine(t, Options{MaxRows: 1000})
	_, _, prog2 := run(t, e2, b.Bytes(), "", rules, 0, 0)
	if prog2.Encoding != prog.Encoding {
		t.Errorf("RV6b encoding depends on rules/caps: %s vs %s", prog.Encoding, prog2.Encoding)
	}
}

func TestRV6b_EncodingDependsOnRules(t *testing.T) {
	size := 120 << 20
	if testing.Short() {
		size = 12 << 20
	}
	var b bytes.Buffer
	for b.Len() < size {
		b.WriteString("2026-10-21 10:00:00 INFO 연결 실패 서버 응답 없음 ................................\n")
	}
	b.WriteString("broken \xff byte\n")
	p := writeTemp(t, b.Bytes())
	e := newTestEngine(t, Options{})
	var encs []string
	for _, rs := range [][]Rule{
		{{Kind: "text", Pattern: "INFO", CaseSensitive: true}},   // every line
		{{Kind: "text", Pattern: "broken", CaseSensitive: true}}, // one line
	} {
		res, _ := e.Start(Request{Path: p, Rules: rs})
		prog, _ := e.Wait(res.JobID)
		encs = append(encs, prog.Encoding)
	}
	if encs[0] != EncUTF8 || encs[1] != EncUTF8 {
		t.Errorf("RV6b encodings %v", encs)
	}
}

// RV7: the temp copy was deleted while a reader still had it open (Windows:
// the delete failed silently and the copy stayed).
func TestRV7_TempCopyLeakWhenOpen(t *testing.T) {
	dir := t.TempDir()
	e := New(Options{TempDir: dir, WatchEvery: -1})
	defer e.CloseAll(time.Second)
	enc, _ := korean.EUCKR.NewEncoder().Bytes([]byte(strings.Repeat("오류 ERROR 한글\n", 1000)))
	p := writeTemp(t, enc)
	res, err := e.Start(Request{Path: p, Encoding: "cp949", Rules: errRule})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait(res.JobID)
	v, _ := e.view(res.JobID)
	tmp := v.j.tempFile
	h, err := os.Open(tmp) // stands for a handle still open somewhere
	if err != nil {
		t.Fatal(err)
	}
	e.CloseAll(10 * time.Millisecond)
	time.Sleep(200 * time.Millisecond)
	h.Close()
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(tmp); err == nil {
		t.Errorf("RV7 temp copy still exists after Close: %s", tmp)
	}
}

// RV8: a truncated flag surviving an encoding restart (there are no restarts
// any more; kept as a check that the cap is exact).
func TestRV8b_TruncatedSurvivesRestartRace(t *testing.T) {
	var b bytes.Buffer
	for i := 0; i < 1150; i++ {
		b.WriteString("한ERROR\n")
	}
	b.WriteString("\xff\n")
	for i := 0; i < 2000; i++ {
		b.WriteString("plain line\n")
	}
	for trial := 0; trial < 50; trial++ {
		e := newTestEngine(t, Options{MaxRows: 1000, Chunk: 1 << 10, Workers: 4})
		_, _, prog := run(t, e, b.Bytes(), "", []Rule{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}}, 0, 0)
		if prog.Encoding != EncUTF8 || prog.Hits != 1001 || !prog.Truncated {
			t.Fatalf("trial %d: %+v", trial, prog)
		}
	}
}

// RV9: two panes on the same file and rules got the same job id; closing one
// killed the other.
func TestRV9_SharedJobClose(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("a\nERROR\nb\n"))
	r1, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(r1.JobID)
	r2, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Close(r1.JobID)
	if _, err := e.Rows(r2.JobID, 0, 0, 0, 10); err != nil {
		t.Errorf("RV9 pane 2 lost its job after pane 1 closed: %v", err)
	}
}

// RV10: a growing log: after an append, Rows served nothing.
func TestRV10_GrowingLog(t *testing.T) {
	e := newTestEngine(t, Options{})
	p := writeTemp(t, []byte("a\nERROR one\nb\n"))
	r, _ := e.Start(Request{Path: p, Rules: errRule})
	e.Wait(r.JobID)
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("ERROR two\n")
	f.Close()
	time.Sleep(250 * time.Millisecond) // Rows looks at the file at most every 200ms
	pg, err := e.Rows(r.JobID, 0, 0, 0, 100)
	if err != nil || len(pg.Rows) == 0 || pg.Changed {
		t.Fatalf("RV10 after append: rows=%d changed=%v err=%v", len(pg.Rows), pg.Changed, err)
	}
	e.Wait(r.JobID)
	rows, _ := collect(t, e, r.JobID, 0, 0, rand.New(rand.NewSource(1)))
	if fmt.Sprint(lineNos(rows)) != "[2 4]" {
		t.Fatalf("RV10 after following: %v", lineNos(rows))
	}
}

// Line-number fuzz: break-heavy docs, tiny chunks/buffers, every line that
// starts with 'x' is a hit; compared with an independent model.
func TestRVLineNumberFuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(4242))
	breaks := []string{"\n", "\r", "\r\n", "\n\r", "\r\r\n", "\n\n", "\r\r"}
	iters := 300
	if testing.Short() {
		iters = 80
	}
	for iter := 0; iter < iters; iter++ {
		var sb strings.Builder
		for k := rng.Intn(25); k > 0; k-- {
			switch rng.Intn(4) {
			case 0:
				sb.WriteString("x" + strings.Repeat("가", rng.Intn(30)))
			case 1:
				sb.WriteString(strings.Repeat("y", rng.Intn(50)))
			case 2:
				sb.WriteString("x")
			}
			sb.WriteString(breaks[rng.Intn(len(breaks))])
		}
		if rng.Intn(2) == 0 {
			sb.WriteString("x tail")
		}
		doc := sb.String()
		lines := refLines(doc)
		var want []int64
		for i, l := range lines {
			if strings.HasPrefix(l, "x") {
				want = append(want, int64(i+1))
			}
		}
		A, B := rng.Intn(3), rng.Intn(3)
		show := make([]bool, len(lines)+2)
		for _, h := range want {
			for x := h - int64(A); x <= h+int64(B); x++ {
				if x >= 1 && x <= int64(len(lines)) {
					show[x] = true
				}
			}
		}
		var exp []string
		gap := 0
		for i := 1; i <= len(lines); i++ {
			if !show[i] {
				gap++
				continue
			}
			if gap > 0 {
				exp = append(exp, fmt.Sprintf("gap%d", gap))
				gap = 0
			}
			exp = append(exp, fmt.Sprintf("%d:%s", i, lines[i-1]))
		}
		if gap > 0 && len(want) > 0 {
			exp = append(exp, fmt.Sprintf("gap%d", gap))
		}
		for _, encName := range []string{"", "cp949", "utf-16le", "gz"} {
			data := []byte(doc)
			enc := encName
			switch encName {
			case "cp949":
				data, _ = korean.EUCKR.NewEncoder().Bytes(data)
			case "utf-16le":
				data, _ = unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().Bytes(data)
			case "gz":
				data, enc = gzipBytes(data), "utf-8"
			}
			restore := setKnobs(knobs{litPassLimit, groupSize, dfaMinMem, GiantMax, []int64{1, 2, 3}, int64(1 + rng.Intn(9))})
			e := newTestEngine(t, Options{Chunk: int64(1 + rng.Intn(20)), BufSize: 8 + rng.Intn(40), MaxLineDisplay: 1 << 20})
			rows, _, prog := run(t, e, data, enc, [][]Rule{{{Kind: "regex", Pattern: "^x", CaseSensitive: true}}, {{Kind: "text", Pattern: "x", CaseSensitive: true}}, {{Kind: "text", Pattern: "X"}}}[iter%3], A, B)
			restore()
			var got []string
			for _, r := range rows {
				if r.Line == 0 {
					got = append(got, fmt.Sprintf("gap%d", r.Skip))
				} else {
					got = append(got, fmt.Sprintf("%d:%s", r.Line, r.Text))
				}
			}
			if len(want) == 0 && len(got) == 1 && got[0] == fmt.Sprintf("gap%d", len(lines)) {
				continue
			}
			if strings.Join(got, "|") != strings.Join(exp, "|") || prog.TotalLines != int64(len(lines)) {
				t.Fatalf("iter %d enc %q A=%d B=%d doc=%q\n got=%q\nwant=%q totalLines=%d/%d", iter, encName, A, B, doc, got, exp, prog.TotalLines, len(lines))
			}
		}
	}
}

// Concurrent Start/Rows/Cancel/Close/eviction/appends: no panic, deadlock,
// internal error, goroutine or temp-file leak.
func TestRVStress(t *testing.T) {
	dir := t.TempDir()
	var b bytes.Buffer
	for i := 0; i < 200000; i++ {
		fmt.Fprintf(&b, "2026-10-21 10:00:%02d %s line %d 한글\r\n", i%60, []string{"INFO", "ERROR", "WARN", "DEBUG"}[i%4], i)
	}
	cp, _ := korean.EUCKR.NewEncoder().Bytes(b.Bytes())
	docs := [][]byte{b.Bytes(), cp, gzipBytes(b.Bytes())}
	var paths []string
	for i, d := range docs {
		p := filepath.Join(dir, fmt.Sprintf("doc%d.log", i))
		os.WriteFile(p, d, 0o644)
		paths = append(paths, p)
	}
	growing := filepath.Join(dir, "grow.log")
	os.WriteFile(growing, b.Bytes()[:1<<20], 0o644)
	paths = append(paths, growing)
	tmpDir := t.TempDir()
	g0 := runtime.NumGoroutine()
	e := New(Options{TempDir: tmpDir, OnProgress: func(Progress) {}, WatchEvery: 20 * time.Millisecond, MaxIdleJobs: 2})
	ruleSets := [][]Rule{
		{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}},
		{{Kind: "regex", Pattern: `WARN|ERROR`, CaseSensitive: false}},
		{{Kind: "text", Pattern: "한글"}, {Kind: "word", Pattern: "line"}},
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	errs := map[string]int{}
	dur := 8 * time.Second
	if testing.Short() {
		dur = 2 * time.Second
	}
	deadline := time.Now().Add(dur)
	wg.Add(1)
	go func() { // a writer appending to the growing log
		defer wg.Done()
		off := 1 << 20
		for time.Now().Before(deadline) && off < b.Len() {
			f, _ := os.OpenFile(growing, os.O_APPEND|os.O_WRONLY, 0)
			n := 7777
			if off+n > b.Len() {
				n = b.Len() - off
			}
			f.Write(b.Bytes()[off : off+n])
			f.Close()
			off += n
			time.Sleep(3 * time.Millisecond)
		}
	}()
	for w := 0; w < 12; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			for time.Now().Before(deadline) {
				p := paths[rng.Intn(len(paths))]
				enc := []string{"", "cp949"}[rng.Intn(2)]
				if !strings.HasSuffix(p, "doc1.log") {
					enc = ""
				}
				res, err := e.Start(Request{Path: p, Encoding: enc, Rules: ruleSets[rng.Intn(len(ruleSets))]})
				if err != nil {
					mu.Lock()
					errs["start:"+err.Error()]++
					mu.Unlock()
					continue
				}
				for k := 0; k < 1+rng.Intn(6); k++ {
					switch rng.Intn(10) {
					case 0:
						e.Cancel(res.JobID)
					case 1:
						e.Status(res.JobID)
					default:
						pg, err := e.Rows(res.JobID, rng.Intn(5), rng.Intn(5), rng.Intn(3000), 1+rng.Intn(3000))
						if err != nil {
							mu.Lock()
							errs["rows:"+err.Error()]++
							mu.Unlock()
						}
						for _, r := range pg.Rows {
							if r.Line > 0 && strings.ContainsAny(r.Text, "\r\n") {
								mu.Lock()
								errs["bad row text"]++
								mu.Unlock()
							}
						}
					}
				}
				e.Close(res.JobID)
			}
		}(int64(w))
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(dur + 60*time.Second):
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		t.Fatalf("deadlock?\n%s", buf[:n])
	}
	e.CloseAll(5 * time.Second)
	time.Sleep(300 * time.Millisecond)
	ents, _ := os.ReadDir(tmpDir)
	g1 := runtime.NumGoroutine()
	t.Logf("errors: %v", errs)
	t.Logf("goroutines before=%d after=%d; temp files left=%d", g0, g1, len(ents))
	if len(errs) > 0 {
		t.Errorf("errors: %v", errs)
	}
	if len(ents) != 0 {
		t.Errorf("temp files left: %d", len(ents))
	}
	if g1 > g0+3 {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		t.Errorf("goroutines leaked: %d → %d\n%s", g0, g1, buf[:n])
	}
}

// ---- DFA fuzz with the reviewer's generator ---------------------------------

var rvAtoms = []string{
	"a", "b", "k", "K", "s", "S", "x", "é", "É", "ß", "가", "K", "ſ", "_", "1", " ", "-", ".",
	`\d`, `\w`, `\s`, `\D`, `\W`, `\S`, `\b`, `\B`, `^`, `$`, `.`, `\pL`, `\p{Greek}`, `[[:alpha:]]`,
	`[a-c]`, `[^a-c]`, `[k-s]`, `[^\x00-\x7f]`, `[가-힣]`, `\x{fffd}`, `[é_1]`, `[^ ]`, `(?:)`, `\x00`,
	`\A`, `\z`,
}

func rvGen(rng *rand.Rand, depth int) string {
	if depth <= 0 || rng.Intn(4) == 0 {
		return rvAtoms[rng.Intn(len(rvAtoms))]
	}
	switch rng.Intn(9) {
	case 0, 1:
		n := 2 + rng.Intn(3)
		var parts []string
		for i := 0; i < n; i++ {
			parts = append(parts, rvGen(rng, depth-1))
		}
		return strings.Join(parts, "")
	case 2:
		return "(?:" + rvGen(rng, depth-1) + "|" + rvGen(rng, depth-1) + ")"
	case 3:
		q := []string{"*", "+", "?", "{2}", "{1,3}", "{0,2}", "*?", "+?", "{2,}"}[rng.Intn(9)]
		return "(?:" + rvGen(rng, depth-1) + ")" + q
	case 4:
		return "(?i:" + rvGen(rng, depth-1) + ")"
	case 5:
		return "(?-i:" + rvGen(rng, depth-1) + ")"
	case 6:
		return "(" + rvGen(rng, depth-1) + ")"
	case 7:
		return "(?s:" + rvGen(rng, depth-1) + ")"
	default:
		return "(?m:" + rvGen(rng, depth-1) + ")"
	}
}

var rvLineAlpha = []string{"a", "b", "k", "K", "s", "S", "x", "é", "É", "ß", "ẞ", "가", "힣", "K", "ſ", "_", "1", "9", " ", "\t", "-", ".", "\xff", "\xc3", "\xe0\x80", "\xed\xa0\x80", "\x00", " ", "σ", "Σ", "ς", "\U0001F600"}

func rvLine(rng *rand.Rand) []byte {
	n := rng.Intn(16)
	var b []byte
	for i := 0; i < n; i++ {
		b = append(b, rvLineAlpha[rng.Intn(len(rvLineAlpha))]...)
	}
	return b
}

// The DFA (unanchored: match + earliest end bound; anchored: first start;
// streaming in pieces) agrees with the stdlib on random regexes and lines,
// with normal and tiny caches (flushes, give-ups).
func TestRV_DFAFuzzOwnGenerator(t *testing.T) {
	rng := rand.New(rand.NewSource(20261026))
	patterns, lines := 0, 0
	n := 1500
	if testing.Short() {
		n = 300
	}
	for _, limit := range []int{1 << 20, 4000, 600} {
		old := dfaMinMem
		dfaMinMem = 1
		for p := 0; p < n; p++ {
			src := rvGen(rng, 4)
			if rng.Intn(3) == 0 {
				src = "(?i)" + src
			}
			pi, err := newProgInfo(src)
			if err != nil {
				continue
			}
			re := pi.re
			patterns++
			d := newDFA(pi, false, limit)
			a := newDFA(pi, true, limit)
			for i := 0; i < 400; i++ {
				ln := rvLine(rng)
				lines++
				want := re.FindIndex(ln)
				got, end := d.match(ln)
				if d.failed {
					d = newDFA(pi, false, limit)
					continue
				}
				if got != (want != nil) {
					t.Fatalf("limit %d: %q on %q: dfa=%v regexp=%v", limit, src, ln, got, want)
				}
				if !got {
					continue
				}
				if end < want[0] {
					t.Fatalf("limit %d: %q on %q: end bound %d before the leftmost start %d", limit, src, ln, end, want[0])
				}
				s, ok := a.firstStart(ln, end, 1<<20)
				if a.failed {
					a = newDFA(pi, true, limit)
					continue
				}
				if ok && s != want[0] {
					t.Fatalf("limit %d: %q on %q: first start %d, regexp %d", limit, src, ln, s, want[0])
				}
				// streaming in random pieces
				st := d.streamBegin()
				var acc bool
				for pos := 0; pos < len(ln) && !acc; {
					k := pos + 1 + rng.Intn(4)
					if k > len(ln) {
						k = len(ln)
					}
					piece := ln[pos:k]
					c := len(piece)
					for k < len(ln) {
						if c = runeCut(piece); c > 0 {
							break
						}
						k++
						piece = ln[pos:k]
						c = len(piece)
					}
					st, acc = d.feed(st, piece[:c])
					pos += c
					if d.failed {
						break
					}
				}
				if !d.failed && (acc || d.feedEnd(st)) != true {
					t.Fatalf("stream: %q on %q: no match", src, ln)
				}
				if d.failed {
					d = newDFA(pi, false, limit)
				}
			}
		}
		dfaMinMem = old
	}
	t.Logf("compared %d patterns, %d lines", patterns, lines)
}

// ---- JS oracle -------------------------------------------------------------------

var jsAtoms = []string{
	"д", "Σ", "ö", "ÿ", `[а-я]`, `[^σ]`, "a", "b", "k", "s", "e", "r", "o", "E", "R", "O", "K", "S", "1", "2", " ", "-", ":", "_", "é", "É", "가", "ß",
	`\d`, `\D`, `\w`, `\W`, `\s`, `\S`, `\b`, `\B`, `.`, `^`, `$`,
	`[a-c]`, `[^a-c]`, `[\d.]`, `[\w-]`, `[^\s]`, `[^]`, `[]`, `[\b]`, `[a-z]`, `[A-Z]`, `[^ ]`, `[k]`, `[s-t]`,
	`\x41`, `é`, `K`, `\t`, `\.`, `\/`, `\-`, `\e`, `{`, `}`, `]`, `\cI`, `\0`,
	`error`, `ERROR`, `fail`, `kafka`, `[é]`, ` `, ` `, `\uFEFF`, `😀`, `.😀`,
}

func jsGen(rng *rand.Rand, depth int) string {
	if depth <= 0 || rng.Intn(4) == 0 {
		return jsAtoms[rng.Intn(len(jsAtoms))]
	}
	switch rng.Intn(8) {
	case 0, 1:
		n := 2 + rng.Intn(3)
		var p []string
		for i := 0; i < n; i++ {
			p = append(p, jsGen(rng, depth-1))
		}
		return strings.Join(p, "")
	case 2:
		return "(?:" + jsGen(rng, depth-1) + "|" + jsGen(rng, depth-1) + ")"
	case 3:
		q := []string{"*", "+", "?", "{2}", "{1,3}", "{0,2}", "*?", "+?", "{2,}"}[rng.Intn(9)]
		return "(?:" + jsGen(rng, depth-1) + ")" + q
	case 4:
		return "(" + jsGen(rng, depth-1) + ")"
	case 5:
		return "(?<n" + string(rune('a'+rng.Intn(26))) + ">" + jsGen(rng, depth-1) + ")"
	case 6:
		return "(?i:" + jsGen(rng, depth-1) + ")"
	default:
		return jsGen(rng, depth-1) + "|" + jsGen(rng, depth-1)
	}
}

var jsLineAlpha = []string{"\x1b[31m", "\x1b[0m", "\x1b[1;33m", "\x1b[", "\x1b", "д", "Д", "σ", "Σ", "ς", "ö", "Ö", "ÿ", "Ÿ", "a", "b", "k", "K", "s", "S", "e", "r", "o", "E", "R", "O", "x", "é", "É", "ß", "ẞ", "가", "K", "ſ", "_", "1", "2", " ", "\t", "-", ":", ".", " ", " ", "　", "\uFEFF", "\x0b", "\x0c", "\U0001F600", "error", "ERROR", "fail", "kafka", "/", "{", "}", "]", "\x00", "A", "İ", "ı", " "}

// The engine (lines and first-match columns) against the editor's own regex
// code run in Node (testdata/js_oracle.js). Skipped without node.
func TestJSOracle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found")
	}
	rng := rand.New(rand.NewSource(99))
	type ruleOut struct {
		Kind          string `json:"kind"`
		Pattern       string `json:"pattern"`
		CaseSensitive bool   `json:"caseSensitive"`
	}
	type caseOut struct {
		Lines  []string        `json:"lines"`
		Rules  []ruleOut       `json:"rules"`
		Issues map[int]string  `json:"issues"`
		Hits   map[int64][]int `json:"hits"`
		Cols   map[int64]int32 `json:"cols"`
	}
	var cases []caseOut
	e := newTestEngine(t, Options{})
	n := 600
	if testing.Short() {
		n = 150
	}
	for c := 0; c < n; c++ {
		var doc strings.Builder
		nl := 20 + rng.Intn(30)
		for i := 0; i < nl; i++ {
			for k := rng.Intn(14); k > 0; k-- {
				doc.WriteString(jsLineAlpha[rng.Intn(len(jsLineAlpha))])
			}
			if i < nl-1 {
				doc.WriteString([]string{"\n", "\r\n", "\r"}[rng.Intn(3)])
			}
		}
		var rules []Rule
		var ro []ruleOut
		for r := 1 + rng.Intn(5); r > 0; r-- {
			var rr Rule
			switch rng.Intn(4) {
			case 0:
				w := jsLineAlpha[rng.Intn(len(jsLineAlpha))] + jsLineAlpha[rng.Intn(len(jsLineAlpha))]
				rr = Rule{Kind: "word", Pattern: w, CaseSensitive: rng.Intn(2) == 0}
			case 1:
				w := jsLineAlpha[rng.Intn(len(jsLineAlpha))] + jsLineAlpha[rng.Intn(len(jsLineAlpha))]
				rr = Rule{Kind: "text", Pattern: w, CaseSensitive: rng.Intn(2) == 0}
			default:
				rr = Rule{Kind: "regex", Pattern: jsGen(rng, 3), CaseSensitive: rng.Intn(2) == 0}
			}
			rules = append(rules, rr)
			ro = append(ro, ruleOut{rr.Kind, rr.Pattern, rr.CaseSensitive})
		}
		p := writeTemp(t, []byte(doc.String()))
		res, err := e.Start(Request{Path: p, Encoding: "utf-8", Rules: rules})
		if err != nil {
			t.Fatal(err)
		}
		e.Wait(res.JobID)
		rows, _ := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(1)))
		co := caseOut{Lines: refLines(doc.String()), Rules: ro, Issues: map[int]string{}, Hits: map[int64][]int{}, Cols: map[int64]int32{}}
		for _, is := range res.Issues {
			co.Issues[is.Index] = is.Reason
		}
		for _, r := range rows {
			if r.Hit {
				co.Hits[r.Line] = r.Rules
				co.Cols[r.Line] = r.Col
			}
		}
		cases = append(cases, co)
		e.Close(res.JobID)
	}
	b, _ := json.Marshal(cases)
	corpus := filepath.Join(t.TempDir(), "corpus.json")
	os.WriteFile(corpus, b, 0o644)
	out, err := exec.Command(node, "testdata/js_oracle.js", corpus).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	first, rest, _ := strings.Cut(string(out), "\n")
	var st struct {
		Rules, Both, EditorRisky, GoOnly, LineChecks, LineMismatch, ColChecks, ColMismatch int
		EditorOnly                                                                         map[string]int
	}
	if err := json.Unmarshal([]byte(first), &st); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Logf("%s", first)
	if st.LineMismatch != 0 || st.ColMismatch != 0 || st.GoOnly != 0 {
		t.Errorf("JS oracle mismatches:\n%s", rest)
	}
}

var _ = regexp.MustCompile

// Set DFAs: one pass reports exactly the rules the stdlib says match, with an
// end bound at or after each one's leftmost start.
func TestSetDFAFuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	n := 400
	if testing.Short() {
		n = 100
	}
	checked := 0
	for _, limit := range []int{1 << 20, 3000} {
		old := dfaMinMem
		dfaMinMem = 1
		for it := 0; it < n; it++ {
			k := 1 + rng.Intn(10)
			var srcs []string
			var res []*regexp.Regexp
			for len(srcs) < k {
				src := rvGen(rng, 3)
				if rng.Intn(3) == 0 {
					src = "(?i)" + src
				}
				re, err := regexp.Compile(src)
				if err != nil {
					continue
				}
				srcs = append(srcs, src)
				res = append(res, re)
			}
			pi, err := newSetProgInfo(srcs)
			if err != nil {
				t.Fatal(err)
			}
			d := newDFA(pi, false, limit)
			var ends [64]int32
			for i := 0; i < 300; i++ {
				ln := rvLine(rng)
				mask := d.matchSet(ln, &ends)
				if d.failed {
					d = newDFA(pi, false, limit)
					continue
				}
				checked++
				for r, re := range res {
					loc := re.FindIndex(ln)
					if (mask&(1<<uint(r)) != 0) != (loc != nil) {
						t.Fatalf("set %q rule %d on %q: set=%v regexp=%v", srcs, r, ln, mask&(1<<uint(r)) != 0, loc)
					}
					if loc != nil && int(ends[r]) < loc[0] {
						t.Fatalf("set %q rule %d on %q: end %d before start %d", srcs, r, ln, ends[r], loc[0])
					}
				}
			}
		}
		dfaMinMem = old
	}
	t.Logf("%d set checks", checked)
}
