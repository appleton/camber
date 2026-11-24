package remoteaccess

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// newTestSessionLog returns a log whose spill files live in a test temp dir
// and are removed with it.
func newTestSessionLog(t *testing.T) *SessionLog {
	t.Helper()
	log := NewSessionLog(NewHub())
	log.UseHistoryDir(t.TempDir())
	t.Cleanup(func() { _ = log.Close() })
	return log
}

// replayAll collects a session replay's stream.
func replayAll(t *testing.T, log *SessionLog, sessionID, origin string) ([]map[string]any, SessionCursorInfo, bool) {
	t.Helper()
	stream, cursor, ok := log.SessionReplay("claude", sessionID, origin)
	if !ok {
		return nil, cursor, false
	}
	var messages []map[string]any
	require.NoError(t, stream(func(message map[string]any) error {
		messages = append(messages, message)
		return nil
	}))
	return messages, cursor, true
}

func historyMessage(label string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": label}
}

// loadHistory simulates a successful session/load whose agent replays labels.
func loadHistory(log *SessionLog, sessionID string, labels ...string) {
	log.BeginLoadHistory("claude", sessionID)
	for _, label := range labels {
		log.RecordLoadHistory("claude", sessionID, historyMessage(label))
	}
	log.EndLoadHistory("claude", sessionID, true)
}

func labelsN(prefix string, n int) []string {
	labels := make([]string, n)
	for i := range labels {
		labels[i] = fmt.Sprintf("%s%d", prefix, i)
	}
	return labels
}

// spillFiles lists the log's spill files.
func spillFiles(t *testing.T, log *SessionLog) []string {
	t.Helper()
	log.mu.Lock()
	dir := log.historyDir
	log.mu.Unlock()
	if dir == "" {
		return nil
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	require.NoError(t, err)
	return files
}

func TestLoadHistoryReplaysLatestLoadThenLiveEvents(t *testing.T) {
	log := newTestSessionLog(t)
	// Events from earlier in this helper lifetime, before any load.
	require.Equal(t, int64(1), log.Publish("claude", "s", "", false, testMessage(1)))
	require.Equal(t, int64(2), log.Publish("claude", "s", "", false, testMessage(2)))

	loadHistory(log, "s", "h1", "h2")
	require.Equal(t, int64(3), log.Publish("claude", "s", "", false, testMessage(3)), "seq stays monotonic across loads")
	log.BeginTurn("claude", "s")

	messages, cursor, ok := replayAll(t, log, "s", PrimaryOrigin)
	require.True(t, ok, "a captured load replay is a complete transcript")
	assert.Equal(t, []map[string]any{historyMessage("h1"), historyMessage("h2"), testMessage(3)}, messages,
		"events published before the load are not repeated ahead of the agent's full replay")
	assert.Equal(t, int64(3), cursor.Seq)
	assert.True(t, cursor.TurnActive)

	// A second load replays the whole history again: only the latest counts.
	log.EndTurn("claude", "s")
	loadHistory(log, "s", "h1", "h2", "h3")
	require.Equal(t, int64(4), log.Publish("claude", "s", "", false, testMessage(4)))
	messages, cursor, ok = replayAll(t, log, "s", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1"), historyMessage("h2"), historyMessage("h3"), testMessage(4)}, messages)
	assert.Equal(t, int64(4), cursor.Seq)
}

func TestLoadHistoryOfUnknownSessionStartsAtSeqZero(t *testing.T) {
	log := newTestSessionLog(t)
	loadHistory(log, "idle", "h1")
	messages, cursor, ok := replayAll(t, log, "idle", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1")}, messages)
	assert.Zero(t, cursor.Seq)
	require.Equal(t, int64(1), log.Publish("claude", "idle", "", false, testMessage(1)))
	messages, _, ok = replayAll(t, log, "idle", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1"), testMessage(1)}, messages)
}

func TestLoadHistoryRefusedWhileLoadingOrAfterFailedLoad(t *testing.T) {
	log := newTestSessionLog(t)
	loadHistory(log, "s", "h1")
	assert.True(t, log.HasCompleteHistory("claude", "s"))

	log.BeginLoadHistory("claude", "s")
	log.RecordLoadHistory("claude", "s", historyMessage("h1"))
	_, _, ok := log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok, "an in-flight load replaces the previous snapshot")
	assert.False(t, log.HasCompleteHistory("claude", "s"))
	log.EndLoadHistory("claude", "s", false)
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok, "a failed load leaves no complete history")

	// Messages outside a capture are ignored.
	log.RecordLoadHistory("claude", "s", historyMessage("stray"))
	log.EndLoadHistory("claude", "s", true)
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok)
	assert.False(t, log.HasCompleteHistory("claude", "unknown"))
}

// TestLoadHistoryBeyondBufferCapReplaysFully covers a long reloaded history
// followed by a long in-flight turn: neither the load's replay nor the turn's
// live events are capped, and the transcript replays in order.
func TestLoadHistoryBeyondBufferCapReplaysFully(t *testing.T) {
	log := newTestSessionLog(t)
	historyLen := 3*sessionLogBufferCap + 5
	loadHistory(log, "s", labelsN("h", historyLen)...)
	log.BeginTurn("claude", "s")
	liveLen := 2*sessionLogBufferCap + 3
	for i := range liveLen {
		log.Publish("claude", "s", "", false, historyMessage(fmt.Sprintf("live%d", i)))
	}
	assert.NotEmpty(t, spillFiles(t, log), "a long transcript spills to disk")

	messages, cursor, ok := replayAll(t, log, "s", PrimaryOrigin)
	require.True(t, ok, "a long transcript is never refused to the desktop")
	require.Len(t, messages, historyLen+liveLen)
	for i := range historyLen {
		assert.Equal(t, historyMessage(fmt.Sprintf("h%d", i)), messages[i])
	}
	for i := range liveLen {
		assert.Equal(t, historyMessage(fmt.Sprintf("live%d", i)), messages[historyLen+i])
	}
	assert.Equal(t, int64(liveLen), cursor.Seq)
	assert.True(t, cursor.TurnActive)

	log.mu.Lock()
	assert.LessOrEqual(t, log.historyMemory, sessionLogMaxHistoryMemory)
	log.mu.Unlock()
}

// TestLoadHistoryStreamSurvivesConcurrentRelease checks that a snapshot taken
// under the lock stays readable when the transcript is replaced before the
// stream is read (the spill file is unlinked).
func TestLoadHistoryStreamSurvivesConcurrentRelease(t *testing.T) {
	log := newTestSessionLog(t)
	labels := labelsN("h", sessionLogHistoryMemBatch*2+1)
	loadHistory(log, "s", labels...)
	stream, _, ok := log.SessionReplay("claude", "s", PrimaryOrigin)
	require.True(t, ok)
	loadHistory(log, "s", "replaced")
	var got []map[string]any
	require.NoError(t, stream(func(message map[string]any) error {
		got = append(got, message)
		return nil
	}))
	require.Len(t, got, len(labels))
	assert.Equal(t, historyMessage(labels[len(labels)-1]), got[len(got)-1])
}

func TestLoadHistorySpillFilesAreCleanedUp(t *testing.T) {
	log := newTestSessionLog(t)
	big := labelsN("h", sessionLogHistoryMemBatch+1)

	loadHistory(log, "a", big...)
	first := spillFiles(t, log)
	require.Len(t, first, 1)

	loadHistory(log, "a", big...)
	second := spillFiles(t, log)
	require.Len(t, second, 1)
	assert.NotEqual(t, first, second, "a later load's capture replaces the earlier transcript's file")

	log.BeginLoadHistory("claude", "b")
	for _, label := range big {
		log.RecordLoadHistory("claude", "b", historyMessage(label))
	}
	assert.Len(t, spillFiles(t, log), 2, "an in-flight capture spills too")
	log.EndLoadHistory("claude", "b", false)
	assert.Equal(t, second, spillFiles(t, log), "a failed load's capture is deleted")

	log.ForgetSession("claude", "a")
	assert.Empty(t, spillFiles(t, log), "forgetting a session deletes its transcript")

	loadHistory(log, "c", big...)
	log.mu.Lock()
	dir := log.historyDir
	log.mu.Unlock()
	require.NoError(t, log.Close())
	_, err := os.Stat(dir)
	assert.ErrorIs(t, err, os.ErrNotExist, "closing the log removes its spill dir")
	log.mu.Lock()
	assert.Zero(t, log.historyDiskBytes)
	assert.Zero(t, log.historyMemory)
	log.mu.Unlock()
}

func TestUseHistoryDirRemovesOnlyStaleInstanceDirs(t *testing.T) {
	root := t.TempDir()
	stale := filepath.Join(root, "stale")
	require.NoError(t, os.MkdirAll(stale, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(stale, historyDirLockName), nil, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(stale, "1.jsonl"), []byte("{}\n"), 0o600))

	other := NewSessionLog(NewHub())
	other.UseHistoryDir(root)
	loadHistory(other, "s", labelsN("h", sessionLogHistoryMemBatch)...)
	t.Cleanup(func() { _ = other.Close() })
	require.Len(t, spillFiles(t, other), 1)

	log := newTestSessionLog(t)
	log.UseHistoryDir(root)
	_, err := os.Stat(stale)
	assert.ErrorIs(t, err, os.ErrNotExist, "an exited instance's spill dir is removed")
	assert.Len(t, spillFiles(t, other), 1, "a running instance's spill dir is kept")
}

func TestLoadHistoryRefusesRemoteOverflow(t *testing.T) {
	log := newTestSessionLog(t)
	loadHistory(log, "s", labelsN("", sessionLogMaxReplay-1)...)
	_, _, ok := log.SessionReplay("claude", "s", "remote:dev/a")
	assert.True(t, ok)
	log.Publish("claude", "s", "", false, testMessage(1))
	_, _, ok = log.SessionReplay("claude", "s", "remote:dev/a")
	assert.False(t, ok, "history counts toward the remote replay burst")
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.True(t, ok)
}

func TestLoadHistoryDoesNotAffectResume(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)
	log.UseHistoryDir(t.TempDir())
	t.Cleanup(func() { _ = log.Close() })
	log.Publish("claude", "s", "", false, testMessage(1))
	log.Publish("claude", "s", "", false, testMessage(2))
	loadHistory(log, "s", "h1", "h2")
	log.Publish("claude", "s", "", false, testMessage(3))

	remote := newRecordedNotify(2)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()
	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "claude", SessionID: "s", Epoch: log.epoch, Seq: 1},
	})
	require.Len(t, out.Sessions, 1)
	assert.True(t, out.Sessions[0].Resumed)
	got := remote.wait(t, 2)
	require.Len(t, got, 2, "Resume replays live events only, never the load snapshot")
	assert.Equal(t, int64(2), eventSeq(t, got[0]))
	assert.Equal(t, int64(3), eventSeq(t, got[1]))
}

// TestLoadHistoryDiskBudgetNeverDropsRunningSessions fills the disk budget
// with idle transcripts and checks that the least recently used idle one is
// dropped first, while sessions with a turn or a load in flight keep theirs.
func TestLoadHistoryDiskBudgetNeverDropsRunningSessions(t *testing.T) {
	log := newTestSessionLog(t)
	big := labelsN("h", sessionLogHistoryMemBatch)
	loadHistory(log, "running", big...)
	log.BeginTurn("claude", "running")
	loadHistory(log, "idle-old", big...)
	loadHistory(log, "idle-new", big...)
	log.BeginLoadHistory("claude", "loading")
	for _, label := range big {
		log.RecordLoadHistory("claude", "loading", historyMessage(label))
	}

	log.mu.Lock()
	perSession := log.historyDiskBytes / 4
	// Room for three transcripts: one must go.
	log.maxHistoryDiskBytes = 3 * perSession
	log.mu.Unlock()
	// The running turn keeps publishing well past the buffer cap; its
	// compacted events grow its transcript but never evict it.
	for i := range sessionLogBufferCap + sessionLogHistoryMemBatch {
		log.Publish("claude", "running", "", false, historyMessage(fmt.Sprint(i)))
	}

	assert.True(t, log.HasCompleteHistory("claude", "running"), "a session with a turn in flight keeps its transcript")
	assert.False(t, log.HasCompleteHistory("claude", "idle-old"), "the least recently used idle transcript is dropped")
	log.EndLoadHistory("claude", "loading", true)
	messages, _, ok := replayAll(t, log, "loading", PrimaryOrigin)
	require.True(t, ok, "a load in flight keeps its capture")
	assert.Len(t, messages, len(big))
	messages, _, ok = replayAll(t, log, "running", PrimaryOrigin)
	require.True(t, ok)
	assert.Len(t, messages, len(big)+sessionLogBufferCap+sessionLogHistoryMemBatch)
}

// TestLoadHistoryMemoryBudgetSpillsInsteadOfDropping loads many small
// transcripts (each under the per-store spill batch) until the global memory
// budget forces spills; every transcript remains replayable.
func TestLoadHistoryMemoryBudgetSpillsInsteadOfDropping(t *testing.T) {
	log := newTestSessionLog(t)
	per := sessionLogHistoryMemBatch - 1
	sessions := sessionLogMaxHistoryMemory/per + 2
	for i := range sessions {
		loadHistory(log, fmt.Sprintf("s%d", i), labelsN("h", per)...)
	}
	log.mu.Lock()
	assert.LessOrEqual(t, log.historyMemory, sessionLogMaxHistoryMemory)
	log.mu.Unlock()
	assert.NotEmpty(t, spillFiles(t, log))
	for i := range sessions {
		messages, _, ok := replayAll(t, log, fmt.Sprintf("s%d", i), PrimaryOrigin)
		require.True(t, ok, "s%d keeps its transcript", i)
		assert.Len(t, messages, per)
	}
}

// TestSpilledHistoryRoundTripsAsJSON documents that spilled messages come back
// as their JSON form, which is what the wire delivers anyway.
func TestSpilledHistoryRoundTripsAsJSON(t *testing.T) {
	log := newTestSessionLog(t)
	log.BeginLoadHistory("claude", "s")
	type payload struct {
		Text string `json:"text"`
	}
	for range sessionLogHistoryMemBatch {
		log.RecordLoadHistory("claude", "s", map[string]any{"method": "session/update", "params": payload{Text: "x"}})
	}
	log.EndLoadHistory("claude", "s", true)
	messages, _, ok := replayAll(t, log, "s", PrimaryOrigin)
	require.True(t, ok)
	require.Len(t, messages, sessionLogHistoryMemBatch)
	want, err := json.Marshal(map[string]any{"method": "session/update", "params": payload{Text: "x"}})
	require.NoError(t, err)
	got, err := json.Marshal(messages[0])
	require.NoError(t, err)
	assert.JSONEq(t, string(want), string(got))
}
