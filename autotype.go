package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ChipsResult is returned to the frontend after a TypeChips run.
type ChipsResult struct {
	Typed    int    `json:"typed"`    // items fully typed + committed
	Total    int    `json:"total"`    // items after empty-filtering
	Canceled bool   `json:"canceled"` // user pressed 중지
	Aborted  bool   `json:"aborted"`  // focus guard / send error stopped us
	Message  string `json:"message"`  // human-readable Korean summary
}

// CancelChips requests the in-flight TypeChips run to stop before the next item.
func (a *App) CancelChips() { a.chipsCancel.Store(true) }

// sanitizeItem removes characters that would act as an unintended commit/line
// break inside a single chip, and trims the ends.
func sanitizeItem(s string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", "", "\n", " ", "\t", " ").Replace(s))
}

// clampDuration returns a duration from ms, using def when ms<=0, clamped to [lo,hi] ms.
func clampDuration(ms, def, lo, hi int) time.Duration {
	if ms <= 0 {
		ms = def
	}
	if ms < lo {
		ms = lo
	}
	if ms > hi {
		ms = hi
	}
	return time.Duration(ms) * time.Millisecond
}

func (a *App) emitChipsDone(r ChipsResult) {
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, "chips:done", map[string]interface{}{
			"typed": r.Typed, "total": r.Total,
			"canceled": r.Canceled, "aborted": r.Aborted, "message": r.Message,
		})
	}
}

// TypeChips types each item into the currently-foreground window, pressing the
// commit key after each, so an ID list becomes N chips in an external chips
// input. The frontend runs a countdown first (so the target window is focused),
// then calls this. Platform-specific injection lives in platformTypeItem etc.
func (a *App) TypeChips(items []string, commitKey string, perItemDelayMs int) (ChipsResult, error) {
	clean := make([]string, 0, len(items))
	for _, it := range items {
		if s := sanitizeItem(it); s != "" {
			clean = append(clean, s)
		}
	}
	total := len(clean)
	res := ChipsResult{Total: total}
	if total == 0 {
		res.Message = "입력할 항목이 없습니다"
		return res, nil
	}
	switch commitKey {
	case "enter", "tab", "comma":
	default:
		commitKey = "enter"
	}
	perItem := clampDuration(perItemDelayMs, 45, 0, 5000)

	a.chipsCancel.Store(false)

	target, err := platformCaptureFocus()
	if err != nil {
		res.Aborted = true
		res.Message = err.Error()
		a.emitChipsDone(res)
		return res, errors.New(res.Message)
	}

	platformBeginRun()
	defer platformEndRun()

	for i, item := range clean {
		if a.chipsCancel.Load() {
			res.Canceled = true
			res.Message = fmt.Sprintf("사용자가 취소했습니다 (%d/%d)", res.Typed, total)
			a.emitChipsDone(res)
			return res, nil
		}
		if platformFocusChanged(target) {
			res.Aborted = true
			res.Message = fmt.Sprintf("포커스가 대상 창에서 벗어나 중단했습니다 (%d/%d)", i+1, total)
			a.emitChipsDone(res)
			return res, errors.New(res.Message)
		}
		if err := platformTypeItem(item, commitKey, target); err != nil {
			res.Aborted = true
			res.Message = fmt.Sprintf("입력 실패 (%d/%d): %s", i+1, total, err.Error())
			a.emitChipsDone(res)
			return res, errors.New(res.Message)
		}
		res.Typed = i + 1
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, "chips:progress", map[string]interface{}{"done": i + 1, "total": total})
		}
		if perItem > 0 {
			time.Sleep(perItem)
		}
	}

	res.Message = fmt.Sprintf("%d개 항목 입력 완료", res.Typed)
	a.emitChipsDone(res)
	return res, nil
}
