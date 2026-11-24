package acpnav

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
)

func TestCreateChatCreatesSessionDirectoryInCamberState(t *testing.T) {
	setTestStateHome(t)
	server := NewServer()

	output, err := server.CreateChat(context.Background(), &methods.ACPNavCreateChatParams{
		SessionID: "conversation:session-123",
	}, nil)

	require.NoError(t, err)
	require.Len(t, filepath.Base(output.Path), 64)
	require.Equal(t, chatStorageDirectoryName, filepath.Base(filepath.Dir(output.Path)))
	require.Equal(t, "poolside", filepath.Base(filepath.Dir(filepath.Dir(output.Path))))
	info, err := os.Stat(output.Path)
	require.NoError(t, err)
	require.True(t, info.IsDir())
}

func TestCreateChatUsesDistinctIsolatedPaths(t *testing.T) {
	setTestStateHome(t)
	server := NewServer()
	ctx := context.Background()

	plain, err := server.CreateChat(ctx, &methods.ACPNavCreateChatParams{SessionID: "foo"}, nil)
	require.NoError(t, err)
	prefixed, err := server.CreateChat(ctx, &methods.ACPNavCreateChatParams{SessionID: "conversation:foo"}, nil)
	require.NoError(t, err)
	reserved, err := server.CreateChat(ctx, &methods.ACPNavCreateChatParams{SessionID: "conversation:logs"}, nil)
	require.NoError(t, err)

	require.NotEqual(t, plain.Path, prefixed.Path)
	require.Equal(t, filepath.Join(userconfig.StateDirectory(), chatStorageDirectoryName), filepath.Dir(reserved.Path))
	require.NotEqual(t, filepath.Join(userconfig.StateDirectory(), "logs"), reserved.Path)
}

func TestCreateChatRejectsEmptySessionID(t *testing.T) {
	_, err := NewServer().CreateChat(context.Background(), &methods.ACPNavCreateChatParams{}, nil)
	require.ErrorContains(t, err, "sessionId is required")
}

func TestDeleteConversationDeletesOnlyChatWorkingDirectory(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	server := newTestServer(t, ctx)

	logsPath := filepath.Join(userconfig.StateDirectory(), "logs")
	require.NoError(t, os.MkdirAll(logsPath, 0o700))
	logFile := filepath.Join(logsPath, "keep.log")
	require.NoError(t, os.WriteFile(logFile, []byte("important log"), 0o600))

	const chatID = "conversation:logs"
	chat, err := server.CreateChat(ctx, &methods.ACPNavCreateChatParams{SessionID: chatID}, nil)
	require.NoError(t, err)
	require.NotEqual(t, logsPath, chat.Path)
	chatFile := filepath.Join(chat.Path, "draft.txt")
	require.NoError(t, os.WriteFile(chatFile, []byte("chat draft"), 0o600))
	require.NoError(t, server.store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            chatID,
		WorkspacePath: chatWorkspacePath,
		AgentServer:   "poolside",
		SessionID:     "chat-session",
		Cwd:           chat.Path,
		Title:         "Standalone chat",
	}))

	projectCwd := t.TempDir()
	projectFile := filepath.Join(projectCwd, "keep.txt")
	require.NoError(t, os.WriteFile(projectFile, []byte("project file"), 0o600))
	const projectID = "conversation:project-to-delete"
	require.NoError(t, server.store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            projectID,
		WorkspacePath: projectCwd,
		AgentServer:   "poolside",
		SessionID:     "project-session",
		Cwd:           projectCwd,
		Title:         "Project conversation",
	}))

	_, err = server.DeleteConversation(ctx, &methods.ACPNavDeleteConversationParams{
		ConversationID: chatID,
	}, nil)
	require.NoError(t, err)
	require.NoDirExists(t, chat.Path)
	require.FileExists(t, logFile)

	_, err = server.DeleteConversation(ctx, &methods.ACPNavDeleteConversationParams{
		ConversationID: projectID,
	}, nil)
	require.NoError(t, err)
	require.DirExists(t, projectCwd)
	require.FileExists(t, projectFile)
}

func TestServerLiveStatusOverlayAndViewState(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")

	require.NoError(t, server.SetConversationLiveStatus(ctx, nil, "poolside", "s-1", ConversationLiveStatusPatch{
		Working: Bool(true),
	}))

	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.NotNil(t, state.Conversations[0].LiveStatus)
	require.True(t, state.Conversations[0].LiveStatus.Working)

	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	state, err = server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Conversations[0].LiveStatus)
	require.False(t, state.Conversations[0].LiveStatus.Working)
	require.True(t, state.Conversations[0].LiveStatus.Unread)

	state, err = server.SetConversationViewState(ctx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside",
		SessionID:   "s-1",
		Active:      true,
	}, nil)
	require.NoError(t, err)
	require.Nil(t, state.Conversations[0].LiveStatus)
}

func TestViewStateClearsDescendantUnread(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	for _, id := range []string{"parent", "child", "grandchild", "waiting", "other"} {
		upsertTestConversation(t, ctx, server, "poolside", id)
	}
	for id, parent := range map[string]string{"child": "parent", "grandchild": "child", "waiting": "parent"} {
		require.NoError(t, server.WriteControlState(ctx, "conversation/conversation:"+id, map[string]string{"parentId": "conversation:" + parent}))
	}
	// A cycle back to the parent must not hang the walk.
	require.NoError(t, server.WriteControlState(ctx, "conversation/conversation:parent", map[string]string{"parentId": "conversation:grandchild"}))
	for _, id := range []string{"child", "grandchild", "waiting", "other"} {
		require.NoError(t, server.SetConversationLiveStatus(ctx, nil, "poolside", id, ConversationLiveStatusPatch{Unread: Bool(true)}))
	}
	require.NoError(t, server.SetConversationLiveStatus(ctx, nil, "poolside", "waiting", ConversationLiveStatusPatch{WaitingForUser: Bool(true)}))

	_, err := server.SetConversationViewState(ctx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "parent", Active: true,
	}, nil)
	require.NoError(t, err)

	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	byID := map[string]methods.ACPNavConversation{}
	for _, c := range state.Conversations {
		byID[c.SessionID] = c
	}
	assert.Nil(t, byID["child"].LiveStatus)
	assert.Nil(t, byID["grandchild"].LiveStatus)
	require.NotNil(t, byID["waiting"].LiveStatus)
	assert.True(t, byID["waiting"].LiveStatus.Unread)
	assert.True(t, byID["waiting"].LiveStatus.WaitingForUser)
	require.NotNil(t, byID["other"].LiveStatus)
	assert.True(t, byID["other"].LiveStatus.Unread)

	// A child completing while the parent stays open still goes unread.
	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "child"))
	state, err = server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	for _, c := range state.Conversations {
		if c.SessionID == "child" {
			require.NotNil(t, c.LiveStatus)
			assert.True(t, c.LiveStatus.Unread)
		}
	}
}

func TestServerLiveStatusIsNotPersisted(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	server := NewServer()
	server.SetStore(store)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")
	require.NoError(t, server.SetConversationLiveStatus(ctx, nil, "poolside", "s-1", ConversationLiveStatusPatch{
		Working: Bool(true),
	}))

	restarted := NewServer()
	restarted.SetStore(store)
	state, err := restarted.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Nil(t, state.Conversations[0].LiveStatus)
}

func TestClearAgentServerInFlightStatusPreservesUnread(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")

	require.NoError(t, server.SetConversationLiveStatus(ctx, nil, "poolside", "s-1", ConversationLiveStatusPatch{
		Working:        Bool(true),
		WaitingForUser: Bool(true),
		Unread:         Bool(true),
	}))
	require.NoError(t, server.ClearAgentServerInFlightStatus(ctx, nil, "poolside"))

	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.NotNil(t, state.Conversations[0].LiveStatus)
	require.False(t, state.Conversations[0].LiveStatus.Working)
	require.False(t, state.Conversations[0].LiveStatus.WaitingForUser)
	require.True(t, state.Conversations[0].LiveStatus.Unread)
}

func TestViewStateIsTrackedPerClientOrigin(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")

	desktopCtx := methods.WithClientOrigin(ctx, methods.PrimaryClientOrigin)
	phoneCtx := methods.WithClientOrigin(ctx, "remote:device-1/conn-1")

	// Both surfaces view the conversation, then the phone navigates away:
	// the desktop still watches, so a completing turn is not unread.
	_, err := server.SetConversationViewState(desktopCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: true,
	}, nil)
	require.NoError(t, err)
	_, err = server.SetConversationViewState(phoneCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: true,
	}, nil)
	require.NoError(t, err)
	_, err = server.SetConversationViewState(phoneCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: false,
	}, nil)
	require.NoError(t, err)

	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Nil(t, state.Conversations[0].LiveStatus)

	// The desktop stops watching too: now a completing turn goes unread.
	_, err = server.SetConversationViewState(desktopCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: false,
	}, nil)
	require.NoError(t, err)
	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	state, err = server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Conversations[0].LiveStatus)
	require.True(t, state.Conversations[0].LiveStatus.Unread)
}

func TestClearClientViewStateStopsSuppressingUnread(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")

	phoneCtx := methods.WithClientOrigin(ctx, "remote:device-1/conn-1")
	_, err := server.SetConversationViewState(phoneCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: true,
	}, nil)
	require.NoError(t, err)

	// While the phone watches, completing a turn stays read.
	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Nil(t, state.Conversations[0].LiveStatus)

	// The phone's socket drops without an inactive report.
	server.ClearClientViewState("remote:device-1/conn-1")
	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	state, err = server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Conversations[0].LiveStatus)
	require.True(t, state.Conversations[0].LiveStatus.Unread)
}

func TestViewStateResetDropsEarlierEntries(t *testing.T) {
	ctx := context.Background()
	server := newTestServer(t, ctx)
	upsertTestConversation(t, ctx, server, "poolside", "s-1")
	upsertTestConversation(t, ctx, server, "poolside", "s-2")

	desktopCtx := methods.WithClientOrigin(ctx, methods.PrimaryClientOrigin)
	_, err := server.SetConversationViewState(desktopCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-1", Active: true,
	}, nil)
	require.NoError(t, err)

	// The webview reloads: its first report resets and re-registers only s-2.
	_, err = server.SetConversationViewState(desktopCtx, &methods.ACPNavSetConversationViewStateParams{
		AgentServer: "poolside", SessionID: "s-2", Active: true, Reset: true,
	}, nil)
	require.NoError(t, err)

	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-1"))
	require.NoError(t, server.CompletePrompt(ctx, nil, "poolside", "s-2"))
	state, err := server.List(ctx, &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 2)
	for _, conversation := range state.Conversations {
		switch conversation.SessionID {
		case "s-1":
			require.NotNil(t, conversation.LiveStatus)
			require.True(t, conversation.LiveStatus.Unread)
		case "s-2":
			require.Nil(t, conversation.LiveStatus)
		}
	}
}

func newTestServer(t *testing.T, ctx context.Context) *Server {
	t.Helper()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	server := NewServer()
	server.SetStore(store)
	return server
}

func upsertTestConversation(
	t *testing.T,
	ctx context.Context,
	server *Server,
	agentServer string,
	sessionID string,
) {
	t.Helper()
	_, err := server.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{
		Conversation: methods.ACPNavConversation{
			ID:            "conversation:" + sessionID,
			WorkspacePath: "/repo",
			AgentServer:   agentServer,
			SessionID:     sessionID,
			Cwd:           "/repo",
			Title:         "Build nav",
		},
	}, nil)
	require.NoError(t, err)
}
