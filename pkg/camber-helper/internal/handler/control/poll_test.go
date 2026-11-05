package control

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func chunk(text string) map[string]any {
	return map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "session", "update": map[string]any{
		"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}}}}
}

func TestOversizedEventIsReducedAndPagingContinues(t *testing.T) {
	l := remoteaccess.NewSessionLog(remoteaccess.NewHub())
	start := l.ControlCursor("agent", "session")
	l.Publish("agent", "session", "", false, chunk("before "))
	huge := map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "session", "update": map[string]any{
		"sessionUpdate": "tool_call_update", "toolCallId": "tc1", "status": "completed",
		"_meta":   map[string]any{"claudeCode": map[string]any{"toolResponse": map[string]any{"stdout": strings.Repeat("x", 3<<20)}}},
		"content": []any{map[string]any{"type": "image", "mimeType": "image/png", "data": strings.Repeat("A", 2<<20)}},
	}}}
	l.Publish("agent", "session", "", false, huge)
	l.Publish("agent", "session", "", false, chunk("after"))

	cursor, delivered, truncated := start, 0, 0
	var text strings.Builder
	for i := 0; i < 20; i++ {
		page, err := l.Poll("agent", "session", cursor)
		require.NoError(t, err)
		raw, err := json.Marshal(page)
		require.NoError(t, err)
		assert.Less(t, len(raw), 512*1024)
		for _, e := range page.Events {
			delivered++
			enc, _ := json.Marshal(e.Params)
			if strings.Contains(string(enc), `"truncated":true`) {
				truncated++
				assert.Contains(t, string(enc), "tc1")
				assert.Contains(t, string(enc), "completed")
			}
			text.WriteString(extractText(enc))
		}
		cursor = page.NextCursor
		if !page.HasMore {
			break
		}
	}
	assert.Equal(t, 3, delivered)
	assert.Equal(t, 1, truncated)
	assert.Equal(t, "before after", text.String())

	// The stored log is untouched.
	events, _ := l.Poll("agent", "session", "")
	require.Len(t, events.Events, 3)
	original, ok := huge["params"].(map[string]any)["update"].(map[string]any)["_meta"]
	require.True(t, ok)
	assert.Len(t, original.(map[string]any)["claudeCode"].(map[string]any)["toolResponse"].(map[string]any)["stdout"], 3<<20)
}

func extractText(enc []byte) string {
	var p struct {
		Message struct {
			Params struct {
				Update struct {
					Content struct{ Text string } `json:"content"`
				} `json:"update"`
			} `json:"params"`
		} `json:"message"`
	}
	if json.Unmarshal(enc, &p) != nil {
		return ""
	}
	return p.Message.Params.Update.Content.Text
}
