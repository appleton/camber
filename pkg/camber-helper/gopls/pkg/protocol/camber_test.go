package protocol

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParsedNormalizedAsDocument(t *testing.T) {
	tests := []struct {
		name           string
		input          string
		expectedParsed DocumentURI
	}{
		{
			name:           "Valid POSIX path",
			input:          "/valid/posix/path",
			expectedParsed: "file:///valid/posix/path",
		},
		{
			name:           "Valid POSIX root",
			input:          "/",
			expectedParsed: "file:///",
		},
		{
			name:  "Windows path not valid",
			input: `c:\windows\path`,
		},
		{
			name:  "Empty string not valid",
			input: "",
		},
		{
			name:  "Relative POSIX path not valid",
			input: "relative/posix/path",
		},
		{
			name:  "file uri not valid",
			input: "file:///hi",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.expectedParsed == "" {
				_, err := ParseNormalizedPath(tt.input)
				assert.ErrorContains(t, err, "path not normalized")
			} else {
				result, err := ParseNormalizedPath(tt.input)
				assert.NoError(t, err)
				assert.Equal(t, tt.expectedParsed, result)
			}
		})
	}
}

func TestDocumentURI_NormalizedPath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "valid posix abs",
			input: "file:///a/b/c",
			want:  "/a/b/c",
		},
		{
			name:  "valid abs drive name",
			input: "file:///C:/foo",
			want:  "/c:/foo",
		},
		{
			name:  "handles invalid missing leading path with drive name",
			input: "file://C:/foo",
			want:  "/c:/foo",
		},
		{
			name:  "encoded colon",
			input: "file:///C%3A/foo",
			want:  "/c:/foo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			uri, err := ParseDocumentURI(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, uri.NormalizedPath())
		})
	}
}

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		want        string
		expectError bool
	}{
		{
			name:        "empty string should error",
			input:       "",
			expectError: true,
		},
		{
			name:        "unix absolute path",
			input:       "/home/user/file.txt",
			want:        "/home/user/file.txt",
			expectError: false,
		},
		{
			name:        "unix relative path should error",
			input:       "home/user/file.txt",
			expectError: true,
		},
		{
			name:        "windows absolute path with backslashes",
			input:       `C:\Users\user\file.txt`,
			want:        "/c:/Users/user/file.txt",
			expectError: false,
		},
		{
			name:        "windows absolute path with forward slashes",
			input:       "C:/Users/user/file.txt",
			want:        "/c:/Users/user/file.txt",
			expectError: false,
		},
		{
			name:        "windows path with uppercase drive",
			input:       `D:\Program Files\app.exe`,
			want:        "/d:/Program Files/app.exe",
			expectError: false,
		},
		{
			name:        "windows path with lowercase drive",
			input:       `c:\temp\test.log`,
			want:        "/c:/temp/test.log",
			expectError: false,
		},
		{
			name:        "windows relative path should error",
			input:       `folder\subfolder\file.txt`,
			expectError: true,
		},
		{
			name:        "mixed separators",
			input:       `C:\folder/subfolder\file.txt`,
			want:        "/c:/folder/subfolder/file.txt",
			expectError: false,
		},
		{
			name:        "root path",
			input:       "/",
			want:        "/",
			expectError: false,
		},
		{
			name:        "windows root drive",
			input:       `C:\`,
			want:        "/c:/",
			expectError: false,
		},
		{
			name:        "single folder should error",
			input:       "folder",
			expectError: true,
		},
		{
			name:        "already normalized posix path",
			input:       "/already/normalized/path",
			want:        "/already/normalized/path",
			expectError: false,
		},
		{
			name:        "already normalized windows path",
			input:       "/c:/already/normalized/path",
			want:        "/c:/already/normalized/path",
			expectError: false,
		},
		{
			name:        "relative path with dots should error",
			input:       "./relative/path",
			expectError: true,
		},
		{
			name:        "relative path with parent should error",
			input:       "../relative/path",
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := NormalizePath(tt.input)
			if tt.expectError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, result)
			}
		})
	}
}

func TestNormalizeAndParsePath(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		want        DocumentURI
		expectError bool
	}{
		{
			name:        "unix absolute path",
			input:       "/home/user/file.txt",
			want:        "file:///home/user/file.txt",
			expectError: false,
		},
		{
			name:        "windows absolute path with backslashes",
			input:       `C:\Users\user\file.txt`,
			want:        "file:///c:/Users/user/file.txt",
			expectError: false,
		},
		{
			name:        "windows absolute path with forward slashes",
			input:       "C:/Users/user/file.txt",
			want:        "file:///c:/Users/user/file.txt",
			expectError: false,
		},
		{
			name:        "relative path should error",
			input:       "relative/path",
			expectError: true,
		},
		{
			name:        "empty string should error",
			input:       "",
			expectError: true,
		},
		{
			name:        "root path",
			input:       "/",
			want:        "file:///",
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := NormalizeAndParsePath(tt.input)
			if tt.expectError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, result)
			}
		})
	}
}
