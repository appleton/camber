package filesystem

import (
	"os"
	"path/filepath"
)

const fallbackDir = "camber-cache"

// CamberCacheDir creates a cache directory in either os user cache dir or tmp,
// and returns the path
func CamberCacheDir() (string, error) {
	p, err := os.UserCacheDir()
	if err != nil {
		return os.MkdirTemp("", fallbackDir)
	}
	p = filepath.Join(p, "poolside")
	err = os.MkdirAll(p, os.ModePerm)
	if err != nil {
		return os.MkdirTemp("", fallbackDir)
	}
	return p, nil
}
