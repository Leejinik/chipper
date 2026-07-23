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

	"github.com/wailsapp/wails/v2/pkg/options"
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

	// File-open delivery (double-click an associated file). openMu guards both
	// fields. pendingOpen buffers paths that arrive before the frontend has
	// subscribed (cold start); FrontendReady drains them.
	openMu        sync.Mutex
	pendingOpen   []string
	frontendReady bool

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
	// A file passed on the command line (Windows file-association launch:
	// `chipper.exe "C:\path\file.md"`) is buffered here and flushed once the
	// frontend calls FrontendReady. macOS delivers via Mac.OnFileOpen instead.
	a.deliverOpenPaths(existingFiles(os.Args[1:]))
	// If the user previously associated file types and later moved the portable
	// exe, repoint the registered "open" command at the current path. No-op on
	// non-Windows and when nothing was ever registered.
	a.syncFileAssociationsOnLaunch()
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

// --- file-open delivery (double-click an associated file) -----------------

// AssocType is one associable file type shown in the Windows "파일 연결 관리"
// panel. The list below is the single source of truth for both the Windows
// registry code and the (stubbed) non-Windows binding.
type AssocType struct {
	Ext   string `json:"ext"`   // includes the leading dot, e.g. ".md"
	Label string `json:"label"` // human label for the checkbox
}

var chipperAssocTypes = []AssocType{
	{".md", "Markdown (.md)"},
	{".markdown", "Markdown (.markdown)"},
	{".txt", "텍스트 (.txt)"},
	{".text", "텍스트 (.text)"},
	{".log", "로그 (.log)"},
	{".html", "HTML (.html)"},
	{".htm", "HTML (.htm)"},
}

// existingFiles keeps only argv entries that name an existing (non-directory)
// file, absolutized. Association launches always pass an absolute, quoted %1,
// but we stay defensive against relative paths and stray flags.
func existingFiles(args []string) []string {
	out := make([]string, 0, len(args))
	for _, p := range args {
		if p == "" {
			continue
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		if st, e := os.Stat(abs); e == nil && !st.IsDir() {
			out = append(out, abs)
		}
	}
	return out
}

// deliverOpenPaths hands file paths to the frontend. If the frontend has not
// subscribed yet (cold start, before React mounts its EventsOn listener) the
// paths are buffered and later drained by FrontendReady — Wails events have no
// server-side replay, so an emit fired too early would be silently dropped.
func (a *App) deliverOpenPaths(paths []string) {
	if len(paths) == 0 {
		return
	}
	a.openMu.Lock()
	if a.ctx == nil || !a.frontendReady {
		a.pendingOpen = append(a.pendingOpen, paths...)
		a.openMu.Unlock()
		return
	}
	a.openMu.Unlock()
	wruntime.EventsEmit(a.ctx, "chipper:open-files", paths)
}

// FrontendReady is called once by React on mount, AFTER it has registered the
// "chipper:open-files" listener. It marks the frontend ready and returns any
// paths buffered during cold start so the very first double-clicked file is
// not lost.
func (a *App) FrontendReady() []string {
	a.openMu.Lock()
	defer a.openMu.Unlock()
	a.frontendReady = true
	p := a.pendingOpen
	a.pendingOpen = nil
	return p
}

// onSecondInstanceLaunch runs (on a background goroutine) when a second
// chipper process is started while one is already running — typically the user
// double-clicked another associated file. data.Args is that process's
// os.Args[1:]. We raise the existing window and open the file(s) as tabs.
func (a *App) onSecondInstanceLaunch(data options.SecondInstanceData) {
	paths := existingFiles(data.Args)
	if len(paths) == 0 {
		return
	}
	if a.ctx != nil {
		wruntime.WindowUnminimise(a.ctx)
		wruntime.WindowShow(a.ctx)
	}
	a.deliverOpenPaths(paths)
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

// ApplyUpdate no longer self-replaces the running binary. It opens the GitHub
// release page for the new version in the default browser so the user can
// download the new exe and drop it in manually.
//
// Why: rewriting our own on-disk image and relaunching it is a textbook malware
// heuristic. In the field an endpoint-security agent (EDR) quarantined and
// path-locked the swapped-in exe AND the renamed-aside original, leaving no
// runnable binary and no working rollback. A manual download to a fresh path
// sidesteps the whole self-modification trip.
func (a *App) ApplyUpdate(info updater.UpdateInfo) error {
	if a.updater == nil {
		return errors.New("updater not initialised")
	}
	url := "https://github.com/Leejinik/chipper/releases/latest"
	if info.LatestVersion != "" {
		url = fmt.Sprintf("https://github.com/Leejinik/chipper/releases/tag/%s", info.LatestVersion)
	}
	wruntime.BrowserOpenURL(a.ctx, url)
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

// AutoUpdate is the startup update check. It is NOTIFY-ONLY: it asks GitHub for
// a newer build and, if one exists, reports it (Blocked=true) so the frontend
// shows a manual "download" pill. It never self-replaces or quits — see
// ApplyUpdate for why self-replacement was removed (사내 EDR가 자기교체식
// 자동 업데이트를 악성으로 판정·격리하여 실행 파일이 사라지는 문제).
func (a *App) AutoUpdate() updater.AutoUpdateResult {
	if a.updater == nil {
		return updater.AutoUpdateResult{}
	}
	info, err := a.updater.Check(a.ctx)
	if err != nil || !info.Available {
		return updater.AutoUpdateResult{Info: info}
	}
	// Available → surface the manual-download pill (Blocked repurposed as
	// "notify, do not auto-apply"). 자기교체·Quit는 제거됨.
	return updater.AutoUpdateResult{Blocked: true, Info: info}
}

// ShowUpdateModeNoticeOnce shows a one-time native notice explaining that the
// in-app auto-update switched from silent self-replacement to "notify + manual
// download", because the corporate EDR security policy quarantines self-
// replacing executables (in the field it left the app with no runnable binary).
// It fires at most once per install, guarded by a marker file in the config dir.
func (a *App) ShowUpdateModeNoticeOnce() {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".chipper")
	marker := filepath.Join(dir, "update-mode-notice.seen")
	if _, err := os.Stat(marker); err == nil {
		return // already shown on this install
	}
	_, _ = wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{
		Type:  wruntime.InfoDialog,
		Title: "자동 업데이트 방식 변경 안내",
		Message: "사내 EDR 보안 정책이 자기교체식 자동 업데이트를 차단하여, 앞으로는 새 버전이 " +
			"나오면 자동 설치 대신 ‘알림 + 수동 다운로드’ 방식으로 동작합니다.\n\n" +
			"새 버전이 있으면 화면에 다운로드 안내가 표시되고, 클릭하면 릴리스 페이지가 브라우저로 열립니다.",
	})
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(marker, []byte("seen"), 0644)
}
