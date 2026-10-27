package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
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
	closing     atomic.Bool // close requested; the frontend is flushing its final snapshot
	chipsCancel atomic.Bool // set by CancelChips to stop an in-flight TypeChips run

	// sessionBacked: this run already copied the previous session to .bak
	// (guarded by saveMu). sessionBlocked: an unreadable session could not be
	// kept aside, so this run must not write over it.
	sessionBacked  bool
	sessionBlocked atomic.Bool

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
		AssetName:      releaseAssetName(),
		CurrentVersion: a.version,
		ConfigDir:      cfgDir,
	})
	if exe, err := os.Executable(); err == nil {
		a.updater.CleanupLeftovers(exe)
	}
}

// GetPlatform returns the GOOS this build runs on. The frontend needs it because
// FileAssociationSupported() alone collapses Linux and macOS into one "false"
// branch, and the two need completely different guidance — and because chips
// auto-typing exists on Windows and macOS but not Linux, so the button has to
// explain itself rather than just fail when pressed.
func (a *App) GetPlatform() string { return runtime.GOOS }

// releaseAssetName is the GitHub Release asset this build should look for. It
// must match the filenames produced by .github/workflows/release.yml character
// for character: when the GitHub API is rate-limited the updater falls back to
// assembling the download URL from this name (see internal/updater/updater.go).
func releaseAssetName() string {
	switch runtime.GOOS {
	case "linux":
		// e.g. chipper-linux-amd64. GOARCH keeps this honest if an arm64 job is
		// ever added to the workflow.
		return "chipper-linux-" + runtime.GOARCH
	default:
		return "chipper.exe"
	}
}

// beforeClose runs on the main thread before the window is torn down. The
// frontend autosaves on a debounce (serializing big documents on every keystroke
// made typing sluggish), so the newest edits may not have reached us yet. The
// first close is therefore held back and the frontend asked to flush; it answers
// with CloseWithSession, whose Quit lands here again with closing set. Blocking
// here instead would deadlock: the binding call is delivered on this thread.
// If the frontend never answers, the fallback quits with the last autosave.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.openMu.Lock()
	ready := a.frontendReady
	a.openMu.Unlock()
	if ready && a.closing.CompareAndSwap(false, true) {
		wruntime.EventsEmit(ctx, "chipper:flush-before-close")
		go func() {
			time.Sleep(3 * time.Second)
			wruntime.Quit(ctx)
		}()
		return true
	}
	a.pendingMu.Lock()
	data := a.pending
	a.pendingMu.Unlock()
	if data != "" {
		_ = a.writeSession(data)
	}
	return false
}

// CloseWithSession is the frontend's answer to "chipper:flush-before-close":
// persist the final snapshot, then finish the close.
func (a *App) CloseWithSession(data string) {
	if data != "" {
		a.pendingMu.Lock()
		a.pending = data
		a.pendingMu.Unlock()
	}
	wruntime.Quit(a.ctx)
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

// The session lives in session.v3.json. v1.1 (session format 2) reads and
// rewrites session.json, and on meeting a v3 session there it replaced it with
// its welcome document — so v1.2.1+ keeps its own file and never writes
// session.json. session.json is still read once, as the starting point, when
// session.v3.json does not exist yet (upgrade from v1.1 / v1.2.0).
const (
	sessionFileName       = "session.v3.json"
	legacySessionFileName = "session.json"
	sessionFormatVersion  = 3 // must match SESSION_VERSION in App.tsx
)

func (a *App) sessionPath() string {
	if a.dataDir == "" {
		return ""
	}
	return filepath.Join(a.dataDir, sessionFileName)
}

func (a *App) legacySessionPath() string {
	if a.dataDir == "" {
		return ""
	}
	return filepath.Join(a.dataDir, legacySessionFileName)
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
	// The editor turns every line break into LF, so the file's own kind is
	// remembered here and restored on save. "" = the file has no line break.
	EOL      string `json:"eol"`      // "lf" | "crlf" | "cr" (for a mixed file: the most common kind)
	EOLMixed bool   `json:"eolMixed"` // more than one kind of line break
	BOM      bool   `json:"bom"`      // the file starts with a byte-order mark
	// SaveFile only: the text equals what is on disk, so nothing was written.
	Unchanged bool `json:"unchanged"`
}

// maxOpenBytes is the largest file chipper reads. Files are read whole and held
// several times over (bytes, decoded string, editor document); past ~450MB the
// WebView died in the v1.2.0 tests, so the limit keeps a margin below that.
const maxOpenBytes int64 = 384 << 20 // 402,653,184 bytes

func mib(n int64) string { return fmt.Sprintf("%.1fMB", float64(n)/(1<<20)) }

// openSizeError refuses a file over maxOpenBytes before any of it is read.
func openSizeError(path string) error {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() <= maxOpenBytes {
		return nil // let the read itself report a missing file etc.
	}
	return fmt.Errorf("이 파일은 너무 커서 열 수 없습니다 (%s). %s 까지만 열 수 있습니다. 다음 버전의 『태그 줄만 보기』로 걸린 줄만 볼 수 있습니다", mib(info.Size()), mib(maxOpenBytes))
}

// detectEOL reports the line-break kind of s: the most common one when several
// are mixed (ties prefer CRLF, then LF), "" when there is none.
func detectEOL(s string) (eol string, mixed bool) {
	var crlf, lf, cr int
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\r':
			if i+1 < len(s) && s[i+1] == '\n' {
				crlf++
				i++
			} else {
				cr++
			}
		case '\n':
			lf++
		}
	}
	kinds := 0
	for _, n := range []int{crlf, lf, cr} {
		if n > 0 {
			kinds++
		}
	}
	switch {
	case kinds == 0:
		return "", false
	case crlf >= lf && crlf >= cr:
		return "crlf", kinds > 1
	case lf >= cr:
		return "lf", kinds > 1
	default:
		return "cr", kinds > 1
	}
}

// normalizeEOL turns every CRLF / CR into LF — what the editor does to a document.
func normalizeEOL(s string) string {
	if !strings.Contains(s, "\r") {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

// applyEOL writes the editor's LF line breaks back as the file's own kind.
func applyEOL(content, eol string) string {
	switch eol {
	case "crlf":
		return strings.ReplaceAll(normalizeEOL(content), "\n", "\r\n")
	case "cr":
		return strings.ReplaceAll(normalizeEOL(content), "\n", "\r")
	}
	return content
}

// hasBOM reports whether data starts with the byte-order mark of enc.
func hasBOM(data []byte, enc string) bool {
	switch enc {
	case "utf-8", "utf-8-bom", "":
		return bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	case "utf-16le":
		return bytes.HasPrefix(data, []byte{0xFF, 0xFE})
	case "utf-16be":
		return bytes.HasPrefix(data, []byte{0xFE, 0xFF})
	}
	return false
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
var fileFilters = buildFileFilters()

func buildFileFilters() []wruntime.FileFilter {
	specs := []struct{ name, pattern string }{
		{"문서 (Markdown/텍스트/HTML)", "*.md;*.markdown;*.txt;*.text;*.log;*.html;*.htm"},
		{"Markdown (*.md;*.markdown)", "*.md;*.markdown"},
		{"HTML (*.html;*.htm)", "*.html;*.htm"},
		{"텍스트 (*.txt;*.log)", "*.txt;*.log;*.text"},
	}
	out := make([]wruntime.FileFilter, 0, len(specs)+1)
	for _, s := range specs {
		out = append(out, wruntime.FileFilter{DisplayName: s.name, Pattern: dialogPattern(s.pattern)})
	}
	if runtime.GOOS == "windows" {
		out = append(out, wruntime.FileFilter{DisplayName: "모든 파일 (*.*)", Pattern: "*.*"})
	} else {
		// GTK reads "*.*" literally as "a name containing a dot", which hides
		// every extensionless file — README, Makefile, dotfiles: precisely what
		// a text editor gets opened for on Linux. "*" is the real escape hatch.
		out = append(out, wruntime.FileFilter{DisplayName: "모든 파일 (*)", Pattern: "*"})
	}
	return out
}

// dialogPattern adapts a Windows-style filter pattern to the platform's native
// dialog. Windows matches these case-insensitively; GTK's
// gtk_file_filter_add_pattern is a case-SENSITIVE glob, so on Linux "*.md" hides
// README.MD. Adding an upper-case twin per extension covers the shouty-extension
// convention people actually use, without enumerating every mixed case.
func dialogPattern(p string) string {
	if runtime.GOOS == "windows" {
		return p
	}
	parts := strings.Split(p, ";")
	out := make([]string, 0, len(parts)*2)
	for _, e := range parts {
		out = append(out, e)
		if u := strings.ToUpper(e); u != e {
			out = append(out, u)
		}
	}
	return strings.Join(out, ";")
}

// OpenFileDialog shows a native open dialog and returns the chosen path ("" when
// dismissed). It does not read the file: the frontend reads every file through
// one path that checks its size first (big-file confirm, too-big refusal).
func (a *App) OpenFileDialog() (string, error) {
	return wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:   "파일 열기",
		Filters: fileFilters,
	})
}

// OpenFilesDialog lets the user pick several files at once (filling multi-view
// panes). Returns the chosen paths; empty when canceled.
func (a *App) OpenFilesDialog() ([]string, error) {
	return wruntime.OpenMultipleFilesDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:   "파일 열기 (여러 개 선택 가능)",
		Filters: fileFilters,
	})
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

// encodeText encodes a UTF-8 string into bytes using the given encoding. The
// editor's LF line breaks are written as eol ("lf" / "crlf" / "cr"; "" = LF).
// bom only matters for UTF-16: false writes no byte-order mark (a BOM-less
// UTF-16 file stays BOM-less). For UTF-8 the id itself says it (utf-8-bom).
func encodeText(content string, enc string, eol string, bom bool) ([]byte, error) {
	content = applyEOL(content, eol)
	utf16BOM := unicode.IgnoreBOM
	if bom {
		utf16BOM = unicode.UseBOM
	}
	switch enc {
	case "utf-8", "":
		return []byte(content), nil
	case "utf-8-bom":
		return append([]byte{0xEF, 0xBB, 0xBF}, []byte(content)...), nil
	case "cp949":
		return korean.EUCKR.NewEncoder().Bytes([]byte(content))
	case "utf-16le":
		return unicode.UTF16(unicode.LittleEndian, utf16BOM).NewEncoder().Bytes([]byte(content))
	case "utf-16be":
		return unicode.UTF16(unicode.BigEndian, utf16BOM).NewEncoder().Bytes([]byte(content))
	default:
		return []byte(content), nil
	}
}

// fillFormat records the file's line-break kind and BOM on doc.
func fillFormat(doc *FileDoc, data []byte, content string) {
	doc.EOL, doc.EOLMixed = detectEOL(content)
	doc.BOM = hasBOM(data, doc.Encoding)
}

// readDoc is the one place a file is read for the editor. A file over
// maxOpenBytes is refused before any of it is read.
func (a *App) readDoc(path string) (FileDoc, error) {
	if err := openSizeError(path); err != nil {
		return FileDoc{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return FileDoc{}, err
	}
	content, enc := decodeBytes(data)
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	doc.Binary = looksBinary([]byte(content))
	fillFormat(&doc, data, content)
	return doc, nil
}

// ReadFileAs re-reads a file decoding it with an explicit encoding (used by
// "다른 인코딩으로 다시 열기").
func (a *App) ReadFileAs(path string, enc string) (FileDoc, error) {
	if err := openSizeError(path); err != nil {
		return FileDoc{}, err
	}
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
	fillFormat(&doc, data, content)
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
	// Keep an existing file's own mode rather than stamping perm over it. On
	// Windows os.Chmod only toggles the read-only bit, so this never mattered;
	// on Linux forcing 0644 on every save silently strips the executable bit off
	// a script and widens a 0600 file to world-readable. perm stays the mode for
	// files we are creating for the first time.
	if info, serr := os.Stat(path); serr == nil && info.Mode().IsRegular() {
		perm = info.Mode().Perm()
	}
	_ = os.Chmod(tmp, perm)
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// SaveOptions says how a document is written back.
type SaveOptions struct {
	Encoding string `json:"encoding"`
	// Line-break kind to write the editor's LF as: "lf" | "crlf" | "cr". ""
	// means not known (a tab from an older session): keep the kind — and, for
	// UTF-16, the BOM — of the file currently on disk (LF/BOM for a new file).
	EOL string `json:"eol"`
	// UTF-16 only: write without a byte-order mark (the file had none).
	NoBOM bool `json:"noBom"`
	// Write even when the text equals the file's (an explicit encoding change).
	Force bool `json:"force"`
}

// prepareSave encodes content for path. old is the file's current bytes (nil
// when it does not exist).
func prepareSave(old []byte, content string, opt SaveOptions) (data []byte, eol string, bom bool, err error) {
	eol, bom = opt.EOL, !opt.NoBOM
	if eol == "" {
		eol, bom = "lf", true
		if old != nil {
			if txt, derr := decodeWith(old, opt.Encoding); derr == nil {
				if e, _ := detectEOL(txt); e != "" {
					eol = e
				}
			}
			if opt.Encoding == "utf-16le" || opt.Encoding == "utf-16be" {
				bom = hasBOM(old, opt.Encoding)
			}
		}
	}
	data, err = encodeText(content, opt.Encoding, eol, bom)
	if err != nil {
		return nil, "", false, fmt.Errorf("%s 인코딩으로 저장할 수 없는 문자가 있습니다", opt.Encoding)
	}
	return data, eol, bom, nil
}

// sameAsDisk: writing data would not change the text of the file (same bytes, or
// the same text once line breaks are set aside — a mixed-line-break file that
// was not really edited keeps its own line breaks).
func sameAsDisk(old, data []byte, content, enc string) bool {
	if old == nil {
		return false
	}
	if bytes.Equal(old, data) {
		return true
	}
	txt, err := decodeWith(old, enc)
	return err == nil && normalizeEOL(txt) == normalizeEOL(content)
}

func (a *App) savedDoc(path, content, enc, eol string, bom bool) FileDoc {
	doc := a.docWithStat(path, content)
	doc.Encoding = enc
	doc.EOL = eol
	doc.BOM = bom && (enc == "utf-16le" || enc == "utf-16be") || enc == "utf-8-bom"
	return doc
}

// SaveFileDialog shows a native "save as" dialog and writes content atomically
// to the chosen path. Returns the resulting FileDoc (Canceled when dismissed).
func (a *App) SaveFileDialog(defaultName string, content string, opt SaveOptions) (FileDoc, error) {
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
	var old []byte
	if b, rerr := os.ReadFile(path); rerr == nil {
		old = b
	}
	data, eol, bom, perr := prepareSave(old, content, opt)
	if perr != nil {
		return FileDoc{}, perr
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return FileDoc{}, err
	}
	return a.savedDoc(path, content, opt.Encoding, eol, bom), nil
}

// SaveFile writes content atomically to an already-known path (Ctrl+S). The
// file keeps its line-break kind and BOM (opt). When the text equals what is on
// disk nothing is written (FileDoc.Unchanged) unless opt.Force. Returns the
// FileDoc with a fresh mtime so the frontend keeps its external-change token
// current.
func (a *App) SaveFile(path string, content string, opt SaveOptions) (FileDoc, error) {
	if path == "" {
		return FileDoc{}, fmt.Errorf("빈 파일 경로")
	}
	var old []byte
	if b, rerr := os.ReadFile(path); rerr == nil {
		old = b
	}
	data, eol, bom, perr := prepareSave(old, content, opt)
	if perr != nil {
		return FileDoc{}, perr
	}
	if !opt.Force && sameAsDisk(old, data, content, opt.Encoding) {
		// The file is left exactly as it is (line breaks, BOM, mtime).
		doc := a.savedDoc(path, content, opt.Encoding, eol, bom)
		doc.Unchanged = true
		return doc, nil
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return FileDoc{}, err
	}
	return a.savedDoc(path, content, opt.Encoding, eol, bom), nil
}

// SaveSession persists the session blob to disk (debounced autosave) and also
// updates the in-memory pending copy.
func (a *App) SaveSession(data string) error {
	a.pendingMu.Lock()
	a.pending = data
	a.pendingMu.Unlock()
	return a.writeSession(data)
}

// writeSession writes the session file. The first write of each run first
// copies the previous run's session to <session>.bak, so a run that came up
// with the wrong session (and autosaved it within seconds) can be undone.
func (a *App) writeSession(data string) error {
	p := a.sessionPath()
	if p == "" {
		return fmt.Errorf("데이터 디렉터리를 사용할 수 없습니다")
	}
	if a.sessionBlocked.Load() {
		return fmt.Errorf("이전 세션 파일을 보관하지 못해 이번 실행에서는 세션을 저장하지 않습니다")
	}
	a.saveMu.Lock()
	defer a.saveMu.Unlock()
	if !a.sessionBacked {
		a.sessionBacked = true
		if prev, err := os.ReadFile(p); err == nil && len(prev) > 0 {
			_ = atomicWrite(p+".bak", prev, 0o600)
		}
	}
	return atomicWrite(p, []byte(data), 0o600)
}

// SessionLoad is what LoadSession hands the frontend: the session to restore
// ("" = none: first run, or nothing could be recovered) and, when the stored
// session could not be read, a notice for the user.
type SessionLoad struct {
	Data   string `json:"data"`
	Notice string `json:"notice"`
}

// LoadSession returns the persisted session. A session that cannot be read
// (cut off, empty, not JSON, a format this build does not know) is never just
// dropped: the file is kept as session.broken-<time>.json before anything can
// overwrite it, the tabs that are still whole are recovered where possible, and
// the user is told where the original went.
func (a *App) LoadSession() (SessionLoad, error) {
	p := a.sessionPath()
	if p == "" {
		return SessionLoad{}, nil
	}
	src, legacy := p, false
	raw, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		// Upgrade from v1.1 / v1.2.0: start from session.json, never write it.
		src, legacy = a.legacySessionPath(), true
		raw, err = os.ReadFile(src)
		if os.IsNotExist(err) {
			return SessionLoad{}, nil // first run
		}
	}
	if err != nil {
		if !legacy {
			a.sessionBlocked.Store(true) // could not even read it: do not write over it
		}
		return SessionLoad{Notice: fmt.Sprintf("이전 세션 파일을 읽지 못했습니다 (%s).\n%s\n이번 실행에서 연 탭은 다음 실행 때 복원되지 않을 수 있습니다.", err, src)}, nil
	}
	reason, recovered, n := checkSession(raw)
	if reason == "" {
		return SessionLoad{Data: string(raw)}, nil
	}
	kept, kerr := keepBrokenSession(a.dataDir, src, raw, !legacy)
	var b strings.Builder
	fmt.Fprintf(&b, "이전 세션 파일(%s)을 읽지 못했습니다 — %s.\n", filepath.Base(src), reason)
	if kerr != nil {
		if !legacy {
			a.sessionBlocked.Store(true)
		}
		fmt.Fprintf(&b, "원본을 따로 보관하지 못해(%s), 덮어쓰지 않도록 이번 실행에서는 세션을 저장하지 않습니다.\n원본: %s", kerr, src)
	} else {
		fmt.Fprintf(&b, "원본은 %s 에 그대로 보관했습니다.", kept)
	}
	if n > 0 {
		fmt.Fprintf(&b, "\n깨지지 않은 탭 %d개는 되살렸습니다.", n)
	} else {
		b.WriteString("\n되살릴 수 있는 탭이 없어 새로 시작합니다.")
	}
	return SessionLoad{Data: recovered, Notice: b.String()}, nil
}

// checkSession mirrors the frontend's acceptance test (a number version no
// newer than ours, and a tabs array). reason is "" for a good session;
// otherwise it says why, and recovered holds the tabs that are still whole (n
// of them) wrapped in a minimal session, or "".
func checkSession(raw []byte) (reason, recovered string, n int) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "파일이 비어 있습니다", "", 0
	}
	var s struct {
		Version json.RawMessage `json:"version"`
		Tabs    json.RawMessage `json:"tabs"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		tabs := recoverTabs(raw)
		reason = "파일이 중간에 끊겼거나 형식이 깨져 있습니다"
		if len(tabs) == 0 {
			return reason, "", 0
		}
		var b bytes.Buffer
		fmt.Fprintf(&b, `{"version":%d,"tabs":[`, sessionFormatVersion)
		for i, t := range tabs {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(t)
		}
		b.WriteString(`]}`)
		return reason, b.String(), len(tabs)
	}
	var ver float64
	if len(s.Version) == 0 || json.Unmarshal(s.Version, &ver) != nil {
		return "세션 버전 정보가 없습니다", "", 0
	}
	if ver > sessionFormatVersion {
		return fmt.Sprintf("이 Chipper 가 모르는 세션 형식입니다 (버전 %v — 더 새 Chipper 가 저장한 것일 수 있습니다)", ver), "", 0
	}
	if t := bytes.TrimSpace(s.Tabs); len(t) == 0 || t[0] != '[' {
		return "탭 목록이 없습니다", "", 0
	}
	return "", "", 0
}

// recoverTabs reads a cut-off session as far as it goes and returns the tab
// objects that are complete. Nothing is recovered from a session that says it
// is a newer format.
func recoverTabs(raw []byte) []json.RawMessage {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	var out []json.RawMessage
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return out
		}
		switch key, _ := kt.(string); key {
		case "version":
			var v float64
			if err := dec.Decode(&v); err != nil || v > sessionFormatVersion {
				return nil
			}
		case "tabs":
			if t, err := dec.Token(); err != nil || t != json.Delim('[') {
				return out
			}
			for dec.More() {
				var m json.RawMessage
				if err := dec.Decode(&m); err != nil {
					return out
				}
				if len(m) > 0 && m[0] == '{' {
					out = append(out, m)
				}
			}
			if _, err := dec.Token(); err != nil { // the closing ]
				return out
			}
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return out
			}
		}
	}
	return out
}

// keepBrokenSession puts an unreadable session aside as
// session.broken-<time>.json in dir: moved when it is our own file (so it can
// never be overwritten), copied when it is session.json (left untouched).
func keepBrokenSession(dir, src string, raw []byte, move bool) (string, error) {
	stamp := time.Now().Format("20060102-150405")
	dst := filepath.Join(dir, "session.broken-"+stamp+".json")
	for i := 2; ; i++ {
		if _, err := os.Lstat(dst); os.IsNotExist(err) {
			break
		}
		dst = filepath.Join(dir, fmt.Sprintf("session.broken-%s-%d.json", stamp, i))
	}
	if move {
		if err := os.Rename(src, dst); err == nil {
			return dst, nil
		}
	}
	if err := atomicWrite(dst, raw, 0o600); err != nil {
		return "", err
	}
	return dst, nil
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
	// Windows-only: the notice explains why the self-replacing updater was
	// dropped, and the corporate EDR product it refers to only runs on Windows.
	// Other platforms never had a self-replacing updater in the first place (see
	// internal/updater/apply_other.go), so there is nothing to explain.
	if runtime.GOOS != "windows" {
		return
	}
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
