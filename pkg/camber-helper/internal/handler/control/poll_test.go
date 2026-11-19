package control

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
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

// approvalAgent reports fixed pending approvals, like acpproxy.
type approvalAgent struct {
	*fakeAgent
	pending []methods.ACPApproval
}

func (a *approvalAgent) ListApprovals(context.Context, *struct{}, *glsp.Context) (methods.ACPApprovalsDidChangeParams, error) {
	return methods.ACPApprovalsDidChangeParams{Pending: a.pending}, nil
}

func hugeApproval(id string) methods.ACPApproval {
	content := strings.Repeat("z", 2<<20)
	toolCall, _ := json.Marshal(map[string]any{
		"toolCallId": "write-" + id, "title": "Write big.txt", "kind": "edit",
		"rawInput": map[string]any{"file_path": "big.txt", "content": content},
		"content":  []any{map[string]any{"type": "diff", "path": "big.txt", "newText": content}},
	})
	return methods.ACPApproval{
		AgentServer: "test", SessionID: "session", Kind: "permission", ID: id,
		Permission: &methods.ACPApprovalPermission{
			ToolCall: toolCall,
			Options:  json.RawMessage(`[{"optionId":"allow","name":"Allow","kind":"allow_once"}]`),
		},
	}
}

func TestHugePendingApprovalIsBounded(t *testing.T) {
	for _, command := range []string{"chat.poll", "chat.output"} {
		t.Run(command, func(t *testing.T) {
			s, agent := fixture(t)
			pending := []methods.ACPApproval{hugeApproval("a1"), hugeApproval("a2"), hugeApproval("a3"), hugeApproval("a4"), {AgentServer: "other", SessionID: "session", Kind: "permission", ID: "elsewhere"}}
			s.agent = &approvalAgent{fakeAgent: agent, pending: pending}
			spawn := invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
			<-agent.started
			defer close(agent.finish)
			id := spawn["conversation"].(map[string]any)["id"].(string)

			raw, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: json.RawMessage(`{"conversationId":"` + id + `"}`)}, nil)
			require.NoError(t, err)
			assert.Less(t, len(raw), pollResponseCap)
			var out map[string]any
			require.NoError(t, json.Unmarshal(raw, &out))
			assert.Equal(t, "waiting_for_input", out["status"])
			assert.Equal(t, true, out["truncated"])
			assert.Equal(t, true, out["pendingInteractionsTruncated"])
			items, ok := out["pendingInteractions"].([]any)
			require.True(t, ok)
			require.Len(t, items, 4, "only this conversation's approvals")
			first := items[0].(map[string]any)
			assert.Equal(t, "a1", first["id"])
			assert.Equal(t, "permission", first["kind"])
			assert.Equal(t, true, first["_camber"].(map[string]any)["truncated"])
			enc, err := json.Marshal(first)
			require.NoError(t, err)
			assert.LessOrEqual(t, len(enc), pendingInteractionCap)
			assert.Contains(t, string(enc), "allow_once", "options survive reduction")
			assert.Contains(t, string(enc), "write-a1")
			for i, item := range items {
				assert.Equal(t, fmt.Sprintf("a%d", i+1), item.(map[string]any)["id"])
			}
		})
	}
}

func TestSmallPendingApprovalIsVerbatim(t *testing.T) {
	approval := methods.ACPApproval{AgentServer: "test", SessionID: "session", Kind: "permission", ID: "p1",
		Permission: &methods.ACPApprovalPermission{ToolCall: json.RawMessage(`{"toolCallId":"t","rawInput":{"command":"ls"}}`), Options: json.RawMessage(`[]`)}}
	bounded, truncated := boundPendingInteractions([]methods.ACPApproval{approval}, nil)
	assert.False(t, truncated)
	require.Len(t, bounded, 1)
	assert.Equal(t, approval, bounded[0])
}

func TestPollResponseFitsCap(t *testing.T) {
	v := View{Record: Record{Task: strings.Repeat("t", 4096), ConfigOptions: json.RawMessage(`"` + strings.Repeat("c", 500*1024) + `"`)}}
	out := map[string]any{"conversation": v, "text": strings.Repeat("x", 400*1024), "pendingInteractions": []any{}}
	fitPollResponse(out, nil, nil)
	assert.LessOrEqual(t, encodedLen(out), pollResponseCap)
	assert.Equal(t, true, out["conversationReduced"])
	assert.Equal(t, true, out["truncated"])
	assert.NotContains(t, out, "textOmitted", "slimming the conversation was enough")
	assert.Len(t, out["conversation"].(View).Task, 1024)
}
