/*
Package data provides utilities for binary file detection and handling.

# Binary Detection Strategy

This package implements a multi-layered approach to detect whether a file or byte stream
is binary or text. The detection happens in the following order:

1. File Extension Check (if enabled):
  - Checks against a predefined list of known binary extensions
  - Can be disabled using WithoutCheckExtensions()

2. Content Analysis:
  - Searches for null bytes
  - Checks for binary file magic numbers and BOMs
  - Performs MIME type detection
  - Analyzes control character ratio

The detection is configurable through various options to tune the behavior for different
use cases.

Usage:

	// Basic file check
	isBinary, err := data.IsBinaryFile("document.pdf")

	// Check with custom options
	isBinary, err := data.IsBinaryFile("document.txt",
	    data.WithBufferSize(8192),
	    data.WithoutCheckExtensions(),
	)

	// Check io.Reader directly
	isBinary, err := data.IsBinary(reader)
*/
package data

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/spf13/afero"

	"github.com/appleton/camber/pkg/common/sync/bufferpool"
)

// DefaultBinaryCheckBufSize is the default size of the buffer used to read file content
// for binary detection. 4KB is typically sufficient to determine if a file is binary.
const DefaultBinaryCheckBufSize = 4096

var (
	// CommonBinaryExtensions is a set of file extensions that are known to be binary formats.
	// This is used as a quick first-pass check before analyzing file contents.
	CommonBinaryExtensions = map[string]struct{}{
		".dll":   {},
		".dylib": {},
		".exe":   {},
		".gif":   {},
		".gz":    {},
		".jpeg":  {},
		".jpg":   {},
		".pdf":   {},
		".png":   {},
		".so":    {},
		".tar":   {},
		".zip":   {},
	}

	// Common file magic numbers
	magicNumbers = [][]byte{
		{0x7F, 'E', 'L', 'F'},    // ELF
		{0x4D, 0x5A},             // DOS/PE
		{0xFF, 0xD8, 0xFF},       // JPEG
		{0x89, 0x50, 0x4E, 0x47}, // PNG
		{0xFE, 0xFF},             // UTF-16 BE BOM
		{0xFF, 0xFE},             // UTF-16 LE BOM
	}
)

type options struct {
	fs                   afero.Fs
	bp                   *bufferpool.BufferPool[byte]
	bufferSize           int     // Size of buffer to read
	controlCharThreshold float64 // Threshold for control characters ratio
	checkMIME            bool    // Whether to use MIME type detection
	checkExtensions      bool    // Whether to check file extensions
}

// Option represents a function that can modify the binary detection options.
type Option func(*options)

func defaultOptions() *options {
	return &options{
		fs:                   afero.NewReadOnlyFs(afero.NewOsFs()),
		bufferSize:           DefaultBinaryCheckBufSize,
		controlCharThreshold: 0.1,
		checkMIME:            true,
		checkExtensions:      true,
	}
}

func (o *options) apply(opts []Option) {
	for _, opt := range opts {
		opt(o)
	}
}

// WithFS sets a custom filesystem implementation for file operations.
// This is particularly useful for testing or working with virtual filesystems.
func WithFS(fs afero.Fs) Option {
	return func(o *options) {
		o.fs = afero.NewReadOnlyFs(fs)
	}
}

// WithBufferPool sets a custom buffer pool for memory reuse during binary detection.
// This can improve performance when checking many files by reducing allocations.
func WithBufferPool(bp *bufferpool.BufferPool[byte]) Option {
	return func(o *options) {
		o.bp = bp
	}
}

// IsBinaryFile determines if a file at the given path is binary.
// It returns true if the file is binary, false if it's text, and any error encountered.
func IsBinaryFile(path string, opts ...Option) (bool, error) {
	o := defaultOptions()
	o.apply(opts)

	// Quick extension check first
	if o.checkExtensions {
		ext := strings.ToLower(filepath.Ext(path))
		if _, ok := CommonBinaryExtensions[ext]; ok {
			return true, nil
		}
	}

	r, err := o.fs.Open(path)
	if err != nil {
		return false, fmt.Errorf("binary matcher couldn't open file %q: %w", path, err)
	}
	defer r.Close()

	return isBinary(r, o)
}

func isBinary(r io.Reader, o *options) (bool, error) {
	var buf *[]byte
	if o.bp == nil {
		b := make([]byte, o.bufferSize)
		buf = &b
	} else {
		buf = o.bp.Get()
		defer o.bp.Put(buf)
	}

	n, err := io.ReadFull(r, *buf)
	switch {
	case errors.Is(err, io.EOF):
		// empty file, treat as text
		return false, nil
	case errors.Is(err, io.ErrUnexpectedEOF):
		// partial read is fine
		*buf = (*buf)[:n]
	case err != nil:
		return false, fmt.Errorf("binary matcher had error reading: %w", err)
	}

	// Check for null bytes, null bytes strongly indicate binary
	if n = bytes.IndexByte(*buf, 0); n != -1 {
		return true, nil
	}

	// Check for BOM and common magic numbers
	for _, magic := range magicNumbers {
		if bytes.HasPrefix(*buf, magic) {
			return true, nil
		}
	}

	// MIME type check
	if o.checkMIME && !isTextMime(*buf) {
		return true, nil
	}

	// Control character analysis
	return analyzeBinaryControlChars(*buf, o.controlCharThreshold), nil
}

func isTextMime(buf []byte) bool {
	mimeType := http.DetectContentType(buf)

	switch {
	case strings.HasPrefix(mimeType, "text/"):
		return true
	case mimeType == "application/json":
		return true
	}

	return false
}

func analyzeBinaryControlChars(buf []byte, thresh float64) bool {
	controlCount := 0
	totalRunes := 0
	for i := 0; i < len(buf); {
		r, size := utf8.DecodeRune((buf)[i:])
		if r == utf8.RuneError {
			return true // Invalid UTF-8 sequence, is binary
		}

		if unicode.Is(unicode.C, r) && !unicode.IsSpace(r) {
			controlCount++
		}

		totalRunes++
		i += size
	}

	// If more than 10% is control chars, likely binary
	if totalRunes > 0 && float64(controlCount)/float64(totalRunes) > thresh {
		return true
	}

	return false
}
