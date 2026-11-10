package remoteaccess

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type recordedNotify struct {
	mu    sync.Mutex
	calls []notifyMsg
	done  chan struct{}
}

func newRecordedNotify(expect int) *recordedNotify {
	return &recordedNotify{done: make(chan struct{}, expect)}
}

func (r *recordedNotify) fn(ctx context.Context, method string, params any) error {
	r.mu.Lock()
	r.calls = append(r.calls, notifyMsg{method: method, params: params})
	r.mu.Unlock()
	r.done <- struct{}{}
	return nil
}

func (r *recordedNotify) wait(t *testing.T, n int) []notifyMsg {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-r.done:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for notification %d of %d", i+1, n)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]notifyMsg, len(r.calls))
	copy(out, r.calls)
	return out
}

func TestWrapNotifyFansOutFromPrimaryToRemotes(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)

	remote := newRecordedNotify(1)
	unregister := hub.RegisterRemote("remote:a", remote.fn, nil)
	defer unregister()

	wrapped := hub.WrapNotify(PrimaryOrigin, primary.fn)
	require.NoError(t, wrapped(context.Background(), "camber/jsonrpc/notify", "payload"))

	// Origin (primary) is notified synchronously via the original func.
	assert.Len(t, primary.wait(t, 1), 1)
	// Remote receives the fan-out copy through its ordered queue.
	got := remote.wait(t, 1)
	require.Len(t, got, 1)
	assert.Equal(t, "camber/jsonrpc/notify", got[0].method)
	assert.Equal(t, "payload", got[0].params)
}

func TestWrapNotifyFromRemoteReachesPrimaryAndOtherRemotesOnly(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)

	origin := newRecordedNotify(1)
	unregisterOrigin := hub.RegisterRemote("remote:origin", origin.fn, nil)
	defer unregisterOrigin()

	other := newRecordedNotify(1)
	unregisterOther := hub.RegisterRemote("remote:other", other.fn, nil)
	defer unregisterOther()

	wrapped := hub.WrapNotify("remote:origin", origin.fn)
	require.NoError(t, wrapped(context.Background(), "m", 1))

	// Origin got exactly one delivery (the direct one), no fan-out echo.
	origin.wait(t, 1)
	primary.wait(t, 1)
	other.wait(t, 1)

	time.Sleep(50 * time.Millisecond) // allow any (buggy) duplicate to land
	origin.mu.Lock()
	assert.Len(t, origin.calls, 1, "origin must not receive its own notification twice")
	origin.mu.Unlock()
}

func TestRemoteNotificationOrderPreserved(t *testing.T) {
	hub := NewHub()
	remote := newRecordedNotify(100)
	unregister := hub.RegisterRemote("remote:a", remote.fn, nil)
	defer unregister()

	wrapped := hub.WrapNotify(PrimaryOrigin, func(context.Context, string, any) error { return nil })
	for i := 0; i < 100; i++ {
		require.NoError(t, wrapped(context.Background(), "m", i))
	}
	got := remote.wait(t, 100)
	require.Len(t, got, 100)
	for i, msg := range got {
		assert.Equal(t, i, msg.params)
	}
}

func TestQueueOverflowDropsClient(t *testing.T) {
	hub := NewHub()
	dropped := make(chan struct{})
	blocked := make(chan struct{})
	// A notify fn that never completes simulates a stuck socket.
	stuck := func(ctx context.Context, method string, params any) error {
		<-blocked
		return nil
	}
	unregister := hub.RegisterRemote("remote:stuck", stuck, func() { close(dropped) })
	defer unregister()
	defer close(blocked)

	wrapped := hub.WrapNotify(PrimaryOrigin, func(context.Context, string, any) error { return nil })
	// One message is consumed by the writer goroutine and blocks; the queue
	// holds notifyQueueSize more; the next one overflows.
	for i := 0; i < notifyQueueSize+2; i++ {
		require.NoError(t, wrapped(context.Background(), "m", i))
	}

	select {
	case <-dropped:
	case <-time.After(2 * time.Second):
		t.Fatal("expected overflowing client to be dropped")
	}
}

func TestNotifyOthersSentinelSkipsOrigin(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)

	origin := newRecordedNotify(1)
	unregisterOrigin := hub.RegisterRemote("remote:origin", origin.fn, nil)
	defer unregisterOrigin()

	other := newRecordedNotify(1)
	unregisterOther := hub.RegisterRemote("remote:other", other.fn, nil)
	defer unregisterOther()

	wrapped := hub.WrapNotify("remote:origin", origin.fn)
	require.NoError(t, wrapped(context.Background(), methods.NotifyOthersMethod, methods.NotifyOthersParams{
		Method: "camber/jsonrpc/notify",
		Params: "payload",
	}))

	// Primary and the other remote receive the unwrapped notification.
	gotPrimary := primary.wait(t, 1)
	require.Len(t, gotPrimary, 1)
	assert.Equal(t, "camber/jsonrpc/notify", gotPrimary[0].method)
	assert.Equal(t, "payload", gotPrimary[0].params)

	gotOther := other.wait(t, 1)
	require.Len(t, gotOther, 1)
	assert.Equal(t, "camber/jsonrpc/notify", gotOther[0].method)

	// The origin gets nothing at all — it already rendered locally.
	time.Sleep(50 * time.Millisecond)
	origin.mu.Lock()
	assert.Empty(t, origin.calls, "origin must not receive the relayed notification")
	origin.mu.Unlock()
}

func TestNotifyOthersSentinelFromPrimaryReachesRemotesOnly(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)

	remote := newRecordedNotify(1)
	unregister := hub.RegisterRemote("remote:a", remote.fn, nil)
	defer unregister()

	wrapped := hub.WrapNotify(PrimaryOrigin, primary.fn)
	require.NoError(t, wrapped(context.Background(), methods.NotifyOthersMethod, methods.NotifyOthersParams{
		Method: "m",
		Params: 1,
	}))

	got := remote.wait(t, 1)
	require.Len(t, got, 1)
	assert.Equal(t, "m", got[0].method)

	time.Sleep(50 * time.Millisecond)
	primary.mu.Lock()
	assert.Empty(t, primary.calls, "primary origin must not receive its own relay")
	primary.mu.Unlock()
}

func TestNotifyOthersSentinelRejectsWrongParams(t *testing.T) {
	hub := NewHub()
	wrapped := hub.WrapNotify(PrimaryOrigin, func(context.Context, string, any) error { return nil })
	require.Error(t, wrapped(context.Background(), methods.NotifyOthersMethod, "not-a-relay"))
}

// NotifyAll is the approvals/didChange fan-out: every surface — primary AND
// all remotes, with no origin exclusion — receives the pushed state.
func TestNotifyAllReachesPrimaryAndEveryRemote(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)

	remoteA := newRecordedNotify(1)
	unregisterA := hub.RegisterRemote("remote:a", remoteA.fn, nil)
	defer unregisterA()

	remoteB := newRecordedNotify(1)
	unregisterB := hub.RegisterRemote("remote:b", remoteB.fn, nil)
	defer unregisterB()

	hub.NotifyAll(methods.ACPApprovalsDidChangeMethod, methods.ACPApprovalsDidChangeParams{})

	for _, r := range []*recordedNotify{primary, remoteA, remoteB} {
		got := r.wait(t, 1)
		require.Len(t, got, 1)
		assert.Equal(t, methods.ACPApprovalsDidChangeMethod, got[0].method)
	}
}

func TestNotifyRemotesSkipsPrimary(t *testing.T) {
	hub := NewHub()

	primary := newRecordedNotify(1)
	hub.SetPrimary(primary.fn)
	remote := newRecordedNotify(1)
	unregister := hub.RegisterRemote("remote:a", remote.fn, nil)
	defer unregister()

	hub.NotifyRemotes("camber/test", map[string]any{"enabled": true})

	got := remote.wait(t, 1)
	require.Len(t, got, 1)
	assert.Equal(t, "camber/test", got[0].method)
	primary.mu.Lock()
	defer primary.mu.Unlock()
	assert.Empty(t, primary.calls)
}
