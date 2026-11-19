package appcontrol

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestArchiveConversationClosesSessionAndCascades(t *testing.T) {
	ctx := context.Background()
	nav := navFixture(t, "p", "c", "other")
	link(t, nav, "c", "p")
	agent := &recordingAgent{}
	s := New(nav, agent)

	out, err := s.ArchiveConversation(ctx, &methods.AppArchiveConversationParams{WorkspacePath: "/ws", ConversationID: "p", AgentServer: "agent", SessionID: "s-p"}, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"p"}, out.Archived)
	assert.Equal(t, []string{"c"}, out.Descendants)
	assert.Equal(t, map[string]bool{"p": true, "c": true, "other": false}, archived(t, nav))
	require.Len(t, agent.closed, 1)
	assert.Equal(t, "s-p", string(agent.closed[0].SessionId))
	assert.True(t, agent.closed[0].CancelInFlight, "archiving cancels a running turn")
}

func TestArchiveConversationIgnoresCloseFailure(t *testing.T) {
	nav := navFixture(t, "p")
	s := New(nav, &recordingAgent{closeErr: errors.New("busy")})
	_, err := s.ArchiveConversation(context.Background(), &methods.AppArchiveConversationParams{ConversationID: "p", AgentServer: "agent", SessionID: "s-p"}, nil)
	require.NoError(t, err)
	assert.True(t, archived(t, nav)["p"])
}

func TestRenameConversationRenamesSessionOnlyWhenSupported(t *testing.T) {
	ctx := context.Background()
	nav := navFixture(t, "p")

	plain := &recordingAgent{caps: acpproxy.SessionManagementCapabilities{Known: true}}
	state, err := New(nav, plain).RenameConversation(ctx, &methods.AppRenameConversationParams{ConversationID: "p", Name: "  Plain  "}, nil)
	require.NoError(t, err)
	row := conversation(t, state, "p")
	assert.Equal(t, "Plain", row.Nickname)
	assert.Equal(t, "title-p", row.Title, "without session rename the title stays")
	assert.Empty(t, plain.waitRenamed(t, false))

	renaming := &recordingAgent{caps: acpproxy.SessionManagementCapabilities{Known: true, Rename: true}, renamed: make(chan *methods.ACPRenameSessionParams, 1)}
	state, err = New(nav, renaming).RenameConversation(ctx, &methods.AppRenameConversationParams{ConversationID: "p", Name: "Renamed"}, nil)
	require.NoError(t, err)
	row = conversation(t, state, "p")
	assert.Equal(t, "Renamed", row.Nickname)
	assert.Equal(t, "Renamed", row.Title)
	renamed := renaming.waitRenamed(t, true)
	require.Len(t, renamed, 1)
	assert.Equal(t, "s-p", string(renamed[0].SessionID))
	assert.Equal(t, "Renamed", renamed[0].Title)

	_, err = New(nav, plain).RenameConversation(ctx, &methods.AppRenameConversationParams{ConversationID: "p", Name: "  "}, nil)
	assert.Error(t, err)
}

func TestDeleteConversationRemovesRowAndSession(t *testing.T) {
	ctx := context.Background()
	nav := navFixture(t, "p", "q")
	agent := &recordingAgent{}
	s := New(nav, agent)

	_, err := s.DeleteConversation(ctx, &methods.AppDeleteConversationParams{ConversationID: "p", CancelInFlight: true}, nil)
	require.NoError(t, err)
	_, present := archived(t, nav)["p"]
	assert.False(t, present)
	require.Len(t, agent.deleted, 1)
	assert.Equal(t, "s-p", string(agent.deleted[0].SessionId))
	assert.Equal(t, []string{"s-p"}, agent.cancelled)

	_, err = s.DeleteConversation(ctx, &methods.AppDeleteConversationParams{ConversationID: "q", AgentServer: "agent", SessionID: "explicit"}, nil)
	require.NoError(t, err)
	require.Len(t, agent.deleted, 2)
	assert.Equal(t, "explicit", string(agent.deleted[1].SessionId))
	assert.Equal(t, []string{"s-p"}, agent.cancelled, "no cancel unless requested")
}

func TestDeleteConversationDropsControlRecord(t *testing.T) {
	ctx := context.Background()
	nav := navFixture(t, "p", "c")
	link(t, nav, "c", "p")
	// Warm the parent-link cache so the delete must keep it coherent.
	require.Equal(t, "p", conversation(t, listState(t, nav), "c").ParentID)

	_, err := New(nav, &recordingAgent{}).DeleteConversation(ctx, &methods.AppDeleteConversationParams{ConversationID: "c"}, nil)
	require.NoError(t, err)

	var stored map[string]string
	require.NoError(t, nav.ReadControlState(ctx, "conversation/c", &stored))
	assert.Nil(t, stored, "the control record is deleted with the conversation")

	// A conversation that reuses the id must not inherit the old parent link.
	state, err := nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "c", WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "agent", SessionID: "s-c2", UpdatedAt: "2026-01-02T00:00:00Z"}}, nil)
	require.NoError(t, err)
	row := conversation(t, state, "c")
	assert.Empty(t, row.ParentID)
	assert.Empty(t, row.RootID)
}

func TestDesktopRequests(t *testing.T) {
	ctx := context.Background()
	s := New(navFixture(t), &recordingAgent{})
	err := s.OpenConversation(ctx, "p", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no Camber desktop window")

	var gotMethod string
	var gotParams any
	g := &glsp.Context{Call: func(_ context.Context, method string, params any, _ any) error {
		gotMethod, gotParams = method, params
		return nil
	}}
	require.NoError(t, s.OpenConversation(ctx, "p", g))
	assert.Equal(t, methods.DesktopAppOpenConversationMethod, gotMethod)
	assert.Equal(t, methods.DesktopAppOpenConversationParams{ConversationID: "p"}, gotParams)

	require.NoError(t, s.RemoveProject(ctx, "/ws", g))
	assert.Equal(t, methods.DesktopAppRemoveProjectMethod, gotMethod)

	notFound := &glsp.Context{Call: func(context.Context, string, any, any) error { return errors.New("Method not found") }}
	err = s.RemoveProject(ctx, "/ws", notFound)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no Camber desktop window")
}

type recordingAgent struct {
	mu        sync.Mutex
	caps      acpproxy.SessionManagementCapabilities
	closeErr  error
	closed    []*methods.ACPCloseSessionParams
	deleted   []*methods.ACPDeleteSessionParams
	cancelled []string
	renamed   chan *methods.ACPRenameSessionParams
}

func (a *recordingAgent) CloseSession(_ context.Context, p *methods.ACPCloseSessionParams, _ *glsp.Context) (*methods.ACPCloseSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = append(a.closed, p)
	return &methods.ACPCloseSessionOutput{}, a.closeErr
}

func (a *recordingAgent) DeleteSession(_ context.Context, p *methods.ACPDeleteSessionParams, _ *glsp.Context) (*methods.ACPDeleteSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.deleted = append(a.deleted, p)
	return &methods.ACPDeleteSessionOutput{}, nil
}

func (a *recordingAgent) RenameSession(_ context.Context, p *methods.ACPRenameSessionParams, _ *glsp.Context) (*methods.ACPRenameSessionOutput, error) {
	a.renamed <- p
	return &methods.ACPRenameSessionOutput{}, nil
}

func (a *recordingAgent) CancelInFlightTurn(_ context.Context, _, sessionID string, _ *glsp.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelled = append(a.cancelled, sessionID)
	return nil
}

func (a *recordingAgent) SessionManagementCapabilities(string) acpproxy.SessionManagementCapabilities {
	return a.caps
}

// waitRenamed returns the background session renames; with expect it waits
// for one.
func (a *recordingAgent) waitRenamed(t *testing.T, expect bool) []*methods.ACPRenameSessionParams {
	t.Helper()
	if a.renamed == nil {
		return nil
	}
	if !expect {
		select {
		case p := <-a.renamed:
			return []*methods.ACPRenameSessionParams{p}
		case <-time.After(50 * time.Millisecond):
			return nil
		}
	}
	select {
	case p := <-a.renamed:
		return []*methods.ACPRenameSessionParams{p}
	case <-time.After(5 * time.Second):
		require.FailNow(t, "session rename was not called")
		return nil
	}
}

func navFixture(t *testing.T, ids ...string) *acpnav.Server {
	t.Helper()
	ctx := context.Background()
	store, err := acpnav.Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	server := acpnav.NewServer()
	server.SetStore(store)
	t.Cleanup(func() { _ = server.Close() })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/ws"})
	require.NoError(t, err)
	for _, id := range ids {
		require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
			ID: id, WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "agent", SessionID: "s-" + id, Title: "title-" + id, UpdatedAt: "2026-01-01T00:00:00Z",
		}))
	}
	return server
}

func link(t *testing.T, s *acpnav.Server, child, parent string) {
	t.Helper()
	require.NoError(t, s.WriteControlState(context.Background(), "conversation/"+child, map[string]string{"parentId": parent}))
}

func listState(t *testing.T, s *acpnav.Server) methods.ACPNavState {
	t.Helper()
	state, err := s.List(context.Background(), &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	return state
}

func archived(t *testing.T, s *acpnav.Server) map[string]bool {
	t.Helper()
	state, err := s.List(context.Background(), &methods.ACPNavListParams{}, nil)
	require.NoError(t, err)
	out := map[string]bool{}
	for _, c := range state.Conversations {
		out[c.ID] = c.Archived
	}
	return out
}

func conversation(t *testing.T, state methods.ACPNavState, id string) methods.ACPNavConversation {
	t.Helper()
	for _, c := range state.Conversations {
		if c.ID == id {
			return c
		}
	}
	require.FailNow(t, "conversation missing", id)
	return methods.ACPNavConversation{}
}
