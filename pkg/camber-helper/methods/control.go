package methods

import "encoding/json"

const ControlDispatchMethod = "camber/control/dispatch"

// ControlDispatchParams invokes a discoverable desktop orchestration action.
type ControlDispatchParams struct {
	Command string          `json:"command" doc:"Action name, discoverable through actions.list"`
	Args    json.RawMessage `json:"args,omitempty" doc:"Action arguments"`
}

type ControlDispatchOutput = json.RawMessage

// ControlObservedTurn describes a retained helper-owned turn independently of
// which surface started it or which turn is currently running in the session.
type ControlObservedTurn struct {
	TurnID   string
	Status   string
	Epoch    string
	StartSeq int64
	EndSeq   int64
	Finished bool
	Result   *ACPPromptOutput
	Error    string
}
