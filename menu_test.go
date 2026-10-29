package main

import (
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu"
)

// macOS gets the App + Edit menus (Wails v2.12 sets no menu at all when
// options.Menu is nil, and WKWebView's ⌘C/⌘V/⌘X need the Edit menu's
// copy:/paste:/cut: key equivalents); Windows and Linux stay menu-less.
func TestAppMenuFor(t *testing.T) {
	for _, goos := range []string{"windows", "linux"} {
		if m := appMenuFor(goos); m != nil {
			t.Fatalf("%s: want no menu, got %d items", goos, len(m.Items))
		}
	}
	m := appMenuFor("darwin")
	if m == nil || len(m.Items) != 2 {
		t.Fatalf("darwin: want App + Edit menus, got %#v", m)
	}
	if m.Items[0].Role != menu.AppMenuRole || m.Items[1].Role != menu.EditMenuRole {
		t.Fatalf("darwin: roles %v, %v", m.Items[0].Role, m.Items[1].Role)
	}
}
