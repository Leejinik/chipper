package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"chipper/internal/updater"
)

// App is the root struct bound to Wails. Every exported method is callable from
// the React frontend via the generated bindings.
type App struct {
	ctx         context.Context
	dataDir     string
	saveMu      sync.Mutex  // serializes session writes to the on-disk file
	pendingMu   sync.Mutex  // guards pending
	pending     string      // latest session snapshot, flushed synchronously on close
	chipsCancel atomic.Bool // set by CancelChips to stop an in-flight TypeChips run

	// version is set from main() after NewApp(); the updater is built on startup
	// once we know the value.
	version string
	updater *updater.Updater
}

// NewApp creates a new App application struct.
func NewApp() *App { return &App{} }

// startup is called when the app starts. The context is saved so we can call the
// runtime methods, and the per-user data directory (used for autosave) is
// prepared under the user's home folder.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.version == "" {
		a.version = "dev"
	}
	home, _ := os.UserHomeDir()
	cfgDir := filepath.Join(home, ".chipper")
	if home != "" {
		dir := cfgDir
		if err := os.MkdirAll(dir, 0o700); err == nil {
			a.dataDir = dir
			// One-time migration from the previous ".md-editor" data directory.
			newSess := filepath.Join(dir, "session.json")
			if _, serr := os.Stat(newSess); os.IsNotExist(serr) {
				if data, rerr := os.ReadFile(filepath.Join(home, ".md-editor", "session.json")); rerr == nil {
					_ = os.WriteFile(newSess, data, 0o600)
				}
			}
		}
	}
	// Auto-updater: build against GitHub Releases, then sweep any leftover files
	// a previous in-place swap may have left next to the binary.
	a.updater = updater.New(updater.Config{
		Owner:          "Leejinik",
		Repo:           "chipper",
		AssetName:      "chipper.exe",
		CurrentVersion: a.version,
		ConfigDir:      cfgDir,
	})
	if exe, err := os.Executable(); err == nil {
		a.updater.CleanupLeftovers(exe)
	}
}

// beforeClose runs synchronously on the main thread before the window is torn
// down, flushing the latest session snapshot so the final keystrokes made right
// before a plain window close are never lost. Returning false allows the close.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.pendingMu.Lock()
	data := a.pending
	a.pendingMu.Unlock()
	if data != "" {
		_ = a.writeSession(data)
	}
	return false
}

func (a *App) sessionPath() string {
	if a.dataDir == "" {
		return ""
	}
	return filepath.Join(a.dataDir, "session.json")
}

// FileDoc is a single document handed to / from the frontend.
type FileDoc struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	ModTime  int64  `json:"modTime"` // disk mtime in unix millis (for external-change detection)
	Size     int64  `json:"size"`
	Encoding string `json:"encoding"` // detected/used text encoding
	Binary   bool   `json:"binary"`   // true when the file looks like binary (not a text document)
	Canceled bool   `json:"canceled"`
}

// looksBinary reports whether the data appears to be a binary (non-text) file,
// detected by a NUL byte in the leading window. Used to refuse dragging an
// image/exe into a text editor.
func looksBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// FileStat is a lightweight stat result used to detect external modifications.
type FileStat struct {
	Exists  bool  `json:"exists"`
	ModTime int64 `json:"modTime"`
	Size    int64 `json:"size"`
}

// fileFilters are the filters shown in the open/save native dialogs.
var fileFilters = []wruntime.FileFilter{
	{DisplayName: "문서 (Markdown/텍스트/HTML)", Pattern: "*.md;*.markdown;*.txt;*.text;*.log;*.html;*.htm"},
	{DisplayName: "Markdown (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
	{DisplayName: "HTML (*.html;*.htm)", Pattern: "*.html;*.htm"},
	{DisplayName: "텍스트 (*.txt;*.log)", Pattern: "*.txt;*.log;*.text"},
	{DisplayName: "모든 파일 (*.*)", Pattern: "*.*"},
}

// OpenFileDialog shows a native open dialog and returns the chosen file's
// content. FileDoc.Canceled is true when the user dismisses the dialog.
func (a *App) OpenFileDialog() (FileDoc, error) {
	path, err := wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:   "파일 열기",
		Filters: fileFilters,
	})
	if err != nil {
		return FileDoc{}, err
	}
	if path == "" {
		return FileDoc{Canceled: true}, nil
	}
	return a.readDoc(path)
}

// ReadFile reads a file by path (used to reload a file from disk).
func (a *App) ReadFile(path string) (FileDoc, error) {
	return a.readDoc(path)
}

// StatFile returns the current mtime/size of a path so the frontend can detect
// that a file changed on disk before overwriting it.
func (a *App) StatFile(path string) (FileStat, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return FileStat{Exists: false}, nil
		}
		return FileStat{}, err
	}
	return FileStat{Exists: true, ModTime: info.ModTime().UnixMilli(), Size: info.Size()}, nil
}

// decodeBytes turns raw file bytes into a UTF-8 string and reports the detected
// encoding: BOM sniffing (UTF-8/UTF-16), then valid UTF-8, then a CP949/EUC-KR
// fallback (still common for legacy Windows-Korean text).
func decodeBytes(data []byte) (string, string) {
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		return string(data[3:]), "utf-8-bom"
	}
	if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
		if s, err := decodeWith(data, "utf-16le"); err == nil {
			return s, "utf-16le"
		}
	}
	if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
		if s, err := decodeWith(data, "utf-16be"); err == nil {
			return s, "utf-16be"
		}
	}
	// BOM-less UTF-16 heuristic: a strong, regular run of NUL bytes on one parity.
	// Must run before the utf8.Valid check (ASCII UTF-16LE is valid UTF-8 too).
	if len(data) >= 4 && len(data)%2 == 0 {
		limit := len(data)
		if limit > 8000 {
			limit = 8000
		}
		var evenZero, oddZero, n int
		for i := 0; i+1 < limit; i += 2 {
			if data[i] == 0 {
				evenZero++
			}
			if data[i+1] == 0 {
				oddZero++
			}
			n++
		}
		if n > 0 {
			if oddZero*10 >= n*6 && evenZero*10 < n*2 {
				if s, err := decodeWith(data, "utf-16le"); err == nil && utf8.ValidString(s) {
					return s, "utf-16le"
				}
			}
			if evenZero*10 >= n*6 && oddZero*10 < n*2 {
				if s, err := decodeWith(data, "utf-16be"); err == nil && utf8.ValidString(s) {
					return s, "utf-16be"
				}
			}
		}
	}
	if utf8.Valid(data) {
		return string(data), "utf-8"
	}
	if dec, err := korean.EUCKR.NewDecoder().Bytes(data); err == nil && utf8.Valid(dec) {
		return string(dec), "cp949"
	}
	return string(data), "utf-8"
}

// decodeWith decodes raw bytes using an explicit encoding name.
func decodeWith(data []byte, enc string) (string, error) {
	switch enc {
	case "utf-8", "":
		return string(data), nil
	case "utf-8-bom":
		return string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})), nil
	case "cp949":
		b, err := korean.EUCKR.NewDecoder().Bytes(data)
		if err != nil {
			return "", err
		}
		return string(b), nil
	case "utf-16le":
		b, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(data)
		if err != nil {
			return "", err
		}
		return string(b), nil
	case "utf-16be":
		b, err := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder().Bytes(data)
		if err != nil {
			return "", err
		}
		return string(b), nil
	default:
		return string(data), nil
	}
}

// encodeText encodes a UTF-8 string into bytes using the given encoding.
func encodeText(content string, enc string) ([]byte, error) {
	switch enc {
	case "utf-8", "":
		return []byte(content), nil
	case "utf-8-bom":
		return append([]byte{0xEF, 0xBB, 0xBF}, []byte(content)...), nil
	case "cp949":
		return korean.EUCKR.NewEncoder().Bytes([]byte(content))
	case "utf-16le":
		return unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().Bytes([]byte(content))
	case "utf-16be":
		return unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewEncoder().Bytes([]byte(content))
	default:
		return []byte(content), nil
	}
}

func (a *App) readDoc(path string) (FileDoc, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return FileDoc{}, err
	}
	content, enc := decodeBytes(data)
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	doc.Binary = looksBinary([]byte(content))
	return doc, nil
}

// ReadFileAs re-reads a file decoding it with an explicit encoding (used by
// "다른 인코딩으로 다시 열기").
func (a *App) ReadFileAs(path string, enc string) (FileDoc, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return FileDoc{}, err
	}
	content, derr := decodeWith(data, enc)
	if derr != nil {
		return FileDoc{}, derr
	}
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	doc.Binary = looksBinary([]byte(content))
	return doc, nil
}

func (a *App) docWithStat(path, content string) FileDoc {
	doc := FileDoc{Path: path, Name: filepath.Base(path), Content: content}
	if info, err := os.Stat(path); err == nil {
		doc.ModTime = info.ModTime().UnixMilli()
		doc.Size = info.Size()
	}
	return doc
}

// atomicWrite writes data to path via a uniquely-named temp file in the same
// directory followed by os.Rename, so a mid-write failure (disk full, power
// loss, AV lock) can never truncate/destroy the existing file, and concurrent
// writers never share a temp path.
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".chipper-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	_ = os.Chmod(tmp, perm)
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// SaveFileDialog shows a native "save as" dialog and writes content atomically
// to the chosen path. Returns the resulting FileDoc (Canceled when dismissed).
func (a *App) SaveFileDialog(defaultName string, content string, enc string) (FileDoc, error) {
	path, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:                "다른 이름으로 저장",
		DefaultFilename:      defaultName,
		Filters:              fileFilters,
		CanCreateDirectories: true,
	})
	if err != nil {
		return FileDoc{}, err
	}
	if path == "" {
		return FileDoc{Canceled: true}, nil
	}
	data, eerr := encodeText(content, enc)
	if eerr != nil {
		return FileDoc{}, fmt.Errorf("%s 인코딩으로 저장할 수 없는 문자가 있습니다", enc)
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return FileDoc{}, err
	}
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	return doc, nil
}

// SaveFile writes content atomically to an already-known path (Ctrl+S), encoding
// it with enc. Returns the updated FileDoc (fresh mtime/size) so the frontend
// can keep its external-change token current.
func (a *App) SaveFile(path string, content string, enc string) (FileDoc, error) {
	if path == "" {
		return FileDoc{}, fmt.Errorf("빈 파일 경로")
	}
	data, eerr := encodeText(content, enc)
	if eerr != nil {
		return FileDoc{}, fmt.Errorf("%s 인코딩으로 저장할 수 없는 문자가 있습니다", enc)
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return FileDoc{}, err
	}
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	return doc, nil
}

// StashSession keeps the backend's in-memory copy of the latest session current
// (called from the frontend on every change). It is cheap and never touches the
// disk; beforeClose flushes it synchronously at shutdown.
func (a *App) StashSession(data string) {
	a.pendingMu.Lock()
	a.pending = data
	a.pendingMu.Unlock()
}

// SaveSession persists the session blob to disk (debounced autosave) and also
// updates the in-memory pending copy.
func (a *App) SaveSession(data string) error {
	a.pendingMu.Lock()
	a.pending = data
	a.pendingMu.Unlock()
	return a.writeSession(data)
}

func (a *App) writeSession(data string) error {
	p := a.sessionPath()
	if p == "" {
		return fmt.Errorf("데이터 디렉터리를 사용할 수 없습니다")
	}
	a.saveMu.Lock()
	defer a.saveMu.Unlock()
	return atomicWrite(p, []byte(data), 0o600)
}

// LoadSession returns the persisted session blob, or "" when no session exists
// yet (first run).
func (a *App) LoadSession() (string, error) {
	p := a.sessionPath()
	if p == "" {
		return "", nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// --- Auto-update --------------------------------------------------------

// GetCurrentVersion returns the build-time version (or "dev" for local builds).
func (a *App) GetCurrentVersion() string {
	if a.updater == nil {
		return a.version
	}
	return a.updater.CurrentVersion()
}

// CheckForUpdate queries GitHub Releases for a newer build. Pure check — it
// does NOT record an auto-apply attempt.
func (a *App) CheckForUpdate() (updater.UpdateInfo, error) {
	if a.updater == nil {
		return updater.UpdateInfo{CurrentVersion: a.version}, nil
	}
	return a.updater.Check(a.ctx)
}

// ApplyUpdate downloads the new exe, stashes the release notes, swaps the
// binary in place, and quits the app — the relaunched (new) binary shows the
// release notes once on startup. This is the manual/unguarded path.
func (a *App) ApplyUpdate(info updater.UpdateInfo) error {
	if a.updater == nil {
		return errors.New("updater not initialised")
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return err
	}
	// Hand off. Quit in a goroutine so this call can return cleanly to the
	// frontend before the runtime shuts down.
	go wruntime.Quit(a.ctx)
	return nil
}

// GetPendingReleaseNotes returns release notes stashed by the previous version
// right before it triggered the update, iff they belong to the current binary
// version. Returns nil when there's nothing to show.
func (a *App) GetPendingReleaseNotes() *updater.PendingNotes {
	if a.updater == nil {
		return nil
	}
	notes, ok, _ := a.updater.LoadPendingNotes()
	if !ok {
		return nil
	}
	return &notes
}

// MarkReleaseNotesSeen deletes the stashed notes file so it won't pop again.
func (a *App) MarkReleaseNotesSeen() error {
	if a.updater == nil {
		return nil
	}
	return a.updater.ClearPendingNotes()
}

// AutoUpdate is the GUARDED silent startup path. It checks, then only applies
// if the loop guard green-lights (ShouldAutoApply caps repeated non-converging
// attempts at maxAutoTries). On a blocked/available update it returns
// Blocked=true so the frontend can show a manual "new version" badge.
func (a *App) AutoUpdate() updater.AutoUpdateResult {
	if a.updater == nil {
		return updater.AutoUpdateResult{}
	}
	info, err := a.updater.Check(a.ctx)
	if err != nil || !info.Available {
		return updater.AutoUpdateResult{Info: info}
	}
	if !a.updater.ShouldAutoApply(info) {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	go wruntime.Quit(a.ctx)
	return updater.AutoUpdateResult{Applying: true, Info: info}
}
