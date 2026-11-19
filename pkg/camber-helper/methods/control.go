package methods

import "encoding/json"

const ControlDispatchMethod = "camber/control/dispatch"

// ControlDispatchParams invokes a discoverable desktop orchestration action.
type ControlDispatchParams struct {
	Command string          `json:"command" doc:"Action name, discoverable through actions.list"`
	Args    json.RawMessage `json:"args,omitempty" doc:"Action arguments"`
	// CallerToken proves the issuing conversation; agents receive it in their
	// per-prompt host context. Absent or unknown tokens prove nothing.
	CallerToken string `json:"callerToken,omitempty" doc:"Caller token from the issuing conversation's Camber host context"`
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
