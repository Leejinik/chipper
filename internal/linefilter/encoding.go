package linefilter

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"unicode/utf8"

	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Encoding names are the ones app.go uses (decodeBytes / decodeWith).
const (
	EncUTF8    = "utf-8"
	EncUTF8BOM = "utf-8-bom"
	EncCP949   = "cp949"
	EncUTF16LE = "utf-16le"
	EncUTF16BE = "utf-16be"
)

func checkEncodingName(enc string) error {
	switch enc {
	case "", EncUTF8, EncUTF8BOM, EncCP949, EncUTF16LE, EncUTF16BE:
		return nil
	}
	return fmt.Errorf("알 수 없는 인코딩입니다: %q (\"\"(자동), utf-8, utf-8-bom, cp949, utf-16le, utf-16be 중 하나)", enc)
}

const (
	sniffBytes  = 1 << 20 // head sample
	extraSample = 64 << 10
	extraCount  = 16
)

// utf8Score counts, in b, valid multi-byte UTF-8 characters and bytes that are
// not valid UTF-8. A sequence cut at either end of the sample is ignored.
func utf8Score(b []byte) (valid, invalid int) {
	// skip continuation bytes at the start (the sample may begin mid-character)
	for k := 0; k < 3 && len(b) > 0 && !utf8.RuneStart(b[0]); k++ {
		b = b[1:]
	}
	b = b[:runeCut(b)]
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			i++
			continue
		}
		r, w := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && w == 1 {
			invalid++
		} else {
			valid++
		}
		i += w
	}
	return
}

// detectEncoding picks the encoding of a file once, before scanning, from
// samples: BOM → BOM-less UTF-16 (app.go's heuristic) → UTF-8 or CP949. The
// decision is never revised later, so a file always reads the same way whatever
// the rules are. A UTF-8 file with a few broken bytes stays UTF-8 (they read as
// U+FFFD and are counted). When the head holds no multi-byte character (plain
// ASCII, or ASCII with stray bytes), more samples decide together with it
// (English start-up lines followed by Korean are common): spread over the whole
// file, or for a .gz the inflated text that follows the head (up to
// gzipSniffMax). size < 0: unknown (compressed stream).
func detectEncoding(head []byte, size int64, extra func() [][]byte) string {
	if len(head) >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF {
		return EncUTF8BOM
	}
	if len(head) >= 2 && head[0] == 0xFF && head[1] == 0xFE {
		return EncUTF16LE
	}
	if len(head) >= 2 && head[0] == 0xFE && head[1] == 0xFF {
		return EncUTF16BE
	}
	evenSize := size%2 == 0
	if size < 0 {
		evenSize = true
	}
	if len(head) >= 4 && evenSize {
		limit := len(head)
		if limit > 8000 {
			limit = 8000
		}
		var evenZero, oddZero, cnt int
		for i := 0; i+1 < limit; i += 2 {
			if head[i] == 0 {
				evenZero++
			}
			if head[i+1] == 0 {
				oddZero++
			}
			cnt++
		}
		if cnt > 0 {
			if oddZero*10 >= cnt*6 && evenZero*10 < cnt*2 {
				return EncUTF16LE
			}
			if evenZero*10 >= cnt*6 && oddZero*10 < cnt*2 {
				return EncUTF16BE
			}
		}
	}
	v, inv := utf8Score(head)
	if v == 0 && extra != nil {
		for _, s := range extra() {
			a, b := utf8Score(s)
			v += a
			inv += b
		}
	}
	if inv == 0 || v > 2*inv {
		return EncUTF8
	}
	return EncCP949
}

// sampleFile reads the head and, lazily, evenly spread extra samples.
func sampleFile(f *os.File, size int64) ([]byte, func() [][]byte, error) {
	n := int64(sniffBytes)
	if size < n {
		n = size
	}
	head := make([]byte, n)
	if _, err := f.ReadAt(head, 0); err != nil && err != io.EOF {
		return nil, nil, err
	}
	extra := func() [][]byte {
		if size <= int64(len(head)) {
			return nil
		}
		var out [][]byte
		span := size - int64(len(head))
		for k := 0; k <= extraCount; k++ {
			off := int64(len(head)) + span*int64(k)/int64(extraCount+1)
			if k == extraCount {
				off = size - extraSample
			}
			if off < int64(len(head)) {
				off = int64(len(head))
			}
			m := int64(extraSample)
			if off+m > size {
				m = size - off
			}
			if m <= 0 {
				continue
			}
			b := make([]byte, m)
			if _, err := f.ReadAt(b, off); err != nil && err != io.EOF {
				continue
			}
			out = append(out, b)
		}
		return out
	}
	return head, extra, nil
}

// needsTranscode: encodings whose bytes cannot be scanned as UTF-8 directly.
func needsTranscode(enc string) bool {
	return enc == EncCP949 || enc == EncUTF16LE || enc == EncUTF16BE
}

// dataStartFor: where the text starts (after a BOM the decoder would drop) and
// the encoding to decode with — for UTF-16 a BOM overrides the requested byte
// order, as app.go's decoder (UseBOM) does.
func dataStartFor(enc string, head []byte) (string, int64) {
	switch enc {
	case EncUTF8BOM:
		if bytes.HasPrefix(head, []byte{0xEF, 0xBB, 0xBF}) {
			return enc, 3
		}
	case EncUTF16LE, EncUTF16BE:
		if bytes.HasPrefix(head, []byte{0xFF, 0xFE}) {
			return EncUTF16LE, 2
		}
		if bytes.HasPrefix(head, []byte{0xFE, 0xFF}) {
			return EncUTF16BE, 2
		}
	}
	return enc, 0
}

// newDecoder decodes text after any BOM (BOMs are resolved by dataStartFor).
func newDecoder(enc string) transform.Transformer {
	switch enc {
	case EncCP949:
		return korean.EUCKR.NewDecoder()
	case EncUTF16LE:
		return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()
	case EncUTF16BE:
		return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder()
	}
	return transform.Nop
}

// decodeChunk decodes src (a run of whole characters) into dst.
func decodeChunk(dec transform.Transformer, dst, src []byte) []byte {
	dec.Reset()
	dst = dst[:0]
	for {
		if cap(dst)-len(dst) < 64 {
			dst = append(dst, make([]byte, cap(dst)+len(src)+64)...)[:len(dst)]
		}
		nDst, nSrc, err := dec.Transform(dst[len(dst):cap(dst)], src, true)
		dst = dst[:len(dst)+nDst]
		src = src[nSrc:]
		if err == transform.ErrShortDst {
			dst = append(dst, make([]byte, cap(dst))...)[:len(dst)]
			continue
		}
		if err != nil || len(src) == 0 {
			return dst
		}
	}
}

// splitPoint returns an offset ≤ len(b), ≥ from, where b can be cut so both
// halves decode exactly as the whole does, or -1. b must start on a character
// boundary (for UTF-16: at an even offset from the text start).
//   - CP949: right after a byte that is never a trail byte (< 0x41, 0x5B–0x60,
//     0x7B–0x7F): it is a character on its own.
//   - UTF-16: an even offset whose unit is not a low surrogate (the decoder
//     joins a surrogate with a following low surrogate, valid or not).
//   - UTF-8: after any byte that is not a lead or continuation byte... we only
//     need line starts there, so callers never ask.
func splitPoint(enc string, b []byte, from int) int {
	switch enc {
	case EncCP949:
		for k := from; k < len(b); k++ {
			c := b[k]
			if c < 0x41 || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7f) {
				return k + 1
			}
		}
	case EncUTF16LE, EncUTF16BE:
		p := from
		if p%2 == 1 {
			p++
		}
		for ; p+1 < len(b); p += 2 {
			u := uint16(b[p])<<8 | uint16(b[p+1])
			if enc == EncUTF16LE {
				u = u>>8 | u<<8
			}
			if u < 0xDC00 || u > 0xDFFF {
				return p
			}
		}
	default:
		for k := from; k < len(b); k++ {
			if b[k] < utf8.RuneSelf {
				return k + 1
			}
		}
	}
	return -1
}

// lastNewline returns the offset just past the last newline character of src
// (a run of whole characters in enc), or -1. Each such newline decodes to one
// '\n' and nothing else decodes to '\n', so it pairs with the last '\n' of the
// decoded text.
func lastNewline(enc string, src []byte) int {
	switch enc {
	case EncUTF16LE, EncUTF16BE:
		for p := len(src) - 2 - len(src)%2; p >= 0; p -= 2 {
			u := uint16(src[p])<<8 | uint16(src[p+1])
			if enc == EncUTF16LE {
				u = u>>8 | u<<8
			}
			if u == '\n' {
				return p + 2
			}
		}
		return -1
	}
	if k := bytes.LastIndexByte(src, '\n'); k >= 0 {
		return k + 1
	}
	return -1
}

// invalidUTF8 counts bytes of b that are not valid UTF-8 and the offset of the
// first one (-1 when none). b must hold whole characters.
func invalidUTF8(b []byte) (int64, int) {
	if utf8.Valid(b) {
		return 0, -1
	}
	var n int64
	first := -1
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			i++
			continue
		}
		r, w := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && w == 1 {
			n++
			if first < 0 {
				first = i
			}
		}
		i += w
	}
	return n, first
}

// sanitizeUTF8 replaces every invalid byte with U+FFFD (one each, as the
// column numbers count them).
func sanitizeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb bytes.Buffer
	sb.Grow(len(b) + 16)
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			sb.WriteByte(c)
			i++
			continue
		}
		r, w := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && w == 1 {
			sb.WriteString("�")
		} else {
			sb.Write(b[i : i+w])
		}
		i += w
	}
	return sb.String()
}
