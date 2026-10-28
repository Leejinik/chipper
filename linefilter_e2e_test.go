package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"chipper/internal/linefilter"
)

// TestFilterE2EServer is not a test by itself: frontend/tests/lines-e2e.cjs
// runs it (CHIPPER_LF_E2E=<file to write the address to>) so the headless page
// of the 「태그 줄만」 view talks to the real filter bindings (App.Filter*) and
// the real engine, with the progress events relayed over HTTP.
//
//	POST /call   {"name":"FilterRows","args":[...]} → {"result":…} | {"error":"…"}
//	GET  /events?from=N → {"events":[…], "next":M}
//	GET  /reset?maxRows=&maxBytes=&dfaMemory= → a new engine with these limits
//	GET  /quit
func TestFilterE2EServer(t *testing.T) {
	out := os.Getenv("CHIPPER_LF_E2E")
	if out == "" {
		t.Skip("frontend/tests/lines-e2e.cjs 가 띄우는 도우미")
	}
	var mu sync.Mutex
	var evs []linefilter.Progress
	tmp := t.TempDir()
	newEngine := func(maxRows int, maxBytes int64, dfa int) {
		if filterEng != nil {
			filterEng.CloseAll(2 * time.Second)
		}
		filterOnce.Do(func() {})
		filterEng = linefilter.New(linefilter.Options{
			MaxRows:    maxRows,
			MaxBytes:   maxBytes,
			DFAMemory:  dfa,
			TempDir:    tmp,
			WatchEvery: 100 * time.Millisecond,
			OnProgress: func(p linefilter.Progress) {
				mu.Lock()
				evs = append(evs, p)
				mu.Unlock()
			},
		})
	}
	newEngine(0, 0, 0)
	a := &App{}

	mux := http.NewServeMux()
	mux.HandleFunc("/call", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string            `json:"name"`
			Args []json.RawMessage `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		arg := func(i int, v any) {
			if i < len(req.Args) {
				_ = json.Unmarshal(req.Args[i], v)
			}
		}
		var id string
		var A, B, from, count int
		var res any
		var err error
		switch req.Name {
		case "FilterStart":
			var q linefilter.Request
			arg(0, &q)
			res, err = a.FilterStart(q)
		case "FilterRows":
			arg(0, &id)
			arg(1, &A)
			arg(2, &B)
			arg(3, &from)
			arg(4, &count)
			res, err = a.FilterRows(id, A, B, from, count)
		case "FilterStatus":
			arg(0, &id)
			res, err = a.FilterStatus(id)
		case "FilterCancel":
			arg(0, &id)
			a.FilterCancel(id)
		case "FilterClose":
			arg(0, &id)
			a.FilterClose(id)
		case "FilterRowOfLine":
			var line int64
			arg(0, &id)
			arg(1, &A)
			arg(2, &B)
			arg(3, &line)
			res, err = a.FilterRowOfLine(id, A, B, line)
		case "FilterFind":
			var q linefilter.Rule
			arg(0, &id)
			arg(1, &A)
			arg(2, &B)
			arg(3, &q)
			res, err = a.FilterFind(id, A, B, q)
		case "ValidateFilterRules":
			var rs []linefilter.Rule
			arg(0, &rs)
			res = a.ValidateFilterRules(rs)
		default:
			http.Error(w, "unknown binding "+req.Name, 404)
			return
		}
		w.Header().Set("content-type", "application/json")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": res})
	})
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("from"))
		mu.Lock()
		if n < 0 || n > len(evs) {
			n = len(evs)
		}
		batch := append([]linefilter.Progress(nil), evs[n:]...)
		next := len(evs)
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"events": batch, "next": next})
	})
	mux.HandleFunc("/reset", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		mr, _ := strconv.Atoi(q.Get("maxRows"))
		mb, _ := strconv.ParseInt(q.Get("maxBytes"), 10, 64)
		dm, _ := strconv.Atoi(q.Get("dfaMemory"))
		newEngine(mr, mb, dm)
		_, _ = w.Write([]byte("ok"))
	})
	quit := make(chan struct{})
	var quitOnce sync.Once
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("bye"))
		quitOnce.Do(func() { close(quit) })
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	if err := os.WriteFile(out, []byte(ln.Addr().String()), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-quit:
	case <-time.After(20 * time.Minute):
	}
	_ = srv.Close()
	filterEng.CloseAll(2 * time.Second)
}
