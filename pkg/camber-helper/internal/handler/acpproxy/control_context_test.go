package acpproxy

import (
	"context"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestControlContextPreservesExistingHostContext(t *testing.T) {
	original := "<camber-system-instructions>Project guidelines</camber-system-instructions>"
	prompt := []acpsdk.ContentBlock{
		acpsdk.TextBlock("Fix the API"),
		acpsdk.ResourceBlock(acpsdk.EmbeddedResourceResource{
			TextResourceContents: &acpsdk.TextResourceContents{Uri: controlHostContextURI, Text: original},
		}),
	}
	out := withControlContext(prompt, &controlContext{InstanceID: "desktop-1", ConversationID: "child-2"}, true)
	require.Len(t, out, 2)
	require.NotNil(t, out[1].Resource)
	require.NotNil(t, out[1].Resource.Resource.TextResourceContents)
	assert.Equal(t, original, prompt[1].Resource.Resource.TextResourceContents.Text, "do not mutate caller-owned content")
	assert.Contains(t, out[1].Resource.Resource.TextResourceContents.Text, "Project guidelines")
	assert.Contains(t, out[1].Resource.Resource.TextResourceContents.Text, `"conversationId":"child-2"`)
	assert.Contains(t, out[1].Resource.Resource.TextResourceContents.Text, `"instanceId":"desktop-1"`)
	assert.Equal(t, "Fix the API", out[0].Text.Text)
}

func TestControlContextRespectsPromptCapabilities(t *testing.T) {
	origin := &controlContext{InstanceID: "desktop-1", ConversationID: "chat-2"}
	for _, embedded := range []bool{false, true} {
		t.Run(map[bool]string{false: "text only", true: "embedded"}[embedded], func(t *testing.T) {
			out := withControlContext([]acpsdk.ContentBlock{acpsdk.TextBlock("Task")}, origin, embedded)
			require.Len(t, out, 2)
			if embedded {
				require.NotNil(t, out[1].Resource)
				assert.Equal(t, controlHostContextURI, out[1].Resource.Resource.TextResourceContents.Uri)
			} else {
				require.NotNil(t, out[1].Text)
				assert.Contains(t, out[1].Text.Text, "<camber-system-instructions>")
				assert.Contains(t, out[1].Text.Text, `"conversationId":"chat-2"`)
			}
		})
	}
}

func TestControlContextAbsentOutsideDesktop(t *testing.T) {
	prompt := []acpsdk.ContentBlock{acpsdk.TextBlock("Task")}
	assert.Equal(t, prompt, withControlContext(prompt, nil, true))
}

// listingLiveStatusSink lets promptControlContext find the conversation.
type listingLiveStatusSink struct {
	recordingLiveStatusSink
	conversations []methods.ACPNavConversation
}

func (s *listingLiveStatusSink) List(context.Context, *methods.ACPNavListParams, *glsp.Context) (methods.ACPNavState, error) {
	return methods.ACPNavState{Conversations: s.conversations}, nil
}

func TestControlContextCarriesResolvableCallerToken(t *testing.T) {
	t.Setenv("CAMBER_INSTANCE_ID", "desktop-1")
	sink := &listingLiveStatusSink{conversations: []methods.ACPNavConversation{
		{ID: "chat-a", AgentServer: "agent", SessionID: "s-a", Cwd: "/w"},
		{ID: "chat-b", AgentServer: "agent", SessionID: "s-b", Cwd: "/w"},
	}}
	h := NewHandler(nil, nil, sink)

	origin := h.promptControlContext(context.Background(), "agent", "s-a")
	require.NotNil(t, origin)
	require.NotEmpty(t, origin.CallerToken)
	assert.GreaterOrEqual(t, len(origin.CallerToken), 22, "at least 128 bits")
	again := h.promptControlContext(context.Background(), "agent", "s-a")
	require.NotNil(t, again)
	assert.Equal(t, origin.CallerToken, again.CallerToken, "stable for the process lifetime")
	other := h.promptControlContext(context.Background(), "agent", "s-b")
	require.NotNil(t, other)
	assert.NotEqual(t, origin.CallerToken, other.CallerToken)

	out := withControlContext([]acpsdk.ContentBlock{acpsdk.TextBlock("Task")}, origin, false)
	require.Len(t, out, 2)
	require.NotNil(t, out[1].Text)
	assert.Contains(t, out[1].Text.Text, `"callerToken":"`+origin.CallerToken+`"`)
	assert.Contains(t, out[1].Text.Text, "--caller-token")
	for _, command := range []string{"chat spawn", "chat config set", "chat send", "chat steer"} {
		assert.Contains(t, out[1].Text.Text, command, "token instructions name %s", command)
	}

	id, ok := h.ResolveCallerToken(origin.CallerToken)
	require.True(t, ok)
	assert.Equal(t, "chat-a", id)
	id, ok = h.ResolveCallerToken(other.CallerToken)
	require.True(t, ok)
	assert.Equal(t, "chat-b", id)
	for _, bogus := range []string{"", "not-a-token"} {
		_, ok = h.ResolveCallerToken(bogus)
		assert.False(t, ok, bogus)
	}

	redacted := string(h.RedactCallerTokens([]byte(`{"text":"` + origin.CallerToken + `"}`)))
	assert.NotContains(t, redacted, origin.CallerToken)
	assert.Contains(t, redacted, "[redacted]")
}
