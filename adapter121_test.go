package main

// Test adapter: the v1.2.1 tests call the app through these helpers so the same
// test bodies can run against v1.2.0 (to show the defects) and v1.2.1.
// This is the v1.2.1 (AFTER) version. The v1.2.0 one was:
//
//	func primarySessionName() string { return "session.json" }
//	func saveLikeFrontend(a *App, path string, doc FileDoc, content string, force bool) (FileDoc, error) {
//		return a.SaveFile(path, content, doc.Encoding)
//	}
//	func saveWithEncodingLikeFrontend(a *App, path string, doc FileDoc, content string, enc string) (FileDoc, error) {
//		return a.SaveFile(path, content, enc)
//	}
//	func loadSessionForTest(a *App) (data string, notice string, err error) {
//		s, err := a.LoadSession()
//		return s, "", err
//	}

func primarySessionName() string { return sessionFileName }

// What App.tsx doSave sends: the tab remembers the file's line-break kind and
// BOM from when it was read.
func saveLikeFrontend(a *App, path string, doc FileDoc, content string, force bool) (FileDoc, error) {
	return a.SaveFile(path, content, SaveOptions{Encoding: doc.Encoding, EOL: doc.EOL, EOLMixed: doc.EOLMixed, NoBOM: !doc.BOM, Force: force})
}

// What App.tsx saveWithEncoding sends: an explicit conversion (BOM only kept
// off when the encoding stays the same).
func saveWithEncodingLikeFrontend(a *App, path string, doc FileDoc, content string, enc string) (FileDoc, error) {
	return a.SaveFile(path, content, SaveOptions{Encoding: enc, EOL: doc.EOL, NoBOM: enc == doc.Encoding && !doc.BOM, Force: true})
}

func loadSessionForTest(a *App) (data string, notice string, err error) {
	s, err := a.LoadSession()
	return s.Data, s.Notice, err
}
