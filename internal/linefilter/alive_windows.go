package linefilter

import "syscall"

// processAlive: OpenProcess fails for a pid that no longer exists.
func processAlive(pid int) bool {
	const queryLimited = 0x1000 // PROCESS_QUERY_LIMITED_INFORMATION
	h, err := syscall.OpenProcess(queryLimited, false, uint32(pid))
	if err != nil {
		return false
	}
	var code uint32
	ok := syscall.GetExitCodeProcess(h, &code) == nil && code == 259 // STILL_ACTIVE
	syscall.CloseHandle(h)
	return ok
}
