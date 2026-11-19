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
//
// A session/load's replayed history is retained as a snapshot so a later live
// attach can present the whole transcript. It shares the session's buffer cap
// with the live events published after the load (a snapshot that no longer
// fits is dropped, and attaches are refused), and sessionLogMaxHistoryEvents
// bounds the snapshots retained across all sessions: loads of idle
// conversations now retain data, so without a global budget the worst case
// would grow from one live buffer per publishing session to one transcript
// per conversation ever opened.
const (
	sessionLogBufferCap        = 2048
	sessionLogMaxReplay        = notifyQueueSize / 2
	sessionLogMaxSessions      = 128
	sessionLogMaxHistoryEvents = 8 * sessionLogBufferCap
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
	// completeHistory reports that history followed by every event after
	// historySeq is the whole transcript: a session created by this helper
	// (empty history, historySeq 0) or one whose latest session/load replay
	// was captured in full (history is that replay, historySeq the stream
	// position when the load began). A bounded log is only a transcript
	// snapshot while it still covers every event after historySeq.
	completeHistory bool
	historySeq      int64
	history         []map[string]any
	// capturing is set while a session/load is in flight; its replay is
	// collected in pending and becomes history only if the load succeeds.
	capturing  bool
	pending    []map[string]any
	pendingSeq int64
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
// Only live events are stamped and buffered here. session/load replay traffic
// is scoped to the loading client (Hub.NotifyClient) and never stamped, so
// the resumable buffer never contains transcript duplicates; the replay is
// kept aside as the session's history snapshot (BeginLoadHistory).
type SessionLog struct {
	hub   *Hub
	epoch string

	mu       sync.Mutex
	sessions map[sessionLogKey]*sessionLogEntry
	useTick  int64
	// historyEvents counts retained history snapshot messages across all
	// sessions (see sessionLogMaxHistoryEvents).
	historyEvents int
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
// session/load response. It is a pure read: an unknown session reports seq 0
// without gaining a slot (see peekLocked).
func (l *SessionLog) Cursor(agentServer, sessionID string) SessionCursorInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.peekLocked(agentServer, sessionID)
	return SessionCursorInfo{
		Epoch:        l.epoch,
		Seq:          entry.seq,
		TurnActive:   entry.activeTurns > 0,
		TurnStartSeq: entry.turnStartSeq,
	}
}

// MarkSessionHistory records whether live events alone reconstruct this
// session: true for a session this helper just created (its history starts at
// seq 1), false when agent-side history was attached without a captured
// replay (session/resume). Invalidating an unknown session is a no-op — a
// missing entry already has no complete history, and a later publish creates
// one marked incomplete.
func (l *SessionLog) MarkSessionHistory(agentServer, sessionID string, complete bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !complete && l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}] == nil {
		return
	}
	entry := l.entryLocked(agentServer, sessionID)
	l.setHistoryLocked(entry, nil)
	entry.historySeq = 0
	entry.completeHistory = complete
}

// BeginLoadHistory starts capturing a session/load's replay. ACP session/load
// replays the session's entire history, so once the load succeeds the replay
// (RecordLoadHistory) followed by every event published from this point on is
// the complete transcript. Until EndLoadHistory the session's previous
// snapshot no longer describes the agent's state and is dropped. The stream
// seq is not touched: remote cursors stay valid and Resume never replays
// history.
func (l *SessionLog) BeginLoadHistory(agentServer, sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agentServer, sessionID)
	l.setHistoryLocked(entry, nil)
	entry.completeHistory = false
	entry.capturing = true
	entry.pending = nil
	entry.pendingSeq = entry.seq
}

// RecordLoadHistory appends one replayed message to the in-flight load's
// capture. Callers deliver replay messages in agent order on the session's
// notification queue. Captures that outgrow the buffer cap are abandoned.
func (l *SessionLog) RecordLoadHistory(agentServer, sessionID string, message map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil || !entry.capturing {
		return
	}
	if len(entry.pending) >= sessionLogBufferCap {
		entry.capturing = false
		entry.pending = nil
		return
	}
	entry.pending = append(entry.pending, message)
}

// EndLoadHistory finishes the in-flight load's capture. A successful load's
// replay becomes the session's history snapshot, replacing any earlier one
// (an agent replay is a full transcript, so snapshots never accumulate);
// otherwise the session has no complete history. It must run after every
// replay message was recorded.
func (l *SessionLog) EndLoadHistory(agentServer, sessionID string, loaded bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil {
		return
	}
	captured, ok := entry.pending, entry.capturing && loaded
	entry.capturing = false
	entry.pending = nil
	if !ok {
		l.setHistoryLocked(entry, nil)
		entry.completeHistory = false
		return
	}
	if captured == nil {
		captured = []map[string]any{}
	}
	entry.historySeq = entry.pendingSeq
	l.setHistoryLocked(entry, captured)
	entry.completeHistory = true
	l.fitHistoryLocked(entry)
	l.trimHistoryBudgetLocked(entry)
}

// ForgetSession drops a session's slot and buffered events. It is for
// throwaway sessions (config probes) closed right after creation; a session
// with a turn in flight is kept so its stream stays intact.
func (l *SessionLog) ForgetSession(agentServer, sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := sessionLogKey{agentServer: agentServer, sessionID: sessionID}
	if entry := l.sessions[key]; entry != nil && entry.activeTurns == 0 {
		l.setHistoryLocked(entry, nil)
		delete(l.sessions, key)
	}
}

// SessionReplay returns a complete, ordered snapshot — the latest load's
// replayed history followed by every live event published since — or refuses
// it. Callers serialize this and its delivery with live publishes on the ACP
// event queue. Remotes have a bounded delivery queue, so refuse an oversized
// replay before sending anything rather than disconnecting the reader halfway
// through.
func (l *SessionLog) SessionReplay(agentServer, sessionID, originID string) ([]map[string]any, SessionCursorInfo, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil || !entry.completeHistory || !l.coversHistoryLocked(entry) {
		return nil, SessionCursorInfo{}, false
	}
	total := len(entry.history) + int(entry.seq-entry.historySeq)
	if originID != PrimaryOrigin && total >= sessionLogMaxReplay {
		return nil, SessionCursorInfo{}, false
	}
	messages := make([]map[string]any, 0, total)
	messages = append(messages, entry.history...)
	for _, event := range entry.events {
		if event.seq <= entry.historySeq {
			continue
		}
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

// entryLocked returns the session's entry, creating it (and evicting the least
// recently used idle session when full) and bumping its recency. Only writers
// — publishes, turn boundaries, history marks — may call it.
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

// peekLocked returns the session's entry without creating it or bumping its
// recency, so reads (control polls, cursors) across many conversations cannot
// evict the retained history of sessions that are actually publishing. An
// unknown session reads as an empty stream at seq 0 in the current epoch; a
// cursor taken from it stays valid because the first publish creates the entry
// and stamps seq 1. The returned zero entry is detached and must not be
// mutated.
func (l *SessionLog) peekLocked(agentServer, sessionID string) *sessionLogEntry {
	if entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]; entry != nil {
		return entry
	}
	return &sessionLogEntry{}
}

// compactLocked drops the oldest buffered events past the buffer cap, and a
// history snapshot that no longer fits beside the events that follow it.
func (l *SessionLog) compactLocked(entry *sessionLogEntry) {
	if excess := len(entry.events) - sessionLogBufferCap; excess > 0 {
		entry.events = append([]loggedEvent(nil), entry.events[excess:]...)
	}
	l.fitHistoryLocked(entry)
}

// coversHistoryLocked reports whether the buffer still holds every event
// published after historySeq.
func (l *SessionLog) coversHistoryLocked(entry *sessionLogEntry) bool {
	if entry.seq <= entry.historySeq {
		return true
	}
	return len(entry.events) > 0 && entry.events[0].seq <= entry.historySeq+1
}

// fitHistoryLocked drops a history snapshot whose transcript (snapshot plus
// the live events after it) exceeds the per-session buffer cap.
func (l *SessionLog) fitHistoryLocked(entry *sessionLogEntry) {
	if entry.history != nil && len(entry.history)+int(entry.seq-entry.historySeq) > sessionLogBufferCap {
		l.setHistoryLocked(entry, nil)
		entry.completeHistory = false
	}
}

// trimHistoryBudgetLocked drops the snapshots of the least recently used idle
// sessions (never keep's) until retained snapshots fit the global budget.
func (l *SessionLog) trimHistoryBudgetLocked(keep *sessionLogEntry) {
	for l.historyEvents > sessionLogMaxHistoryEvents {
		var oldest *sessionLogEntry
		for _, entry := range l.sessions {
			if entry == keep || entry.activeTurns > 0 || len(entry.history) == 0 {
				continue
			}
			if oldest == nil || entry.lastUse < oldest.lastUse {
				oldest = entry
			}
		}
		if oldest == nil {
			return
		}
		l.setHistoryLocked(oldest, nil)
		oldest.completeHistory = false
	}
}

// setHistoryLocked replaces the entry's snapshot, keeping the global count.
func (l *SessionLog) setHistoryLocked(entry *sessionLogEntry, history []map[string]any) {
	l.historyEvents += len(history) - len(entry.history)
	entry.history = history
}

// evictIdleSessionLocked removes the least recently used session that has no
// turn or load in flight; resumes targeting it will fail and fall back to a reload.
func (l *SessionLog) evictIdleSessionLocked() {
	var oldestKey sessionLogKey
	var oldest *sessionLogEntry
	for key, entry := range l.sessions {
		if entry.activeTurns > 0 || entry.capturing {
			continue
		}
		if oldest == nil || entry.lastUse < oldest.lastUse {
			oldestKey, oldest = key, entry
		}
	}
	if oldest != nil {
		l.setHistoryLocked(oldest, nil)
		delete(l.sessions, oldestKey)
	}
}
