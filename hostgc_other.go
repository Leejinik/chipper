//go:build !windows

package main

// 「화면 메모리 정리」 is Windows only (WebView2's DevTools protocol, hostgc_windows.go):
// elsewhere it is off and the heap limit stays as it is.
type hostGC struct{}

func findHostGC(any) *hostGC      { return &hostGC{} }
func (h *hostGC) ready() bool     { return false }
func (h *hostGC) why() string     { return "not on this platform" }
func (h *hostGC) collect() string { return "off: not on this platform" }
