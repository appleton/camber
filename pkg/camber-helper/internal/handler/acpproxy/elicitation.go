package acpproxy

import (
	"encoding/json"
	"fmt"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// elicitationRequestFromStandard converts a standard elicitation/create
// request into the helper's internal shape, which the pool extension
// elicitation already uses. Form-mode requests carry no id on the wire, so
// one is synthesized to key the approval store entry.
func elicitationRequestFromStandard(params acpsdk.UnstableCreateElicitationRequest) (methods.ElicitationRequest, error) {
	switch {
	case params.Form != nil:
		// The wire bytes carry the agent's property order, which surfaces use
		// as the form's field order; re-marshalling the typed schema would
		// sort it away. Requests built in-process have no raw bytes.
		schema := params.Form.RequestedSchemaRaw
		if schema == nil {
			marshalled, err := json.Marshal(params.Form.RequestedSchema)
			if err != nil {
				return methods.ElicitationRequest{}, fmt.Errorf("acpproxy: marshal elicitation schema: %w", err)
			}
			schema = marshalled
		}
		return methods.ElicitationRequest{
			SessionID:       string(params.Form.SessionId),
			Mode:            methods.ElicitationModeForm,
			Message:         params.Form.Message,
			ElicitationID:   uuid.NewString(),
			RequestedSchema: schema,
			Meta:            params.Form.Meta,
		}, nil
	case params.Url != nil:
		return methods.ElicitationRequest{
			SessionID:     string(params.Url.SessionId),
			Mode:          methods.ElicitationModeURL,
			Message:       params.Url.Message,
			ElicitationID: string(params.Url.ElicitationId),
			URL:           params.Url.Url,
			Meta:          params.Url.Meta,
		}, nil
	default:
		return methods.ElicitationRequest{}, fmt.Errorf("acpproxy: elicitation request without form or url variant")
	}
}

// standardElicitationResponse converts the approval store's answer back into
// the standard elicitation/create response union.
func standardElicitationResponse(out methods.ACPElicitationOutput) acpsdk.UnstableCreateElicitationResponse {
	switch out.Action {
	case methods.ElicitationActionAccept:
		resp := acpsdk.NewUnstableCreateElicitationResponseAccept()
		resp.Accept.Content = out.Content
		return resp
	case methods.ElicitationActionDecline:
		return acpsdk.NewUnstableCreateElicitationResponseDecline()
	default:
		return acpsdk.NewUnstableCreateElicitationResponseCancel()
	}
}
