package main

import (
	"encoding/json"
	"errors"
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

// The frontend (logTags.ts tagNameProblem) checks the same table, so a name is
// accepted by both or by neither: invisible characters, white space at the
// ends (incl. U+FEFF, which JS trim removes and Go TrimSpace keeps), NFC.
func TestTagNameProblem_SharedWithFrontend(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("frontend", "tests", "tag-names.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name string `json:"name"`
		OK   bool   `json:"ok"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 40 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		if got := tagNameProblem(c.Name) == ""; got != c.OK {
			t.Errorf("tagNameProblem(%+q) ok=%v, want %v (%s)", c.Name, got, c.OK, tagNameProblem(c.Name))
		}
	}
}

func TestParseTags(t *testing.T) {
	// refused when loading and when saving
	bad := map[string]string{
		"not json":         `{"version":1,`,
		"trailing value":   okTags + ` {}`,
		"trailing brace":   okTags + `}`, // dec.More() says "nothing more" before a stray } or ]
		"trailing bracket": okTags + `]`,
		"trailing junk":    okTags + ` x`,
		"no version":       `{"tags":[]}`,
		"null version":     `{"version":null,"tags":[]}`,
		"version 1.5":      `{"version":1.5,"tags":[]}`,
		"version 0":        `{"version":0,"tags":[]}`,
		"version string":   `{"version":"1","tags":[]}`,
		"rules not arr":    `{"version":1,"tags":[{"name":"a","rules":{}}]}`,
		"assign shape":     `{"version":1,"tags":[],"assign":{"dir":{"x":"collector"}}}`,
		"name not string":  `{"version":1,"tags":[{"name":5}]}`,
		"array root":       `[]`,
	}
	for k, v := range bad {
		for _, strict := range []bool{false, true} {
			if _, err := parseTags([]byte(v), strict); err == nil {
				t.Errorf("%s (strict=%v): expected error", k, strict)
			}
		}
	}
	// refused only when saving (the frontend repairs these names on load)
	saveOnly := map[string]string{
		"empty name":     `{"version":1,"tags":[{"name":"","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`,
		"space name":     `{"version":1,"tags":[{"name":"x ","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`,
		"zwsp name":      `{"version":1,"tags":[{"name":"a\u200bb","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`,
		"nfd name":       `{"version":1,"tags":[{"name":"e\u0301","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`,
		"dup exact case": `{"version":1,"tags":[{"name":"a","rules":[]},{"name":"a","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`,
		"no tags":        `{"version":1,"assign":{"dir":{},"file":{},"name":{}}}`,
		"no assign":      `{"version":1,"tags":[]}`,
		"assign no name": `{"version":1,"tags":[],"assign":{"dir":{},"file":{}}}`,
	}
	for k, v := range saveOnly {
		if _, err := parseTags([]byte(v), true); err == nil {
			t.Errorf("%s: expected a save to be refused", k)
		}
		if _, err := parseTags([]byte(v), false); err != nil {
			t.Errorf("%s: loading should accept it: %v", k, err)
		}
	}
	for _, strict := range []bool{false, true} {
		if newer, err := parseTags([]byte(okTags), strict); err != nil || newer {
			t.Fatalf("ok tags (strict=%v): newer=%v err=%v", strict, newer, err)
		}
	}
	if newer, err := parseTags([]byte(`{"version":2,"whatever":true}`), false); err != nil || !newer {
		t.Fatalf("v2: newer=%v err=%v", newer, err)
	}
	// a BOM (Notepad, PowerShell) and "1.0" are fine
	bom := append([]byte{0xEF, 0xBB, 0xBF}, okTags...)
	if newer, err := parseTags(bom, false); err != nil || newer {
		t.Fatalf("BOM: newer=%v err=%v", newer, err)
	}
	if _, err := parseTags([]byte(strings.Replace(okTags, `"version":1`, `"version":1.0`, 1)), false); err != nil {
		t.Fatalf("version 1.0: %v", err)
	}
	if newer, _ := parseTags([]byte(`{"version":2.0}`), false); !newer {
		t.Fatal("version 2.0 should be newer")
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
	if err := saveTagsFile(dir, []byte(`{"version":1,"tags":[{"name":" bad","rules":[]}],"assign":{"dir":{},"file":{},"name":{}}}`)); err == nil {
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

// A tags.json saved with a BOM by a text editor loads (BOM removed from Data)
// instead of being moved aside as broken.
func TestLoadTags_BOM(t *testing.T) {
	dir := t.TempDir()
	bom := append([]byte{0xEF, 0xBB, 0xBF}, okTags...)
	if err := os.WriteFile(filepath.Join(dir, "tags.json"), bom, 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := loadTagsFile(dir, time.Now())
	if err != nil || !l.Exists || l.Broken != "" || l.Data != okTags {
		t.Fatalf("BOM load: %+v %v", l, err)
	}
}

// Two backups: after three different saves .bak holds the 2nd version and
// .bak2 the 1st; a broken tags.json with a broken .bak falls back to .bak2.
func TestSaveTags_TwoBackups(t *testing.T) {
	dir := t.TempDir()
	v := func(x string) []byte { return []byte(strings.Replace(okTags, `"pattern":"x"`, `"pattern":"`+x+`"`, 1)) }
	for _, x := range []string{"1", "2", "3"} {
		if err := saveTagsFile(dir, v(x)); err != nil {
			t.Fatal(err)
		}
	}
	read := func(n string) string { b, _ := os.ReadFile(filepath.Join(dir, n)); return string(b) }
	if read("tags.json") != string(v("3")) || read("tags.json.bak") != string(v("2")) || read("tags.json.bak2") != string(v("1")) {
		t.Fatalf("backups: cur=%s\nbak=%s\nbak2=%s", read("tags.json"), read("tags.json.bak"), read("tags.json.bak2"))
	}
	if err := os.WriteFile(filepath.Join(dir, "tags.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tags.json.bak"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := loadTagsFile(dir, time.Now())
	if err != nil || !l.Restored || l.RestoredFrom != "tags.json.bak2" || l.Data != string(v("1")) {
		t.Fatalf("fallback to .bak2: %+v %v", l, err)
	}
}

// A newer chipper's tags.json on disk is never written over — the guard is in
// Go, not only in the frontend: the frontend always sends version 1, so this
// is the save a real change would make.
func TestSaveTags_RefusesNewerOnDisk(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "tags.json")
	disk := `{"version":2,"tags":[{"name":"common","rules":[],"shape":"new"}]}`
	if err := os.WriteFile(p, []byte(disk), 0o600); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(okTags, `"pattern":"x"`, `"pattern":"changed"`, 1)
	err := saveTagsFile(dir, []byte(changed))
	if err == nil {
		t.Fatal("expected the save to be refused")
	}
	if tagsErrCode(err) != TagsErrNewerOnDisk || !strings.HasPrefix(err.Error(), "["+TagsErrNewerOnDisk+"] ") {
		t.Fatalf("want code %s, got %q", TagsErrNewerOnDisk, err)
	}
	if b, _ := os.ReadFile(p); string(b) != disk {
		t.Fatalf("newer file was changed: %s", b)
	}
	if _, err := os.Stat(p + ".bak"); !os.IsNotExist(err) {
		t.Fatal("a refused save must not touch the backups")
	}
}

func TestTagsErrorCodes(t *testing.T) {
	dir := t.TempDir()
	if c := tagsErrCode(saveTagsFile(dir, []byte(`{"version":1,"tags":[{"name":" x"}],"assign":{"dir":{},"file":{},"name":{}}}`))); c != TagsErrInvalid {
		t.Errorf("invalid: %q", c)
	}
	if c := tagsErrCode(saveTagsFile(dir, []byte(`{"version":3}`))); c != TagsErrNewerFormat {
		t.Errorf("newer format: %q", c)
	}
	if c := tagsErrCode(errors.New("x")); c != "" {
		t.Errorf("plain error: %q", c)
	}
	// .bak can't be written (a folder is in the way): code, and tags.json kept
	if err := saveTagsFile(dir, []byte(okTags)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "tags.json.bak"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tags.json.bak", "x"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "tags.json.bak2"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tags.json.bak2", "x"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(okTags, `"pattern":"x"`, `"pattern":"z"`, 1)
	if c := tagsErrCode(saveTagsFile(dir, []byte(changed))); c != TagsErrBackup {
		t.Errorf("backup: %q", c)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "tags.json")); string(b) != okTags {
		t.Error("tags.json changed although no backup could be kept")
	}
}

func TestDecodeOneJSON(t *testing.T) {
	var v map[string]any
	for _, ok := range []string{`{}`, ` {"a":1} `, "{}\n\t "} {
		if err := decodeOneJSON([]byte(ok), &v); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{`{}}`, `{}]`, `{} {}`, `{} x`, `{`, ``, `{}{}`} {
		if err := decodeOneJSON([]byte(bad), &v); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestNormalizeTagName(t *testing.T) {
	nfd := "e" + string(rune(0x301))
	if got := normalizeTagName(nfd); got != string(rune(0xe9)) || tagNameProblem(got) != "" || tagNameProblem(nfd) == "" {
		t.Fatalf("normalizeTagName(%+q) = %+q", nfd, got)
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
