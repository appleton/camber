package methods

import "encoding/json"

type ElicitationMode string

const (
	ElicitationModeForm ElicitationMode = "form"
	ElicitationModeURL  ElicitationMode = "url"
)

type ElicitationRequest struct {
	SessionID       string          `json:"sessionId,omitempty"`
	Mode            ElicitationMode `json:"mode"`
	Message         string          `json:"message"`
	ElicitationID   string          `json:"elicitationId"`
	RequestedSchema json.RawMessage `json:"requestedSchema,omitempty"`
	URL             string          `json:"url,omitempty"`
	Meta            map[string]any  `json:"_meta,omitempty"`
}

type ElicitationAction string

const (
	ElicitationActionAccept  ElicitationAction = "accept"
	ElicitationActionDecline ElicitationAction = "decline"
	ElicitationActionCancel  ElicitationAction = "cancel"
)

type ElicitationResponse struct {
	Action  ElicitationAction `json:"action"`
	Content map[string]any    `json:"content,omitempty"`
}
