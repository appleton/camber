package handler

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/appleton/camber/pkg/common/userconfig"
)

// removeLegacyEngagementState deletes the anonymous-device seed file that
// releases before engagement metrics were removed wrote to the helper's
// state directory. Nothing reads this file anymore; it is cleaned up
// opportunistically so it doesn't linger on disk forever.
func removeLegacyEngagementState() {
	removeLegacyEngagementStateAt(filepath.Join(userconfig.StateDirectory(), "helper", "engagement.json"))
}

func removeLegacyEngagementStateAt(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Debug("failed to remove legacy engagement state file", "path", path, "err", err)
	}
}
