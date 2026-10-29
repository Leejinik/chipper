package main

import "github.com/wailsapp/wails/v2/pkg/menu"

// appMenuFor is the application menu for an OS. macOS only: Wails v2.12 sets no
// menu when options.Menu is nil (internal/frontend/desktop/darwin/window.go only
// calls SetApplicationMenu for a non-nil menu), and without the Edit menu's
// copy:/cut:/paste:/selectAll: key equivalents ⌘C/⌘X/⌘V do nothing in WKWebView.
// The App menu brings ⌘H (hide), ⌥⌘H and ⌘Q (quit) — keybinds.ts refuses those
// for app shortcuts on macOS. Windows and Linux keep no menu bar.
func appMenuFor(goos string) *menu.Menu {
	if goos != "darwin" {
		return nil
	}
	return menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu())
}
