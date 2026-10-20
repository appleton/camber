package control

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"
)

func TestRemovalProtectsNestedAndAliasedConversationPaths(t *testing.T) {
	for _, field := range []string{"workspace", "cwd", "workingDirectory", "alias"} {
		t.Run(field, func(t *testing.T) {
			s, _ := fixture(t)
			root := t.TempDir()
			nested := filepath.Join(root, "src")
			require.NoError(t, os.Mkdir(nested, 0700))
			parent := filepath.Dir(root)
			project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: parent}, nil)
			require.NoError(t, err)
			parent = project.Path
			_, err = s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: root, IsWorktree: true, ParentPath: &parent}, nil)
			require.NoError(t, err)
			c := methods.ACPNavConversation{ID: "nested", AgentServer: "test", WorkspacePath: t.TempDir()}
			switch field {
			case "workspace":
				c.WorkspacePath = nested
			case "cwd":
				c.Cwd = nested
			case "workingDirectory":
				c.WorkingDirectories = []string{nested}
			case "alias":
				alias := filepath.Join(t.TempDir(), "alias")
				require.NoError(t, os.Symlink(root, alias))
				c.WorkspacePath = filepath.Join(alias, "src")
			}
			_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: c}, nil)
			require.NoError(t, err)
			require.NoError(t, s.save(context.Background(), View{ACPNavConversation: c, Record: Record{Status: "running"}}))
			_, err = s.removeWorktree(context.Background(), Args{WorkspacePath: root}, nil)
			require.ErrorContains(t, err, "preparing or running")
			assert.DirExists(t, nested)
		})
	}
	assert.False(t, conversationUsesWorktree(methods.ACPNavConversation{WorkspacePath: "/work/tree-other"}, "/work/tree"))
}

type preparingAgent struct {
	*fakeAgent
	entered chan struct{}
	release chan struct{}
}

func (f *preparingAgent) NewSession(ctx context.Context, _ *methods.ACPNewSessionParams, _ *glsp.Context) (*methods.ACPNewSessionOutput, error) {
	close(f.entered)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-f.release:
		return nil, errors.New("preparation stopped")
	}
}
func (f *preparingAgent) Cancel(context.Context, *methods.ACPCancelParams, *glsp.Context) (*methods.ACPCancelOutput, error) {
	return &methods.ACPCancelOutput{}, nil
}
func TestUnrelatedStopRemainsAvailableDuringPreparation(t *testing.T) {
	s, base := fixture(t)
	agent := &preparingAgent{fakeAgent: base, entered: make(chan struct{}), release: make(chan struct{})}
	s.agent = agent
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, _ = s.spawn(context.Background(), Args{ParentID: "parent", Text: "prepare", RequestID: "blocked"}, nil)
	}()
	defer func() { close(agent.release); <-finished }()
	select {
	case <-agent.entered:
	case <-time.After(time.Second):
		require.FailNow(t, "preparation did not start")
	}
	done := make(chan error, 1)
	go func() { _, err := s.stop(context.Background(), Args{ConversationID: "parent"}, nil); done <- err }()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		require.FailNow(t, "unrelated stop blocked behind preparation")
	}
}
func TestConversationLockWaitIsCancellable(t *testing.T) {
	s, _ := fixture(t)
	release, err := s.lockConversation(context.Background(), "a")
	require.NoError(t, err)
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = s.lockConversation(ctx, "a")
	require.ErrorIs(t, err, context.DeadlineExceeded)
	other, err := s.lockConversation(context.Background(), "b")
	require.NoError(t, err)
	other()
}

type observedAgent struct {
	*fakeAgent
	turn methods.ControlObservedTurn
}

func (f *observedAgent) CurrentTurn(string, string) (string, string, bool) {
	return "ui-b", "running", true
}
func (f *observedAgent) ObserveTurn(_ context.Context, _, _, id string) (methods.ControlObservedTurn, bool, error) {
	return f.turn, id == f.turn.TurnID, nil
}
func TestPollDrainsRetainedUITurnAfterNextTurnStarts(t *testing.T) {
	s, base := fixture(t)
	_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "ui", AgentServer: "test", SessionID: "session", WorkspacePath: t.TempDir()}}, nil)
	require.NoError(t, err)
	publish := func(text string) {
		s.log.Publish("test", "session", "", false, map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}}}})
	}
	publish("turn A")
	publish("turn B")
	s.log.BeginTurn("test", "session")
	s.agent = &observedAgent{fakeAgent: base, turn: methods.ControlObservedTurn{TurnID: "ui-a", Status: "completed", Epoch: s.log.ProcessEpoch(), StartSeq: 0, EndSeq: 1, Finished: true, Result: &methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}}}
	out := invoke(t, s, "chat.output", Args{ConversationID: "ui", TurnID: "ui-a"})
	assert.Equal(t, "turn A", out["text"])
	assert.Equal(t, true, out["complete"])
	assert.Equal(t, "completed", out["status"])
	page := invoke(t, s, "chat.poll", Args{ConversationID: "ui", TurnID: "ui-a", Cursor: out["nextCursor"].(string)})
	assert.Empty(t, page["events"])
	assert.Equal(t, true, page["terminal"])
}
