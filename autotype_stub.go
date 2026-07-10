//go:build !windows && !darwin

package main

import "fmt"

// Fallback for platforms without a keystroke implementation (e.g. Linux/CI),
// so the package still compiles. The app ships on Windows and macOS.

func platformCaptureFocus() (string, error) {
	return "", fmt.Errorf("이 플랫폼에서는 자동 입력이 지원되지 않습니다")
}

func platformFocusChanged(string) bool { return true }

func platformTypeItem(_, _, _ string) error {
	return fmt.Errorf("이 플랫폼에서는 자동 입력이 지원되지 않습니다")
}

func platformBeginRun() {}
func platformEndRun()   {}
