//go:build !windows

package main

func selfWorkingSet() (uint64, bool) { return 0, false }

func childWorkingSets() (uint64, int) { return 0, 0 }
