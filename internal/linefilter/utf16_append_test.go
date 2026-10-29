package linefilter

import (
	"math/rand"
	"os"
	"testing"
	"time"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
)

// A UTF-16 file read while a character is half written (the file ends at an
// odd byte), then the rest appended: the temp copy is decoded again from the
// restart point, and what the first decode wrote past the new end (the half
// character's U+FFFD is 3 bytes, the finished character often fewer) must not
// stay there as a tail of garbage (10-29: TestAllRandomAgainstReference seed
// 1793243054535078600 — the last empty line showed 「��」).

// TestAllRandomSeedUTF16OddAppend: the random run that found it, kept.
func TestAllRandomSeedUTF16OddAppend(t *testing.T) {
	t.Setenv("LF_SEED", "1793243054535078600")
	TestAllRandomAgainstReference(t)
}

// appendAt starts a job on data[:split] (all mode, or 「🏷 줄만」 with rules),
// appends the rest and waits for it.
func appendAt(t *testing.T, data []byte, split int, enc string, rules []Rule, all bool) (*Engine, string, Progress) {
	t.Helper()
	e := New(Options{Workers: 2, TempDir: t.TempDir(), WatchEvery: -1})
	p := writeTemp(t, data[:split])
	req := Request{Path: p, Encoding: enc, Rules: rules}
	if all {
		req.Mode = ModeAll
	}
	res, err := e.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Wait(res.JobID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write(data[split:])
	f.Close()
	v, _ := e.view(res.JobID)
	v.j.checkFile(true)
	prog, err := e.Wait(res.JobID)
	if err != nil {
		t.Fatal(err)
	}
	return e, res.JobID, prog
}

func TestUTF16OddAppend(t *testing.T) {
	type variant struct {
		name, enc string
		data      []byte
	}
	var vs []variant
	docs := []string{
		"aa\r\nbb\r\n",              // ends with a newline: the last (empty) line
		"aa\r\nbb",                  // ends inside a line
		"Rebalance \r\nσοφία é\r\n", // wider characters
	}
	encs := []struct {
		name string
		enc  string
		e    unicode.Endianness
		bom  unicode.BOMPolicy
	}{
		{"be-bom", "", unicode.BigEndian, unicode.UseBOM},
		{"le-bom", "", unicode.LittleEndian, unicode.UseBOM},
		{"le", EncUTF16LE, unicode.LittleEndian, unicode.IgnoreBOM},
		{"be", EncUTF16BE, unicode.BigEndian, unicode.IgnoreBOM},
	}
	for _, d := range docs {
		for _, en := range encs {
			b, _ := unicode.UTF16(en.e, en.bom).NewEncoder().Bytes([]byte(d))
			vs = append(vs, variant{d + " " + en.name, en.enc, b})
		}
	}
	// CP949 too (a lead byte alone decodes to U+FFFD as well)
	for _, d := range []string{"aa\r\n한글\r\n", "aa\r\nb한"} {
		b, _ := korean.EUCKR.NewEncoder().Bytes([]byte(d))
		vs = append(vs, variant{d + " cp949", EncCP949, b})
	}
	rules := []Rule{{ID: "b", Kind: "text", Pattern: "b", On: on(true), Filter: on(true)}, {ID: "a", Kind: "text", Pattern: "a", On: on(true), Filter: on(true)}}
	rng := rand.New(rand.NewSource(1))
	for _, v := range vs {
		for split := 1; split < len(v.data); split++ {
			for _, all := range []bool{true, false} {
				e, id, prog := appendAt(t, v.data, split, v.enc, rules, all)
				text := refDecode(v.data, prog.Encoding)
				var want []Row
				if all {
					want, _ = refAll(text, nil, 1<<20)
				} else {
					want, _ = refFilter(text, rules, refOpts{maxRows: 1 << 30, maxDisplay: 1 << 20})
				}
				got, _ := collect(t, e, id, 0, 0, rng)
				if !t.Failed() {
					func() {
						defer func() {
							if t.Failed() {
								t.Logf("doc %q split %d all %v", v.name, split, all)
							}
						}()
						diffRows(t, got, want, nil)
					}()
				}
				e.Close(id)
			}
		}
	}
}
