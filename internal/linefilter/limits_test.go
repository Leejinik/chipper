package linefilter

import (
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/korean"
)

// ---- more than 64 rules -------------------------------------------------------

// manyRules: n rules t000…, cycling text / word / regex.
func manyRules(n int) []Rule {
	var rs []Rule
	for i := 0; i < n; i++ {
		tok := fmt.Sprintf("t%03d", i)
		switch i % 3 {
		case 0:
			rs = append(rs, Rule{Kind: "text", Pattern: tok, CaseSensitive: true})
		case 1:
			rs = append(rs, Rule{Kind: "word", Pattern: tok})
		default:
			rs = append(rs, Rule{Kind: "regex", Pattern: tok + `\b`, CaseSensitive: true})
		}
	}
	return rs
}

func manyRulesDoc(rng *rand.Rand, lines, nRules int) []byte {
	var b bytes.Buffer
	for i := 0; i < lines; i++ {
		fmt.Fprintf(&b, "%05d info", i)
		for k := rng.Intn(4); k > 0; k-- {
			fmt.Fprintf(&b, " t%03d", rng.Intn(nRules+20)) // some tokens have no rule
		}
		if rng.Intn(40) == 0 {
			b.WriteString(" " + strings.Repeat("x", 300))
		}
		b.WriteByte('\n')
	}
	return b.Bytes()
}

func wantRuleHits(rows []Row, n int) []int64 {
	out := make([]int64, n)
	for _, r := range rows {
		for _, ri := range r.Rules {
			out[ri]++
		}
	}
	return out
}

// Every enabled rule is used however many there are: 200 rules, on every
// matching path (set DFA, small groups, streamed giant lines, stdlib fallback,
// literal passes) and across an append.
func TestManyRules(t *testing.T) {
	const n = 200
	rules := manyRules(n)
	if is := Validate(rules); len(is) != 0 {
		t.Fatalf("200 rules: %d rejected, first %+v", len(is), is[0])
	}
	rng := rand.New(rand.NewSource(7))
	doc := manyRulesDoc(rng, 3000, n)
	small := manyRulesDoc(rng, 400, n)
	type cfg struct {
		name string
		k    knobs
		o    Options
		doc  []byte
	}
	def := knobs{litPassLimit, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1}
	k8 := def
	k8.group = 8
	kGiant := def
	kGiant.giant = 20
	kStd := def
	kStd.minMem, kStd.group = 600, 8
	kLit := def
	kLit.litPass = 1000
	cfgs := []cfg{
		{"default", def, Options{}, doc},
		{"group8", k8, Options{Chunk: 4096}, doc},
		{"streamed", kGiant, Options{BufSize: 64, Chunk: 16}, small},
		{"stdlib", kStd, Options{DFAMemory: 1}, doc},
		{"literal", kLit, Options{Chunk: 4096}, doc},
	}
	for _, c := range cfgs {
		restore := setKnobs(c.k)
		c.o.MaxRows = 1 << 30
		e := newTestEngine(t, c.o)
		got, _, prog := run(t, e, c.doc, "", rules, 1, 0)
		want, _ := refFilter(string(c.doc), rules, refOpts{above: 1, maxRows: 1 << 30, maxDisplay: DefaultMaxLineDisplay})
		colOK := func(g, w Row) bool { return g.Hit && g.Col == -1 && GiantMax < 1000 }
		diffRows(t, got, want, colOK)
		if wr := wantRuleHits(want, n); !reflect.DeepEqual(prog.RuleHits, wr) {
			t.Errorf("%s: ruleHits differ (rule 199: %d want %d)", c.name, prog.RuleHits[n-1], wr[n-1])
		}
		hi := 0
		for _, r := range got {
			for _, ri := range r.Rules {
				if ri >= 64 {
					hi++
				}
			}
		}
		if hi == 0 {
			t.Errorf("%s: no hit of a rule past the 64th", c.name)
		}
		restore()
		if t.Failed() {
			t.Fatalf("config %s", c.name)
		}
	}

	// append: the hits after the restart point are dropped (rule counts too)
	// and filtered again
	e := newTestEngine(t, Options{MaxRows: 1 << 30})
	half := bytes.LastIndexByte(doc[:len(doc)/2], '\n') + 1
	p := writeTemp(t, doc[:half])
	res, err := e.Start(Request{Path: p, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait(res.JobID)
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.Write(doc[half:])
	f.Close()
	v, _ := e.view(res.JobID)
	v.j.checkFile(true)
	prog, _ := e.Wait(res.JobID)
	if prog.Version != 1 {
		t.Fatalf("append not followed: %+v", prog)
	}
	got, _ := collect(t, e, res.JobID, 0, 0, rand.New(rand.NewSource(1)))
	want, _ := refFilter(string(doc), rules, refOpts{maxRows: 1 << 30, maxDisplay: DefaultMaxLineDisplay})
	diffRows(t, got, want, nil)
	if wr := wantRuleHits(want, n); !reflect.DeepEqual(prog.RuleHits, wr) {
		t.Errorf("after append: ruleHits differ")
	}
}

// A rule past the 64th whose DFA explodes is reported in slowRules.
func TestManyRulesSlowRuleReported(t *testing.T) {
	var b strings.Builder
	rng := rand.New(rand.NewSource(5))
	for i := 0; i < 20000; i++ {
		for k := 0; k < 60; k++ {
			b.WriteByte("abcxyz0123456789 ."[rng.Intn(18)])
		}
		b.WriteByte('\n')
	}
	rules := manyRules(69)
	rules = append(rules, Rule{Regex: true, Pattern: `a.{0,25}[0-9]{2}[^0-9]`}) // index 69
	want, _ := refFilter(b.String(), rules, refOpts{maxRows: 1 << 30, maxDisplay: 1 << 20})
	restore := setKnobs(knobs{litPassLimit, 8, 2000, GiantMax, decodeChunkSizes, decodeChunk1})
	defer restore()
	e := newTestEngine(t, Options{DFAMemory: 1, MaxRows: 1 << 30})
	got, _, prog := run(t, e, []byte(b.String()), "", rules, 0, 0)
	diffRows(t, got, want, nil)
	if !slices.Contains(prog.SlowRules, 69) {
		t.Fatalf("slowRules %v: want 69 in it", prog.SlowRules)
	}
	for _, s := range prog.SlowRules {
		if s < 0 || s >= len(rules) {
			t.Fatalf("slowRules %v: bad index", prog.SlowRules)
		}
	}
}

// ---- encoding samples -----------------------------------------------------------

func cp949(s string) []byte {
	b, err := korean.EUCKR.NewEncoder().Bytes([]byte(s))
	if err != nil {
		panic(err)
	}
	return b
}

// Automatic encoding: an English head followed by Korean must not be decided by
// the head alone — for .gz too (the head sample of a .gz is its first 4MB of
// inflated text) and when the head holds a stray byte but no multi-byte
// character.
func TestDetectLateKorean(t *testing.T) {
	ascii := func(n int, stray bool) []byte {
		var b bytes.Buffer
		for i := 0; b.Len() < n; i++ {
			b.WriteString("plain ascii start-up line\n")
			if stray && i == 100 {
				b.WriteString("stray \xff byte\n")
			}
		}
		return b.Bytes()
	}
	korLines := func(enc string, n int) []byte {
		var b bytes.Buffer
		line := []byte("가 오류 한글 메시지\n")
		if enc == EncCP949 {
			line = cp949(string(line))
		}
		for i := 0; i < n; i++ {
			b.Write(line)
		}
		return b.Bytes()
	}
	cases := []struct {
		name   string
		head   []byte
		tail   string // encoding of the Korean lines
		gz     bool
		want   string
		hitsOK func(int) bool
	}{
		{"plain ascii→cp949", ascii(3<<20, false), EncCP949, false, EncCP949, nil},
		{"plain stray→utf-8", ascii(3<<20, true), EncUTF8, false, EncUTF8, nil},
		{"plain stray→cp949", ascii(3<<20, true), EncCP949, false, EncCP949, nil},
		{"gz ascii 6MB→cp949", ascii(6<<20, false), EncCP949, true, EncCP949, nil},
		{"gz stray 6MB→utf-8", ascii(6<<20, true), EncUTF8, true, EncUTF8, nil},
		{"gz stray 6MB→cp949", ascii(6<<20, true), EncCP949, true, EncCP949, nil},
		{"gz ascii 1MB→cp949", ascii(1<<20, false), EncCP949, true, EncCP949, nil},
		// past the 32MB the .gz sample reaches: decided from what was seen
		{"gz ascii 33MB→cp949", ascii(33<<20, false), EncCP949, true, EncUTF8, func(int) bool { return true }},
	}
	e := newTestEngine(t, Options{})
	for _, c := range cases {
		data := append(append([]byte(nil), c.head...), korLines(c.tail, 2000)...)
		if c.gz {
			data = gzipBytes(data)
		}
		rows, _, prog := run(t, e, data, "", []Rule{{Kind: "text", Pattern: "오류"}}, 0, 0)
		if prog.Encoding != c.want {
			t.Errorf("%s: encoding %s want %s", c.name, prog.Encoding, c.want)
			continue
		}
		if n := len(lineNos(rows)); c.hitsOK == nil && n != 2000 {
			t.Errorf("%s: %d hits want 2000", c.name, n)
		}
	}
}

// ---- cancel inside a very long line ---------------------------------------------

// A line longer than GiantMax is judged piece by piece; cancel must not wait
// for the end of the line — neither in the DFA pieces nor in the stdlib's
// MatchReader fallback.
func TestCancelGiantLine(t *testing.T) {
	size := 300 << 20
	// 64KB of random text repeated: no line break, nothing the rules find
	rng := rand.New(rand.NewSource(3))
	block := make([]byte, 64<<10)
	for i := range block {
		block[i] = "abcxyz0123456789 ."[rng.Intn(18)]
	}
	p := filepath.Join(t.TempDir(), "giant.log")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	for w := 0; w < size; w += len(block) {
		if _, err := f.Write(block); err != nil {
			t.Fatal(err)
		}
	}
	f.WriteString("\nlast ERROR line\n")
	f.Close()

	var dfaRules []Rule
	for i := 0; i < 40; i++ {
		dfaRules = append(dfaRules, Rule{Regex: true, Pattern: fmt.Sprintf(`Q%02d[a-z]+`, i), CaseSensitive: true})
	}
	cases := []struct {
		name  string
		rules []Rule
		k     knobs
		o     Options
	}{
		{"dfa pieces", dfaRules, knobs{litPassLimit, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1}, Options{}},
		{"stdlib reader", []Rule{{Regex: true, Pattern: `a.{0,25}[0-9]{2}Q`, CaseSensitive: true}},
			knobs{litPassLimit, groupSize, 600, GiantMax, decodeChunkSizes, decodeChunk1}, Options{DFAMemory: 1}},
	}
	for _, c := range cases {
		restore := setKnobs(c.k)
		e := newTestEngine(t, c.o)
		res, err := e.Start(Request{Path: p, Rules: c.rules})
		if err != nil {
			restore()
			t.Fatal(err)
		}
		time.Sleep(400 * time.Millisecond)
		st, _ := e.Status(res.JobID)
		if st.Done {
			restore()
			t.Fatalf("%s: finished before the cancel (%d ms): the test does not reach the long-line path", c.name, st.ElapsedMs)
		}
		t0 := time.Now()
		e.Cancel(res.JobID)
		prog, _ := e.Wait(res.JobID)
		d := time.Since(t0)
		restore()
		if !prog.Canceled || !prog.Done {
			t.Fatalf("%s: %+v", c.name, prog)
		}
		t.Logf("%s: cancel took %v", c.name, d)
		if d > 500*time.Millisecond {
			t.Errorf("%s: cancel took %v (want ≤ 0.5s)", c.name, d)
		}
	}
}
