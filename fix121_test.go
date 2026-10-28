package main

// v1.2.1 defect tests (see .relay/20261027-v121/plan.md). Each test reproduces a
// defect found in the v1.2.0 verification; they fail on v1.2.0 and pass on
// v1.2.1. The app is driven through adapter121_test.go.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/text/encoding/korean"
)

var oldTime = time.Date(2020, 1, 2, 3, 4, 5, 0, time.Local)

// cmNormalize is what CodeMirror does to a document: every CRLF / CR becomes LF.
func cmNormalize(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

func enc16le(s string, bom bool) []byte {
	var out []byte
	if bom {
		out = append(out, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func writeOld(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
}

type eolFixture struct {
	name   string
	text   string                // with the file's own line breaks
	encode func(s string) []byte // how the fixture bytes are made
	edited string                // expected text after "X" is typed at the start ("" = "X"+text)
}

func eolFixtures() []eolFixture {
	utf8b := func(s string) []byte { return []byte(s) }
	utf8bom := func(s string) []byte { return append([]byte{0xEF, 0xBB, 0xBF}, s...) }
	cp949 := func(s string) []byte {
		b, err := korean.EUCKR.NewEncoder().Bytes([]byte(s))
		if err != nil {
			panic(err)
		}
		return b
	}
	return []eolFixture{
		{name: "lf.log", text: "a1\nb2\nc3\n", encode: utf8b},
		{name: "crlf.log", text: "a1\r\nb2\r\nc3\r\n", encode: utf8b},
		{name: "cr-only.log", text: "a1\rb2\rc3\r", encode: utf8b},
		// 3 CRLF, 1 LF, 1 CR → CRLF is the majority
		{name: "mixed-eol.log", text: "a1\r\nb2\r\nc3\nd4\re5\r\n", encode: utf8b, edited: "Xa1\r\nb2\r\nc3\r\nd4\r\ne5\r\n"},
		{name: "utf16le-nobom.log", text: "a1\r\nb2\r\nc3\r\n", encode: func(s string) []byte { return enc16le(s, false) }},
		{name: "utf16le-bom.log", text: "가1\r\n나2\r\n", encode: func(s string) []byte { return enc16le(s, true) }},
		{name: "utf8-bom.log", text: "가\r\n나\r\n", encode: utf8bom},
		{name: "cp949.log", text: "가나\r\n다\r\n", encode: cp949},
	}
}

// DATA-1: Ctrl+S on a document nobody edited must not touch the file at all.
func TestSave_UnchangedDocumentIsNotWritten(t *testing.T) {
	dir := t.TempDir()
	a := &App{}
	for _, f := range eolFixtures() {
		t.Run(f.name, func(t *testing.T) {
			p := filepath.Join(dir, f.name)
			orig := f.encode(f.text)
			writeOld(t, p, orig)
			doc, err := a.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := saveLikeFrontend(a, p, doc, cmNormalize(doc.Content), false); err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(p)
			st, _ := os.Stat(p)
			if !bytes.Equal(got, orig) {
				t.Errorf("bytes changed: %d → %d (% x → % x)", len(orig), len(got), head(orig), head(got))
			}
			if !st.ModTime().Equal(oldTime) {
				t.Errorf("file rewritten: mtime %v → %v", oldTime, st.ModTime())
			}
		})
	}
}

// DATA-2: after a real edit the file keeps its own line breaks and BOM; only the
// edited part differs (mixed line breaks become the majority kind).
func TestSave_EditKeepsLineBreaksAndBOM(t *testing.T) {
	dir := t.TempDir()
	a := &App{}
	for _, f := range eolFixtures() {
		t.Run(f.name, func(t *testing.T) {
			p := filepath.Join(dir, f.name)
			writeOld(t, p, f.encode(f.text))
			doc, err := a.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := saveLikeFrontend(a, p, doc, "X"+cmNormalize(doc.Content), false); err != nil {
				t.Fatal(err)
			}
			wantText := f.edited
			if wantText == "" {
				wantText = "X" + f.text
			}
			want := f.encode(wantText)
			got, _ := os.ReadFile(p)
			if !bytes.Equal(got, want) {
				t.Errorf("saved bytes differ from the original + edit:\n want %d bytes % x\n  got %d bytes % x", len(want), head(want), len(got), head(got))
			}
		})
	}
}

// Picking another encoding in "인코딩하여 저장 / 변환" is an explicit conversion
// and must still write even though the text is unchanged.
func TestSave_EncodingConversionStillWrites(t *testing.T) {
	dir := t.TempDir()
	a := &App{}
	p := filepath.Join(dir, "conv.txt")
	writeOld(t, p, []byte("a\r\nb\r\n"))
	doc, err := a.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := saveWithEncodingLikeFrontend(a, p, doc, cmNormalize(doc.Content), "utf-8-bom"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if want := []byte("\xEF\xBB\xBFa\r\nb\r\n"); !bytes.Equal(got, want) {
		t.Errorf("conversion: want % x, got % x", want, got)
	}
}

func head(b []byte) []byte {
	if len(b) > 24 {
		return b[:24]
	}
	return b
}

// --- session -----------------------------------------------------------------

func sessionWithTabs(n int) string {
	tabs := make([]map[string]any, 0, n)
	for i := 1; i <= n; i++ {
		tabs = append(tabs, map[string]any{
			"id": "t" + string(rune('0'+i)), "title": "메모" + string(rune('0'+i)) + ".md", "path": "",
			"lang": "markdown", "content": "저장 안 한 메모 " + strings.Repeat("내용", 50), "dirty": true,
			"view": "split", "mtime": 0, "encoding": "utf-8", "reloadSeq": 0,
		})
	}
	b, _ := json.Marshal(map[string]any{"version": 3, "tabs": tabs, "activeId": "t1", "splitRatio": 0.5, "fontSize": 14})
	return string(b)
}

func brokenFiles(t *testing.T, dir string) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(dir, "session.broken-*.json"))
	return m
}

// DATA-3: a session that cannot be read is kept aside (and the user told)
// before the app writes a new one over it.
func TestSession_BrokenSessionIsKeptAndReported(t *testing.T) {
	full := sessionWithTabs(3)
	cut := strings.Index(full, `"id":"t3"`) + 5
	cases := []struct {
		name     string
		data     string
		wantTabs int // tabs recovered (-1 = don't check)
	}{
		{"truncated", full[:cut], 2},
		{"empty", "", 0},
		{"not-json", "이건 JSON 이 아닙니다 {{{", 0},
		// version 99 (a newer Chipper) is no longer "broken": see TestSessionR_NewerFormatIsLeftAlone
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, primarySessionName())
			if err := os.WriteFile(p, []byte(c.data), 0o600); err != nil {
				t.Fatal(err)
			}
			a := &App{dataDir: dir}
			data, notice, _ := loadSessionForTest(a)
			// the frontend then autosaves whatever it ended up with
			_ = a.SaveSession(`{"version":3,"tabs":[],"activeId":""}`)

			kept := brokenFiles(t, dir)
			if len(kept) != 1 {
				t.Fatalf("want the unreadable session kept as session.broken-<time>.json, found %v", kept)
			}
			if b, _ := os.ReadFile(kept[0]); string(b) != c.data {
				t.Errorf("kept copy differs from the original (%d vs %d bytes)", len(b), len(c.data))
			}
			if !strings.Contains(notice, "세션") || !strings.Contains(notice, filepath.Base(kept[0])) {
				t.Errorf("want a Korean notice naming the kept file, got %q", notice)
			}
			if c.wantTabs >= 0 {
				got := 0
				if data != "" {
					var s struct{ Tabs []json.RawMessage }
					if err := json.Unmarshal([]byte(data), &s); err != nil {
						t.Fatalf("recovered session is not JSON: %v", err)
					}
					got = len(s.Tabs)
				}
				if got != c.wantTabs {
					t.Errorf("recovered %d tabs, want %d", got, c.wantTabs)
				}
			}
		})
	}
}

// DATA-4: v1.1 rewrites session.json with its own welcome document. The v1.2
// session must survive that round trip (v1.2 → v1.1 → v1.2).
func TestSession_OlderVersionCannotClobber(t *testing.T) {
	dir := t.TempDir()
	mine := sessionWithTabs(2)
	a := &App{dataDir: dir}
	if _, _, err := loadSessionForTest(a); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveSession(mine); err != nil {
		t.Fatal(err)
	}
	// v1.1 starts, cannot read v3 and writes its welcome session over session.json
	v11 := `{"version":2,"tabs":[{"id":"w","title":"환영합니다.md","path":"","lang":"markdown","content":"# 환영","dirty":false}],"activeId":"w","splitRatio":0.5}`
	if err := os.WriteFile(filepath.Join(dir, "session.json"), []byte(v11), 0o600); err != nil {
		t.Fatal(err)
	}
	b := &App{dataDir: dir}
	data, _, err := loadSessionForTest(b)
	if err != nil {
		t.Fatal(err)
	}
	if data != mine {
		t.Errorf("v1.2 session lost after a v1.1 run: got %d bytes (%.60q…)", len(data), data)
	}
}

// First v1.2.1 start after v1.2.0: the v3 session in session.json is taken
// over, and session.json itself is left exactly as it was.
func TestSession_TakesOverV3FromSessionJSONWithoutTouchingIt(t *testing.T) {
	dir := t.TempDir()
	old := sessionWithTabs(2)
	legacy := filepath.Join(dir, "session.json")
	writeOld(t, legacy, []byte(old))
	a := &App{dataDir: dir}
	data, _, err := loadSessionForTest(a)
	if err != nil {
		t.Fatal(err)
	}
	if data != old {
		t.Fatalf("v3 session in session.json not taken over")
	}
	if err := a.SaveSession(sessionWithTabs(1)); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(legacy)
	st, _ := os.Stat(legacy)
	if string(got) != old || !st.ModTime().Equal(oldTime) {
		t.Errorf("session.json was rewritten (%d → %d bytes)", len(old), len(got))
	}
}

// The session from the previous run is kept as <session>.bak before this run
// first overwrites it (later autosaves of the same run leave the .bak alone).
func TestSession_BackupBeforeFirstOverwrite(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	prev := sessionWithTabs(2)
	if err := os.WriteFile(p, []byte(prev), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &App{dataDir: dir}
	if _, _, err := loadSessionForTest(a); err != nil {
		t.Fatal(err)
	}
	_ = a.SaveSession(`{"version":3,"tabs":[],"activeId":""}`)
	_ = a.SaveSession(`{"version":3,"tabs":[],"activeId":"","fontSize":15}`)
	bak, err := os.ReadFile(p + ".bak")
	if err != nil {
		t.Fatalf("no backup of the previous session: %v", err)
	}
	if string(bak) != prev {
		t.Errorf("backup is not the previous run's session (%d bytes, want %d)", len(bak), len(prev))
	}
}

// --- bundle ------------------------------------------------------------------

// TREE-1: an empty server folder must list its files as [] (JSON null crashed
// the whole UI: "t.files is not iterable").
func TestScanBundle_EmptyFolderHasEmptyFileList(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "server1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "server1", "a.log"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "empty-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := (&App{}).ScanBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	js, _ := json.Marshal(b)
	if strings.Contains(string(js), `"files":null`) {
		t.Errorf("empty folder serialized as files:null → %s", js)
	}
}

// --- big files -----------------------------------------------------------------

// BIG-1: past 384MB the file is refused up front with a Korean message instead
// of being read whole (500MB+ crashed the WebView).
func TestReadFile_RefusesFilesOver384MB(t *testing.T) {
	p := filepath.Join(t.TempDir(), "huge.log")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(402_653_184 + 1); err != nil { // 384MB + 1 byte
		t.Fatal(err)
	}
	f.Close()
	start := time.Now()
	_, err = (&App{}).ReadFile(p)
	if err == nil || !strings.Contains(err.Error(), "너무 커서") {
		t.Errorf("want a 「너무 커서 열 수 없습니다」 error, got %v (after %v)", err, time.Since(start))
	}
	// 「태그 줄만」 is in this version: the message points at it, not at a next one
	if err != nil && (strings.Contains(err.Error(), "다음 버전") || !strings.Contains(err.Error(), "태그 줄만")) {
		t.Errorf("the refusal should point at 「🏷 태그 줄만」 of this version: %v", err)
	}
}
