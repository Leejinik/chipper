//go:build !windows

package main

// Non-Windows stubs so the App bindings generate identically on every platform.
// On macOS the "파일 연결 관리" panel is hidden (FileAssociationSupported=false)
// and the user sets the default via Finder → Get Info → Open with → Change All;
// there is no per-user registry to manage.

func (a *App) FileAssociationSupported() bool              { return false }
func (a *App) SupportedFileTypes() []AssocType             { return chipperAssocTypes }
func (a *App) AssociationStatus() (map[string]bool, error) { return map[string]bool{}, nil }
func (a *App) RegisterFileTypes(exts []string) error       { return nil }
func (a *App) UnregisterFileTypes(exts []string) error     { return nil }
func (a *App) OpenDefaultAppsSettings() error              { return nil }
func (a *App) syncFileAssociationsOnLaunch()               {}
