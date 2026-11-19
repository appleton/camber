//go:build unix

package remoteaccess

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const historyDirLockName = ".lock"

// lockHistoryDir holds an exclusive flock on dir's lock file for the rest of
// the process's life (or until the returned unlock), which is how other
// helper instances tell a live spill directory from an abandoned one.
func lockHistoryDir(dir string) (func(), error) {
	for range 3 {
		path := filepath.Join(dir, historyDirLockName)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return nil, fmt.Errorf("remoteaccess: open history spill lock: %w", err)
		}
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			_ = file.Close()
			return nil, fmt.Errorf("remoteaccess: lock history spill dir: %w", err)
		}
		// Another instance's stale-directory sweep may have removed the
		// directory between its creation and our lock; start over if so.
		held, statErr := file.Stat()
		onDisk, pathErr := os.Stat(path)
		if statErr == nil && pathErr == nil && os.SameFile(held, onDisk) {
			return func() { _ = file.Close() }, nil
		}
		_ = file.Close()
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("remoteaccess: create history spill dir: %w", err)
		}
	}
	return nil, errors.New("remoteaccess: history spill dir keeps disappearing")
}

// staleHistoryDir reports whether no running helper instance holds dir's
// lock. A directory without a lock file is only stale once it is old enough
// that its creator cannot still be about to lock it.
func staleHistoryDir(dir string) bool {
	file, err := os.OpenFile(filepath.Join(dir, historyDirLockName), os.O_RDWR, 0)
	if err != nil {
		info, statErr := os.Stat(dir)
		return errors.Is(err, os.ErrNotExist) && statErr == nil && time.Since(info.ModTime()) > time.Minute
	}
	defer file.Close()
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}
