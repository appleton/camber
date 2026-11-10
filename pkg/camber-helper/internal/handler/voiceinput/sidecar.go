package voiceinput

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// managedWhisperServer supervises one whisper-server (whisper.cpp) child
// process bound to the loopback interface with the selected model loaded.
type managedWhisperServer struct {
	cmd       *exec.Cmd
	baseURL   string
	modelPath string
	done      chan error
}

func (p *managedWhisperServer) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// ensureSidecar returns a running whisper-server for modelPath, reusing the
// current one when it already serves that model.
func (s *Server) ensureSidecar(ctx context.Context, modelPath string) (*managedWhisperServer, error) {
	binary, ok := whisperServerPath()
	if !ok {
		return nil, errors.New(whisperServerMissingReason)
	}

	s.mu.Lock()
	if s.sidecar != nil && s.sidecar.running() && s.sidecar.modelPath == modelPath {
		sidecar := s.sidecar
		s.mu.Unlock()
		return sidecar, nil
	}
	// Detach the old server under the lock but shut it down after releasing
	// it: the graceful wait must not stall other lock holders. The
	// replacement uses a freshly reserved port, so the two cannot collide.
	previous := s.detachSidecarLocked()
	shutdownPrevious := func() {
		if err := shutdownSidecar(previous); err != nil {
			slog.Warn("voice input: whisper-server cleanup failed", "err", err)
		}
	}

	port, err := reserveLocalPort()
	if err != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, err
	}
	baseURL := fmt.Sprintf("http://%s:%d", sidecarHost, port)
	cmd := exec.Command(binary,
		"-m", modelPath,
		"--host", sidecarHost,
		"--port", strconv.Itoa(port),
		"--inference-path", inferencePath,
	)
	cmd.Dir = filepath.Dir(modelPath)
	stdout, stdoutErr := cmd.StdoutPipe()
	stderr, stderrErr := cmd.StderrPipe()
	if stdoutErr != nil || stderrErr != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, fmt.Errorf("voice input: preparing whisper-server stdio: %w", errors.Join(stdoutErr, stderrErr))
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, fmt.Errorf("voice input: starting %s: %w", binary, err)
	}

	sidecar := &managedWhisperServer{
		cmd:       cmd,
		baseURL:   baseURL,
		modelPath: modelPath,
		done:      make(chan error, 1),
	}
	s.sidecar = sidecar
	go drainSidecarOutput("stdout", stdout)
	go drainSidecarOutput("stderr", stderr)
	go s.waitSidecar(sidecar)
	s.mu.Unlock()
	shutdownPrevious()

	if err := waitForSidecarReady(ctx, baseURL); err != nil {
		s.stopSidecar(sidecar)
		return nil, err
	}
	return sidecar, nil
}

func (s *Server) stopSidecar(sidecar *managedWhisperServer) {
	s.mu.Lock()
	if s.sidecar != sidecar {
		s.mu.Unlock()
		return
	}
	detached := s.detachSidecarLocked()
	s.mu.Unlock()
	if err := shutdownSidecar(detached); err != nil {
		slog.Warn("voice input: whisper-server cleanup failed", "err", err)
	}
}

// detachSidecarLocked clears s.sidecar and returns the previous value. Callers
// must hold s.mu and pass the result to shutdownSidecar after releasing it.
func (s *Server) detachSidecarLocked() *managedWhisperServer {
	sidecar := s.sidecar
	s.sidecar = nil
	return sidecar
}

// shutdownSidecar interrupts the whisper-server, waits up to
// sidecarGracefulShutdownTimeout, and kills it otherwise. It blocks, so it
// must be called without holding s.mu.
func shutdownSidecar(sidecar *managedWhisperServer) error {
	if sidecar == nil || !sidecar.running() {
		return nil
	}
	if sidecar.cmd == nil || sidecar.cmd.Process == nil {
		return nil
	}
	if err := sidecar.cmd.Process.Signal(os.Interrupt); err == nil {
		timer := time.NewTimer(sidecarGracefulShutdownTimeout)
		defer timer.Stop()
		select {
		case <-sidecar.done:
			return nil
		case <-timer.C:
		}
	}
	if err := sidecar.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("voice input: stopping whisper-server: %w", err)
	}
	return nil
}

func (s *Server) waitSidecar(sidecar *managedWhisperServer) {
	err := sidecar.cmd.Wait()
	sidecar.done <- err
	close(sidecar.done)

	wasCurrent := false
	s.mu.Lock()
	if s.sidecar == sidecar {
		s.sidecar = nil
		wasCurrent = true
	}
	s.mu.Unlock()

	if reportErr := unexpectedSidecarExitError(wasCurrent, err); reportErr != nil {
		slog.Warn("voice input: whisper-server exited", "err", reportErr)
	}
}

func unexpectedSidecarExitError(wasCurrent bool, err error) error {
	if !wasCurrent {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("voice input: whisper-server exited unexpectedly with status 0")
}

func drainSidecarOutput(stream string, r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		slog.Debug("voice input: whisper-server", "stream", stream, "line", scanner.Text())
	}
}

func waitForSidecarReady(ctx context.Context, baseURL string) error {
	ctx, cancel := context.WithTimeout(ctx, sidecarReadyTimeout)
	defer cancel()

	ticker := time.NewTicker(sidecarReadyInterval)
	defer ticker.Stop()

	var lastErr error
	for {
		if err := probeSidecar(ctx, baseURL); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("voice input: whisper-server did not become ready: %w", lastErr)
		case <-ticker.C:
		}
	}
}

// probeSidecar treats any HTTP response as readiness: whisper-server only
// starts accepting connections once the model is loaded.
func probeSidecar(ctx context.Context, baseURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/", nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("readiness returned status %d", resp.StatusCode)
	}
	return nil
}

// whisperServerPath resolves the whisper.cpp server binary: the
// CAMBER_WHISPER_SERVER env var, siblings of the helper executable, then
// PATH (e.g. `brew install whisper-cpp`).
func whisperServerPath() (string, bool) {
	if path := strings.TrimSpace(os.Getenv(whisperServerPathEnv)); path != "" {
		if executableFileExists(path) {
			return path, true
		}
	}
	if exe, err := os.Executable(); err == nil {
		if path, ok := whisperServerInDir(filepath.Dir(exe)); ok {
			return path, true
		}
	}
	// Development runs the helper with `go run` from a source checkout, so the
	// executable has no bundled siblings; the desktop app's downloaded
	// binaries live under the checkout instead.
	if cwd, err := os.Getwd(); err == nil {
		for dir := cwd; ; dir = filepath.Dir(dir) {
			binaries := filepath.Join(dir, "ui", "apps", "desktop-assistant", "src-tauri", "binaries")
			if path, ok := whisperServerInDir(binaries); ok {
				return path, true
			}
			if dir == filepath.Dir(dir) {
				break
			}
		}
	}
	if path, err := exec.LookPath("whisper-server"); err == nil && executableFileExists(path) {
		return path, true
	}
	return "", false
}

// whisperServerInDir finds a bundled whisper-server in dir. The desktop app
// bundles it as a plain camber-whisper-server sibling; IDE dists keep
// target-suffixed names (e.g. camber-whisper-server-darwin-arm64), so the
// current target's suffix is preferred before any remaining match.
func whisperServerInDir(dir string) (string, bool) {
	names := []string{"camber-whisper-server", "whisper-server"}
	if triple := currentHelperTargetSuffix(); triple != "" {
		names = append(names, "camber-whisper-server-"+triple)
	}
	candidates := make([]string, 0, len(names))
	for _, name := range names {
		candidates = append(candidates, filepath.Join(dir, name+executableExtension()))
	}
	if matches, err := filepath.Glob(filepath.Join(dir, "camber-whisper-server-*")); err == nil {
		for _, match := range matches {
			if isExecutableName(filepath.Base(match)) {
				candidates = append(candidates, match)
			}
		}
	}
	for _, candidate := range candidates {
		if executableFileExists(candidate) {
			return candidate, true
		}
	}
	return "", false
}

func executableExtension() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// isExecutableName rejects the metadata siblings the glob can match (e.g. the
// *.version files copy-helper.mjs writes next to desktop dev binaries). Our
// binary names never contain a dot except for the Windows .exe suffix.
func isExecutableName(name string) bool {
	if runtime.GOOS == "windows" {
		return strings.HasSuffix(name, ".exe")
	}
	return !strings.Contains(name, ".")
}

// currentHelperTargetSuffix matches the <platform>-<arch> suffix used by the
// helper release archives (e.g. darwin-arm64), which IDE dists preserve.
func currentHelperTargetSuffix() string {
	arch := runtime.GOARCH
	switch runtime.GOOS {
	case "darwin", "linux", "windows":
		return runtime.GOOS + "-" + arch
	default:
		return ""
	}
}

func executableFileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return false
	}
	// Belt and braces next to isExecutableName: anything without the
	// executable bit cannot be spawned anyway. Windows has no such bit and
	// relies on the name filter alone.
	if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		return false
	}
	return true
}

func reserveLocalPort() (int, error) {
	ln, err := net.Listen("tcp", sidecarHost+":0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("unexpected listener address %T", ln.Addr())
	}
	return addr.Port, nil
}
