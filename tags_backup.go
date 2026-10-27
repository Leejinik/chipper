package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// Backups of the whole tag store (tags + assign) made right before an import
// changes it — and right before such a backup is restored — kept apart from
// tags.json.bak/.bak2 (those turn over at every save, so a single edit after
// an import used to lose the state before it):
//
//	~/.chipper/tags-backup/before-import-20261027-153012.123.json
//	~/.chipper/tags-backup/before-restore-20261027-160501.004.json
//
// The newest keepTagsBackups of each kind are kept. The tag window lists them
// under 「가져오기 전으로 되돌리기…」.

const (
	tagsBackupDir   = "tags-backup"
	keepTagsBackups = 5
)

var tagsBackupKinds = map[string]bool{"import": true, "restore": true}

// before-<kind>-<yyyymmdd-hhmmss.mmm>[-n].json — the only names read back
// (so a name from the frontend can't point anywhere else).
var tagsBackupName = regexp.MustCompile(`^before-(import|restore)-(\d{8}-\d{6}\.\d{3})(?:-(\d+))?\.json$`)

// TagsBackupInfo describes one backup for the tag window.
type TagsBackupInfo struct {
	File    string   `json:"file"`    // file name in tags-backup
	Kind    string   `json:"kind"`    // "import" | "restore"
	Time    string   `json:"time"`    // "2026-10-27 15:30:12" (local time it was made)
	Tags    int      `json:"tags"`    // number of tags
	Names   []string `json:"names"`   // tag names (first few)
	Places  int      `json:"places"`  // number of assigned places
	Problem string   `json:"problem"` // why it can't be restored ("" = it can)
}

// backupTagsFile writes data (a whole tag store, as SaveTags gets it) to
// dir/tags-backup/before-<kind>-<time>.json and drops the oldest of that kind
// beyond keepTagsBackups. Returns the file name.
func backupTagsFile(dir, kind string, data []byte, now time.Time) (string, error) {
	if !tagsBackupKinds[kind] {
		return "", fmt.Errorf("모르는 백업 종류 %q", kind)
	}
	if newer, err := parseTags(data, true); err != nil || newer {
		if err == nil {
			err = errors.New("모르는 버전")
		}
		return "", &TagsError{TagsErrInvalid, "백업할 태그 내용이 잘못돼 백업하지 않았습니다", err}
	}
	bdir := filepath.Join(dir, tagsBackupDir)
	if err := os.MkdirAll(bdir, 0o700); err != nil {
		return "", err
	}
	stamp := now.Format("20060102-150405.000")
	name := fmt.Sprintf("before-%s-%s.json", kind, stamp)
	for i := 2; ; i++ { // never replace a backup made in the same millisecond
		if _, err := os.Lstat(filepath.Join(bdir, name)); os.IsNotExist(err) {
			break
		}
		name = fmt.Sprintf("before-%s-%s-%d.json", kind, stamp, i)
	}
	if err := atomicWrite(filepath.Join(bdir, name), data, 0o600); err != nil {
		return "", err
	}
	pruneTagsBackups(bdir, kind)
	return name, nil
}

type backupEntry struct {
	name, kind, stamp string
	n                 int
}

// tagsBackupEntries lists the backup files of dir/tags-backup, newest first.
func tagsBackupEntries(bdir string) []backupEntry {
	ents, _ := os.ReadDir(bdir)
	var out []backupEntry
	for _, e := range ents {
		m := tagsBackupName.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		n, _ := strconv.Atoi(m[3])
		out = append(out, backupEntry{e.Name(), m[1], m[2], n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].stamp != out[j].stamp {
			return out[i].stamp > out[j].stamp
		}
		return out[i].n > out[j].n
	})
	return out
}

func pruneTagsBackups(bdir, kind string) {
	kept := 0
	for _, e := range tagsBackupEntries(bdir) {
		if e.kind != kind {
			continue
		}
		if kept++; kept > keepTagsBackups {
			os.Remove(filepath.Join(bdir, e.name))
		}
	}
}

// listTagsBackups describes the backups, newest first.
func listTagsBackups(dir string) []TagsBackupInfo {
	bdir := filepath.Join(dir, tagsBackupDir)
	out := []TagsBackupInfo{}
	for _, e := range tagsBackupEntries(bdir) {
		info := TagsBackupInfo{File: e.name, Kind: e.kind, Names: []string{}}
		if t, err := time.ParseInLocation("20060102-150405.000", e.stamp, time.Local); err == nil {
			info.Time = t.Format("2006-01-02 15:04:05")
		}
		data, err := os.ReadFile(filepath.Join(bdir, e.name))
		if err != nil {
			info.Problem = "읽지 못했습니다: " + err.Error()
			out = append(out, info)
			continue
		}
		var env tagsEnvelope
		newer, perr := parseTags(data, false)
		switch {
		case perr != nil:
			info.Problem = "태그 파일 형식이 아닙니다: " + perr.Error()
		case newer:
			info.Problem = "더 새 버전의 chipper 가 만든 파일입니다"
		case decodeOneJSON(trimBOM(data), &env) == nil:
			info.Tags = len(env.Tags)
			for _, t := range env.Tags {
				if len(info.Names) == 8 {
					break
				}
				info.Names = append(info.Names, t.Name)
			}
			if env.Assign != nil {
				info.Places = len(env.Assign.Dir) + len(env.Assign.File) + len(env.Assign.Name)
			}
		}
		out = append(out, info)
	}
	return out
}

// readTagsBackup returns one backup's contents (without a BOM).
func readTagsBackup(dir, name string) (string, error) {
	if !tagsBackupName.MatchString(name) {
		return "", fmt.Errorf("태그 백업 파일 이름이 아닙니다: %q", name)
	}
	data, err := os.ReadFile(filepath.Join(dir, tagsBackupDir, name))
	if err != nil {
		return "", err
	}
	newer, perr := parseTags(data, false)
	if perr != nil {
		return "", fmt.Errorf("%s 는 태그 파일 형식이 아닙니다: %w", name, perr)
	}
	if newer {
		return "", &TagsError{TagsErrNewerFormat, name + " 는 더 새 버전의 chipper 가 만든 파일이라 되돌릴 수 없습니다", nil}
	}
	return string(trimBOM(data)), nil
}

// BackupTagsBefore keeps data (the whole tag store about to be replaced) as
// tags-backup/before-<kind>-<time>.json; kind is "import" or "restore".
// Returns the file name.
func (a *App) BackupTagsBefore(kind, data string) (string, error) {
	if a.dataDir == "" {
		return "", &TagsError{TagsErrNoDataDir, "데이터 디렉터리를 사용할 수 없습니다", nil}
	}
	return backupTagsFile(a.dataDir, kind, []byte(data), time.Now())
}

// ListTagsBackups lists the tag store backups, newest first.
func (a *App) ListTagsBackups() ([]TagsBackupInfo, error) {
	if a.dataDir == "" {
		return []TagsBackupInfo{}, nil
	}
	return listTagsBackups(a.dataDir), nil
}

// ReadTagsBackup returns one backup (a whole tag store) by file name.
func (a *App) ReadTagsBackup(name string) (string, error) {
	if a.dataDir == "" {
		return "", &TagsError{TagsErrNoDataDir, "데이터 디렉터리를 사용할 수 없습니다", nil}
	}
	return readTagsBackup(a.dataDir, name)
}
