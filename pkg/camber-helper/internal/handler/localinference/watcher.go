package localinference

import (
	"maps"
	"os"
	"path/filepath"
	"time"
)

const modelsDirPollInterval = 2 * time.Second

// WatchModelsDirectory polls the models directory and pushes a state change
// when its directory tree moves — a model placed there outside the app
// download flow appears in every client without waiting for a state read.
// Polling a directory-level fingerprint (~20 stats a tick, no file reads)
// keeps this dependency-free; fsnotify would need one watch per owner
// directory on macOS and re-registration as they come and go. Returns a stop
// function for the handler's cleanup list.
func (s *Server) WatchModelsDirectory() func() error {
	return s.watchModelsDirectory(modelsDirPollInterval)
}

func (s *Server) watchModelsDirectory(interval time.Duration) func() error {
	stamp := currentModelsDirStamp(s.modelsDirectory(configFile{}))
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				next := currentModelsDirStamp(s.modelsDirectory(configFile{}))
				changed := !maps.Equal(next, stamp)
				stamp = next
				if !changed {
					continue
				}
				// The app's own downloads churn the tree constantly and their
				// handlers already push the resulting state every progress
				// tick; notifying here too would pile redundant rebuilds on a
				// path that must stay cheap. Absorb the movement silently —
				// the completion push rescans, so a model added by hand
				// mid-download is picked up there.
				if s.anyDownloadRunning() {
					continue
				}
				// Before a client connects there is no one to tell, and its
				// initial state read is fresh anyway; skipping also keeps the
				// no-notifier warning out of the logs.
				if s.clientNotifier() == nil {
					continue
				}
				s.notifyStateBestEffort()
			}
		}
	}()
	return func() error {
		close(done)
		return nil
	}
}

func (s *Server) anyDownloadRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, job := range s.downloadJobs {
		if job != nil && job.running() {
			return true
		}
	}
	return false
}

type dirStamp struct {
	modTime time.Time
	size    int64
}

// currentModelsDirStamp fingerprints the models tree at directory
// granularity: creating, removing, or renaming an entry moves its parent
// directory's mtime (and the entry set itself is part of the fingerprint),
// while writes into existing files do not — so models appearing or vanishing
// are noticed without reading any model files. Stat rather than
// DirEntry.IsDir so symlinked model directories count too.
func currentModelsDirStamp(modelsDir string) map[string]dirStamp {
	stamp := make(map[string]dirStamp)
	if modelsDir == "" {
		return stamp
	}
	addDir := func(path string) bool {
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			return false
		}
		stamp[path] = dirStamp{modTime: info.ModTime(), size: info.Size()}
		return true
	}
	if !addDir(modelsDir) {
		return stamp
	}
	owners, err := os.ReadDir(modelsDir)
	if err != nil {
		return stamp
	}
	for _, owner := range owners {
		ownerPath := filepath.Join(modelsDir, owner.Name())
		if !addDir(ownerPath) {
			continue
		}
		models, err := os.ReadDir(ownerPath)
		if err != nil {
			continue
		}
		for _, model := range models {
			addDir(filepath.Join(ownerPath, model.Name()))
		}
	}
	return stamp
}
