package linefilter

import (
	"sort"
	"sync"
	"unicode"
)

// Case-insensitive matching the way the editor's JavaScript regexes do it
// (flag "i" without "u"): two characters are equal when Canonicalize gives the
// same code unit, where Canonicalize(ch) = toUpperCase(ch) unless that is not a
// single code unit, or maps a non-ASCII character to ASCII. So "k" matches "K"
// but not the Kelvin sign U+212A, and "s" does not match "ſ" U+017F — unlike
// Go's (?i), which folds whole Unicode orbits. Characters outside the BMP never
// fold (they are two code units in non-u mode).
//
// The filter therefore never uses Go's (?i): case-insensitive rules are
// rewritten into explicit character sets built from these classes.

// jsMultiUpper are the BMP characters whose toUpperCase() is longer than one
// character (SpecialCasing.txt); Canonicalize leaves them alone. Checked
// against Node's String.prototype.toUpperCase (see TestJSCanonAgainstNode).
var jsMultiUpper = [][2]rune{
	{0xdf, 0xdf}, {0x149, 0x149}, {0x1f0, 0x1f0}, {0x390, 0x390}, {0x3b0, 0x3b0}, {0x587, 0x587},
	{0x1e96, 0x1e9a}, {0x1f50, 0x1f50}, {0x1f52, 0x1f52}, {0x1f54, 0x1f54}, {0x1f56, 0x1f56},
	{0x1f80, 0x1faf}, {0x1fb2, 0x1fb4}, {0x1fb6, 0x1fb7}, {0x1fbc, 0x1fbc}, {0x1fc2, 0x1fc4},
	{0x1fc6, 0x1fc7}, {0x1fcc, 0x1fcc}, {0x1fd2, 0x1fd3}, {0x1fd6, 0x1fd7}, {0x1fe2, 0x1fe4},
	{0x1fe6, 0x1fe7}, {0x1ff2, 0x1ff4}, {0x1ff6, 0x1ff7}, {0x1ffc, 0x1ffc},
	{0xfb00, 0xfb06}, {0xfb13, 0xfb17},
}

// jsUnicode16Upper: case pairs added in Unicode 16 (in V8, not yet in Go's
// tables).
var jsUnicode16Upper = map[rune]rune{0x019B: 0xA7DC, 0x0264: 0xA7CB, 0x1C8A: 0x1C89, 0xA7CD: 0xA7CC, 0xA7DB: 0xA7DA}

func jsIsMultiUpper(r rune) bool {
	for _, x := range jsMultiUpper {
		if r >= x[0] && r <= x[1] {
			return true
		}
	}
	return false
}

// jsCanon is ECMAScript Canonicalize for a non-u, case-insensitive regex.
func jsCanon(r rune) rune {
	if r > 0xffff || (r >= 0xd800 && r <= 0xdfff) {
		return r
	}
	if r < 0x80 {
		if 'a' <= r && r <= 'z' {
			return r - 'a' + 'A'
		}
		return r
	}
	if jsIsMultiUpper(r) {
		return r
	}
	if u, ok := jsUnicode16Upper[r]; ok {
		return u
	}
	u := unicode.ToUpper(r)
	if u > 0xffff || u < 0x80 {
		return r
	}
	return u
}

var (
	jsFoldOnce  sync.Once
	jsFoldClass map[rune][]rune // canonical → every character with that canonical (≥ 2 members)
	jsCased     []rune          // sorted: characters that have at least one other equivalent
)

func jsFoldInit() {
	jsFoldOnce.Do(func() {
		cls := map[rune][]rune{}
		for r := rune(0); r <= 0xffff; r++ {
			if r >= 0xd800 && r <= 0xdfff {
				continue
			}
			if c := jsCanon(r); c != r {
				cls[c] = append(cls[c], r)
			}
		}
		jsFoldClass = map[rune][]rune{}
		for c, ms := range cls {
			if jsCanon(c) == c {
				ms = append(ms, c)
			}
			if len(ms) < 2 {
				continue
			}
			sort.Slice(ms, func(i, j int) bool { return ms[i] < ms[j] })
			jsFoldClass[c] = ms
			jsCased = append(jsCased, ms...)
		}
		sort.Slice(jsCased, func(i, j int) bool { return jsCased[i] < jsCased[j] })
	})
}

// jsEquiv returns every character equal to r under JS case-insensitive
// matching (r included), sorted.
func jsEquiv(r rune) []rune {
	jsFoldInit()
	if ms := jsFoldClass[jsCanon(r)]; len(ms) > 0 {
		for _, m := range ms {
			if m == r {
				return ms
			}
		}
	}
	return []rune{r}
}

// jsFoldTrivial: every character of s outside ASCII has no case partner under
// JS folding, so ASCII lower-casing alone implements case-insensitivity.
func jsFoldTrivial(s string) bool {
	for _, r := range s {
		if r >= 0x80 && len(jsEquiv(r)) > 1 {
			return false
		}
	}
	return true
}

// jsFoldExtras adds to dst the JS case partners of every character in [lo, hi].
func jsFoldExtras(dst []rune, lo, hi rune) []rune {
	jsFoldInit()
	i := sort.Search(len(jsCased), func(i int) bool { return jsCased[i] >= lo })
	for ; i < len(jsCased) && jsCased[i] <= hi; i++ {
		dst = append(dst, jsEquiv(jsCased[i])...)
	}
	return dst
}
