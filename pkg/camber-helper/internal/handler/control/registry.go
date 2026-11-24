package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sort"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

// RegisteredAction is a control action implemented outside the core dispatch
// switch. Each area (conversation management, agents and tools, ...) registers
// its actions from its own file with registerAction, decodes its own
// arguments, and describes its own input schema.
type RegisteredAction struct {
	// Summary is the one-line description shown by actions.list/describe.
	Summary string
	// InputSchema is the JSON schema of the action's arguments object.
	InputSchema map[string]any
	// Run executes the action. raw is the arguments object (may be empty);
	// caller is the token-proven calling conversation, or "".
	Run func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error)
}

var registeredActions = map[string]RegisteredAction{}

// registerAction adds an action at package init. Names must be unique and must
// not shadow a core action.
func registerAction(name string, action RegisteredAction) {
	if _, dup := registeredActions[name]; dup {
		panic("control: duplicate registered action " + name)
	}
	for _, core := range coreCommands {
		if core == name {
			panic("control: registered action shadows core action " + name)
		}
	}
	if action.InputSchema == nil {
		action.InputSchema = map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}
	}
	registeredActions[name] = action
}

// allCommands lists core actions followed by registered ones in name order.
func allCommands() []string {
	names := make([]string, 0, len(registeredActions))
	for name := range registeredActions {
		names = append(names, name)
	}
	sort.Strings(names)
	return append(append([]string{}, coreCommands...), names...)
}

// decodeActionArgs strictly decodes a registered action's arguments into dst:
// unknown fields and trailing data are rejected, and empty input leaves dst
// zero-valued.
func decodeActionArgs(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return pkgerrors.Wrap(err, "invalid control arguments")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return pkgerrors.Errorf("arguments must contain one JSON object")
	}
	return nil
}

// objectSchema builds an input schema from property schemas and required names.
func objectSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}
