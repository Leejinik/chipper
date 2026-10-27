package linefilter

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
)

// ---- reference implementation: whole file in memory, line by line ----------

// refDetect is the engine's encoding choice for a file whose head sample is the
// whole file (small test files): BOM, BOM-less UTF-16, then UTF-8 unless the
// broken bytes outnumber the valid multi-byte characters.
func refDetect(data []byte, gz bool) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		return "utf-8-bom"
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}):
		return "utf-16le"
	case bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		return "utf-16be"
	}
	if len(data) >= 4 && (gz || len(data)%2 == 0) {
		limit := len(data)
		if limit > 8000 {
			limit = 8000
		}
		var evenZero, oddZero, n int
		for i := 0; i+1 < limit; i += 2 {
			if data[i] == 0 {
				evenZero++
			}
			if data[i+1] == 0 {
				oddZero++
			}
			n++
		}
		if oddZero*10 >= n*6 && evenZero*10 < n*2 {
			return "utf-16le"
		}
		if evenZero*10 >= n*6 && oddZero*10 < n*2 {
			return "utf-16be"
		}
	}
	valid, invalid := 0, 0
	s := data
	if len(s) > sniffBytes {
		s = s[:sniffBytes]
	}
	s = s[:runeCut(s)] // a character cut at the end of the sample is not counted
	for i := 0; i < len(s); {
		if s[i] < 0x80 {
			i++
			continue
		}
		r, w := utf8.DecodeRune(s[i:])
		if r == utf8.RuneError && w == 1 {
			invalid++
		} else {
			valid++
		}
		i += w
	}
	if invalid == 0 || valid > 2*invalid {
		return "utf-8"
	}
	return "cp949"
}

// refDecode is app.go's decodeWith (UseBOM for UTF-16).
func refDecode(data []byte, enc string) string {
	switch enc {
	case "utf-8-bom":
		return string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}))
	case "cp949":
		b, _ := korean.EUCKR.NewDecoder().Bytes(data)
		return string(b)
	case "utf-16le":
		b, _ := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(data)
		return string(b)
	case "utf-16be":
		b, _ := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder().Bytes(data)
		return string(b)
	}
	return string(data)
}

var cmBreak = regexp.MustCompile(`\r\n|\r|\n`)

// refLines splits like CodeMirror: always breaks+1 lines.
func refLines(s string) []string { return cmBreak.Split(s, -1) }

func refWordOK(line string, p, q int) bool {
	return (p == 0 || !isWordByte(line[p-1])) && (q == len(line) || !isWordByte(line[q]))
}

// refMatch: does rule r colour something on line, and where does the first
// coloured match start (byte offset)?
func refMatch(r Rule, line string) (bool, int) {
	k := r.kind()
	if k != kindRegex {
		ci := !r.CaseSensitive
		if ci && !jsFoldTrivial(r.Pattern) {
			// JS canonical comparison, character by character.
			pat := []rune(r.Pattern)
			for p := 0; p < len(line); {
				q, ok := p, true
				for _, pr := range pat {
					if q >= len(line) {
						ok = false
						break
					}
					lr, w := utf8.DecodeRuneInString(line[q:])
					if jsCanon(lr) != jsCanon(pr) {
						ok = false
						break
					}
					q += w
				}
				if ok && (k == kindText || refWordOK(line, p, q)) {
					return true, p
				}
				_, w := utf8.DecodeRuneInString(line[p:])
				p += w
			}
			return false, 0
		}
		hay, pat := line, r.Pattern
		if ci {
			hay, pat = string(asciiLower([]byte(hay))), string(asciiLower([]byte(pat)))
		}
		for i := 0; i+len(pat) <= len(hay); i++ {
			if hay[i:i+len(pat)] == pat && (k == kindText || refWordOK(hay, i, i+len(pat))) {
				return true, i
			}
		}
		return false, 0
	}
	re := refRegex(r)
	p := firstNonEmpty(re, []byte(line))
	return p >= 0, p
}

var refRegexCache sync.Map

func refRegex(r Rule) *regexp.Regexp {
	key := fmt.Sprintf("%v|%s", r.CaseSensitive, r.Pattern)
	if re, ok := refRegexCache.Load(key); ok {
		return re.(*regexp.Regexp)
	}
	cr, reason := compileOne(r)
	if reason != "" {
		panic(reason)
	}
	refRegexCache.Store(key, cr.lineRe)
	return cr.lineRe
}

func refCol(line string, s int) int32 {
	return int32(len(utf16.Encode([]rune(line[:s]))))
}

func refText(raw string, maxDisplay int) (string, bool) {
	if len(raw) > maxDisplay {
		return string([]rune(string(trimPartialRune([]byte(raw[:maxDisplay]))))), true
	}
	return string([]rune(raw)), false
}

type refOpts struct {
	above, below, maxRows, maxDisplay int
	giantCol                          func(lineLen int) bool // col unknown (-1) allowed for this line
}

// refFilter returns the rows the engine must produce for decoded text.
func refFilter(text string, rules []Rule, o refOpts) ([]Row, bool) {
	lines := refLines(text)
	bad := map[int]bool{}
	for _, is := range Validate(rules) {
		bad[is.Index] = true
	}
	hitRules := make([][]int, len(lines))
	cols := make([]int32, len(lines))
	for li, ln := range lines {
		best := -1
		for ri, r := range rules {
			if bad[ri] || !r.enabled() || r.Pattern == "" {
				continue
			}
			if ok, s := refMatch(r, ln); ok {
				hitRules[li] = append(hitRules[li], ri)
				if best < 0 || s < best {
					best = s
				}
			}
		}
		cols[li] = -1
		if best >= 0 {
			cols[li] = refCol(ln, best)
		}
	}
	show := make([]bool, len(lines))
	for li := range lines {
		if hitRules[li] == nil {
			continue
		}
		for k := li - o.above; k <= li+o.below; k++ {
			if k >= 0 && k < len(lines) {
				show[k] = true
			}
		}
	}
	var rows []Row
	lineRows := 0
	gap := int64(0)
	for li, ln := range lines {
		if !show[li] {
			gap++
			continue
		}
		if lineRows == o.maxRows {
			return rows, true
		}
		if gap > 0 {
			rows = append(rows, Row{Skip: gap, From: int64(li) - gap + 1, Col: -1})
			gap = 0
		}
		t, cut := refText(ln, o.maxDisplay)
		row := Row{Line: int64(li + 1), Text: t, Hit: hitRules[li] != nil, Rules: hitRules[li], TruncatedLine: cut, Col: -1}
		if row.Hit {
			row.Col = cols[li]
		}
		rows = append(rows, row)
		lineRows++
	}
	if gap > 0 {
		rows = append(rows, Row{Skip: gap, From: int64(len(lines)) - gap + 1, Col: -1})
	}
	return rows, false
}

// ---- helpers -----------------------------------------------------------------

func writeTemp(t testing.TB, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "log.txt")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func gzipBytes(data []byte) []byte {
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	zw.Write(data)
	zw.Close()
	return b.Bytes()
}

// collect fetches every row of a finished job with random page sizes.
func collect(t testing.TB, e *Engine, id string, above, below int, rng *rand.Rand) ([]Row, Page) {
	t.Helper()
	var rows []Row
	var last Page
	for guard := 0; guard < 1_000_000; guard++ {
		n := 1 + rng.Intn(37)
		if rng.Intn(4) == 0 {
			n = 5000
		}
		p, err := e.Rows(id, above, below, len(rows), n)
		if err != nil {
			t.Fatalf("Rows: %v", err)
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

func normRows(rs []Row) []Row {
	out := make([]Row, len(rs))
	for i, r := range rs {
		if len(r.Rules) == 0 {
			r.Rules = nil
		}
		out[i] = r
	}
	return out
}

func diffRows(t testing.TB, got, want []Row, colOK func(got, want Row) bool) {
	t.Helper()
	got, want = normRows(got), normRows(want)
	n := len(got)
	if len(want) > n {
		n = len(want)
	}
	shown := 0
	for i := 0; i < n && shown < 6; i++ {
		var g, w Row
		gOK, wOK := i < len(got), i < len(want)
		if gOK {
			g = got[i]
		}
		if wOK {
			w = want[i]
		}
		same := gOK && wOK
		if same {
			gc, wc := g, w
			if colOK != nil && colOK(g, w) {
				gc.Col = wc.Col
			}
			same = reflect.DeepEqual(gc, wc)
		}
		if !same {
			t.Errorf("row %d:\n got  %+v (present %v)\n want %+v (present %v)", i, g, gOK, w, wOK)
			shown++
		}
	}
	if shown > 0 {
		t.Fatalf("rows differ (got %d, want %d)", len(got), len(want))
	}
}

func on(b bool) *bool { return &b }

// ---- random comparison against the reference ---------------------------------

var vocab = []string{
	"ERROR", "error", "Error:", "ERR", "_ERR_", "errors", "INFO", "info", "Info", "WARN", "warning",
	"rebalance", "Rebalance", "REBALANCE", "kafka rebalance", "x", "xx", "가나", "다라 가나", "12", "2026-10-21",
	"a", "b", " ", "  ", "-", "(", ")", "[Note]", "é", "É", "\t", "foo.bar", "Exception", "NullPointerException",
	"Kafka", "\u212Aafka", "ſ", "s", "S", "😀", "연결 실패",
	"Дом", "дом", "ДОМ", "ΣΟΦΙΑ", "σοφια", "Σοφιας", "Straße", "STRASSE", "ÉCOLE", "école", "Ölçü", "öLÇÜ",
}

var badBytes = []string{"\xff", "\xc3", "\xe0\x80", "\xed\xa0\x80"}

var terms = []string{"\n", "\r\n", "\r"}

func randDoc(rng *rand.Rand, invalid bool) []byte {
	var b strings.Builder
	nl := rng.Intn(60)
	mode := rng.Intn(4) // 0 LF, 1 CRLF, 2 CR, 3 mixed
	for i := 0; i < nl; i++ {
		nw := rng.Intn(8)
		if rng.Intn(15) == 0 {
			nw = 40 + rng.Intn(80) // long line
		}
		for w := 0; w < nw; w++ {
			if w > 0 && rng.Intn(3) > 0 {
				b.WriteByte(' ')
			}
			if invalid && rng.Intn(25) == 0 {
				b.WriteString(badBytes[rng.Intn(len(badBytes))])
			}
			b.WriteString(vocab[rng.Intn(len(vocab))])
		}
		if i == nl-1 && rng.Intn(2) == 0 {
			break // last line without a break
		}
		switch mode {
		case 3:
			b.WriteString(terms[rng.Intn(3)])
		default:
			b.WriteString(terms[mode])
		}
	}
	return []byte(b.String())
}

var randRules = []Rule{
	{Kind: "text", Pattern: "error"},
	{Kind: "text", Pattern: "ERR", CaseSensitive: true},
	{Kind: "word", Pattern: "info"},
	{Kind: "word", Pattern: "ERR", CaseSensitive: true},
	{Pattern: "rebalance"}, // no kind, regex=false → word
	{Kind: "text", Pattern: "kafka rebalance"},
	{Kind: "text", Pattern: "é"},                        // non-ASCII fold → JS classes
	{Kind: "word", Pattern: "é"},                        // non-ASCII fold word
	{Kind: "text", Pattern: "kafka"},                    // k folds to K only (not U+212A)
	{Kind: "text", Pattern: "дом"},                      // Cyrillic folds
	{Kind: "word", Pattern: "σοφια"},                    // Greek folds (ς/σ/Σ)
	{Kind: "text", Pattern: "école"},                    // Latin accents
	{Regex: true, Pattern: `ölçü|straße`},               // regex, non-ASCII folding
	{Kind: "text", Pattern: "ERROR", Filter: on(false)}, // not used by the filter
	{Kind: "text", Pattern: "가나", CaseSensitive: true},
	{Kind: "regex", Pattern: `\b(ERROR|WARN(ING)?)\b`},
	{Regex: true, Pattern: `^\d+`, CaseSensitive: true},
	{Regex: true, Pattern: `x$`, CaseSensitive: true},
	{Regex: true, Pattern: `[A-Z]{3}\d`, CaseSensitive: true}, // no literal: every line
	{Regex: true, Pattern: `\[Note\]|Exception\b`},
	{Regex: true, Pattern: `a\s+b`},
	{Regex: true, Pattern: `\w*Exception`},
	{Regex: true, Pattern: `(?<=x)y`}, // RE2 cannot: issue
	{Regex: true, Pattern: `foo.bar`},
	{Kind: "text", Pattern: "x", On: on(false)},
	{Regex: true, Pattern: `(a|b)`, CaseSensitive: true},
	{Regex: true, Pattern: `kafka|s\b`}, // ci k / s: JS folding
	{Regex: true, Pattern: `(ERR)?\b`},  // can match empty: exact slow path
	{Regex: true, Pattern: `\nfoo`},     // needs a line break: issue
	{Regex: true, Pattern: `.😀|[가-힣]{2}`, CaseSensitive: true},
	{Regex: true, Pattern: `\uFFFD`, CaseSensitive: true}, // the broken bytes
	{Regex: true, Pattern: `\b`},                          // only empty matches: issue
}

func encodeDoc(rng *rand.Rand, doc []byte) ([]byte, string) {
	switch rng.Intn(10) {
	case 0:
		return append([]byte{0xEF, 0xBB, 0xBF}, doc...), ""
	case 1:
		b, _ := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().Bytes(doc)
		return b, ""
	case 2:
		b, _ := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewEncoder().Bytes(doc)
		return b, ""
	case 3:
		// CP949: drop what it cannot encode
		s := strings.Map(func(r rune) rune {
			if r > 0x7f && !(r >= 0xac00 && r <= 0xd7a3) {
				return 'e'
			}
			return r
		}, string(doc))
		b, err := korean.EUCKR.NewEncoder().Bytes([]byte(s))
		if err != nil {
			return doc, ""
		}
		if rng.Intn(2) == 0 {
			return b, "cp949"
		}
		return b, ""
	case 4:
		return doc, "utf-8"
	case 5:
		b, _ := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder().Bytes(doc)
		return b, "utf-16le"
	}
	return doc, ""
}

type knobs struct {
	litPass, group, minMem, giant int
	decSizes                      []int64
	dec1                          int64
}

func setKnobs(k knobs) func() {
	old := knobs{litPassLimit, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1}
	litPassLimit, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1 = k.litPass, k.group, k.minMem, k.giant, k.decSizes, k.dec1
	return func() {
		litPassLimit, groupSize, dfaMinMem, GiantMax, decodeChunkSizes, decodeChunk1 = old.litPass, old.group, old.minMem, old.giant, old.decSizes, old.dec1
	}
}

func TestRandomAgainstReference(t *testing.T) {
	seed := time.Now().UnixNano()
	if s := os.Getenv("LF_SEED"); s != "" {
		fmt.Sscan(s, &seed)
	}
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewSource(seed))
	iters := 500
	if testing.Short() {
		iters = 100
	}
	for it := 0; it < iters; it++ {
		itStart := time.Now()
		doc := randDoc(rng, rng.Intn(3) == 0)
		data, enc := encodeDoc(rng, doc)
		var rules []Rule
		for _, r := range randRules {
			if rng.Intn(3) == 0 {
				rules = append(rules, r)
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
		restore := setKnobs(k)
		chunk := []int64{1, 3, 17, 64, 1 << 20}[rng.Intn(5)]
		bufSize := []int{8, 16, 33, 100, 1 << 16}[rng.Intn(5)]
		maxRows := []int{3, 10, 1 << 20}[rng.Intn(3)]
		maxDisplay := []int{5, 1 << 20}[rng.Intn(2)]
		above, below := rng.Intn(4), rng.Intn(4)
		gz := rng.Intn(5) == 0
		appendSplit := -1
		if !gz && maxRows > 100 && rng.Intn(4) == 0 && len(data) > 0 {
			appendSplit = rng.Intn(len(data) + 1)
		}
		e := New(Options{Workers: 1 + rng.Intn(4), Chunk: chunk, BufSize: bufSize, MaxRows: maxRows, MaxLineDisplay: maxDisplay,
			DFAMemory: 1, TempDir: t.TempDir(), WatchEvery: -1})
		fileData := data
		if gz {
			fileData = gzipBytes(data)
		}
		first := fileData
		if appendSplit >= 0 {
			first = fileData[:appendSplit]
		}
		p := writeTemp(t, first)
		res, err := e.Start(Request{Path: p, Encoding: enc, Rules: rules})
		if err != nil {
			restore()
			t.Fatal(err)
		}
		prog, _ := e.Wait(res.JobID)
		var before []Row
		if appendSplit >= 0 && prog.Error == "" {
			before, _ = collect(t, e, res.JobID, above, below, rng)
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
					t.Logf("iter %d chunk=%d buf=%d maxRows=%d disp=%d A=%d B=%d knobs=%+v enc=%q gz=%v appendAt=%d rules=%+v\ndoc=%q", it, chunk, bufSize, maxRows, maxDisplay, above, below, k, enc, gz, appendSplit, rules, data)
				}
			}()
			if prog.Error != "" {
				t.Fatalf("iter %d: %s", it, prog.Error)
			}
			wantEnc := enc
			if wantEnc == "" {
				src := data
				if appendSplit >= 0 {
					src = data[:appendSplit]
				}
				wantEnc = refDetect(src, gz)
			}
			if prog.Encoding != wantEnc && !(wantEnc == "utf-16le" && prog.Encoding == "utf-16be") && !(wantEnc == "utf-16be" && prog.Encoding == "utf-16le") {
				t.Fatalf("encoding %s want %s", prog.Encoding, wantEnc)
			}
			text := refDecode(data, prog.Encoding)
			colOK := func(g, w Row) bool { return g.Hit && g.Col == -1 && GiantMax < 1000 }
			got, last := collect(t, e, res.JobID, above, below, rng)
			want, wantTrunc := refFilter(text, rules, refOpts{above: above, below: below, maxRows: maxRows, maxDisplay: maxDisplay})
			diffRows(t, got, want, colOK)
			if (last.Truncated == "rows") != wantTrunc {
				t.Fatalf("truncated=%q want %v", last.Truncated, wantTrunc)
			}
			if appendSplit >= 0 && before != nil && prog.Version > 0 {
				// Rows before the first one touching (old tailLine - above) are unchanged.
				x := int64(-1)
				v, _ := e.view(res.JobID)
				v.j.mu.Lock()
				if len(v.j.appendLines) > 0 {
					x = v.j.appendLines[0] - int64(above)
				}
				v.j.mu.Unlock()
				for i, r := range before {
					if r.Line >= x || (r.Line == 0 && r.From+r.Skip-1 >= x) {
						break
					}
					if i >= len(got) || !reflect.DeepEqual(normRows([]Row{r}), normRows([]Row{got[i]})) {
						t.Fatalf("row %d changed by the append though it is before line %d: %+v -> %+v", i, x, r, got)
					}
				}
			}
			// Another N on the same job must not rescan and must still match.
			a2, b2 := rng.Intn(5), rng.Intn(5)
			got2, _ := collect(t, e, res.JobID, a2, b2, rng)
			want2, _ := refFilter(text, rules, refOpts{above: a2, below: b2, maxRows: maxRows, maxDisplay: maxDisplay})
			diffRows(t, got2, want2, colOK)
			if !prog.Truncated {
				lines := len(refLines(text))
				if prog.TotalLines != int64(lines) {
					t.Fatalf("TotalLines %d want %d", prog.TotalLines, lines)
				}
			}
		}()
		tc := time.Now()
		e.CloseAll(time.Second)
		if d := time.Since(itStart); d > 300*time.Millisecond && os.Getenv("LF_SLOW") != "" {
			t.Logf("slow iter %d: %v (close %v) gz=%v enc=%q knobs=%+v buf=%d chunk=%d", it, d, time.Since(tc), gz, enc, k, bufSize, chunk)
		}
		if t.Failed() {
			return
		}
	}
}
