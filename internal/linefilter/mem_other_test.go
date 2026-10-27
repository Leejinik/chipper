//go:build !windows

package linefilter

func workingSet() (uint64, error)     { return 0, nil }
func peakWorkingSet() (uint64, error) { return 0, nil }
