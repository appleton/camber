//go:build !unix

package remoteaccess

import (
	"os"
	"time"
)

// Without flock there is no cheap liveness check for another instance's spill
// directory; only directories untouched for a week are treated as abandoned.
func lockHistoryDir(string) (func(), error) { return func() {}, nil }

func staleHistoryDir(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && time.Since(info.ModTime()) > 7*24*time.Hour
}
