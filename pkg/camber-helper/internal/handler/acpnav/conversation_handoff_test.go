package acpnav

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestConversationHandoffPersistsCommittedSourceLeg(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
		Title:         "Durable handoff",
	}))

	require.NoError(t, store.PrepareConversationHandoff(ctx, methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-1",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[{"eventKind":"user_message","content":[{"type":"text","text":"hello"}]}]`),
		Turns:             json.RawMessage(`[{"startedAt":"2026-07-16T10:00:00Z","endedAt":"2026-07-16T10:01:00Z","startIndex":0,"endIndex":0}]`),
		Plan:              json.RawMessage(`null`),
		CreatedAt:         "2026-07-16T10:02:00Z",
	}))

	pending, err := store.ConversationHistory(ctx, "conversation-1")
	require.NoError(t, err)
	assert.Empty(t, pending.Legs, "pending handoffs must not appear on reload")

	require.NoError(t, store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"target-session",
		"/repo",
		"handoff-1",
	))

	history, err := store.ConversationHistory(ctx, "conversation-1")
	require.NoError(t, err)
	require.Len(t, history.Legs, 1)
	leg := history.Legs[0]
	assert.Equal(t, "handoff-1", leg.HandoffID)
	assert.Equal(t, 0, leg.Ordinal)
	assert.Equal(t, "poolside", leg.AgentServer)
	assert.Equal(t, "source-session", leg.SessionID)
	assert.Equal(t, "codex-acp", leg.TargetAgentServer)
	assert.Equal(t, "target-session", leg.TargetSessionID)
	assert.Equal(t, 1, leg.SchemaVersion)
	assert.JSONEq(t, `[{"eventKind":"user_message","content":[{"type":"text","text":"hello"}]}]`, string(leg.Events))
	assert.JSONEq(t, `[{"startedAt":"2026-07-16T10:00:00Z","endedAt":"2026-07-16T10:01:00Z","startIndex":0,"endIndex":0}]`, string(leg.Turns))
	assert.JSONEq(t, `null`, string(leg.Plan))

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "codex-acp", conversations[0].AgentServer)
	assert.Equal(t, "target-session", conversations[0].SessionID)
	assert.Equal(t, "Durable handoff", conversations[0].Title)

	require.NoError(t, store.DeleteConversationByID(ctx, "conversation-1"))
	history, err = store.ConversationHistory(ctx, "conversation-1")
	require.NoError(t, err)
	assert.Empty(t, history.Legs)
}

func TestConversationHandoffAbortKeepsSourceBinding(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
	}))
	require.NoError(t, store.PrepareConversationHandoff(ctx, methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-abort",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
	}))

	require.NoError(t, store.AbortConversationHandoff(ctx, "handoff-abort"))
	err := store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"target-session",
		"/repo",
		"handoff-abort",
	)
	require.ErrorContains(t, err, "not found")

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "poolside", conversations[0].AgentServer)
	assert.Equal(t, "source-session", conversations[0].SessionID)
}

func TestConversationHandoffRetriesAreIdempotent(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
	}))
	params := methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-retry",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
		CreatedAt:         "2026-07-16T10:02:00Z",
	}

	// A dropped prepare response resends the same handoff id while it is pending.
	require.NoError(t, store.PrepareConversationHandoff(ctx, params))
	require.NoError(t, store.PrepareConversationHandoff(ctx, params))
	require.NoError(t, store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"target-session-1",
		"/repo",
		"handoff-retry",
	))

	// session/new commits before returning. A lost response retries both prepare
	// and bind with the same handoff id and may produce a replacement session.
	require.NoError(t, store.PrepareConversationHandoff(ctx, params))
	require.NoError(t, store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"target-session-2",
		"/repo",
		"handoff-retry",
	))

	history, err := store.ConversationHistory(ctx, "conversation-1")
	require.NoError(t, err)
	require.Len(t, history.Legs, 1)
	assert.Equal(t, "target-session-2", history.Legs[0].TargetSessionID)

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "codex-acp", conversations[0].AgentServer)
	assert.Equal(t, "target-session-2", conversations[0].SessionID)
}

func TestConversationHandoffRetryRejectsReusedIDForDifferentHandoff(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
	}))
	params := methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-collision",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
	}
	require.NoError(t, store.PrepareConversationHandoff(ctx, params))

	params.TargetAgentServer = "claude-acp"
	err := store.PrepareConversationHandoff(ctx, params)
	require.ErrorContains(t, err, "already used by a different conversation handoff")
}

func TestConversationHandoffRetryDoesNotOverwriteNewerBinding(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
	}))
	params := methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-old",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
	}
	require.NoError(t, store.PrepareConversationHandoff(ctx, params))
	require.NoError(t, store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"target-session",
		"/repo",
		"handoff-old",
	))
	require.NoError(t, store.BindConversationSession(
		ctx,
		"conversation-1",
		"claude-acp",
		"newer-session",
		"/repo",
	))

	err := store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"retry-session",
		"/repo",
		"handoff-old",
	)
	require.ErrorContains(t, err, "conversation changed after the handoff was committed")

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "claude-acp", conversations[0].AgentServer)
	assert.Equal(t, "newer-session", conversations[0].SessionID)
}

func TestConversationHandoffIgnoresStaleClientBindingUpsert(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
		Title:         "Before handoff",
	}))
	require.NoError(t, store.PrepareConversationHandoff(ctx, methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-1",
		ConversationID:    "conversation-1",
		SourceAgentServer: "poolside",
		SourceSessionID:   "source-session",
		TargetAgentServer: "codex-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
	}))
	require.NoError(t, store.BindConversationSessionHandoff(
		ctx,
		"conversation-1",
		"codex-acp",
		"codex-session",
		"/repo",
		"handoff-1",
	))

	// A delayed title/metadata write from the source webview must enrich the
	// conversation without restoring the source binding over the helper-owned
	// handoff commit.
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conversation-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "source-session",
		Cwd:           "/repo",
		Title:         "Updated after handoff",
		Metadata:      json.RawMessage(`{"source":"late-client"}`),
	}))

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "codex-acp", conversations[0].AgentServer)
	assert.Equal(t, "codex-session", conversations[0].SessionID)
	assert.Equal(t, "Updated after handoff", conversations[0].Title)
	assert.JSONEq(t, `{"source":"late-client"}`, string(conversations[0].Metadata))

	// Recovery may hand off again from the target session. This is the path
	// that failed when the stale upsert above restored the source binding.
	require.NoError(t, store.PrepareConversationHandoff(ctx, methods.ACPNavPrepareConversationHandoffParams{
		HandoffID:         "handoff-2",
		ConversationID:    "conversation-1",
		SourceAgentServer: "codex-acp",
		SourceSessionID:   "codex-session",
		TargetAgentServer: "claude-acp",
		Events:            json.RawMessage(`[]`),
		Turns:             json.RawMessage(`[]`),
		Plan:              json.RawMessage(`null`),
	}))
}
