package mcpservers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mcpHTTPHandler returns an httptest handler that speaks a minimal MCP server:
// initialize -> result, notifications/initialized -> 202, tools/list -> tools.
// When sse is true, tools/list is returned as a text/event-stream body.
func mcpHTTPHandler(tools []string, sse bool, onReq func(r *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if onReq != nil {
			onReq(r)
		}
		body, _ := io.ReadAll(r.Body)
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(body, &req)
		w.Header().Set("Mcp-Session-Id", "sess-1")

		switch req.Method {
		case "initialize":
			writeJSONRPCResult(w, req.ID, map[string]any{"protocolVersion": "2024-11-05"})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			toolObjs := make([]map[string]any, 0, len(tools))
			for _, n := range tools {
				toolObjs = append(toolObjs, map[string]any{"name": n})
			}
			result := map[string]any{"tools": toolObjs}
			if sse {
				w.Header().Set("Content-Type", "text/event-stream")
				payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
				_, _ = w.Write([]byte("event: message\ndata: " + string(payload) + "\n\n"))
				return
			}
			writeJSONRPCResult(w, req.ID, result)
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	})
}

func writeJSONRPCResult(w http.ResponseWriter, id int, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func TestProbeHTTP_JSONListsTools(t *testing.T) {
	srv := httptest.NewServer(mcpHTTPHandler([]string{"alpha", "beta"}, false, nil))
	defer srv.Close()

	res := ProbeServer(context.Background(), mcpProbeEntry{Name: "x", URL: srv.URL})
	require.True(t, res.OK, "probe error: %s", res.Error)
	assert.Equal(t, 2, res.ToolCount)
	assert.ElementsMatch(t, []string{"alpha", "beta"}, res.ToolNames)
}

func TestProbeHTTP_SSEListsTools(t *testing.T) {
	srv := httptest.NewServer(mcpHTTPHandler([]string{"only"}, true, nil))
	defer srv.Close()

	res := ProbeServer(context.Background(), mcpProbeEntry{Name: "x", URL: srv.URL})
	require.True(t, res.OK, "probe error: %s", res.Error)
	assert.Equal(t, []string{"only"}, res.ToolNames)
}

func TestProbeHTTP_ManagedBearerOverridesUserAuthHeader(t *testing.T) {
	var lastAuth string
	srv := httptest.NewServer(mcpHTTPHandler(nil, false, func(r *http.Request) {
		lastAuth = r.Header.Get("Authorization")
	}))
	defer srv.Close()

	ProbeServer(context.Background(), mcpProbeEntry{
		Name:        "x",
		URL:         srv.URL,
		Headers:     map[string]string{"Authorization": "Bearer user-supplied"},
		BearerToken: "managed-token",
	})
	assert.Equal(t, "Bearer managed-token", lastAuth)
}

func TestProbeHTTP_ErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	res := ProbeServer(context.Background(), mcpProbeEntry{Name: "x", URL: srv.URL})
	assert.False(t, res.OK)
	assert.NotEmpty(t, res.Error)
}

func TestProbeServer_NoTransport(t *testing.T) {
	res := ProbeServer(context.Background(), mcpProbeEntry{Name: "x"})
	assert.False(t, res.OK)
	assert.NotEmpty(t, res.Error)
}

// A plain endpoint that answers 200 with a non-MCP body must not be reported as
// a working MCP server just because it didn't error.
func TestProbeHTTP_Non_MCPEndpointNotOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("hello, not mcp"))
	}))
	defer srv.Close()

	res := ProbeServer(context.Background(), mcpProbeEntry{Name: "x", URL: srv.URL})
	assert.False(t, res.OK, "plain 200 endpoint must not pass as an MCP server")
	assert.NotEmpty(t, res.Error)
}

func TestParseSSEForID(t *testing.T) {
	body := []byte("event: message\n" +
		`data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}` + "\n\n" +
		`data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}` + "\n\n")

	resp := parseSSEForID(body, 2)
	require.NotNil(t, resp)
	assert.Equal(t, 2, resp.ID)

	assert.Nil(t, parseSSEForID(body, 99))
}
