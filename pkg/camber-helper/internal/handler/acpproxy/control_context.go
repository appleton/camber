package acpproxy

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const controlHostContextURI = "camber://host-context.md"

// controlContext identifies the caller independently of the user's focused
// conversation. Agent processes can serve several sessions, so conversation
// identity belongs in each prompt rather than process-wide environment.
type controlContext struct {
	InstanceID     string `json:"instanceId"`
	ConversationID string `json:"conversationId"`
	AgentServer    string `json:"agentServer"`
	WorkspacePath  string `json:"workspacePath"`
	// CallerToken proves this conversation's identity to the control
	// dispatcher. It appears only in this prompt's host context.
	CallerToken string `json:"callerToken,omitempty"`
}

type controlConversationSource interface {
	List(context.Context, *methods.ACPNavListParams, *glsp.Context) (methods.ACPNavState, error)
}

func (h *Handler) promptControlContext(ctx context.Context, serverName, sessionID string) *controlContext {
	instanceID := os.Getenv("CAMBER_INSTANCE_ID")
	source, ok := h.liveStatusSink.(controlConversationSource)
	if instanceID == "" || !ok {
		return nil
	}
	state, err := source.List(ctx, &methods.ACPNavListParams{}, nil)
	if err != nil {
		return nil
	}
	for _, conversation := range state.Conversations {
		if conversation.SessionID == sessionID && normalizeServerName(conversation.AgentServer) == serverName {
			return &controlContext{
				InstanceID:     instanceID,
				ConversationID: conversation.ID,
				AgentServer:    serverName,
				WorkspacePath:  conversation.Cwd,
				CallerToken:    h.callerTokenForSession(conversation.ID, promptSessionKey{agentServer: serverName, sessionID: sessionID}),
			}
		}
	}
	return nil
}

func withControlContext(prompt []acpsdk.ContentBlock, origin *controlContext, embedded bool) []acpsdk.ContentBlock {
	if origin == nil {
		return prompt
	}
	identity, _ := json.Marshal(origin)
	text := "\nCamber CLI origin (the conversation running this agent, independent of UI focus):\n" +
		string(identity) +
		"\nUse `camber skill show` for current CLI instructions. Pass the instanceId with --instance and use conversationId as the parent when spawning child conversations. Pass callerToken with --caller-token on `chat spawn` and `chat config set` so the desktop can verify which conversation is asking; it is required to give a child or conversation a permission-bypass mode. Keep the token private: do not write it to files, task text, or other conversations. Use explicit target IDs; do not infer your origin from the focused desktop conversation.\n"
	out := append([]acpsdk.ContentBlock(nil), prompt...)
	for i, block := range out {
		if block.Resource == nil || block.Resource.Resource.TextResourceContents == nil {
			continue
		}
		resource := *block.Resource.Resource.TextResourceContents
		if resource.Uri != controlHostContextURI {
			continue
		}
		if strings.Contains(resource.Text, "</camber-system-instructions>") {
			resource.Text = strings.Replace(resource.Text, "</camber-system-instructions>", text+"</camber-system-instructions>", 1)
		} else {
			resource.Text += text
		}
		wrapper := *block.Resource
		wrapper.Resource.TextResourceContents = &resource
		out[i].Resource = &wrapper
		return out
	}
	text = "<camber-system-instructions>" + text + "</camber-system-instructions>"
	if embedded {
		mime := "text/markdown"
		return append(out, acpsdk.ResourceBlock(acpsdk.EmbeddedResourceResource{
			TextResourceContents: &acpsdk.TextResourceContents{
				Uri: controlHostContextURI, MimeType: &mime, Text: text,
			},
		}))
	}
	return append(out, acpsdk.TextBlock(text))
}
