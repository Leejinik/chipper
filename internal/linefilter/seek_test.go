package linefilter

import (
	"testing"
)

// RowOfLine agrees with the rows Rows returns: for every line of the file, the
// row it gives is the first row showing a line ≥ it (or the gap row covering it).
func TestRowOfLine(t *testing.T) {
	doc := "l1\nl2\nl3\nERROR\nl5\nl6\nl7\nl8\nl9\nERROR\nl11\nl12\nl13\nl14\nERROR\nl16"
	e := newTestEngine(t, Options{Chunk: 5, BufSize: 16})
	p := writeTemp(t, []byte(doc))
	res, err := e.Start(Request{Path: p, Rules: errRule})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait(res.JobID)
	for _, ab := range [][2]int{{0, 0}, {1, 2}, {3, 0}, {0, 3}, {10, 10}} {
		page, err := e.Rows(res.JobID, ab[0], ab[1], 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		for x := int64(1); x <= 16; x++ {
			want := len(page.Rows)
			for i, r := range page.Rows {
				if (r.Line != 0 && r.Line >= x) || (r.Line == 0 && r.From+r.Skip-1 >= x) {
					want = i
					break
				}
			}
			got, err := e.RowOfLine(res.JobID, ab[0], ab[1], x)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Errorf("above=%d below=%d line %d: row %d want %d", ab[0], ab[1], x, got, want)
			}
		}
	}
	if _, err := e.RowOfLine("nope", 0, 0, 1); err == nil {
		t.Fatal("unknown view: no error")
	}
}
