package acpproxy

import (
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
