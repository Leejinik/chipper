//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// N: a session file another program holds (no sharing) is explained in
// Korean — what to do — with the system's own text kept for 「자세히 보기」.
func TestSessionR_LockedSessionNoticeIsKorean(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, primarySessionName())
	if err := writeFileR(p, sessionWithTabs(1)); err != nil {
		t.Fatal(err)
	}
	name, _ := syscall.UTF16PtrFromString(p)
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0 /* no sharing */, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	r := loadR(&App{dataDir: dir})
	if !strings.Contains(r.notice, "다른 프로그램") || strings.Contains(r.notice, "The process cannot access") {
		t.Errorf("want a Korean notice without the raw system text, got %q", r.notice)
	}
	if !strings.Contains(r.detail, "The process cannot access") && !strings.Contains(r.detail, "프로세스") {
		t.Errorf("want the system's own text under 자세히 보기, got %q", r.detail)
	}
}
