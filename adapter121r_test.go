package main

import "os"

// Test adapter for the rework tests (fix121r_test.go): the same test bodies run
// against 7f336e5 (v1.2.1 rc1, to show each problem) and the rework. This is
// the rework (AFTER) version. The rc1 one (BEFORE) is kept at
// .relay/20261027-v121/rework/adapter121r_before.go.txt.

type loadResultR struct {
	data, notice, detail string
	blocked              bool
	legacy, backup       string // names offered for 「불러오기」 ("" = none)
}

func loadR(a *App) loadResultR {
	s, _ := a.LoadSession()
	r := loadResultR{data: s.Data, notice: s.Notice, detail: s.Detail, blocked: s.Blocked}
	if s.Legacy != nil {
		r.legacy = s.Legacy.Name
	}
	if s.Backup != nil {
		r.backup = s.Backup.Name
	}
	return r
}

func backupNamesR(a *App) []string {
	var out []string
	for _, b := range a.SessionBackups() {
		out = append(out, b.Name)
	}
	return out
}

func readBackupR(a *App, name string) (string, error) { return a.ReadSessionBackup(name) }

type saveOptR struct {
	enc, eol                          string
	mixed, noBom, force, allowTooBig bool
}

func saveR(a *App, path, content string, o saveOptR) (FileDoc, error) {
	return a.SaveFile(path, content, SaveOptions{Encoding: o.enc, EOL: o.eol, EOLMixed: o.mixed, NoBOM: o.noBom, Force: o.force, AllowTooBig: o.allowTooBig})
}

// setOpenLimitR lowers the open limit for a test; ok=false when the build has
// no way to (rc1: a const).
func setOpenLimitR(n int64) (restore func(), ok bool) {
	old := maxOpenBytes
	maxOpenBytes = n
	return func() { maxOpenBytes = old }, true
}

func rootFilesR(b Bundle) []string {
	var out []string
	for _, f := range b.RootFiles {
		out = append(out, f.Rel)
	}
	return out
}

func writeFileR(p, s string) error { return os.WriteFile(p, []byte(s), 0o600) }
