package acpproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestInvalidateSessionConfigurationRequiresReload(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	// Invalidating an absent subprocess must not start one.
	h.InvalidateSessionConfiguration(DefaultAgentServerName, "target")
	require.Empty(t, h.procs)
	cache := &sessionConfigurationCache{}
	cache.capture("target", []acpsdk.SessionConfigOption{}, nil)
	cache.capture("other", []acpsdk.SessionConfigOption{}, nil)
	h.procs[DefaultAgentServerName] = &process{configuration: cache}

	h.InvalidateSessionConfiguration(DefaultAgentServerName, "target")
	_, _, found := h.SessionConfiguration(DefaultAgentServerName, "target")
	assert.False(t, found)
	_, _, found = h.SessionConfiguration(DefaultAgentServerName, "other")
	assert.True(t, found)
	cache.observe("target", acpsdk.SessionUpdate{
		ConfigOptionUpdate: &acpsdk.SessionConfigOptionUpdate{ConfigOptions: []acpsdk.SessionConfigOption{}},
		CurrentModeUpdate:  &acpsdk.SessionCurrentModeUpdate{CurrentModeId: "plan"},
	})
	_, _, found = h.SessionConfiguration(DefaultAgentServerName, "target")
	assert.False(t, found, "late updates must not make failed recovery usable")
	cache.capture("target", []acpsdk.SessionConfigOption{}, nil)
	_, _, found = h.SessionConfiguration(DefaultAgentServerName, "target")
	assert.True(t, found, "a confirmed reload makes the session usable again")
}

func TestSessionConfigurationCloseLifecycle(t *testing.T) {
	for _, scenario := range []string{"closed", "already_gone", "failed", "unsupported"} {
		t.Run(scenario, func(t *testing.T) {
			inputR, inputW := io.Pipe()
			outputR, outputW := io.Pipe()
			t.Cleanup(func() {
				inputW.Close()
				outputW.Close()
				inputR.Close()
				outputR.Close()
			})
			go func() {
				scanner := bufio.NewScanner(inputR)
				for scanner.Scan() {
					var req struct {
						ID     any    `json:"id"`
						Method string `json:"method"`
					}
					if json.Unmarshal(scanner.Bytes(), &req) != nil {
						return
					}
					response := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}}
					if req.Method == "session/close" && (scenario == "already_gone" || scenario == "failed") {
						detail := "Session not found"
						if scenario == "failed" {
							detail = "temporary failure"
						}
						delete(response, "result")
						response["error"] = map[string]any{"code": -32603, "message": detail}
					}
					raw, _ := json.Marshal(response)
					if _, err := outputW.Write(append(raw, '\n')); err != nil {
						return
					}
				}
			}()
			h := NewHandler(dummyConfig(), nil, nil)
			g := newGlspContext(nil, nil)
			proc, client := h.processFor(DefaultAgentServerName, g)
			cache := &sessionConfigurationCache{}
			cache.capture("target", []acpsdk.SessionConfigOption{}, nil)
			cache.capture("other", []acpsdk.SessionConfigOption{}, nil)
			proc.configuration = cache
			proc.state = processState{kind: processStateRunning}
			proc.conn = acpsdk.NewClientSideConnection(client, inputW, outputR)
			proc.initResp = &acpsdk.InitializeResponse{AgentCapabilities: acpsdk.AgentCapabilities{
				LoadSession: true,
				SessionCapabilities: acpsdk.SessionCapabilities{
					Close: &acpsdk.SessionCloseCapabilities{},
				},
			}}
			if scenario == "unsupported" {
				proc.initResp.AgentCapabilities.SessionCapabilities.Close = nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := h.CloseSession(ctx, &methods.ACPCloseSessionParams{
				ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
				CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: "target"},
			}, g)
			if scenario == "failed" {
				require.ErrorContains(t, err, "temporary failure")
			} else {
				require.NoError(t, err)
			}
			_, _, found := h.SessionConfiguration(DefaultAgentServerName, "target")
			closed := scenario == "closed" || scenario == "already_gone"
			assert.Equal(t, !closed, found)
			_, _, found = h.SessionConfiguration(DefaultAgentServerName, "other")
			assert.True(t, found, "closing one session must not invalidate another")
			if !closed {
				return
			}
			// Late notifications can update pending state but must not turn a
			// closed session back into a live one without a load response.
			cache.observe("target", acpsdk.SessionUpdate{
				ConfigOptionUpdate: &acpsdk.SessionConfigOptionUpdate{ConfigOptions: []acpsdk.SessionConfigOption{}},
				CurrentModeUpdate:  &acpsdk.SessionCurrentModeUpdate{CurrentModeId: "plan"},
			})
			_, _, found = h.SessionConfiguration(DefaultAgentServerName, "target")
			assert.False(t, found)
			proc.mu.Lock()
			_, err = proc.loadSessionLocked(ctx, acpsdk.LoadSessionRequest{SessionId: "target", Cwd: "/tmp"})
			proc.mu.Unlock()
			require.NoError(t, err)
			_, _, found = h.SessionConfiguration(DefaultAgentServerName, "target")
			assert.True(t, found, "a confirmed reload makes the session usable again")
		})
	}
}

func TestSessionConfigurationTracksLifecycleAndSettings(t *testing.T) {
	inputR, inputW := io.Pipe()
	outputR, outputW := io.Pipe()
	t.Cleanup(func() {
		inputW.Close()
		outputW.Close()
	})
	options := json.RawMessage(`[{"id":"model","name":"Model","type":"select","currentValue":"sol","options":[{"value":"sol","name":"Sol"},{"value":"luna","name":"Luna"}]}]`)
	modes := json.RawMessage(`{"currentModeId":"code","availableModes":[{"id":"code","name":"Code"},{"id":"plan","name":"Plan"}]}`)
	go func() {
		scanner := bufio.NewScanner(inputR)
		for scanner.Scan() {
			var request struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				return
			}
			result := map[string]any{"configOptions": options, "modes": modes}
			switch request.Method {
			case "session/new":
				result["sessionId"] = "created"
			case "session/set_mode":
				result = map[string]any{}
			case "session/set_config_option":
				result = map[string]any{"configOptions": json.RawMessage(`[{"id":"model","name":"Model","type":"select","currentValue":"luna","options":[{"value":"sol","name":"Sol"},{"value":"luna","name":"Luna"}]}]`)}
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			if _, err := outputW.Write(append(response, '\n')); err != nil {
				return
			}
		}
	}()
	cache := &sessionConfigurationCache{}
	proc := &process{
		state:         processState{kind: processStateRunning},
		configuration: cache,
		conn:          acpsdk.NewClientSideConnection(&configurationClient{acpClient: &acpClient{}, configuration: cache}, inputW, outputR),
	}
	h := NewHandler(dummyConfig(), nil, nil)
	h.procs[DefaultAgentServerName] = proc
	ctx := context.Background()
	proc.mu.Lock()
	created, newErr := proc.newSessionLocked(ctx, acpsdk.NewSessionRequest{Cwd: "/tmp"})
	_, loadErr := proc.loadSessionLocked(ctx, acpsdk.LoadSessionRequest{SessionId: "loaded", Cwd: "/tmp"})
	_, resumeErr := proc.resumeSessionLocked(ctx, acpsdk.ResumeSessionRequest{SessionId: "resumed", Cwd: "/tmp"})
	proc.mu.Unlock()
	require.NoError(t, newErr)
	require.NoError(t, loadErr)
	require.NoError(t, resumeErr)
	require.Equal(t, acpsdk.SessionId("created"), created.SessionId)
	for _, session := range []string{"created", "loaded", "resumed"} {
		gotOptions, gotModes, ok := h.SessionConfiguration(DefaultAgentServerName, session)
		require.True(t, ok, session)
		assert.JSONEq(t, string(options), string(gotOptions))
		assert.JSONEq(t, string(modes), string(gotModes))
	}
	// This agent emits no configuration notifications. A control-origin setter
	// must still publish the response's accepted values to open desktop clients.
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	// A remote client's concurrent replay must not hide this live mutation
	// from the primary desktop or other clients already watching the session.
	h.loadScopes[promptSessionKey{agentServer: DefaultAgentServerName, sessionID: "created"}] = "remote:other/load"
	ctx = methods.WithClientOrigin(ctx, "control")
	_, err := h.SetMode(ctx, &methods.ACPSetModeParams{
		ACPAgentServerParams:  methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		SetSessionModeRequest: acpsdk.SetSessionModeRequest{SessionId: "created", ModeId: "plan"},
	}, newGlspContext(nil, nil))
	require.NoError(t, err)
	_, gotModes, ok := h.SessionConfiguration(DefaultAgentServerName, "created")
	require.True(t, ok)
	assert.JSONEq(t, `{"currentModeId":"plan","availableModes":[{"id":"code","name":"Code"},{"id":"plan","name":"Plan"}]}`, string(gotModes))
	_, err = h.SetConfigOption(ctx, &methods.ACPSetConfigOptionParams{
		ACPAgentServerParams:          methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		SetSessionConfigOptionRequest: acpsdk.SetSessionConfigOptionRequest{ValueId: &acpsdk.SetSessionConfigOptionValueId{SessionId: "created", ConfigId: "model", Value: "luna"}},
	}, newGlspContext(nil, nil))
	require.NoError(t, err)
	gotOptions, _, ok := h.SessionConfiguration(DefaultAgentServerName, "created")
	require.True(t, ok)
	assert.Contains(t, string(gotOptions), `"currentValue":"luna"`)
	published, _ := sink.snapshot()
	require.Len(t, published, 2)
	modeUpdate, ok := published[0].message["params"].(acpsdk.SessionNotification)
	require.True(t, ok)
	require.NotNil(t, modeUpdate.Update.CurrentModeUpdate)
	assert.Equal(t, acpsdk.SessionId("created"), modeUpdate.SessionId)
	assert.Equal(t, acpsdk.SessionModeId("plan"), modeUpdate.Update.CurrentModeUpdate.CurrentModeId)
	configUpdate, ok := published[1].message["params"].(acpsdk.SessionNotification)
	require.True(t, ok)
	require.NotNil(t, configUpdate.Update.ConfigOptionUpdate)
	assert.Equal(t, acpsdk.SessionId("created"), configUpdate.SessionId)
	acceptedOptions, err := json.Marshal(configUpdate.Update.ConfigOptionUpdate.ConfigOptions)
	require.NoError(t, err)
	assert.JSONEq(t, string(gotOptions), string(acceptedOptions))
	// The primary UI already consumes its own response and gets no redundant
	// synthesized update. Agent-emitted updates retain their normal path.
	require.NoError(t, h.publishControlConfiguration(context.Background(), DefaultAgentServerName, "created", configUpdate.Update, newGlspContext(nil, nil)))
	published, _ = sink.snapshot()
	assert.Len(t, published, 2)
}

func TestSessionConfigurationNotificationsAndRestartIsolation(t *testing.T) {
	cache := &sessionConfigurationCache{}
	var options []acpsdk.SessionConfigOption
	require.NoError(t, json.Unmarshal([]byte(`[{"id":"effort","name":"Effort","type":"select","currentValue":"high","options":[{"value":"high","name":"High"}]}]`), &options))
	cache.observe("parent", acpsdk.SessionUpdate{ConfigOptionUpdate: &acpsdk.SessionConfigOptionUpdate{ConfigOptions: options}})
	cache.observe("parent", acpsdk.SessionUpdate{CurrentModeUpdate: &acpsdk.SessionCurrentModeUpdate{CurrentModeId: "plan"}})
	// A load response that omits optional fields must preserve updates emitted
	// during replay, and returned bytes cannot mutate the observer's state.
	cache.capture("parent", nil, nil)
	got, mode, ok := cache.snapshot("parent")
	require.True(t, ok)
	assert.Contains(t, string(got), `"currentValue":"high"`)
	assert.JSONEq(t, `{"currentModeId":"plan"}`, string(mode))
	got[0] = 'x'
	again, _, _ := cache.snapshot("parent")
	assert.Equal(t, byte('['), again[0])
	proc := &process{configuration: cache}
	proc.mu.Lock()
	proc.resetLocked(processState{})
	proc.configuration = &sessionConfigurationCache{}
	proc.mu.Unlock()
	// Old connection callbacks retain only their invalidated generation.
	cache.observe("parent", acpsdk.SessionUpdate{ConfigOptionUpdate: &acpsdk.SessionConfigOptionUpdate{ConfigOptions: options}})
	_, _, ok = cache.snapshot("parent")
	assert.False(t, ok)
	_, _, ok = proc.configuration.snapshot("parent")
	assert.False(t, ok)
}
