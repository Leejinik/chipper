//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"reflect"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

// 「화면 메모리 정리」: a full garbage collection of the window's JS memory,
// asked by the host. Text let go (✏️ → 📖, a closed tab) stays in the window's
// memory until V8 collects it, and it may not for minutes — with the heap near
// its ceiling a new 「✏️ 편집으로 열기」 is refused (heapWhyOf) and stayed so
// (.18 10-29: 60s·60s·90s at 3.43GB). The page cannot collect itself; the
// DevTools protocol can (HeapProfiler.collectGarbage: 3.43GB → 1.37GB in 0.8s,
// a QA build, .18 10-29).
//
// Wails 2 gives the app no handle on the WebView, so it is reached through
// Wails' own frontend (ctx.Value("frontend") → *windows.Frontend: the private
// fields chromium *edge.Chromium and mainWindow *Window, whose Invoke runs on
// the window's thread) by reflection — checked against Wails v2.12.0 /
// go-webview2 v1.0.22 (hostgc_windows_test.go fails when go.mod moves them).
// Anything not as expected: off, quietly (the heap limit then stays as it is).

type hostGC struct {
	mu       sync.Mutex
	frontend reflect.Value // *windows.Frontend (addressable struct behind it)
	invoke   reflect.Value // mainWindow.Invoke(func())
	off      string        // why it is off ("" = it may work)
	logged   bool
}

var (
	chromiumType = reflect.TypeOf((*edge.Chromium)(nil))
	invokeType   = reflect.TypeOf(func(func()) {})
)

// findHostGC looks at what Wails put in the context as "frontend". Never panics.
func findHostGC(fe any) (h *hostGC) {
	h = &hostGC{}
	defer func() {
		if r := recover(); r != nil {
			h = &hostGC{off: fmt.Sprint("reflection failed: ", r)}
		}
	}()
	rv := reflect.ValueOf(fe)
	if !rv.IsValid() || rv.Kind() != reflect.Ptr || rv.IsNil() || rv.Elem().Kind() != reflect.Struct {
		h.off = fmt.Sprintf("frontend is %T", fe)
		return h
	}
	st := rv.Elem()
	if t := st.Type(); t.Name() != "Frontend" || t.PkgPath() != "github.com/wailsapp/wails/v2/internal/frontend/desktop/windows" {
		h.off = "frontend is " + t.PkgPath() + "." + t.Name()
		return h
	}
	ch := st.FieldByName("chromium")
	if !ch.IsValid() || ch.Type() != chromiumType {
		h.off = "no chromium *edge.Chromium field"
		return h
	}
	mw := st.FieldByName("mainWindow")
	if !mw.IsValid() || mw.Kind() != reflect.Ptr {
		h.off = "no mainWindow field"
		return h
	}
	inv := reflect.NewAt(mw.Type(), unsafe.Pointer(mw.UnsafeAddr())).Elem().MethodByName("Invoke")
	if !inv.IsValid() || inv.Type() != invokeType {
		h.off = "mainWindow has no Invoke(func())"
		return h
	}
	h.frontend = st
	h.invoke = inv
	return h
}

// ready: it may be tried (found at start, not failed since).
func (h *hostGC) ready() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.off == "" && h.frontend.IsValid()
}

func (h *hostGC) why() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.off == "" && !h.frontend.IsValid() {
		return "not found"
	}
	return h.off
}

// collect asks the window for a full GC and waits for it (≤ 10s). "" = done.
func (h *hostGC) collect() (why string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			why = fmt.Sprint("panic: ", r)
		}
		if why != "" && why != "busy" {
			h.off = why // once broken, off for this run
		}
		if !h.logged || why != "" {
			h.logged = true
			if why == "" {
				log.Printf("화면 메모리 정리(호스트 GC): 됨")
			} else {
				log.Printf("화면 메모리 정리(호스트 GC): 꺼짐 — %s", why)
			}
		}
	}()
	if h.off != "" {
		return h.off
	}
	if !h.frontend.IsValid() {
		return "not found"
	}
	f := h.frontend.FieldByName("chromium")
	chromium := *(**edge.Chromium)(unsafe.Pointer(f.UnsafeAddr()))
	if chromium == nil {
		return "busy" // the window is not up yet: try again later
	}
	done := make(chan error, 1)
	h.invoke.Call([]reflect.Value{reflect.ValueOf(func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("panic: %v", r)
			}
		}()
		done <- callCollectGarbage(chromium)
	})})
	select {
	case err := <-done:
		if err != nil {
			return err.Error()
		}
		return ""
	case <-time.After(10 * time.Second):
		return "busy"
	}
}

// ICoreWebView2::CallDevToolsProtocolMethod is slot 36 of the interface's
// vtable (COM ABI, fixed): go-webview2's edge.ICoreWebView2 keeps its vtable
// private, so the slot is called directly. On the window's thread.
const slotCallDevToolsProtocolMethod = 36

func callCollectGarbage(c *edge.Chromium) error {
	ctl := c.GetController()
	if ctl == nil {
		return errors.New("no controller")
	}
	wv, err := ctl.GetCoreWebView2()
	if err != nil || wv == nil {
		return fmt.Errorf("no webview: %v", err)
	}
	vt := (*[slotCallDevToolsProtocolMethod + 1]uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(wv)))
	defer syscall.SyscallN(vt[2], uintptr(unsafe.Pointer(wv))) // Release (GetCoreWebView2 added a reference)
	m, _ := windows.UTF16PtrFromString("HeapProfiler.collectGarbage")
	p, _ := windows.UTF16PtrFromString("{}")
	hr, _, _ := syscall.SyscallN(vt[slotCallDevToolsProtocolMethod], uintptr(unsafe.Pointer(wv)), uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(p)), 0)
	if hr != 0 {
		return fmt.Errorf("CallDevToolsProtocolMethod hr=%#x", hr)
	}
	return nil
}
