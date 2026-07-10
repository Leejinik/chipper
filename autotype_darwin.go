//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// macOS keystroke injection via osascript + System Events (no CGO). Requires the
// app to be granted 손쉬운 사용(Accessibility) and 자동화(Automation) permission.
// Text is delivered via clipboard paste (Cmd+V) so it is correct regardless of
// the active keyboard layout / Korean IME; the commit key is a real key event.

func runOsascript(args ...string) (string, error) {
	out, err := exec.Command("osascript", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func accessibilityHint(out string, err error) string {
	low := strings.ToLower(out)
	// Automation (Apple Events / TCC) denial — distinct from Accessibility.
	if strings.Contains(out, "-1743") ||
		strings.Contains(low, "send apple events") ||
		(strings.Contains(low, "not authorized") && strings.Contains(low, "apple event")) {
		return "자동화(Automation) 권한이 필요합니다: 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 이 앱이 'System Events' 제어를 허용하도록 설정하세요."
	}
	// Accessibility (assistive access) denial.
	if strings.Contains(low, "not allowed") || strings.Contains(low, "assistive") ||
		strings.Contains(out, "-1719") || strings.Contains(out, "-25211") {
		return "손쉬운 사용(Accessibility) 권한이 필요합니다: 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 이 앱을 허용하세요."
	}
	if out != "" {
		return out
	}
	if err != nil {
		return err.Error()
	}
	return "알 수 없는 오류"
}

// frontmostUnixID returns the unix pid (as text) of the frontmost app process.
// Using the pid (not bundle id) is robust for processes without a bundle id and
// lets us detect our own window (pid == os.Getpid()).
func frontmostUnixID() (string, error) {
	out, err := runOsascript("-e",
		`tell application "System Events" to get unix id of (first application process whose frontmost is true)`)
	if err != nil {
		return "", fmt.Errorf("%s", accessibilityHint(out, err))
	}
	return strings.TrimSpace(out), nil
}

func platformCaptureFocus() (string, error) {
	id, err := frontmostUnixID()
	if err != nil {
		return "", err
	}
	if id == "" {
		return "", fmt.Errorf("전면 앱을 찾을 수 없습니다")
	}
	if id == fmt.Sprintf("%d", os.Getpid()) {
		return "", fmt.Errorf("대상 창이 이 앱입니다 — 외부 입력창을 먼저 클릭하세요")
	}
	return id, nil
}

func platformFocusChanged(token string) bool {
	id, err := frontmostUnixID()
	if err != nil {
		return true // treat a stat error as focus lost (safer: abort)
	}
	return id != token
}

// chipsScript pastes one item (IME-safe) and presses the commit key, but only if
// the frontmost process is still the expected pid. Values are passed via argv
// (after a "--" sentinel) so there is no AppleScript escaping/injection and IDs
// starting with "-" are not parsed as osascript options.
const chipsScript = `on run argv
	set theText to item 1 of argv
	set commitKey to item 2 of argv
	set expected to item 3 of argv
	tell application "System Events"
		set frontPid to (unix id of (first application process whose frontmost is true)) as text
		if frontPid is not equal to expected then
			return "FOCUS_LOST"
		end if
		set the clipboard to theText
		keystroke "v" using {command down}
		if commitKey is "tab" then
			key code 48
		else if commitKey is "comma" then
			keystroke ","
		else
			key code 36
		end if
	end tell
	return "OK"
end run`

func platformTypeItem(text, commitKey, target string) error {
	out, err := runOsascript("-e", chipsScript, "--", text, commitKey, target)
	if err != nil {
		return fmt.Errorf("%s", accessibilityHint(out, err))
	}
	switch out {
	case "OK":
		return nil
	case "FOCUS_LOST":
		return fmt.Errorf("포커스가 대상 창에서 벗어났습니다")
	default:
		return fmt.Errorf("입력 실패: %s", out)
	}
}

// Clipboard save/restore around a run, since we paste each item.
var (
	savedClip   string
	savedClipOK bool
)

func platformBeginRun() {
	out, err := runOsascript("-e", "the clipboard")
	savedClip, savedClipOK = out, err == nil
}

func platformEndRun() {
	if savedClipOK {
		_, _ = runOsascript("-e", "on run argv", "-e", "set the clipboard to item 1 of argv", "-e", "end run", "--", savedClip)
	}
}
