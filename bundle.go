package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// 「📂 디렉토리 열기」: any folder opens as a tree. When it holds one
// sub-folder per server — the rtaskmgr layout (<server>/<category>/<module>/<file>)
// or "server1, server2, server3 with every file thrown in" — the bundle features
// work as before: each top folder is a "server", its files are listed by their
// path relative to that folder (the tag assignment key), so "the same log on
// every server" can be matched across servers. Any other folder (files only,
// one deep tree, dozens of folders) opens the same way; only a folder that
// cannot be read is an error.

// BundleFile is one file inside a server folder.
type BundleFile struct {
	Rel        string `json:"rel"` // relative to the server folder, always "/"-separated
	Size       int64  `json:"size"`
	Compressed bool   `json:"compressed"` // .gz/.zip/... — cannot be opened as text
}

// BundleServer is one top folder of the opened directory.
type BundleServer struct {
	Name       string       `json:"name"` // folder name
	Files      []BundleFile `json:"files"`
	Truncated  bool         `json:"truncated"`  // more than maxBundleFiles files, or the total limit hit inside it
	Unreadable int          `json:"unreadable"` // entries skipped because they could not be read
	// NotRead: the total limit was reached before this folder, so its files
	// were not listed (the tree still shows the folder).
	NotRead bool `json:"notRead"`
}

// Bundle is the scanned directory.
type Bundle struct {
	Root    string         `json:"root"`
	Servers []BundleServer `json:"servers"`
	// Files lying directly in the opened folder (all-servers.log, README.txt,
	// or every file of a folder without sub-folders): shown in the tree as
	// 「(이 폴더)」 so nothing is left out.
	RootFiles     []BundleFile `json:"rootFiles"`
	RootTruncated bool         `json:"rootTruncated"` // more than maxBundleFiles files directly in the folder
	// Truncated: the whole scan stopped at FileLimit files (a drive root or a
	// home folder picked by mistake); the tree says so.
	Truncated bool `json:"truncated"`
	FileLimit int  `json:"fileLimit"`
	Files     int  `json:"files"` // files listed in all
}

const (
	maxBundleFiles = 5000  // per top folder (and for the files directly in the opened folder)
	maxDirFiles    = 20000 // the whole directory: keeps a mis-picked huge folder from hanging the scan and the tree
)

// DirScanProgressEvent is emitted about 10 times a second while a directory is
// scanned: {"root", "files", "dirs"}.
const DirScanProgressEvent = "chipper:dirscan-progress"

// ErrDirScanCanceled: CancelScanBundle stopped the scan (or a newer scan
// replaced it).
var ErrDirScanCanceled = errors.New("디렉토리 읽기를 취소했습니다")

var compressedExts = map[string]bool{
	".gz": true, ".tgz": true, ".zip": true, ".bz2": true, ".xz": true, ".zst": true, ".7z": true, ".tar": true,
}

// One scan at a time: a new ScanBundle cancels the one before it.
var dirScan struct {
	mu     sync.Mutex
	gen    int
	cancel context.CancelFunc
}

// OpenFolderDialog asks for the folder to open. "" when canceled.
func (a *App) OpenFolderDialog() (string, error) {
	return wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "디렉토리 열기 — 왼쪽 트리에 보일 폴더를 고르세요",
	})
}

// CancelScanBundle stops the scan in progress (no-op when none).
func (a *App) CancelScanBundle() {
	dirScan.mu.Lock()
	defer dirScan.mu.Unlock()
	if dirScan.cancel != nil {
		dirScan.cancel()
	}
}

// ScanBundle lists the top folders directly under root and, for each, every
// file below it (recursively), plus the files lying directly in root. Hidden
// entries are skipped. Errors: root cannot be read, or the scan was canceled
// (ErrDirScanCanceled).
func (a *App) ScanBundle(root string) (Bundle, error) {
	ctx, cancel := context.WithCancel(context.Background())
	dirScan.mu.Lock()
	if dirScan.cancel != nil {
		dirScan.cancel()
	}
	dirScan.gen++
	gen := dirScan.gen
	dirScan.cancel = cancel
	dirScan.mu.Unlock()
	defer func() {
		dirScan.mu.Lock()
		if dirScan.gen == gen {
			dirScan.cancel = nil
		}
		dirScan.mu.Unlock()
		cancel()
	}()
	var progress func(files, dirs int)
	if a.ctx != nil {
		progress = func(files, dirs int) {
			wruntime.EventsEmit(a.ctx, DirScanProgressEvent, map[string]interface{}{"root": root, "files": files, "dirs": dirs})
		}
	}
	return scanDir(ctx, root, maxBundleFiles, maxDirFiles, progress)
}

// scanDir does the work of ScanBundle with the limits given (tests use small
// ones). progress (may be nil) is called at most every 100ms and once at the end.
func scanDir(ctx context.Context, root string, perFolder, total int, progress func(files, dirs int)) (Bundle, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return Bundle{}, err
	}
	b := Bundle{Root: root, Servers: []BundleServer{}, RootFiles: []BundleFile{}, FileLimit: total}
	dirs := 0
	last := time.Now()
	tick := func() {
		if progress != nil && time.Since(last) >= 100*time.Millisecond {
			last = time.Now()
			progress(b.Files, dirs)
		}
	}
	full := func() bool { return b.Files >= total }
	// Top folders in the order the tree shows them, so the total limit cuts
	// the last ones.
	sort.SliceStable(entries, func(i, j int) bool { return naturalLess(entries[i].Name(), entries[j].Name()) })
	var folders []fs.DirEntry
	for _, e := range entries {
		if ctx.Err() != nil {
			return Bundle{}, ErrDirScanCanceled
		}
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if e.IsDir() {
			folders = append(folders, e)
			continue
		}
		p := filepath.Join(root, e.Name())
		info, ierr := os.Stat(p) // follows a symlink: what opening it would read
		if ierr != nil || info.IsDir() {
			continue
		}
		if len(b.RootFiles) >= perFolder || full() {
			b.RootTruncated = true
			b.Truncated = b.Truncated || full()
			continue
		}
		b.RootFiles = append(b.RootFiles, BundleFile{
			Rel:        e.Name(),
			Size:       info.Size(),
			Compressed: compressedExts[strings.ToLower(filepath.Ext(p))],
		})
		b.Files++
		tick()
	}
	for _, e := range folders {
		// Files starts as [] so an empty folder reaches the frontend as an
		// empty list, not JSON null (null crashed the whole UI: "t.files is not
		// iterable").
		srv := BundleServer{Name: e.Name(), Files: []BundleFile{}}
		if full() {
			srv.NotRead = true
			b.Truncated = true
			b.Servers = append(b.Servers, srv)
			continue
		}
		base := filepath.Join(root, e.Name())
		walkErr := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ErrDirScanCanceled
			}
			if err != nil {
				srv.Unreadable++ // e.g. no permission: skip it, keep scanning, but say so
				if d != nil && d.IsDir() && p != base {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") && p != base {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				dirs++
				tick()
				return nil
			}
			if len(srv.Files) >= perFolder || full() {
				srv.Truncated = true
				b.Truncated = b.Truncated || full()
				return filepath.SkipAll
			}
			rel, rerr := filepath.Rel(base, p)
			if rerr != nil {
				return nil
			}
			var size int64
			if d.Type()&fs.ModeSymlink != 0 {
				// Report what opening it would read: the target's size.
				if info, serr := os.Stat(p); serr == nil && !info.IsDir() {
					size = info.Size()
				} else {
					return nil // dangling or points at a folder
				}
			} else if info, ierr := d.Info(); ierr == nil {
				size = info.Size()
			}
			srv.Files = append(srv.Files, BundleFile{
				Rel:        filepath.ToSlash(rel),
				Size:       size,
				Compressed: compressedExts[strings.ToLower(filepath.Ext(p))],
			})
			b.Files++
			tick()
			return nil
		})
		if errors.Is(walkErr, ErrDirScanCanceled) {
			return Bundle{}, ErrDirScanCanceled
		}
		if walkErr != nil {
			srv.Unreadable++
		}
		sort.Slice(srv.Files, func(i, j int) bool { return srv.Files[i].Rel < srv.Files[j].Rel })
		b.Servers = append(b.Servers, srv)
	}
	if progress != nil {
		progress(b.Files, dirs)
	}
	sort.SliceStable(b.Servers, func(i, j int) bool { return naturalLess(b.Servers[i].Name, b.Servers[j].Name) })
	sort.Slice(b.RootFiles, func(i, j int) bool { return b.RootFiles[i].Rel < b.RootFiles[j].Rel })
	return b, nil
}

// naturalLess orders "server2" before "server10".
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		da, db := leadingDigits(a), leadingDigits(b)
		if da != "" && db != "" {
			na, nb := strings.TrimLeft(da, "0"), strings.TrimLeft(db, "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			a, b = a[len(da):], b[len(db):]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func leadingDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}
