package linefilter

// Real-file measurements (skipped without LF_FILE). One configuration per
// process so the peak working set belongs to it:
//
//	LF_FILE=<path> LF_SET=default6|filter3|text1|worst30|explode30|rare30|ci10 [LF_ENC=cp949] [LF_N=20] \
//	  go test -run TestBench -count=1 -v ./internal/linefilter
//
// Prints one "BENCH" line: first run (fresh process, OS file cache warm),
// median/max of 3 more runs, time to the first row, whether the scan covered
// the whole file or stopped at the hit cap, N change and memory peaks.
// LF_GEN=cp949|utf16|longline LF_OUT=<path> TestGenBenchFile writes test files.

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"runtime"
	"runtime/metrics"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

func benchSet(set string) []Rule {
	re := func(p string, cs bool) Rule { return Rule{Kind: "regex", Pattern: p, CaseSensitive: cs} }
	d := defaultLogRulesV1() // the stage-1 measurements' rule set
	switch set {
	case "default8": // revision 2 (stage 6)
		return defaultLogRules()
	case "filter4": // revision 2's 「줄만」 defaults: error, fail, warn, mk119
		v := defaultLogRules()
		return []Rule{v[0], v[2], v[3], v[7]}
	case "default6":
		return d
	case "filter3": // the "줄만 보기에 씀" defaults: error, warning, failure signals
		return []Rule{d[0], d[1], d[5]}
	case "text1":
		return []Rule{{Kind: "text", Pattern: "ERROR", CaseSensitive: true}}
	case "ci10":
		var rs []Rule
		for _, p := range []string{"rebalance", "exception", "timeout", "refused", "deadlock", "rollback", "partition", "leader", "offset", "commit"} {
			rs = append(rs, Rule{Kind: "text", Pattern: p})
		}
		return rs
	case "worst30":
		rs := []Rule{d[0], d[1], d[5],
			re(`(timeout|timed out|time-out|deadline exceeded)`, false),
			re(`(connection|conn)\s*(refused|reset|closed|lost|aborted)`, false),
			re(`\b(OOM|out of memory|memory limit|GC overhead)\b`, false),
			re(`(kafka|zookeeper|redis|clickhouse|mariadb|galera).{0,40}(down|fail|error|lost)`, false),
			re(`\b\d{1,3}(\.\d{1,3}){3}:\d{2,5}\b`, true),
			re(`(user|uid|account)[=: ]+\w+`, false),
			re(`\b(deadlock|lock wait|rollback)\b`, false),
			re(`(retry|retrying|reconnect)\w*`, false),
			re(`\b[A-Z][a-z]+(Exception|Error)\b`, false),
		}
		for _, p := range []string{"rebalance", "exception", "timeout", "refused", "deadlock", "rollback", "partition", "leader"} {
			rs = append(rs, Rule{Kind: "text", Pattern: p})
		}
		for _, p := range []string{`(session|query|thread)\s*(id)?[=:#]\s*[0-9a-f-]{8,}`, `(GET|POST|PUT|DELETE)\s+/\S+`, `(disk|space|quota).{0,20}(full|exceed|low)`, `(slow|long).{0,10}(query|request)`, `5\d\d`, `(denied|forbidden|unauthori[sz]ed)`, `(shutdown|stopping|terminat)\w*`, `(replica|replication|sync).{0,30}(lag|behind|fail)`, `\[\s*\d+\s*\]\s*\{[^}]*\}\s*<(Error|Warning)>`, `checkpoint.{0,30}(fail|timeout)`} {
			rs = append(rs, re(p, false))
		}
		return rs
	case "rare30":
		rs := []Rule{d[0], d[1], d[5]}
		words := []string{"kafka", "zookeeper", "redis", "galera", "wsrep", "replica", "checkpoint", "snapshot", "quorum", "election", "fencing", "split", "brain", "lease", "heartbeat", "watchdog", "oom", "killer", "segfault", "core", "dump", "abort", "panic", "stack", "overflow", "corrupt", "checksum", "mismatch", "torn", "page"}
		for i := 0; i < 27; i++ {
			a, b := words[i%len(words)], words[(i*7+3)%len(words)]
			rs = append(rs, re(`(`+a+`|`+b+`x)[^;]{0,30}(fail|lost|timeout|refused)`, false))
		}
		return rs
	case "explode30":
		var rs []Rule
		for _, w := range strings.Split("abcdefghijklmnopqrstuvwxyz0123", "") {
			rs = append(rs, re(w+`.{0,25}[0-9]{2}[^0-9]`, false))
		}
		return rs
	case "kor":
		return []Rule{d[0], d[1], d[5], {Kind: "text", Pattern: "연결 실패", CaseSensitive: true}}
	}
	return nil
}

func TestBench(t *testing.T) {
	path := os.Getenv("LF_FILE")
	if path == "" {
		t.Skip("LF_FILE not set")
	}
	set := os.Getenv("LF_SET")
	rules := benchSet(set)
	if rules == nil {
		t.Fatalf("LF_SET %q", set)
	}
	enc := os.Getenv("LF_ENC")
	nCtx := 5
	if s := os.Getenv("LF_N"); s != "" {
		nCtx, _ = strconv.Atoi(s)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	var peakHeap atomic.Uint64
	stop := make(chan struct{})
	go func() {
		// runtime/metrics does not stop the world (ReadMemStats every few ms
		// would slow the 16 scanners down noticeably).
		sm := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}, {Name: "/memory/classes/heap/unused:bytes"}}
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			metrics.Read(sm)
			if h := sm[0].Value.Uint64() + sm[1].Value.Uint64(); h > peakHeap.Load() {
				peakHeap.Store(h)
			}
		}
	}()
	maxRows, _ := strconv.Atoi(os.Getenv("LF_MAXROWS")) // e.g. 100000000: no cap, the whole file is scanned
	e := New(Options{TempDir: t.TempDir(), WatchEvery: -1, MaxRows: maxRows})
	defer e.CloseAll(5 * time.Second)
	type res struct {
		total, first time.Duration
		p            Progress
		id           string
	}
	var prev string
	one := func() res {
		if prev != "" {
			e.Close(prev)
			e.mu.Lock()
			for j := range e.jobs {
				e.dropLocked(j) // really rescan
			}
			e.mu.Unlock()
			e.drops.Wait()
			runtime.GC()
		}
		t0 := time.Now()
		r, err := e.Start(Request{Path: path, Encoding: enc, Rules: rules})
		if err != nil {
			t.Fatal(err)
		}
		var first time.Duration
		for {
			pg, err := e.Rows(r.JobID, 0, 3, 0, 1000)
			if err != nil {
				t.Fatal(err)
			}
			if len(pg.Rows) > 0 && (pg.Rows[0].Hit || len(pg.Rows) > 1) {
				first = time.Since(t0)
				break
			}
			if pg.End {
				first = time.Since(t0)
				break
			}
			time.Sleep(200 * time.Microsecond)
		}
		p, _ := e.Wait(r.JobID)
		prev = r.JobID
		return res{time.Since(t0), first, p, r.JobID}
	}
	var runs []res
	for i := 0; i < 4; i++ {
		runs = append(runs, one())
	}
	warm := runs[1:]
	last := warm[len(warm)-1]
	if last.p.Error != "" {
		t.Fatal(last.p.Error)
	}
	// N change: first page of 2000 rows, then every row
	t0 := time.Now()
	if _, err := e.Rows(last.id, nCtx, nCtx, 0, 2000); err != nil {
		t.Fatal(err)
	}
	nFirst := time.Since(t0)
	t0 = time.Now()
	nrows := 0
	for from := 0; ; {
		pg, err := e.Rows(last.id, nCtx+1, nCtx+1, from, 5000)
		if err != nil {
			t.Fatal(err)
		}
		nrows += len(pg.Rows)
		from += len(pg.Rows)
		if pg.End {
			break
		}
	}
	nAll := time.Since(t0)
	close(stop)
	ws, _ := peakWorkingSet()
	med := func(f func(res) time.Duration) (time.Duration, time.Duration) {
		var x []time.Duration
		for _, r := range warm {
			x = append(x, f(r))
		}
		sort.Slice(x, func(i, j int) bool { return x[i] < x[j] })
		return x[1], x[2]
	}
	tm, tx := med(func(r res) time.Duration { return r.total })
	fm, fx := med(func(r res) time.Duration { return r.first })
	s := func(d time.Duration) string { return fmt.Sprintf("%.3f", d.Seconds()) }
	scope := "full"
	if last.p.Truncated {
		scope = fmt.Sprintf("cap@line%d(%.0f%%)", last.p.ScannedLines, 100*float64(last.p.ScannedBytes)/float64(last.p.TotalBytes))
	}
	if os.Getenv("LF_RUNS") != "" {
		for i, r := range runs {
			t.Logf("run %d: total %s first %s", i, s(r.total), s(r.first))
		}
	}
	t.Logf("BENCH file=%dMB set=%s enc=%s gz=%v | scope=%s | first-run %s | warm med %s max %s | first-row med %s max %s | hits=%d lines=%d | N=%d first2000 %s all %s (%d rows) | heap %dMB ws %dMB | inv=%d",
		st.Size()>>20, set, last.p.Encoding, last.p.Compressed != "", scope, s(runs[0].total), s(tm), s(tx), s(fm), s(fx),
		last.p.Hits, last.p.ScannedLines, nCtx, s(nFirst), s(nAll), nrows, peakHeap.Load()>>20, ws>>20, last.p.InvalidBytes)
}

// TestGenBenchFile writes the generated measurement files (the reviewer's
// generator): ~400MB of Korean log text as CP949 or UTF-16LE, or 300MB with
// 1–5MB JSON lines.
func TestGenBenchFile(t *testing.T) {
	kind, out := os.Getenv("LF_GEN"), os.Getenv("LF_OUT")
	if kind == "" {
		t.Skip()
	}
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var w *bufio.Writer
	switch kind {
	case "cp949":
		w = bufio.NewWriterSize(transform.NewWriter(f, korean.EUCKR.NewEncoder()), 1<<20)
	case "utf16":
		f.Write([]byte{0xFF, 0xFE})
		w = bufio.NewWriterSize(transform.NewWriter(f, unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder()), 1<<20)
	default:
		w = bufio.NewWriterSize(f, 1<<20)
	}
	rng := rand.New(rand.NewSource(1))
	target := int64(400 << 20)
	if kind == "longline" {
		target = 300 << 20
	}
	var n int64
	i := 0
	for n < target {
		i++
		var line string
		switch {
		case kind == "longline" && i%50 == 0:
			sz := (1 + rng.Intn(5)) << 20
			var b strings.Builder
			b.WriteString(fmt.Sprintf("10-21 00:00:%02d INFO payload={", i%60))
			for b.Len() < sz {
				b.WriteString(`"k":"vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv",`)
			}
			if i%100 == 0 {
				b.WriteString(`"status":"ERROR"`)
			}
			b.WriteString("}")
			line = b.String()
		case i%97 == 0:
			line = fmt.Sprintf("2026-10-21 10:%02d:%02d ERROR 연결 실패 서버=%d 응답 없음 timeout", i%60, i%60, i)
		case i%31 == 0:
			line = fmt.Sprintf("2026-10-21 10:%02d:%02d WARN 지연 %dms 경고 발생", i%60, i%60, i%1000)
		default:
			line = fmt.Sprintf("2026-10-21 10:%02d:%02d INFO 정상 처리 완료 장비=%d 포인트=%d 값=%d", i%60, i%60, i%500, i%9000, rng.Intn(100000))
		}
		w.WriteString(line)
		w.WriteString("\r\n")
		n += int64(len(line) + 2)
	}
	w.Flush()
	t.Logf("wrote %s lines=%d utf8bytes=%d", out, i, n)
}
