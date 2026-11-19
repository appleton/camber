package remoteaccess

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

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

func TestLoadHistoryReplaysLatestLoadThenLiveEvents(t *testing.T) {
	log := NewSessionLog(NewHub())
	// Events from earlier in this helper lifetime, before any load.
	require.Equal(t, int64(1), log.Publish("claude", "s", "", false, testMessage(1)))
	require.Equal(t, int64(2), log.Publish("claude", "s", "", false, testMessage(2)))

	loadHistory(log, "s", "h1", "h2")
	require.Equal(t, int64(3), log.Publish("claude", "s", "", false, testMessage(3)), "seq stays monotonic across loads")
	log.BeginTurn("claude", "s")

	messages, cursor, ok := log.SessionReplay("claude", "s", PrimaryOrigin)
	require.True(t, ok, "a captured load replay is a complete transcript")
	assert.Equal(t, []map[string]any{historyMessage("h1"), historyMessage("h2"), testMessage(3)}, messages,
		"events published before the load are not repeated ahead of the agent's full replay")
	assert.Equal(t, int64(3), cursor.Seq)
	assert.True(t, cursor.TurnActive)

	// A second load replays the whole history again: only the latest counts.
	log.EndTurn("claude", "s")
	loadHistory(log, "s", "h1", "h2", "h3")
	require.Equal(t, int64(4), log.Publish("claude", "s", "", false, testMessage(4)))
	messages, cursor, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1"), historyMessage("h2"), historyMessage("h3"), testMessage(4)}, messages)
	assert.Equal(t, int64(4), cursor.Seq)
}

func TestLoadHistoryOfUnknownSessionStartsAtSeqZero(t *testing.T) {
	log := NewSessionLog(NewHub())
	loadHistory(log, "idle", "h1")
	messages, cursor, ok := log.SessionReplay("claude", "idle", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1")}, messages)
	assert.Zero(t, cursor.Seq)
	require.Equal(t, int64(1), log.Publish("claude", "idle", "", false, testMessage(1)))
	messages, _, ok = log.SessionReplay("claude", "idle", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{historyMessage("h1"), testMessage(1)}, messages)
}

func TestLoadHistoryRefusedWhileLoadingOrAfterFailedLoad(t *testing.T) {
	log := NewSessionLog(NewHub())
	loadHistory(log, "s", "h1")

	log.BeginLoadHistory("claude", "s")
	log.RecordLoadHistory("claude", "s", historyMessage("h1"))
	_, _, ok := log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok, "an in-flight load replaces the previous snapshot")
	log.EndLoadHistory("claude", "s", false)
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok, "a failed load leaves no complete history")

	// Messages outside a capture are ignored.
	log.RecordLoadHistory("claude", "s", historyMessage("stray"))
	log.EndLoadHistory("claude", "s", true)
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok)
}

func TestLoadHistoryRefusedOnceItNoLongerFits(t *testing.T) {
	log := NewSessionLog(NewHub())
	loadHistory(log, "s", "h1", "h2")
	for i := 0; i < sessionLogBufferCap-2; i++ {
		log.Publish("claude", "s", "", false, testMessage(i))
	}
	_, _, ok := log.SessionReplay("claude", "s", PrimaryOrigin)
	require.True(t, ok, "history plus live events at the cap is still complete")
	log.Publish("claude", "s", "", false, testMessage(-1))
	_, _, ok = log.SessionReplay("claude", "s", PrimaryOrigin)
	assert.False(t, ok, "never present a transcript that outgrew the buffer")

	// An oversized replay is abandoned at capture time.
	log.BeginLoadHistory("claude", "big")
	for i := 0; i <= sessionLogBufferCap; i++ {
		log.RecordLoadHistory("claude", "big", historyMessage(fmt.Sprint(i)))
	}
	log.EndLoadHistory("claude", "big", true)
	_, _, ok = log.SessionReplay("claude", "big", PrimaryOrigin)
	assert.False(t, ok)
}

func TestLoadHistoryRefusesRemoteOverflow(t *testing.T) {
	log := NewSessionLog(NewHub())
	labels := make([]string, sessionLogMaxReplay-1)
	for i := range labels {
		labels[i] = fmt.Sprint(i)
	}
	loadHistory(log, "s", labels...)
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

func TestLoadHistoryGlobalBudgetDropsLeastRecentlyUsedSnapshot(t *testing.T) {
	log := NewSessionLog(NewHub())
	labels := make([]string, sessionLogBufferCap)
	for i := range labels {
		labels[i] = fmt.Sprint(i)
	}
	sessions := sessionLogMaxHistoryEvents/sessionLogBufferCap + 1
	for i := range sessions {
		loadHistory(log, fmt.Sprintf("s%d", i), labels...)
	}
	_, _, ok := log.SessionReplay("claude", "s0", PrimaryOrigin)
	assert.False(t, ok, "the oldest snapshot is dropped to fit the budget")
	for i := 1; i < sessions; i++ {
		_, _, ok = log.SessionReplay("claude", fmt.Sprintf("s%d", i), PrimaryOrigin)
		assert.True(t, ok, "s%d keeps its snapshot", i)
	}
	assert.Equal(t, sessionLogMaxHistoryEvents, log.historyEvents)

	log.ForgetSession("claude", "s1")
	assert.Equal(t, sessionLogMaxHistoryEvents-sessionLogBufferCap, log.historyEvents)
}
