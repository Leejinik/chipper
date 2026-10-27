package main

// v1.2.1 final touches (.relay/20261027-v121/plan.md, 「codex 설계 검토 판정」
// P and S). Each test fails on 81e4613 (the rework) and passes after.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newerCut: a session of format ver written the way the frontend writes it
// ("version" first), cut off inside its second tab.
func newerCut(t *testing.T, ver string) string {
	t.Helper()
	full := sessionWithTabs(3) // json.Marshal sorts keys: … "tabs":[…],"version":3}
	tail := `,"version":3}`
	if !strings.HasSuffix(full, tail) {
		t.Fatalf("test session: unexpected shape %q", full[len(full)-30:])
	}
	front := `{"version":` + ver + `,` + full[1:len(full)-len(tail)] + `}`
	return front[:strings.Index(front, `"id":"t2"`)+12]
}

// P: a session from a newer Chipper that was cut off after its "version"
// field is still a newer session: not moved aside as broken, not rewritten,
// nothing recovered from it, and this run does not save (the G notice).
func TestSessionF_TruncatedNewerIsLeftAlone(t *testing.T) {
	for _, ver := range []string{"4", "99"} {
		t.Run("v"+ver, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, primarySessionName())
			// cut inside the second tab (well after "version")
			cut := newerCut(t, ver)
			if !strings.Contains(cut, `"version":`+ver) {
				t.Fatalf("test session: the cut must come after the version field: %q", cut[:60])
			}
			if err := os.WriteFile(p, []byte(cut), 0o600); err != nil {
				t.Fatal(err)
			}
			r := runOnce(dir, welcomeSession) // the frontend's first autosave tries to write
			got, _ := os.ReadFile(p)
			if string(got) != cut {
				t.Errorf("the cut-off newer session was moved or rewritten (%d bytes now, was %d)", len(got), len(cut))
			}
			if b := brokenFiles(t, dir); len(b) != 0 {
				t.Errorf("the cut-off newer session was kept aside as broken: %v", b)
			}
			if r.data != "" {
				t.Errorf("tabs were recovered from a newer session: %q", r.data)
			}
			if !strings.Contains(r.notice, "더 새") || !strings.Contains(r.notice, "건드리지 않습니다") {
				t.Errorf("want the newer-session (G) notice, got %q", r.notice)
			}
			if !r.blocked {
				t.Errorf("want this run's session saving off")
			}
		})
	}
}

// P: the same goes for a stored session listed for 「불러오기」 — a cut-off
// newer one is reported as newer, not as a broken session with no tabs.
func TestSessionF_TruncatedNewerBackupSaysNewer(t *testing.T) {
	dir := t.TempDir()
	cut := newerCut(t, "4")
	if err := os.WriteFile(filepath.Join(dir, primarySessionName()+".bak"), []byte(cut), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &App{dataDir: dir}
	var note string
	for _, b := range a.SessionBackups() {
		if b.Name == primarySessionName()+".bak" {
			note = b.Note
		}
	}
	if !strings.Contains(note, "더 새") {
		t.Errorf("want the cut-off newer .bak listed as a newer session, got note %q", note)
	}
}

// S: a session whose tabs the frontend would all throw away (no text field,
// not objects) is not a 「normal」 session: starting from it must not push
// the last good session out of .bak.
func TestSessionF_BakNeedsARestorableTab(t *testing.T) {
	for name, start := range map[string]string{
		"no content":  `{"version":3,"tabs":[{"id":"a","title":"a.md"},{"id":"b","path":"C:\\x.log"}],"activeId":"a"}`,
		"not objects": `{"version":3,"tabs":[1,"x",null,[]],"activeId":""}`,
		"empty":       `{"version":3,"tabs":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, primarySessionName())
			good := sessionWithTabs(2)
			if err := os.WriteFile(p+".bak", []byte(good), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte(start), 0o600); err != nil {
				t.Fatal(err)
			}
			runOnce(dir, welcomeSession)
			if b, _ := os.ReadFile(p + ".bak"); string(b) != good {
				t.Errorf(".bak was replaced by a session with nothing to restore: now %q", string(b))
			}
		})
	}
}

// S: what the frontend does restore still counts — one tab with text among
// junk makes the session normal, so it is backed up before being overwritten.
func TestSessionF_BakKeepsSessionWithOneRestorableTab(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	start := `{"version":3,"tabs":[{"id":"x","title":"x.md"},{"id":"a","title":"a.md","content":"메모","dirty":true}],"activeId":"a"}`
	if err := os.WriteFile(p, []byte(start), 0o600); err != nil {
		t.Fatal(err)
	}
	runOnce(dir, welcomeSession)
	if b, _ := os.ReadFile(p + ".bak"); string(b) != start {
		t.Errorf("want the session with a restorable tab backed up as .bak, got %q", string(b))
	}
	// and it is offered with the number of tabs the frontend would restore
	a := &App{dataDir: dir}
	for _, b := range a.SessionBackups() {
		if b.Name == primarySessionName()+".bak" && b.Tabs != 1 {
			t.Errorf(".bak listed with %d tabs, the frontend restores 1", b.Tabs)
		}
	}
}
