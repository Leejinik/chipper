package main

import (
	"errors"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"unicode/utf8"
)

// 「✏️ 편집으로 열기」 of a big file (「📖 읽기 보기」 → the editor). Handing the
// whole text to the window in one message kept the window from taking any
// input for ~33s on a 300MB log (.18, 10-28: the message is received and
// parsed in one go). Here Go reads and decodes the file once, keeps the text,
// and the window fetches it in pieces: between pieces it stays responsive,
// shows how far it got and can stop (「취소」).
//
//  1. EditOpenBegin(path, enc) → {id, doc (no content), length, chunks}; enc "" = detect.
//  2. EditOpenChunk(id, i) for i in 0..chunks-1 → the text's i-th piece
//     (split on character boundaries; joined they are doc.content).
//  3. EditOpenEnd(id) — always (done, canceled or failed): frees the text.

// EditChunkBytes: bytes of text in one EditOpenChunk answer.
var EditChunkBytes = 4 << 20

type EditOpen struct {
	ID     string  `json:"id"`
	Doc    FileDoc `json:"doc"` // content left empty
	Length int     `json:"length"`
	Chunks int     `json:"chunks"`
}

type editOpening struct {
	text string
	cuts []int // chunk i = text[cuts[i]:cuts[i+1]]
}

var (
	editMu   sync.Mutex
	editOpen = map[string]*editOpening{}
	editSeq  atomic.Int64
)

// EditOpenBegin reads a file for the editor (as ReadFile / ReadFileAs) and
// keeps its text for EditOpenChunk.
func (a *App) EditOpenBegin(path string, enc string) (EditOpen, error) {
	var doc FileDoc
	var err error
	if enc == "" {
		doc, err = a.readDoc(path)
	} else {
		doc, err = a.ReadFileAs(path, enc)
	}
	if err != nil {
		return EditOpen{}, err
	}
	text := doc.Content
	doc.Content = ""
	cuts := []int{0}
	for at := 0; at < len(text); {
		next := at + EditChunkBytes
		if next >= len(text) {
			next = len(text)
		} else {
			for next > at && !utf8.RuneStart(text[next]) {
				next--
			}
			if next == at {
				// a piece smaller than one character: take the whole character
				_, w := utf8.DecodeRuneInString(text[at:])
				next = at + w
			}
		}
		cuts = append(cuts, next)
		at = next
	}
	id := "eo" + strconv.FormatInt(editSeq.Add(1), 10)
	editMu.Lock()
	editOpen[id] = &editOpening{text: text, cuts: cuts}
	editMu.Unlock()
	return EditOpen{ID: id, Doc: doc, Length: len(text), Chunks: len(cuts) - 1}, nil
}

// EditOpenChunk returns piece i of an EditOpenBegin's text.
func (a *App) EditOpenChunk(id string, i int) (string, error) {
	editMu.Lock()
	o := editOpen[id]
	editMu.Unlock()
	if o == nil {
		return "", errors.New("편집용으로 여는 작업이 없습니다 (취소되었거나 끝남)")
	}
	if i < 0 || i+1 >= len(o.cuts) {
		return "", errors.New("범위를 벗어난 조각")
	}
	return o.text[o.cuts[i]:o.cuts[i+1]], nil
}

// EditOpenEnd frees an EditOpenBegin's text.
func (a *App) EditOpenEnd(id string) {
	editMu.Lock()
	delete(editOpen, id)
	editMu.Unlock()
}

// MemInfo: what 「🧠」 in the status bar shows — this process (Go) and the
// window's processes (WebView2: the renderer, GPU and browser processes started
// by this app), in bytes. WebView is 0 where it cannot be told.
type MemInfo struct {
	GoWorkingSet uint64 `json:"goWorkingSet"` // the process's working set (Windows) / bytes from the OS (others)
	GoHeap       uint64 `json:"goHeap"`       // Go heap in use
	WebView      uint64 `json:"webView"`      // working sets of the WebView processes together
	WebViewProcs int    `json:"webViewProcs"`
}

func (a *App) MemInfo() MemInfo {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	m := MemInfo{GoHeap: ms.HeapInuse, GoWorkingSet: ms.Sys}
	if ws, ok := selfWorkingSet(); ok {
		m.GoWorkingSet = ws
	}
	m.WebView, m.WebViewProcs = childWorkingSets()
	return m
}
