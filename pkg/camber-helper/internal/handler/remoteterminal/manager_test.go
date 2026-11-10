package remoteterminal

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// notifyRecorder collects the manager's client notifications.
type notifyRecorder struct {
	mu     sync.Mutex
	writes map[string]string // terminalId -> concatenated output
	exits  map[string]int
	events chan struct{}
}

func newNotifyRecorder() *notifyRecorder {
	return &notifyRecorder{
		writes: map[string]string{},
		exits:  map[string]int{},
		events: make(chan struct{}, 256),
	}
}

func (r *notifyRecorder) notify(originID string, method string, params any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch p := params.(type) {
	case methods.RemoteTerminalDidWriteParams:
		r.writes[p.TerminalID] += p.Data
	case methods.RemoteTerminalDidExitParams:
		code := -999
		if p.ExitCode != nil {
			code = *p.ExitCode
		}
		r.exits[p.TerminalID] = code
	}
	select {
	case r.events <- struct{}{}:
	default:
	}
}

func (r *notifyRecorder) output(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writes[id]
}

func (r *notifyRecorder) exitCode(id string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	code, ok := r.exits[id]
	return code, ok
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	require.Eventually(t, cond, 10*time.Second, 20*time.Millisecond)
}

func TestCommandOutputAndExit(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	rec := newNotifyRecorder()
	m := NewManager(rec.notify)
	defer func() { _ = m.Close() }()

	tab, err := m.Create("remote:dev/conn1", methods.RemoteTerminalCreateParams{
		Cwd:     t.TempDir(),
		Command: "printf remote-terminal-hello; exit 3",
	})
	require.NoError(t, err)
	require.NotEmpty(t, tab.ID)

	waitFor(t, func() bool {
		_, exited := rec.exitCode(tab.ID)
		return exited
	})
	code, _ := rec.exitCode(tab.ID)
	assert.Equal(t, 3, code)
	assert.Contains(t, rec.output(tab.ID), "remote-terminal-hello")
}

func TestInteractiveWriteEchoAndDelete(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	rec := newNotifyRecorder()
	m := NewManager(rec.notify)
	defer func() { _ = m.Close() }()

	tab, err := m.Create("remote:dev/conn1", methods.RemoteTerminalCreateParams{Cwd: t.TempDir()})
	require.NoError(t, err)

	require.NoError(t, m.Write(tab.ID, "printf marker-$((40+2))\n"))
	waitFor(t, func() bool { return strings.Contains(rec.output(tab.ID), "marker-42") })

	require.NoError(t, m.Delete(tab.ID))
	waitFor(t, func() bool {
		_, exited := rec.exitCode(tab.ID)
		return exited
	})
	assert.Empty(t, m.List())
	assert.ErrorIs(t, m.Write(tab.ID, "x"), ErrNotFound)
}

func TestAttachBackfill(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	rec := newNotifyRecorder()
	m := NewManager(rec.notify)
	defer func() { _ = m.Close() }()

	tab, err := m.Create("remote:dev/conn1", methods.RemoteTerminalCreateParams{
		Cwd:     t.TempDir(),
		Command: "printf abcdef",
	})
	require.NoError(t, err)
	waitFor(t, func() bool {
		_, exited := rec.exitCode(tab.ID)
		return exited
	})
	full := rec.output(tab.ID)
	require.Contains(t, full, "abcdef")

	results := m.Attach("remote:dev/conn2", []methods.RemoteTerminalAttachSession{
		{TerminalID: tab.ID, SinceSeq: 0},
		{TerminalID: "missing", SinceSeq: 0},
	})
	require.Len(t, results, 2)

	require.True(t, results[0].Alive)
	assert.Equal(t, full, results[0].Data)
	assert.Equal(t, int64(len(full)), results[0].Seq)
	require.NotNil(t, results[0].ExitCode)
	assert.Equal(t, 0, *results[0].ExitCode)

	// A caught-up client gets no backfill.
	caughtUp := m.Attach("remote:dev/conn2", []methods.RemoteTerminalAttachSession{
		{TerminalID: tab.ID, SinceSeq: results[0].Seq},
	})
	require.Len(t, caughtUp, 1)
	assert.Empty(t, caughtUp[0].Data)

	assert.False(t, results[1].Alive)
}

func TestCloseForPath(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	rec := newNotifyRecorder()
	m := NewManager(rec.notify)
	defer func() { _ = m.Close() }()

	dir := t.TempDir()
	_, err := m.Create("remote:dev/conn1", methods.RemoteTerminalCreateParams{Cwd: dir})
	require.NoError(t, err)
	require.Len(t, m.List(), 1)

	m.CloseForPath(dir)
	assert.Empty(t, m.List())
}

func TestCreateRejectsMissingCwd(t *testing.T) {
	rec := newNotifyRecorder()
	m := NewManager(rec.notify)
	_, err := m.Create("origin", methods.RemoteTerminalCreateParams{Cwd: "/definitely/not/a/dir"})
	assert.Error(t, err)
	_, err = m.Create("origin", methods.RemoteTerminalCreateParams{})
	assert.Error(t, err)
}

func TestCompleteUTF8HoldsBackSplitRunes(t *testing.T) {
	var tail []byte
	// "é" is 0xC3 0xA9; split it across two reads.
	first := completeUTF8(&tail, []byte{'a', 0xC3})
	assert.Equal(t, []byte("a"), first)
	assert.Equal(t, []byte{0xC3}, tail)

	second := completeUTF8(&tail, []byte{0xA9, 'b'})
	assert.Equal(t, []byte("éb"), second)
	assert.Empty(t, tail)
}

func TestLocaleEnvDefaultsToUTF8OnlyWhenUnset(t *testing.T) {
	assert.Equal(t, []string{"LANG=en_US.UTF-8"}, localeEnv(nil))
	assert.Equal(t, []string{"LANG=en_US.UTF-8"}, localeEnv([]string{"TERM=xterm-256color", "LANG=", "LANGUAGE=en"}))
	assert.Nil(t, localeEnv([]string{"LANG=de_DE.UTF-8"}))
	assert.Nil(t, localeEnv([]string{"LC_ALL=C"}))
}
