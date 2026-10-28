package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 「📂 디렉토리 열기」: any folder opens (no 「서버 폴더가 없습니다」), the
// total file limit, progress and cancel.

func writeFiles(t *testing.T, root string, rels ...string) {
	t.Helper()
	for _, r := range rels {
		p := filepath.Join(root, filepath.FromSlash(r))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func serverNames(b Bundle) string {
	var n []string
	for _, s := range b.Servers {
		n = append(n, s.Name)
	}
	return strings.Join(n, ",")
}

// OD-1: a folder with only files (no sub-folders) opens; the files are the
// root files and the server list is [] (not null).
func TestOpenDir_FilesOnly(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "messages", "messages.1", "app.log", ".hidden")
	b, err := (&App{}).ScanBundle(root)
	if err != nil {
		t.Fatalf("files-only folder must open: %v", err)
	}
	if got := strings.Join(rootFilesR(b), ","); got != "app.log,messages,messages.1" {
		t.Errorf("root files = %q", got)
	}
	js, _ := json.Marshal(b)
	if !strings.Contains(string(js), `"servers":[]`) {
		t.Errorf("servers should be [] → %s", js)
	}
	if b.Truncated || b.Files != 3 || b.FileLimit != maxDirFiles {
		t.Errorf("truncated=%v files=%d limit=%d", b.Truncated, b.Files, b.FileLimit)
	}
}

// OD-2: an empty folder opens too (empty tree), not an error.
func TestOpenDir_EmptyFolder(t *testing.T) {
	b, err := (&App{}).ScanBundle(t.TempDir())
	if err != nil {
		t.Fatalf("empty folder must open: %v", err)
	}
	if len(b.Servers) != 0 || len(b.RootFiles) != 0 {
		t.Errorf("want nothing: %+v", b)
	}
}

// OD-3: only an unreadable folder is an error.
func TestOpenDir_MissingFolderIsError(t *testing.T) {
	if _, err := (&App{}).ScanBundle(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("missing folder should be an error")
	}
}

// OD-4: one deep tree under one top folder keeps the "/" relative path under
// that top folder (the tag key the tree uses).
func TestOpenDir_DeepTree(t *testing.T) {
	root := t.TempDir()
	deep := "a/b/c/d/e/f/g/h/i/j/k.log"
	writeFiles(t, root, "logs/"+deep, "logs/top.log")
	b, err := (&App{}).ScanBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	if serverNames(b) != "logs" {
		t.Fatalf("servers = %q", serverNames(b))
	}
	var rels []string
	for _, f := range b.Servers[0].Files {
		rels = append(rels, f.Rel)
	}
	if strings.Join(rels, ",") != deep+",top.log" {
		t.Errorf("rels = %v", rels)
	}
}

// OD-5: dozens of top folders, natural order (server2 before server10).
func TestOpenDir_ManyFolders(t *testing.T) {
	root := t.TempDir()
	var want []string
	for i := 1; i <= 40; i++ {
		writeFiles(t, root, fmt.Sprintf("server%d/m/x.log", i))
		want = append(want, fmt.Sprintf("server%d", i))
	}
	b, err := (&App{}).ScanBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	if serverNames(b) != strings.Join(want, ",") {
		t.Errorf("servers = %s", serverNames(b))
	}
	if b.Files != 40 || b.Truncated {
		t.Errorf("files=%d truncated=%v", b.Files, b.Truncated)
	}
}

// OD-6: the total limit stops the scan; folders after it are listed but not
// read (NotRead), the cut follows the tree order, and the root files count.
func TestOpenDir_TotalLimit(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "r1.log", "r2.log")
	for i := 1; i <= 5; i++ {
		for k := 0; k < 4; k++ {
			writeFiles(t, root, fmt.Sprintf("s%d/f%d.log", i, k))
		}
	}
	b, err := scanDir(context.Background(), root, 100, 9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.Files != 9 || !b.Truncated || b.FileLimit != 9 {
		t.Fatalf("files=%d truncated=%v limit=%d", b.Files, b.Truncated, b.FileLimit)
	}
	got := []string{}
	for _, s := range b.Servers {
		got = append(got, fmt.Sprintf("%s:%d:%v:%v", s.Name, len(s.Files), s.Truncated, s.NotRead))
	}
	want := "s1:4:false:false,s2:3:true:false,s3:0:false:true,s4:0:false:true,s5:0:false:true"
	if strings.Join(got, ",") != want {
		t.Errorf("servers = %s\nwant      %s", strings.Join(got, ","), want)
	}
	if len(b.RootFiles) != 2 {
		t.Errorf("root files = %d", len(b.RootFiles))
	}
	js, _ := json.Marshal(b.Servers[4])
	if strings.Contains(string(js), "null") {
		t.Errorf("not-read folder must have files [] → %s", js)
	}
}

// OD-7: the per-folder limit also covers files lying directly in the folder.
func TestOpenDir_RootPerFolderLimit(t *testing.T) {
	root := t.TempDir()
	for k := 0; k < 6; k++ {
		writeFiles(t, root, fmt.Sprintf("f%d.log", k))
	}
	writeFiles(t, root, "s1/a.log")
	b, err := scanDir(context.Background(), root, 4, 100, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.RootFiles) != 4 || !b.RootTruncated || b.Truncated {
		t.Errorf("root=%d rootTruncated=%v truncated=%v", len(b.RootFiles), b.RootTruncated, b.Truncated)
	}
	if len(b.Servers) != 1 || len(b.Servers[0].Files) != 1 {
		t.Errorf("s1 should still be read: %+v", b.Servers)
	}
}

// OD-8: cancel — before the scan, and from the progress callback mid-scan.
func TestOpenDir_Cancel(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 30; i++ {
		writeFiles(t, root, fmt.Sprintf("s%d/a/b.log", i))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := scanDir(ctx, root, 100, 1000, nil); !errors.Is(err, ErrDirScanCanceled) {
		t.Errorf("canceled before: err = %v", err)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	calls := 0
	_, err := scanDir(ctx2, root, 100, 1000, func(files, dirs int) {
		calls++
		cancel2()
	})
	// progress runs every 100ms: on a fast disk the scan may finish first and
	// only the final call happens — then cancel the next way.
	if calls == 0 {
		t.Fatal("progress never called")
	}
	if err != nil && !errors.Is(err, ErrDirScanCanceled) {
		t.Errorf("mid-scan cancel: err = %v", err)
	}
}

// OD-9: CancelScanBundle stops a running ScanBundle (a slow walk simulated by
// many folders; the scan is canceled right away from another goroutine).
func TestOpenDir_CancelBinding(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 400; i++ {
		writeFiles(t, root, fmt.Sprintf("s%03d/a/b/c.log", i))
	}
	a := &App{}
	done := make(chan error, 1)
	go func() {
		_, err := a.ScanBundle(root)
		done <- err
	}()
	// cancel as soon as the scan registered itself
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		dirScan.mu.Lock()
		running := dirScan.cancel != nil
		dirScan.mu.Unlock()
		if running {
			break
		}
		time.Sleep(time.Millisecond)
	}
	a.CancelScanBundle()
	select {
	case err := <-done:
		// the scan may have finished before the cancel landed (fast disk)
		if err != nil && !errors.Is(err, ErrDirScanCanceled) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("scan did not stop")
	}
	a.CancelScanBundle() // no scan running: no-op
}

// OD-10: progress reports a growing count and a final call with the total.
func TestOpenDir_ProgressFinal(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a.log", "s1/x/y.log", "s2/z.log")
	var last [2]int
	_, err := scanDir(context.Background(), root, 100, 100, func(files, dirs int) { last = [2]int{files, dirs} })
	if err != nil {
		t.Fatal(err)
	}
	if last[0] != 3 || last[1] < 3 {
		t.Errorf("final progress = %v", last)
	}
}
