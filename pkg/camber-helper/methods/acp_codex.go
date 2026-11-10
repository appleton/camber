package methods

import acpsdk "github.com/coder/acp-go-sdk"

const (
	ACPCodexGoalControlExtensionMethod = "_codex/session/goal_control"
	ACPCodexGoalControlMethod          = acpMethodPrefix + ACPCodexGoalControlExtensionMethod
)

type ACPCodexGoalControlAction string

const (
	ACPCodexGoalControlPause ACPCodexGoalControlAction = "pause"
	ACPCodexGoalControlClear ACPCodexGoalControlAction = "clear"
)

type ACPCodexGoalControlRequest struct {
	SessionID acpsdk.SessionId          `json:"sessionId"`
	Action    ACPCodexGoalControlAction `json:"action"`
}

type ACPCodexGoalControlParams struct {
	ACPAgentServerParams
	ACPCodexGoalControlRequest
}

type ACPCodexGoalControlOutput struct{}
