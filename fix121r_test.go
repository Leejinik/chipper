package main

// v1.2.1 rework tests (.relay/20261027-v121/plan.md: 되묻기 1·2, review A~J,
// .18 K~N). Each test shows a problem of 7f336e5 (rc1) and passes after the
// rework. The app is driven through adapter121r_test.go.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// one "run" of Chipper against dir: load the session, then the frontend's
// first autosave writes `writes` (what the frontend ended up with).
func runOnce(dir string, writes string) loadResultR {
	a := &App{dataDir: dir}
	r := loadR(a)
	if writes != "" {
		_ = a.SaveSession(writes)
	}
	return r
}

func setMtime(t *testing.T, p string, tm time.Time) {
	t.Helper()
	if err := os.Chtimes(p, tm, tm); err != nil {
		t.Fatal(err)
	}
}

const welcomeSession = `{"version":3,"tabs":[{"id":"w","title":"환영합니다.md","path":"","lang":"markdown","content":"# 환영","dirty":false}],"activeId":"w"}`

// E: a run that came up wrong, then restarts that changed nothing, must not
// push the last good session out of the backups.
func TestSessionR_BakSurvivesBadRestarts(t *testing.T) {
	dir := t.TempDir()
	good := sessionWithTabs(3)
	if err := os.WriteFile(filepath.Join(dir, primarySessionName()), []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	runOnce(dir, welcomeSession) // run 2: the frontend failed to restore → welcome
	runOnce(dir, welcomeSession) // run 3: the user restarts to "fix" it
	runOnce(dir, welcomeSession) // run 4: and once more
	found := false
	for _, n := range []string{".bak", ".bak2"} {
		if b, err := os.ReadFile(filepath.Join(dir, primarySessionName()+n)); err == nil && string(b) == good {
			found = true
		}
	}
	if !found {
		t.Errorf("the last good session is in neither .bak nor .bak2 after 3 restarts")
	}
}

// E: a run that started from a broken session leaves the backup alone.
func TestSessionR_BrokenStartLeavesBakAlone(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	good := sessionWithTabs(2)
	if err := os.WriteFile(p+".bak", []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, nil, 0o600); err != nil { // empty: broken
		t.Fatal(err)
	}
	runOnce(dir, welcomeSession)
	runOnce(dir, welcomeSession)
	runOnce(dir, welcomeSession)
	found := false
	for _, n := range []string{".bak", ".bak2"} {
		if b, err := os.ReadFile(p + n); err == nil && string(b) == good {
			found = true
		}
	}
	if !found {
		t.Errorf("the good .bak was pushed out by runs that started from a broken session")
	}
}

// F: after a broken session.v3.json is put aside, loading again before the
// first autosave must not quietly open an old session.json instead.
func TestSessionR_ReloadAfterBrokenDoesNotOpenOldLegacy(t *testing.T) {
	dir := t.TempDir()
	stale := `{"version":2,"tabs":[{"id":"old","title":"옛 탭.md","path":"","lang":"markdown","content":"오래된 v1.1 탭","dirty":true}],"activeId":"old"}`
	legacy := filepath.Join(dir, "session.json")
	if err := os.WriteFile(legacy, []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}
	setMtime(t, legacy, time.Now().Add(-48*time.Hour))
	full := sessionWithTabs(3)
	if err := os.WriteFile(filepath.Join(dir, primarySessionName()), []byte(full[:strings.Index(full, `"id":"t3"`)+5]), 0o600); err != nil {
		t.Fatal(err)
	}
	first := runOnce(dir, "") // notice, nothing autosaved yet (e.g. 「다시 시도」 or killed)
	if first.notice == "" {
		t.Fatalf("no notice for the broken session")
	}
	second := runOnce(dir, "")
	if strings.Contains(second.data, "오래된 v1.1 탭") {
		t.Errorf("the second load opened the stale session.json without a word (notice %q)", second.notice)
	}
	if !strings.Contains(second.data, `"id":"t1"`) {
		t.Errorf("the second load lost the recovered tabs: %.80q", second.data)
	}
}

// G: a session from a newer Chipper is not moved, not rewritten, and the user
// is told that this build leaves it alone.
func TestSessionR_NewerFormatIsLeftAlone(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	newer := strings.Replace(sessionWithTabs(2), `"version":3`, `"version":4`, 1)
	if err := os.WriteFile(p, []byte(newer), 0o600); err != nil {
		t.Fatal(err)
	}
	r := runOnce(dir, welcomeSession)
	got, _ := os.ReadFile(p)
	if string(got) != newer {
		t.Errorf("the newer session file was moved or rewritten (%d bytes now)", len(got))
	}
	if len(brokenFiles(t, dir)) != 0 {
		t.Errorf("the newer session was treated as broken: %v", brokenFiles(t, dir))
	}
	if !strings.Contains(r.notice, "더 새") || !strings.Contains(r.notice, "건드리지 않습니다") {
		t.Errorf("want a notice that this build leaves the newer session alone, got %q", r.notice)
	}
	if !r.blocked {
		t.Errorf("want this run's session saving off")
	}
}

// H: a session cut off late keeps the fields that were whole, not just tabs.
func TestSessionR_PartialRecoveryKeepsOtherFields(t *testing.T) {
	dir := t.TempDir()
	var s map[string]any
	_ = json.Unmarshal([]byte(sessionWithTabs(2)), &s)
	full, _ := json.Marshal(map[string]any{
		"version": 3, "tabs": s["tabs"], "activeId": "t2", "splitRatio": 0.4, "fontSize": 18,
		"keybindings": map[string]string{"save": "ctrl+alt+s"},
		"logRules":    []map[string]any{{"name": "내 규칙", "pattern": "OOPS"}},
		"multi":       map[string]any{"on": true, "count": 2, "slots": []map[string]any{{"tabId": "t1", "mode": "edit"}, {"tabId": "t2", "mode": "read"}}},
	})
	// encoding/json sorts map keys: …, "logRules", "multi", "splitRatio", "tabs", "version".
	// Write the frontend's order instead (version, tabs, activeId, splitRatio,
	// fontSize, keybindings, logRules, multi) and cut inside multi.
	var m map[string]json.RawMessage
	_ = json.Unmarshal(full, &m)
	var b bytes.Buffer
	b.WriteString(`{"version":3,"tabs":` + string(m["tabs"]) + `,"activeId":"t2","splitRatio":0.4,"fontSize":18,"keybindings":` + string(m["keybindings"]) + `,"logRules":` + string(m["logRules"]) + `,"multi":` + string(m["multi"]) + `}`)
	raw := b.String()
	cut := raw[:strings.LastIndex(raw, `"mode":"read"`)]
	if err := os.WriteFile(filepath.Join(dir, primarySessionName()), []byte(cut), 0o600); err != nil {
		t.Fatal(err)
	}
	r := runOnce(dir, "")
	var got map[string]json.RawMessage
	if err := json.Unmarshal([]byte(r.data), &got); err != nil {
		t.Fatalf("recovered session is not JSON: %v (%.80q)", err, r.data)
	}
	for _, k := range []string{"activeId", "splitRatio", "fontSize", "keybindings", "logRules"} {
		if _, ok := got[k]; !ok {
			t.Errorf("recovery dropped %q", k)
		}
	}
	if !strings.Contains(string(got["keybindings"]), "ctrl+alt+s") || !strings.Contains(string(got["logRules"]), "OOPS") {
		t.Errorf("recovered fields differ: keybindings=%s logRules=%s", got["keybindings"], got["logRules"])
	}
}

// 되묻기 1 / L: work done in an older Chipper (session.json newer than ours)
// is offered for loading; v1.1's bare welcome document is not.
func TestSessionR_LegacyNewerIsOffered(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	if err := os.WriteFile(p, []byte(sessionWithTabs(1)), 0o600); err != nil {
		t.Fatal(err)
	}
	setMtime(t, p, time.Now().Add(-2*time.Hour))
	legacy := filepath.Join(dir, "session.json")
	work := `{"version":2,"tabs":[{"id":"x","title":"V110X.md","path":"","lang":"markdown","content":"v1.1 에서 쓴 메모","dirty":true}],"activeId":"x"}`
	if err := os.WriteFile(legacy, []byte(work), 0o600); err != nil {
		t.Fatal(err)
	}
	r := loadR(&App{dataDir: dir})
	if r.legacy != "session.json" || !strings.Contains(r.notice, "예전 버전") {
		t.Fatalf("work from an older Chipper is not offered: legacy=%q notice=%q", r.legacy, r.notice)
	}
	data, err := readBackupR(&App{dataDir: dir}, "session.json")
	if err != nil || !strings.Contains(data, "v1.1 에서 쓴 메모") {
		t.Errorf("「불러오기」 cannot read session.json: %v", err)
	}
	// v1.1 that only showed its welcome document: nothing to offer.
	if err := os.WriteFile(legacy, []byte(welcomeSession), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := loadR(&App{dataDir: dir}); r.legacy != "" {
		t.Errorf("a bare welcome document was offered as older work")
	}
}

// 되묻기 2: the backups and the kept broken sessions can be loaded from; a
// broken-session notice offers the last good session.
func TestSessionR_BackupsCanBeLoaded(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	good := sessionWithTabs(2)
	if err := os.WriteFile(p+".bak", []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	full := sessionWithTabs(3)
	if err := os.WriteFile(p, []byte(full[:strings.Index(full, `"id":"t3"`)+5]), 0o600); err != nil {
		t.Fatal(err)
	}
	r := loadR(&App{dataDir: dir})
	if r.backup != primarySessionName()+".bak" {
		t.Errorf("the broken-session notice does not offer the .bak (backup=%q)", r.backup)
	}
	a := &App{dataDir: dir}
	names := backupNamesR(a)
	var broken string
	for _, n := range names {
		if strings.HasPrefix(n, "session.broken-") {
			broken = n
		}
	}
	if broken == "" || !strings.Contains(strings.Join(names, ","), ".bak") {
		t.Fatalf("stored sessions not listed: %v", names)
	}
	if d, err := readBackupR(a, primarySessionName()+".bak"); err != nil || d != good {
		t.Errorf(".bak cannot be loaded: %v", err)
	}
	if d, err := readBackupR(a, broken); err != nil || !strings.Contains(d, `"id":"t2"`) {
		t.Errorf("the whole tabs of a broken session cannot be loaded: %v", err)
	}
	if _, err := readBackupR(a, "../outside.json"); err == nil {
		t.Errorf("a name outside the list was read")
	}
}

// D: a save whose result differs in length from the file (an edit; the file
// not mixed) decides without reading the file — a log that grew huge since it
// was opened is not read whole.
func TestSaveR_DoesNotReadWholeFileWhenLengthDiffers(t *testing.T) {
	p := filepath.Join(t.TempDir(), "grown.log")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(600 << 20); err != nil { // grew to 600MB on disk (sparse)
		t.Fatal(err)
	}
	f.Close()
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	if _, err := saveR(&App{}, p, "edited text\n", saveOptR{enc: "utf-8", eol: "lf"}); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&m1)
	if alloc := m1.TotalAlloc - m0.TotalAlloc; alloc > 32<<20 {
		t.Errorf("saving 12 bytes over a 600MB file allocated %dMB (the file was read)", alloc>>20)
	}
}

// D: memory of saving an edited 64MB CRLF log (the review measured 5× the
// file in rc1). Logged for the report; must stay under 3×.
func TestSaveR_EditedBigFileMemory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big.log")
	line := strings.Repeat("2026-10-27 12:00:00 INFO collector queue=12 ok ", 2) + "\r\n"
	text := strings.Repeat(line, (64<<20)/len(line))
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	edited := cmNormalize(text) + "X"
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	t0 := time.Now()
	if _, err := saveR(&App{}, p, edited, saveOptR{enc: "utf-8", eol: "crlf"}); err != nil {
		t.Fatal(err)
	}
	el := time.Since(t0)
	runtime.ReadMemStats(&m1)
	alloc := m1.TotalAlloc - m0.TotalAlloc
	t.Logf("64MB CRLF edited save: %v, allocated %dMB (%.1f× the file)", el, alloc>>20, float64(alloc)/float64(len(text)))
	if float64(alloc) > 3*float64(len(text)) {
		t.Errorf("allocated %.1f× the file", float64(alloc)/float64(len(text)))
	}
	got, _ := os.ReadFile(p)
	if string(got) != text+"X" {
		t.Errorf("saved bytes differ")
	}
	// typed and undone on the same big file: still recognised as unchanged
	res, err := saveR(&App{}, p, cmNormalize(text)+"X", saveOptR{enc: "utf-8", eol: "crlf"})
	if err != nil || !res.Unchanged {
		t.Errorf("unchanged big file rewritten: %v %v", res.Unchanged, err)
	}
}

// J: 「다른 인코딩으로 다시 열기」 must not change the file's BOM when saved.
func TestReadAsR_BOMDecidesEncoding(t *testing.T) {
	dir := t.TempDir()
	// a BOM'd UTF-16LE file reopened as "UTF-16 BE"
	p := filepath.Join(dir, "le-bom.log")
	writeOld(t, p, enc16le("가1\r\n나2\r\n", true))
	doc, err := (&App{}).ReadFileAs(p, "utf-16be")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := saveR(&App{}, p, "X"+cmNormalize(doc.Content), saveOptR{enc: doc.Encoding, eol: doc.EOL, noBom: !doc.BOM}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if want := enc16le("X가1\r\n나2\r\n", true); !bytes.Equal(got, want) {
		t.Errorf("LE+BOM file saved as %x…, want %x…", head(got), head(want))
	}
	// a BOM-less UTF-8 file reopened as "UTF-8 BOM"
	q := filepath.Join(dir, "plain.log")
	writeOld(t, q, []byte("a\nb\n"))
	doc, err = (&App{}).ReadFileAs(q, "utf-8-bom")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := saveR(&App{}, q, "X"+doc.Content, saveOptR{enc: doc.Encoding, eol: doc.EOL, noBom: !doc.BOM}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(q); string(got) != "Xa\nb\n" {
		t.Errorf("BOM-less UTF-8 file got a BOM: %x", head(got))
	}
}

// J: a tab from an older session (line breaks unknown) converted from UTF-16
// to UTF-8 keeps the file's CRLF.
func TestSaveR_OldTabConversionKeepsDiskLineBreaks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "u16.log")
	writeOld(t, p, enc16le("a\r\nb\r\nc\r\n", true))
	if _, err := saveR(&App{}, p, "a\nb\nc\nX", saveOptR{enc: "utf-8", eol: "", force: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != "a\r\nb\r\nc\r\nX" {
		t.Errorf("got %q, want CRLF kept", got)
	}
}

// J: the name search for session.broken-<time>.json is bounded (an Lstat that
// keeps failing must not spin at start-up).
func TestKeepBrokenR_NameLoopIsBounded(t *testing.T) {
	done := make(chan error, 1)
	go func() {
		_, err := keepBrokenSession("bad\x00dir", "nowhere", []byte("x"), true)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Errorf("want an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("keepBrokenSession never returned (unbounded loop)")
	}
}

// N: the refusal says the size and the limit in bytes, so 384MB+1 byte does
// not read as "(384.0MB) — up to 384.0MB".
func TestOpenSizeR_MessageSaysBytes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "over.log")
	f, _ := os.Create(p)
	_ = f.Truncate(402_653_185)
	f.Close()
	_, err := (&App{}).ReadFile(p)
	if err == nil || !strings.Contains(err.Error(), "402,653,185 바이트") || !strings.Contains(err.Error(), "402,653,184 바이트") {
		t.Errorf("want both byte counts in %v", err)
	}
}

// N: a save whose result would be over the open limit is not written until
// the user agreed (allowTooBig) — otherwise the file silently becomes one
// Chipper refuses to open next time.
func TestSaveR_TooBigResultNeedsConsent(t *testing.T) {
	restore, ok := setOpenLimitR(1000)
	if !ok {
		t.Fatalf("no way to warn before a save makes the file too big to open (open limit is fixed and unchecked)")
	}
	defer restore()
	p := filepath.Join(t.TempDir(), "edge.log")
	writeOld(t, p, []byte(strings.Repeat("a", 1000)))
	_, err := saveR(&App{}, p, strings.Repeat("a", 1001), saveOptR{enc: "utf-8", eol: "lf"})
	if err == nil || !strings.HasPrefix(err.Error(), tooBigAfterSavePrefix) {
		t.Fatalf("want the too-big error first, got %v", err)
	}
	if b, _ := os.ReadFile(p); len(b) != 1000 {
		t.Errorf("written before consent")
	}
	if _, err := saveR(&App{}, p, strings.Repeat("a", 1001), saveOptR{enc: "utf-8", eol: "lf", allowTooBig: true}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); len(b) != 1001 {
		t.Errorf("not written after consent")
	}
}

// M: files lying directly in the bundle root are listed (the tree shows them
// as 「(묶음 루트)」).
func TestScanBundleR_RootFilesListed(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"server1", "empty-dir"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"server1/a.log", "all-servers.log", "README.txt"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := (&App{}).ScanBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(rootFilesR(b), ",")
	if got != "README.txt,all-servers.log" {
		t.Errorf("root files = %q", got)
	}
}
