package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is injected at build time via -ldflags "-X main.Version=v1.2.3".
var Version = "dev"

func main() {
	app := NewApp()
	app.version = Version

	err := wails.Run(&options.App{
		Title:     "Chipper",
		Width:     1400,
		Height:    900,
		MinWidth:  900,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 24, G: 26, B: 31, A: 1},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true, // deliver dropped files' absolute paths to the frontend
		},
		// macOS delivers a double-clicked file's path here (Finder does NOT put it
		// in os.Args — it arrives via the openFile Apple event, which Wails wires
		// to this callback). Fires at cold start and while running. No-op on Windows.
		Mac: &mac.Options{
			OnFileOpen: func(filePath string) { app.deliverOpenPaths(existingFiles([]string{filePath})) },
		},
		// Windows/Linux: keep chipper single-window. A second launch (e.g. the user
		// double-clicks another associated file) forwards its argv to the running
		// instance and exits, instead of spawning a second window that would fight
		// over session.json. UniqueId must stay frozen across releases.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "chipper-59C3D6A2-6B1E-4E7B-9E7A-2E1F0A7B5C10",
			OnSecondInstanceLaunch: app.onSecondInstanceLaunch,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
