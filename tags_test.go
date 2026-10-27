package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const okTags = `{"version":1,"tags":[{"name":"common","rules":[],"updated":""},{"name":"collector","rules":[{"pattern":"x"}]},{"name":"Collector","rules":[]}],"assign":{"dir":{"":["collector"]},"file":{},"name":{}}}`

func TestTagNameProblem(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"common", true},
		{"collector", true},
		{"Collector", true},
		{"카프카 rebalance", true},
		{"a b", true},
		{"", false},
		{" lead", false},
		{"trail ", false},
		{"\tx", false},
		{"a\nb", false},
		{"a\x00b", false},
		{"a\u0085b", false}, // NEL is a control char
		{strings.Repeat("가", 100), true},
		{strings.Repeat("가", 101), false},
	}
	for _, c := range cases {
		if got := tagNameProblem(c.name) == ""; got != c.ok {
			t.Errorf("tagNameProblem(%q) ok=%v, want %v", c.name, got, c.ok)
		}
	}
}

func TestParseTags(t *testing.T) {
	bad := map[string]string{
		"not json":       `{"version":1,`,
		"trailing":       okTags + ` {}`,
		"no version":     `{"tags":[]}`,
		"empty name":     `{"version":1,"tags":[{"name":"","rules":[]}]}`,
		"space name":     `{"version":1,"tags":[{"name":"x ","rules":[]}]}`,
		"dup exact case": `{"version":1,"tags":[{"name":"a","rules":[]},{"name":"a","rules":[]}]}`,
		"rules not arr":  `{"version":1,"tags":[{"name":"a","rules":{}}]}`,
		"assign shape":   `{"version":1,"tags":[],"assign":{"dir":{"x":"collector"}}}`,
		"array root":     `[]`,
	}
	for k, v := range bad {
		if _, err := parseTags([]byte(v)); err == nil {
			t.Errorf("%s: expected error", k)
		}
	}
	if newer, err := parseTags([]byte(okTags)); err != nil || newer {
		t.Fatalf("ok tags: newer=%v err=%v", newer, err)
	}
	if newer, err := parseTags([]byte(`{"version":2,"whatever":true}`)); err != nil || !newer {
		t.Fatalf("v2: newer=%v err=%v", newer, err)
	}
}

func TestSaveLoadTags_AtomicAndBak(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 27, 9, 30, 0, 0, time.Local)

	// first run: nothing on disk
	l, err := loadTagsFile(dir, now)
	if err != nil || l.Exists || l.Data != "" || l.Broken != "" {
		t.Fatalf("empty dir: %+v %v", l, err)
	}

	v1 := okTags
	v2 := strings.Replace(okTags, `"pattern":"x"`, `"pattern":"y"`, 1)
	if err := saveTagsFile(dir, []byte(v1)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "tags.json.bak")); !os.IsNotExist(err) {
		t.Fatalf("no .bak expected after the first save")
	}
	if err := saveTagsFile(dir, []byte(v2)); err != nil {
		t.Fatal(err)
	}
	bak, _ := os.ReadFile(filepath.Join(dir, "tags.json.bak"))
	cur, _ := os.ReadFile(filepath.Join(dir, "tags.json"))
	if string(bak) != v1 || string(cur) != v2 {
		t.Fatalf("bak/cur wrong:\nbak=%s\ncur=%s", bak, cur)
	}
	// same content again: nothing rewritten, .bak stays one change behind
	if err := saveTagsFile(dir, []byte(v2)); err != nil {
		t.Fatal(err)
	}
	bak, _ = os.ReadFile(filepath.Join(dir, "tags.json.bak"))
	if string(bak) != v1 {
		t.Fatalf("unchanged save rotated the backup")
	}
	// invalid data is refused and the file on disk is untouched
	if err := saveTagsFile(dir, []byte(`{"version":1,"tags":[{"name":" bad","rules":[]}]}`)); err == nil {
		t.Fatal("expected refusal of a bad tag name")
	}
	if err := saveTagsFile(dir, []byte(`{"version":9}`)); err == nil {
		t.Fatal("expected refusal of a newer-version store")
	}
	cur, _ = os.ReadFile(filepath.Join(dir, "tags.json"))
	if string(cur) != v2 {
		t.Fatal("refused save changed the file")
	}
	// no temp files left behind
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("leftover temp file %s", e.Name())
		}
	}
	l, err = loadTagsFile(dir, now)
	if err != nil || !l.Exists || l.Data != v2 || l.Restored || l.Broken != "" {
		t.Fatalf("load: %+v %v", l, err)
	}
}

func TestLoadTags_BrokenMovedAsideAndBakRestored(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 27, 9, 30, 5, 0, time.Local)
	p := filepath.Join(dir, "tags.json")
	if err := os.WriteFile(p+".bak", []byte(okTags), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"version":1,"tags":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := loadTagsFile(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "tags.broken-20261027-093005.json")
	if l.Broken != want || l.Problem == "" || !l.Restored || !l.Exists || l.Data != okTags {
		t.Fatalf("broken load: %+v", l)
	}
	if b, _ := os.ReadFile(want); string(b) != `{"version":1,"tags":[` {
		t.Fatalf("broken copy content changed: %q", b)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("broken tags.json should have been moved away")
	}

	// a second broken file in the same second gets its own name
	if err := os.WriteFile(p, []byte(`nope`), 0o600); err != nil {
		t.Fatal(err)
	}
	l2, err := loadTagsFile(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Broken == want || !strings.HasPrefix(filepath.Base(l2.Broken), "tags.broken-20261027-093005-") {
		t.Fatalf("second broken name: %s", l2.Broken)
	}
	if b, _ := os.ReadFile(want); string(b) != `{"version":1,"tags":[` {
		t.Fatal("first broken copy was overwritten")
	}

	// broken with no usable backup: reported, nothing to load
	dir2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir2, "tags.json"), []byte(`[1,2]`), 0o600); err != nil {
		t.Fatal(err)
	}
	l3, err := loadTagsFile(dir2, now)
	if err != nil || l3.Exists || l3.Data != "" || l3.Broken == "" || l3.Restored {
		t.Fatalf("no-bak broken: %+v %v", l3, err)
	}
}

func TestLoadTags_Newer(t *testing.T) {
	dir := t.TempDir()
	data := `{"version":2,"tags":[{"name":"x"}]}`
	if err := os.WriteFile(filepath.Join(dir, "tags.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := loadTagsFile(dir, time.Now())
	if err != nil || !l.Exists || !l.Newer || l.Data != data || l.Broken != "" {
		t.Fatalf("newer: %+v %v", l, err)
	}
}
