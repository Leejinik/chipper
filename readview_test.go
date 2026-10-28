package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 「✏️ 편집으로 열기」 in pieces: joined, the pieces are exactly what ReadFile
// gives (multi-byte characters never split), for every encoding path.
func TestEditOpenChunks(t *testing.T) {
	a := &App{}
	old := EditChunkBytes
	defer func() { EditChunkBytes = old }()
	dir := t.TempDir()
	text := strings.Repeat("가나다 abc 😀 é\r\nline two\n", 500)
	p := filepath.Join(dir, "a.log")
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	want, err := a.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{1, 2, 3, 5, 7, 4096, 1 << 20} {
		EditChunkBytes = n
		for _, enc := range []string{"", "utf-8"} {
			o, err := a.EditOpenBegin(p, enc)
			if err != nil {
				t.Fatal(err)
			}
			var b strings.Builder
			for i := 0; i < o.Chunks; i++ {
				s, err := a.EditOpenChunk(o.ID, i)
				if err != nil {
					t.Fatal(err)
				}
				if s == "" || strings.ContainsRune(s, '�') {
					t.Fatalf("chunk %d of %d (size %d): %q", i, o.Chunks, n, s)
				}
				b.WriteString(s)
			}
			a.EditOpenEnd(o.ID)
			if b.String() != want.Content || o.Length != len(want.Content) || o.Doc.Content != "" || o.Doc.Encoding != want.Encoding || o.Doc.EOL != want.EOL {
				t.Fatalf("size %d enc %q: joined text differs (len %d want %d), doc %+v", n, enc, b.Len(), len(want.Content), o.Doc)
			}
			if _, err := a.EditOpenChunk(o.ID, 0); err == nil {
				t.Fatal("chunk after End")
			}
		}
	}
	empty := filepath.Join(dir, "empty.log")
	os.WriteFile(empty, nil, 0o644)
	o, err := a.EditOpenBegin(empty, "")
	if err != nil || o.Chunks != 0 || o.Length != 0 {
		t.Fatalf("empty: %+v %v", o, err)
	}
	a.EditOpenEnd(o.ID)
	if m := a.MemInfo(); m.GoWorkingSet == 0 || m.GoHeap == 0 {
		t.Fatalf("meminfo %+v", m)
	}
}
