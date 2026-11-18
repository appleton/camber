package acpproxy

import (
	"context"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSessionManagementCapabilities(t *testing.T) {
	h := &Handler{procs: map[string]*process{}}
	assert.Equal(t, SessionManagementCapabilities{}, h.SessionManagementCapabilities("agent"), "an agent that never initialized is unknown")

	h.procs["agent"] = &process{initResp: &acpsdk.InitializeResponse{AgentCapabilities: acpsdk.AgentCapabilities{
		Meta:                map[string]any{"rename_session": true},
		SessionCapabilities: acpsdk.SessionCapabilities{Delete: &acpsdk.SessionDeleteCapabilities{}},
	}}}
	assert.Equal(t, SessionManagementCapabilities{Known: true, Rename: true, Delete: true}, h.SessionManagementCapabilities("agent"))

	h.procs["plain"] = &process{initResp: &acpsdk.InitializeResponse{}}
	assert.Equal(t, SessionManagementCapabilities{Known: true}, h.SessionManagementCapabilities("plain"))
}

func TestCancelInFlightTurnWithoutPromptIsNoop(t *testing.T) {
	h := &Handler{procs: map[string]*process{}, promptsInFlight: map[promptSessionKey]*activeTurn{}}
	require.NoError(t, h.CancelInFlightTurn(context.Background(), "agent", "s-1", nil))
}
