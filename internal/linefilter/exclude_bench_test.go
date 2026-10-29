package linefilter

// 「🚫 제외」 cost on a synthetic log (skipped without LF_EXBENCH):
//
//	LF_EXBENCH=<file to create or reuse> [LF_EXBENCH_MB=726] [LF_EXBENCH_RUNS=5] \
//	  go test -run TestExcludeBench -count=1 -v ./internal/linefilter
//
// The file mixes three kinds of lines (2/3 of them plain INFO lines):
// 「abc」 or 「def」 in 30% of the lines (dense hits), and of those 80% also
// hold 「commonConnection」; 「rarehit」 in 0.2% (sparse hits). Every
// configuration runs LF_EXBENCH_RUNS times on a fresh engine (no cache) and
// prints the median and the max. Then the toggle times: switching a chip off
// (the scan without it is cached) and on again, adding a new one (a new scan).

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

func exBenchFile(t *testing.T, path string, mb int) {
	if st, err := os.Stat(path); err == nil && st.Size() >= int64(mb)<<20 {
		return
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriterSize(f, 4<<20)
	rng := rand.New(rand.NewSource(1))
	var n int64
	for line := 0; n < int64(mb)<<20; line++ {
		ts := fmt.Sprintf("2026-10-28 10:%02d:%02d.%03d", line/60000%60, line/1000%60, line%1000)
		var s string
		switch r := rng.Intn(1000); {
		case r < 2:
			s = fmt.Sprintf("%s ERROR [worker-%d] rarehit while committing offset %d", ts, rng.Intn(64), rng.Int63())
		case r < 300:
			key := "abc"
			if r%2 == 0 {
				key = "def"
			}
			if rng.Intn(10) < 8 {
				s = fmt.Sprintf("%s INFO  [pool-%d] %s commonConnection keepalive id=%d peer=10.0.%d.%d:9092", ts, rng.Intn(32), key, rng.Int63(), rng.Intn(255), rng.Intn(255))
			} else {
				s = fmt.Sprintf("%s WARN  [pool-%d] %s request took %dms (slow) topic=liz.checkvalue", ts, rng.Intn(32), key, rng.Intn(9000))
			}
		default:
			s = fmt.Sprintf("%s INFO  [collector-%d] polled %d points from device %d in %dms", ts, rng.Intn(16), rng.Intn(5000), rng.Intn(100000), rng.Intn(300))
		}
		k, _ := w.WriteString(s + "\n")
		n += int64(k)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

type exBenchResult struct {
	med, max   time.Duration
	hits, excl int64
	trunc      bool
	scanned    int64
}

func exBenchRun(t *testing.T, opt Options, path string, rules, exclude []Rule, runs int) exBenchResult {
	var ds []time.Duration
	var last Progress
	for i := 0; i < runs; i++ {
		e := New(opt)
		t0 := time.Now()
		res, err := e.Start(Request{Path: path, Rules: rules, Exclude: exclude})
		if err != nil {
			t.Fatal(err)
		}
		last, _ = e.Wait(res.JobID)
		ds = append(ds, time.Since(t0))
		if last.Error != "" {
			t.Fatal(last.Error)
		}
		e.CloseAll(5 * time.Second)
	}
	sort.Slice(ds, func(a, b int) bool { return ds[a] < ds[b] })
	return exBenchResult{med: ds[len(ds)/2], max: ds[len(ds)-1], hits: last.Hits, excl: last.Excluded, trunc: last.Truncated, scanned: last.ScannedBytes}
}

func TestExcludeBench(t *testing.T) {
	path := os.Getenv("LF_EXBENCH")
	if path == "" {
		t.Skip("LF_EXBENCH not set")
	}
	mb := 726
	if s := os.Getenv("LF_EXBENCH_MB"); s != "" {
		mb, _ = strconv.Atoi(s)
	}
	runs := 5
	if s := os.Getenv("LF_EXBENCH_RUNS"); s != "" {
		runs, _ = strconv.Atoi(s)
	}
	exBenchFile(t, path, mb)
	st, _ := os.Stat(path)
	t.Logf("file %s %.0fMB", path, float64(st.Size())/(1<<20))
	txt := func(p string, cs bool) Rule { return Rule{Kind: "text", Pattern: p, CaseSensitive: cs} }
	dense := []Rule{txt("abc", true), txt("def", true)}
	sparse := []Rule{txt("rarehit", false)}
	ex1 := []Rule{txt("commonConnection", false)}
	ex5 := []Rule{txt("commonConnection", false), txt("no-such-text", false), txt("worker-63", true), {Kind: "regex", Pattern: `took 9\d{3}ms`}, txt("pool-7]", true)}
	cases := []struct {
		name  string
		rules []Rule
		capOK bool // default caps (20만 hits)
	}{
		{"dense hits, default cap", dense, true},
		{"dense hits, no cap (every hit checked)", dense, false},
		{"sparse hits", sparse, true},
	}
	exs := []struct {
		n  string
		rs []Rule
	}{{"제외 0", nil}, {"제외 1", ex1}, {"제외 5", ex5}}
	// warm the OS file cache, then interleave the configurations (round k
	// runs every one once) so a slow moment hits all of them alike
	exBenchRun(t, Options{TempDir: t.TempDir(), WatchEvery: -1, MaxRows: 1 << 30}, path, sparse, nil, 2)
	all := map[string][]exBenchResult{}
	for k := 0; k < runs; k++ {
		for _, c := range cases {
			opt := Options{TempDir: t.TempDir(), WatchEvery: -1}
			if !c.capOK {
				opt.MaxRows = 1 << 30
			}
			for _, ex := range exs {
				id := c.name + " | " + ex.n
				all[id] = append(all[id], exBenchRun(t, opt, path, c.rules, ex.rs, 1))
			}
		}
	}
	for _, c := range cases {
		for _, ex := range exs {
			rs := all[c.name+" | "+ex.n]
			sort.Slice(rs, func(a, b int) bool { return rs[a].med < rs[b].med })
			r := rs[len(rs)/2]
			fmt.Printf("EXBENCH | %s | %s | min %.3f | med %.3f | max %.3f | hits %d | excluded %d | truncated %v | scanned %.0f%%\n",
				c.name, ex.n, rs[0].med.Seconds(), r.med.Seconds(), rs[len(rs)-1].med.Seconds(), r.hits, r.excl, r.trunc, 100*float64(r.scanned)/float64(st.Size()))
		}
	}
	// Toggle response on one engine, as the view does it (the old view is
	// closed, then the new request starts — a finished scan stays cached):
	// time to the first page of rows / to the end of the scan.
	for _, c := range []struct {
		name  string
		rules []Rule
	}{{"dense", dense}, {"sparse", sparse}} {
		e := New(Options{TempDir: t.TempDir(), WatchEvery: -1})
		prev := ""
		step := func(ex []Rule) (time.Duration, time.Duration, bool) {
			if prev != "" {
				e.Close(prev)
			}
			t0 := time.Now()
			res, err := e.Start(Request{Path: path, Rules: c.rules, Exclude: ex})
			if err != nil {
				t.Fatal(err)
			}
			prev = res.JobID
			for {
				pg, err := e.Rows(res.JobID, 0, 3, 0, 500)
				if err != nil {
					t.Fatal(err)
				}
				if len(pg.Rows) >= 500 || pg.End {
					break
				}
				time.Sleep(time.Millisecond)
			}
			d := time.Since(t0)
			e.Wait(res.JobID)
			return d, time.Since(t0), res.Cached
		}
		step(nil) // the view as opened
		for i := 0; i < 3; i++ {
			on1, on1d, c1 := step(ex1)     // add 「commonConnection」 (a new scan; cached from round 2)
			off, offd, c2 := step(nil)     // chip off: the scan without it is cached
			on2, on2d, c3 := step(ex1)     // chip on again: cached
			add, addd, c4 := step(ex5[:3]) // more chips (a new set: a new scan in round 1)
			fmt.Printf("EXTOGGLE | %s | round %d | on %.0f/%.0fms (cached %v) | off %.0f/%.0fms (cached %v) | on again %.0f/%.0fms (cached %v) | +chips %.0f/%.0fms (cached %v)\n",
				c.name, i+1, ms(on1), ms(on1d), c1, ms(off), ms(offd), c2, ms(on2), ms(on2d), c3, ms(add), ms(addd), c4)
		}
		e.CloseAll(5 * time.Second)
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
