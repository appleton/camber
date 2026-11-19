package acpproxy

import (
	"sync"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// probeGate keeps config-probe sessions out of the retained session log.
//
// A probe's id is unknown until its session/new returns, yet the agent may
// stream updates (available_commands_update) before answering. The gate holds
// the first events of any session it has not yet seen while a probe
// session/new is in flight, then, once the probes resolve, delivers the
// probe's events unretained and publishes everything else in its original
// order. Outside a probe window the gate is a pass-through.
//
// Admit and release run on the client's serial async notification queue, so
// the delivery order is the queue order; mu only guards state shared with the
// goroutines that begin and resolve probes.
type probeGate struct {
	mu      sync.Mutex
	pending int
	seen    map[string]struct{}
	held    []heldSessionEvent
	holding map[string]struct{}
	// failed records a probe session/new that failed in this window: its
	// early events cannot be attributed, so the window's held events are
	// delivered unretained rather than risk a log entry for the probe.
	failed bool
}

type heldSessionEvent struct {
	sessionID    string
	originDevice string
	skipPrimary  bool
	message      map[string]any
}

// publishSessionEvent routes a live session event: probe sessions are fanned
// out without touching the session log; everything else is published (stamped
// and retained). Callers must be on the client's async notification queue.
func (c *acpClient) publishSessionEvent(events SessionEventSink, sessionID, originDevice string, skipPrimary bool, message map[string]any) {
	isProbe := c.handler != nil && c.handler.isProbeSession(c.agentServer, sessionID)
	g := &c.probes
	g.mu.Lock()
	_, held := g.holding[sessionID]
	_, known := g.seen[sessionID]
	switch {
	case held || (!isProbe && !known && g.pending > 0):
		if g.holding == nil {
			g.holding = map[string]struct{}{}
		}
		g.holding[sessionID] = struct{}{}
		g.held = append(g.held, heldSessionEvent{sessionID, originDevice, skipPrimary, message})
		g.mu.Unlock()
	case isProbe:
		g.mu.Unlock()
		c.deliverUnretained(events, message)
	default:
		g.markSeenLocked(sessionID)
		g.mu.Unlock()
		events.PublishSessionUpdate(c.agentServer, sessionID, originDevice, skipPrimary, message)
	}
}

// deliverUnretained fans a probe's update out to every client unstamped, so
// the UI still sees its commands/config without a session-log slot.
func (c *acpClient) deliverUnretained(events SessionEventSink, message map[string]any) {
	events.NotifyAll(methods.JSONRPCNotifyMethod, bridgeMessage(c.agentServer, message))
}

// beginProbe must be called before a probe's session/new is sent.
func (c *acpClient) beginProbe() {
	c.probes.mu.Lock()
	c.probes.pending++
	c.probes.mu.Unlock()
}

// endProbe resolves a probe's session/new (sessionID empty on failure) from
// the async notification queue, behind every update the agent sent before its
// response. The probe must already be registered in the handler.
func (c *acpClient) endProbe(events SessionEventSink, sessionID string) {
	g := &c.probes
	g.mu.Lock()
	if g.pending > 0 {
		g.pending--
	}
	var release []heldSessionEvent
	if sessionID == "" {
		g.failed = true
	}
	failed := false
	if g.pending == 0 {
		failed = g.failed
		release, g.held, g.holding, g.failed = g.held, nil, nil, false
	} else if sessionID != "" {
		var keep []heldSessionEvent
		for _, ev := range g.held {
			if ev.sessionID == sessionID {
				release = append(release, ev)
			} else {
				keep = append(keep, ev)
			}
		}
		g.held = keep
		delete(g.holding, sessionID)
	}
	g.mu.Unlock()
	for _, ev := range release {
		if failed || ev.sessionID == sessionID || (c.handler != nil && c.handler.isProbeSession(c.agentServer, ev.sessionID)) {
			c.deliverUnretained(events, ev.message)
			continue
		}
		g.mu.Lock()
		g.markSeenLocked(ev.sessionID)
		g.mu.Unlock()
		events.PublishSessionUpdate(c.agentServer, ev.sessionID, ev.originDevice, ev.skipPrimary, ev.message)
	}
}

// forgetSeen drops a closed session from the gate's bookkeeping.
func (c *acpClient) forgetSeen(sessionID string) {
	c.probes.mu.Lock()
	delete(c.probes.seen, sessionID)
	c.probes.mu.Unlock()
}

func (g *probeGate) markSeenLocked(sessionID string) {
	if g.seen == nil {
		g.seen = map[string]struct{}{}
	}
	g.seen[sessionID] = struct{}{}
}
