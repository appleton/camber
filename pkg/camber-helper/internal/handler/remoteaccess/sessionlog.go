package remoteaccess

import (
	"context"
	"sync"

	"github.com/google/uuid"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Per-session event buffer bounds. A resume whose cursor predates the buffer
// simply fails and the client re-loads the session.
//
// sessionLogMaxReplay caps one resume's replay burst: the events are enqueued
// atomically into the client's bounded hub queue (notifyQueueSize deep), and
// overflowing it would DROP the client mid-replay — a reconnect loop for any
// client far enough behind. Keeping the cap under half the queue leaves room
// for concurrent live traffic; buffering much beyond it is pointless.
const (
	sessionLogBufferCap   = 2048
	sessionLogMaxReplay   = notifyQueueSize / 2
	sessionLogMaxSessions = 128
)

// SessionCursorInfo describes a session's live-event stream position.
type SessionCursorInfo struct {
	Epoch        string
	Seq          int64
	TurnActive   bool
	TurnStartSeq int64
}

type sessionLogKey struct {
	agentServer string
	sessionID   string
}

type loggedEvent struct {
	seq    int64
	method string
	params any
}

type sessionLogEntry struct {
	seq    int64
	events []loggedEvent
	// True only for sessions created by this helper whose history has never
	// been replaced by an agent-side load. A bounded log is not a transcript
	// snapshot unless it still covers that session from its beginning.
	completeHistory bool
	// activeTurns counts BeginTurn calls not yet matched by EndTurn. A turn's
	// EndTurn rides the per-client notification queue behind the turn's final
	// publishes, so it can land after the next turn's synchronous BeginTurn;
	// counting keeps that next turn marked active where a boolean would not.
	activeTurns  int
	turnStartSeq int64
	// lastUse orders whole-session eviction (monotonic counter, not time).
	lastUse int64
}

// SessionLog assigns each live session/update event a per-session monotonic
// sequence number, stamps it into the bridge envelope, buffers it, and fans it
// out to connected clients. Reconnecting clients resume from their last seq
// (Resume) instead of re-loading conversations; the stamps let clients drop
// duplicates by construction.
//
// Only live events pass through here. session/load replay traffic is scoped
// to the loading client (Hub.NotifyClient) and never stamped or buffered, so
// the buffer never contains transcript duplicates.
type SessionLog struct {
	hub   *Hub
	epoch string

	mu       sync.Mutex
	sessions map[sessionLogKey]*sessionLogEntry
	useTick  int64
}

func NewSessionLog(hub *Hub) *SessionLog {
	return &SessionLog{
		hub:      hub,
		epoch:    uuid.NewString(),
		sessions: map[sessionLogKey]*sessionLogEntry{},
	}
}

// Publish stamps the raw agent JSON-RPC message with the session's next
// sequence number, buffers it, and delivers it to every connected remote
// client and (unless skipPrimary) the primary. It returns the assigned
// sequence number.
//
// Every remote receives every stamped event — the per-session seq stream has
// no intentional gaps, which is what lets clients reorder the resume-replay /
// live race and detect real loss. Events a device already rendered locally
// (its own prompt's user message) are delivered anyway, tagged with
// originDevice, and dropped by that device's transport. skipPrimary covers
// the same case for the desktop, whose transport has no gating layer.
//
// Callers must serialize Publish calls per session (acpproxy's per-client
// async notification queue does); the lock only protects against concurrent
// Resume and cross-session publishes.
func (l *SessionLog) Publish(agentServer, sessionID, originDevice string, skipPrimary bool, message map[string]any) int64 {
	l.mu.Lock()
	entry := l.entryLocked(agentServer, sessionID)
	entry.seq++
	seq := entry.seq
	params := map[string]any{
		"agentServer":                 agentServer,
		"message":                     message,
		methods.BridgeSessionSeqKey:   seq,
		methods.BridgeSessionEpochKey: l.epoch,
	}
	if originDevice != "" {
		params[methods.BridgeOriginDeviceKey] = originDevice
	}
	entry.events = append(entry.events, loggedEvent{
		seq:    seq,
		method: methods.JSONRPCNotifyMethod,
		params: params,
	})
	l.compactLocked(entry)
	// Enqueue to remote clients while holding the lock so Resume's
	// replay-then-live handoff cannot interleave out of order.
	l.hub.enqueueRemotesExcept("", notifyMsg{method: methods.JSONRPCNotifyMethod, params: params})
	l.mu.Unlock()

	// The primary connection never resumes (its transport does not drop), so
	// its delivery does not need the lock; per-session ordering holds because
	// each session's publishes come from one goroutine.
	if !skipPrimary {
		l.hub.NotifyPrimary(context.Background(), methods.JSONRPCNotifyMethod, params)
	}
	return seq
}

// BeginTurn pins the upcoming turn's first sequence number so the buffer
// retains the whole in-flight turn and session/load responses can report it.
func (l *SessionLog) BeginTurn(agentServer, sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agentServer, sessionID)
	entry.activeTurns++
	entry.turnStartSeq = entry.seq + 1
}

func (l *SessionLog) EndTurn(agentServer, sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agentServer, sessionID)
	if entry.activeTurns > 0 {
		entry.activeTurns--
	}
}

// Cursor reports the session's current stream position for stamping into a
// session/load response.
func (l *SessionLog) Cursor(agentServer, sessionID string) SessionCursorInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agentServer, sessionID)
	return SessionCursorInfo{
		Epoch:        l.epoch,
		Seq:          entry.seq,
		TurnActive:   entry.activeTurns > 0,
		TurnStartSeq: entry.turnStartSeq,
	}
}

// MarkSessionHistory records whether live events can reconstruct this session.
// Loading persisted agent history invalidates this: replay is not in our log.
func (l *SessionLog) MarkSessionHistory(agentServer, sessionID string, complete bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entryLocked(agentServer, sessionID).completeHistory = complete
}

// SessionReplay returns a complete, ordered snapshot or refuses it. Callers
// serialize this and its delivery with live publishes on the ACP event queue.
// Remotes have a bounded delivery queue, so refuse an oversized replay before
// sending anything rather than disconnecting the reader halfway through.
func (l *SessionLog) SessionReplay(agentServer, sessionID, originID string) ([]map[string]any, SessionCursorInfo, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil || !entry.completeHistory ||
		(entry.seq > 0 && (len(entry.events) == 0 || entry.events[0].seq != 1)) ||
		(originID != PrimaryOrigin && len(entry.events) >= sessionLogMaxReplay) {
		return nil, SessionCursorInfo{}, false
	}
	messages := make([]map[string]any, 0, len(entry.events))
	for _, event := range entry.events {
		envelope, ok := event.params.(map[string]any)
		if !ok {
			return nil, SessionCursorInfo{}, false
		}
		message, ok := envelope["message"].(map[string]any)
		if !ok {
			return nil, SessionCursorInfo{}, false
		}
		messages = append(messages, message)
	}
	return messages, SessionCursorInfo{Epoch: l.epoch, Seq: entry.seq, TurnActive: entry.activeTurns > 0}, true
}

// Resume replays buffered events after each cursor to the calling remote
// client, atomically with live publishes so everything from the replay
// onwards reaches the client in seq order. Sessions whose cursor cannot be
// bridged (epoch change, evicted range, unknown session) are reported
// resumed=false and must be re-loaded by the client.
func (l *SessionLog) Resume(originID string, cursors []methods.RemoteResumeCursor) methods.RemoteResumeOutput {
	out := methods.RemoteResumeOutput{Sessions: make([]methods.RemoteResumeResult, 0, len(cursors))}

	l.mu.Lock()
	defer l.mu.Unlock()
	for _, cursor := range cursors {
		result := methods.RemoteResumeResult{AgentServer: cursor.AgentServer, SessionID: cursor.SessionID}
		entry := l.sessions[sessionLogKey{agentServer: cursor.AgentServer, sessionID: cursor.SessionID}]
		if entry != nil && l.replayLocked(originID, entry, cursor) {
			result.Resumed = true
		}
		out.Sessions = append(out.Sessions, result)
	}
	return out
}

func (l *SessionLog) replayLocked(originID string, entry *sessionLogEntry, cursor methods.RemoteResumeCursor) bool {
	if cursor.Epoch != l.epoch || cursor.Seq > entry.seq {
		return false
	}
	if cursor.Seq < entry.seq {
		// The buffer must cover (cursor, latest] contiguously, and the burst
		// must fit the client's hub queue (see sessionLogMaxReplay).
		if entry.seq-cursor.Seq > sessionLogMaxReplay {
			return false
		}
		if len(entry.events) == 0 || entry.events[0].seq > cursor.Seq+1 {
			return false
		}
		for _, event := range entry.events {
			if event.seq <= cursor.Seq {
				continue
			}
			if !l.hub.enqueueTo(originID, notifyMsg{method: event.method, params: event.params}) {
				return false
			}
		}
	}
	l.useTick++
	entry.lastUse = l.useTick
	return true
}

func (l *SessionLog) entryLocked(agentServer, sessionID string) *sessionLogEntry {
	key := sessionLogKey{agentServer: agentServer, sessionID: sessionID}
	entry := l.sessions[key]
	if entry == nil {
		if len(l.sessions) >= sessionLogMaxSessions {
			l.evictIdleSessionLocked()
		}
		entry = &sessionLogEntry{}
		l.sessions[key] = entry
	}
	l.useTick++
	entry.lastUse = l.useTick
	return entry
}

// compactLocked drops the oldest buffered events past the buffer cap.
func (l *SessionLog) compactLocked(entry *sessionLogEntry) {
	if excess := len(entry.events) - sessionLogBufferCap; excess > 0 {
		entry.events = append([]loggedEvent(nil), entry.events[excess:]...)
	}
}

// evictIdleSessionLocked removes the least recently used session that has no
// turn in flight; resumes targeting it will fail and fall back to a reload.
func (l *SessionLog) evictIdleSessionLocked() {
	var oldestKey sessionLogKey
	var oldest *sessionLogEntry
	for key, entry := range l.sessions {
		if entry.activeTurns > 0 {
			continue
		}
		if oldest == nil || entry.lastUse < oldest.lastUse {
			oldestKey, oldest = key, entry
		}
	}
	if oldest != nil {
		delete(l.sessions, oldestKey)
	}
}
