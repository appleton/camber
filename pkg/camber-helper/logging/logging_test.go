package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestDefaultLoggerFollowsLevelChange(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() {
		slog.SetDefault(original)
		logLevel.Set(slog.LevelInfo)
	})

	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{
		Level: logLevel,
	})
	slog.SetDefault(slog.New(handler))

	t.Run("production filters debug messages", func(t *testing.T) {
		buf.Reset()
		UpdateLevelForEnvironment(methods.AssistantEnvironment("production"))

		slog.Debug("debug message should be hidden")
		slog.Info("info message should appear")

		output := buf.String()
		if strings.Contains(output, "debug message should be hidden") {
			t.Error("debug message should NOT appear in production mode")
		}
		if !strings.Contains(output, "info message should appear") {
			t.Error("info message should appear in production mode")
		}
	})

	t.Run("development shows debug messages", func(t *testing.T) {
		buf.Reset()
		UpdateLevelForEnvironment(methods.DevelopmentEnv)

		slog.Debug("debug message should appear")
		slog.Info("info message should appear")

		output := buf.String()
		if !strings.Contains(output, "debug message should appear") {
			t.Errorf("debug message should appear in development mode, got: %s", output)
		}
		if !strings.Contains(output, "info message should appear") {
			t.Error("info message should appear in development mode")
		}
	})

	t.Run("switching back to production hides debug again", func(t *testing.T) {
		buf.Reset()
		UpdateLevelForEnvironment(methods.AssistantEnvironment("production"))

		slog.Debug("debug after switch should be hidden")

		output := buf.String()
		if strings.Contains(output, "debug after switch should be hidden") {
			t.Error("debug message should NOT appear after switching back to production")
		}
	})
}
