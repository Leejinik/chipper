package linefilter

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Defaults (see Options).
const (
	DefaultMaxRows        = 200_000
	DefaultMaxBytes       = 64 << 20
	DefaultMaxPageBytes   = 4 << 20
	DefaultMaxLineDisplay = 4096
	DefaultChunk          = 2 << 20
	DefaultDFAMemory      = 64 << 20
	DefaultMaxInflate     = 16 << 30
	MaxContext            = 10_000 // largest above/below accepted
	MaxPageRows           = 50_000 // largest count accepted by Rows
	// Finished jobs kept for reuse: a tab switching 📖 읽기 ↔ 🏷 줄만 comes back
	// to its other job at once (six panes × two modes). A finished job holds
	// its hits only (and a temp copy for .gz / CP949 / UTF-16, which the disk
	// check frees first when space runs short).
	defaultIdleJobs = 12
	// AllMaxHidden: lines a 「📖 읽기」 job can hide (Request.Exclude matches,
	// 40 bytes each); past it the view stops there (Truncated) like MaxRows.
	AllMaxHidden = 16_000_000
)

// ModeAll: Request.Mode of 「📖 읽기 보기」 — every line of the file is a row
// (no MaxRows / MaxBytes caps, no context), except the lines Exclude matches,
// which are hidden. The job keeps only where its regions start and the hidden
// lines; rows are read from the file around the asked page (all.go).
const ModeAll = "all"

// Options tune the engine; zero values take the defaults. Tests shrink Chunk and
// BufSize to exercise boundaries.
type Options struct {
	Workers        int   // parallel scanners and decoders (default runtime.NumCPU())
	Chunk          int64 // nominal region size
	BufSize        int   // per-worker read window; longer lines take the giant-line path
	MaxRows        int   // result line rows
	MaxBytes       int64 // result text bytes
	MaxPageBytes   int64 // text bytes in one Rows answer
	MaxLineDisplay int   // a longer line's text is cut (Row.TruncatedLine); matching sees the whole line
	DFAMemory      int   // DFA caches of one job, all workers together
	MaxInflate     int64 // largest uncompressed size of a .gz
	MaxIdleJobs    int   // finished jobs kept (unreferenced) for reuse
	TempDir        string
	OnProgress     func(Progress)
	ProgressEvery  time.Duration
	WatchEvery     time.Duration // file change polling for jobs in use (default 1s, < 0: off)
	DiskFree       func(dir string) (uint64, error)
}

// Request starts a filter job.
type Request struct {
	Path     string `json:"path"`
	Encoding string `json:"encoding,omitempty"` // "" = detect; otherwise the tab's encoding
	Rules    []Rule `json:"rules"`
	// Exclude: a line that matches a rule but also one of these is not a hit
	// (「🚫 제외」): only matched lines are checked, so the cost follows the hits,
	// not the file. Its lines still show as context of other hits. Kinds and
	// judging as for Rules (ANSI codes left out).
	Exclude []Rule `json:"exclude,omitempty"`
	// Mode "all" (ModeAll): 「📖 읽기 보기」 — every line, minus the lines an
	// Exclude rule matches (hidden). Rules are not used. "" = 「🏷 줄만」.
	Mode string `json:"mode,omitempty"`
}

// StartResult answers FilterStart.
type StartResult struct {
	JobID  string      `json:"jobId"`
	Issues []RuleIssue `json:"issues,omitempty"` // rules left out (the rest still run)
	// ExcludeIssues: exclude rules left out (Index = position in Exclude)
	ExcludeIssues []RuleIssue `json:"excludeIssues,omitempty"`
	Cached        bool        `json:"cached"` // an identical scan (same file state, rules, encoding) was reused
	Progress      Progress    `json:"progress"`
}

// Progress is the "linefilter:progress" event payload and FilterStatus result.
//
// Changed contract: a change is noticed from the file's size and modification
// time (then a fingerprint of its head and end). A rewrite that keeps both the
// size and the modification time (a tool that restores the time stamp, or a
// file system with a coarse clock rewriting within one tick) is NOT reported;
// the rows then mix old line positions with new bytes. Such a file has to be
// filtered again by the caller.
type Progress struct {
	JobID        string  `json:"jobId"`
	Phase        string  `json:"phase"`        // "scan" | "append" (filtering lines added to the file) | "done"
	ScannedBytes int64   `json:"scannedBytes"` // of TotalBytes (source file bytes; for .gz the compressed bytes)
	TotalBytes   int64   `json:"totalBytes"`
	ScannedLines int64   `json:"scannedLines"` // lines covered so far (in file order)
	Hits         int64   `json:"hits"`         // matched lines so far (excluded ones not counted); mode "all": lines shown so far
	Excluded     int64   `json:"excluded"`     // matched lines left out by Request.Exclude (same part of the file as Hits); mode "all": lines hidden
	Mode         string  `json:"mode,omitempty"`
	RuleHits     []int64 `json:"ruleHits"`     // per request rule index: matched lines
	Encoding     string  `json:"encoding"`     // encoding used ("" until known)
	Compressed   string  `json:"compressed,omitempty"`
	InvalidBytes int64   `json:"invalidBytes"` // UTF-8 files: bytes that are not UTF-8 (shown as U+FFFD)
	InvalidLine  int64   `json:"invalidLine"`  // first line holding one (0 = none)
	Done         bool    `json:"done"`
	Truncated    bool    `json:"truncated"` // stopped at MaxRows+1 matched lines; the rest of the file was not scanned
	Canceled     bool    `json:"canceled"`
	Changed      bool    `json:"changed"` // the file's content changed (not just appended): start again (limit: see above)
	Error        string  `json:"error,omitempty"`
	TotalLines   int64   `json:"totalLines"`            // lines in the file (editor count); 0 until known (done and not truncated)
	SlowRules    []int   `json:"slowRules,omitempty"`   // request rule indexes too complex for the fast matcher (state explosion): judged by the slow standard regexp
	SlowExclude  []int   `json:"slowExclude,omitempty"` // the same for Request.Exclude indexes
	Version      int     `json:"version"`               // +1 each time lines appended to the file are taken in
	TailLine     int64   `json:"tailLine"`              // the next append can change lines ≥ TailLine
	ElapsedMs    int64   `json:"elapsedMs"`
	FirstHitMs   int64   `json:"firstHitMs"` // -1 until the first hit is published
}

// Engine runs and caches filter jobs. Safe for concurrent use.
type Engine struct {
	opt   Options
	mu    sync.Mutex
	views map[string]*view
	keys  map[string]*job // cache: key → job
	jobs  map[*job]bool
	pool  chan *workBuf
	giant chan struct{}

	watchOnce sync.Once
	watchStop chan struct{}
	drops     sync.WaitGroup
	closed    bool
}

type view struct {
	id       string
	j        *job
	canceled bool
	findSeq  atomic.Int64 // the running Find (find.go); changed = stop it
}

// New creates an engine.
func New(opt Options) *Engine {
	if opt.Workers <= 0 {
		opt.Workers = runtime.NumCPU()
	}
	if opt.Chunk <= 0 {
		opt.Chunk = DefaultChunk
	}
	if opt.BufSize <= 0 {
		opt.BufSize = int(opt.Chunk) + int(opt.Chunk)/8
	}
	if opt.MaxRows <= 0 {
		opt.MaxRows = DefaultMaxRows
	}
	if opt.MaxBytes <= 0 {
		opt.MaxBytes = DefaultMaxBytes
	}
	if opt.MaxPageBytes <= 0 {
		opt.MaxPageBytes = DefaultMaxPageBytes
	}
	if opt.MaxLineDisplay <= 0 {
		opt.MaxLineDisplay = DefaultMaxLineDisplay
	}
	if opt.DFAMemory <= 0 {
		opt.DFAMemory = DefaultDFAMemory
	}
	if opt.MaxInflate <= 0 {
		opt.MaxInflate = DefaultMaxInflate
	}
	if opt.MaxIdleJobs <= 0 {
		opt.MaxIdleJobs = defaultIdleJobs
	}
	if opt.ProgressEvery <= 0 {
		opt.ProgressEvery = 100 * time.Millisecond
	}
	if opt.WatchEvery == 0 {
		opt.WatchEvery = time.Second
	}
	if opt.TempDir == "" {
		opt.TempDir = filepath.Join(os.TempDir(), "chipper-linefilter", strconv.Itoa(os.Getpid()))
	}
	e := &Engine{opt: opt, views: map[string]*view{}, keys: map[string]*job{}, jobs: map[*job]bool{},
		pool: make(chan *workBuf, opt.Workers), giant: make(chan struct{}, 1), watchStop: make(chan struct{})}
	for i := 0; i < opt.Workers; i++ {
		e.pool <- nil // buffers are allocated on first use
	}
	return e
}

func (e *Engine) diskFree(dir string) (uint64, error) {
	if e.opt.DiskFree != nil {
		return e.opt.DiskFree(dir)
	}
	return diskFree(dir)
}

// CleanStaleTemp removes temp copies left by earlier runs: folders of processes
// that are gone, and any other folder untouched for a day.
func CleanStaleTemp() {
	root := filepath.Join(os.TempDir(), "chipper-linefilter")
	ents, err := os.ReadDir(root)
	if err != nil {
		return
	}
	self := strconv.Itoa(os.Getpid())
	for _, en := range ents {
		if en.Name() == self {
			continue
		}
		pid, err := strconv.Atoi(en.Name())
		dead := err != nil || !processAlive(pid)
		if info, err := en.Info(); err == nil && (dead || time.Since(info.ModTime()) > 24*time.Hour) {
			os.RemoveAll(filepath.Join(root, en.Name()))
		}
	}
}

type fileState struct {
	size  int64
	mtime int64
}

func statFile(p string) (fileState, error) {
	info, err := os.Stat(p)
	if err != nil {
		return fileState{}, err
	}
	if info.IsDir() {
		return fileState{}, fmt.Errorf("폴더는 거를 수 없습니다")
	}
	return fileState{info.Size(), info.ModTime().UnixNano()}, nil
}

// fingerprint identifies a file's content: the head and the bytes before its
// end. An append keeps both (the old end is checked at the old size).
type fingerprint struct {
	size       int64
	head, tail uint64
}

const fpHead, fpTail = 64 << 10, 4 << 10

func hashRange(f *os.File, off, n int64) (uint64, error) {
	b := make([]byte, n)
	if n > 0 {
		if k, err := f.ReadAt(b, off); int64(k) < n {
			if err == nil {
				err = io.ErrUnexpectedEOF
			}
			return 0, err
		}
	}
	h := fnv.New64a()
	h.Write(b)
	return h.Sum64(), nil
}

// takeFingerprint of the first size bytes of path.
func takeFingerprint(path string, size int64) (fingerprint, error) {
	f, err := os.Open(path)
	if err != nil {
		return fingerprint{}, err
	}
	defer f.Close()
	fp := fingerprint{size: size}
	hn := int64(fpHead)
	if size < hn {
		hn = size
	}
	if fp.head, err = hashRange(f, 0, hn); err != nil {
		return fp, err
	}
	tn := int64(fpTail)
	if size < tn {
		tn = size
	}
	fp.tail, err = hashRange(f, size-tn, tn)
	return fp, err
}

type restartPoint struct {
	ok   bool
	src  int64 // source offset of the first byte to rescan
	tmp  int64 // the same place in the scanned file
	line int64 // its line number
}

type job struct {
	e        *Engine
	id       string
	key      string
	path     string
	reqEnc   string
	m        *matcher
	ex       *matcher // Request.Exclude (nil: none)
	issues   []RuleIssue
	exIssues []RuleIssue
	nRules   int
	started  time.Time
	stop     atomic.Bool
	content  sync.RWMutex // readers vs. rewriting the temp copy's tail (append)

	mu           sync.Mutex
	cond         *sync.Cond
	views        map[string]bool
	refs, active int
	state        fileState
	fp           fingerprint
	gz           bool
	enc          string
	readPath     string
	tempFile     string
	dataStart    int64
	size         int64 // readable bytes of readPath
	srcDone      int64
	commits      []commit
	nlTmp, nlSrc int64
	runSrcFrom   int64
	sr           *scanRun
	phase        string
	scannedOff   int64
	scannedLines int64
	hits         []hit
	ext          []uint64 // arena of hits' rules past the 64th (hit.ext); append only, replaced when cut
	ruleHits     []int64
	excluded     int64 // matched lines left out by ex (in the published part)
	longs        []longLine
	invalid      int64
	invalidLine  int64
	invalidTail  int64
	done         bool
	following    bool
	truncated    bool
	canceled     bool
	changed      bool
	closed       bool
	err          error
	totalLines   int64
	restart      restartPoint
	version      int
	appendLines  []int64 // appendLines[v]: first line the append that made version v+1 could change
	firstHit     time.Duration
	elapsed      time.Duration
	lastEmit     time.Time
	evPending    *Progress
	evSignal     chan struct{}
	evClosed     bool
	lastUse      time.Time
	lastCheck    time.Time
	marks        map[[2]int64]*byteMarks
	lay          *layout
	layA, layB   int64
	// mode "all" (all.go): the job's rules are Request.Exclude, so hits are the
	// hidden lines. cps: the first line and offset of every published region
	// (line starts, in order); seen: line starts learned while reading rows.
	all  bool
	cps  []linePos
	seen []linePos
}

func newID() string {
	var b [8]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func normPath(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

func cacheKey(path string, st fileState, enc string, rules, exclude []Rule, mode ...string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\x00%d\x00%d\x00%s", normPath(path), st.size, st.mtime, enc)
	for _, r := range rules {
		if !r.enabled() || r.Pattern == "" {
			b.WriteString("\x00-")
			continue
		}
		fmt.Fprintf(&b, "\x00%d|%t|%s", r.kind(), r.CaseSensitive, r.Pattern)
	}
	// No exclude rule: the same key as before they existed (rekey keeps
	// everything after the encoding, these too).
	for _, r := range exclude {
		if !r.enabled() || r.Pattern == "" {
			b.WriteString("\x00x-")
			continue
		}
		fmt.Fprintf(&b, "\x00x%d|%t|%s", r.kind(), r.CaseSensitive, r.Pattern)
	}
	if len(mode) > 0 && mode[0] == ModeAll {
		b.WriteString("\x00all")
	}
	return b.String()
}

func (j *job) reusableLocked() bool {
	return !j.canceled && j.err == nil && !j.changed && !j.closed
}

// Start begins a filter job, or attaches a new view to an identical one (same
// file state, encoding and rules). Every call returns its own id. Rules with
// problems are reported in Issues and left out.
func (e *Engine) Start(req Request) (StartResult, error) {
	if req.Path == "" {
		return StartResult{}, errors.New("빈 파일 경로")
	}
	if err := checkEncodingName(req.Encoding); err != nil {
		return StartResult{}, err
	}
	all := req.Mode == ModeAll
	if req.Mode != "" && !all {
		return StartResult{}, fmt.Errorf("알 수 없는 보기: %q", req.Mode)
	}
	if all {
		// the hidden lines are the job's hits: Exclude is what it looks for
		req.Rules, req.Exclude = req.Exclude, nil
	}
	st, err := statFile(req.Path)
	if err != nil {
		return StartResult{}, err
	}
	key := cacheKey(req.Path, st, req.Encoding, req.Rules, req.Exclude, req.Mode)
	e.ensureWatcher()
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return StartResult{}, errors.New("엔진이 닫혔습니다")
	}
	if j := e.keys[key]; j != nil {
		j.mu.Lock()
		ok := j.reusableLocked()
		j.mu.Unlock()
		if ok {
			v := e.newViewLocked(j)
			e.mu.Unlock()
			return j.startResult(v.id, true), nil
		}
		delete(e.keys, key)
	}
	e.mu.Unlock()

	fp, err := takeFingerprint(req.Path, st.size)
	if err != nil {
		return StartResult{}, err
	}
	rules, issues := compileRules(req.Rules)
	exRules, exIssues := compileRules(req.Exclude)
	var ex *matcher
	if len(exRules) > 0 {
		ex = newMatcher(exRules)
	}
	j := &job{
		e: e, id: newID(), key: key, path: req.Path, reqEnc: req.Encoding, m: newMatcher(rules), ex: ex, issues: issues, exIssues: exIssues,
		nRules: len(rules), started: time.Now(), state: st, fp: fp, phase: "scan", ruleHits: make([]int64, len(req.Rules)),
		firstHit: -1, nlTmp: -1, marks: map[[2]int64]*byteMarks{}, views: map[string]bool{}, all: all,
	}
	j.cond = sync.NewCond(&j.mu)
	j.lastUse = time.Now()
	if cb := e.opt.OnProgress; cb != nil {
		j.evSignal = make(chan struct{}, 1)
		go j.deliverEvents(cb)
	}
	e.mu.Lock()
	e.jobs[j] = true
	e.keys[key] = j
	v := e.newViewLocked(j)
	e.evictIdleLocked()
	e.mu.Unlock()
	go j.run()
	return j.startResult(v.id, false), nil
}

func (j *job) startResult(id string, cached bool) StartResult {
	r := StartResult{JobID: id, Issues: j.issues, ExcludeIssues: j.exIssues, Cached: cached, Progress: j.progressFor(id)}
	if j.all {
		// the job's rules are the request's Exclude
		r.Issues, r.ExcludeIssues = nil, j.issues
	}
	return r
}

// capHits: matched lines a job keeps (MaxRows + 1 = "cut", or AllMaxHidden + 1).
func (j *job) capHits() int {
	if j.all {
		return AllMaxHidden + 1
	}
	return j.e.opt.MaxRows + 1
}

func (e *Engine) newViewLocked(j *job) *view {
	v := &view{id: newID(), j: j}
	e.views[v.id] = v
	j.mu.Lock()
	j.views[v.id] = true
	j.refs++
	j.active++
	j.lastUse = time.Now()
	j.mu.Unlock()
	return v
}

// evictIdleLocked drops unreferenced jobs beyond MaxIdleJobs, oldest first.
func (e *Engine) evictIdleLocked() {
	var idle []*job
	for j := range e.jobs {
		j.mu.Lock()
		if j.refs == 0 {
			idle = append(idle, j)
		}
		j.mu.Unlock()
	}
	if len(idle) <= e.opt.MaxIdleJobs {
		return
	}
	sort.Slice(idle, func(a, b int) bool {
		idle[a].mu.Lock()
		la := idle[a].lastUse
		idle[a].mu.Unlock()
		idle[b].mu.Lock()
		lb := idle[b].lastUse
		idle[b].mu.Unlock()
		return la.Before(lb)
	})
	for _, j := range idle[:len(idle)-e.opt.MaxIdleJobs] {
		e.dropLocked(j)
	}
}

// freeIdleTemps drops the unreferenced jobs (cached, finished) that hold a
// temp copy — all but `keep` — and waits a little for their copies to be
// deleted. False when there was none.
func (e *Engine) freeIdleTemps(keep *job) bool {
	e.mu.Lock()
	var idle []*job
	for j := range e.jobs {
		if j == keep {
			continue
		}
		j.mu.Lock()
		if j.refs == 0 && j.tempFile != "" {
			idle = append(idle, j)
		}
		j.mu.Unlock()
	}
	for _, j := range idle {
		e.dropLocked(j)
	}
	e.mu.Unlock()
	if len(idle) == 0 {
		return false
	}
	done := make(chan struct{})
	go func() {
		e.drops.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	return true
}

// dropLocked forgets a job: stops it, and once nothing reads its temp copy
// any more, deletes it.
func (e *Engine) dropLocked(j *job) {
	delete(e.jobs, j)
	if e.keys[j.key] == j {
		delete(e.keys, j.key)
	}
	j.mu.Lock()
	j.closed = true
	j.mu.Unlock()
	j.stop.Store(true)
	j.wake()
	e.drops.Add(1)
	go func() {
		defer e.drops.Done()
		j.mu.Lock()
		for !j.done || j.following {
			j.cond.Wait()
		}
		tmp := j.tempFile
		j.hits, j.ext, j.longs = nil, nil, nil
		if j.evSignal != nil && !j.evClosed {
			j.evClosed = true
			close(j.evSignal)
		}
		j.mu.Unlock()
		if tmp == "" {
			return
		}
		j.content.Lock() // every reader has closed its handle
		defer j.content.Unlock()
		for i := 0; i < 20; i++ {
			err := os.Remove(tmp)
			if err == nil || os.IsNotExist(err) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		// Left for CleanStaleTemp at the next start.
	}()
}

func (e *Engine) view(id string) (*view, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v := e.views[id]
	if v == nil {
		return nil, fmt.Errorf("거르기 작업이 없습니다 (닫혔거나 오래되어 정리됨): %s", id)
	}
	return v, nil
}

// Status returns a job's progress.
func (e *Engine) Status(id string) (Progress, error) {
	v, err := e.view(id)
	if err != nil {
		return Progress{}, err
	}
	v.j.checkFile(false)
	return v.j.progressFor(id), nil
}

// Wait blocks until the job is done (tests and benchmarks).
func (e *Engine) Wait(id string) (Progress, error) {
	v, err := e.view(id)
	if err != nil {
		return Progress{}, err
	}
	j := v.j
	j.mu.Lock()
	for !j.done || j.following {
		j.cond.Wait()
	}
	j.mu.Unlock()
	return j.progressFor(id), nil
}

// Cancel: this view no longer wants the scan. The scan stops when no view of
// it wants it any more; rows found so far stay readable. A canceled job is not
// offered for reuse.
func (e *Engine) Cancel(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v := e.views[id]
	if v == nil || v.canceled {
		return
	}
	v.canceled = true
	j := v.j
	j.mu.Lock()
	j.active--
	stopNow := j.active == 0 && (!j.done || j.following)
	j.mu.Unlock()
	if stopNow {
		j.stop.Store(true)
		if e.keys[j.key] == j {
			delete(e.keys, j.key)
		}
		j.wake()
	}
}

// Close forgets a view. The job stays cached while other views use it; an
// unused finished job is kept for reuse (up to MaxIdleJobs), an unfinished one
// is stopped and dropped.
func (e *Engine) Close(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v := e.views[id]
	if v == nil {
		return
	}
	delete(e.views, id)
	v.findSeq.Store(-1) // a Find still running on it stops
	j := v.j
	j.mu.Lock()
	delete(j.views, id)
	j.refs--
	if !v.canceled {
		j.active--
	}
	refs := j.refs
	keep := j.reusableLocked() && j.done && !j.following && !j.stop.Load()
	j.lastUse = time.Now()
	j.mu.Unlock()
	if refs == 0 && !keep {
		e.dropLocked(j)
	}
	e.evictIdleLocked()
}

// CloseAll forgets every job (app shutdown) and waits up to timeout for the
// temp copies to be deleted.
func (e *Engine) CloseAll(timeout time.Duration) {
	e.mu.Lock()
	if !e.closed {
		e.closed = true
		close(e.watchStop)
	}
	for j := range e.jobs {
		e.dropLocked(j)
	}
	e.views = map[string]*view{}
	e.mu.Unlock()
	done := make(chan struct{})
	go func() { e.drops.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

// ---- file watching -------------------------------------------------------------

func (e *Engine) ensureWatcher() {
	if e.opt.WatchEvery < 0 {
		return
	}
	e.watchOnce.Do(func() {
		go func() {
			t := time.NewTicker(e.opt.WatchEvery)
			defer t.Stop()
			for {
				select {
				case <-e.watchStop:
					return
				case <-t.C:
				}
				e.mu.Lock()
				var js []*job
				for j := range e.jobs {
					js = append(js, j)
				}
				e.mu.Unlock()
				for _, j := range js {
					j.mu.Lock()
					inUse := j.refs > 0
					j.mu.Unlock()
					if inUse {
						j.checkFile(true)
					}
				}
			}
		}()
	})
}

// checkFile compares the file with the state the job was scanned at. Growth
// with the same head and old end is an append: the new tail is filtered and
// the version goes up. Anything else is a change — except that the same size
// and modification time count as "unchanged" without reading the file (see
// Progress).
func (j *job) checkFile(force bool) {
	j.mu.Lock()
	if !force && time.Since(j.lastCheck) < 200*time.Millisecond {
		j.mu.Unlock()
		return
	}
	j.lastCheck = time.Now()
	if j.changed || j.closed {
		j.mu.Unlock()
		return
	}
	old, oldFP := j.state, j.fp
	done, following := j.done, j.following
	j.mu.Unlock()
	st, err := statFile(j.path)
	if err == nil && st == old {
		return
	}
	if err == nil && st.size > old.size && !j.gz {
		if !done || following {
			return // look again when the current scan is over
		}
		now, ferr := takeFingerprint(j.path, old.size)
		if ferr == nil && now.head == oldFP.head && now.tail == oldFP.tail {
			newFP, ferr := takeFingerprint(j.path, st.size)
			if ferr == nil {
				j.appendTo(st, newFP)
				return
			}
		}
	}
	if err == nil && !done && st.size > old.size {
		return
	}
	j.mu.Lock()
	if !j.changed {
		j.changed = true
		j.emitLocked(true)
	}
	j.mu.Unlock()
	e := j.e
	e.mu.Lock()
	if e.keys[j.key] == j {
		delete(e.keys, j.key)
	}
	e.mu.Unlock()
}

// appendTo takes in lines appended to the file.
func (j *job) appendTo(st fileState, fp fingerprint) {
	j.mu.Lock()
	if !j.done || j.following || j.closed || j.changed {
		j.mu.Unlock()
		return
	}
	oldKey := j.key
	if j.truncated || j.err != nil || j.canceled || !j.restart.ok {
		// Nothing more can be shown (or the job cannot follow): only accept the
		// new size so the rows already shown stay valid.
		j.state, j.fp = st, fp
		j.mu.Unlock()
		if !j.restart.ok && !j.truncated && j.err == nil && !j.canceled {
			j.mu.Lock()
			j.changed = true
			j.emitLocked(true)
			j.mu.Unlock()
		}
		j.rekey(oldKey)
		return
	}
	j.following = true
	j.done = false
	j.mu.Unlock()
	j.rekey(oldKey)
	go j.runAppend(st, fp)
}

func (j *job) rekey(oldKey string) {
	e := j.e
	j.mu.Lock()
	parts := strings.SplitN(oldKey, "\x00", 4) // path, size, mtime, encoding+rules
	if len(parts) == 4 {
		j.key = fmt.Sprintf("%s\x00%d\x00%d\x00%s", parts[0], j.state.size, j.state.mtime, parts[3])
	}
	newKey := j.key
	j.mu.Unlock()
	e.mu.Lock()
	if e.keys[oldKey] == j {
		delete(e.keys, oldKey)
	}
	if _, taken := e.keys[newKey]; !taken && e.jobs[j] {
		e.keys[newKey] = j
	}
	e.mu.Unlock()
}

// ---- progress and events ----------------------------------------------------------

func (j *job) wake() {
	j.mu.Lock()
	sr := j.sr
	j.cond.Broadcast()
	j.mu.Unlock()
	if sr != nil {
		sr.wake()
	}
}

func (j *job) progressFor(id string) Progress {
	j.mu.Lock()
	defer j.mu.Unlock()
	p := j.progressLocked()
	p.JobID = id
	return p
}

// srcOffset maps an offset of the scanned file to the source file.
func (j *job) srcOffsetLocked(off int64) int64 {
	if j.tempFile == "" {
		return off
	}
	k := sort.Search(len(j.commits), func(i int) bool { return j.commits[i].tmpEnd >= off })
	if k < len(j.commits) {
		return j.commits[k].srcEnd
	}
	return j.srcDone
}

func (j *job) progressLocked() Progress {
	p := Progress{
		Phase: j.phase, TotalBytes: j.state.size, ScannedLines: j.scannedLines, Hits: int64(len(j.hits)), Excluded: j.excluded,
		RuleHits: append([]int64(nil), j.ruleHits...), Encoding: j.enc, InvalidBytes: j.invalid, InvalidLine: j.invalidLine,
		Done: j.done && !j.following, Truncated: j.truncated, Canceled: j.canceled, Changed: j.changed,
		TotalLines: j.totalLines, Version: j.version, TailLine: j.restart.line, FirstHitMs: -1,
	}
	if j.gz {
		p.Compressed = "gzip"
	}
	for k := range j.m.slow {
		if j.m.slow[k].Load() {
			p.SlowRules = append(p.SlowRules, j.m.rules[k].index)
		}
	}
	if j.all {
		p.Mode = ModeAll
		p.Excluded = int64(len(j.hits))
		p.Hits = j.allLinesLocked() - p.Excluded
		p.SlowRules, p.SlowExclude = nil, p.SlowRules
	}
	if j.ex != nil {
		for k := range j.ex.slow {
			if j.ex.slow[k].Load() {
				p.SlowExclude = append(p.SlowExclude, j.ex.rules[k].index)
			}
		}
	}
	p.ScannedBytes = j.srcOffsetLocked(j.scannedOff)
	if p.Done && !j.truncated && j.err == nil && !j.canceled {
		p.ScannedBytes = p.TotalBytes
	}
	if !j.restart.ok {
		p.TailLine = 0
	}
	if j.err != nil {
		p.Error = j.err.Error()
	}
	if p.Done {
		p.ElapsedMs = j.elapsed.Milliseconds()
	} else {
		p.ElapsedMs = time.Since(j.started).Milliseconds()
	}
	if j.firstHit >= 0 {
		p.FirstHitMs = j.firstHit.Milliseconds()
	}
	return p
}

func (j *job) emitLocked(force bool) {
	if j.evSignal == nil || j.evClosed {
		return
	}
	now := time.Now()
	if !force && now.Sub(j.lastEmit) < j.e.opt.ProgressEvery {
		return
	}
	j.lastEmit = now
	p := j.progressLocked()
	// Never call out with the lock held. One sender per job delivers the most
	// recent progress in order.
	j.evPending = &p
	select {
	case j.evSignal <- struct{}{}:
	default:
	}
}

func (j *job) deliverEvents(cb func(Progress)) {
	for range j.evSignal {
		j.mu.Lock()
		p := j.evPending
		j.evPending = nil
		ids := make([]string, 0, len(j.views))
		for id := range j.views {
			ids = append(ids, id)
		}
		j.mu.Unlock()
		if p == nil {
			continue
		}
		sort.Strings(ids)
		for _, id := range ids {
			q := *p
			q.JobID = id
			cb(q)
		}
	}
}

// ---- running ---------------------------------------------------------------------

func (j *job) setSR(sr *scanRun) {
	j.mu.Lock()
	j.sr = sr
	j.mu.Unlock()
}

func (j *job) run() {
	sr, err := j.scanInitial()
	j.finishScan(sr, err)
}

func (j *job) scanInitial() (*scanRun, error) {
	f, err := os.Open(j.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	size := j.state.size
	if isGzip(f) {
		return j.scanGzip(f, size)
	}
	head, extra, err := sampleFile(f, size)
	if err != nil {
		return nil, err
	}
	enc := j.reqEnc
	if enc == "" {
		enc = detectEncoding(head, size, extra)
	}
	enc, ds := dataStartFor(enc, head)
	j.mu.Lock()
	j.enc, j.runSrcFrom = enc, ds
	j.mu.Unlock()
	if !needsTranscode(enc) {
		j.mu.Lock()
		j.readPath, j.dataStart = j.path, ds
		j.mu.Unlock()
		sr := newScanRun(j, j.path, ds, 0, true)
		j.setSR(sr)
		sr.setWM(size, true, nil)
		return sr, sr.run()
	}
	if err := j.checkDisk((size - ds) * 3 / 2); err != nil {
		return nil, err
	}
	tmp, err := j.createTemp()
	if err != nil {
		return nil, err
	}
	defer tmp.Close()
	j.mu.Lock()
	j.readPath, j.dataStart = j.tempFile, 0
	j.mu.Unlock()
	sr := newScanRun(j, j.tempFile, 0, 0, false)
	j.setSR(sr)
	var pw sync.WaitGroup
	pw.Add(1)
	go func() {
		defer pw.Done()
		j.transcodeFile(sr, f, tmp, enc, ds, size, 0, false)
	}()
	err = sr.run()
	sr.endProducer()
	pw.Wait()
	return sr, err
}

// endProducer tells a producer still running (the scan stopped early) to stop.
func (sr *scanRun) endProducer() {
	sr.mu.Lock()
	sr.quit = true
	sr.cond.Broadcast()
	sr.mu.Unlock()
	sr.wakeProducers()
}

func (j *job) scanGzip(f *os.File, size int64) (*scanRun, error) {
	j.mu.Lock()
	j.gz = true
	j.mu.Unlock()
	g, err := openGzip(f, size)
	if err != nil {
		return nil, err
	}
	enc := j.reqEnc
	if enc == "" {
		var extErr error
		more := func() [][]byte {
			b, err := g.extendHead(gzipSniffMax)
			extErr = err
			if len(b) == 0 {
				return nil
			}
			return [][]byte{b}
		}
		enc = detectEncoding(g.head, -1, more)
		if extErr != nil {
			return nil, extErr
		}
	}
	enc, ds := dataStartFor(enc, g.head)
	need := gzipSizeHint(f, size)
	if need < size {
		need = size * 4 // trailer only holds the size modulo 4GB
	}
	if need > j.e.opt.MaxInflate {
		need = j.e.opt.MaxInflate
	}
	if err := j.checkDisk(need); err != nil {
		return nil, err
	}
	tmp, err := j.createTemp()
	if err != nil {
		return nil, err
	}
	defer tmp.Close()
	readStart, skip := ds, 0
	if needsTranscode(enc) {
		readStart, skip = 0, int(ds)
	}
	j.mu.Lock()
	j.enc, j.readPath, j.dataStart = enc, j.tempFile, readStart
	j.mu.Unlock()
	sr := newScanRun(j, j.tempFile, readStart, 0, !needsTranscode(enc))
	j.setSR(sr)
	var pw sync.WaitGroup
	pw.Add(1)
	go func() {
		defer pw.Done()
		j.inflate(sr, g, tmp, enc, skip)
	}()
	err = sr.run()
	sr.endProducer()
	pw.Wait()
	return sr, err
}

// runAppend filters what was appended to the file: from the restart point
// (the start of the last line that could still change) to the new end.
func (j *job) runAppend(st fileState, fp fingerprint) {
	// The lines from the restart point on are judged again: take their
	// excluded lines out of the count first (they are not in the hit list).
	var exTail int64
	if j.ex != nil {
		j.mu.Lock()
		rp, path, size := j.restart, j.readPath, j.size
		j.mu.Unlock()
		exTail = j.excludedIn(path, rp.tmp, size)
	}
	j.mu.Lock()
	j.excluded -= exTail
	rp := j.restart
	keep := sort.Search(len(j.hits), func(i int) bool { return j.hits[i].line >= rp.line })
	nh := make([]hit, keep, keep+1024)
	copy(nh, j.hits[:keep])
	keepExt := 0
	for _, h := range j.hits[:keep] {
		if h.ext != 0 {
			keepExt = int(h.ext) // entries are in hit order
		}
	}
	for _, h := range j.hits[keep:] {
		j.m.eachRule(h, j.ext, func(k int) { j.ruleHits[j.m.rules[k].index]-- })
	}
	j.hits = nh
	if j.ext != nil {
		// a new slice: rows being read may still look at the dropped entries
		j.ext = append([]uint64(nil), j.ext[:keepExt*j.m.extWords]...)
	}
	kl := sort.Search(len(j.longs), func(i int) bool { return j.longs[i].line >= rp.line })
	j.longs = append([]longLine(nil), j.longs[:kl]...)
	if j.all {
		j.cps = cutPos(j.cps, rp.line)
		j.seen = cutPos(j.seen, rp.line)
	}
	kc := sort.Search(len(j.commits), func(i int) bool { return j.commits[i].tmpEnd > rp.tmp })
	j.commits = append([]commit(nil), j.commits[:kc]...)
	j.scannedLines, j.scannedOff, j.totalLines = rp.line-1, rp.tmp, 0
	j.invalid -= j.invalidTail
	j.invalidTail = 0
	if j.invalidLine >= rp.line {
		j.invalidLine = 0
	}
	j.appendLines = append(j.appendLines, rp.line)
	j.version++
	j.phase = "append"
	j.started = time.Now()
	j.state, j.fp = st, fp
	j.nlTmp, j.nlSrc = -1, -1
	j.runSrcFrom = rp.src
	j.lay = nil
	j.emitLocked(true)
	tempFile, enc := j.tempFile, j.enc
	j.mu.Unlock()

	var sr *scanRun
	err := func() error {
		f, err := os.Open(j.path)
		if err != nil {
			return err
		}
		defer f.Close()
		if tempFile == "" {
			sr = newScanRun(j, j.path, rp.tmp, rp.line-1, true)
			j.setSR(sr)
			sr.setWM(st.size, true, nil)
			return sr.run()
		}
		if err := j.checkDisk((st.size - rp.src) * 3 / 2); err != nil {
			return err
		}
		tmp, err := os.OpenFile(tempFile, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		defer tmp.Close()
		sr = newScanRun(j, tempFile, rp.tmp, rp.line-1, false)
		j.setSR(sr)
		var pw sync.WaitGroup
		pw.Add(1)
		go func() {
			defer pw.Done()
			j.transcodeFile(sr, f, tmp, enc, rp.src, st.size, rp.tmp, true)
		}()
		err = sr.run()
		sr.endProducer()
		pw.Wait()
		return err
	}()
	j.finishScan(sr, err)
}

// finishScan records the end of a scan run: totals, the restart point for a
// later append, done.
func (j *job) finishScan(sr *scanRun, err error) {
	j.mu.Lock()
	if sr != nil && sr.wm > j.size {
		j.size = sr.wm
	}
	if err != nil && !errors.Is(err, errCanceled) && j.err == nil {
		j.err = err
	}
	if j.stop.Load() && !j.truncated && j.err == nil {
		j.canceled = true
	}
	ok := sr != nil && j.err == nil && !j.canceled && !j.truncated
	j.mu.Unlock()
	var total int64
	var rp restartPoint
	var invTail int64
	if ok {
		var terr error
		total, rp, invTail, terr = j.tailInfo(sr)
		if terr != nil {
			ok = false
			j.mu.Lock()
			if j.err == nil {
				j.err = terr
			}
			j.mu.Unlock()
		}
	}
	j.mu.Lock()
	if ok {
		j.totalLines = total
		j.scannedLines = total
		j.scannedOff = j.size
		j.restart = rp
		j.invalidTail = invTail
	} else {
		j.restart = restartPoint{}
	}
	j.done = true
	j.following = false
	j.phase = "done"
	j.elapsed = time.Since(j.started)
	j.sr = nil
	j.lay = nil
	j.emitLocked(true)
	j.cond.Broadcast()
	failed := j.err != nil || j.canceled
	j.mu.Unlock()
	if failed {
		e := j.e
		e.mu.Lock()
		if e.keys[j.key] == j {
			delete(e.keys, j.key)
		}
		e.mu.Unlock()
	}
}

// tailInfo: the file's line count, where an append would have to rescan from,
// and the invalid bytes counted in that tail.
func (j *job) tailInfo(sr *scanRun) (int64, restartPoint, int64, error) {
	size := sr.wm
	f, err := os.Open(sr.path)
	if err != nil {
		return 0, restartPoint{}, 0, err
	}
	defer f.Close()
	total := sr.linesBefore + sr.linesDone
	endsWithBreak := size == sr.from
	if !endsWithBreak {
		var b [1]byte
		if _, err := f.ReadAt(b[:], size-1); err != nil {
			return 0, restartPoint{}, 0, err
		}
		endsWithBreak = isTerm(b[0])
	}
	if endsWithBreak {
		total++
	}
	j.mu.Lock()
	gz, temp := j.gz, j.tempFile != ""
	nlTmp, nlSrc, srcFrom := j.nlTmp, j.nlSrc, j.runSrcFrom
	j.mu.Unlock()
	if gz {
		return total, restartPoint{}, 0, nil
	}
	rp := restartPoint{ok: true}
	if temp {
		if nlTmp >= 0 {
			rp.tmp, rp.src = nlTmp, nlSrc
		} else {
			rp.tmp, rp.src = sr.from, srcFrom
		}
	} else {
		// after the last '\n' (searching back at most 64MB), else the start
		// of the last region (a line start)
		rp.tmp = sr.from
		if n := len(sr.regions); n > 0 {
			rp.tmp = sr.regions[n-1].start
		}
		if p, ok := lastLF(f, sr.from, size, 64<<20); ok && p > rp.tmp {
			rp.tmp = p
		}
		rp.src = rp.tmp
	}
	breaks, inv, err := countTail(f, rp.tmp, size, sr.checkUTF8)
	if err != nil {
		return 0, restartPoint{}, 0, err
	}
	rp.line = total - breaks
	return total, rp, inv, nil
}

// lastLF: the offset just past the last '\n' in [from, size), searching back
// at most max bytes.
func lastLF(f *os.File, from, size, max int64) (int64, bool) {
	buf := make([]byte, 64<<10)
	lo := size - max
	if lo < from {
		lo = from
	}
	for pos := size; pos > lo; {
		n := int64(len(buf))
		if pos-lo < n {
			n = pos - lo
		}
		if _, err := f.ReadAt(buf[:n], pos-n); err != nil && err != io.EOF {
			return 0, false
		}
		for i := n - 1; i >= 0; i-- {
			if buf[i] == '\n' {
				return pos - n + i + 1, true
			}
		}
		pos -= n
	}
	return 0, false
}

// countTail counts line breaks (and invalid UTF-8 bytes) in [from, size).
func countTail(f *os.File, from, size int64, utf8Check bool) (int64, int64, error) {
	buf := make([]byte, 1<<20)
	var breaks, inv int64
	prevCR := false
	carry := 0
	for pos := from; pos < size; {
		n := int64(len(buf) - carry)
		if size-pos < n {
			n = size - pos
		}
		k, err := f.ReadAt(buf[carry:carry+int(n)], pos)
		if int64(k) < n {
			if err == nil || err == io.EOF {
				err = errShrunk
			}
			return 0, 0, err
		}
		pos += n
		b := buf[carry : carry+int(n)]
		breaks += countBreaks(b, true)
		if prevCR && len(b) > 0 && b[0] == '\n' {
			breaks--
		}
		if len(b) > 0 {
			prevCR = b[len(b)-1] == '\r'
		}
		data := buf[:carry+int(n)]
		cut := len(data)
		if pos < size {
			cut = runeCut(data)
		}
		if utf8Check {
			c, _ := invalidUTF8(data[:cut])
			inv += c
		}
		carry = copy(buf, data[cut:])
	}
	return breaks, inv, nil
}
