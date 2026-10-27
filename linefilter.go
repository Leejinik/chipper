package main

import (
	"context"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"chipper/internal/linefilter"
)

// "태그 줄만 보기" bindings. The Go side reads the log file straight from disk
// (never the editor's copy), so it also works for files too big to open, and
// for .gz files.
//
// Flow for the frontend:
//  1. FilterStart({path, encoding, rules}) → {jobId, issues, cached, progress}.
//     Every call gets its own jobId (one per view); identical requests on an
//     unchanged file share the scan behind the scenes.
//  2. Listen to "linefilter:progress" (payload linefilter.Progress, filtered by
//     jobId) and call FilterRows(jobId, above, below, from, count) to pull rows.
//     Within one progress.version, rows already returned never change; fetch
//     from len(rows so far) until a page says end. A page may hold fewer rows
//     than asked (or none while scanning): call again on the next event.
//  3. Changing above/below = call FilterRows again from 0 with the new values;
//     the file is not rescanned.
//  4. When progress.version goes up (lines were appended to the file), drop the
//     rows from the first one that shows a line ≥ (previous tailLine − above)
//     (or a gap row reaching it) and fetch again from there. progress.changed:
//     the file was rewritten — start again.
//  5. FilterCancel stops a scan (for this view); FilterClose frees the view.

// FilterProgressEvent is emitted with a linefilter.Progress payload: on the
// first results, about every 100ms while scanning, and when a scan ends.
const FilterProgressEvent = "linefilter:progress"

var (
	filterOnce sync.Once
	filterEng  *linefilter.Engine
)

func (a *App) filters() *linefilter.Engine {
	filterOnce.Do(func() {
		go linefilter.CleanStaleTemp()
		filterEng = linefilter.New(linefilter.Options{OnProgress: func(p linefilter.Progress) {
			if a.ctx != nil {
				wruntime.EventsEmit(a.ctx, FilterProgressEvent, p)
			}
		}})
	})
	return filterEng
}

// shutdownFilters deletes the filter's temp copies when the app quits.
func (a *App) shutdownFilters(ctx context.Context) {
	if filterEng != nil {
		filterEng.CloseAll(2 * time.Second)
	}
}

// ValidateFilterRules lists the rules "줄만 보기" cannot use (e.g. JS-only regex
// syntax such as look-behind); the reasons are ready to show. Empty = all fine.
func (a *App) ValidateFilterRules(rules []linefilter.Rule) []linefilter.RuleIssue {
	is := linefilter.Validate(rules)
	if is == nil {
		return []linefilter.RuleIssue{}
	}
	return is
}

// FilterStart begins filtering a file on disk (or shares an identical scan).
func (a *App) FilterStart(req linefilter.Request) (linefilter.StartResult, error) {
	return a.filters().Start(req)
}

// FilterRows returns rows [from, from+count) of a job's filtered view with
// `above` lines before and `below` lines after each matched line.
func (a *App) FilterRows(jobID string, above, below, from, count int) (linefilter.Page, error) {
	return a.filters().Rows(jobID, above, below, from, count)
}

// FilterStatus returns a job's progress (for a frontend that missed events).
func (a *App) FilterStatus(jobID string) (linefilter.Progress, error) {
	return a.filters().Status(jobID)
}

// FilterCancel stops a running scan for this view; rows found so far stay
// readable.
func (a *App) FilterCancel(jobID string) { a.filters().Cancel(jobID) }

// FilterClose forgets a view (and, when no other view uses it, its scan).
func (a *App) FilterClose(jobID string) { a.filters().Close(jobID) }
