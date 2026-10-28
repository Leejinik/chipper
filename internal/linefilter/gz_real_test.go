package linefilter

import (
	"compress/gzip"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// TestGzipMatchesPlainReal: every .gz in LF_GZDIR gives the same rows as its
// decompressed copy (real files; skipped without LF_GZDIR).
func TestGzipMatchesPlainReal(t *testing.T) {
	dir := os.Getenv("LF_GZDIR")
	if dir == "" {
		t.Skip()
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.gz"))
	e := newTestEngine(t, Options{})
	for _, gzp := range files {
		f, _ := os.Open(gzp)
		zr, _ := gzip.NewReader(f)
		plain, _ := io.ReadAll(zr)
		f.Close()
		pp := writeTemp(t, plain)
		for _, set := range []string{"default6", "filter3", "worst30"} {
			rules := benchSet(set)
			t0 := time.Now()
			r1, _ := e.Start(Request{Path: gzp, Rules: rules})
			p1, _ := e.Wait(r1.JobID)
			d1 := time.Since(t0)
			r2, _ := e.Start(Request{Path: pp, Rules: rules})
			p2, _ := e.Wait(r2.JobID)
			a, _ := collect(t, e, r1.JobID, 2, 2, rand.New(rand.NewSource(1)))
			b, _ := collect(t, e, r2.JobID, 2, 2, rand.New(rand.NewSource(1)))
			if !reflect.DeepEqual(a, b) || p1.Hits != p2.Hits || p1.TotalLines != p2.TotalLines || p1.Error != "" {
				t.Errorf("%s %s: gz %d hits %d lines (%s) vs plain %d/%d", filepath.Base(gzp), set, p1.Hits, p1.TotalLines, p1.Error, p2.Hits, p2.TotalLines)
			}
			t.Logf("%s %s: %d/%d bytes, hits %d, lines %d, enc %s, %.3fs", filepath.Base(gzp), set, p1.TotalBytes, len(plain), p1.Hits, p1.TotalLines, p1.Encoding, d1.Seconds())
			e.Close(r1.JobID)
			e.Close(r2.JobID)
		}
	}
}
