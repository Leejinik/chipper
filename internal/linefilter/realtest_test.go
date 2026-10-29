package linefilter

import (
	"bytes"
	"os"
	"testing"
)

// Each chip set of a .gz (or CP949 / UTF-16) log is its own scan with its own
// temp UTF-8 copy, and finished scans stay cached. When the temp volume is
// short, the copies of cached scans nobody looks at give way before the new
// scan fails for disk space (agy review 10-28).
func TestDiskShortFreesIdleTempCopies(t *testing.T) {
	data := gzipBytes(bytes.Repeat([]byte("10-28 00:00:01 ERROR x commonConnection\n10-28 00:00:02 ERROR y\n"), 20000))
	plain := int64(20000 * (len("10-28 00:00:01 ERROR x commonConnection\n") + len("10-28 00:00:02 ERROR y\n")))
	dir := t.TempDir()
	// free = room for one copy (+ margin), less what copies in dir already take
	base := uint64(diskMargin + plain*3/2)
	e := newTestEngine(t, Options{TempDir: dir, DiskFree: func(string) (uint64, error) {
		var used int64
		ents, _ := os.ReadDir(dir)
		for _, x := range ents {
			if fi, err := x.Info(); err == nil {
				used += fi.Size()
			}
		}
		if uint64(used) >= base {
			return 0, nil
		}
		return base - uint64(used), nil
	}})
	p := writeTemp(t, data)
	rules := []Rule{{Kind: "text", Pattern: "ERROR"}}
	start := func(ex []Rule) Progress {
		res, err := e.Start(Request{Path: p, Rules: rules, Exclude: ex})
		if err != nil {
			t.Fatal(err)
		}
		prog, err := e.Wait(res.JobID)
		if err != nil {
			t.Fatal(err)
		}
		e.Close(res.JobID) // the view goes (chip switched): the scan stays cached
		return prog
	}
	a := start(nil)
	if a.Error != "" || a.Hits != 40000 {
		t.Fatalf("first scan: %+v", a)
	}
	b := start([]Rule{{Kind: "text", Pattern: "commonConnection"}})
	if b.Error != "" {
		t.Fatalf("second chip set failed instead of freeing the idle copy: %q", b.Error)
	}
	if b.Hits != 20000 || b.Excluded != 20000 {
		t.Fatalf("second scan: hits %d excluded %d", b.Hits, b.Excluded)
	}
}
