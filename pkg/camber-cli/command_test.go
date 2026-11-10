package cambercli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type call struct {
	method string
	params map[string]any
}
type fakeCaller struct {
	calls    []call
	results  []json.RawMessage
	err      error
	failures []error
}

func (f *fakeCaller) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	f.calls = append(f.calls, call{method, params.(map[string]any)})
	if len(f.failures) > 0 {
		err := f.failures[0]
		f.failures = f.failures[1:]
		if err != nil {
			return nil, err
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	if len(f.results) > 0 {
		r := f.results[0]
		f.results = f.results[1:]
		return r, nil
	}
	return json.RawMessage(`{"ok":true}`), nil
}
func execute(t *testing.T, f *fakeCaller, args ...string) (string, error) {
	t.Helper()
	cmd := NewCommandWithClient(f)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestConfigurationCommands(t *testing.T) {
	f := &fakeCaller{}
	_, err := execute(t, f, "chat", "config", "set", "child", "reasoning_effort", "--value-json", `"high"`, "--json")
	require.NoError(t, err)
	require.Len(t, f.calls, 1)
	assert.Equal(t, "camber/control/dispatch", f.calls[0].method)
	assert.Equal(t, "chat.config.set", f.calls[0].params["command"])
	args := f.calls[0].params["args"].(map[string]any)
	assert.Equal(t, "child", args["conversationId"])
	assert.Equal(t, map[string]any{"reasoning_effort": "high"}, args["config"])
	f = &fakeCaller{}
	_, err = execute(t, f, "chat", "config", "set", "child", "--input", `{"model":"sol","thinking":true}`)
	require.NoError(t, err)
	require.Len(t, f.calls, 1)
	args = f.calls[0].params["args"].(map[string]any)
	assert.Equal(t, map[string]any{"model": "sol", "thinking": true}, args["config"])
}
func TestInvalidConfigurationDoesNotDispatch(t *testing.T) {
	for _, args := range [][]string{
		{"chat", "config", "set", "child", "--input", `{"effort":3}`},
		{"chat", "config", "set", "child", "--input", `null`},
		{"chat", "config", "set", "child", "effort", "--value-json", `"high"`, "--input", `{}`},
		{"chat", "config", "set", "child", "effort"},
		{"chat", "config", "set", "child", "--value-json", `true`},
	} {
		f := &fakeCaller{}
		_, err := execute(t, f, args...)
		require.Error(t, err)
		assert.Empty(t, f.calls)
	}
}
func TestSpawnCarriesConfigurationAndOrigin(t *testing.T) {
	t.Setenv("CAMBER_CONVERSATION_ID", "origin")
	f := &fakeCaller{}
	_, err := execute(t, f, "chat", "spawn", "--agent", "codex", "--model", "sol", "--effort", "high", "--new-worktree", "api-task", "--text", "implement API", "--input", `{"mode":"code"}`)
	require.NoError(t, err)
	require.Len(t, f.calls, 1)
	args := f.calls[0].params["args"].(map[string]any)
	assert.Equal(t, "chat.spawn", f.calls[0].params["command"])
	assert.Equal(t, "origin", args["parentId"])
	assert.Equal(t, "codex", args["agentServer"])
	assert.Equal(t, "sol", args["model"])
	assert.Equal(t, "high", args["effort"])
	assert.Equal(t, "api-task", args["worktreeName"])
	assert.Equal(t, "implement API", args["text"])
}
func TestFollowUsesReusableCursorAndNeverCancels(t *testing.T) {
	f := &fakeCaller{results: []json.RawMessage{
		json.RawMessage(`{"conversationId":"child","turnId":"turn","cursor":"start"}`),
		json.RawMessage(`{"events":[{"seq":1}],"nextCursor":"next","turnActive":true}`),
		json.RawMessage(`{"events":[{"seq":2}],"cursor":"end","turnActive":false,"terminal":true,"status":"completed"}`),
	}}
	output, err := execute(t, f, "chat", "send", "child", "--text", "hello", "--follow", "--json")
	require.NoError(t, err)
	require.Len(t, f.calls, 3)
	assert.Equal(t, 3, bytes.Count([]byte(output), []byte("\n")))
	assert.Equal(t, "chat.send", f.calls[0].params["command"])
	for _, call := range f.calls[1:] {
		assert.Equal(t, "chat.poll", call.params["command"])
	}
	assert.Equal(t, "start", f.calls[1].params["args"].(map[string]any)["cursor"])
	assert.Equal(t, "next", f.calls[2].params["args"].(map[string]any)["cursor"])
}
func TestFollowDisconnectDoesNotSubmitOrCancel(t *testing.T) {
	f := &fakeCaller{err: errors.New("connection closed")}
	_, err := execute(t, f, "chat", "watch", "child", "--cursor", "resume")
	require.ErrorContains(t, err, "connection closed")
	require.Len(t, f.calls, 1)
	assert.Equal(t, "chat.poll", f.calls[0].params["command"])
	assert.Equal(t, "resume", f.calls[0].params["args"].(map[string]any)["cursor"])
}
func TestFollowWaitsForPendingInteraction(t *testing.T) {
	f := &fakeCaller{results: []json.RawMessage{
		json.RawMessage(`{"nextCursor":"approval","turnActive":false,"status":"waiting_for_input"}`),
		json.RawMessage(`{"nextCursor":"end","turnActive":false,"terminal":true,"status":"completed"}`),
	}}
	_, err := execute(t, f, "chat", "watch", "child")
	require.NoError(t, err)
	require.Len(t, f.calls, 2)
	assert.Equal(t, "approval", f.calls[1].params["args"].(map[string]any)["cursor"])
}

func TestSteeringDoesNotAdvertiseIgnoredIdempotency(t *testing.T) {
	f := &fakeCaller{}
	_, err := execute(t, f, "chat", "steer", "child", "--text", "change", "--request-id", "retry")
	require.ErrorContains(t, err, "unknown flag")
	assert.Empty(t, f.calls)
}

func TestTextCanEscapeLeadingAtSign(t *testing.T) {
	text, err := readText("@@team please review", strings.NewReader(""))
	require.NoError(t, err)
	assert.Equal(t, "@team please review", text)
}
func TestFollowRequiresSuccessfulCompletionAndDrainsPages(t *testing.T) {
	for _, status := range []string{"failed", "cancelled", "interrupted", "idle", ""} {
		t.Run(status, func(t *testing.T) {
			page, err := json.Marshal(map[string]any{"status": status, "turnActive": false})
			require.NoError(t, err)
			f := &fakeCaller{results: []json.RawMessage{page}}
			output, err := execute(t, f, "chat", "watch", "child")
			require.Error(t, err)
			assert.Contains(t, output, `"status"`)
			require.Len(t, f.calls, 1)
		})
	}
	f := &fakeCaller{results: []json.RawMessage{
		json.RawMessage(`{"nextCursor":"remaining","turnActive":false,"hasMore":true,"status":"completed"}`),
		json.RawMessage(`{"nextCursor":"end","turnActive":false,"terminal":true,"status":"completed"}`),
	}}
	_, err := execute(t, f, "chat", "watch", "child")
	require.NoError(t, err)
	require.Len(t, f.calls, 2)
	assert.Equal(t, "remaining", f.calls[1].params["args"].(map[string]any)["cursor"])
	f = &fakeCaller{results: []json.RawMessage{json.RawMessage(`{"resetRequired":true,"status":"completed","terminal":true}`)}}
	_, err = execute(t, f, "chat", "watch", "child")
	require.ErrorContains(t, err, "incomplete")
}
func TestSnapshotAndOutputHaveDedicatedActions(t *testing.T) {
	for _, name := range []string{"snapshot", "output"} {
		f := &fakeCaller{}
		_, err := execute(t, f, "chat", name, "child")
		require.NoError(t, err)
		require.Len(t, f.calls, 1)
		assert.Equal(t, "chat."+name, f.calls[0].params["command"])
	}
}
func TestPromptAndBatchCanReadStdin(t *testing.T) {
	f := &fakeCaller{}
	cmd := NewCommandWithClient(f)
	cmd.SetIn(bytes.NewBufferString(`{"effort":"high"}`))
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetArgs([]string{"chat", "config", "set", "child", "--input", "@-"})
	require.NoError(t, cmd.Execute())
	require.Len(t, f.calls, 1)
	assert.Equal(t, map[string]any{"effort": "high"}, f.calls[0].params["args"].(map[string]any)["config"])
}

func TestFollowReconnectsFromLastEmittedCursor(t *testing.T) {
	f := &fakeCaller{failures: []error{nil, io.ErrUnexpectedEOF, nil}, results: []json.RawMessage{
		json.RawMessage(`{"events":[{"seq":1}],"nextCursor":"one","turnActive":true}`),
		json.RawMessage(`{"events":[{"seq":2}],"nextCursor":"two","terminal":true,"status":"completed"}`),
	}}
	output, err := execute(t, f, "chat", "watch", "child", "--cursor", "start", "--json")
	require.NoError(t, err)
	require.Len(t, f.calls, 3)
	assert.Equal(t, 2, bytes.Count([]byte(output), []byte("\n")))
	for _, call := range f.calls {
		assert.Equal(t, "chat.poll", call.params["command"])
	}
	assert.Equal(t, "one", f.calls[1].params["args"].(map[string]any)["cursor"])
	assert.Equal(t, "one", f.calls[2].params["args"].(map[string]any)["cursor"])
}
func TestFollowGivesUpAfterRepeatedDisconnects(t *testing.T) {
	f := &fakeCaller{err: io.ErrUnexpectedEOF}
	_, err := execute(t, f, "chat", "watch", "child")
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
	assert.Len(t, f.calls, 4)
}

func TestCallerTokenIsForwardedInDispatchParams(t *testing.T) {
	t.Run("flag", func(t *testing.T) {
		t.Setenv("CAMBER_CALLER_TOKEN", "")
		f := &fakeCaller{}
		_, err := execute(t, f, "chat", "spawn", "parent", "--text", "task", "--caller-token", "tok-flag")
		require.NoError(t, err)
		require.Len(t, f.calls, 1)
		assert.Equal(t, "tok-flag", f.calls[0].params["callerToken"])
		_, inArgs := f.calls[0].params["args"].(map[string]any)["callerToken"]
		assert.False(t, inArgs, "the token travels beside the action arguments")
	})
	t.Run("environment fallback", func(t *testing.T) {
		t.Setenv("CAMBER_CALLER_TOKEN", "tok-env")
		f := &fakeCaller{}
		_, err := execute(t, f, "chat", "config", "set", "child", "--mode", "plan")
		require.NoError(t, err)
		require.Len(t, f.calls, 1)
		assert.Equal(t, "tok-env", f.calls[0].params["callerToken"])
	})
	t.Run("absent", func(t *testing.T) {
		t.Setenv("CAMBER_CALLER_TOKEN", "")
		f := &fakeCaller{}
		_, err := execute(t, f, "chat", "list")
		require.NoError(t, err)
		require.Len(t, f.calls, 1)
		_, present := f.calls[0].params["callerToken"]
		assert.False(t, present)
	})
}
