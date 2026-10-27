package main

// v1.2.1 unit tests for the new helpers (no v1.2.0 counterpart).

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenSizeError_Boundary(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string, size int64) string {
		p := filepath.Join(dir, name)
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(size); err != nil {
			t.Fatal(err)
		}
		f.Close()
		return p
	}
	if err := openSizeError(mk("at.log", maxOpenBytes)); err != nil {
		t.Errorf("exactly 384MB must still open (with the big-file confirm), got %v", err)
	}
	err := openSizeError(mk("over.log", maxOpenBytes+1))
	if err == nil || !strings.Contains(err.Error(), "384.0MB") {
		t.Errorf("384MB+1 must be refused naming the limit, got %v", err)
	}
	if err := openSizeError(filepath.Join(dir, "missing.log")); err != nil {
		t.Errorf("a missing file is left to the read to report, got %v", err)
	}
}

func TestDetectEOL(t *testing.T) {
	cases := []struct {
		in, eol string
		mixed   bool
	}{
		{"", "", false},
		{"one line", "", false},
		{"a\nb\n", "lf", false},
		{"a\r\nb\r\n", "crlf", false},
		{"a\rb\r", "cr", false},
		{"a\r\nb\nc\r\n", "crlf", true},
		{"a\nb\nc\r\n", "lf", true},
		{"a\rb\rc\n", "cr", true},
		{"a\r\nb\n", "crlf", true}, // tie → CRLF
		{"a\nb\r", "lf", true},     // tie → LF before CR
	}
	for _, c := range cases {
		eol, mixed := detectEOL(c.in)
		if eol != c.eol || mixed != c.mixed {
			t.Errorf("detectEOL(%q) = %q,%v; want %q,%v", c.in, eol, mixed, c.eol, c.mixed)
		}
	}
}

func TestEncodeText_UTF16BOMChoice(t *testing.T) {
	with, _ := encodeText("a\n", "utf-16le", "crlf", true)
	without, _ := encodeText("a\n", "utf-16le", "crlf", false)
	if !bytes.Equal(with, []byte{0xFF, 0xFE, 'a', 0, '\r', 0, '\n', 0}) {
		t.Errorf("with BOM: % x", with)
	}
	if !bytes.Equal(without, []byte{'a', 0, '\r', 0, '\n', 0}) {
		t.Errorf("without BOM: % x", without)
	}
}

// A tab from an older session has no line-break info (EOL ""): the save then
// follows the file on disk (CRLF, no BOM) instead of writing LF + BOM.
func TestSave_UnknownFormatFollowsDisk(t *testing.T) {
	p := filepath.Join(t.TempDir(), "old-session-tab.log")
	writeOld(t, p, enc16le("a\r\nb\r\n", false))
	if _, err := (&App{}).SaveFile(p, "X\nb\n", SaveOptions{Encoding: "utf-16le"}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if want := enc16le("X\r\nb\r\n", false); !bytes.Equal(got, want) {
		t.Errorf("want % x, got % x", want, got)
	}
}

// Typed and undone (dirty, but the text equals the file): nothing is written.
func TestSave_EditedBackToOriginalIsNotWritten(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mixed.log")
	orig := []byte("a\r\nb\nc\rd\r\n")
	writeOld(t, p, orig)
	a := &App{}
	doc, _ := a.ReadFile(p)
	res, err := a.SaveFile(p, cmNormalize(doc.Content), SaveOptions{Encoding: doc.Encoding, EOL: doc.EOL})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	st, _ := os.Stat(p)
	if !res.Unchanged || !bytes.Equal(got, orig) || !st.ModTime().Equal(oldTime) {
		t.Errorf("unchanged=%v bytes same=%v mtime same=%v", res.Unchanged, bytes.Equal(got, orig), st.ModTime().Equal(oldTime))
	}
}

// session.json (v1.1 / v1.2.0's file) that cannot be read is copied aside and
// left exactly as it was.
func TestSession_BrokenLegacyIsCopiedNotTouched(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "session.json")
	writeOld(t, legacy, []byte(`{"version":3,"tabs":[{"id":"a","content":"x"},{"id":"b","con`))
	a := &App{dataDir: dir}
	got, err := a.LoadSession()
	if err != nil {
		t.Fatal(err)
	}
	_ = a.SaveSession(`{"version":3,"tabs":[]}`)
	b, _ := os.ReadFile(legacy)
	st, _ := os.Stat(legacy)
	if string(b) != `{"version":3,"tabs":[{"id":"a","content":"x"},{"id":"b","con` || !st.ModTime().Equal(oldTime) {
		t.Errorf("session.json was changed")
	}
	if len(brokenFiles(t, dir)) != 1 {
		t.Errorf("no session.broken copy")
	}
	if !strings.Contains(got.Data, `"id":"a"`) || strings.Contains(got.Data, `"id":"b"`) {
		t.Errorf("want only the whole tab a recovered, got %s", got.Data)
	}
}

// The frontend writes "version" first; a newer format cut off mid-way must
// not be half-imported.
func TestSession_TruncatedNewerFormatIsNotRecovered(t *testing.T) {
	reason, rec, n := checkSession([]byte(`{"version":7,"tabs":[{"id":"a","content":"x"},{"id":"b"`))
	if reason == "" || rec != "" || n != 0 {
		t.Errorf("reason=%q rec=%q n=%d", reason, rec, n)
	}
	reason, rec, n = checkSession([]byte(`{"version":3,"tabs":[{"id":"a","content":"x"},{"id":"b"`))
	if reason == "" || n != 1 || !strings.Contains(rec, `"id":"a"`) {
		t.Errorf("v3 cut off: reason=%q rec=%q n=%d", reason, rec, n)
	}
	if reason, _, _ := checkSession([]byte(sessionWithTabs(2))); reason != "" {
		t.Errorf("a good session was rejected: %s", reason)
	}
}
