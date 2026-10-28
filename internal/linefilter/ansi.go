package linefilter

import "bytes"

// ANSI colour codes. Programs that colour their terminal output leave
// ESC [ … m codes in the log; the editor matches its rules on the line without
// them (frontend/src/logHighlight.ts stripAnsi / paintLine), so the filter
// judges such lines the same way — otherwise `ESC[1;31mWARN` would not match
// \bWARN\b here (no word boundary after the "m") while the editor colours it.
//
// A sequence is exactly what the editor's /\x1b\[[0-?]*[ -\/]*[@-~]/ takes:
// ESC '[', parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F, one final
// byte 0x40–0x7E. An ESC that does not start a complete sequence stays.
//
// Only buffers that hold an ESC take the line-by-line path (scanBufLines);
// everything else is unchanged. Lines longer than GiantMax (judged piece by
// piece in streamLine) are judged with their codes.

const esc = 0x1b

// ansiSeqLen: length of the sequence starting at b[0] (an ESC), 0 if none.
func ansiSeqLen(b []byte) int {
	if len(b) < 3 || b[0] != esc || b[1] != '[' {
		return 0
	}
	i := 2
	for i < len(b) && b[i] >= 0x30 && b[i] <= 0x3f {
		i++
	}
	for i < len(b) && b[i] >= 0x20 && b[i] <= 0x2f {
		i++
	}
	if i < len(b) && b[i] >= 0x40 && b[i] <= 0x7e {
		return i + 1
	}
	return 0
}

// stripANSI returns line without its sequences (in the worker's scratch
// buffer) and, for each byte of it plus one past the end, the offset in line;
// ok=false when line has no complete sequence (use line as it is).
func (ws *wstate) stripANSI(line []byte) (out []byte, pos []int32, ok bool) {
	out, pos = ws.ansiBuf[:0], ws.ansiPos[:0]
	for i := 0; i < len(line); {
		if line[i] == esc {
			if n := ansiSeqLen(line[i:]); n > 0 {
				ok = true
				i += n
				continue
			}
		}
		j := i + 1
		if k := bytes.IndexByte(line[j:], esc); k >= 0 {
			j += k
		} else {
			j = len(line)
		}
		out = append(out, line[i:j]...)
		for p := i; p < j; p++ {
			pos = append(pos, int32(p))
		}
		i = j
	}
	pos = append(pos, int32(len(line)))
	ws.ansiBuf, ws.ansiPos = out, pos
	return out, pos, ok
}

// lineAny decides one line whatever the matcher's mode: the rule mask and the
// byte offset of the first match (as lineHitDFA).
func (ws *wstate) lineAny(line []byte) (uint64, int) {
	if !ws.m.litMode {
		return ws.lineHitDFA(line)
	}
	var mask uint64
	best := len(line) + 1
	for ri := range ws.m.rules {
		if ok, s := ws.ruleStart(ri, line, best, -1); ok {
			ws.setRule(&mask, ri)
			if s < best {
				best = s
			}
		}
	}
	return mask, best
}

// scanBufLines is scanBuf for a buffer holding an ESC byte: one line at a
// time, lines with ANSI sequences judged without them. The hit's column is
// the first match's place in the line as stored (the editor shows the codes).
func (ws *wstate) scanBufLines(data []byte, base int64, out []hit, lineBase int64, capHits int, hasCR bool) ([]hit, bool) {
	var idx int64
	for pos := 0; pos < len(data); idx++ {
		le, next := lineEnd(data, pos, hasCR)
		line := data[pos:le]
		judge := line
		var at []int32
		if bytes.IndexByte(line, esc) >= 0 {
			if s, p, ok := ws.stripANSI(line); ok {
				judge, at = s, p
				ws.lowPtr = nil // the scratch buffer is reused: forget its lower-cased copy
			}
		}
		if mask, s := ws.lineAny(judge); ws.lineHit(mask) {
			if at != nil {
				if s > len(judge) {
					s = len(judge)
				}
				s = int(at[s])
			}
			out = ws.addHit(out, hit{line: lineBase + idx, start: base + int64(pos), end: base + int64(le), mask: mask, col: utf16Col(line, s)})
			if len(out) >= capHits {
				return out, true
			}
		}
		pos = next
	}
	return out, false
}
