//go:build windows

package main

import (
	"fmt"
	"runtime"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	inputKeyboard    = 1
	keyeventfKeyUp   = 0x0002
	keyeventfUnicode = 0x0004
	vkReturn         = 0x0D
	vkTab            = 0x09
)

// keybdInput matches Win32 KEYBDINPUT (24 bytes on amd64 via natural alignment).
type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	timeField   uint32
	dwExtraInfo uintptr
}

// input matches Win32 INPUT. On amd64 it must be exactly 40 bytes (cbSize the
// kernel expects): type(4) + pad(4) + union(32, sized by MOUSEINPUT).
type input struct {
	inputType uint32
	_         [4]byte
	ki        keybdInput
	_         [8]byte
}

// Compile-time guard: build fails unless input is exactly 40 bytes.
var _ [1]struct{} = [unsafe.Sizeof(input{}) - 40 + 1]struct{}{}

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procSendInput                = user32.NewProc("SendInput")
	procGetForeground            = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
)

// foregroundIsSelf reports whether the foreground window belongs to this very
// process (comparing PIDs catches every window/frame the app owns).
func foregroundIsSelf() bool {
	h := getForegroundWindow()
	if h == 0 {
		return false
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
	return pid != 0 && pid == windows.GetCurrentProcessId()
}

func sendInputs(events []input) error {
	if len(events) == 0 {
		return nil
	}
	n, _, err := procSendInput.Call(
		uintptr(len(events)),
		uintptr(unsafe.Pointer(&events[0])),
		unsafe.Sizeof(input{}), // cbSize MUST be 40
	)
	if int(n) != len(events) {
		return fmt.Errorf("키 입력 전송 실패 (%d/%d). 대상 창이 관리자 권한으로 실행 중이면 이 앱도 관리자 권한으로 실행해야 합니다. (%v)", int(n), len(events), err)
	}
	return nil
}

func typeCodeUnit(cu uint16) error {
	return sendInputs([]input{
		{inputType: inputKeyboard, ki: keybdInput{wScan: cu, dwFlags: keyeventfUnicode}},
		{inputType: inputKeyboard, ki: keybdInput{wScan: cu, dwFlags: keyeventfUnicode | keyeventfKeyUp}},
	})
}

func pressVK(vk uint16) error {
	return sendInputs([]input{
		{inputType: inputKeyboard, ki: keybdInput{wVk: vk}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vk, dwFlags: keyeventfKeyUp}},
	})
}

func getForegroundWindow() uintptr {
	h, _, _ := procGetForeground.Call()
	return h
}

func platformCaptureFocus() (string, error) {
	h := getForegroundWindow()
	if h == 0 {
		return "", fmt.Errorf("전면 창을 찾을 수 없습니다")
	}
	if foregroundIsSelf() {
		return "", fmt.Errorf("대상 창이 이 앱입니다 — 외부 입력창을 먼저 클릭하세요")
	}
	return fmt.Sprint(h), nil
}

// No clipboard save/restore needed on Windows (SendInput injects directly).
func platformBeginRun() {}
func platformEndRun()   {}

func platformFocusChanged(token string) bool {
	return fmt.Sprint(getForegroundWindow()) != token
}

func platformTypeItem(text, commitKey, target string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// Re-check focus right before injecting (closes the race with the loop guard).
	if fmt.Sprint(getForegroundWindow()) != target {
		return fmt.Errorf("포커스가 대상 창에서 벗어났습니다")
	}
	for _, cu := range utf16.Encode([]rune(text)) {
		if err := typeCodeUnit(cu); err != nil {
			return err
		}
		time.Sleep(3 * time.Millisecond)
	}
	switch commitKey {
	case "tab":
		return pressVK(vkTab)
	case "comma":
		return typeCodeUnit(uint16(','))
	default:
		return pressVK(vkReturn)
	}
}
