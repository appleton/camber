package localinference

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func existingFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return -1
	}
	return info.Size()
}

func normalizeRemoteFilePath(path string) (string, bool) {
	if path == "" || strings.Contains(path, "\\") || strings.Contains(path, "\x00") || filepath.IsAbs(path) {
		return "", false
	}
	parts := strings.Split(path, "/")
	normalized := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
		normalized = append(normalized, part)
	}
	return strings.Join(normalized, "/"), true
}

func destinationPath(modelDir, remotePath string) (string, error) {
	safePath, ok := normalizeRemoteFilePath(remotePath)
	if !ok {
		return "", fmt.Errorf("unsafe Hugging Face path %q", remotePath)
	}
	parts := strings.Split(safePath, "/")
	destination := filepath.Join(append([]string{modelDir}, parts...)...)
	if !pathContained(destination, modelDir) {
		return "", fmt.Errorf("unsafe Hugging Face path %q", remotePath)
	}
	parent := filepath.Dir(destination)
	if err := existingParentChainIsSafe(modelDir, parent); err != nil {
		return "", err
	}
	return destination, nil
}

func existingParentChainIsSafe(base, parent string) error {
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return err
	}
	parentAbs, err := filepath.Abs(parent)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(baseAbs, parentAbs)
	if err != nil {
		return err
	}
	current := baseAbs
	if rel == "." {
		return nil
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to download through symlinked directory %s", current)
		}
		if !info.IsDir() {
			return fmt.Errorf("refusing to download through non-directory %s", current)
		}
	}
	return nil
}

func pathContained(path, base string) bool {
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(baseAbs, pathAbs)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func directorySize(path string) int64 {
	var size int64
	_ = filepath.WalkDir(path, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err == nil {
			size += info.Size()
		}
		return nil
	})
	return size
}

type directorySizeEntry struct {
	size      int64
	expiresAt time.Time
}

// cachedDirectorySize bounds the cost of InstalledBytes on state builds:
// directorySize walks the whole model directory, and state is rebuilt on
// every download-progress tick. Completed downloads and deletions call
// invalidateDirectorySizes so the TTL only masks mid-download churn.
func (s *Server) cachedDirectorySize(path string) int64 {
	now := time.Now()
	s.dirSizeMu.Lock()
	if entry, ok := s.dirSizeCache[path]; ok && now.Before(entry.expiresAt) {
		s.dirSizeMu.Unlock()
		return entry.size
	}
	s.dirSizeMu.Unlock()

	size := directorySize(path)

	s.dirSizeMu.Lock()
	if s.dirSizeCache == nil {
		s.dirSizeCache = make(map[string]directorySizeEntry)
	}
	s.dirSizeCache[path] = directorySizeEntry{size: size, expiresAt: now.Add(directorySizeCacheTTL)}
	s.dirSizeMu.Unlock()
	return size
}

func (s *Server) invalidateDirectorySizes() {
	s.dirSizeMu.Lock()
	s.dirSizeCache = nil
	s.dirSizeMu.Unlock()
}
