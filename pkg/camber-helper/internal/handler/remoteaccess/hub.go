package remoteaccess

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// PrimaryOrigin identifies the primary (stdio/TCP) client connection in the
// hub. Remote WebSocket connections get unique generated origin IDs.
const PrimaryOrigin = "primary"

// notifyQueueSize bounds the per-remote-client notification queue. A remote
// client that cannot drain this many notifications is dropped rather than
// letting it stall helper -> client traffic. Sized so a resume replay burst
// (sessionLogMaxReplay, half of this) plus concurrent live traffic fits: an
// agent streams ~50-100 session/update chunks per second, so the replay half
// covers several seconds of mid-turn disconnection.
const notifyQueueSize = 1024

type notifyMsg struct {
	method string
	params any
}

// remoteClient is one live remote connection registered with the Hub.
// Notifications are relayed through an ordered queue so a slow socket cannot
// reorder or block session updates for other clients.
type remoteClient struct {
	id     string
	queue  chan notifyMsg
	closed chan struct{}
	drop   func()
	once   sync.Once
}

func (c *remoteClient) enqueue(msg notifyMsg) {
	select {
	case c.queue <- msg:
	default:
		slog.Warn("remoteaccess: dropping remote client, notification queue overflow", "client", c.id)
		c.close()
	}
}

func (c *remoteClient) close() {
	c.once.Do(func() {
		close(c.closed)
		if c.drop != nil {
			c.drop()
		}
	})
}

func (c *remoteClient) run(notify glsp.NotifyFunc) {
	for {
		select {
		case <-c.closed:
			return
		case msg := <-c.queue:
			if err := notify(context.Background(), msg.method, msg.params); err != nil {
				slog.Debug("remoteaccess: notify to remote client failed", "client", c.id, "error", err)
			}
		}
	}
}

// Hub fans helper -> client notifications out to every live connection. The
// primary connection (desktop/IDE over stdio) is registered lazily from
// request contexts; remote WebSocket connections register on connect.
//
// Handle wraps each request's Notify through the hub, so closures that
// capture a request context (acpproxy clients, acpnav notifications) reach all
// clients regardless of which connection triggered the work. Helper -> client
// requests stay on their originating connection; anything every surface must
// see travels as pushed state (nav didChange, approvals didChange) instead.
type Hub struct {
	mu            sync.Mutex
	primaryNotify glsp.NotifyFunc
	remotes       map[string]*remoteClient
}

func NewHub() *Hub {
	return &Hub{remotes: map[string]*remoteClient{}}
}

// SetPrimary records the primary connection's raw notify function. Call this
// with the UNWRAPPED function before wrapping, or fan-out would loop.
func (h *Hub) SetPrimary(notify glsp.NotifyFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.primaryNotify = notify
}

// RegisterRemote adds a live remote connection and returns an unregister
// function. drop is invoked (once) if the hub evicts the client for falling
// behind; it should close the underlying socket.
func (h *Hub) RegisterRemote(id string, notify glsp.NotifyFunc, drop func()) func() {
	client := &remoteClient{
		id:     id,
		queue:  make(chan notifyMsg, notifyQueueSize),
		closed: make(chan struct{}),
		drop:   drop,
	}
	h.mu.Lock()
	h.remotes[id] = client
	h.mu.Unlock()
	go client.run(notify)

	// Pending approvals reach late joiners as state: the client pulls
	// camber/acp/approvals/list after connecting and reconciles by key, so
	// there is no per-connection re-delivery (and no duplicate prompts).

	return func() {
		h.mu.Lock()
		delete(h.remotes, id)
		h.mu.Unlock()
		client.once.Do(func() { close(client.closed) })
	}
}

func (h *Hub) RemoteCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.remotes)
}

// WrapNotify returns a NotifyFunc that first notifies the originating
// connection, then relays the notification to every other live client.
//
// The NotifyOthersMethod sentinel inverts that: the wrapped payload goes to
// every client EXCEPT the origin. Handlers use it for actions the origin
// already rendered locally (e.g. the user message of a prompt).
func (h *Hub) WrapNotify(originID string, orig glsp.NotifyFunc) glsp.NotifyFunc {
	return func(ctx context.Context, method string, params any) error {
		if method == methods.NotifyOthersMethod {
			relay, ok := params.(methods.NotifyOthersParams)
			if !ok {
				return errors.New("remoteaccess: NotifyOthersMethod requires methods.NotifyOthersParams")
			}
			h.fanOutNotify(originID, relay.Method, relay.Params)
			return nil
		}
		err := orig(ctx, method, params)
		h.fanOutNotify(originID, method, params)
		return err
	}
}

func (h *Hub) fanOutNotify(originID string, method string, params any) {
	h.mu.Lock()
	primary := h.primaryNotify
	clients := make([]*remoteClient, 0, len(h.remotes))
	for id, c := range h.remotes {
		if id == originID {
			continue
		}
		clients = append(clients, c)
	}
	h.mu.Unlock()

	if originID != PrimaryOrigin && primary != nil {
		if err := primary(context.Background(), method, params); err != nil {
			slog.Debug("remoteaccess: notify to primary failed", "error", err)
		}
	}
	for _, c := range clients {
		c.enqueue(notifyMsg{method: method, params: params})
	}
}

// NotifyAll queues a notification for the primary and every remote client with
// no origin exclusion. Used for helper-owned state pushes (e.g. the approvals
// didChange set) that must reach every surface, including the one that
// triggered the underlying change.
func (h *Hub) NotifyAll(method string, params any) {
	h.mu.Lock()
	primary := h.primaryNotify
	clients := make([]*remoteClient, 0, len(h.remotes))
	for _, c := range h.remotes {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	if primary != nil {
		if err := primary(context.Background(), method, params); err != nil {
			slog.Debug("remoteaccess: NotifyAll to primary failed", "error", err)
		}
	}
	for _, c := range clients {
		c.enqueue(notifyMsg{method: method, params: params})
	}
}

// NotifyRemotes queues helper-owned state for every remote client without
// sending an irrelevant notification to the primary desktop/IDE connection.
func (h *Hub) NotifyRemotes(method string, params any) {
	h.enqueueRemotesExcept("", notifyMsg{method: method, params: params})
}

// enqueueRemotesExcept queues a notification for every live remote client but
// excludeID. The SessionLog calls this under its own lock so a Resume replay
// and subsequent live events cannot interleave out of order per client.
func (h *Hub) enqueueRemotesExcept(excludeID string, msg notifyMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, c := range h.remotes {
		if id == excludeID {
			continue
		}
		c.enqueue(msg)
	}
}

// enqueueTo queues a notification for one remote client, reporting whether
// the client is still registered.
func (h *Hub) enqueueTo(id string, msg notifyMsg) bool {
	h.mu.Lock()
	c := h.remotes[id]
	h.mu.Unlock()
	if c == nil {
		return false
	}
	c.enqueue(msg)
	return true
}

// NotifyPrimary sends a notification to the primary connection only.
func (h *Hub) NotifyPrimary(ctx context.Context, method string, params any) {
	h.mu.Lock()
	primary := h.primaryNotify
	h.mu.Unlock()
	if primary == nil {
		return
	}
	if err := primary(ctx, method, params); err != nil {
		slog.Debug("remoteaccess: notify to primary failed", "error", err)
	}
}

// NotifyClient delivers a notification to exactly one client (primary or
// remote), bypassing fan-out. Used to scope session/load replay traffic to
// the client that requested the load.
func (h *Hub) NotifyClient(originID string, method string, params any) {
	if originID == PrimaryOrigin {
		h.NotifyPrimary(context.Background(), method, params)
		return
	}
	if !h.enqueueTo(originID, notifyMsg{method: method, params: params}) {
		slog.Debug("remoteaccess: notify to departed client dropped", "client", originID, "method", method)
	}
}
