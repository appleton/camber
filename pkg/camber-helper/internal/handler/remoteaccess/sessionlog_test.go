package remoteaccess

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func testMessage(i int) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": i}
}

func TestSessionReplayRequiresCompleteHistory(t *testing.T) {
	log := NewSessionLog(NewHub())
	log.Publish("claude", "child", "", false, testMessage(1))
	_, _, ok := log.SessionReplay("claude", "child", PrimaryOrigin)
	assert.False(t, ok, "unknown or previously loaded sessions are not complete transcripts")
	log.MarkSessionHistory("claude", "child", true)
	log.BeginTurn("claude", "child")
	messages, cursor, ok := log.SessionReplay("claude", "child", PrimaryOrigin)
	require.True(t, ok)
	assert.Equal(t, []map[string]any{testMessage(1)}, messages)
	assert.True(t, cursor.TurnActive)
	assert.Equal(t, int64(1), cursor.Seq)
	log.MarkSessionHistory("claude", "child", false)
	_, _, ok = log.SessionReplay("claude", "child", PrimaryOrigin)
	assert.False(t, ok, "agent-side replay invalidates our full-history claim")
}

func TestSessionReplayRefusesEvictionAndRemoteOverflow(t *testing.T) {
	log := NewSessionLog(NewHub())
	log.MarkSessionHistory("claude", "child", true)
	for i := 0; i < sessionLogMaxReplay; i++ {
		log.Publish("claude", "child", "", false, testMessage(i))
	}
	_, _, ok := log.SessionReplay("claude", "child", "remote:device/a")
	assert.False(t, ok)
	_, _, ok = log.SessionReplay("claude", "child", PrimaryOrigin)
	assert.True(t, ok)
	for i := sessionLogMaxReplay; i <= sessionLogBufferCap; i++ {
		log.Publish("claude", "child", "", false, testMessage(i))
	}
	_, _, ok = log.SessionReplay("claude", "child", PrimaryOrigin)
	assert.False(t, ok, "never present an evicted prefix as complete")
}

func eventSeq(t *testing.T, msg notifyMsg) int64 {
	t.Helper()
	params, ok := msg.params.(map[string]any)
	require.True(t, ok, "expected bridge envelope params")
	seq, ok := params[methods.BridgeSessionSeqKey].(int64)
	require.True(t, ok, "expected stamped sequence number")
	return seq
}

func TestPublishStampsAndFansOut(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)

	primary := newRecordedNotify(2)
	hub.SetPrimary(primary.fn)
	remote := newRecordedNotify(2)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()

	require.Equal(t, int64(1), log.Publish("poolside", "s1", "", false, testMessage(1)))
	require.Equal(t, int64(2), log.Publish("poolside", "s1", "", false, testMessage(2)))

	for _, got := range [][]notifyMsg{remote.wait(t, 2), primary.wait(t, 2)} {
		require.Len(t, got, 2)
		for i, msg := range got {
			assert.Equal(t, methods.JSONRPCNotifyMethod, msg.method)
			params := msg.params.(map[string]any)
			assert.Equal(t, "poolside", params["agentServer"])
			assert.Equal(t, int64(i+1), eventSeq(t, msg))
			assert.Equal(t, log.epoch, params[methods.BridgeSessionEpochKey])
		}
	}
}

func TestPublishSeqIsPerSession(t *testing.T) {
	log := NewSessionLog(NewHub())
	assert.Equal(t, int64(1), log.Publish("poolside", "s1", "", false, testMessage(1)))
	assert.Equal(t, int64(1), log.Publish("poolside", "s2", "", false, testMessage(1)))
	assert.Equal(t, int64(2), log.Publish("poolside", "s1", "", false, testMessage(2)))
}

func TestPublishOriginDeviceTagAndSkipPrimary(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)
	origin := newRecordedNotify(2)
	defer hub.RegisterRemote("remote:dev/origin", origin.fn, nil)()
	other := newRecordedNotify(2)
	defer hub.RegisterRemote("remote:dev2/other", other.fn, nil)()

	// A remote device's relayed user message: every remote receives it (the
	// origin's transport drops it by device tag), the primary renders it.
	log.Publish("poolside", "s1", "dev", false, testMessage(1))
	primary.wait(t, 1)
	for _, got := range [][]notifyMsg{origin.wait(t, 1), other.wait(t, 1)} {
		require.Len(t, got, 1)
		params := got[0].params.(map[string]any)
		assert.Equal(t, "dev", params[methods.BridgeOriginDeviceKey])
	}

	// The desktop's own relayed user message: primary skipped, remotes get it
	// untagged.
	log.Publish("poolside", "s1", "", true, testMessage(2))
	gotOther := other.wait(t, 1)
	origin.wait(t, 1)
	params := gotOther[1].params.(map[string]any)
	assert.NotContains(t, params, methods.BridgeOriginDeviceKey)
	primary.mu.Lock()
	assert.Len(t, primary.calls, 1, "primary must not receive its own relayed message")
	primary.mu.Unlock()
}

func TestResumeReplaysAfterCursor(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)

	for i := 1; i <= 5; i++ {
		log.Publish("poolside", "s1", "", false, testMessage(i))
	}

	remote := newRecordedNotify(3)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()

	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 2},
	})
	require.Len(t, out.Sessions, 1)
	assert.True(t, out.Sessions[0].Resumed)

	got := remote.wait(t, 3)
	require.Len(t, got, 3)
	for i, msg := range got {
		assert.Equal(t, int64(3+i), eventSeq(t, msg))
	}
}

func TestResumeAtLatestReplaysNothing(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)
	log.Publish("poolside", "s1", "", false, testMessage(1))

	remote := newRecordedNotify(1)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()

	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 1},
	})
	require.Len(t, out.Sessions, 1)
	require.True(t, out.Sessions[0].Resumed)
	remote.mu.Lock()
	assert.Empty(t, remote.calls)
	remote.mu.Unlock()
}

func TestResumeFailsOnEpochMismatchUnknownSessionOrFutureSeq(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)
	log.Publish("poolside", "s1", "", false, testMessage(1))
	defer hub.RegisterRemote("remote:dev/a", newRecordedNotify(1).fn, nil)()

	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: "other-run", Seq: 1},
		{AgentServer: "poolside", SessionID: "unknown", Epoch: log.epoch, Seq: 1},
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 99},
	})
	require.Len(t, out.Sessions, 3)
	for i, result := range out.Sessions {
		assert.False(t, result.Resumed, "cursor %d must not resume", i)
	}
}

func TestResumeFailsWhenCursorEvicted(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)
	for i := 0; i < sessionLogBufferCap+10; i++ {
		log.Publish("poolside", "s1", "", false, testMessage(i))
	}
	defer hub.RegisterRemote("remote:dev/a", newRecordedNotify(1).fn, nil)()

	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 1},
	})
	require.Len(t, out.Sessions, 1)
	assert.False(t, out.Sessions[0].Resumed, "evicted range must force a reload")
}

func TestResumeFailsBeyondReplayCap(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)
	total := sessionLogMaxReplay + 10
	for i := 0; i < total; i++ {
		log.Publish("poolside", "s1", "", false, testMessage(i))
	}

	remote := newRecordedNotify(sessionLogMaxReplay)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()

	// A range larger than one queue-safe burst cannot be replayed: forcing a
	// reload beats overflowing the client's hub queue and dropping it.
	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 0},
	})
	require.Len(t, out.Sessions, 1)
	assert.False(t, out.Sessions[0].Resumed)

	// Exactly at the cap resumes fine.
	out = log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: int64(total - sessionLogMaxReplay)},
	})
	require.Len(t, out.Sessions, 1)
	require.True(t, out.Sessions[0].Resumed)
	assert.Len(t, remote.wait(t, sessionLogMaxReplay), sessionLogMaxReplay)
}

func TestResumeReplaysTaggedEventsWithoutGaps(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)

	log.Publish("poolside", "s1", "", false, testMessage(1))
	// A user message relayed from device "dev": buffered tagged, replayed to
	// everyone — the tagged device's transport drops the content client-side,
	// which keeps the replayed stream gapless.
	log.Publish("poolside", "s1", "dev", false, testMessage(2))
	log.Publish("poolside", "s1", "", false, testMessage(3))

	same := newRecordedNotify(3)
	defer hub.RegisterRemote("remote:dev/conn2", same.fn, nil)()
	out := log.Resume("remote:dev/conn2", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 0},
	})
	require.Len(t, out.Sessions, 1)
	require.True(t, out.Sessions[0].Resumed)
	got := same.wait(t, 3)
	require.Len(t, got, 3)
	for i, msg := range got {
		assert.Equal(t, int64(i+1), eventSeq(t, msg))
	}
	tagged := got[1].params.(map[string]any)
	assert.Equal(t, "dev", tagged[methods.BridgeOriginDeviceKey])
}

func TestResumeAndConcurrentPublishesStayOrdered(t *testing.T) {
	hub := NewHub()
	log := NewSessionLog(hub)

	for i := 0; i < 50; i++ {
		log.Publish("poolside", "s1", "", false, testMessage(i))
	}

	remote := newRecordedNotify(150)
	defer hub.RegisterRemote("remote:dev/a", remote.fn, nil)()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			log.Publish("poolside", "s1", "", false, testMessage(i))
		}
	}()
	out := log.Resume("remote:dev/a", []methods.RemoteResumeCursor{
		{AgentServer: "poolside", SessionID: "s1", Epoch: log.epoch, Seq: 0},
	})
	require.Len(t, out.Sessions, 1)
	require.True(t, out.Sessions[0].Resumed)
	wg.Wait()

	// A publish racing ahead of Resume's lock may reach the client before the
	// replayed range — the client's reorder buffer absorbs that. The log's
	// guarantee is completeness (every seq exactly once) and order within the
	// replay and within the live stream.
	got := remote.wait(t, 150)
	require.Len(t, got, 150)
	seen := map[int64]bool{}
	lastReplay, lastLive := int64(0), int64(50)
	for _, msg := range got {
		seq := eventSeq(t, msg)
		require.False(t, seen[seq], "seq %d delivered twice", seq)
		seen[seq] = true
		if seq <= 50 {
			require.Greater(t, seq, lastReplay, "replayed events must stay in order")
			lastReplay = seq
		} else {
			require.Greater(t, seq, lastLive, "live events must stay in order")
			lastLive = seq
		}
	}
	require.Len(t, seen, 150, "every event must be delivered exactly once")
}

func TestIdleSessionEviction(t *testing.T) {
	log := NewSessionLog(NewHub())
	log.BeginTurn("poolside", "busy")
	log.Publish("poolside", "busy", "", false, testMessage(0))
	for i := 0; i < sessionLogMaxSessions+10; i++ {
		log.Publish("poolside", fmt.Sprintf("s%d", i), "", false, testMessage(i))
	}

	log.mu.Lock()
	defer log.mu.Unlock()
	assert.LessOrEqual(t, len(log.sessions), sessionLogMaxSessions+1)
	_, busyKept := log.sessions[sessionLogKey{agentServer: "poolside", sessionID: "busy"}]
	assert.True(t, busyKept, "session with an in-flight turn must not be evicted")
}

// A turn's EndTurn is queued behind its final publishes, so it can arrive
// after the next turn's BeginTurn. The late EndTurn must close its own turn,
// not the one now in flight.
func TestOverlappingTurnBoundariesKeepSessionActive(t *testing.T) {
	log := NewSessionLog(NewHub())
	log.BeginTurn("poolside", "s1")
	log.BeginTurn("poolside", "s1")
	log.EndTurn("poolside", "s1")

	assert.True(t, log.Cursor("poolside", "s1").TurnActive,
		"the second turn must stay active after the first turn's late EndTurn")
	for i := 0; i < sessionLogMaxSessions+10; i++ {
		log.Publish("poolside", fmt.Sprintf("s%d", i+2), "", false, testMessage(i))
	}
	log.mu.Lock()
	_, kept := log.sessions[sessionLogKey{agentServer: "poolside", sessionID: "s1"}]
	log.mu.Unlock()
	assert.True(t, kept, "session with an in-flight turn must not be evicted")

	log.EndTurn("poolside", "s1")
	assert.False(t, log.Cursor("poolside", "s1").TurnActive)
	// An unmatched EndTurn (e.g. a replayed boundary) must not underflow into
	// marking a future turn ended.
	log.EndTurn("poolside", "s1")
	log.BeginTurn("poolside", "s1")
	assert.True(t, log.Cursor("poolside", "s1").TurnActive)
}
