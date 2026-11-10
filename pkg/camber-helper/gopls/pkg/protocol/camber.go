package protocol

import (
	"strings"
	"unicode"

	"github.com/pkg/errors"
)

// NormalizeAndParsePath first normalizes the given path using NormalizePath, then parses it to a
// DocumentURI
func NormalizeAndParsePath(path string) (DocumentURI, error) {
	path, err := NormalizePath(path)
	if err != nil {
		return "", err
	}
	return ParseNormalizedPath(path)
}

// NormalizePath accepts a path separated by the os path separator and returns a normalized path
// (i.e. a posix path or a /c:/foo/bar style windows path)
func NormalizePath(path string) (string, error) {
	path = strings.ReplaceAll(path, `\`, "/")

	isWindowsPath := len(path) >= 2 && unicode.IsLetter(rune(path[0])) && path[1] == ':'
	isAbsolute := strings.HasPrefix(path, "/") || isWindowsPath

	if !isAbsolute {
		return "", errors.Errorf("path is not absolute: %q", path)
	}

	if isWindowsPath {
		return "/" + strings.ToLower(string(path[0])) + path[1:], nil
	}

	return path, nil
}

// MustParseNormalizedPath returns a DocumentURI from a valid
// normalized path (i.e. a posix path or a /c:/foo/bar windows path)
// Panics on invalid input, should only be used on deterministically valid paths
func MustParseNormalizedPath(path string) DocumentURI {
	d, err := ParseNormalizedPath(path)
	if err != nil {
		panic(err)
	}
	return d
}

// ParseNormalizedPath returns a DocumentURI from a valid
// normalized path (i.e. a posix path or a /c:/foo/bar windows path), or error
// URIFromPath is the equivalent for parsing an OS path, not a normalized one.
func ParseNormalizedPath(path string) (DocumentURI, error) {
	if !strings.HasPrefix(path, "/") {
		return "", errors.Errorf("path not normalized %q", path)
	}
	return DocumentURI("file://" + path), nil
}

// NormalizedPath is:
// - posix paths unchanged
// - windows paths have drives as follows - /c:/a/b/c
func (uri DocumentURI) NormalizedPath() string {
	fn, err := filename(uri)
	if err != nil {
		// could only happen with manually constructed paths,
		// all uris coming in via requests has been validated
		panic(err)
	}
	if len(fn) < 2 {
		return fn
	}
	if unicode.IsLetter(rune(fn[0])) && fn[1] == ':' {
		return "/" + fn
	}
	return fn
}
