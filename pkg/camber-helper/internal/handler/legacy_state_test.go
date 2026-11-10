package handler

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRemoveLegacyEngagementStateAt(t *testing.T) {
	t.Run("file exists", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "helper", "engagement.json")
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, []byte(`{"deviceId":"legacy"}`), 0o644))

		removeLegacyEngagementStateAt(path)

		_, err := os.Stat(path)
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("file absent", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "helper", "engagement.json")

		assert.NotPanics(t, func() {
			removeLegacyEngagementStateAt(path)
		})
	})
}
