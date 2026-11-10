package handler

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/tliron/glsp"
)

func TestLifecycle(t *testing.T) {
	t.Run("shutdown calls all cleanupFns and sets receivedShutdown", func(t *testing.T) {
		handler := newHandlerBaseState()

		// Track which cleanupFns were called
		closable1Called := false
		closable2Called := false

		// Add cleanupFns
		handler.cleanupFns = append(handler.cleanupFns, func() error {
			closable1Called = true
			return nil
		})
		handler.cleanupFns = append(handler.cleanupFns, func() error {
			closable2Called = true
			return nil
		})

		// Call shutdown
		ctx := &glsp.Context{}
		err := handler.shutdown(ctx)

		assert.NoError(t, err)
		assert.True(t, handler.receivedShutdown.Load())
		assert.True(t, closable1Called)
		assert.True(t, closable2Called)
	})

	t.Run("exit with shutdown received exits with code 0", func(t *testing.T) {
		handler := newHandlerBaseState()

		// Mock osExit
		exitCode := -1
		originalOsExit := osExit
		osExit = func(code int) {
			exitCode = code
		}
		defer func() { osExit = originalOsExit }()

		// Set receivedShutdown to true
		handler.receivedShutdown.Store(true)

		// Call exit
		ctx := &glsp.Context{}
		err := handler.exit(ctx)

		assert.NoError(t, err)
		assert.Equal(t, 0, exitCode)
	})

	t.Run("exit without shutdown received exits with code 1", func(t *testing.T) {
		handler := newHandlerBaseState()

		// Mock osExit
		exitCode := -1
		originalOsExit := osExit
		osExit = func(code int) {
			exitCode = code
		}
		defer func() { osExit = originalOsExit }()

		// receivedShutdown is false by default
		assert.False(t, handler.receivedShutdown.Load())

		// Call exit
		ctx := &glsp.Context{}
		err := handler.exit(ctx)

		assert.NoError(t, err)
		assert.Equal(t, 1, exitCode)
	})
}
