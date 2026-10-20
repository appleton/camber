package acpproxy

import (
	"context"
	"encoding/json"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// SessionConfiguration returns the last configuration witnessed on this live
// ACP connection. Closing a session or restarting its subprocess invalidates
// its snapshot; callers must load it again before using the live settings.
func (h *Handler) SessionConfiguration(agentServer, sessionID string) (options json.RawMessage, modes json.RawMessage, ok bool) {
	h.mu.Lock()
	proc := h.procs[normalizeServerName(agentServer)]
	h.mu.Unlock()
	if proc == nil {
		return nil, nil, false
	}
	proc.mu.Lock()
	cache := proc.configuration
	proc.mu.Unlock()
	return cache.snapshot(sessionID)
}

// InvalidateSessionConfiguration requires callers to reload a session after
// failed configuration restoration. It leaves the agent session itself open.
func (h *Handler) InvalidateSessionConfiguration(agentServer, sessionID string) {
	h.mu.Lock()
	proc := h.procs[normalizeServerName(agentServer)]
	h.mu.Unlock()
	if proc == nil {
		return
	}
	proc.mu.Lock()
	cache := proc.configuration
	proc.mu.Unlock()
	cache.closeSession(sessionID)
}

// UI callers apply setter responses themselves. Control callers have no local
// selector to update, and ACP does not require agents to also emit a session
// update, so fan out the accepted state through the shared update path. These
// full-state assignments remain idempotent if the agent emits its own update.
func (h *Handler) publishControlConfiguration(ctx context.Context, agentServer string, sessionID acpsdk.SessionId, update acpsdk.SessionUpdate, gCtx *glsp.Context) error {
	if methods.ClientOriginFromContext(ctx) != "control" {
		return nil
	}
	_, client := h.processFor(normalizeServerName(agentServer), gCtx)
	notification := acpsdk.SessionNotification{SessionId: sessionID, Update: update}
	client.asyncNotifications.enqueue(func(ctx context.Context, method string, params any) {
		if h.events != nil {
			// This is a live accepted mutation, never transcript replay. A
			// concurrent load must not scope it away from existing clients.
			h.events.PublishSessionUpdate(normalizeServerName(agentServer), string(sessionID), "", false,
				map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
		} else {
			client.notify(ctx, method, params)
		}
	}, acpsdk.ClientMethodSessionUpdate, notification)
	// Publish before the setter response so the native helper bridge's usual
	// notification barrier orders the desktop selectors ahead of CLI success.
	if err := client.waitForSessionUpdates(ctx); err != nil {
		return preserveACPError("acpproxy: control configuration notifications", err)
	}
	return nil
}

// Each connection owns a separate observer, so late notifications from a
// stopping subprocess cannot populate the replacement subprocess's cache.
type configurationClient struct {
	*acpClient
	configuration *sessionConfigurationCache
}

func (c *configurationClient) SessionUpdate(ctx context.Context, params acpsdk.SessionNotification) error {
	c.configuration.observe(string(params.SessionId), params.Update)
	return c.acpClient.SessionUpdate(ctx, params)
}

type sessionConfiguration struct {
	options json.RawMessage
	modes   json.RawMessage
	closed  bool
}

// This mutex is independent of process.mu: agents can emit updates while a
// session/new or session/load call holds the process lock awaiting its response.
type sessionConfigurationCache struct {
	mu       sync.Mutex
	invalid  bool
	sessions map[string]sessionConfiguration
}

func (p *process) configurationForConn(conn *acpsdk.ClientSideConnection) *sessionConfigurationCache {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn != conn {
		return nil
	}
	return p.configuration
}

func (c *sessionConfigurationCache) snapshot(sessionID string) (json.RawMessage, json.RawMessage, bool) {
	if c == nil {
		return nil, nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.invalid {
		return nil, nil, false
	}
	state, ok := c.sessions[sessionID]
	if !ok || state.closed {
		return nil, nil, false
	}
	return append(json.RawMessage(nil), state.options...), append(json.RawMessage(nil), state.modes...), true
}

// Keep a closed marker so late notifications cannot make a closed session
// appear live. A subsequent new/load/resume response reopens the snapshot.
func (c *sessionConfigurationCache) closeSession(sessionID string) {
	if c == nil || sessionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.invalid {
		return
	}
	if c.sessions == nil {
		c.sessions = make(map[string]sessionConfiguration)
	}
	c.sessions[sessionID] = sessionConfiguration{closed: true}
}

func (c *sessionConfigurationCache) invalidate() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.invalid = true
	c.sessions = nil
}

func (c *sessionConfigurationCache) capture(sessionID string, options []acpsdk.SessionConfigOption, modes *acpsdk.SessionModeState) {
	if c == nil || sessionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.invalid {
		return
	}
	c.captureLocked(sessionID, options, modes)
	state := c.sessions[sessionID]
	state.closed = false
	c.sessions[sessionID] = state
}

func (c *sessionConfigurationCache) captureLocked(sessionID string, options []acpsdk.SessionConfigOption, modes *acpsdk.SessionModeState) {
	if c.sessions == nil {
		c.sessions = make(map[string]sessionConfiguration)
	}
	state := c.sessions[sessionID]
	// Omitted optional fields must not erase updates delivered during load.
	if options != nil {
		if raw, err := json.Marshal(options); err == nil {
			state.options = raw
		}
	}
	if modes != nil {
		if raw, err := json.Marshal(modes); err == nil {
			state.modes = raw
		}
	}
	c.sessions[sessionID] = state
}

func (c *sessionConfigurationCache) setMode(sessionID string, mode acpsdk.SessionModeId) {
	if c == nil || sessionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.invalid {
		return
	}
	c.setModeLocked(sessionID, mode)
}

func (c *sessionConfigurationCache) setModeLocked(sessionID string, mode acpsdk.SessionModeId) {
	if c.sessions == nil {
		c.sessions = make(map[string]sessionConfiguration)
	}
	state := c.sessions[sessionID]
	var modes map[string]json.RawMessage
	_ = json.Unmarshal(state.modes, &modes)
	if modes == nil {
		modes = make(map[string]json.RawMessage)
	}
	modes["currentModeId"], _ = json.Marshal(mode)
	state.modes, _ = json.Marshal(modes)
	c.sessions[sessionID] = state
}

func (c *sessionConfigurationCache) observe(sessionID string, update acpsdk.SessionUpdate) {
	if c == nil || sessionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.invalid {
		return
	}
	if update.ConfigOptionUpdate != nil {
		options := update.ConfigOptionUpdate.ConfigOptions
		if options == nil {
			options = []acpsdk.SessionConfigOption{}
		}
		c.captureLocked(sessionID, options, nil)
	}
	if update.CurrentModeUpdate != nil {
		c.setModeLocked(sessionID, update.CurrentModeUpdate.CurrentModeId)
	}
}
