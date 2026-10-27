package linefilter

// RowOfLine returns the row of the filtered view (with `above`/`below` context)
// that shows line `line` of the file, or, when that line is not shown, the
// first row after it (a gap row standing for it counts). The view uses it to
// stay on the same place of the file when the context sizes change, and to
// find where rows must be fetched again after lines were appended. The answer
// can be ≥ the rows available so far (the line lies beyond what is known yet);
// rows cut by MaxBytes are not taken into account (the caller clamps).
func (e *Engine) RowOfLine(id string, above, below int, line int64) (int, error) {
	v, err := e.view(id)
	if err != nil {
		return 0, err
	}
	j := v.j
	j.mu.Lock()
	defer j.mu.Unlock()
	if line < 1 {
		line = 1
	}
	lay := j.layoutLocked(clampCtx(above), clampCtx(below))
	return lay.rowAtLine(line), nil
}
