package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Log colour tags live in one file, ~/.chipper/tags.json:
//
//	{ "version": 1,
//	  "tags":   [ { "name": "common", "rules": [LogRule...], "updated": "..." }, ... ],
//	  "assign": { "dir":  { "modules/lizcollector": ["collector"] },
//	              "file": { "modules/lizcollector/collector.log.*": ["admin"] },
//	              "name": { "messages": ["syslog"] } } }
//
// One file rather than one per tag: Windows file names are case-insensitive,
// and tag names are not ("collector" and "Collector" are two tags).
//
// Go only guards the envelope (shape, version, tag names); rule contents are
// the frontend's business and are stored exactly as sent.

const (
	tagsFileName   = "tags.json"
	tagsVersion    = 1
	maxTagNameLen  = 100 // product rule (characters = code points), same as the frontend
	tagsBrokenStem = "tags.broken-"
)

// The backups kept next to tags.json, newest first: every save that changes
// the file moves .bak to .bak2 and the replaced version to .bak.
var tagsBackups = []string{tagsFileName + ".bak", tagsFileName + ".bak2"}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// TagsLoad is what LoadTags hands the frontend.
type TagsLoad struct {
	Data         string `json:"data"`         // file contents without a BOM ("" = nothing usable on disk)
	Exists       bool   `json:"exists"`       // a tags.json (or a backup) was found and is usable
	Restored     bool   `json:"restored"`     // Data came from a backup because tags.json was broken
	RestoredFrom string `json:"restoredFrom"` // that backup's file name (tags.json.bak / tags.json.bak2)
	Broken       string `json:"broken"`       // where an unreadable tags.json was moved ("" = it wasn't)
	Problem      string `json:"problem"`      // why it was considered broken
	Newer        bool   `json:"newer"`        // written by a newer chipper: show, but don't save over it
}

type tagsEnvelope struct {
	Version json.RawMessage   `json:"version"`
	Tags    []tagsEnvelopeTag `json:"tags"`
	Assign  *struct {
		Dir  map[string][]string `json:"dir"`
		File map[string][]string `json:"file"`
		Name map[string][]string `json:"name"`
	} `json:"assign"`
}

type tagsEnvelopeTag struct {
	Name  string          `json:"name"`
	Rules json.RawMessage `json:"rules"`
}

var tagsMu sync.Mutex // serializes tags.json reads/writes

// Error codes of SaveTags. The error text starts with "[CODE] " so the
// frontend can tell the cases apart without matching Korean words
// (logTags.ts tagsErrorCode / TAGS_ERR use the same codes).
const (
	TagsErrInvalid     = "TAGS_INVALID"       // the data sent is not a valid tag store
	TagsErrNewerFormat = "TAGS_NEWER_FORMAT"  // the data sent has a version this build doesn't know
	TagsErrNewerOnDisk = "TAGS_NEWER_ON_DISK" // tags.json on disk was written by a newer chipper
	TagsErrBackup      = "TAGS_BACKUP_FAILED" // .bak/.bak2 could not be kept, so nothing was written
	TagsErrNoDataDir   = "TAGS_NO_DATA_DIR"   // no ~/.chipper
)

// TagsError is an error with one of the codes above.
type TagsError struct {
	Code string
	Msg  string
	Err  error // cause, may be nil
}

func (e *TagsError) Error() string {
	if e.Err != nil {
		return "[" + e.Code + "] " + e.Msg + ": " + e.Err.Error()
	}
	return "[" + e.Code + "] " + e.Msg
}
func (e *TagsError) Unwrap() error { return e.Err }

// tagsErrCode returns the code of a TagsError ("" for any other error).
func tagsErrCode(err error) string {
	var te *TagsError
	if errors.As(err, &te) {
		return te.Code
	}
	return ""
}

// trimBOM drops a leading UTF-8 BOM (Notepad, PowerShell).
func trimBOM(b []byte) []byte { return bytes.TrimPrefix(b, utf8BOM) }

// decodeOneJSON decodes data into v and requires that it is exactly one JSON
// value: anything after it but white space is an error. A second Decode must
// hit io.EOF — json.Decoder.More() is no such test at the top level (it says
// "nothing more" before a stray "}" or "]"). Shared by tags.json loading and
// the import of an exported tag file (stage 5).
func decodeOneJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("JSON 형식이 아닙니다: %v", err)
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("JSON 뒤에 다른 내용이 붙어 있습니다")
	}
	return nil
}

// normalizeTagName returns name in the form tags.json keeps (Unicode NFC) —
// the frontend's normalizeTagName. tagNameProblem refuses names not in it.
func normalizeTagName(name string) string { return norm.NFC.String(name) }

// isTagSpace: white space not allowed at either end of a name — Go's
// unicode.IsSpace plus what JavaScript's trim() removes (U+FEFF), spelled out
// so the frontend (logTags.ts WS) uses the very same set.
func isTagSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// tagNameProblem returns why name can't be a tag name ("" = fine). Same rules,
// in the same order, as the frontend's tagNameProblem (logTags.ts): not empty,
// at most 100 characters, no white space at the ends, no control characters
// (Cc), no invisible characters (Cf: zero-width, direction marks/overrides,
// BOM…; Zl, Zp), and NFC.
func tagNameProblem(name string) string {
	if name == "" {
		return "태그 이름이 비어 있습니다"
	}
	if !utf8.ValidString(name) {
		return "태그 이름이 올바른 UTF-8 글자가 아닙니다"
	}
	if utf8.RuneCountInString(name) > maxTagNameLen {
		return fmt.Sprintf("태그 이름은 %d자까지입니다", maxTagNameLen)
	}
	first, _ := utf8.DecodeRuneInString(name)
	last, _ := utf8.DecodeLastRuneInString(name)
	if isTagSpace(first) || isTagSpace(last) {
		return "태그 이름 앞뒤에 공백을 둘 수 없습니다"
	}
	for _, r := range name {
		if unicode.Is(unicode.Cc, r) {
			return "태그 이름에 제어 문자(줄바꿈·탭 등)를 쓸 수 없습니다"
		}
	}
	for _, r := range name {
		if unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			return "태그 이름에 보이지 않는 글자(폭 없는 문자·방향 제어 문자 등)를 쓸 수 없습니다"
		}
	}
	if !norm.NFC.IsNormalString(name) {
		return "태그 이름이 NFC 로 정규화되어 있지 않습니다"
	}
	return ""
}

// parseTags checks the envelope. newer = version above what this build knows
// (the envelope is then not checked further).
//
// strict (a save from the frontend, which always writes the full shape): tags
// and assign must be there and every name must pass tagNameProblem, no name
// twice. Loading is lenient about names — the frontend repairs a bad or
// repeated name (repairTagName) rather than losing the tag, so such a file is
// not "broken". A UTF-8 BOM is skipped; version may be written 1 or 1.0.
func parseTags(data []byte, strict bool) (newer bool, err error) {
	var env tagsEnvelope
	if err := decodeOneJSON(trimBOM(data), &env); err != nil {
		return false, err
	}
	if len(env.Version) == 0 || bytes.Equal(env.Version, []byte("null")) {
		return false, errors.New("version 이 없습니다")
	}
	v, verr := strconv.ParseFloat(string(env.Version), 64)
	if verr != nil || v != math.Trunc(v) || math.IsInf(v, 0) {
		return false, errors.New("version 이 정수가 아닙니다")
	}
	if v < 1 {
		return false, errors.New("version 이 1보다 작습니다")
	}
	if v > tagsVersion {
		return true, nil
	}
	if strict {
		if env.Tags == nil {
			return false, errors.New("tags 가 없습니다")
		}
		if env.Assign == nil || env.Assign.Dir == nil || env.Assign.File == nil || env.Assign.Name == nil {
			return false, errors.New("assign(dir·file·name) 이 없습니다")
		}
	}
	seen := make(map[string]bool, len(env.Tags))
	for i, t := range env.Tags {
		if strict {
			if p := tagNameProblem(t.Name); p != "" {
				return false, fmt.Errorf("%d번째 태그 %q: %s", i+1, t.Name, p)
			}
			if seen[t.Name] { // case-sensitive: "collector" and "Collector" may coexist
				return false, fmt.Errorf("태그 이름 %q 이 두 번 있습니다", t.Name)
			}
			seen[t.Name] = true
		}
		if len(t.Rules) > 0 && !bytes.Equal(bytes.TrimSpace(t.Rules), []byte("null")) {
			var arr []json.RawMessage
			if err := json.Unmarshal(t.Rules, &arr); err != nil {
				return false, fmt.Errorf("태그 %q 의 rules 가 배열이 아닙니다", t.Name)
			}
		}
	}
	return false, nil
}

// loadTagsFile reads dir/tags.json. A file that can't be parsed is never
// deleted: it is moved aside to tags.broken-<time>.json and the newest usable
// backup (tags.json.bak, then tags.json.bak2) is offered instead.
func loadTagsFile(dir string, now time.Time) (TagsLoad, error) {
	tagsMu.Lock()
	defer tagsMu.Unlock()
	p := filepath.Join(dir, tagsFileName)
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return TagsLoad{}, nil
		}
		return TagsLoad{}, err
	}
	newer, perr := parseTags(data, false)
	if perr == nil {
		return TagsLoad{Data: string(trimBOM(data)), Exists: true, Newer: newer}, nil
	}
	out := TagsLoad{Problem: perr.Error()}
	broken := filepath.Join(dir, tagsBrokenStem+now.Format("20060102-150405")+".json")
	for i := 2; ; i++ { // never clobber an earlier broken copy
		if _, serr := os.Stat(broken); os.IsNotExist(serr) {
			break
		}
		broken = filepath.Join(dir, fmt.Sprintf("%s%s-%d.json", tagsBrokenStem, now.Format("20060102-150405"), i))
	}
	if err := os.Rename(p, broken); err != nil {
		return TagsLoad{}, fmt.Errorf("깨진 태그 파일을 옮기지 못했습니다: %w", err)
	}
	out.Broken = broken
	for _, name := range tagsBackups {
		bak, berr := os.ReadFile(filepath.Join(dir, name))
		if berr != nil {
			continue
		}
		if bnewer, e := parseTags(bak, false); e == nil {
			out.Data, out.Exists, out.Restored, out.RestoredFrom, out.Newer = string(trimBOM(bak)), true, true, name, bnewer
			break
		}
	}
	return out, nil
}

// saveTagsFile replaces dir/tags.json atomically, keeping the version it
// replaces as tags.json.bak (and the one before as tags.json.bak2). Unchanged
// content is not rewritten (so the backups stay real changes behind). A file
// written by a newer chipper is never replaced.
func saveTagsFile(dir string, data []byte) error {
	newer, err := parseTags(data, true)
	if err != nil {
		return &TagsError{TagsErrInvalid, "태그 파일 형식이 잘못돼 저장하지 않았습니다", err}
	}
	if newer {
		return &TagsError{TagsErrNewerFormat, "이 버전이 모르는 태그 파일 형식이라 저장하지 않았습니다", nil}
	}
	tagsMu.Lock()
	defer tagsMu.Unlock()
	p := filepath.Join(dir, tagsFileName)
	old, rerr := os.ReadFile(p)
	if rerr == nil {
		if bytes.Equal(old, data) {
			return nil
		}
		if oldNewer, perr := parseTags(old, false); perr == nil && oldNewer {
			return &TagsError{TagsErrNewerOnDisk, "디스크의 태그 파일이 더 새 버전의 chipper 가 만든 것이라 덮어쓰지 않았습니다", nil}
		}
		bak := filepath.Join(dir, tagsBackups[0])
		if _, serr := os.Stat(bak); serr == nil {
			if err := os.Rename(bak, filepath.Join(dir, tagsBackups[1])); err != nil {
				return &TagsError{TagsErrBackup, "직전 태그 파일(.bak)을 .bak2 로 옮기지 못해 저장하지 않았습니다", err}
			}
		}
		if err := atomicWrite(bak, old, 0o600); err != nil {
			return &TagsError{TagsErrBackup, "직전 태그 파일(.bak)을 남기지 못해 저장하지 않았습니다", err}
		}
	} else if !os.IsNotExist(rerr) {
		return rerr
	}
	return atomicWrite(p, data, 0o600)
}

// LoadTags returns the tag store (see TagsLoad). Exists=false and no Broken:
// first run — the frontend builds "common" from the old session rules.
func (a *App) LoadTags() (TagsLoad, error) {
	if a.dataDir == "" {
		return TagsLoad{}, nil
	}
	return loadTagsFile(a.dataDir, time.Now())
}

// SaveTags writes the whole tag store (atomic, previous versions → .bak, .bak2).
func (a *App) SaveTags(data string) error {
	if a.dataDir == "" {
		return &TagsError{TagsErrNoDataDir, "데이터 디렉터리를 사용할 수 없습니다", nil}
	}
	return saveTagsFile(a.dataDir, []byte(data))
}
