package remoteaccess

import (
	"context"
	"log/slog"
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
// for concurrent live traffic; buffering much beyond it is pointless. The
// same cap refuses oversized live-attach replays to remote clients.
//
// A session's transcript (the latest session/load replay, or nothing for a
// session this helper created, followed by every live event since) is kept
// so a later live attach can present it whole, with no per-session message
// cap: the bounded live buffer hands events it compacts away to the
// transcript instead of dropping them. Transcripts live in historyStores that
// spill to disk past sessionLogHistoryMemBatch messages, and
// sessionLogMaxHistoryMemory bounds the messages held in memory across all of
// them (the largest are spilled first). sessionLogMaxHistoryDiskBytes bounds
// the spill files: past it, the transcripts of the least recently used
// sessions with no turn or load in flight are dropped (never a running
// session's).
const (
	sessionLogBufferCap           = 2048
	sessionLogMaxReplay           = notifyQueueSize / 2
	sessionLogMaxSessions         = 128
	sessionLogHistoryMemBatch     = 256
	sessionLogMaxHistoryMemory    = 8 * sessionLogBufferCap
	sessionLogMaxHistoryDiskBytes = 1 << 30
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
	// was captured in full (history starts as that replay, historySeq as the
	// stream position when the load began). Live events compacted out of the
	// bounded buffer are appended to history, advancing historySeq, so the
	// transcript survives any number of events.
	completeHistory bool
	historySeq      int64
	history         *historyStore
	// capturing is set while a session/load is in flight; its replay is
	// collected in pending and becomes history only if the load succeeds.
	capturing  bool
	pending    *historyStore
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
	// historyMemory counts transcript messages held in memory across all
	// stores (see sessionLogMaxHistoryMemory); historyDiskBytes the bytes in
	// their spill files (see maxHistoryDiskBytes).
	historyMemory       int
	historyDiskBytes    int64
	maxHistoryDiskBytes int64
	// Spill files live in historyDir (historyRoot/epoch), created and locked
	// on first spill.
	historyRoot      string
	historyDir       string
	historyDirUnlock func()
	historyFileSeq   int64
}

func NewSessionLog(hub *Hub) *SessionLog {
	return &SessionLog{
		hub:      hub,
		epoch:    uuid.NewString(),
		sessions: map[sessionLogKey]*sessionLogEntry{},

		maxHistoryDiskBytes: sessionLogMaxHistoryDiskBytes,
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
	l.trimHistoryLocked(entry)
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

// BeginTurn pins the upcoming turn's first sequence number so session/load
// responses can report it. The whole in-flight turn stays in the session's
// transcript however long it runs (compacted events move to history), and a
// session with a turn in flight never loses its transcript to the budgets.
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
	l.dropHistoryLocked(entry)
	entry.historySeq = 0
	if complete {
		entry.history = &historyStore{}
		entry.completeHistory = true
	}
}

// HasCompleteHistory reports whether a live attach of the session would
// present its whole transcript (ignoring the remote replay cap). It is a pure
// read.
func (l *SessionLog) HasCompleteHistory(agentServer, sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	return entry != nil && entry.completeHistory && l.coversHistoryLocked(entry)
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
	l.dropHistoryLocked(entry)
	l.releaseStoreLocked(entry.pending)
	entry.capturing = true
	entry.pending = &historyStore{}
	entry.pendingSeq = entry.seq
}

// RecordLoadHistory appends one replayed message to the in-flight load's
// capture. Callers deliver replay messages in agent order on the session's
// notification queue. Large captures spill to disk; a capture is abandoned
// only if spilling fails.
func (l *SessionLog) RecordLoadHistory(agentServer, sessionID string, message map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil || !entry.capturing {
		return
	}
	if err := l.appendHistoryLocked(entry.pending, message); err != nil {
		slog.Warn("remoteaccess: abandoning session history capture", "agentServer", agentServer, "sessionId", sessionID, "error", err)
		l.releaseStoreLocked(entry.pending)
		entry.capturing = false
		entry.pending = nil
		return
	}
	l.trimHistoryLocked(entry)
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
	captured, ok := entry.pending, entry.capturing && loaded && entry.pending != nil
	entry.capturing = false
	entry.pending = nil
	l.dropHistoryLocked(entry)
	if !ok {
		l.releaseStoreLocked(captured)
		return
	}
	entry.historySeq = entry.pendingSeq
	entry.history = captured
	entry.completeHistory = true
	l.trimHistoryLocked(entry)
}

// ForgetSession drops a session's slot and buffered events. It is for
// throwaway sessions (config probes) closed right after creation; a session
// with a turn in flight is kept so its stream stays intact.
func (l *SessionLog) ForgetSession(agentServer, sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := sessionLogKey{agentServer: agentServer, sessionID: sessionID}
	if entry := l.sessions[key]; entry != nil && entry.activeTurns == 0 {
		l.releaseEntryLocked(entry)
		delete(l.sessions, key)
	}
}

// ReplayStream delivers a session replay's messages in order to emit,
// stopping at emit's first error. It must be called exactly once (it releases
// the snapshot's resources) and may run after the SessionLog lock is gone.
type ReplayStream func(emit func(message map[string]any) error) error

// SessionReplay returns a complete, ordered snapshot — the session's retained
// transcript followed by every live event published since — or refuses it.
// The transcript may be partly on disk, so it is returned as a stream read
// lazily. Callers serialize this and the stream's delivery with live
// publishes on the ACP event queue. Remotes have a bounded delivery queue, so
// refuse an oversized replay to them before sending anything rather than
// disconnecting the reader halfway through.
func (l *SessionLog) SessionReplay(agentServer, sessionID, originID string) (ReplayStream, SessionCursorInfo, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.sessions[sessionLogKey{agentServer: agentServer, sessionID: sessionID}]
	if entry == nil || !entry.completeHistory || !l.coversHistoryLocked(entry) {
		return nil, SessionCursorInfo{}, false
	}
	total := entry.history.len() + int(entry.seq-entry.historySeq)
	if originID != PrimaryOrigin && total >= sessionLogMaxReplay {
		return nil, SessionCursorInfo{}, false
	}
	live := make([]map[string]any, 0, int(entry.seq-entry.historySeq))
	for _, event := range entry.events {
		if event.seq <= entry.historySeq {
			continue
		}
		message, ok := eventMessage(event)
		if !ok {
			return nil, SessionCursorInfo{}, false
		}
		live = append(live, message)
	}
	snapshot, err := l.snapshotLocked(entry.history)
	if err != nil {
		slog.Warn("remoteaccess: dropping unreadable session history", "agentServer", agentServer, "sessionId", sessionID, "error", err)
		l.dropHistoryLocked(entry)
		return nil, SessionCursorInfo{}, false
	}
	stream := func(emit func(map[string]any) error) error {
		defer snapshot.close()
		if err := snapshot.each(emit); err != nil {
			return err
		}
		for _, message := range live {
			if err := emit(message); err != nil {
				return err
			}
		}
		return nil
	}
	return stream, SessionCursorInfo{Epoch: l.epoch, Seq: entry.seq, TurnActive: entry.activeTurns > 0}, true
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

// compactLocked drops the oldest buffered events past the buffer cap. Events
// that belong to a complete transcript move to its history instead of being
// lost; without a complete transcript they are simply dropped.
func (l *SessionLog) compactLocked(entry *sessionLogEntry) {
	excess := len(entry.events) - sessionLogBufferCap
	if excess <= 0 {
		return
	}
	for _, event := range entry.events[:excess] {
		if !entry.completeHistory || event.seq <= entry.historySeq {
			continue
		}
		message, ok := eventMessage(event)
		if !ok || event.seq != entry.historySeq+1 {
			l.dropHistoryLocked(entry)
			continue
		}
		if err := l.appendHistoryLocked(entry.history, message); err != nil {
			slog.Warn("remoteaccess: dropping session history", "error", err)
			l.dropHistoryLocked(entry)
			continue
		}
		entry.historySeq = event.seq
	}
	entry.events = append([]loggedEvent(nil), entry.events[excess:]...)
}

// coversHistoryLocked reports whether the buffer still holds every event
// published after historySeq.
func (l *SessionLog) coversHistoryLocked(entry *sessionLogEntry) bool {
	if entry.seq <= entry.historySeq {
		return true
	}
	return len(entry.events) > 0 && entry.events[0].seq <= entry.historySeq+1
}

// trimHistoryLocked enforces the transcript budgets after keep's stores grew:
// memory by spilling the stores holding the most messages in memory, disk by
// dropping the transcripts of the least recently used sessions with no turn
// or load in flight (never keep's).
func (l *SessionLog) trimHistoryLocked(keep *sessionLogEntry) {
	for l.historyMemory > sessionLogMaxHistoryMemory {
		var largest *historyStore
		var owner *sessionLogEntry
		for _, entry := range l.sessions {
			for _, store := range []*historyStore{entry.history, entry.pending} {
				if store != nil && (largest == nil || len(store.mem) > len(largest.mem)) {
					largest, owner = store, entry
				}
			}
		}
		if largest == nil || len(largest.mem) == 0 {
			break
		}
		if err := l.spillLocked(largest); err != nil {
			slog.Warn("remoteaccess: dropping session history that could not be spilled", "error", err)
			if largest == owner.pending {
				l.releaseStoreLocked(owner.pending)
				owner.pending, owner.capturing = nil, false
			} else {
				l.dropHistoryLocked(owner)
			}
		}
	}
	for l.historyDiskBytes > l.maxHistoryDiskBytes {
		var oldest *sessionLogEntry
		for _, entry := range l.sessions {
			if entry == keep || entry.activeTurns > 0 || entry.capturing || entry.history == nil || entry.history.size == 0 {
				continue
			}
			if oldest == nil || entry.lastUse < oldest.lastUse {
				oldest = entry
			}
		}
		if oldest == nil {
			return
		}
		l.dropHistoryLocked(oldest)
	}
}

// dropHistoryLocked releases the entry's transcript: it no longer has a
// complete history.
func (l *SessionLog) dropHistoryLocked(entry *sessionLogEntry) {
	l.releaseStoreLocked(entry.history)
	entry.history = nil
	entry.completeHistory = false
}

// releaseEntryLocked frees everything the entry retains outside its event
// buffer, ahead of deleting it.
func (l *SessionLog) releaseEntryLocked(entry *sessionLogEntry) {
	l.dropHistoryLocked(entry)
	l.releaseStoreLocked(entry.pending)
	entry.pending = nil
	entry.capturing = false
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
		l.releaseEntryLocked(oldest)
		delete(l.sessions, oldestKey)
	}
}

// eventMessage extracts the raw agent message from a buffered event's bridge
// envelope.
func eventMessage(event loggedEvent) (map[string]any, bool) {
	envelope, ok := event.params.(map[string]any)
	if !ok {
		return nil, false
	}
	message, ok := envelope["message"].(map[string]any)
	return message, ok
}
