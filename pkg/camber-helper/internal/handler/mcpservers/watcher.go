package mcpservers

import (
	"os"
	"time"
)

const storePollInterval = 2 * time.Second

// storeStamp fingerprints the connectors file for external-change detection.
type storeStamp struct {
	modTime time.Time
	size    int64
	exists  bool
}

// WatchStoreForExternalChanges polls the connectors file and invokes the
// change notifier when another process writes it — a second helper instance
// (e.g. a dev build running beside the installed app) shares
// ~/.config/camber/connectors.json, and without this its edits never reach
// this instance's live sessions. In-process mutations refresh the fingerprint
// before notifying (see changed), so the poller stays quiet for our own
// writes. Returns a stop function for the handler's cleanup list.
func (s *Server) WatchStoreForExternalChanges() func() error {
	return s.watchStore(storePollInterval)
}

func (s *Server) watchStore(interval time.Duration) func() error {
	s.rememberStamp()
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if s.updateStamp() && s.notifyChanged != nil {
					s.notifyChanged()
				}
			}
		}
	}()
	return func() error {
		close(done)
		return nil
	}
}

func (s *Server) currentStamp() storeStamp {
	info, err := os.Stat(s.store.Path())
	if err != nil {
		return storeStamp{}
	}
	return storeStamp{modTime: info.ModTime(), size: info.Size(), exists: true}
}

// rememberStamp records the file's current fingerprint as seen.
func (s *Server) rememberStamp() {
	stamp := s.currentStamp()
	s.stampMu.Lock()
	s.stamp = stamp
	s.stampMu.Unlock()
}

// updateStamp records the current fingerprint and reports whether it moved.
func (s *Server) updateStamp() bool {
	stamp := s.currentStamp()
	s.stampMu.Lock()
	defer s.stampMu.Unlock()
	if stamp == s.stamp {
		return false
	}
	s.stamp = stamp
	return true
}
