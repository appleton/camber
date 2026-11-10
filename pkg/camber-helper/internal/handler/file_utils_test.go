package handler

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestUriToPath(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "file URI with absolute path",
			input:    "file:///home/user/project/main.go",
			expected: "/home/user/project/main.go",
		},
		{
			name:     "file URI with spaces encoded",
			input:    "file:///home/user/my%20project/main.go",
			expected: "/home/user/my project/main.go",
		},
		{
			name:     "plain absolute path returned as-is",
			input:    "/home/user/project/main.go",
			expected: "/home/user/project/main.go",
		},
		{
			name:     "relative path returned as-is",
			input:    "relative/path/file.go",
			expected: "relative/path/file.go",
		},
		{
			name:     "empty string returned as-is",
			input:    "",
			expected: "",
		},
		{
			name:     "non-file scheme returned as-is",
			input:    "https://example.com/file.go",
			expected: "https://example.com/file.go",
		},
		{
			name:     "file URI with only scheme prefix",
			input:    "file:///",
			expected: "/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, uriToPath(tt.input))
		})
	}
}
