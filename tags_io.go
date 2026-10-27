package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Sharing log colour tags: a tag export file (<name>.chipper-tags.json) holds
// some tags and their rules — never where they are assigned:
//
//	{ "format": "chipper-tags", "version": 1, "exported": "2026-10-27T10:00:00Z",
//	  "tags": [ { "name": "collector",
//	              "rules": [ { "pattern": "kafka rebalance", "kind": "text", "color": "#c678dd", ... } ] } ] }
//
// Go reads the envelope (format, version, tag names, rules being a list) and
// hands the rules on untouched; whether a rule is usable (regex, colour, slow
// patterns) is decided by the frontend, which owns the rule semantics.
// A tags.json (version + tags, no format) is read the same way, assign ignored,
// so someone can share their whole ~/.chipper/tags.json.

const (
	tagsExportFormat  = "chipper-tags"
	tagsExportVersion = 1
	tagsExportExt     = ".chipper-tags.json"
	maxTagsExportSize = 16 << 20
)

// TagsImportTag is one importable tag: its name and its rules as written.
type TagsImportTag struct {
	Name  string `json:"name"`
	Rules []any  `json:"rules"`
}

// TagsImportFile is what one chosen file yielded. Error = the whole file was
// refused (nothing in it is used); Problems = tags that were left out.
type TagsImportFile struct {
	Path     string          `json:"path"`
	File     string          `json:"file"` // base name, for messages
	Error    string          `json:"error"`
	Tags     []TagsImportTag `json:"tags"`
	Problems []string        `json:"problems"`
	TagsJSON bool            `json:"tagsJson"` // a tags.json rather than an export file
}

// tagsDialogFilters: tag files first (on Windows the first filter also gives the
// dialog its default extension), then everything.
func tagsDialogFilters() []wruntime.FileFilter {
	out := []wruntime.FileFilter{{DisplayName: "chipper 태그 파일 (*" + tagsExportExt + ")", Pattern: dialogPattern("*" + tagsExportExt)}}
	if runtime.GOOS == "windows" {
		return append(out, wruntime.FileFilter{DisplayName: "모든 파일 (*.*)", Pattern: "*.*"})
	}
	return append(out, wruntime.FileFilter{DisplayName: "모든 파일 (*)", Pattern: "*"})
}

// parseTagsImport reads an export file (or a tags.json). It never fails as a
// Go error: problems are in the result, in Korean, for the import summary.
func parseTagsImport(data []byte) TagsImportFile {
	out := TagsImportFile{Tags: []TagsImportTag{}, Problems: []string{}}
	if len(data) > maxTagsExportSize {
		out.Error = fmt.Sprintf("파일이 너무 큽니다 (%d MB 넘음) — 태그 파일이 아닌 것 같습니다", maxTagsExportSize>>20)
		return out
	}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")) // Notepad's UTF-8 BOM
	if len(bytes.TrimSpace(data)) == 0 {
		out.Error = "빈 파일입니다"
		return out
	}
	var top map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&top); err != nil {
		var se *json.SyntaxError
		var te *json.UnmarshalTypeError
		switch {
		case errors.As(err, &te):
			out.Error = "chipper 태그 파일이 아닙니다 (맨 바깥이 { } 가 아님)"
		case errors.As(err, &se):
			out.Error = fmt.Sprintf("JSON 형식이 아닙니다 (%d번째 바이트 근처: %v)", se.Offset, se)
		default:
			out.Error = "JSON 형식이 아닙니다: " + err.Error()
		}
		return out
	}
	if dec.More() {
		out.Error = "JSON 뒤에 다른 내용이 붙어 있습니다"
		return out
	}
	if top == nil {
		out.Error = "chipper 태그 파일이 아닙니다 (맨 바깥이 { } 가 아님)"
		return out
	}
	if raw, ok := top["format"]; ok {
		var f string
		if json.Unmarshal(raw, &f) != nil || f != tagsExportFormat {
			out.Error = fmt.Sprintf("chipper 태그 파일이 아닙니다 (format 이 %q 가 아님: %s)", tagsExportFormat, clip(string(raw), 40))
			return out
		}
	} else if _, hasTags := top["tags"]; hasTags {
		if _, hasVer := top["version"]; hasVer {
			out.TagsJSON = true // someone's tags.json: tags are read, assign is not
		}
	}
	if _, ok := top["format"]; !ok && !out.TagsJSON {
		out.Error = fmt.Sprintf("chipper 태그 파일이 아닙니다 (\"format\": %q 가 없음)", tagsExportFormat)
		return out
	}
	if raw, ok := top["version"]; ok {
		var v float64
		if json.Unmarshal(raw, &v) != nil || v != float64(int(v)) || v < 1 {
			out.Error = "version 이 1 이상의 정수가 아닙니다: " + clip(string(raw), 20)
			return out
		}
		if int(v) > tagsExportVersion {
			out.Error = fmt.Sprintf("더 새 버전의 chipper 가 만든 태그 파일입니다 (version %d) — chipper 를 업데이트한 뒤 가져오세요", int(v))
			return out
		}
	}
	raw, ok := top["tags"]
	if !ok {
		out.Error = "태그 목록(\"tags\")이 없습니다"
		return out
	}
	var tags []json.RawMessage
	if json.Unmarshal(raw, &tags) != nil {
		out.Error = "\"tags\" 가 목록([ ])이 아닙니다"
		return out
	}
	if len(tags) == 0 {
		out.Error = "태그가 하나도 없습니다"
		return out
	}
	seen := map[string]bool{}
	for i, rt := range tags {
		var t map[string]json.RawMessage
		if json.Unmarshal(rt, &t) != nil || t == nil {
			out.Problems = append(out.Problems, fmt.Sprintf("%d번째 태그: 형식이 잘못돼 뺐습니다", i+1))
			continue
		}
		var name string
		if json.Unmarshal(t["name"], &name) != nil {
			out.Problems = append(out.Problems, fmt.Sprintf("%d번째 태그: 이름(name)이 없거나 글자가 아니라 뺐습니다", i+1))
			continue
		}
		name, p := importTagName(name)
		if p != "" {
			out.Problems = append(out.Problems, fmt.Sprintf("%d번째 태그 %s: %s — 뺐습니다", i+1, quoteName(name), p))
			continue
		}
		if seen[name] { // case-sensitive, like the store
			out.Problems = append(out.Problems, fmt.Sprintf("태그 %s 가 이 파일에 두 번 있어 첫 번째만 가져옵니다", quoteName(name)))
			continue
		}
		rules := []any{}
		if rr, ok := t["rules"]; ok && !bytes.Equal(bytes.TrimSpace(rr), []byte("null")) {
			if json.Unmarshal(rr, &rules) != nil {
				out.Problems = append(out.Problems, fmt.Sprintf("태그 %s: 규칙(rules)이 목록이 아니라 뺐습니다", quoteName(name)))
				continue
			}
			if rules == nil {
				rules = []any{}
			}
		}
		seen[name] = true
		out.Tags = append(out.Tags, TagsImportTag{Name: name, Rules: rules})
	}
	if len(out.Tags) == 0 && out.Error == "" {
		out.Error = "가져올 수 있는 태그가 없습니다"
	}
	return out
}

// importTagName is the one place an imported tag name is checked (and, once
// the store normalizes names, normalized) — the same rule as tags.json names.
// MERGE NOTE: when stage 3's name normalization (NFC; zero-width, bidi
// control and BOM characters refused) lands, call it here and return the
// normalized name.
func importTagName(name string) (string, string) {
	return name, tagNameProblem(name)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// quoteName shows a tag name in a message: 「name」, with odd characters escaped.
func quoteName(name string) string {
	q := fmt.Sprintf("%q", clip(name, 60))
	return "「" + q[1:len(q)-1] + "」"
}

// readTagsImportFile reads and parses one file to import.
func readTagsImportFile(path string) TagsImportFile {
	var out TagsImportFile
	st, err := os.Stat(path)
	switch {
	case err != nil:
		out = TagsImportFile{Tags: []TagsImportTag{}, Problems: []string{}, Error: "파일을 읽지 못했습니다: " + err.Error()}
	case st.IsDir():
		out = TagsImportFile{Tags: []TagsImportTag{}, Problems: []string{}, Error: "폴더입니다"}
	case st.Size() > maxTagsExportSize:
		out = parseTagsImport(make([]byte, maxTagsExportSize+1)) // the size message
	default:
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			out = TagsImportFile{Tags: []TagsImportTag{}, Problems: []string{}, Error: "파일을 읽지 못했습니다: " + rerr.Error()}
		} else {
			out = parseTagsImport(data)
		}
	}
	out.Path = path
	out.File = filepath.Base(path)
	return out
}

// exportPath fixes up a path from the save dialog: no extension → the tag file
// extension; Windows' default-extension quirk ("x..chipper-tags.json") undone.
// appended reports whether we changed the name (the dialog's own "replace?"
// question then did not cover the final path).
func exportPath(p string) (string, bool) {
	dir, base := filepath.Split(p)
	if i := strings.Index(strings.ToLower(base), "."+tagsExportExt); i >= 0 && strings.EqualFold(base[i+1:], tagsExportExt) {
		base = base[:i] + base[i+1:]
		return dir + base, false
	}
	if !strings.HasSuffix(strings.ToLower(base), ".json") {
		return p + tagsExportExt, true
	}
	return p, false
}

// writeTagsExportFile checks that data is a tag export file and writes it
// atomically to path.
func writeTagsExportFile(path, data string) error {
	parsed := parseTagsImport([]byte(data))
	if parsed.Error != "" || parsed.TagsJSON {
		msg := parsed.Error
		if msg == "" {
			msg = "format 이 없음"
		}
		return errors.New("내보낼 내용이 태그 파일 형식이 아닙니다: " + msg)
	}
	if len(parsed.Problems) > 0 {
		return errors.New("내보낼 내용에 잘못된 태그가 있습니다: " + strings.Join(parsed.Problems, "; "))
	}
	return atomicWrite(path, []byte(data), 0o644)
}

// ExportTagsDialog asks where to save a tag export file (defaultName is offered)
// and writes data there. Returns the path written, "" when canceled.
func (a *App) ExportTagsDialog(defaultName, data string) (string, error) {
	path, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:                "태그 내보내기",
		DefaultFilename:      defaultName,
		Filters:              tagsDialogFilters(),
		CanCreateDirectories: true,
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	final, appended := exportPath(path)
	if appended {
		if _, serr := os.Stat(final); serr == nil {
			return "", fmt.Errorf("「%s」 파일이 이미 있습니다. 다른 이름으로 다시 내보내세요", filepath.Base(final))
		}
	}
	if err := writeTagsExportFile(final, data); err != nil {
		return "", err
	}
	return final, nil
}

// ImportTagsDialog lets the user pick tag files (several at once) and returns
// what each held. Empty when canceled.
func (a *App) ImportTagsDialog() ([]TagsImportFile, error) {
	paths, err := wruntime.OpenMultipleFilesDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:   "태그 가져오기 (여러 파일 선택 가능)",
		Filters: tagsDialogFilters(),
	})
	if err != nil {
		return nil, err
	}
	return a.ImportTagsFiles(paths), nil
}

// ImportTagsFiles is ImportTagsDialog without the dialog (paths already known).
func (a *App) ImportTagsFiles(paths []string) []TagsImportFile {
	out := make([]TagsImportFile, 0, len(paths))
	for _, p := range paths {
		out = append(out, readTagsImportFile(p))
	}
	return out
}
