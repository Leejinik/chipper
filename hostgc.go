package main

import (
	"log"
	"sync"
)

var (
	hostGCOnce sync.Once
	hostGCAt   *hostGC
)

func (a *App) hostGC() *hostGC {
	hostGCOnce.Do(func() {
		var fe any
		if a.ctx != nil {
			fe = a.ctx.Value("frontend")
		}
		hostGCAt = findHostGC(fe)
		if hostGCAt.ready() {
			log.Printf("화면 메모리 정리(호스트 GC): 준비됨")
		} else {
			log.Printf("화면 메모리 정리(호스트 GC): 꺼짐 — %s", hostGCAt.why())
		}
	})
	return hostGCAt
}

// HostGCReady: 「화면 메모리 정리」 can be asked for (Windows, Wails as expected).
func (a *App) HostGCReady() bool { return a.hostGC().ready() }

// CollectWindowGarbage asks the window for a full garbage collection of its JS
// memory (hostgc_windows.go). "" = asked; otherwise why not ("busy": try later).
func (a *App) CollectWindowGarbage() string { return a.hostGC().collect() }
