package control

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestConfigurationRecoveryBeforeDiscoveryUpdateAndSend(t *testing.T) {
	for _, action := range []string{"chat.config.list", "chat.config.set", "chat.send"} {
		t.Run(action, func(t *testing.T) {
			s, base := fixture(t)
			agent := &configurationRecoveryAgent{fakeAgent: base, modes: recoveryModes()}
			s.agent = agent
			setRecoveryParent(t, s)

			args := Args{ConversationID: "parent", Text: "continue"}
			if action == "chat.config.set" {
				args.Config = map[string]any{"toggle": false}
			}
			out := invoke(t, s, action, args)
			if action != "chat.send" {
				options, err := json.Marshal(out["configOptions"])
				require.NoError(t, err)
				values := recoveryValues(options)
				assert.Equal(t, "large", values["model"])
				assert.Equal(t, "high", values["reasoning_effort"])
				assert.Equal(t, action != "chat.config.set", values["toggle"])
				assert.Equal(t, "plan", out["modes"].(map[string]any)["currentModeId"])
				out = invoke(t, s, "chat.send", Args{ConversationID: "parent", Text: "continue"})
			}
			select {
			case <-base.started:
			case <-time.After(time.Second):
				require.FailNow(t, "continuation did not start")
			}
			base.mu.Lock()
			calls := append([]string(nil), base.calls...)
			effective := recoveryValues(base.options)
			base.mu.Unlock()
			assert.Equal(t, 1, agent.loads, "reading settings must not prevent restoration or cause another reload")
			assert.Equal(t, "large", effective["model"])
			assert.Equal(t, "high", effective["reasoning_effort"])
			assert.Equal(t, action != "chat.config.set", effective["toggle"])
			require.NotEmpty(t, calls)
			assert.Equal(t, "load", calls[0])
			assert.Equal(t, "prompt", calls[len(calls)-1])

			stored, err := s.view(context.Background(), "parent", nil)
			require.NoError(t, err)
			saved, found, err := savedConfiguration(stored.Metadata)
			require.NoError(t, err)
			require.True(t, found)
			assert.Equal(t, effective, saved.Config)
			assert.Equal(t, "plan", saved.Mode)
			assert.Contains(t, string(stored.Metadata), `"keep"`)
			finishRecoveryTurn(t, s, base, "parent")
		})
	}
}

func TestConfigurationRecoveryUsesLiveValuesWithoutReload(t *testing.T) {
	s, base := fixture(t)
	agent := &configurationRecoveryAgent{fakeAgent: base, live: true, modes: recoveryModes()}
	s.agent = agent
	setRecoveryParent(t, s)
	out := invoke(t, s, "chat.config.list", Args{ConversationID: "parent"})
	options, err := json.Marshal(out["configOptions"])
	require.NoError(t, err)
	assert.Equal(t, "small", recoveryValues(options)["model"])
	assert.Zero(t, agent.loads)
}

func TestFailedConfigurationRecoveryPreservesSelectionsAndBlocksSend(t *testing.T) {
	for _, unavailable := range []string{"model", "reasoning_effort"} {
		t.Run(unavailable, func(t *testing.T) {
			s, base := fixture(t)
			var options []map[string]any
			require.NoError(t, json.Unmarshal(testOptions, &options))
			for _, o := range options {
				if o["id"] == unavailable {
					o["options"] = []map[string]any{{"value": o["currentValue"], "name": "Default"}}
				}
			}
			loadOptions, err := json.Marshal(options)
			require.NoError(t, err)
			agent := &configurationRecoveryAgent{fakeAgent: base, loadOptions: loadOptions}
			s.agent = agent
			setRecoveryParent(t, s)
			before, err := s.view(context.Background(), "parent", nil)
			require.NoError(t, err)
			before.ConfigOptions, before.Modes = testOptions, recoveryModes()
			require.NoError(t, s.save(context.Background(), before))

			// Each failed action must preserve the saved target, even when the
			// model was already applied before validating dependent selections.
			for i, action := range []string{"chat.config.list", "chat.config.set", "chat.send", "chat.send"} {
				raw, err := json.Marshal(Args{ConversationID: "parent", Text: "continue", Config: map[string]any{"toggle": false}})
				require.NoError(t, err)
				_, err = s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: action, Args: raw}, nil)
				require.ErrorContains(t, err, "unsupported value for configuration option "+unavailable)
				after, err := s.view(context.Background(), "parent", nil)
				require.NoError(t, err)
				assert.JSONEq(t, string(before.Metadata), string(after.Metadata))
				assert.JSONEq(t, string(before.ConfigOptions), string(after.ConfigOptions))
				assert.JSONEq(t, string(before.Modes), string(after.Modes))
				_, _, live := agent.SessionConfiguration(before.AgentServer, before.SessionID)
				assert.False(t, live, "a partial restoration must not be usable by the next send")
				assert.Equal(t, i+1, agent.loads, "every retry must reload and reapply the saved selections")
				assert.False(t, agent.reserved)
			}
			base.mu.Lock()
			calls := append([]string(nil), base.calls...)
			base.mu.Unlock()
			assert.NotContains(t, calls, "prompt")
			if unavailable == "reasoning_effort" {
				assert.Contains(t, calls, "set:model", "exercise failure after the recursive model update")
			}

			// Once the agent supports the saved selections again, the same
			// conversation recovers without losing any of the user's choices.
			agent.loadOptions = nil
			invoke(t, s, "chat.send", Args{ConversationID: "parent", Text: "continue"})
			select {
			case <-base.started:
			case <-time.After(time.Second):
				require.FailNow(t, "recovered continuation did not start")
			}
			optionsRaw, modes, live := agent.SessionConfiguration(before.AgentServer, before.SessionID)
			require.True(t, live)
			assert.Equal(t, map[string]any{"model": "large", "reasoning_effort": "high", "toggle": true}, recoveryValues(optionsRaw))
			var mode struct {
				Current string `json:"currentModeId"`
			}
			require.NoError(t, json.Unmarshal(modes, &mode))
			assert.Equal(t, "plan", mode.Current)
			finishRecoveryTurn(t, s, base, "parent")
		})
	}
}

func TestSpawnInheritsSavedParentConfiguration(t *testing.T) {
	for _, scenario := range []string{"saved", "explicit", "other_agent", "live_parent"} {
		t.Run(scenario, func(t *testing.T) {
			s, base := fixture(t)
			agent := &configurationRecoveryAgent{fakeAgent: base, modes: recoveryModes(), modelDependent: true}
			s.agent = agent
			setRecoveryParent(t, s)
			// The old CLI record can disagree with a newer UI selection. Saved
			// navigation metadata wins when there is no live parent session.
			parent, err := s.view(context.Background(), "parent", nil)
			require.NoError(t, err)
			parent.ConfigOptions = testOptions
			require.NoError(t, s.save(context.Background(), parent))
			args := Args{ParentID: "parent", Text: "child task"}
			wantModel, wantEffort, wantMode, wantToggle := "large", "high", "plan", true
			switch scenario {
			case "explicit":
				args.Model, args.Effort, args.Mode = "small", "medium", "code"
				args.Config = map[string]any{"toggle": false}
				wantModel, wantEffort, wantMode, wantToggle = "small", "medium", "code", false
			case "other_agent":
				args.AgentServer = "other"
				wantModel, wantEffort, wantMode, wantToggle = "small", "medium", "code", false
			case "live_parent":
				agent.parentOptions = testOptions
				wantModel, wantEffort, wantMode, wantToggle = "small", "medium", "code", false
			}
			out := invoke(t, s, "chat.spawn", args)
			id := out["conversation"].(map[string]any)["id"].(string)
			select {
			case <-base.started:
			case <-time.After(time.Second):
				require.FailNow(t, "child did not start")
			}
			base.mu.Lock()
			values := recoveryValues(base.options)
			base.mu.Unlock()
			assert.Equal(t, wantModel, values["model"])
			assert.Equal(t, wantEffort, values["reasoning_effort"])
			assert.Equal(t, wantToggle, values["toggle"])
			var modes struct {
				Current string `json:"currentModeId"`
			}
			require.NoError(t, json.Unmarshal(agent.modes, &modes))
			assert.Equal(t, wantMode, modes.Current)
			assert.Zero(t, agent.loads, "inheritance must not load or disturb the parent")
			finishRecoveryTurn(t, s, base, id)
		})
	}
}

func setRecoveryParent(t *testing.T, s *Service) {
	t.Helper()
	v, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	v.SessionID = "parent-session"
	v.Metadata = json.RawMessage(`{"explored":["keep"],"sessionConfig":{"selections":{"model":"large","reasoning_effort":"high","toggle":true},"modeId":"plan"}}`)
	_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, nil)
	require.NoError(t, err)
}

func finishRecoveryTurn(t *testing.T, s *Service, base *fakeAgent, id string) {
	t.Helper()
	close(base.finish)
	require.Eventually(t, func() bool {
		v, err := s.view(context.Background(), id, nil)
		return err == nil && v.Status == "completed"
	}, time.Second, 10*time.Millisecond)
}

func recoveryValues(raw json.RawMessage) map[string]any {
	values := map[string]any{}
	for _, o := range parseOptions(raw) {
		values[o.ID] = o.Current
	}
	return values
}

func recoveryModes() json.RawMessage {
	return json.RawMessage(`{"currentModeId":"code","availableModes":[{"id":"code","name":"Code"},{"id":"plan","name":"Plan"}]}`)
}

type configurationRecoveryAgent struct {
	*fakeAgent
	live           bool
	reserved       bool
	loads          int
	loadOptions    json.RawMessage
	modes          json.RawMessage
	parentOptions  json.RawMessage
	modelDependent bool
}

func (a *configurationRecoveryAgent) ReserveIdleSession(context.Context, string, string) (func(), error) {
	if a.reserved {
		return nil, errors.New("nested idle reservation")
	}
	a.reserved = true
	return func() { a.reserved = false }, nil
}

func (a *configurationRecoveryAgent) SessionConfiguration(_, session string) (json.RawMessage, json.RawMessage, bool) {
	if session == "parent-session" && a.parentOptions != nil {
		return a.parentOptions, recoveryModes(), true
	}
	if !a.live {
		return nil, nil, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return append(json.RawMessage(nil), a.options...), append(json.RawMessage(nil), a.modes...), true
}

func (a *configurationRecoveryAgent) InvalidateSessionConfiguration(string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.live = false
}

func (a *configurationRecoveryAgent) LoadSession(context.Context, *methods.ACPLoadSessionParams, *glsp.Context) (*methods.ACPLoadSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.loads++
	a.live = true
	a.calls = append(a.calls, "load")
	a.options = testOptions
	if a.loadOptions != nil {
		a.options = a.loadOptions
	}
	a.modes = recoveryModes()
	var out methods.ACPLoadSessionOutput
	raw, err := json.Marshal(map[string]any{"configOptions": a.options, "modes": a.modes})
	if err == nil {
		err = json.Unmarshal(raw, &out)
	}
	return &out, err
}

func (a *configurationRecoveryAgent) NewSession(ctx context.Context, p *methods.ACPNewSessionParams, g *glsp.Context) (*methods.ACPNewSessionOutput, error) {
	if a.modelDependent {
		var opts []map[string]any
		if err := json.Unmarshal(a.options, &opts); err != nil {
			return nil, err
		}
		for _, o := range opts {
			if o["id"] == "reasoning_effort" {
				o["options"] = []map[string]string{{"value": "medium", "name": "Medium"}}
			}
		}
		a.options, _ = json.Marshal(opts)
	}
	out, err := a.fakeAgent.NewSession(ctx, p, g)
	if err == nil {
		err = json.Unmarshal(a.modes, &out.Modes)
	}
	return out, err
}

func (a *configurationRecoveryAgent) SetConfigOption(ctx context.Context, p *methods.ACPSetConfigOptionParams, g *glsp.Context) (*methods.ACPSetConfigOptionOutput, error) {
	out, err := a.fakeAgent.SetConfigOption(ctx, p, g)
	if err != nil || !a.modelDependent {
		return out, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var opts []map[string]any
	if err = json.Unmarshal(a.options, &opts); err != nil {
		return nil, err
	}
	if recoveryValues(a.options)["model"] == "large" {
		for _, o := range opts {
			if o["id"] == "reasoning_effort" {
				o["options"] = []map[string]string{{"value": "medium", "name": "Medium"}, {"value": "high", "name": "High"}}
			}
		}
	}
	a.options, err = json.Marshal(opts)
	if err == nil {
		err = json.Unmarshal([]byte(`{"configOptions":`+string(a.options)+`}`), out)
	}
	return out, err
}

func (a *configurationRecoveryAgent) SetMode(_ context.Context, p *methods.ACPSetModeParams, _ *glsp.Context) (*methods.ACPSetModeOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "set:mode")
	var modes map[string]any
	if err := json.Unmarshal(a.modes, &modes); err != nil {
		return nil, err
	}
	modes["currentModeId"] = p.ModeId
	var err error
	a.modes, err = json.Marshal(modes)
	return &methods.ACPSetModeOutput{}, err
}
