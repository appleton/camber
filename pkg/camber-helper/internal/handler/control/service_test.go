package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

var testOptions = json.RawMessage(`[{"id":"model","name":"Model","type":"select","category":"model","currentValue":"small","options":[{"value":"small","name":"Small"},{"value":"large","name":"Large"}]},{"id":"reasoning_effort","name":"Effort","type":"select","category":"thought_level","currentValue":"medium","options":[{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},{"id":"toggle","name":"Toggle","type":"boolean","currentValue":false}]`)

type fakeAgent struct {
	Agent
	mu      sync.Mutex
	calls   []string
	options json.RawMessage
	started chan struct{}
	finish  chan struct{}
	log     *remoteaccess.SessionLog
	next    int
}

func (f *fakeAgent) NewSession(_ context.Context, _ *methods.ACPNewSessionParams, _ *glsp.Context) (*methods.ACPNewSessionOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	f.calls = append(f.calls, "new")
	var out methods.ACPNewSessionOutput
	_ = json.Unmarshal([]byte(`{"sessionId":"session","configOptions":`+string(f.options)+`}`), &out)
	return &out, nil
}
func (f *fakeAgent) SetConfigOption(_ context.Context, p *methods.ACPSetConfigOptionParams, _ *glsp.Context) (*methods.ACPSetConfigOptionOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := json.Marshal(p.SetSessionConfigOptionRequest)
	var req struct {
		ID    string `json:"configId"`
		Value any    `json:"value"`
	}
	_ = json.Unmarshal(raw, &req)
	f.calls = append(f.calls, "set:"+req.ID)
	var opts []map[string]any
	_ = json.Unmarshal(f.options, &opts)
	for _, o := range opts {
		if o["id"] == req.ID {
			o["currentValue"] = req.Value
		}
	}
	f.options, _ = json.Marshal(opts)
	var out methods.ACPSetConfigOptionOutput
	_ = json.Unmarshal([]byte(`{"configOptions":`+string(f.options)+`}`), &out)
	return &out, nil
}
func (f *fakeAgent) Prompt(ctx context.Context, p *methods.ACPPromptParams, _ *glsp.Context) (*methods.ACPPromptOutput, error) {
	f.mu.Lock()
	f.calls = append(f.calls, "prompt")
	f.mu.Unlock()
	f.log.BeginTurn(p.AgentServer, string(p.SessionId))
	defer f.log.EndTurn(p.AgentServer, string(p.SessionId))
	close(f.started)
	f.log.Publish(p.AgentServer, string(p.SessionId), "", false, map[string]any{"method": "session/update", "params": map[string]any{"sessionId": p.SessionId, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "answer"}}}})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-f.finish:
		return &methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}, nil
	}
}
func fixture(t *testing.T) (*Service, *fakeAgent) {
	t.Helper()
	store, err := acpnav.Open(context.Background(), filepath.Join(t.TempDir(), "nav.sqlite"))
	require.NoError(t, err)
	nav := acpnav.NewServer()
	nav.SetStore(store)
	t.Cleanup(func() { require.NoError(t, nav.Close()) })
	log := remoteaccess.NewSessionLog(remoteaccess.NewHub())
	agent := &fakeAgent{options: testOptions, started: make(chan struct{}), finish: make(chan struct{}), log: log}
	s := New(nav, agent, log)
	_, err = nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	_, err = nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "parent", AgentServer: "test", WorkspacePath: t.TempDir(), Cwd: t.TempDir()}}, nil)
	require.NoError(t, err)
	return s, agent
}
func invoke(t *testing.T, s *Service, command string, args Args) map[string]any {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	result, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: raw}, nil)
	require.NoError(t, err)
	var out map[string]any
	require.NoError(t, json.Unmarshal(result, &out))
	return out
}

func TestSpawnConfigBeforePromptAndDetachedPolling(t *testing.T) {
	s, agent := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	args := Args{ParentID: "parent", Text: "do task", RequestID: "retry", Model: "large", Effort: "high", Config: map[string]any{"toggle": true}}
	raw, _ := json.Marshal(args)
	result, err := s.Dispatch(ctx, &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.NoError(t, err)
	cancel()
	select {
	case <-agent.started:
	case <-time.After(time.Second):
		require.FailNow(t, "prompt did not start")
	}
	var out struct {
		Conversation View   `json:"conversation"`
		Cursor       string `json:"cursor"`
	}
	require.NoError(t, json.Unmarshal(result, &out))
	assert.Equal(t, "parent", out.Conversation.ParentID)
	assert.Equal(t, "parent", out.Conversation.RootID)
	stored, storedErr := s.view(context.Background(), out.Conversation.ID, nil)
	require.NoError(t, storedErr)
	var metadata struct {
		Config struct {
			Selections map[string]any `json:"selections"`
		} `json:"sessionConfig"`
	}
	require.NoError(t, json.Unmarshal(stored.Metadata, &metadata))
	assert.Equal(t, "large", metadata.Config.Selections["model"])
	assert.Equal(t, "high", metadata.Config.Selections["reasoning_effort"])
	agent.mu.Lock()
	assert.Equal(t, []string{"new", "set:model", "set:reasoning_effort", "set:toggle", "prompt"}, agent.calls)
	agent.mu.Unlock()
	page := invoke(t, s, "chat.poll", Args{ConversationID: out.Conversation.ID, Cursor: out.Cursor, WaitMs: 1000})
	assert.Equal(t, true, page["turnActive"])
	require.NotEmpty(t, page["events"])
	again := invoke(t, s, "chat.spawn", args)
	assert.Equal(t, out.Conversation.ID, again["conversation"].(map[string]any)["id"])
	agent.mu.Lock()
	assert.Equal(t, 1, agent.next)
	agent.mu.Unlock()
	close(agent.finish)
	require.Eventually(t, func() bool {
		v, e := s.view(context.Background(), out.Conversation.ID, nil)
		return e == nil && v.Status == "completed"
	}, time.Second, time.Millisecond*10)
	output := invoke(t, s, "chat.output", Args{ConversationID: out.Conversation.ID})
	assert.Equal(t, "answer", output["text"])
	assert.Equal(t, true, output["complete"])
	children := invoke(t, s, "chat.children", Args{ParentID: "parent"})
	assert.Len(t, children["conversations"], 1)
}

func TestInvalidConfigNeverStartsTask(t *testing.T) {
	s, agent := fixture(t)
	raw, _ := json.Marshal(Args{ParentID: "parent", Text: "task", Config: map[string]any{"model": "large", "reasoning_effort": "impossible"}})
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "unsupported value")
	agent.mu.Lock()
	assert.Equal(t, []string{"new", "set:model"}, agent.calls)
	agent.mu.Unlock()
}
func TestRequestIDRejectsDifferentTask(t *testing.T) {
	s, agent := fixture(t)
	invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "first", RequestID: "same"})
	<-agent.started
	defer close(agent.finish)
	raw, _ := json.Marshal(Args{ParentID: "parent", Text: "second", RequestID: "same"})
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "different arguments")
}
func TestUnknownArgumentsRejected(t *testing.T) {
	s, _ := fixture(t)
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "status", Args: json.RawMessage(`{"typo":true}`)}, nil)
	require.ErrorContains(t, err, "unknown field")
}
func TestControlRecordSurvivesFrontendMetadataUpdate(t *testing.T) {
	s, _ := fixture(t)
	v, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	v.Record = Record{}
	v.ParentID, v.RootID = "root", "root"
	require.NoError(t, s.save(context.Background(), v))
	v.Metadata = json.RawMessage(`{"client":"updated"}`)
	_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, nil)
	require.NoError(t, err)
	loaded, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	assert.Equal(t, "root", loaded.ParentID)
	assert.Equal(t, "root", loaded.RootID)
	var raw map[string]any
	require.NoError(t, s.nav.ReadControlState(context.Background(), "conversation/parent", &raw))
	assert.Equal(t, "root", raw["parentId"])
	assert.Equal(t, "root", raw["rootId"])
	wire, err := json.Marshal(loaded)
	require.NoError(t, err)
	var flat map[string]any
	require.NoError(t, json.Unmarshal(wire, &flat))
	assert.Equal(t, "root", flat["parentId"])
	assert.Equal(t, "root", flat["rootId"])
}

func TestInheritanceExplicitOverridesAndCompatibility(t *testing.T) {
	var child []map[string]any
	require.NoError(t, json.Unmarshal(testOptions, &child))
	parent := json.RawMessage(`[{"id":"model","type":"select","category":"model","currentValue":"small"},{"id":"reasoning_effort","type":"select","category":"thought_level","currentValue":"medium"},{"id":"missing","type":"select","currentValue":"x"}]`)
	values := inheritCompatible(parent, testOptions, Args{Model: "large", Effort: "high"})
	assert.NotContains(t, values, "model")
	assert.NotContains(t, values, "reasoning_effort")
	assert.NotContains(t, values, "missing")
}
func TestRestartReconcilesPersistedRunningState(t *testing.T) {
	s, _ := fixture(t)
	v, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	v.Status = "running"
	v.TurnID = "parent/old"
	v.Cursor = s.log.ControlCursor("test", "session")
	require.NoError(t, s.save(context.Background(), v))
	s.log = remoteaccess.NewSessionLog(remoteaccess.NewHub())
	v, err = s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	assert.Equal(t, "interrupted", v.Status)
	assert.Contains(t, v.Error, "unknown")
}
func TestUnknownConfigDoesNotMutateAgent(t *testing.T) {
	s, agent := fixture(t)
	raw, _ := json.Marshal(Args{ParentID: "parent", Text: "task", Config: map[string]any{"model": "large", "unknown": "value"}})
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "unknown configuration")
	agent.mu.Lock()
	assert.Equal(t, []string{"new"}, agent.calls)
	agent.mu.Unlock()
}
func TestOutputForCompletedTurnExcludesLaterUIEvents(t *testing.T) {
	s, agent := fixture(t)
	spawn := invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
	<-agent.started
	close(agent.finish)
	id := spawn["conversation"].(map[string]any)["id"].(string)
	turn := spawn["turnId"].(string)
	require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status == "completed" }, time.Second, time.Millisecond*10)
	s.log.BeginTurn("test", "session")
	s.log.Publish("test", "session", "", false, map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "session", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "LATER UI TURN"}}}})
	out := invoke(t, s, "chat.output", Args{ConversationID: id, TurnID: turn})
	assert.Equal(t, "answer", out["text"])
	assert.Equal(t, true, out["complete"])
	assert.Equal(t, false, out["turnActive"])
}

func TestWorktreeRemovalRefusesPendingConversation(t *testing.T) {
	s, _ := fixture(t)
	parent := t.TempDir()
	path := filepath.Join(parent, "child")
	parentProject, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: parent}, nil)
	require.NoError(t, err)
	parent = parentProject.Path
	_, err = s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: path, IsWorktree: true, ParentPath: &parent}, nil)
	require.NoError(t, err)
	v := View{ACPNavConversation: methods.ACPNavConversation{ID: "pending", AgentServer: "test", WorkspacePath: path, Cwd: path}, Record: Record{Status: "preparing"}}
	_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, nil)
	require.NoError(t, err)
	require.NoError(t, s.save(context.Background(), v))
	raw, _ := json.Marshal(Args{WorkspacePath: path})
	_, err = s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "worktrees.remove", Args: raw}, nil)
	require.ErrorContains(t, err, "preparing or running")
}

type reloadingAgent struct {
	*fakeAgent
	loads int
}

func (f *reloadingAgent) LoadSession(_ context.Context, _ *methods.ACPLoadSessionParams, _ *glsp.Context) (*methods.ACPLoadSessionOutput, error) {
	f.loads++
	var out methods.ACPLoadSessionOutput
	_ = json.Unmarshal([]byte(`{"configOptions":`+string(testOptions)+`}`), &out)
	return &out, nil
}
func TestReloadRestoresPersistedConfigBeforeContinuation(t *testing.T) {
	s, base := fixture(t)
	agent := &reloadingAgent{fakeAgent: base}
	s.agent = agent
	v, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	v.SessionID = "session"
	v.Metadata = json.RawMessage(`{"explored":["keep"],"sessionConfig":{"selections":{"model":"large","reasoning_effort":"high"},"modeId":null}}`)
	_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, nil)
	require.NoError(t, err)
	require.NoError(t, s.restoreSession(context.Background(), &v, nil))
	assert.Equal(t, 1, agent.loads)
	base.mu.Lock()
	assert.Equal(t, []string{"set:model", "set:reasoning_effort"}, base.calls)
	base.mu.Unlock()
	stored, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	var metadata map[string]any
	require.NoError(t, json.Unmarshal(stored.Metadata, &metadata))
	assert.Equal(t, []any{"keep"}, metadata["explored"])
	assert.Equal(t, "large", metadata["sessionConfig"].(map[string]any)["selections"].(map[string]any)["model"])
}

type followupAgent struct {
	Agent
	log  *remoteaccess.SessionLog
	fail bool
}

func (f *followupAgent) Prompt(_ context.Context, p *methods.ACPPromptParams, _ *glsp.Context) (*methods.ACPPromptOutput, error) {
	f.log.BeginTurn(p.AgentServer, string(p.SessionId))
	defer f.log.EndTurn(p.AgentServer, string(p.SessionId))
	if f.fail {
		return nil, errors.New("followup failed")
	}
	return &methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}, nil
}
func TestSpawnRetryReturnsInitialTurnAfterFollowup(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprintf("followup_failure_%t", fail), func(t *testing.T) {
			s, agent := fixture(t)
			args := Args{ParentID: "parent", Text: "initial task", RequestID: "spawn"}
			first := invoke(t, s, "chat.spawn", args)
			id := first["conversation"].(map[string]any)["id"].(string)
			<-agent.started
			close(agent.finish)
			require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status == "completed" }, time.Second, 10*time.Millisecond)
			s.agent = &followupAgent{Agent: agent, log: s.log, fail: fail}
			followup := invoke(t, s, "chat.send", Args{ConversationID: id, Text: "followup", RequestID: "followup"})
			require.NotEqual(t, first["turnId"], followup["turnId"])
			require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status != "running" }, time.Second, 10*time.Millisecond)
			retry := invoke(t, s, "chat.spawn", args)
			assert.Equal(t, first["turnId"], retry["turnId"])
			assert.Equal(t, first["cursor"], retry["cursor"])
			assert.Equal(t, followup["turnId"], retry["conversation"].(map[string]any)["turnId"])
			agent.mu.Lock()
			assert.Equal(t, 1, agent.next)
			agent.mu.Unlock()
		})
	}
}
func TestSpawnRetryReportsPreparationFailure(t *testing.T) {
	s, _ := fixture(t)
	args := Args{ParentID: "parent", Text: "task", RequestID: "failed", Config: map[string]any{"unknown": "value"}}
	raw, _ := json.Marshal(args)
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "unknown configuration")
	_, err = s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "previous spawn")
	require.ErrorContains(t, err, "failed")
}

func TestSpawnRetryReportsInitialTurnFailure(t *testing.T) {
	s, agent := fixture(t)
	s.agent = &followupAgent{Agent: agent, log: s.log, fail: true}
	args := Args{ParentID: "parent", Text: "initial task", RequestID: "failed-initial"}
	first := invoke(t, s, "chat.spawn", args)
	id := first["conversation"].(map[string]any)["id"].(string)
	require.Eventually(t, func() bool { v, e := s.view(context.Background(), id, nil); return e == nil && v.Status == "failed" }, time.Second, 10*time.Millisecond)
	raw, _ := json.Marshal(args)
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.spawn", Args: raw}, nil)
	require.ErrorContains(t, err, "previous spawn")
	require.ErrorContains(t, err, "followup failed")
}
