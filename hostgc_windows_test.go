//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"testing"
)

// What hostgc_windows.go reaches by reflection is Wails' private layout:
// pinned here so a Wails / go-webview2 upgrade in go.mod says so instead of
// quietly turning 「화면 메모리 정리」 off.
const (
	pinWails    = "v2.12.0"
	pinWebview2 = "v1.0.22"
)

func TestHostGCPinnedVersions(t *testing.T) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		t.Skip("no build info")
	}
	want := map[string]string{"github.com/wailsapp/wails/v2": pinWails, "github.com/wailsapp/go-webview2": pinWebview2}
	for _, d := range bi.Deps {
		v, ok := want[d.Path]
		if !ok {
			continue
		}
		got := d.Version
		if d.Replace != nil {
			got = d.Replace.Version // a QA copy (replace with a folder) has none: checked by source below
		}
		if got != "" && got != v {
			t.Errorf("%s is %s, hostgc_windows.go was checked against %s — check the fields it reaches (TestHostGCWailsSource) and update the pins", d.Path, got, v)
		}
		delete(want, d.Path)
	}
	for p := range want {
		t.Errorf("%s not in the build", p)
	}
}

// The source of the Wails in use still has what hostgc_windows.go looks for.
func TestHostGCWailsSource(t *testing.T) {
	dir := modDir(t, "github.com/wailsapp/wails/v2")
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		return string(b)
	}
	fe := read("internal/frontend/desktop/windows/frontend.go")
	for _, re := range []string{`type Frontend struct`, `\n\tchromium\s+\*edge\.Chromium\n`, `\n\tmainWindow\s+\*Window\n`} {
		if !regexp.MustCompile(re).MatchString(fe) {
			t.Errorf("Wails frontend.go: no %q", re)
		}
	}
	if !strings.Contains(read("internal/frontend/desktop/windows/window.go"), "\twinc.Form\n") {
		t.Error("Wails Window no longer embeds winc.Form (Invoke)")
	}
	if !regexp.MustCompile(`func \(cba \*ControlBase\) Invoke\(f func\(\)\)`).MatchString(read("internal/frontend/desktop/windows/winc/controlbase.go")) {
		t.Error("winc ControlBase.Invoke(func()) gone")
	}
	if !strings.Contains(read("internal/app/app_production.go"), `context.WithValue(ctx, "frontend", appFrontend)`) {
		t.Error(`Wails no longer puts the frontend in ctx as "frontend"`)
	}
	wv := modDir(t, "github.com/wailsapp/go-webview2")
	b, err := os.ReadFile(filepath.Join(wv, "pkg/edge/corewebview2.go"))
	if err != nil {
		t.Fatal(err)
	}
	// slot 36: IUnknown (3) + 33 entries before CallDevToolsProtocolMethod
	vt := string(b)
	i := strings.Index(vt, "type iCoreWebView2Vtbl struct")
	j := strings.Index(vt[i:], "CallDevToolsProtocolMethod")
	if i < 0 || j < 0 || strings.Count(vt[i:i+j], "ComProc") != slotCallDevToolsProtocolMethod-3 {
		t.Errorf("ICoreWebView2 vtable: CallDevToolsProtocolMethod is not slot %d", slotCallDevToolsProtocolMethod)
	}
}

func modDir(t *testing.T, mod string) string {
	out, err := exec.Command("go", "list", "-m", "-f", "{{if .Replace}}{{.Replace.Dir}}{{else}}{{.Dir}}{{end}}", mod).Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		t.Skipf("go list %s: %v", mod, err)
	}
	return strings.TrimSpace(string(out))
}

// Anything that is not Wails' windows Frontend: off, quietly — no panic.
func TestHostGCOffQuietly(t *testing.T) {
	type Frontend struct {
		chromium   *int
		mainWindow *int
	}
	var nilPtr *Frontend
	for _, fe := range []any{nil, 3, "x", nilPtr, &Frontend{}, &struct{ a int }{}} {
		h := findHostGC(fe)
		if h.ready() {
			t.Errorf("%T: ready", fe)
		}
		if why := h.collect(); why == "" {
			t.Errorf("%T: collect said done", fe)
		}
	}
	if (&App{}).HostGCReady() {
		t.Error("an App without a Wails context: ready")
	}
}
