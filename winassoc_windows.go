//go:build windows

package main

// Windows file-association management for the PORTABLE chipper.exe.
//
// chipper ships as a single portable exe (no NSIS installer), so the usual
// installer-time association is never written. Instead the app registers itself
// per-user into HKCU\Software\Classes at the user's request. This makes chipper
// appear in Explorer's "다른 앱으로 열기 / Open with" list and as a selectable
// app in Windows Settings › Default apps. It deliberately uses OpenWithProgids
// (additive) and never touches the extension's UserChoice default — modern
// Windows protects that with a per-(user+ext) hash and silently rejects direct
// writes, so the user makes the final "set as default" choice in the OS UI.

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	chipperProgID     = "Chipper.Document"
	appExeKey         = "chipper.exe" // stable key name under Applications\
	registeredAppName = "Chipper"     // must equal the ms-settings ?registeredAppUser token
)

// FileAssociationSupported reports whether the in-app "파일 연결 관리" panel
// applies to this platform. Windows: yes.
func (a *App) FileAssociationSupported() bool { return true }

// SupportedFileTypes returns the associable types shown as checkboxes.
func (a *App) SupportedFileTypes() []AssocType { return chipperAssocTypes }

// --- status ----------------------------------------------------------------

// AssociationStatus reports, per extension, whether chipper is currently
// registered as an "Open with" candidate.
func (a *App) AssociationStatus() (map[string]bool, error) {
	out := make(map[string]bool, len(chipperAssocTypes))
	for _, t := range chipperAssocTypes {
		out[t.Ext] = extRegistered(t.Ext)
	}
	return out, nil
}

func extRegistered(ext string) bool {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Classes\`+ext+`\OpenWithProgids`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(chipperProgID)
	return err == nil
}

func extAnyRegistered() bool {
	for _, t := range chipperAssocTypes {
		if extRegistered(t.Ext) {
			return true
		}
	}
	return false
}

// --- register --------------------------------------------------------------

// RegisterFileTypes registers chipper as an "Open with" candidate for the given
// extensions (per-user, no admin). Idempotent.
func (a *App) RegisterFileTypes(exts []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if abs, e := filepath.Abs(exe); e == nil {
		exe = abs
	}
	openCmd := fmt.Sprintf(`"%s" "%%1"`, exe)
	iconVal := exe + ",0"

	// ProgID: the class Explorer opens for our documents.
	pid := `Software\Classes\` + chipperProgID
	if err := setDefault(pid, "Chipper 문서"); err != nil {
		return err
	}
	_ = setValue(pid, "FriendlyTypeName", "Chipper 문서")
	_ = setDefault(pid+`\DefaultIcon`, iconVal)
	if err := setDefault(pid+`\shell\open\command`, openCmd); err != nil {
		return err
	}

	// Applications\chipper.exe: the app entry backing the "Open with" list.
	appKey := `Software\Classes\Applications\` + appExeKey
	_ = setValue(appKey, "FriendlyAppName", "Chipper")
	_ = setDefault(appKey+`\shell\open\command`, openCmd)

	// Capabilities + RegisteredApplications: makes chipper show up as an app in
	// Settings › Default apps (the "set as default" surface).
	cap := `Software\Chipper\Capabilities`
	_ = setValue(cap, "ApplicationName", "Chipper")
	_ = setValue(cap, "ApplicationDescription", "Markdown/텍스트/HTML 편집기")
	if err := setValue(`Software\RegisteredApplications`, registeredAppName, cap); err != nil {
		return err
	}

	// Per extension: additive candidate registration. Never writes the (Default)
	// of the extension key, so the current default handler is left untouched.
	for _, ext := range exts {
		_ = setValue(appKey+`\SupportedTypes`, ext, "")
		if err := setValue(`Software\Classes\`+ext+`\OpenWithProgids`, chipperProgID, ""); err != nil {
			return err
		}
		_ = setValue(cap+`\FileAssociations`, ext, chipperProgID)
	}
	notifyShellAssocChanged()
	return nil
}

// --- unregister ------------------------------------------------------------

// UnregisterFileTypes removes chipper as a candidate for the given extensions,
// and tears down the shared ProgID/Capabilities trees once nothing remains.
func (a *App) UnregisterFileTypes(exts []string) error {
	appKey := `Software\Classes\Applications\` + appExeKey
	cap := `Software\Chipper\Capabilities`
	for _, ext := range exts {
		deleteValue(`Software\Classes\`+ext+`\OpenWithProgids`, chipperProgID)
		// RegisterFileTypes' CreateKey materializes the intermediate
		// Software\Classes\<ext> and \OpenWithProgids keys for extensions the
		// user had no per-user class for. Reap them if — and only if — they are
		// now empty, so we never touch a pre-existing default or another app's
		// OpenWithProgids entries.
		deleteKeyIfEmpty(`Software\Classes\` + ext + `\OpenWithProgids`)
		deleteKeyIfEmpty(`Software\Classes\` + ext)
		deleteValue(appKey+`\SupportedTypes`, ext)
		deleteValue(cap+`\FileAssociations`, ext)
	}
	if !extAnyRegistered() {
		deleteValue(`Software\RegisteredApplications`, registeredAppName)
		_ = deleteKeyRecursive(`Software\Chipper`)
		_ = deleteKeyRecursive(appKey)
		_ = deleteKeyRecursive(`Software\Classes\` + chipperProgID)
	}
	notifyShellAssocChanged()
	return nil
}

// --- self-heal after the portable exe is moved -----------------------------

// syncFileAssociationsOnLaunch repoints the registered "open" command at the
// current exe path if (and only if) the user already opted in and the recorded
// path is stale. It never auto-adds associations.
func (a *App) syncFileAssociationsOnLaunch() {
	if !extAnyRegistered() {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if abs, e := filepath.Abs(exe); e == nil {
		exe = abs
	}
	openCmd := fmt.Sprintf(`"%s" "%%1"`, exe)
	if cur, ok := currentProgIDCommand(); ok && cur == openCmd {
		return // already current — avoid needless registry churn / icon-cache flicker
	}
	_ = setDefault(`Software\Classes\`+chipperProgID+`\shell\open\command`, openCmd)
	_ = setDefault(`Software\Classes\`+chipperProgID+`\DefaultIcon`, exe+",0")
	_ = setDefault(`Software\Classes\Applications\`+appExeKey+`\shell\open\command`, openCmd)
	notifyShellAssocChanged()
}

func currentProgIDCommand() (string, bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Classes\`+chipperProgID+`\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer k.Close()
	v, _, err := k.GetStringValue("")
	return v, err == nil
}

// --- open the OS "default apps" chooser (the actual "make default" step) ----

// OpenDefaultAppsSettings opens the Windows Settings › Default apps page,
// deep-linked to chipper when the OS supports it. The app cannot force the
// default itself, so this is where the user confirms the choice.
func (a *App) OpenDefaultAppsSettings() error {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString("ms-settings:defaultapps?registeredAppUser=" + registeredAppName)
	return windows.ShellExecute(0, verb, file, nil, nil, int32(windows.SW_SHOWNORMAL))
}

// --- registry helpers ------------------------------------------------------

func setValue(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.WRITE)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func setDefault(path, value string) error { return setValue(path, "", value) }

func deleteValue(path, name string) {
	if k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.SET_VALUE); err == nil {
		_ = k.DeleteValue(name)
		k.Close()
	}
}

// deleteKeyIfEmpty removes a key only when it holds no subkeys and no values,
// so reaping our own leftovers can never delete a pre-existing user default or
// another application's entries.
func deleteKeyIfEmpty(path string) {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.READ)
	if err != nil {
		return
	}
	subs, _ := k.ReadSubKeyNames(-1)
	vals, _ := k.ReadValueNames(-1)
	k.Close()
	if len(subs) == 0 && len(vals) == 0 {
		_ = registry.DeleteKey(registry.CURRENT_USER, path)
	}
}

// deleteKeyRecursive removes a key and every subkey under it (RegDeleteKey only
// removes leaf keys).
func deleteKeyRecursive(path string) error {
	if k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.READ); err == nil {
		names, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, n := range names {
			_ = deleteKeyRecursive(path + `\` + n)
		}
	} else if err == registry.ErrNotExist {
		return nil
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}

// --- shell notification ----------------------------------------------------

var (
	modShell32         = windows.NewLazySystemDLL("shell32.dll")
	procSHChangeNotify = modShell32.NewProc("SHChangeNotify")
)

const (
	shcneAssocChanged = 0x08000000 // SHCNE_ASSOCCHANGED
	shcnfIDList       = 0x0000     // SHCNF_IDLIST
)

// notifyShellAssocChanged tells Explorer that file associations changed so open
// windows and the icon cache refresh without a logoff.
func notifyShellAssocChanged() {
	_, _, _ = procSHChangeNotify.Call(uintptr(shcneAssocChanged), uintptr(shcnfIDList), 0, 0)
}
