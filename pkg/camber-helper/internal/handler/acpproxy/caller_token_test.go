package acpproxy

import (
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func messageChunk(text string) acpsdk.SessionUpdate {
	return acpsdk.UpdateAgentMessageText(text)
}

func TestCallerTokenSplitAcrossChunksIsRevoked(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	owner := promptSessionKey{agentServer: "agent", sessionID: "s-a"}
	token := h.callerTokenForSession("chat-a", owner)
	other := h.callerTokenForSession("chat-b", promptSessionKey{agentServer: "agent", sessionID: "s-b"})

	// A different session streams chat-a's token in two fragments.
	h.observeCallerTokenLeak("agent", "s-b", messageChunk("here it is: "+token[:10]))
	_, ok := h.ResolveCallerToken(token)
	require.True(t, ok, "a fragment alone is not a leak")
	h.observeCallerTokenLeak("agent", "s-b", messageChunk(token[10:]+" done"))

	_, ok = h.ResolveCallerToken(token)
	assert.False(t, ok, "split token is revoked")
	id, ok := h.ResolveCallerToken(other)
	assert.True(t, ok, "unrelated tokens stay valid")
	assert.Equal(t, "chat-b", id)

	fresh := h.callerTokenForSession("chat-a", owner)
	assert.NotEqual(t, token, fresh, "the next prompt mints a fresh token")
	id, ok = h.ResolveCallerToken(fresh)
	require.True(t, ok)
	assert.Equal(t, "chat-a", id)
	assert.NotContains(t, string(h.RedactCallerTokens([]byte(token))), token, "revoked tokens stay redacted")
}

func TestCallerTokenSplitAcrossThoughtChunksIsRevoked(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	token := h.callerTokenForSession("chat-a", promptSessionKey{agentServer: "agent", sessionID: "s-a"})
	// Interleaved message text must not break the thought window.
	h.observeCallerTokenLeak("agent", "s-a", acpsdk.UpdateAgentThoughtText(token[:5]))
	h.observeCallerTokenLeak("agent", "s-a", messageChunk("unrelated"))
	h.observeCallerTokenLeak("agent", "s-a", acpsdk.UpdateAgentThoughtText(token[5:]))
	_, ok := h.ResolveCallerToken(token)
	assert.False(t, ok)
}

func TestCallerTokenUnrelatedTextIsNotRevoked(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	token := h.callerTokenForSession("chat-a", promptSessionKey{agentServer: "agent", sessionID: "s-a"})
	for _, text := range []string{token[:20], "xx", token[:6], "unrelated text " + token[3:]} {
		h.observeCallerTokenLeak("agent", "s-a", messageChunk(text))
	}
	// The fragment in another session's window does not combine with this one.
	h.observeCallerTokenLeak("agent", "s-b", messageChunk(token[:13]))
	h.observeCallerTokenLeak("agent", "s-a", messageChunk(token[13:]))
	id, ok := h.ResolveCallerToken(token)
	require.True(t, ok)
	assert.Equal(t, "chat-a", id)
}

func TestCallerTokenInToolCall(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	own := h.callerTokenForSession("chat-a", promptSessionKey{agentServer: "agent", sessionID: "s-a"})
	foreign := h.callerTokenForSession("chat-b", promptSessionKey{agentServer: "agent", sessionID: "s-b"})

	h.observeCallerTokenLeak("agent", "s-a", acpsdk.StartToolCall("call-1", "camber chat spawn --caller-token "+own,
		acpsdk.WithStartRawInput(map[string]any{"command": "camber chat spawn --caller-token " + own})))
	_, ok := h.ResolveCallerToken(own)
	assert.True(t, ok, "the session's own token on the CLI is legitimate use")

	h.observeCallerTokenLeak("agent", "s-a", acpsdk.UpdateToolCall("call-1",
		acpsdk.WithUpdateContent([]acpsdk.ToolCallContent{acpsdk.ToolContent(acpsdk.TextBlock("found " + foreign))})))
	_, ok = h.ResolveCallerToken(foreign)
	assert.False(t, ok, "another conversation's token in tool output is a leak")
	_, ok = h.ResolveCallerToken(own)
	assert.True(t, ok)
}

func TestCallerTokenInReplayedUserMessageIsNotRevoked(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	token := h.callerTokenForSession("chat-a", promptSessionKey{agentServer: "agent", sessionID: "s-a"})
	h.observeCallerTokenLeak("agent", "s-a", acpsdk.UpdateUserMessageText(`{"callerToken":"`+token+`"}`))
	_, ok := h.ResolveCallerToken(token)
	assert.True(t, ok)
}
