package control

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

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

func TestReducedAgentTextIsNotReportedComplete(t *testing.T) {
	for _, command := range []string{"chat.output", "chat.snapshot"} {
		t.Run(command, func(t *testing.T) {
			s, agent := fixture(t)
			spawn := invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
			<-agent.started
			id := spawn["conversation"].(map[string]any)["id"].(string)
			turn := spawn["turnId"].(string)
			s.log.Publish("test", "session", "", false, chunk(strings.Repeat("y", 300*1024)))
			close(agent.finish)
			require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status == "completed" }, time.Second, time.Millisecond*10)

			out := invoke(t, s, command, Args{ConversationID: id, TurnID: turn})
			assert.Equal(t, false, out["hasMore"])
			assert.Equal(t, true, out["truncated"])
			assert.Equal(t, false, out["complete"])
			assert.Equal(t, true, out["agentTextTruncated"])
			assert.EqualValues(t, 1, out["reducedEvents"])
			assert.Contains(t, out["text"], "[truncated ")
		})
	}
}

func TestNormalFinalPageIsCompleteAndNotTruncated(t *testing.T) {
	s, agent := fixture(t)
	spawn := invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
	<-agent.started
	id := spawn["conversation"].(map[string]any)["id"].(string)
	turn := spawn["turnId"].(string)
	s.log.Publish("test", "session", "", false, chunk("short answer"))
	close(agent.finish)
	require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status == "completed" }, time.Second, time.Millisecond*10)

	out := invoke(t, s, "chat.output", Args{ConversationID: id, TurnID: turn})
	assert.Equal(t, true, out["complete"])
	assert.Equal(t, false, out["truncated"])
	assert.Equal(t, false, out["agentTextTruncated"])
}
