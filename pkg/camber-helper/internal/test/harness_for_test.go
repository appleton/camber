package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pkgerrors "github.com/pkg/errors"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/sourcegraph/jsonrpc2"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	jsonrpc3 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2/servertest"
	fake2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/test/integration/fake"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler"
	"github.com/appleton/camber/pkg/camber-helper/server"
)

// creates a fake editor and sandbox connected to provided handler and API, with provided files
func testHarness(
	t *testing.T,
	handlerV *handler.CamberHandler,
	apiMock *httptest.Server,
	files map[string][]byte,
) (*fake2.Sandbox, *fake2.Editor) {
	ts := createTestServer(t, handlerV)

	ctx := context.Background()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	sb, err := fake2.NewSandbox(&fake2.SandboxConfig{
		Files: files,
	})
	require.NoError(t, err)

	ed1, err := fake2.NewEditor(sb, fake2.EditorConfig{
		// TODO audit all usages of editor-provided language IDs
		// N.B. without this language params will not be set in Fake-sent LSP messages
		FileAssociations: map[string]string{
			"python": ".+\\.py",
			"go":     ".+\\.go",
		},
	}).Connect(ctx, ts, fake2.ClientHooks{})
	require.NoError(t, err)

	err = ed1.Server.DidChangeConfiguration(ctx, &protocol.DidChangeConfigurationParams{
		Settings: map[string]interface{}{
			"token":  "aa-bb-fake-token",
			"apiUrl": apiMock.URL,
		},
	})
	require.NoError(t, err)

	return sb, ed1
}

func createTestServer(t *testing.T, plsHelper *handler.CamberHandler) *servertest.PipeServer {
	lspServer, _ := server.New(plsHelper)

	server := jsonrpc3.HandlerServer(func(ctx context.Context, reply jsonrpc3.Replier, req jsonrpc3.Request) error {
		res, validMethod, validParams, err := lspServer.Handler.Handle(&glsp.Context{
			Method: req.Method(),
			Params: req.Params(),
			Notify: func(ctx context.Context, method string, params any) error {
				t.Log("jsonrpc notify", method, params)
				return nil
			},
			Call: func(ctx context.Context, method string, params any, result any) error {
				t.Log("jsonrpc call", method, params)
				return nil
			},
			RequestID: jsonrpc2.ID{},
		})
		if !validMethod {
			return jsonrpc3.MethodNotFound(ctx, reply, req)
		}
		if !validParams {
			return pkgerrors.WithStack(jsonrpc3.ErrInvalidParams)
		}
		if err != nil {
			reply(ctx, nil, err)
			return nil
		}
		reply(ctx, res, nil)
		return nil
	})
	ts := servertest.NewPipeServer(server, nil)
	return ts
}

func createAPIMock(pathHandlers map[string]func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	apiMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if a custom handler exists for this path
		if handler, exists := pathHandlers[r.URL.Path]; exists {
			handler(w, r)
			return
		}

		if strings.HasPrefix(r.URL.Path, "/v0/events") {
			w.WriteHeader(204)
			return
		}

		w.WriteHeader(404)
	}))
	return apiMock
}
