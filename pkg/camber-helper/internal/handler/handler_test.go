package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/internal/lsptest"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestJSONRPC(t *testing.T) {
	h := New()
	h.config = &Config{
		AssistantEnvironment: string(methods.DevelopmentEnv),
	}
	h.SetInitialized(true)

	registerJSONRPCMethod(h, JSONRPCOperation{
		Method: "test/panic",
	}, func(ctx context.Context, req *int, lspReq *glsp.Context) (any, error) {
		panic("BOOM")
	})
	registerJSONRPCMethod(h, JSONRPCOperation{
		Method: "test/error",
	}, func(ctx context.Context, req *int, lspReq *glsp.Context) (any, error) {
		return nil, errors.New("test error")
	})
	registerJSONRPCMethod(h, JSONRPCOperation{
		Method: "test/error-data",
	}, func(ctx context.Context, req *int, lspReq *glsp.Context) (any, error) {
		wireErr := &jsonrpc2.WireError{
			Code:    jsonrpc2.CodeInternalError,
			Message: "Internal error",
		}
		wireErr.SetError(map[string]any{
			"error":   "loaded session does not exist",
			"details": []string{"session-1", "workspace-a"},
		})
		return nil, wireErr
	})

	t.Run("valid requests are handled", func(t *testing.T) {
		r, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/hello",
			mustJSON(t, &HelloIn{
				Ping: "input",
			}),
		))

		require.NoError(t, err)
		assert.True(t, validMethod)
		assert.True(t, validParams)

		out, ok := r.(*HelloOut)
		require.True(t, ok)

		assert.Equal(t, out.Pong, "input")
	})

	// trigger max length violation
	invalidHelloBody :=
		mustJSON(t, map[string]any{
			"ping": strings.Repeat("hello", (128/5)+1),
		})

	t.Run("request bodies are validated", func(t *testing.T) {
		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/hello",
			invalidHelloBody,
		))

		require.ErrorContains(t, err, "expected length <= 128")
		assert.False(t, validParams)
		assert.True(t, validMethod)
	})

	t.Run("in production, request bodies are not validated", func(t *testing.T) {
		h := New()
		h.config = &Config{
			AssistantEnvironment: string(methods.AssistantEnvironment("production")),
		}
		h.SetInitialized(true)
		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/hello",
			invalidHelloBody,
		))

		assert.True(t, validMethod)
		assert.True(t, validParams)
		require.NoError(t, err)
	})

	t.Run("request bodies with unexpected fields error as usual", func(t *testing.T) {
		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/hello",
			mustJSON(t, map[string]any{
				"ping":  42,
				"extra": 42,
			})),
		)

		require.ErrorContains(t, err, "expected string (ping: 42)")
		assert.False(t, validParams)
		assert.True(t, validMethod)
	})

	t.Run("missing methods return invalid method, but no error", func(t *testing.T) {
		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/i_am_a_teapot",
			mustJSON(t, map[string]any{}),
		))

		assert.NoError(t, err)
		assert.False(t, validParams)
		assert.False(t, validMethod)
	})

	t.Run("panics are recovered and logged", func(t *testing.T) {
		tlog := testLogger()

		_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"test/panic",
			mustJSON(t, 42),
		))
		require.True(t, validMethod, "expected valid method")
		assert.Error(t, err)

		assert.Contains(t, tlog.String(), `error="panic with value: BOOM`)
	})

	t.Run("errors are logged", func(t *testing.T) {
		tlog := testLogger()

		_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"test/error",
			mustJSON(t, 42),
		))
		require.True(t, validMethod, "expected valid method")
		assert.Error(t, err)

		assert.Contains(t, tlog.String(), `error="jsonrpc2: code -32603 message: test error`)
	})

	t.Run("jsonrpc error data is logged", func(t *testing.T) {
		tlog := testLogger()

		_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"test/error-data",
			mustJSON(t, 42),
		))
		require.True(t, validMethod, "expected valid method")
		assert.Error(t, err)

		assert.Contains(t, tlog.String(), `error="jsonrpc2: code -32603 message: Internal error`)
		assert.Contains(t, tlog.String(), `error_data="{\"details\":[\"session-1\",\"workspace-a\"],\"error\":\"loaded session does not exist\"}"`)
	})

	t.Run("non-errors are logged", func(t *testing.T) {
		tlog := testLogger()

		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"camber/hello",
			mustJSON(t, &HelloIn{
				Ping: "input",
			})))
		require.NoError(t, err)
		require.True(t, validMethod && validParams, "expected valid call")

		assert.Contains(t, tlog.String(), "method=camber/hello error=<nil>")
	})

	t.Run("successful acp nav list requests are silent", func(t *testing.T) {
		tlog := testLogger()
		h := New()
		h.SetInitialized(true)
		h.extensionHandlers[methods.ACPNavListMethod] = func(ctx context.Context, req *glsp.Context) (any, error) {
			return methods.ACPNavState{}, nil
		}

		_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			methods.ACPNavListMethod,
			mustJSON(t, &methods.ACPNavListParams{}),
		))
		require.NoError(t, err)
		require.True(t, validMethod && validParams, "expected valid call")

		assert.NotContains(t, tlog.String(), methods.ACPNavListMethod)
	})
}

func TestJSONRPC_Cancellation(t *testing.T) {

	t.Run("in-flight requests are aborted", func(t *testing.T) {
		tlog := testLogger()

		h := New()
		h.SetInitialized(true)

		started := make(chan struct{})
		registerJSONRPCMethod(h, JSONRPCOperation{
			Method: "test/blockForAges",
		}, func(ctx context.Context, req *int, lspReq *glsp.Context) (any, error) {
			close(started)
			select {
			case <-ctx.Done():
				return nil, nil
			case <-time.After(60 * time.Second):
				return nil, errors.New("should not have completed")
			}
		})

		done := make(chan struct{})
		go func() {
			_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethodWithRequestID(t,
				"test/blockForAges",
				mustJSON(t, 99),
				42,
			))
			assert.True(t, validMethod, "expected valid method")
			assert.NoError(t, err)
			close(done)
		}()

		<-started
		_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
			"$/cancelRequest",
			mustJSON(t, map[string]any{"id": 42}),
		))
		require.True(t, validMethod, "expected valid method")
		assert.NoError(t, err)

		assert.Contains(t, tlog.String(), `cancel`)

		select {
		case <-done:

		case <-time.After(10 * time.Millisecond):
			t.Errorf("should have been cancelled")
		}
	})

	t.Run("request that have not yet started are immediately aborted on start", func(t *testing.T) {
		tlog := testLogger()

		h := New()
		h.SetInitialized(true)

		started := atomic.Int64{}
		registerJSONRPCMethod(h, JSONRPCOperation{
			Method: "test/blockForAges",
		}, func(ctx context.Context, req *int, lspReq *glsp.Context) (any, error) {
			started.Add(1)
			select {
			case <-ctx.Done():
				return nil, nil
			case <-time.After(time.Second * 2):
				t.Errorf("unexpectedly uncancelled %s", lspReq.RequestID.String())
				return nil, errors.New("should not have completed")
			}
		})

		rids := []int{}
		n := 50
		for i := range n {
			rids = append(rids, i+1)
		}

		nextCancelRequestID := 10000
		for i, rid := range rids {
			// cancel half ahead of time
			if i%2 == 0 {
				continue
			}
			nextCancelRequestID++
			_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethodWithRequestID(t,
				"$/cancelRequest",
				mustJSON(t, map[string]any{"id": rid}),
				nextCancelRequestID,
			))
			require.True(t, validMethod)
			require.NoError(t, err)
		}

		// back up a lot of requests
		wg := sync.WaitGroup{}
		for _, rid := range rids {
			wg.Add(1)
			// Loop variable passed as an argument (not captured) to appease
			// nogo's loopclosure analyzer, which cannot see the Go language
			// version under rules_go and assumes pre-1.22 capture semantics.
			go func(rid int) {
				defer wg.Done()
				_, validMethod, _, _ := h.Handle(lsptest.NewGLSPTestCtxForMethodWithRequestID(t,
					"test/blockForAges",
					mustJSON(t, 99),
					rid,
				))
				assert.True(t, validMethod, "expected valid method")
			}(rid)
		}

		for i, rid := range rids {
			// cancel the rest
			if i%2 != 0 {
				continue
			}
			nextCancelRequestID++
			_, validMethod, _, err := h.Handle(lsptest.NewGLSPTestCtxForMethodWithRequestID(t,
				"$/cancelRequest",
				mustJSON(t, map[string]any{"id": rid}),
				nextCancelRequestID,
			))
			require.True(t, validMethod)
			require.NoError(t, err)
		}

		heardAll := make(chan struct{})
		go func() {
			wg.Wait()
			close(heardAll)
		}()

		select {
		// pass if we've heard all first
		case <-heardAll:
			assert.Contains(t, tlog.String(), `canceled_by_client=true`, "should have logged cancellation")
			assert.LessOrEqual(t, started.Load(), int64(n/2), "at least half should have never started, as cancel was received first")
		// give a decent amount of time to avoid flakes
		case <-time.After(5 * time.Second):
			t.Errorf("should have been cancelled. Logs:\n%s", tlog.String())
		}

	})
}

func TestConcurrentMethods(t *testing.T) {
	t.Run("default handler marks extension methods as concurrent", func(t *testing.T) {
		h := New()

		extensionMethods := []string{
			methods.ACPInitializeMethod,
			methods.ACPSteerMethod,
			methods.ACPSetConfigOptionMethod,
			methods.ACPSetModeMethod,
			"camber/hello",
		}
		for _, method := range extensionMethods {
			assert.True(t, h.IsConcurrentMethod(method), "%s should be concurrent", method)
		}

		lspMethods := []string{
			"textDocument/didOpen",
			"textDocument/didChange",
		}
		for _, method := range lspMethods {
			assert.False(t, h.IsConcurrentMethod(method), "%s should not be concurrent", method)
		}
	})

	t.Run("custom handler properly sets concurrent flag", func(t *testing.T) {
		h := newHandlerBaseState()

		registerLSPMethod(h, JSONRPCOperation{
			Method: "test/lspMethod",
		}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
			return "", nil
		})

		registerExtensionMethod(h, JSONRPCOperation{
			Method: "test/extensionMethod",
		}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
			return "", nil
		})

		registerExtensionMethodUntyped(h, JSONRPCOperation{
			Method: "test/serializedUntypedMethod",
		}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
			return "", nil
		})

		registerUnserializedExtensionMethodUntyped(h, JSONRPCOperation{
			Method: "test/unserializedUntypedMethod",
		}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
			return "", nil
		})

		registerUnserializedExtensionMethodUntypedNoDeadline(h, JSONRPCOperation{
			Method: "test/unserializedUntypedMethodNoDeadline",
		}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
			return "", nil
		})

		assert.False(t, h.IsConcurrentMethod("test/lspMethod"), "LSP method should not be concurrent")
		assert.True(t, h.IsConcurrentMethod("test/extensionMethod"), "Extension method should be concurrent")
		assert.False(t, h.IsConcurrentMethod("test/serializedUntypedMethod"), "serialized untyped method should not be concurrent")
		assert.True(t, h.IsConcurrentMethod("test/unserializedUntypedMethod"), "unserialized untyped method should be concurrent")
		assert.True(t, h.IsConcurrentMethod("test/unserializedUntypedMethodNoDeadline"), "unserialized no-deadline method should be concurrent")
	})
}

func TestRequestContextDeadlines(t *testing.T) {
	h := newHandlerBaseState()
	h.SetInitialized(true)

	var sawDefaultDeadline bool
	registerExtensionMethodUntyped(h, JSONRPCOperation{
		Method: "test/defaultDeadlineMethod",
	}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
		_, sawDefaultDeadline = ctx.Deadline()
		return "", nil
	})

	var sawNoDeadline bool
	registerUnserializedExtensionMethodUntypedNoDeadline(h, JSONRPCOperation{
		Method: "test/noDeadlineMethod",
	}, func(ctx context.Context, req *string, lspReq *glsp.Context) (string, error) {
		_, sawNoDeadline = ctx.Deadline()
		return "", nil
	})

	_, validMethod, validParams, err := h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
		"test/defaultDeadlineMethod",
		mustJSON(t, "hello"),
	))
	require.NoError(t, err)
	require.True(t, validMethod)
	require.True(t, validParams)
	assert.True(t, sawDefaultDeadline)

	_, validMethod, validParams, err = h.Handle(lsptest.NewGLSPTestCtxForMethod(t,
		"test/noDeadlineMethod",
		mustJSON(t, "hello"),
	))
	require.NoError(t, err)
	require.True(t, validMethod)
	require.True(t, validParams)
	assert.False(t, sawNoDeadline)
}

func TestACPInitializeHasNoRequestDeadline(t *testing.T) {
	h := New()

	_, ok := h.noDeadlineMethods[methods.ACPInitializeMethod]
	require.True(t, ok)
	assert.True(t, h.IsConcurrentMethod(methods.ACPInitializeMethod))
}

func TestACPNavInstallAgentServerHasNoRequestDeadline(t *testing.T) {
	h := New()

	_, ok := h.noDeadlineMethods[methods.ACPNavInstallAgentServerMethod]
	require.True(t, ok)
	assert.True(t, h.IsConcurrentMethod(methods.ACPNavInstallAgentServerMethod))
}

func TestAgentServerBinaryDistributionConversionsPreserveSHA256(t *testing.T) {
	binaries := map[string]methods.ACPAgentServerBinaryDistribution{
		"darwin-aarch64": {
			Archive: "https://example.com/agent.tar.gz",
			SHA256:  "0123456789abcdef",
			Cmd:     "./agent",
		},
	}

	proxyBinaries := toProxyAgentServerBinaries(binaries)
	require.Contains(t, proxyBinaries, "darwin-aarch64")
	assert.Equal(t, "0123456789abcdef", proxyBinaries["darwin-aarch64"].SHA256)

	roundTripped := toMethodsAgentServerBinaries(proxyBinaries)
	require.Contains(t, roundTripped, "darwin-aarch64")
	assert.Equal(t, "0123456789abcdef", roundTripped["darwin-aarch64"].SHA256)
}

func TestAgentServersForHost(t *testing.T) {
	state := methods.ACPNavAgentServersState{
		AgentServers: methods.ACPAgentServers{
			acpproxy.DefaultAgentServerName: {},
			methods.LocalAgentServerName:    {Type: "local"},
		},
		DefaultAgentServer: methods.LocalAgentServerName,
	}

	t.Run("desktop keeps local inference", func(t *testing.T) {
		h := New()
		h.config = &Config{AssistantHost: "desktop"}

		filtered := h.agentServersForHost(state)

		assert.Contains(t, filtered.AgentServers, methods.LocalAgentServerName)
		assert.Equal(t, methods.LocalAgentServerName, filtered.DefaultAgentServer)
	})

	t.Run("VS Code removes local inference and falls back to Camber", func(t *testing.T) {
		h := New()
		h.config = &Config{AssistantHost: "vscode"}

		filtered := h.agentServersForHost(state)

		assert.NotContains(t, filtered.AgentServers, methods.LocalAgentServerName)
		assert.Equal(t, acpproxy.DefaultAgentServerName, filtered.DefaultAgentServer)
		assert.Contains(t, state.AgentServers, methods.LocalAgentServerName)
	})
}

func TestACPNavStateForHost(t *testing.T) {
	state := methods.ACPNavState{
		Conversations: []methods.ACPNavConversation{
			{ID: "poolside", AgentServer: acpproxy.DefaultAgentServerName},
			{ID: "local", AgentServer: methods.LocalAgentServerName},
		},
	}

	t.Run("desktop keeps local conversations", func(t *testing.T) {
		h := &CamberHandler{config: &Config{AssistantHost: "desktop"}}
		filtered := h.acpNavStateForHost(state)
		require.Len(t, filtered.Conversations, 2)
	})

	t.Run("vscode hides local conversations", func(t *testing.T) {
		h := &CamberHandler{config: &Config{AssistantHost: "vscode"}}
		filtered := h.acpNavStateForHost(state)
		require.Len(t, filtered.Conversations, 1)
		assert.Equal(t, "poolside", filtered.Conversations[0].ID)
		require.Len(t, state.Conversations, 2, "filter must not mutate shared state")
	})
}

func testLogger() *strings.Builder {
	var buf strings.Builder
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})
	logger := slog.New(handler)
	slog.SetDefault(logger)
	return &buf
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type performanceRPCInput struct {
	Content string   `json:"content"`
	Parts   []string `json:"parts"`
}

func BenchmarkJSONRPCDecodeLargePayload(b *testing.B) {
	b.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(b.TempDir(), "remote.json"))
	payload, err := json.Marshal(performanceRPCInput{Content: strings.Repeat("streamed file content\n", 16000), Parts: []string{"one", "two"}})
	require.NoError(b, err)
	for _, unvalidated := range []bool{false, true} {
		name := "registered-production"
		if unvalidated {
			name = "unvalidated"
		}
		b.Run(name, func(b *testing.B) {
			h := New()
			operation := JSONRPCOperation{Method: "test/performance"}
			handle := func(_ context.Context, input *performanceRPCInput, _ *glsp.Context) (int, error) {
				return len(input.Content), nil
			}
			if unvalidated {
				registerSerializedJSONRPCUnvalidated(h, operation, handle)
			} else {
				registerJSONRPCMethod(h, operation, handle)
			}
			request := &glsp.Context{Params: payload}
			b.ReportAllocs()
			b.SetBytes(int64(len(payload)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, err := h.extensionHandlers[operation.Method](context.Background(), request)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// The diagnostic digest lets the performance audit compare the entire emitted
// schema before/after changing when it is built, without pinning API evolution.
func TestJSONRPCSchemaDiagnostic(t *testing.T) {
	t.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(t.TempDir(), "remote.json"))
	h := New()
	encoded, err := json.Marshal(h.OpenAPI().OpenAPI())
	require.NoError(t, err)
	require.Greater(t, len(h.OpenAPI().OpenAPI().Paths), 100)
	t.Logf("schema bytes=%d sha256=%x", len(encoded), sha256.Sum256(encoded))
}

func BenchmarkJSONRPCStartupRegistration(b *testing.B) {
	b.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(b.TempDir(), "remote.json"))
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		h := New()
		if len(h.extensionHandlers) < 100 {
			b.Fatal("missing registered handlers")
		}
	}
}

func TestJSONRPCDeferredSchemasPreserveValidationAndLateRegistration(t *testing.T) {
	t.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(t.TempDir(), "remote.json"))
	h := New()
	require.Nil(t, h.huma, "production startup should not build schemas")
	input := &glsp.Context{Params: json.RawMessage(`{"ping":"` + strings.Repeat("x", 129) + `"}`)}
	_, err := h.extensionHandlers["camber/hello"](context.Background(), input)
	require.NoError(t, err)
	assert.Nil(t, h.huma, "production requests should not build schemas")
	h.config.AssistantEnvironment = string(methods.DevelopmentEnv)
	_, err = h.extensionHandlers["camber/hello"](context.Background(), input)
	require.ErrorContains(t, err, "expected length <= 128")
	require.NotNil(t, h.huma)
	assert.Empty(t, h.schemaRegistrations, "release registration closures after use")
	registerJSONRPCMethod(h, JSONRPCOperation{Method: "test/late"}, func(context.Context, *HelloIn, *glsp.Context) (bool, error) { return true, nil })
	assert.Contains(t, h.OpenAPI().OpenAPI().Paths, "/test/late")
}

func TestJSONRPCConcurrentFirstSchemaAccess(t *testing.T) {
	t.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(t.TempDir(), "remote.json"))
	h := New()
	var wg sync.WaitGroup
	counts := make(chan int, 16)
	for i := 0; i < cap(counts); i++ {
		wg.Go(func() { counts <- len(h.OpenAPI().OpenAPI().Paths) })
	}
	wg.Wait()
	want := len(h.OpenAPI().OpenAPI().Paths)
	for i := 0; i < cap(counts); i++ {
		assert.Equal(t, want, <-counts)
	}
}

func TestJSONRPCSingleDecodePreservesInputSemantics(t *testing.T) {
	for _, input := range []string{"", "{", "{\"ping\":"} {
		_, err := decodeJSONRPCInput[HelloIn](json.RawMessage(input))
		require.ErrorIs(t, err, ErrInvalidParams)
		assert.ErrorContains(t, err, "could not parse input as json")
	}
	for _, input := range []string{`{"ping":42}`, `[]`, `"text"`} {
		_, err := decodeJSONRPCInput[HelloIn](json.RawMessage(input))
		require.ErrorIs(t, err, ErrInvalidParams)
		assert.ErrorContains(t, err, "could not decode input")
	}
	input, err := decodeJSONRPCInput[HelloIn](json.RawMessage(`{"ping":"hello","extra":42}`))
	require.NoError(t, err)
	require.NotNil(t, input)
	assert.Equal(t, "hello", input.Ping)
	input, err = decodeJSONRPCInput[HelloIn](json.RawMessage(`null`))
	require.NoError(t, err)
	assert.Nil(t, input)
}
