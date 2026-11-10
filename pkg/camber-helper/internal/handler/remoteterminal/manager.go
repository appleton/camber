// Package remoteterminal owns the PTYs the helper spawns on behalf of remote
// (mobile) clients: a plain shell (or a one-shot setup/teardown command) per
// worktree, with output retained for reconnect backfill. These terminals are
// deliberately separate from the desktop app's integrated terminals — the
// desktop process never sees them, and killing one never touches desktop
// state.
package remoteterminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"github.com/google/uuid"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// maxTerminals bounds live PTYs so a misbehaving client cannot fork-bomb the
// helper host through the remote surface.
const maxTerminals = 8

// maxBufferBytes bounds the retained output per terminal used for reconnect
// backfill. Matches the shared UI repository's own replay buffer order of
// magnitude.
const maxBufferBytes = 256 * 1024

const defaultCols, defaultRows = 80, 24

// NotifyFunc delivers a notification to one client connection (the hub's
// NotifyClient).
type NotifyFunc func(originID string, method string, params any)

var ErrNotFound = errors.New("remoteterminal: no such terminal")

// Manager tracks the live remote terminals. All methods are safe for
// concurrent use.
type Manager struct {
	notify NotifyFunc

	mu        sync.Mutex
	terminals map[string]*terminal
}

type terminal struct {
	id           string
	cwd          string
	title        string
	createdAt    string
	worktreePath string

	mu         sync.Mutex
	ptmx       *os.File
	cmd        *exec.Cmd
	subscriber string
	// buf retains the trailing output; bufStart is the absolute byte offset
	// of buf[0] and seq the offset just past the end. utf8Tail holds back an
	// incomplete multi-byte sequence split across PTY reads so every emitted
	// chunk (and the buffer itself) stays valid UTF-8 for JSON transport.
	buf      []byte
	bufStart int64
	seq      int64
	utf8Tail []byte
	exited   bool
	exitCode *int
}

func NewManager(notify NotifyFunc) *Manager {
	return &Manager{notify: notify, terminals: map[string]*terminal{}}
}

// Create spawns a PTY in params.Cwd subscribed to origin. With a Command it
// runs `shell -lc command`; otherwise it starts an interactive login shell.
func (m *Manager) Create(origin string, params methods.RemoteTerminalCreateParams) (methods.RemoteTerminalTab, error) {
	if params.Cwd == "" {
		return methods.RemoteTerminalTab{}, errors.New("remoteterminal: cwd is required")
	}
	if info, err := os.Stat(params.Cwd); err != nil || !info.IsDir() {
		return methods.RemoteTerminalTab{}, fmt.Errorf("remoteterminal: cwd is not a directory: %s", params.Cwd)
	}

	m.mu.Lock()
	if len(m.terminals) >= maxTerminals {
		// Exited terminals are only kept around for attach/exit-code display;
		// evict them before refusing a new shell.
		for id, t := range m.terminals {
			t.mu.Lock()
			exited := t.exited
			t.mu.Unlock()
			if exited {
				delete(m.terminals, id)
			}
		}
	}
	if len(m.terminals) >= maxTerminals {
		m.mu.Unlock()
		return methods.RemoteTerminalTab{}, fmt.Errorf("remoteterminal: too many terminals (max %d)", maxTerminals)
	}
	m.mu.Unlock()

	shell := loginShell()
	var cmd *exec.Cmd
	if params.Command != "" {
		cmd = exec.Command(shell, "-lc", params.Command)
	} else {
		cmd = exec.Command(shell, "-l")
	}
	cmd.Dir = params.Cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.Env = append(cmd.Env, localeEnv(cmd.Env)...)
	for k, v := range params.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	cols, rows := params.Cols, params.Rows
	if cols <= 0 {
		cols = defaultCols
	}
	if rows <= 0 {
		rows = defaultRows
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return methods.RemoteTerminalTab{}, fmt.Errorf("remoteterminal: start shell: %w", err)
	}

	t := &terminal{
		id:           uuid.NewString(),
		cwd:          params.Cwd,
		worktreePath: params.Cwd,
		title:        filepath.Base(params.Cwd),
		createdAt:    time.Now().UTC().Format(time.RFC3339),
		ptmx:         ptmx,
		cmd:          cmd,
		subscriber:   origin,
	}

	m.mu.Lock()
	m.terminals[t.id] = t
	m.mu.Unlock()

	go m.readLoop(t)
	return t.tab(), nil
}

func (m *Manager) Write(id string, data string) error {
	t, err := m.get(id)
	if err != nil {
		return err
	}
	t.mu.Lock()
	ptmx, exited := t.ptmx, t.exited
	t.mu.Unlock()
	if exited {
		return nil
	}
	_, err = ptmx.Write([]byte(data))
	return err
}

func (m *Manager) Resize(id string, cols, rows int) error {
	t, err := m.get(id)
	if err != nil {
		return err
	}
	if cols <= 0 || rows <= 0 {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.exited {
		return nil
	}
	return pty.Setsize(t.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Clear drops the retained buffer (the client already reset its own copy) and
// asks the shell to repaint the prompt.
func (m *Manager) Clear(id string) error {
	t, err := m.get(id)
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.buf = nil
	t.bufStart = t.seq
	exited := t.exited
	ptmx := t.ptmx
	t.mu.Unlock()
	if !exited {
		// Deliver the Ctrl+L off this request: a shell still sourcing its rc
		// files has the PTY in canonical mode with echo, and the kernel would
		// echo the byte as a literal `^L`. Waiting until the line editor
		// flips the PTY to raw mode makes it a silent clear-screen instead.
		// The buffer was already dropped above, so callers need not wait for
		// the repaint.
		//
		// This goroutine may outlive the terminal: kill() closes this same
		// *os.File, so a Write (or the termios ioctl inside waitForRawMode)
		// racing a delete fails with ErrClosed rather than touching a reused
		// fd — Go's runtime refcounts the fd through the os.File.
		go func() {
			waitForRawMode(ptmx, 2*time.Second)
			_, _ = ptmx.Write([]byte("\x0c"))
		}()
	}
	return nil
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	t := m.terminals[id]
	delete(m.terminals, id)
	m.mu.Unlock()
	if t == nil {
		return nil
	}
	t.kill()
	return nil
}

// CloseForPath kills every terminal at or beneath path (a worktree, or a
// project and all its worktrees).
func (m *Manager) CloseForPath(path string) {
	// An empty or root path would produce prefix "/" and match every
	// terminal; no legitimate caller closes "everything by path".
	if strings.TrimSuffix(path, "/") == "" {
		return
	}
	prefix := strings.TrimSuffix(path, "/") + "/"
	m.mu.Lock()
	var doomed []*terminal
	for id, t := range m.terminals {
		if t.worktreePath == path || strings.HasPrefix(t.worktreePath+"/", prefix) {
			doomed = append(doomed, t)
			delete(m.terminals, id)
		}
	}
	m.mu.Unlock()
	for _, t := range doomed {
		t.kill()
	}
}

func (m *Manager) List() []methods.RemoteTerminalTab {
	m.mu.Lock()
	defer m.mu.Unlock()
	tabs := make([]methods.RemoteTerminalTab, 0, len(m.terminals))
	for _, t := range m.terminals {
		tabs = append(tabs, t.tab())
	}
	return tabs
}

// Attach re-subscribes a reconnected client and backfills the output it
// missed. Terminals the manager no longer has come back Alive:false.
func (m *Manager) Attach(origin string, sessions []methods.RemoteTerminalAttachSession) []methods.RemoteTerminalAttachResult {
	results := make([]methods.RemoteTerminalAttachResult, 0, len(sessions))
	for _, s := range sessions {
		t, err := m.get(s.TerminalID)
		if err != nil {
			results = append(results, methods.RemoteTerminalAttachResult{TerminalID: s.TerminalID})
			continue
		}
		t.mu.Lock()
		t.subscriber = origin
		result := methods.RemoteTerminalAttachResult{
			TerminalID: s.TerminalID,
			Alive:      true,
			Seq:        t.seq,
			ExitCode:   t.exitCode,
		}
		switch {
		case s.SinceSeq >= t.seq:
			// Nothing missed.
		case s.SinceSeq >= t.bufStart:
			result.Data = string(t.buf[s.SinceSeq-t.bufStart:])
		default:
			result.Data = string(t.buf)
			result.Truncated = true
		}
		t.mu.Unlock()
		results = append(results, result)
	}
	return results
}

// Close kills every terminal; used on helper shutdown.
func (m *Manager) Close() error {
	m.mu.Lock()
	doomed := make([]*terminal, 0, len(m.terminals))
	for id, t := range m.terminals {
		doomed = append(doomed, t)
		delete(m.terminals, id)
	}
	m.mu.Unlock()
	for _, t := range doomed {
		t.kill()
	}
	return nil
}

func (m *Manager) get(id string) (*terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.terminals[id]
	if t == nil {
		return nil, ErrNotFound
	}
	return t, nil
}

// readLoop pumps PTY output into the retained buffer and streams it to the
// subscribed client, then reports the exit.
func (m *Manager) readLoop(t *terminal) {
	chunk := make([]byte, 8192)
	for {
		n, err := t.ptmx.Read(chunk)
		if n > 0 {
			m.appendAndEmit(t, chunk[:n])
		}
		if err != nil {
			break
		}
	}

	err := t.cmd.Wait()
	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		exitCode = exitErr.ExitCode()
	} else if err != nil {
		exitCode = -1
	}

	t.mu.Lock()
	t.exited = true
	t.exitCode = &exitCode
	subscriber := t.subscriber
	_ = t.ptmx.Close()
	t.mu.Unlock()

	m.notify(subscriber, methods.RemoteTerminalDidExitMethod, methods.RemoteTerminalDidExitParams{
		TerminalID: t.id,
		ExitCode:   &exitCode,
	})
}

func (m *Manager) appendAndEmit(t *terminal, raw []byte) {
	t.mu.Lock()
	data := completeUTF8(&t.utf8Tail, raw)
	if len(data) == 0 {
		t.mu.Unlock()
		return
	}
	t.buf = append(t.buf, data...)
	t.seq += int64(len(data))
	if overflow := len(t.buf) - maxBufferBytes; overflow > 0 {
		trim := runeAlignedTrim(t.buf, overflow)
		t.buf = t.buf[trim:]
		t.bufStart += int64(trim)
	}
	subscriber := t.subscriber
	params := methods.RemoteTerminalDidWriteParams{
		TerminalID: t.id,
		Data:       string(data),
		Seq:        t.seq,
	}
	// Emit under the lock so per-terminal Seq ordering matches delivery order
	// (the hub enqueue is non-blocking).
	m.notify(subscriber, methods.RemoteTerminalDidWriteMethod, params)
	t.mu.Unlock()
}

func (t *terminal) tab() methods.RemoteTerminalTab {
	return methods.RemoteTerminalTab{
		ID:           t.id,
		Title:        t.title,
		Cwd:          t.cwd,
		WorktreePath: t.worktreePath,
		CreatedAt:    t.createdAt,
		ExitCode:     t.exitCode,
	}
}

func (t *terminal) kill() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cmd.Process != nil {
		_ = t.cmd.Process.Kill()
	}
	_ = t.ptmx.Close()
}

func loginShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/sh"
}

// localeEnv returns a LANG entry to append when env carries no locale at all.
// A GUI-launched helper inherits launchd's environment, which has none, and
// locale-aware programs (pagers especially) then treat multibyte UTF-8 output
// as binary and mangle it into <E2><94><82>-style byte escapes (PE-2444).
func localeEnv(env []string) []string {
	for _, entry := range env {
		if strings.HasPrefix(entry, "LANG=") || strings.HasPrefix(entry, "LC_ALL=") {
			if entry != "LANG=" && entry != "LC_ALL=" {
				return nil
			}
		}
	}
	return []string{"LANG=en_US.UTF-8"}
}

// completeUTF8 joins the held-back tail with raw and returns the longest
// prefix that ends on a complete UTF-8 sequence, storing the remainder back
// into tail for the next read.
func completeUTF8(tail *[]byte, raw []byte) []byte {
	data := append(*tail, raw...)
	keep := len(data)
	for keep > 0 && keep > len(data)-utf8.UTFMax {
		r, size := utf8.DecodeLastRune(data[:keep])
		if r != utf8.RuneError || size > 1 {
			break
		}
		// The last byte is not a complete sequence; if it could be the start
		// or middle of one, hold it back. A plain invalid byte passes through.
		b := data[keep-1]
		if b < 0x80 {
			break
		}
		keep--
	}
	*tail = append([]byte(nil), data[keep:]...)
	return data[:keep]
}

// runeAlignedTrim widens trim so the buffer never restarts mid-sequence.
func runeAlignedTrim(buf []byte, trim int) int {
	for trim < len(buf) && buf[trim]&0xC0 == 0x80 {
		trim++
	}
	return trim
}
