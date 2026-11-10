package methods

import "encoding/json"

const (
	// ACPClaudeSDKMessageMethod is Claude Code's ACP extension notification for
	// forwarding selected raw Agent SDK messages to the client.
	ACPClaudeSDKMessageMethod = "_claude/sdkMessage"

	ACPClaudeSDKPromptSuggestionType = "prompt_suggestion"
	ACPClaudeSDKActiveGoalType       = "active_goal"
)

type ACPClaudeSDKMessageNotification struct {
	SessionID string                    `json:"sessionId"`
	Message   ACPClaudeSDKPromptMessage `json:"message"`
}

type ACPClaudeSDKPromptMessage struct {
	Type       string          `json:"type"`
	Suggestion string          `json:"suggestion"`
	UUID       string          `json:"uuid"`
	SessionID  string          `json:"session_id"`
	Value      json.RawMessage `json:"value,omitempty"`
}

type ACPClaudeSDKActiveGoal struct {
	Condition     string   `json:"condition"`
	Iterations    *int     `json:"iterations"`
	SetAt         *float64 `json:"set_at"`
	TokensAtStart *float64 `json:"tokens_at_start"`
	LastReason    string   `json:"last_reason,omitempty"`
}
