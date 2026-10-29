package main

import (
	"io"
	"os"
)

// binaryText: the decoded text of a file looks like a binary file (agy F-09).
// A NUL in it says so; and when the bytes were taken for UTF-16 without a BOM
// (the NUL-parity guess of decodeBytes) the guess is checked too — 16-bit
// integers with a zero high byte pass that guess and decode to control
// characters, which text in UTF-16 does not have.
func binaryText(data []byte, content, enc string) bool {
	if looksBinary([]byte(content)) {
		return true
	}
	if (enc == "utf-16le" || enc == "utf-16be") && !hasBOM(data, enc) {
		return controlShare(content) > 0.1
	}
	return false
}

// controlShare: the share of control characters (C0 but tab, line breaks, form
// feed, backspace and ESC; C1; U+FFFD) in the first 4000 characters.
func controlShare(s string) float64 {
	n, bad := 0, 0
	for _, r := range s {
		if n == 4000 {
			break
		}
		n++
		switch {
		case r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v' || r == '\b' || r == 0x1b:
		case r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0xfffd:
			bad++
		}
	}
	if n == 0 {
		return 0
	}
	return float64(bad) / float64(n)
}

// SniffBinary: does the file look like a binary one (its first 64KB)? For the
// warning above 「📖 읽기」 (any size: the editor's check reads the whole file).
func (a *App) SniffBinary(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 64<<10)
	n, _ := io.ReadFull(f, buf)
	data := buf[:n]
	if n%2 == 1 && n == len(buf) {
		data = data[:n-1] // a cut UTF-16 unit
	}
	content, enc := decodeBytes(data)
	return binaryText(data, content, enc)
}
