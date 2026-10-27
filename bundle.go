package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// A log bundle is a folder holding one sub-folder per server — either the
// rtaskmgr layout (<server>/<category>/<module>/<file>) or the common
// "server1, server2, server3 with every file thrown in" layout. Each server's
// files are listed by their path relative to that server's folder, so "the same
// log on every server" can be matched across servers.

// BundleFile is one file inside a server folder.
type BundleFile struct {
	Rel        string `json:"rel"` // relative to the server folder, always "/"-separated
	Size       int64  `json:"size"`
	Compressed bool   `json:"compressed"` // .gz/.zip/... — cannot be opened as text
}

// BundleServer is one server folder of the bundle.
type BundleServer struct {
	Name       string       `json:"name"` // folder name
	Files      []BundleFile `json:"files"`
	Truncated  bool         `json:"truncated"`  // more than maxBundleFiles files
	Unreadable int          `json:"unreadable"` // entries skipped because they could not be read
}

// Bundle is the scanned bundle root.
type Bundle struct {
	Root    string         `json:"root"`
	Servers []BundleServer `json:"servers"`
}

const maxBundleFiles = 5000 // per server; keeps a mis-picked huge folder from hanging the scan

var compressedExts = map[string]bool{
	".gz": true, ".tgz": true, ".zip": true, ".bz2": true, ".xz": true, ".zst": true, ".7z": true, ".tar": true,
}

// OpenFolderDialog asks for the bundle's root folder. "" when canceled.
func (a *App) OpenFolderDialog() (string, error) {
	return wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "로그 묶음 폴더 고르기 (server1, server2… 폴더가 들어 있는 상위 폴더)",
	})
}

// ScanBundle lists the server folders directly under root and, for each, every
// file below it (recursively). Hidden entries are skipped.
func (a *App) ScanBundle(root string) (Bundle, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return Bundle{}, err
	}
	b := Bundle{Root: root}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		// Files starts as [] so an empty server folder reaches the frontend as an
		// empty list, not JSON null (null crashed the whole UI: "t.files is not
		// iterable").
		srv := BundleServer{Name: e.Name(), Files: []BundleFile{}}
		base := filepath.Join(root, e.Name())
		walkErr := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
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
				return nil
			}
			if len(srv.Files) >= maxBundleFiles {
				srv.Truncated = true
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
			return nil
		})
		if walkErr != nil {
			srv.Unreadable++
		}
		sort.Slice(srv.Files, func(i, j int) bool { return srv.Files[i].Rel < srv.Files[j].Rel })
		b.Servers = append(b.Servers, srv)
	}
	if len(b.Servers) == 0 {
		return b, errors.New("이 폴더 안에 서버 폴더가 없습니다. server1, server2… 처럼 서버별 폴더가 들어 있는 상위 폴더를 골라 주세요.")
	}
	sort.Slice(b.Servers, func(i, j int) bool { return naturalLess(b.Servers[i].Name, b.Servers[j].Name) })
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
