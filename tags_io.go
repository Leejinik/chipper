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
	"unicode/utf8"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Sharing log colour tags: a tag export file (<name>.chipper-tags.json) holds
// some tags and their rules, and — only when the sender ticked 「붙인 곳도
// 같이」 — where those tags are attached:
//
//	{ "format": "chipper-tags", "version": 1, "exported": "2026-10-27T10:00:00Z",
//	  "tags": [ { "name": "collector",
//	              "rules": [ { "id": "k1", "pattern": "kafka rebalance", "kind": "text", "color": "#c678dd", ... } ] } ],
//	  "assign": { "dir": { "modules/lizcollector": ["collector"] }, "file": {}, "name": {} } }
//
// Go reads the envelope (format, version, limits, tag names, rules being a
// list, assign's shape) and hands the rest on untouched; whether a rule is
// usable (regex, colour …) and what of assign is taken is decided by the
// frontend, which owns the rule semantics and the user's own assignments.
// A tags.json (version + tags, no format) is read the same way, its assign
// ignored (its owner did not choose to share it), so someone can share their
// whole ~/.chipper/tags.json.

const (
	tagsExportFormat  = "chipper-tags"
	tagsExportVersion = 1
	tagsExportExt     = ".chipper-tags.json"
)

// Import limits (product rule; the frontend's IMPORT_LIMITS are the same): a
// file beyond any of them is refused as a whole, with why — so one wrong file
// cannot make the tag store (and every colouring after it) huge.
const (
	maxTagsExportSize = 4 << 20 // bytes
	maxImportTags     = 1000    // tags in one file
	maxImportRules    = 2000    // rules in one tag
	maxImportPattern  = 1000    // characters in one pattern
	maxImportLabel    = 100     // characters in one label
)

// TagsImportTag is one importable tag: its name and its rules as written.
type TagsImportTag struct {
	Name  string `json:"name"`
	Rules []any  `json:"rules"`
}

// TagsImportAssign is where the file says its tags are attached (keys and
// names as written; the frontend normalizes them and keeps the user's own).
type TagsImportAssign struct {
	Dir  map[string][]string `json:"dir"`
	File map[string][]string `json:"file"`
	Name map[string][]string `json:"name"`
}

// TagsImportFile is what one chosen file yielded. Error = the whole file was
// refused (nothing in it is used); Problems = tags (or assign entries) that
// were left out.
type TagsImportFile struct {
	Path     string            `json:"path"`
	File     string            `json:"file"` // base name, for messages
	Error    string            `json:"error"`
	Tags     []TagsImportTag   `json:"tags"`
	Problems []string          `json:"problems"`
	TagsJSON bool              `json:"tagsJson"` // a tags.json rather than an export file
	Assign   *TagsImportAssign `json:"assign"`   // nil = the file says nothing about it
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
	// decodeOneJSON (tags.go): one JSON value, nothing after it but white space
	// (dec.More() let a stray "}" or "]" through).
	if err := decodeOneJSON(data, &top); err != nil {
		var se *json.SyntaxError
		var te *json.UnmarshalTypeError
		switch {
		case errors.Is(err, errJSONTrailing):
			out.Error = err.Error()
		case errors.As(err, &te):
			out.Error = "chipper 태그 파일이 아닙니다 (맨 바깥이 { } 가 아님)"
		case errors.As(err, &se):
			out.Error = fmt.Sprintf("JSON 형식이 아닙니다 (%d번째 바이트 근처: %v)", se.Offset, se)
		default:
			out.Error = err.Error() // "JSON 형식이 아닙니다: …"
		}
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
		if int(v) > importMaxVersion(out.TagsJSON) {
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
	if p := importLimitProblem(tags); p != "" {
		out.Error = p
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
	if len(out.Tags) == 0 {
		out.Error = "가져올 수 있는 태그가 없습니다"
		return out
	}
	if raw, ok := top["assign"]; ok && !out.TagsJSON && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		out.Assign = parseImportAssign(raw, &out.Problems)
	}
	return out
}

// importMaxVersion: an export file is compared with the export format's
// version, someone's tags.json with the tag store's (tags.go tagsVersion).
func importMaxVersion(tagsJSON bool) int {
	if tagsJSON {
		return tagsVersion
	}
	return tagsExportVersion
}

// importLimitProblem checks the limits on every tag of the file (also on tags
// that are left out later for their name); "" when within them.
func importLimitProblem(tags []json.RawMessage) string {
	if len(tags) > maxImportTags {
		return fmt.Sprintf("태그가 너무 많습니다 (%d개, 한 파일에 %d개까지) — 이 파일은 가져오지 않습니다", len(tags), maxImportTags)
	}
	for i, rt := range tags {
		var t struct {
			Name  any               `json:"name"`
			Rules []json.RawMessage `json:"rules"`
		}
		if json.Unmarshal(rt, &t) != nil {
			continue // not a tag with a rule list: reported per tag later
		}
		who := fmt.Sprintf("%d번째 태그", i+1)
		if n, ok := t.Name.(string); ok {
			who = "태그 " + quoteName(n)
		}
		if len(t.Rules) > maxImportRules {
			return fmt.Sprintf("%s 의 규칙이 너무 많습니다 (%d개, 태그 하나에 %d개까지) — 이 파일은 가져오지 않습니다", who, len(t.Rules), maxImportRules)
		}
		for j, rr := range t.Rules {
			var r struct {
				Pattern any `json:"pattern"`
				Label   any `json:"label"`
			}
			if json.Unmarshal(rr, &r) != nil {
				continue
			}
			if p, ok := r.Pattern.(string); ok && utf8.RuneCountInString(p) > maxImportPattern {
				return fmt.Sprintf("%s 의 %d번째 규칙: 패턴이 너무 깁니다 (%d자, %d자까지) — 이 파일은 가져오지 않습니다", who, j+1, utf8.RuneCountInString(p), maxImportPattern)
			}
			if l, ok := r.Label.(string); ok && utf8.RuneCountInString(l) > maxImportLabel {
				return fmt.Sprintf("%s 의 %d번째 규칙: 이름표가 너무 깁니다 (%d자, %d자까지) — 이 파일은 가져오지 않습니다", who, j+1, utf8.RuneCountInString(l), maxImportLabel)
			}
		}
	}
	return ""
}

// parseImportAssign reads an export file's "assign": { dir|file|name: { key: [names] } }.
// What has the wrong shape is left out and said in problems; other kinds are ignored.
func parseImportAssign(raw json.RawMessage, problems *[]string) *TagsImportAssign {
	var kinds map[string]json.RawMessage
	if json.Unmarshal(raw, &kinds) != nil || kinds == nil {
		*problems = append(*problems, "붙인 곳(assign)이 { } 형식이 아니라 뺐습니다")
		return nil
	}
	out := &TagsImportAssign{Dir: map[string][]string{}, File: map[string][]string{}, Name: map[string][]string{}}
	for _, k := range []struct {
		name string
		m    map[string][]string
	}{{"dir", out.Dir}, {"file", out.File}, {"name", out.Name}} {
		rk, ok := kinds[k.name]
		if !ok || bytes.Equal(bytes.TrimSpace(rk), []byte("null")) {
			continue
		}
		var entries map[string]json.RawMessage
		if json.Unmarshal(rk, &entries) != nil || entries == nil {
			*problems = append(*problems, fmt.Sprintf("붙인 곳(assign.%s)이 { } 형식이 아니라 뺐습니다", k.name))
			continue
		}
		for key, rv := range entries {
			var names []string
			if json.Unmarshal(rv, &names) != nil || names == nil {
				*problems = append(*problems, fmt.Sprintf("붙인 곳 %s %q: 태그 이름 목록이 아니라 뺐습니다", k.name, clip(key, 60)))
				continue
			}
			k.m[key] = names
		}
	}
	return out
}

// importTagName is the one place an imported tag name is checked and
// normalized — the same rule as tags.json names (tags.go: NFC first, then
// tagNameProblem refuses zero-width, bidi control and BOM characters …).
func importTagName(name string) (string, string) {
	name = normalizeTagName(name)
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

// exportPath turns the path the save dialog returned into the file written:
// always <stem>.chipper-tags.json in lower case, whatever was typed — "x",
// "x.json", ".json", "x..json" (Windows' default-extension quirk),
// "x.CHIPPER-TAGS.JSON" — and the same on every OS (GTK adds no extension).
// changed reports that this is not the path the dialog asked about (its own
// 「replace?」 question then did not cover the final path).
func exportPath(p string) (final string, changed bool) {
	dir, base := filepath.Split(p)
	hasExt := func(s, ext string) bool { return len(s) >= len(ext) && strings.EqualFold(s[len(s)-len(ext):], ext) }
	stem := base
	switch {
	case hasExt(stem, tagsExportExt):
		stem = stem[:len(stem)-len(tagsExportExt)]
	case hasExt(stem, ".json"):
		stem = stem[:len(stem)-len(".json")]
	}
	stem = strings.TrimRight(stem, ". ") // Windows drops trailing dots and spaces anyway
	if stem == "" {
		stem = "tags"
	}
	final = dir + stem + tagsExportExt
	return final, final != p
}

// exportNeedsConfirm: the final path is not the one the dialog asked about,
// and a file is already there — unless it is the very same file under another
// spelling (a case-insensitive file system), which the dialog did ask about.
func exportNeedsConfirm(asked, final string) bool {
	if asked == final {
		return false
	}
	fst, err := os.Stat(final)
	if err != nil {
		return false // nothing there (anything else: the write says so)
	}
	if ast, err := os.Stat(asked); err == nil && os.SameFile(ast, fst) {
		return false
	}
	return true
}

// isTagsStorePath: p is chipper's own tag store (tags.json or a backup of it)
// in dataDir — never a place to export to.
func isTagsStorePath(dataDir, p string) bool {
	if dataDir == "" || p == "" {
		return false
	}
	for _, n := range append([]string{tagsFileName}, tagsBackups...) {
		if samePath(p, filepath.Join(dataDir, n)) {
			return true
		}
	}
	return false
}

// samePath: the same file (when both exist), else the same cleaned path —
// ignoring case where file names do (Windows, macOS).
func samePath(a, b string) bool {
	if as, err := os.Stat(a); err == nil {
		if bs, err := os.Stat(b); err == nil {
			return os.SameFile(as, bs)
		}
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
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

// TagsExportResult: Path written — or, with Confirm, the path that already
// holds a file the save dialog did not ask about; nothing is written until the
// frontend asks the user and calls ExportTagsTo(Path, data).
type TagsExportResult struct {
	Path    string `json:"path"`
	Confirm bool   `json:"confirm"`
}

// ExportTagsDialog asks where to save a tag export file (defaultName is
// offered) and writes data there. Path "" when canceled.
func (a *App) ExportTagsDialog(defaultName, data string) (TagsExportResult, error) {
	path, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:                "태그 내보내기",
		DefaultFilename:      defaultName,
		Filters:              tagsDialogFilters(),
		CanCreateDirectories: true,
	})
	if err != nil {
		return TagsExportResult{}, err
	}
	if path == "" {
		return TagsExportResult{}, nil
	}
	return a.exportTags(path, data, false)
}

// ExportTagsTo writes the export after the user said yes to replacing the
// file ExportTagsDialog reported (Confirm). Returns the path written.
func (a *App) ExportTagsTo(path, data string) (string, error) {
	r, err := a.exportTags(path, data, true)
	return r.Path, err
}

func (a *App) exportTags(asked, data string, confirmed bool) (TagsExportResult, error) {
	if isTagsStorePath(a.dataDir, asked) {
		return TagsExportResult{}, errors.New("chipper 의 태그 저장소(tags.json)에는 내보낼 수 없습니다 — 다른 곳을 고르세요")
	}
	final, _ := exportPath(asked)
	if !confirmed && exportNeedsConfirm(asked, final) {
		return TagsExportResult{Path: final, Confirm: true}, nil
	}
	if err := writeTagsExportFile(final, data); err != nil {
		return TagsExportResult{}, err
	}
	return TagsExportResult{Path: final}, nil
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
