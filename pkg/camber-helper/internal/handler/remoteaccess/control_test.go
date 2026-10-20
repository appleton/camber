package remoteaccess

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestControlPollPagesWithoutLosingEvents(t *testing.T) {
	l := NewSessionLog(NewHub())
	start := l.ControlCursor("agent", "session")
	for i := 0; i < 8; i++ {
		l.Publish("agent", "session", "", false, map[string]any{"text": strings.Repeat("a", 100000)})
	}
	cursor := start
	count := 0
	pages := 0
	for {
		page, err := l.Poll("agent", "session", cursor)
		require.NoError(t, err)
		require.False(t, page.ResetRequired)
		count += len(page.Events)
		pages++
		cursor = page.NextCursor
		if !page.HasMore {
			break
		}
	}
	assert.Equal(t, 8, count)
	assert.Greater(t, pages, 1)
}

func TestRemoteClientsCannotInvokeLocalControl(t *testing.T) {
	assert.False(t, MethodAllowed("camber/control/dispatch"))
	assert.False(t, MethodAllowed("camber/control/handshake"))
	assert.True(t, MethodAllowed("camber/acp/session/prompt"))
}
func TestControlPollBindsSessionAndEpoch(t *testing.T) {
	l := NewSessionLog(NewHub())
	cursor := l.ControlCursor("agent", "session")
	_, err := l.Poll("agent", "other", cursor)
	require.ErrorContains(t, err, "different conversation")
	restarted := NewSessionLog(NewHub())
	page, err := restarted.Poll("agent", "session", cursor)
	require.NoError(t, err)
	assert.True(t, page.ResetRequired)
}
func TestControlPollBoundsCompletedTurn(t *testing.T) {
	l := NewSessionLog(NewHub())
	start := l.ControlCursor("agent", "session")
	l.Publish("agent", "session", "", false, map[string]any{"text": "A"})
	end := l.ControlCursor("agent", "session")
	l.Publish("agent", "session", "", false, map[string]any{"text": "B"})
	l.BeginTurn("agent", "session")
	page, err := l.PollBetween("agent", "session", start, end)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	assert.Equal(t, end, page.NextCursor)
	assert.False(t, page.TurnActive)
}
func TestControlPollReportsEvictionAndPreservesSnapshotSuffix(t *testing.T) {
	l := NewSessionLog(NewHub())
	cursor := l.ControlCursor("agent", "session")
	for i := 0; i < sessionLogBufferCap+2; i++ {
		l.Publish("agent", "session", "", false, map[string]any{"text": "a"})
	}
	page, err := l.Poll("agent", "session", cursor)
	require.NoError(t, err)
	assert.True(t, page.ResetRequired)
	assert.Empty(t, page.Events)
	snapshot, err := l.Poll("agent", "session", "")
	require.NoError(t, err)
	assert.True(t, snapshot.ResetRequired)
	assert.NotEmpty(t, snapshot.Events)
}
