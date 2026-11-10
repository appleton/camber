package handler

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	protocol "github.com/tliron/glsp/protocol_3_16"

	protocol2 "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
)

func TestApplyWorkspaceFolderChange(t *testing.T) {
	h := &CamberHandler{
		workspaceFolders: []protocol.WorkspaceFolder{
			{URI: "file:///workspace/old", Name: "old"},
			{URI: "file:///workspace/keep", Name: "keep"},
		},
	}

	h.applyWorkspaceFolderChange(&protocol2.DidChangeWorkspaceFoldersParams{
		Event: protocol2.WorkspaceFoldersChangeEvent{
			Removed: []protocol2.WorkspaceFolder{{URI: "file:///workspace/old", Name: "old"}},
			Added:   []protocol2.WorkspaceFolder{{URI: "file:///workspace/new", Name: "new"}},
		},
	})

	assert.Equal(t, []protocol.WorkspaceFolder{
		{URI: "file:///workspace/keep", Name: "keep"},
		{URI: "file:///workspace/new", Name: "new"},
	}, h.GetWorkspaceFolders())
}

func TestApplyWorkspaceFolderChangeDoesNotMutatePreviousSlices(t *testing.T) {
	h := &CamberHandler{
		workspaceFolders: []protocol.WorkspaceFolder{
			{URI: "file:///workspace/old", Name: "old"},
			{URI: "file:///workspace/keep", Name: "keep"},
		},
	}
	previous := h.GetWorkspaceFolders()

	h.applyWorkspaceFolderChange(&protocol2.DidChangeWorkspaceFoldersParams{
		Event: protocol2.WorkspaceFoldersChangeEvent{
			Removed: []protocol2.WorkspaceFolder{{URI: "file:///workspace/old", Name: "old"}},
			Added:   []protocol2.WorkspaceFolder{{URI: "file:///workspace/new", Name: "new"}},
		},
	})

	assert.Equal(t, []protocol.WorkspaceFolder{
		{URI: "file:///workspace/old", Name: "old"},
		{URI: "file:///workspace/keep", Name: "keep"},
	}, previous)
}

func TestClientSupportsWatchedFiles(t *testing.T) {
	assert.False(t, clientSupportsWatchedFiles(&protocol.InitializeParams{}))

	var params protocol.InitializeParams
	assert.NoError(t, json.Unmarshal([]byte(`{
		"capabilities": {
			"workspace": {
				"didChangeWatchedFiles": {
					"dynamicRegistration": true
				}
			}
		}
	}`), &params))
	assert.True(t, clientSupportsWatchedFiles(&params))
}
