package acpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	acphelpers "github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/approvals"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestSessionUpdate(t *testing.T) {
	got := make(chan struct {
		method string
		params any
	}, 1)

	c := &acpClient{
		notify: func(_ context.Context, method string, params any) {
			got <- struct {
				method string
				params any
			}{method: method, params: params}
		},
	}

	params := acpsdk.SessionNotification{SessionId: "s1"}
	err := c.SessionUpdate(context.Background(), params)

	require.NoError(t, err)
	require.NoError(t, c.waitForSessionUpdates(context.Background()))
	gotNotification := <-got
	assert.Equal(t, acpsdk.ClientMethodSessionUpdate, gotNotification.method)
	assert.Equal(t, params, gotNotification.params)
}

func TestHandleClaudeSDKMessage(t *testing.T) {
	t.Run("forwards a valid suggestion", func(t *testing.T) {
		got := make(chan struct {
			method string
			params any
		}, 1)
		c := &acpClient{
			notify: func(_ context.Context, method string, params any) {
				got <- struct {
					method string
					params any
				}{method: method, params: params}
			},
		}
		raw := json.RawMessage(`{
			"sessionId": "s1",
			"message": {
				"type": "prompt_suggestion",
				"suggestion": "Run the focused tests",
				"uuid": "suggestion-1",
				"session_id": "claude-session-1"
			}
		}`)

		out, err := c.HandleExtensionMethod(context.Background(), methods.ACPClaudeSDKMessageMethod, raw)

		require.NoError(t, err)
		assert.Nil(t, out)
		require.NoError(t, c.waitForSessionUpdates(context.Background()))
		gotNotification := <-got
		assert.Equal(t, methods.ACPClaudeSDKMessageMethod, gotNotification.method)
		assert.Equal(t, "Run the focused tests", gotNotification.params.(methods.ACPClaudeSDKMessageNotification).Message.Suggestion)
	})

	t.Run("forwards active goal snapshots and explicit clears", func(t *testing.T) {
		got := make(chan methods.ACPClaudeSDKMessageNotification, 2)
		c := &acpClient{
			notify: func(_ context.Context, method string, params any) {
				assert.Equal(t, methods.ACPClaudeSDKMessageMethod, method)
				got <- params.(methods.ACPClaudeSDKMessageNotification)
			},
		}

		for _, raw := range []json.RawMessage{
			json.RawMessage(`{
				"sessionId":"s1",
				"message":{"type":"active_goal","value":{
					"condition":"Land the release",
					"iterations":2,
					"set_at":1722500000,
					"tokens_at_start":12400,
					"last_reason":"Two tests still fail"
				}}
			}`),
			json.RawMessage(`{"sessionId":"s1","message":{"type":"active_goal","value":null}}`),
		} {
			out, err := c.HandleExtensionMethod(context.Background(), methods.ACPClaudeSDKMessageMethod, raw)
			require.NoError(t, err)
			assert.Nil(t, out)
		}

		require.NoError(t, c.waitForSessionUpdates(context.Background()))
		active := <-got
		assert.Equal(t, methods.ACPClaudeSDKActiveGoalType, active.Message.Type)
		assert.Contains(t, string(active.Message.Value), "Land the release")
		cleared := <-got
		assert.JSONEq(t, "null", string(cleared.Message.Value))
	})

	t.Run("ignores unrelated or invalid raw SDK messages", func(t *testing.T) {
		notifications := 0
		c := &acpClient{
			notify: func(context.Context, string, any) {
				notifications++
			},
		}

		for _, raw := range []json.RawMessage{
			json.RawMessage(`{"sessionId":"s1","message":{"type":"assistant","suggestion":"no"}}`),
			json.RawMessage(`{"sessionId":"s1","message":{"type":"prompt_suggestion","suggestion":"  "}}`),
			json.RawMessage(`{"message":{"type":"prompt_suggestion","suggestion":"missing session"}}`),
			json.RawMessage(`{"sessionId":"s1","message":{"type":"active_goal"}}`),
			json.RawMessage(`{"sessionId":"s1","message":{"type":"active_goal","value":{}}}`),
			json.RawMessage(`{"sessionId":"s1","message":{"type":"active_goal","value":{"condition":"Goal","iterations":-1,"set_at":1,"tokens_at_start":1}}}`),
			json.RawMessage(`{`),
		} {
			out, err := c.HandleExtensionMethod(context.Background(), methods.ACPClaudeSDKMessageMethod, raw)
			require.NoError(t, err)
			assert.Nil(t, out)
		}

		require.NoError(t, c.waitForSessionUpdates(context.Background()))
		assert.Zero(t, notifications)
	})
}

func TestHandleCompactionUpdatePreservesSessionID(t *testing.T) {
	tests := []struct {
		name        string
		raw         json.RawMessage
		wantSession acpsdk.SessionId
	}{
		{
			name:        "leaves legacy notification unscoped",
			raw:         json.RawMessage(`{"id":"compaction-1","phase":"started"}`),
			wantSession: "",
		},
		{
			name:        "preserves agent supplied session",
			raw:         json.RawMessage(`{"sessionId":"agent-session","id":"compaction-1","phase":"completed"}`),
			wantSession: "agent-session",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := make(chan methods.ACPCompactionNotification, 1)
			c := &acpClient{
				notify: func(_ context.Context, method string, params any) {
					assert.Equal(t, methods.ACPCompactionUpdateMethod, method)
					got <- params.(methods.ACPCompactionNotification)
				},
				activeSession: func() acpsdk.SessionId {
					t.Fatal("compaction routing must not infer the process's active session")
					return ""
				},
			}

			out, err := c.HandleExtensionMethod(context.Background(), acphelpers.ExtensionMethodCompactionUpdate, tt.raw)

			require.NoError(t, err)
			assert.Nil(t, out)
			require.NoError(t, c.waitForSessionUpdates(context.Background()))
			notif := <-got
			assert.Equal(t, tt.wantSession, notif.SessionID)
			assert.Equal(t, "compaction-1", notif.ID)
		})
	}
}

func TestSessionUpdatePersistsGeneratedTitle(t *testing.T) {
	sink := &recordingLiveStatusSink{}
	c := &acpClient{
		notify:      func(context.Context, string, any) {},
		liveStatus:  sink,
		agentServer: "claude-acp",
	}
	title := "  Generated title  "
	params := acpsdk.SessionNotification{
		SessionId: "s1",
		Update: acpsdk.SessionUpdate{SessionInfoUpdate: &acpsdk.SessionSessionInfoUpdate{
			SessionUpdate: "session_info_update",
			Title:         &title,
		}},
	}

	require.NoError(t, c.SessionUpdate(context.Background(), params))
	require.NoError(t, c.waitForSessionUpdates(context.Background()))
	require.Len(t, sink.titles, 1)
	assert.Equal(t, recordedTitle{agentServer: "claude-acp", sessionID: "s1", title: "Generated title"}, sink.titles[0])
}

// Agents that flatten history on session/load (codex-acp, claude-code-acp)
// replay a title derived from the flattened first prompt, gluing injected
// Camber context onto the user's text. The sanitized remainder is persisted;
// a title that was nothing but injected context must not clobber the stored
// title at all.
func TestSessionUpdateSanitizesFlattenedReplayTitle(t *testing.T) {
	sink := &recordingLiveStatusSink{}
	c := &acpClient{
		notify:      func(context.Context, string, any) {},
		liveStatus:  sink,
		agentServer: "codex-acp",
	}

	corrupted := `continuecamber://handoff/56a2ba59.md <context ref="camber://handoff/56a2ba59.md">handoff body`
	contextOnly := `<context ref="camber://host-context.md">host context body</context>`
	for _, title := range []string{corrupted, contextOnly} {
		params := acpsdk.SessionNotification{
			SessionId: "s1",
			Update: acpsdk.SessionUpdate{SessionInfoUpdate: &acpsdk.SessionSessionInfoUpdate{
				SessionUpdate: "session_info_update",
				Title:         &title,
			}},
		}
		require.NoError(t, c.SessionUpdate(context.Background(), params))
	}

	require.NoError(t, c.waitForSessionUpdates(context.Background()))
	require.Len(t, sink.titles, 1)
	assert.Equal(t, recordedTitle{agentServer: "codex-acp", sessionID: "s1", title: "continue"}, sink.titles[0])
}

func TestSanitizeSessionTitle(t *testing.T) {
	tests := []struct {
		name  string
		title string
		want  string
	}{
		{"plain title untouched", "Fix the flaky test", "Fix the flaky test"},
		{"trims whitespace", "  Generated title  ", "Generated title"},
		{
			"strips glued handoff link and wrapper",
			`continuecamber://handoff/56a2ba59.md <context ref="camber://handoff/56a2ba59.md">body`,
			"continue",
		},
		{
			"strips glued host context link",
			"Hi, what model are you now?camber://host-context.md",
			"Hi, what model are you now?",
		},
		{"strips inlined handoff tag", "continue <camber-handoff>body", "continue"},
		{"strips inlined system instructions tag", "hello <camber-system-instructions>body", "hello"},
		{"context-only title becomes empty", `<context ref="camber://handoff/x.md">body`, ""},
		{
			// Marker-first: the bare link precedes real user text and must
			// be stripped without dropping the text that follows.
			"strips a bare handoff link before real text",
			"camber://handoff/abc.md\ncontinue working on X",
			"continue working on X",
		},
		{
			// Marker-last: the mirror image of the marker-first case.
			"strips a bare handoff link after real text",
			"continue working on X\ncamber://handoff/abc.md",
			"continue working on X",
		},
		{"bare handoff link only becomes empty", "camber://handoff/abc.md", ""},
		{
			"keeps a handoff link in the middle of user text",
			"why does camber://handoff/abc.md show up in my title?",
			"why does camber://handoff/abc.md show up in my title?",
		},
		{
			"strips a bare host context link before real text",
			"camber://host-context.md\ncontinue working on X",
			"continue working on X",
		},
		{
			"strips a bare host context link after real text",
			"continue working on X\ncamber://host-context.md",
			"continue working on X",
		},
		{"bare host context link only becomes empty", "camber://host-context.md", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, sanitizeSessionTitle(tt.title))
		})
	}
}

func permissionRequestFixture() acpsdk.RequestPermissionRequest {
	return acpsdk.RequestPermissionRequest{
		SessionId: "s1",
		ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: "tc-1"},
		Options: []acpsdk.PermissionOption{
			{OptionId: "opt-1", Kind: "allow_once", Name: "Allow"},
			{OptionId: "opt-2", Kind: "reject_once", Name: "Deny"},
		},
	}
}

func TestRequestPermission(t *testing.T) {
	t.Run("resolves with the first valid surface answer", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "poolside", handler: &Handler{approvals: store}}

		type result struct {
			resp acpsdk.RequestPermissionResponse
			err  error
		}
		done := make(chan result, 1)
		go func() {
			resp, err := c.RequestPermission(context.Background(), permissionRequestFixture())
			done <- result{resp, err}
		}()

		// Registration pushes the grown pending set to every surface.
		pending := <-pushed
		require.Len(t, pending, 1)
		assert.Equal(t, "permission", pending[0].Kind)
		assert.Equal(t, "tc-1", pending[0].ID)
		assert.Equal(t, "s1", pending[0].SessionID)

		out := store.Respond(methods.ACPApprovalsRespondParams{
			AgentServer:   "poolside",
			SessionID:     "s1",
			Kind:          methods.ACPApprovalKindPermission,
			ID:            "tc-1",
			OptionID:      "opt-1",
			OverrideRules: []string{"tool:allow"},
		})
		assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)

		got := <-done
		require.NoError(t, got.err)
		require.NotNil(t, got.resp.Outcome.Selected)
		assert.Equal(t, acpsdk.PermissionOptionId("opt-1"), got.resp.Outcome.Selected.OptionId)
		assert.Equal(
			t,
			[]string{"tool:allow"},
			got.resp.Outcome.Selected.Meta[acphelpers.MetaKeyPermissionOverrideRules],
		)
		// Resolution pushes the shrunken set so every other surface drops it.
		assert.Empty(t, <-pushed)
	})

	t.Run("returns cancelled when the agent abandons the request", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "poolside", handler: &Handler{approvals: store}}

		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan acpsdk.RequestPermissionResponse, 1)
		go func() {
			resp, _ := c.RequestPermission(ctx, permissionRequestFixture())
			done <- resp
		}()
		require.Len(t, <-pushed, 1)

		cancel()
		resp := <-done
		assert.Equal(t, acpsdk.NewRequestPermissionOutcomeCancelled(), resp.Outcome)
		// Abandonment removes the entry and pushes the empty set.
		assert.Empty(t, <-pushed)
	})

	t.Run("returns cancelled without a configured store", func(t *testing.T) {
		c := &acpClient{}
		resp, err := c.RequestPermission(context.Background(), permissionRequestFixture())
		require.NoError(t, err)
		assert.Equal(t, acpsdk.NewRequestPermissionOutcomeCancelled(), resp.Outcome)
	})
}

func TestHandleExtensionMethodElicitationUsesRequestSessionIDForLiveStatus(t *testing.T) {
	sink := &recordingLiveStatusSink{}
	store := approvals.NewStore()
	pushed := make(chan []methods.ACPApproval, 8)
	store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
	c := &acpClient{
		agentServer: "poolside",
		activeSession: func() acpsdk.SessionId {
			return acpsdk.SessionId("active-session")
		},
		liveStatus: sink,
		handler:    &Handler{approvals: store},
	}

	raw, err := json.Marshal(methods.ACPElicitationParams{
		ElicitationRequest: methods.ElicitationRequest{
			SessionID:       "request-session",
			Mode:            methods.ElicitationMode("form"),
			Message:         "Need input",
			ElicitationID:   "call-1",
			RequestedSchema: json.RawMessage(`{"type":"object"}`),
		},
	})
	require.NoError(t, err)

	type result struct {
		out any
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, handleErr := c.HandleExtensionMethod(context.Background(), acphelpers.ExtensionMethodElicitation, raw)
		done <- result{out, handleErr}
	}()

	// The elicitation is registered as helper-owned state with the request's
	// session id and agent server attached.
	pending := <-pushed
	require.Len(t, pending, 1)
	assert.Equal(t, methods.ACPApprovalKindElicitation, pending[0].Kind)
	assert.Equal(t, "call-1", pending[0].ID)
	assert.Equal(t, "request-session", pending[0].SessionID)
	assert.Equal(t, "poolside", pending[0].AgentServer)

	out := store.Respond(methods.ACPApprovalsRespondParams{
		AgentServer: "poolside",
		SessionID:   "request-session",
		Kind:        methods.ACPApprovalKindElicitation,
		ID:          "call-1",
		Action:      string(methods.ElicitationActionDecline),
	})
	assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)

	got := <-done
	require.NoError(t, got.err)
	elicitationOut, ok := got.out.(methods.ACPElicitationOutput)
	require.True(t, ok)
	assert.Equal(t, methods.ElicitationActionDecline, elicitationOut.Action)
	// Live status marks waiting on the REQUEST session id, then clears it.
	assert.Equal(t, []string{"request-session", "request-session"}, sink.sessionIDs)
}

func TestHandleExtensionMethodElicitationAttributesUntaggedRequestToActiveSession(t *testing.T) {
	store := approvals.NewStore()
	pushed := make(chan []methods.ACPApproval, 8)
	store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
	c := &acpClient{
		agentServer: "poolside",
		activeSession: func() acpsdk.SessionId {
			return acpsdk.SessionId("active-session")
		},
		handler: &Handler{approvals: store},
	}

	raw, err := json.Marshal(methods.ACPElicitationParams{
		ElicitationRequest: methods.ElicitationRequest{
			Mode:          methods.ElicitationMode("form"),
			Message:       "Need input",
			ElicitationID: "call-2",
		},
	})
	require.NoError(t, err)

	done := make(chan error, 1)
	go func() {
		_, handleErr := c.HandleExtensionMethod(context.Background(), acphelpers.ExtensionMethodElicitation, raw)
		done <- handleErr
	}()

	// The stored approval carries the active session id so surfaces can route
	// the prompt to the chat that raised it.
	pending := <-pushed
	require.Len(t, pending, 1)
	assert.Equal(t, "active-session", pending[0].SessionID)
	assert.Equal(t, "poolside", pending[0].AgentServer)

	out := store.Respond(methods.ACPApprovalsRespondParams{
		AgentServer: "poolside",
		SessionID:   "active-session",
		Kind:        methods.ACPApprovalKindElicitation,
		ID:          "call-2",
		Action:      string(methods.ElicitationActionDecline),
	})
	assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)
	require.NoError(t, <-done)
}

func TestUnstableCreateElicitation(t *testing.T) {
	t.Run("form request keeps its session and accepts with content", func(t *testing.T) {
		sink := &recordingLiveStatusSink{}
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{
			agentServer: "claude-acp",
			activeSession: func() acpsdk.SessionId {
				return acpsdk.SessionId("active-session")
			},
			liveStatus: sink,
			handler:    &Handler{approvals: store},
		}

		type result struct {
			resp acpsdk.UnstableCreateElicitationResponse
			err  error
		}
		done := make(chan result, 1)
		go func() {
			resp, err := c.UnstableCreateElicitation(context.Background(), acpsdk.UnstableCreateElicitationRequest{
				Form: &acpsdk.UnstableCreateElicitationForm{
					Mode:      "form",
					Message:   "Pick one",
					SessionId: acpsdk.SessionId("request-session"),
					RequestedSchema: acpsdk.UnstableElicitationSchema{
						Properties: map[string]any{"choice": map[string]any{"type": "string"}},
					},
				},
			})
			done <- result{resp, err}
		}()

		pending := <-pushed
		require.Len(t, pending, 1)
		assert.Equal(t, methods.ACPApprovalKindElicitation, pending[0].Kind)
		// The wire request carries no id in form mode; the helper synthesizes
		// one so the approval store can key the entry.
		require.NotEmpty(t, pending[0].ID)
		assert.Equal(t, "request-session", pending[0].SessionID)
		require.NotNil(t, pending[0].Elicitation)
		assert.Equal(t, pending[0].ID, pending[0].Elicitation.ElicitationID)
		assert.Equal(t, methods.ElicitationMode("form"), pending[0].Elicitation.Mode)
		assert.JSONEq(
			t,
			`{"properties":{"choice":{"type":"string"}}}`,
			string(pending[0].Elicitation.RequestedSchema),
		)

		out := store.Respond(methods.ACPApprovalsRespondParams{
			AgentServer: "claude-acp",
			SessionID:   "request-session",
			Kind:        methods.ACPApprovalKindElicitation,
			ID:          pending[0].ID,
			Action:      string(methods.ElicitationActionAccept),
			Content:     map[string]any{"choice": "a"},
		})
		assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)

		got := <-done
		require.NoError(t, got.err)
		require.NotNil(t, got.resp.Accept)
		assert.Equal(t, map[string]any{"choice": "a"}, got.resp.Accept.Content)
		assert.Equal(t, []string{"request-session", "request-session"}, sink.sessionIDs)
	})

	t.Run("preserves the wire schema's property order", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "codex-acp", handler: &Handler{approvals: store}}

		// Codex keys form fields by arbitrary question ids and relies on
		// property order for question order; a map round-trip would sort it.
		wireSchema := `{"type":"object","properties":{"topic":{"type":"string"},"animal":{"type":"string"},"persist":{"type":"string"}},"required":["topic"]}`
		var req acpsdk.UnstableCreateElicitationRequest
		require.NoError(t, json.Unmarshal(
			[]byte(`{"mode":"form","sessionId":"s1","message":"Input requested","requestedSchema":`+wireSchema+`}`),
			&req,
		))

		go func() {
			_, _ = c.UnstableCreateElicitation(context.Background(), req)
		}()

		pending := <-pushed
		require.Len(t, pending, 1)
		require.NotNil(t, pending[0].Elicitation)
		assert.Equal(t, wireSchema, string(pending[0].Elicitation.RequestedSchema))

		store.CancelSession("codex-acp", "s1")
	})

	t.Run("url request declines with the wire elicitation id", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "claude-acp", handler: &Handler{approvals: store}}

		done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
		go func() {
			resp, _ := c.UnstableCreateElicitation(context.Background(), acpsdk.UnstableCreateElicitationRequest{
				Url: &acpsdk.UnstableCreateElicitationUrl{
					Mode:          "url",
					Message:       "Sign in",
					ElicitationId: acpsdk.UnstableElicitationId("el-1"),
					Url:           "https://example.com/auth",
					SessionId:     acpsdk.SessionId("request-session"),
				},
			})
			done <- resp
		}()

		pending := <-pushed
		require.Len(t, pending, 1)
		assert.Equal(t, "el-1", pending[0].ID)
		require.NotNil(t, pending[0].Elicitation)
		assert.Equal(t, "https://example.com/auth", pending[0].Elicitation.URL)

		out := store.Respond(methods.ACPApprovalsRespondParams{
			AgentServer: "claude-acp",
			SessionID:   "request-session",
			Kind:        methods.ACPApprovalKindElicitation,
			ID:          "el-1",
			Action:      string(methods.ElicitationActionDecline),
		})
		assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)
		assert.NotNil(t, (<-done).Decline)
	})

	t.Run("cancels when the agent abandons the request", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "claude-acp", handler: &Handler{approvals: store}}

		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
		go func() {
			resp, _ := c.UnstableCreateElicitation(ctx, acpsdk.UnstableCreateElicitationRequest{
				Form: &acpsdk.UnstableCreateElicitationForm{Mode: "form", Message: "Pick one"},
			})
			done <- resp
		}()
		require.Len(t, <-pushed, 1)

		cancel()
		assert.NotNil(t, (<-done).Cancel)
		assert.Empty(t, <-pushed)
	})

	t.Run("rejects a request without a variant", func(t *testing.T) {
		c := &acpClient{handler: &Handler{approvals: approvals.NewStore()}}
		_, err := c.UnstableCreateElicitation(context.Background(), acpsdk.UnstableCreateElicitationRequest{})
		require.Error(t, err)
	})
}

func TestUnstableCompleteElicitation(t *testing.T) {
	t.Run("accepts the pending url elicitation", func(t *testing.T) {
		store := approvals.NewStore()
		pushed := make(chan []methods.ACPApproval, 8)
		store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
		c := &acpClient{agentServer: "claude-acp", handler: &Handler{approvals: store}}

		done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
		go func() {
			resp, _ := c.UnstableCreateElicitation(context.Background(), acpsdk.UnstableCreateElicitationRequest{
				Url: &acpsdk.UnstableCreateElicitationUrl{
					Mode:          "url",
					Message:       "Sign in",
					ElicitationId: acpsdk.UnstableElicitationId("el-2"),
					Url:           "https://example.com/auth",
					SessionId:     acpsdk.SessionId("request-session"),
				},
			})
			done <- resp
		}()
		require.Len(t, <-pushed, 1)

		require.NoError(t, c.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
			ElicitationId: acpsdk.UnstableElicitationId("el-2"),
		}))

		// The out-of-band completion unblocks the create request as accepted
		// and drops the prompt from every surface.
		assert.NotNil(t, (<-done).Accept)
		assert.Empty(t, <-pushed)
	})

	t.Run("ignores an unknown elicitation id", func(t *testing.T) {
		c := &acpClient{agentServer: "claude-acp", handler: &Handler{approvals: approvals.NewStore()}}
		require.NoError(t, c.UnstableCompleteElicitation(context.Background(), acpsdk.UnstableCompleteElicitationNotification{
			ElicitationId: acpsdk.UnstableElicitationId("missing"),
		}))
	})
}

func TestReadTextFile(t *testing.T) {
	t.Run("rejects relative path", func(t *testing.T) {
		c := &acpClient{}
		_, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{Path: "relative/path.txt"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "path must be absolute")
	})

	t.Run("returns full file content", func(t *testing.T) {
		content := "line1\nline2\nline3"
		c := &acpClient{
			readFile: func(_ context.Context, uri protocol.DocumentURI) ([]byte, error) {
				return []byte(content), nil
			},
		}

		resp, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{Path: "/tmp/test.txt"})
		require.NoError(t, err)
		assert.Equal(t, content, resp.Content)
	})

	t.Run("rejects oversized full file content", func(t *testing.T) {
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return make([]byte, maxReadTextFileResponseBytes+1), nil
			},
		}

		_, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{Path: "/tmp/large.txt"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "file is too large to read without a line range")
	})

	t.Run("returns error when readFile fails", func(t *testing.T) {
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return nil, fmt.Errorf("not found")
			},
		}

		_, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{Path: "/tmp/missing.txt"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not found")
	})

	t.Run("slices by line and limit", func(t *testing.T) {
		content := "a\nb\nc\nd\ne"
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return []byte(content), nil
			},
		}

		line := 2
		limit := 2
		resp, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{
			Path:  "/tmp/test.txt",
			Line:  &line,
			Limit: &limit,
		})
		require.NoError(t, err)
		assert.Equal(t, "b\nc", resp.Content)
	})

	t.Run("blank requested line returns empty content", func(t *testing.T) {
		content := "a\n\nc"
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return []byte(content), nil
			},
		}

		line := 2
		limit := 1
		resp, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{
			Path:  "/tmp/test.txt",
			Line:  &line,
			Limit: &limit,
		})
		require.NoError(t, err)
		assert.Equal(t, "", resp.Content)
	})

	t.Run("line beyond content returns error", func(t *testing.T) {
		content := "a\nb"
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return []byte(content), nil
			},
		}

		line := 100
		_, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{
			Path: "/tmp/test.txt",
			Line: &line,
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "line is out of range")
	})

	t.Run("limit only without line starts from beginning", func(t *testing.T) {
		content := "a\nb\nc\nd"
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return []byte(content), nil
			},
		}

		limit := 2
		resp, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{
			Path:  "/tmp/test.txt",
			Limit: &limit,
		})
		require.NoError(t, err)
		assert.Equal(t, "a\nb", resp.Content)
	})

	t.Run("rejects oversized ranged response", func(t *testing.T) {
		c := &acpClient{
			readFile: func(_ context.Context, _ protocol.DocumentURI) ([]byte, error) {
				return append(make([]byte, maxReadTextFileResponseBytes+1), '\n'), nil
			},
		}

		line := 1
		limit := 1
		_, err := c.ReadTextFile(context.Background(), acpsdk.ReadTextFileRequest{
			Path:  "/tmp/large.txt",
			Line:  &line,
			Limit: &limit,
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "read_text_file response is too large")
	})
}

type recordingLiveStatusSink struct {
	sessionIDs []string
	titles     []recordedTitle
}

type recordedTitle struct {
	agentServer string
	sessionID   string
	title       string
}

func (s *recordingLiveStatusSink) SetConversationLiveStatus(_ context.Context, _ *glsp.Context, _ string, sessionID string, _ acpnav.ConversationLiveStatusPatch) error {
	s.sessionIDs = append(s.sessionIDs, sessionID)
	return nil
}

func (s *recordingLiveStatusSink) CompletePrompt(context.Context, *glsp.Context, string, string) error {
	return nil
}

func (s *recordingLiveStatusSink) ClearAgentServerInFlightStatus(context.Context, *glsp.Context, string) error {
	return nil
}

func (s *recordingLiveStatusSink) UpdateConversationTitle(_ context.Context, _ *glsp.Context, agentServer, sessionID, title string) error {
	s.titles = append(s.titles, recordedTitle{agentServer: agentServer, sessionID: sessionID, title: title})
	return nil
}

func (s *recordingLiveStatusSink) BindConversationSession(context.Context, *glsp.Context, string, string, string, string) error {
	return nil
}

func TestWriteTextFile(t *testing.T) {
	t.Run("rejects relative path", func(t *testing.T) {
		c := &acpClient{}
		_, err := c.WriteTextFile(context.Background(), acpsdk.WriteTextFileRequest{
			Path:    "relative/path.txt",
			Content: "hello",
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "path must be absolute")
	})

	t.Run("writes file content", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "out.txt")

		c := &acpClient{}
		_, err := c.WriteTextFile(context.Background(), acpsdk.WriteTextFileRequest{
			Path:    path,
			Content: "hello world",
		})
		require.NoError(t, err)

		got, err := os.ReadFile(path)
		require.NoError(t, err)
		assert.Equal(t, "hello world", string(got))
	})

	t.Run("creates intermediate directories", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "sub", "deep", "file.txt")

		c := &acpClient{}
		_, err := c.WriteTextFile(context.Background(), acpsdk.WriteTextFileRequest{
			Path:    path,
			Content: "nested",
		})
		require.NoError(t, err)

		got, err := os.ReadFile(path)
		require.NoError(t, err)
		assert.Equal(t, "nested", string(got))
	})
}
