package control

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"
)

func TestRegisteredActionDecodeAndDescribe(t *testing.T) {
	type args struct {
		Name string `json:"name"`
	}
	var got args
	require.NoError(t, decodeActionArgs(json.RawMessage(`{"name":"x"}`), &got))
	assert.Equal(t, "x", got.Name)
	assert.Error(t, decodeActionArgs(json.RawMessage(`{"other":1}`), &got))
	assert.Error(t, decodeActionArgs(json.RawMessage(`{} {}`), &got))
	assert.NoError(t, decodeActionArgs(nil, &got))

	registerAction("test.echo", RegisteredAction{
		Summary:     "Echo a name.",
		InputSchema: objectSchema(map[string]any{"name": map[string]any{"type": "string"}}, "name"),
		Run: func(_ context.Context, _ *Service, raw json.RawMessage, caller string, _ *glsp.Context) (any, error) {
			var a args
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return map[string]string{"name": a.Name, "caller": caller}, nil
		},
	})
	t.Cleanup(func() { delete(registeredActions, "test.echo") })
	assert.Contains(t, allCommands(), "test.echo")
	s := &Service{}
	desc, err := s.describe("test.echo")
	require.NoError(t, err)
	assert.Equal(t, "Echo a name.", desc.(actionDescription).Summary)
	assert.Panics(t, func() { registerAction("chat.send", RegisteredAction{}) })
}
