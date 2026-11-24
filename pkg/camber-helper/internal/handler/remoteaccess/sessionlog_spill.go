package remoteaccess

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
)

// historyStore holds one retained transcript (a session's history, or an
// in-flight load's capture): the oldest messages spilled to an append-only
// JSON-lines file, the newest in memory. Stores are owned by a SessionLog and
// only touched with its lock held.
type historyStore struct {
	path string
	file *os.File
	// size is the number of bytes written to file; disk the messages in it.
	size int64
	disk int
	mem  []map[string]any
}

func (s *historyStore) len() int {
	if s == nil {
		return 0
	}
	return s.disk + len(s.mem)
}

// historySnapshot is a point-in-time view of a store that stays readable
// after the SessionLog lock is released: the spill file is opened while
// locked (an unlinked file stays readable through the open handle) and read
// only up to the size it had, and the in-memory tail is never mutated in
// place (spilling replaces the slice).
type historySnapshot struct {
	file *os.File
	size int64
	mem  []map[string]any
}

func (s historySnapshot) each(emit func(map[string]any) error) error {
	if s.file != nil {
		reader := bufio.NewReader(io.LimitReader(s.file, s.size))
		for {
			// ReadBytes, not a Scanner: a single message (a large tool
			// output) can exceed any fixed token size.
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				var message map[string]any
				if decodeErr := json.Unmarshal(line, &message); decodeErr != nil {
					return fmt.Errorf("remoteaccess: decode spilled history: %w", decodeErr)
				}
				if emitErr := emit(message); emitErr != nil {
					return emitErr
				}
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return fmt.Errorf("remoteaccess: read spilled history: %w", err)
			}
		}
	}
	for _, message := range s.mem {
		if err := emit(message); err != nil {
			return err
		}
	}
	return nil
}

func (s historySnapshot) close() {
	if s.file != nil {
		_ = s.file.Close()
	}
}

// UseHistoryDir places spilled transcripts under root, one directory per
// helper instance, and removes directories left behind by helper instances
// that are no longer running. Call once during setup, before any traffic.
// Without it, spills go to a directory under os.TempDir.
func (l *SessionLog) UseHistoryDir(root string) {
	l.mu.Lock()
	l.historyRoot = root
	l.mu.Unlock()
	removeStaleHistoryDirs(root)
}

// Close releases every retained transcript and removes this instance's spill
// directory. The log keeps working afterwards (later spills recreate it), so
// a late publish during shutdown is harmless.
func (l *SessionLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, entry := range l.sessions {
		l.dropHistoryLocked(entry)
		l.releaseStoreLocked(entry.pending)
		entry.pending = nil
		entry.capturing = false
	}
	l.closeHistoryDirLocked()
	return nil
}

// appendHistoryLocked adds a message to a store, spilling the store's memory
// to disk once it reaches sessionLogHistoryMemBatch messages.
func (l *SessionLog) appendHistoryLocked(store *historyStore, message map[string]any) error {
	store.mem = append(store.mem, message)
	l.historyMemory++
	if len(store.mem) >= sessionLogHistoryMemBatch {
		return l.spillLocked(store)
	}
	return nil
}

// spillLocked moves a store's in-memory messages to its spill file.
func (l *SessionLog) spillLocked(store *historyStore) error {
	if len(store.mem) == 0 {
		return nil
	}
	if store.file == nil {
		dir, err := l.historyDirLocked()
		if err != nil {
			return err
		}
		l.historyFileSeq++
		path := filepath.Join(dir, strconv.FormatInt(l.historyFileSeq, 10)+".jsonl")
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return fmt.Errorf("remoteaccess: create history spill file: %w", err)
		}
		store.path, store.file = path, file
	}
	var buf []byte
	for _, message := range store.mem {
		line, err := json.Marshal(message)
		if err != nil {
			return fmt.Errorf("remoteaccess: encode history message: %w", err)
		}
		buf = append(append(buf, line...), '\n')
	}
	n, err := store.file.Write(buf)
	store.size += int64(n)
	l.historyDiskBytes += int64(n)
	if err != nil {
		return fmt.Errorf("remoteaccess: write history spill file: %w", err)
	}
	store.disk += len(store.mem)
	l.historyMemory -= len(store.mem)
	// Replace rather than truncate: snapshots may still reference the slice.
	store.mem = nil
	return nil
}

// snapshotLocked opens a readable view of the store (see historySnapshot).
func (l *SessionLog) snapshotLocked(store *historyStore) (historySnapshot, error) {
	snap := historySnapshot{size: store.size, mem: store.mem[:len(store.mem):len(store.mem)]}
	if store.file != nil && store.size > 0 {
		file, err := os.Open(store.path)
		if err != nil {
			return historySnapshot{}, fmt.Errorf("remoteaccess: open history spill file: %w", err)
		}
		snap.file = file
	}
	return snap, nil
}

// releaseStoreLocked frees a store's memory and deletes its spill file.
func (l *SessionLog) releaseStoreLocked(store *historyStore) {
	if store == nil {
		return
	}
	l.historyMemory -= len(store.mem)
	l.historyDiskBytes -= store.size
	store.mem = nil
	store.size, store.disk = 0, 0
	if store.file != nil {
		_ = store.file.Close()
		if err := os.Remove(store.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Debug("remoteaccess: remove history spill file", "path", store.path, "error", err)
		}
		store.file, store.path = nil, ""
	}
}

// historyDirLocked returns this instance's spill directory, creating and
// locking it on first use.
func (l *SessionLog) historyDirLocked() (string, error) {
	if l.historyDir != "" {
		return l.historyDir, nil
	}
	root := l.historyRoot
	if root == "" {
		root = filepath.Join(os.TempDir(), "camber-session-history")
	}
	dir := filepath.Join(root, l.epoch)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("remoteaccess: create history spill dir: %w", err)
	}
	unlock, err := lockHistoryDir(dir)
	if err != nil {
		return "", err
	}
	l.historyDir, l.historyDirUnlock = dir, unlock
	return dir, nil
}

func (l *SessionLog) closeHistoryDirLocked() {
	if l.historyDir == "" {
		return
	}
	if err := os.RemoveAll(l.historyDir); err != nil {
		slog.Debug("remoteaccess: remove history spill dir", "dir", l.historyDir, "error", err)
	}
	if l.historyDirUnlock != nil {
		l.historyDirUnlock()
	}
	l.historyDir, l.historyDirUnlock = "", nil
}

// removeStaleHistoryDirs deletes spill directories under root whose owning
// helper instance has exited (see staleHistoryDir).
func removeStaleHistoryDirs(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if staleHistoryDir(dir) {
			if err := os.RemoveAll(dir); err != nil {
				slog.Debug("remoteaccess: remove stale history spill dir", "dir", dir, "error", err)
			}
		}
	}
}
