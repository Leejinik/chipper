package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// agy F-09 (user 10-29): binary files open with a warning, never in the editor;
// real UTF-16 logs (with or without BOM) open as before.
func utf16le(s string, bom bool) []byte {
	var out []byte
	if bom {
		out = append(out, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		out = binary.LittleEndian.AppendUint16(out, u)
	}
	return out
}

func TestBinarySniff(t *testing.T) {
	dir := t.TempDir()
	logText := strings.Repeat("2026-10-29 09:00:00 INFO 장비 연결 확인 line\r\n", 400)
	// 16-bit integers 1..300 (high byte 0 for most, never 0x0000): reads as BOM-less UTF-16LE
	var st []byte
	for i := 1; i <= 4000; i++ {
		st = binary.LittleEndian.AppendUint16(st, uint16(1+i%250))
	}
	elf := append([]byte{0x7F, 'E', 'L', 'F', 2, 1, 1, 0, 0, 0}, []byte(strings.Repeat("abc\x00\x01\x02", 500))...)
	cases := []struct {
		name string
		data []byte
		bin  bool
	}{
		{"utf8.log", []byte(logText), false},
		{"utf16-bom.log", utf16le(logText, true), false},
		{"utf16-nobom.log", utf16le(logText, false), false},
		{"struct.bin", st, true},
		{"elf.log", elf, true},
		{"ansi.log", []byte(strings.Repeat("\x1b[33mWARN\x1b[0m\tthing\n", 300)), false},
	}
	a := &App{}
	for _, c := range cases {
		p := filepath.Join(dir, c.name)
		if err := os.WriteFile(p, c.data, 0o644); err != nil {
			t.Fatal(err)
		}
		if got := a.SniffBinary(p); got != c.bin {
			t.Errorf("SniffBinary(%s) = %v, want %v", c.name, got, c.bin)
		}
		doc, err := a.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if doc.Binary != c.bin {
			t.Errorf("ReadFile(%s).Binary = %v, want %v (encoding %s)", c.name, doc.Binary, c.bin, doc.Encoding)
		}
	}
	if a.SniffBinary(filepath.Join(dir, "gone.log")) {
		t.Error("a missing file is not binary")
	}
}
