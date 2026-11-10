package mcpservers

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const resolveTimeout = 10 * time.Second

// ResolveParams configures a single resolution pass for a session.
type ResolveParams struct {
	// MCPCapabilities from the agent's InitializeResponse.
	MCPCapabilities acpsdk.McpCapabilities
	// IsPoolAgent is true when the target agent is the camber agent.
	IsPoolAgent bool
}

// ResolveResult is returned by Resolve.
type ResolveResult struct {
	Servers     []acpsdk.McpServer
	Injected    []methods.MCPServerStatus
	Unavailable []methods.MCPServerStatus
}

// Resolve takes enabled servers and returns the ACP McpServer list to inject.
// Each server's OAuth token is loaded (and refreshed if necessary) concurrently.
// Servers that fail to resolve within the budget are reported as resolve_timeout.
// The caller is responsible for passing ctx with the appropriate deadline for
// the overall session setup; Resolve imposes an additional per-server cap.
func (s *Server) Resolve(ctx context.Context, params ResolveParams) ResolveResult {
	entries, err := s.store.List()
	if err != nil {
		slog.Warn("mcpservers: resolve: load store", "error", err)
		return ResolveResult{}
	}

	// Filter to only enabled entries.
	enabled := make([]methods.MCPServerEntry, 0, len(entries))
	for _, e := range entries {
		if e.Enabled {
			enabled = append(enabled, e)
		}
	}
	if len(enabled) == 0 {
		return ResolveResult{}
	}

	caps := params.MCPCapabilities
	if params.IsPoolAgent {
		// The camber agent consumes client-provided MCP servers itself and
		// supports HTTP and SSE transports, but does NOT advertise
		// McpCapabilities in its ACP Initialize response (it leaves the field
		// zero). Without this, every HTTP/SSE connector would be dropped as
		// "unsupported_transport". Treat the pool agent as transport-capable.
		caps.Http = true
		caps.Sse = true
	}

	outcomes := make([]resolveOutcome, len(enabled))
	var wg sync.WaitGroup
	wg.Add(len(enabled))

	resolveCtx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()

	for i, e := range enabled {
		// Loop variables passed as arguments (not captured) to appease nogo's
		// loopclosure analyzer, which cannot see the Go language version under
		// rules_go and assumes pre-1.22 capture semantics.
		go func(i int, e methods.MCPServerEntry) {
			defer wg.Done()
			outcomes[i] = resolveOne(resolveCtx, e, caps)
		}(i, e)
	}
	wg.Wait()

	var result ResolveResult
	for _, out := range outcomes {
		if out.ok {
			result.Servers = append(result.Servers, out.server)
			result.Injected = append(result.Injected, methods.MCPServerStatus{ServerName: out.entry.Name})
		} else {
			result.Unavailable = append(result.Unavailable, methods.MCPServerStatus{
				ServerName: out.entry.Name,
				Reason:     out.reason,
				Message:    out.message,
			})
		}
	}
	return result
}

type resolveOutcome struct {
	entry   methods.MCPServerEntry
	server  acpsdk.McpServer
	reason  string
	message string
	ok      bool
}

func resolveOne(ctx context.Context, e methods.MCPServerEntry, caps acpsdk.McpCapabilities) resolveOutcome {
	// Capability gate per remote transport: a "/sse" URL needs SSE support, every
	// other URL needs HTTP. (Stdio servers have no URL and are always allowed.)
	if e.URL != "" {
		if isSSEURL(e.URL) && !caps.Sse {
			return resolveOutcome{entry: e, reason: "unsupported_transport", message: "agent does not support SSE MCP servers"}
		}
		if !isSSEURL(e.URL) && !caps.Http {
			return resolveOutcome{entry: e, reason: "unsupported_transport", message: "agent does not support HTTP MCP servers"}
		}
	}

	// Resolve bearer token for OAuth servers.
	bearerToken := ""
	if e.URL != "" && e.AuthMode == methods.MCPServerAuthModeOAuth {
		token, reason, msg := resolveOAuthToken(ctx, e)
		if reason != "" {
			return resolveOutcome{entry: e, reason: reason, message: msg}
		}
		bearerToken = token
	}

	// Check context (resolveTimeout may have fired).
	select {
	case <-ctx.Done():
		return resolveOutcome{entry: e, reason: "resolve_timeout", message: "context cancelled before resolution"}
	default:
	}

	srv, err := BuildACPServer(e, bearerToken)
	if err != nil {
		return resolveOutcome{entry: e, reason: "invalid_config", message: err.Error()}
	}
	return resolveOutcome{entry: e, server: srv, ok: true}
}

// resolveOAuthToken loads, refreshes-if-needed, and returns the access token for
// an OAuth server. On failure it returns a reason + message for the unavailable list.
// The shared load/refresh/persist logic lives in mcp.ResolveAccessToken so other
// features (e.g. gated Hugging Face model downloads) can reuse the same token.
func resolveOAuthToken(ctx context.Context, e methods.MCPServerEntry) (token, reason, message string) {
	token, err := mcp.ResolveAccessToken(ctx, mcp.NewKeyringSecretsServerStore(), e.URL, e.Name)
	if err == nil {
		return token, "", ""
	}
	slog.Warn("mcpservers: resolve OAuth token", "name", e.Name, "error", err)
	if errors.Is(err, mcp.ErrNotAuthenticated) {
		return "", "needs_auth", "server requires OAuth authentication"
	}
	return "", "invalid_config", err.Error()
}
