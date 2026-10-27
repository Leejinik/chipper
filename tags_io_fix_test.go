package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Stage 5 fixes (stage5-fix.md): limits, trailing content, the export path,
// assignments in an export file.

// exportWith builds an export file with n tags, each with the given rules.
func exportWith(n int, rules string) string {
	var b strings.Builder
	b.WriteString(`{"format":"chipper-tags","version":1,"tags":[`)
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"name":"t%d","rules":%s}`, i, rules)
	}
	b.WriteString("]}")
	return b.String()
}

func rulesJSON(n int, pattern, label string) string {
	parts := make([]string, n)
	for i := range parts {
		p, _ := json.Marshal(pattern)
		l, _ := json.Marshal(label)
		parts[i] = fmt.Sprintf(`{"pattern":%s,"label":%s}`, p, l)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// 판정 med 8: limits — a file beyond any of them is refused as a whole, with why.
func TestParseTagsImportLimits(t *testing.T) {
	ok := []struct{ name, data string }{
		{"1000 tags", exportWith(1000, `[{"pattern":"a"}]`)},
		{"2000 rules", exportWith(1, rulesJSON(2000, "a", ""))},
		{"pattern 1000 chars", exportWith(1, rulesJSON(1, strings.Repeat("가", 1000), ""))},
		{"label 100 chars", exportWith(1, rulesJSON(1, "a", strings.Repeat("가", 100)))},
	}
	for _, c := range ok {
		if r := parseTagsImport([]byte(c.data)); r.Error != "" {
			t.Errorf("%s: at the limit should be fine, got %q", c.name, r.Error)
		}
	}
	bad := []struct{ name, data, want string }{
		{"1001 tags", exportWith(1001, `[]`), "태그가 너무 많습니다 (1001개"},
		{"2001 rules", exportWith(1, rulesJSON(2001, "a", "")), "규칙이 너무 많습니다 (2001개"},
		{"pattern 1001 chars", exportWith(2, rulesJSON(1, strings.Repeat("가", 1001), "")), "패턴이 너무 깁니다 (1001자"},
		{"label 101 chars", exportWith(1, rulesJSON(1, "a", strings.Repeat("a", 101))), "이름표가 너무 깁니다 (101자"},
		// the limit is checked on every tag, even one left out for its name
		{"long pattern in a badly named tag", `{"format":"chipper-tags","tags":[{"name":"ok","rules":[]},{"name":" bad","rules":` + rulesJSON(1, strings.Repeat("x", 1001), "") + `}]}`, "패턴이 너무 깁니다"},
	}
	for _, c := range bad {
		r := parseTagsImport([]byte(c.data))
		if !strings.Contains(r.Error, c.want) {
			t.Errorf("%s: error %q, want it to mention %q", c.name, r.Error, c.want)
		}
		if len(r.Tags) != 0 {
			t.Errorf("%s: a refused file hands on no tags, got %d", c.name, len(r.Tags))
		}
	}
	// 4 MB
	big := `{"format":"chipper-tags","tags":[{"name":"a","rules":[]}],"pad":"` + strings.Repeat("x", 4<<20) + `"}`
	if r := parseTagsImport([]byte(big)); !strings.Contains(r.Error, "너무 큽니다") || !strings.Contains(r.Error, "4 MB") {
		t.Errorf("over 4 MB: %q", r.Error)
	}
	// 300,000 tags (the review's case) is refused, and quickly
	if r := parseTagsImport([]byte(exportWith(300000, `[]`))); !strings.Contains(r.Error, "너무") {
		t.Errorf("300,000 tags: %q", r.Error)
	}
}

// 판정 low: trailing content after the JSON value, the EOF way (decodeOneJSON).
func TestParseTagsImportTrailingMore(t *testing.T) {
	head := `{"format":"chipper-tags","tags":[{"name":"a"}]}`
	for name, data := range map[string]string{
		"white space then garbage": head + " \r\n\t garbage",
		"two JSON values":          head + head,
		"value then number":        head + "\n1",
	} {
		if r := parseTagsImport([]byte(data)); !strings.Contains(r.Error, "뒤에 다른 내용") {
			t.Errorf("%s: error %q", name, r.Error)
		}
	}
	if r := parseTagsImport([]byte(head + " \r\n\t ")); r.Error != "" {
		t.Errorf("trailing white space only is fine: %q", r.Error)
	}
}

// 판정 med 5: the export path always ends in exactly .chipper-tags.json — the
// same rule on every OS.
func TestExportPathNormalized(t *testing.T) {
	d := filepath.Join("C:", "x") + string(filepath.Separator)
	cases := []struct{ in, out string }{
		{"collector.chipper-tags.json", "collector.chipper-tags.json"},
		{"collector", "collector.chipper-tags.json"},
		{"collector..chipper-tags.json", "collector.chipper-tags.json"},
		{"collector.CHIPPER-TAGS.JSON", "collector.chipper-tags.json"},
		{"collector..CHIPPER-TAGS.JSON", "collector.chipper-tags.json"},
		{"mine.json", "mine.chipper-tags.json"},
		{"mine.JSON", "mine.chipper-tags.json"},
		{"x..json", "x.chipper-tags.json"},
		{".json", "tags.chipper-tags.json"},
		{".chipper-tags.json", "tags.chipper-tags.json"},
		{"team. ", "team.chipper-tags.json"},
		{"v1.2 tags", "v1.2 tags.chipper-tags.json"},
		{"a.txt", "a.txt.chipper-tags.json"},
		{"수집기 태그", "수집기 태그.chipper-tags.json"},
	}
	for _, c := range cases {
		got, changed := exportPath(d + c.in)
		if got != d+c.out || changed != (c.in != c.out) {
			t.Errorf("exportPath(%q) = %q,%v want %q,%v", c.in, got, changed, d+c.out, c.in != c.out)
		}
		if again, ch := exportPath(got); again != got || ch {
			t.Errorf("exportPath is not idempotent on %q", got)
		}
	}
}

// user 결정 4: an export file may carry where its tags are attached; Go hands
// that on (the frontend decides what to take). A tags.json's assign is not.
func TestParseTagsImportAssign(t *testing.T) {
	data := `{"format":"chipper-tags","version":1,
	  "tags":[{"name":"collector","rules":[]}],
	  "assign":{"dir":{"modules/lizcollector":["collector"]},"file":{"m/c.log":["collector"]},"name":{},"future":{}}}`
	r := parseTagsImport([]byte(data))
	if r.Error != "" || len(r.Problems) != 0 {
		t.Fatalf("unexpected: %+v", r)
	}
	js, _ := json.Marshal(r)
	for _, want := range []string{`"assign":{`, `"dir":{"modules/lizcollector":["collector"]}`, `"file":{"m/c.log":["collector"]}`, `"name":{}`} {
		if !strings.Contains(string(js), want) {
			t.Errorf("assign should be handed on (%s): %s", want, js)
		}
	}
	// no assign → null
	r = parseTagsImport([]byte(`{"format":"chipper-tags","tags":[{"name":"a","rules":[]}]}`))
	if js, _ := json.Marshal(r); !strings.Contains(string(js), `"assign":null`) {
		t.Errorf("no assign → null: %s", js)
	}
	// a bad assign is left out (the tags still come), and said
	for name, a := range map[string]string{
		"not an object":    `"assign":[1]`,
		"kind not object":  `"assign":{"dir":["x"]}`,
		"names not a list": `"assign":{"dir":{"m":"collector"}}`,
		"names not text":   `"assign":{"dir":{"m":[1]}}`,
	} {
		r := parseTagsImport([]byte(`{"format":"chipper-tags","tags":[{"name":"a","rules":[]}],` + a + `}`))
		if r.Error != "" || len(r.Tags) != 1 || len(r.Problems) != 1 || !strings.Contains(r.Problems[0], "붙인 곳") {
			t.Errorf("%s: %+v", name, r)
		}
	}
}

func TestImportMaxVersion(t *testing.T) {
	if importMaxVersion(true) != tagsVersion || importMaxVersion(false) != tagsExportVersion {
		t.Fatal("a tags.json is compared with the store version, an export file with the export version")
	}
}

// 판정 med 5: confirm a replaced file the dialog didn't ask about; never export
// over chipper's own tags.json.
func TestExportTagsFlow(t *testing.T) {
	data := t.TempDir()
	out := t.TempDir()
	a := &App{dataDir: data}
	// typed "team" → team.chipper-tags.json, nothing there → written
	r, err := a.exportTags(filepath.Join(out, "team"), goodExport, false)
	want := filepath.Join(out, "team.chipper-tags.json")
	if err != nil || r.Path != want || r.Confirm {
		t.Fatalf("first export: %+v %v", r, err)
	}
	// typed "team" again → that file is there and the dialog asked about "team": confirm first
	r, err = a.exportTags(filepath.Join(out, "team"), goodExport, false)
	if err != nil || r.Path != want || !r.Confirm {
		t.Fatalf("existing final path must be confirmed: %+v %v", r, err)
	}
	// "team.json" too
	if r, _ = a.exportTags(filepath.Join(out, "team.json"), goodExport, false); !r.Confirm {
		t.Fatalf("team.json → existing team.chipper-tags.json must be confirmed: %+v", r)
	}
	// the dialog asked about this very path: no second question
	if r, _ = a.exportTags(want, goodExport, false); r.Confirm || r.Path != want {
		t.Fatalf("same path: %+v", r)
	}
	// after a yes
	changed := strings.Replace(goodExport, "kafka rebalance", "kafka 2", 1)
	if p, err := a.ExportTagsTo(want, changed); err != nil || p != want {
		t.Fatalf("ExportTagsTo: %q %v", p, err)
	}
	if r := readTagsImportFile(want); r.Error != "" || r.Tags[0].Rules[0].(map[string]any)["pattern"] != "kafka 2" {
		t.Fatalf("written: %+v", r)
	}
	// never over the tag store or its backups (also when they don't exist yet)
	for _, n := range []string{"tags.json", "tags.json.bak", "tags.json.bak2"} {
		if _, err := a.exportTags(filepath.Join(data, n), goodExport, false); err == nil || !strings.Contains(err.Error(), "태그 저장소") {
			t.Errorf("%s: should be refused, got %v", n, err)
		}
		if _, err := a.ExportTagsTo(filepath.Join(data, n), goodExport); err == nil {
			t.Errorf("ExportTagsTo %s: should be refused", n)
		}
	}
	os.WriteFile(filepath.Join(data, "tags.json"), []byte(`{"version":1,"tags":[]}`), 0o600)
	if _, err := a.exportTags(filepath.Join(data, ".", "sub", "..", "tags.json"), goodExport, false); err == nil {
		t.Error("tags.json by another spelling should be refused")
	}
	if got, _ := os.ReadFile(filepath.Join(data, "tags.json")); string(got) != `{"version":1,"tags":[]}` {
		t.Error("the tag store was changed")
	}
	// a tags.json elsewhere is just a name: written as tags.chipper-tags.json
	if r, err := a.exportTags(filepath.Join(out, "tags.json"), goodExport, false); err != nil || r.Path != filepath.Join(out, "tags.chipper-tags.json") {
		t.Fatalf("tags.json elsewhere: %+v %v", r, err)
	}
}

func TestExportNeedsConfirmSameFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.chipper-tags.json")
	os.WriteFile(p, []byte("x"), 0o644)
	if exportNeedsConfirm(p, p) {
		t.Error("same path")
	}
	upper := filepath.Join(dir, "x.CHIPPER-TAGS.JSON")
	_, err := os.Stat(upper)
	caseInsensitiveFS := err == nil
	if got := exportNeedsConfirm(upper, p); got == caseInsensitiveFS {
		t.Errorf("x.CHIPPER-TAGS.JSON → x.chipper-tags.json: confirm=%v on a case-insensitive=%v file system", got, caseInsensitiveFS)
	}
	if exportNeedsConfirm(filepath.Join(dir, "y"), filepath.Join(dir, "y.chipper-tags.json")) {
		t.Error("nothing there: no question")
	}
}

// 판정 med 6: before-import backups, newest 5 kept, listed and read back.
func TestTagsBackups(t *testing.T) {
	dir := t.TempDir()
	store := func(i int) string {
		return fmt.Sprintf(`{"version":1,"tags":[{"name":"common","rules":[]},{"name":"t%d","rules":[]}],"assign":{"dir":{"m":["t%d"]},"file":{},"name":{}}}`, i, i)
	}
	base := time.Date(2026, 10, 27, 15, 30, 12, 123e6, time.Local)
	var names []string
	for i := 0; i < 7; i++ {
		n, err := backupTagsFile(dir, "import", []byte(store(i)), base.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	if names[0] != "before-import-20261027-153012.123.json" {
		t.Errorf("name: %s", names[0])
	}
	// same millisecond: a second file, not a replaced one
	n2, _ := backupTagsFile(dir, "restore", []byte(store(9)), base)
	n3, _ := backupTagsFile(dir, "restore", []byte(store(10)), base)
	if n2 == n3 || n3 != "before-restore-20261027-153012.123-2.json" {
		t.Errorf("same millisecond: %s %s", n2, n3)
	}
	list := listTagsBackups(dir)
	var imports []string
	for _, b := range list {
		if b.Kind == "import" {
			imports = append(imports, b.File)
		}
	}
	if strings.Join(imports, ",") != strings.Join([]string{names[6], names[5], names[4], names[3], names[2]}, ",") {
		t.Errorf("newest 5 imports kept, newest first: %v", imports)
	}
	if list[0].File != names[6] || list[0].Tags != 2 || list[0].Places != 1 || list[0].Names[1] != "t6" || list[0].Time != "2026-10-27 15:30:18" {
		t.Errorf("info: %+v", list[0])
	}
	got, err := readTagsBackup(dir, names[6])
	if err != nil || got != store(6) {
		t.Fatalf("read back: %q %v", got, err)
	}
	// only backup names, nothing else
	for _, bad := range []string{"../tags.json", "tags.json", "before-import-x.json", `..\before-import-20261027-153012.123.json`} {
		if _, err := readTagsBackup(dir, bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	// what isn't a whole tag store is not backed up
	if _, err := backupTagsFile(dir, "import", []byte(`{"version":1,"tags":[]}`), base); err == nil {
		t.Error("no assign: not a whole store")
	}
	if _, err := backupTagsFile(dir, "other", []byte(store(1)), base); err == nil {
		t.Error("unknown kind")
	}
	// a newer one is listed with why, and not read back
	os.WriteFile(filepath.Join(dir, tagsBackupDir, "before-import-20300101-000000.000.json"), []byte(`{"version":9}`), 0o600)
	l2 := listTagsBackups(dir)
	if l2[0].Problem == "" {
		t.Errorf("newer: %+v", l2[0])
	}
	if _, err := readTagsBackup(dir, "before-import-20300101-000000.000.json"); tagsErrCode(err) != TagsErrNewerFormat {
		t.Errorf("newer read: %v", err)
	}
	a := &App{}
	if _, err := a.BackupTagsBefore("import", store(1)); tagsErrCode(err) != TagsErrNoDataDir {
		t.Errorf("no data dir: %v", err)
	}
}
