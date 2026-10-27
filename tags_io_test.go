package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodExport = `{
  "format": "chipper-tags", "version": 1, "exported": "2026-10-27T01:00:00Z",
  "tags": [
    { "name": "collector", "rules": [ { "pattern": "kafka rebalance", "kind": "text", "color": "#c678dd" } ] },
    { "name": "Collector", "rules": [] },
    { "name": "common" }
  ]
}`

func TestParseTagsImportGood(t *testing.T) {
	r := parseTagsImport([]byte(goodExport))
	if r.Error != "" || len(r.Problems) != 0 || r.TagsJSON {
		t.Fatalf("unexpected: %+v", r)
	}
	if len(r.Tags) != 3 || r.Tags[0].Name != "collector" || r.Tags[1].Name != "Collector" || r.Tags[2].Name != "common" {
		t.Fatalf("tags: %+v", r.Tags)
	}
	if r.Tags[2].Rules == nil || len(r.Tags[2].Rules) != 0 {
		t.Fatalf("missing rules should be [] not nil: %#v", r.Tags[2].Rules)
	}
	rule, _ := r.Tags[0].Rules[0].(map[string]any)
	if rule["pattern"] != "kafka rebalance" || rule["kind"] != "text" {
		t.Fatalf("rule passed through wrongly: %#v", r.Tags[0].Rules[0])
	}
	// the JSON the frontend gets: rules are a list even when empty
	js, _ := json.Marshal(r)
	if !strings.Contains(string(js), `"name":"common","rules":[]`) {
		t.Fatalf("json: %s", js)
	}
}

func TestParseTagsImportUnknownFieldsAndBOM(t *testing.T) {
	data := "\xef\xbb\xbf" + `{"format":"chipper-tags","version":1,"futureThing":{"a":1},
	  "tags":[{"name":"x","colourScheme":"dark","assign":["modules"],"rules":[{"pattern":"a","shiny":true}]}]}`
	r := parseTagsImport([]byte(data))
	if r.Error != "" || len(r.Tags) != 1 || len(r.Problems) != 0 {
		t.Fatalf("unknown fields / BOM should be ignored: %+v", r)
	}
	if m := r.Tags[0].Rules[0].(map[string]any); m["shiny"] != true {
		t.Fatalf("rule fields are passed on as written (frontend ignores unknown ones): %#v", m)
	}
	// version may be left out of a hand-made file
	r = parseTagsImport([]byte(`{"format":"chipper-tags","tags":[{"name":"a","rules":[]}]}`))
	if r.Error != "" || len(r.Tags) != 1 {
		t.Fatalf("no version: %+v", r)
	}
}

func TestParseTagsImportWholeFileErrors(t *testing.T) {
	cases := []struct{ name, data, want string }{
		{"empty", "", "빈 파일"},
		{"blank", " \r\n\t", "빈 파일"},
		{"bom only", "\xef\xbb\xbf\n", "빈 파일"},
		{"not json", "collector: kafka rebalance", "JSON 형식이 아닙니다"},
		{"truncated", `{"format":"chipper-tags","tags":[`, "JSON 형식이 아닙니다"},
		{"array", `[{"name":"a"}]`, "맨 바깥이 { } 가 아님"},
		{"string", `"chipper-tags"`, "맨 바깥이 { } 가 아님"},
		{"null", `null`, "맨 바깥이 { } 가 아님"},
		{"trailing", `{"format":"chipper-tags","tags":[{"name":"a"}]} {}`, "뒤에 다른 내용"},
		{"other format", `{"format":"vscode-theme","tags":[{"name":"a"}]}`, "format 이"},
		{"format not string", `{"format":1,"tags":[{"name":"a"}]}`, "format 이"},
		{"no format, no version", `{"tags":[{"name":"a"}]}`, `"format": "chipper-tags" 가 없음`},
		{"some other json", `{"name":"package","version":"1.0.0"}`, `"format": "chipper-tags" 가 없음`},
		{"newer", `{"format":"chipper-tags","version":2,"tags":[{"name":"a"}]}`, "더 새 버전"},
		{"version 0", `{"format":"chipper-tags","version":0,"tags":[{"name":"a"}]}`, "version 이"},
		{"version 1.5", `{"format":"chipper-tags","version":1.5,"tags":[{"name":"a"}]}`, "version 이"},
		{"version text", `{"format":"chipper-tags","version":"1","tags":[{"name":"a"}]}`, "version 이"},
		{"no tags", `{"format":"chipper-tags","version":1}`, "태그 목록"},
		{"tags object", `{"format":"chipper-tags","version":1,"tags":{"a":[]}}`, "목록([ ])이 아닙니다"},
		{"tags empty", `{"format":"chipper-tags","version":1,"tags":[]}`, "하나도 없습니다"},
		{"all tags bad", `{"format":"chipper-tags","version":1,"tags":[{"name":""},{"rules":[]}]}`, "가져올 수 있는 태그가 없습니다"},
	}
	for _, c := range cases {
		r := parseTagsImport([]byte(c.data))
		if !strings.Contains(r.Error, c.want) {
			t.Errorf("%s: error %q, want it to mention %q", c.name, r.Error, c.want)
		}
		if r.Tags == nil || r.Problems == nil {
			t.Errorf("%s: Tags/Problems must be non-nil lists", c.name)
		}
	}
	big := parseTagsImport(make([]byte, maxTagsExportSize+1))
	if !strings.Contains(big.Error, "너무 큽니다") {
		t.Errorf("big: %q", big.Error)
	}
}

func TestParseTagsImportOddNames(t *testing.T) {
	data := `{"format":"chipper-tags","version":1,"tags":[
	  {"name":"ok","rules":[]},
	  {"name":"","rules":[]},
	  {"name":" lead","rules":[]},
	  {"name":"tab\there","rules":[]},
	  {"name":"line\nbreak","rules":[]},
	  {"name":"nel\u0085x","rules":[]},
	  {"name":"` + strings.Repeat("가", 101) + `","rules":[]},
	  {"name":42,"rules":[]},
	  {"rules":[]},
	  "just a string",
	  {"name":"ok","rules":[{"pattern":"second"}]},
	  {"name":"OK","rules":[]},
	  {"name":"bad rules","rules":{"pattern":"x"}},
	  {"name":"null rules","rules":null},
	  {"name":"슬래시/와:콜론*?","rules":[]},
	  {"name":"이모지 🏷","rules":[]}
	]}`
	r := parseTagsImport([]byte(data))
	if r.Error != "" {
		t.Fatalf("error: %s", r.Error)
	}
	var names []string
	for _, tg := range r.Tags {
		names = append(names, tg.Name)
	}
	want := []string{"ok", "OK", "null rules", "슬래시/와:콜론*?", "이모지 🏷"}
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Fatalf("kept %q, want %q", names, want)
	}
	if len(r.Tags[0].Rules) != 0 {
		t.Fatalf("first of a duplicate name is kept: %#v", r.Tags[0].Rules)
	}
	if len(r.Problems) != 11 {
		t.Fatalf("problems (%d): %q", len(r.Problems), r.Problems)
	}
	joined := strings.Join(r.Problems, "\n")
	for _, want := range []string{"비어 있습니다", "공백", "제어 문자", "100자", "이름(name)이 없거나", "형식이 잘못돼", "두 번 있어", "목록이 아니라", `「tab\there」`} {
		if !strings.Contains(joined, want) {
			t.Errorf("problems should mention %q:\n%s", want, joined)
		}
	}
}

func TestParseTagsImportTagsJSON(t *testing.T) {
	// someone's whole ~/.chipper/tags.json: tags read, assign ignored
	data := `{"version":1,"tags":[{"name":"common","rules":[],"updated":"x"},{"name":"collector","rules":[]}],
	  "assign":{"dir":{"modules/lizcollector":["collector"]},"file":{},"name":{}}}`
	r := parseTagsImport([]byte(data))
	if r.Error != "" || !r.TagsJSON || len(r.Tags) != 2 {
		t.Fatalf("tags.json: %+v", r)
	}
	js, _ := json.Marshal(r)
	if strings.Contains(string(js), "lizcollector") {
		t.Fatalf("assign must not be passed on: %s", js)
	}
}

func TestExportPath(t *testing.T) {
	sep := string(filepath.Separator)
	d := "C:" + sep + "x" + sep
	cases := []struct {
		in, out  string
		appended bool
	}{
		{d + "collector.chipper-tags.json", d + "collector.chipper-tags.json", false},
		{d + "collector", d + "collector.chipper-tags.json", true},
		{d + "collector..chipper-tags.json", d + "collector.chipper-tags.json", false},
		{d + "collector..CHIPPER-TAGS.JSON", d + "collector.CHIPPER-TAGS.JSON", false},
		{d + "mine.json", d + "mine.json", false},
		{d + "v1.2 tags", d + "v1.2 tags.chipper-tags.json", true},
	}
	for _, c := range cases {
		got, app := exportPath(c.in)
		if got != c.out || app != c.appended {
			t.Errorf("exportPath(%q) = %q,%v want %q,%v", c.in, got, app, c.out, c.appended)
		}
	}
}

func TestWriteTagsExportFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "collector.chipper-tags.json")
	if err := writeTagsExportFile(p, goodExport); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if string(got) != goodExport {
		t.Fatalf("written content differs")
	}
	// replacing keeps no temp files and reads back the same
	if err := writeTagsExportFile(p, strings.Replace(goodExport, "kafka rebalance", "kafka rebalance 2", 1)); err != nil {
		t.Fatal(err)
	}
	r := readTagsImportFile(p)
	if r.Error != "" || r.File != "collector.chipper-tags.json" || r.Path != p {
		t.Fatalf("read back: %+v", r)
	}
	if m := r.Tags[0].Rules[0].(map[string]any); m["pattern"] != "kafka rebalance 2" {
		t.Fatalf("read back rule: %#v", m)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("temp files left: %v", ents)
	}
	// not a tag export → refused, the file on disk untouched
	for _, bad := range []string{"", "{}", `{"version":1,"tags":[{"name":"a"}]}`, `{"format":"chipper-tags","tags":[{"name":" x"}]}`} {
		if err := writeTagsExportFile(p, bad); err == nil {
			t.Errorf("writeTagsExportFile(%q) should be refused", bad)
		}
	}
	again, _ := os.ReadFile(p)
	if !strings.Contains(string(again), "kafka rebalance 2") {
		t.Fatalf("refused write changed the file")
	}
	// into a folder that doesn't exist → error, nothing created
	if err := writeTagsExportFile(filepath.Join(dir, "nope", "x.chipper-tags.json"), goodExport); err == nil {
		t.Fatal("missing folder should fail")
	}
}

func TestReadTagsImportFileErrors(t *testing.T) {
	dir := t.TempDir()
	if r := readTagsImportFile(filepath.Join(dir, "missing.chipper-tags.json")); !strings.Contains(r.Error, "읽지 못했습니다") || r.File != "missing.chipper-tags.json" {
		t.Errorf("missing: %+v", r)
	}
	if r := readTagsImportFile(dir); r.Error != "폴더입니다" {
		t.Errorf("dir: %+v", r)
	}
	empty := filepath.Join(dir, "empty.chipper-tags.json")
	os.WriteFile(empty, nil, 0o644)
	if r := readTagsImportFile(empty); r.Error != "빈 파일입니다" {
		t.Errorf("empty: %+v", r)
	}
	a := &App{}
	files := a.ImportTagsFiles([]string{empty, filepath.Join(dir, "missing")})
	if len(files) != 2 || files[0].Error == "" || files[1].Error == "" {
		t.Errorf("ImportTagsFiles: %+v", files)
	}
	if got := a.ImportTagsFiles(nil); got == nil || len(got) != 0 {
		t.Errorf("no paths → empty list, got %#v", got)
	}
}
