//go:build windows

package main

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type procMemCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

var procGetProcessMemoryInfo = syscall.NewLazyDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

func workingSetOf(h windows.Handle) (uint64, bool) {
	var c procMemCounters
	c.cb = uint32(unsafe.Sizeof(c))
	r, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb))
	if r == 0 {
		return 0, false
	}
	return uint64(c.workingSetSize), true
}

func selfWorkingSet() (uint64, bool) {
	return workingSetOf(windows.CurrentProcess())
}

// childWorkingSets: the working sets of every process descended from this one
// (WebView2 starts its browser process as our child, the renderers under it).
func childWorkingSets() (uint64, int) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, 0
	}
	defer windows.CloseHandle(snap)
	parent := map[uint32]uint32{}
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		parent[pe.ProcessID] = pe.ParentProcessID
	}
	self := windows.GetCurrentProcessId()
	var sum uint64
	n := 0
	for pid := range parent {
		// a descendant of ours (pids are reused: stop at a loop or depth 8)
		p, ok := pid, false
		for d := 0; d < 8 && p != 0; d++ {
			pp, has := parent[p]
			if !has || pp == p {
				break
			}
			if pp == self {
				ok = true
				break
			}
			p = pp
		}
		if !ok {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ, false, pid)
		if err != nil {
			h, err = windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
			if err != nil {
				continue
			}
		}
		if ws, ok := workingSetOf(h); ok {
			sum += ws
			n++
		}
		windows.CloseHandle(h)
	}
	return sum, n
}
