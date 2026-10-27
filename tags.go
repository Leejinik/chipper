package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
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
	maxTagNameLen  = 100
	tagsBrokenStem = "tags.broken-"
)

// TagsLoad is what LoadTags hands the frontend.
type TagsLoad struct {
	Data     string `json:"data"`     // file contents ("" = nothing usable on disk)
	Exists   bool   `json:"exists"`   // a tags.json (or its backup) was found and is usable
	Restored bool   `json:"restored"` // Data came from tags.json.bak because tags.json was broken
	Broken   string `json:"broken"`   // where an unreadable tags.json was moved ("" = it wasn't)
	Problem  string `json:"problem"`  // why it was considered broken
	Newer    bool   `json:"newer"`    // written by a newer chipper: show, but don't save over it
}

type tagsEnvelope struct {
	Version int               `json:"version"`
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

// tagNameProblem returns why name can't be a tag name ("" = fine). Same rules
// as the frontend's tagNameProblem.
func tagNameProblem(name string) string {
	if name == "" {
		return "태그 이름이 비어 있습니다"
	}
	if strings.TrimSpace(name) != name {
		return "태그 이름 앞뒤에 공백을 둘 수 없습니다"
	}
	if !utf8.ValidString(name) {
		return "태그 이름이 올바른 UTF-8 글자가 아닙니다"
	}
	if utf8.RuneCountInString(name) > maxTagNameLen {
		return fmt.Sprintf("태그 이름은 %d자까지입니다", maxTagNameLen)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "태그 이름에 제어 문자(줄바꿈·탭 등)를 쓸 수 없습니다"
		}
	}
	return ""
}

// parseTags checks the envelope. newer = version above what this build knows
// (the envelope is then not checked further).
func parseTags(data []byte) (newer bool, err error) {
	var env tagsEnvelope
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&env); err != nil {
		return false, fmt.Errorf("JSON 형식이 아닙니다: %v", err)
	}
	if dec.More() {
		return false, errors.New("JSON 뒤에 다른 내용이 붙어 있습니다")
	}
	if env.Version < 1 {
		return false, errors.New("version 이 없거나 1보다 작습니다")
	}
	if env.Version > tagsVersion {
		return true, nil
	}
	seen := make(map[string]bool, len(env.Tags))
	for i, t := range env.Tags {
		if p := tagNameProblem(t.Name); p != "" {
			return false, fmt.Errorf("%d번째 태그 %q: %s", i+1, t.Name, p)
		}
		if seen[t.Name] { // case-sensitive: "collector" and "Collector" may coexist
			return false, fmt.Errorf("태그 이름 %q 이 두 번 있습니다", t.Name)
		}
		seen[t.Name] = true
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
// deleted: it is moved aside to tags.broken-<time>.json and the previous
// version (tags.json.bak) is offered instead when that one is fine.
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
	newer, perr := parseTags(data)
	if perr == nil {
		return TagsLoad{Data: string(data), Exists: true, Newer: newer}, nil
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
	if bak, berr := os.ReadFile(p + ".bak"); berr == nil {
		if bnewer, e := parseTags(bak); e == nil {
			out.Data, out.Exists, out.Restored, out.Newer = string(bak), true, true, bnewer
		}
	}
	return out, nil
}

// saveTagsFile replaces dir/tags.json atomically, keeping the version it
// replaces as tags.json.bak. Unchanged content is not rewritten (so the
// backup stays one real change behind).
func saveTagsFile(dir string, data []byte) error {
	newer, err := parseTags(data)
	if err != nil {
		return fmt.Errorf("태그 파일 형식이 잘못돼 저장하지 않았습니다: %w", err)
	}
	if newer {
		return errors.New("이 버전이 모르는 태그 파일 형식이라 저장하지 않았습니다")
	}
	tagsMu.Lock()
	defer tagsMu.Unlock()
	p := filepath.Join(dir, tagsFileName)
	old, rerr := os.ReadFile(p)
	if rerr == nil {
		if bytes.Equal(old, data) {
			return nil
		}
		if err := atomicWrite(p+".bak", old, 0o600); err != nil {
			return fmt.Errorf("직전 태그 파일(.bak)을 남기지 못해 저장하지 않았습니다: %w", err)
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

// SaveTags writes the whole tag store (atomic, previous version → .bak).
func (a *App) SaveTags(data string) error {
	if a.dataDir == "" {
		return errors.New("데이터 디렉터리를 사용할 수 없습니다")
	}
	return saveTagsFile(a.dataDir, []byte(data))
}
