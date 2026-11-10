package localinference

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"sync"
	"sync/atomic"
	"time"
)

type managedSidecar struct {
	cmd *exec.Cmd
	// stdin is closed exactly once via closeStdin; both the reaper and the
	// shutdown path race to be first.
	stdin           io.WriteCloser
	stdinClose      sync.Once
	stdinCloseErr   error
	baseURL         string
	apiKey          string
	port            int
	modelsDirectory string
	done            chan error
	// expectedExit is set before the helper shuts the sidecar down itself, so
	// waitSidecar can tell a requested exit from a crash or an external kill
	// (which get a respawn).
	expectedExit atomic.Bool
	// residency is the last-observed model residency from /health, kept
	// fresh by pollSidecarResidency. Guarded by Server.mu.
	residency *sidecarResidency
}

type sidecarExecutable struct {
	path           string
	workingDir     string
	prepareRuntime bool
}

// closeStdin closes the sidecar's stdin control pipe exactly once, telling
// the sidecar to exit (CAMBER_MLX_EXIT_ON_STDIN_CLOSE).
func (p *managedSidecar) closeStdin() error {
	p.stdinClose.Do(func() {
		if p.stdin != nil {
			p.stdinCloseErr = p.stdin.Close()
		}
	})
	return p.stdinCloseErr
}

func (p *managedSidecar) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (s *Server) ensureSidecar(ctx context.Context, cfg configFile) (*managedSidecar, error) {
	if !localRuntimeSupported() {
		return nil, errors.New("local MLX inference requires an Apple Silicon Mac")
	}
	modelsDir := s.modelsDirectory(cfg)
	if modelsDir == "" {
		return nil, errors.New("local inference models directory is not available")
	}
	sidecarExec, sidecarWorkingDir, err := resolveSidecarRuntime(ctx)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	if s.sidecar != nil && s.sidecar.running() && s.sidecar.modelsDirectory == modelsDir {
		sidecar := s.sidecar
		s.mu.Unlock()
		return sidecar, nil
	}
	// Detach the old sidecar under the lock, but shut it down only after the
	// lock is released: the graceful wait can take up to
	// sidecarGracefulShutdownTimeout and must not stall other lock holders.
	// The replacement uses a freshly reserved port, so the detached process
	// cannot collide with it.
	previous := s.detachSidecarLocked()
	shutdownPrevious := func() {
		if err := shutdownSidecar(previous); err != nil {
			slog.Warn("local MLX sidecar cleanup failed", "err", err)
		}
	}

	port, err := reserveLocalPort()
	if err != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, err
	}
	apiKey, err := randomAPIKey()
	if err != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, err
	}
	sidecar, err := s.launchSidecar(sidecarExec, sidecarWorkingDir, modelsDir, s.defaultModelID(cfg), port, apiKey)
	if err != nil {
		s.mu.Unlock()
		shutdownPrevious()
		return nil, err
	}
	s.sidecar = sidecar
	s.mu.Unlock()
	shutdownPrevious()

	if err := waitForSidecarReady(ctx, sidecar.baseURL, apiKey); err != nil {
		s.stopSidecar(sidecar)
		return nil, err
	}
	go s.pollSidecarResidency(sidecar)
	return sidecar, nil
}

// resolveSidecarRuntime locates the sidecar executable and the working
// directory holding its Metal libraries.
func resolveSidecarRuntime(ctx context.Context) (sidecarExecutable, string, error) {
	sidecarExec, ok := sidecarExecutablePath()
	if !ok {
		return sidecarExecutable{}, "", fmt.Errorf("local MLX sidecar is not installed; %s", sidecarInstallHint())
	}
	sidecarWorkingDir := sidecarExec.workingDir
	if sidecarExec.prepareRuntime {
		var err error
		sidecarWorkingDir, err = prepareSidecarRuntime(ctx, sidecarExec.path)
		if err != nil {
			return sidecarExecutable{}, "", err
		}
	}
	if sidecarWorkingDir == "" {
		sidecarWorkingDir = filepath.Dir(sidecarExec.path)
	}
	return sidecarExec, sidecarWorkingDir, nil
}

// launchSidecar starts a sidecar process on the given port and returns its
// handle with the drain and reaper goroutines running. The caller installs it
// as s.sidecar and waits for readiness.
func (s *Server) launchSidecar(sidecarExec sidecarExecutable, workingDir, modelsDir, defaultModel string, port int, apiKey string) (*managedSidecar, error) {
	baseURL := fmt.Sprintf("http://%s:%d", sidecarHost, port)
	args := []string{
		"--host", sidecarHost,
		"--port", strconv.Itoa(port),
		"--models-dir", modelsDir,
		"--default-model", defaultModel,
		"--api-key", apiKey,
	}
	cmd := exec.Command(sidecarExec.path, args...)
	cmd.Dir = workingDir
	cmd.Env = append(os.Environ(),
		modelsDirEnv+"="+modelsDir,
		modelEnv+"="+defaultModel,
		sidecarExitOnStdinCloseEnv+"=1",
	)
	stdin, stdinErr := cmd.StdinPipe()
	stdout, stdoutErr := cmd.StdoutPipe()
	stderr, stderrErr := cmd.StderrPipe()
	if stdinErr != nil || stdoutErr != nil || stderrErr != nil {
		if stdin != nil {
			_ = stdin.Close()
		}
		return nil, fmt.Errorf("local MLX sidecar: preparing stdio: %w", errors.Join(stdinErr, stdoutErr, stderrErr))
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("local MLX sidecar: starting %s: %w", sidecarExec.path, err)
	}

	sidecar := &managedSidecar{
		cmd:             cmd,
		stdin:           stdin,
		baseURL:         baseURL,
		apiKey:          apiKey,
		port:            port,
		modelsDirectory: modelsDir,
		done:            make(chan error, 1),
	}
	go drainSidecarOutput("stdout", stdout)
	go drainSidecarOutput("stderr", stderr)
	go s.waitSidecar(sidecar)
	return sidecar, nil
}

func (s *Server) stopSidecar(sidecar *managedSidecar) {
	s.mu.Lock()
	if s.sidecar != sidecar {
		s.mu.Unlock()
		return
	}
	detached := s.detachSidecarLocked()
	s.mu.Unlock()
	if err := shutdownSidecar(detached); err != nil {
		slog.Warn("local MLX sidecar cleanup failed", "err", err)
	}
}

// detachSidecarLocked clears s.sidecar and returns the previous sidecar (or
// nil). Callers must hold s.mu; the returned sidecar must be passed to
// shutdownSidecar after releasing the lock.
func (s *Server) detachSidecarLocked() *managedSidecar {
	sidecar := s.sidecar
	s.sidecar = nil
	return sidecar
}

// shutdownSidecar closes the sidecar's stdin control pipe, waits up to
// sidecarGracefulShutdownTimeout for it to exit, and kills it otherwise. It
// blocks, so it must be called without holding s.mu; detach the sidecar with
// detachSidecarLocked first.
func shutdownSidecar(sidecar *managedSidecar) error {
	if sidecar == nil {
		return nil
	}
	sidecar.expectedExit.Store(true)
	if !sidecar.running() {
		return nil
	}
	closeErr := sidecar.closeStdin()
	if !sidecar.running() {
		return closeErr
	}
	if sidecar.cmd == nil || sidecar.cmd.Process == nil {
		return closeErr
	}
	if closeErr == nil {
		timer := time.NewTimer(sidecarGracefulShutdownTimeout)
		defer timer.Stop()
		select {
		case <-sidecar.done:
			return nil
		case <-timer.C:
		}
	}
	if err := sidecar.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("local MLX sidecar: stopping: %w", err)
	}
	return closeErr
}

func (s *Server) waitSidecar(sidecar *managedSidecar) {
	err := sidecar.cmd.Wait()
	_ = sidecar.closeStdin()
	sidecar.done <- err
	close(sidecar.done)

	wasCurrent := false
	s.mu.Lock()
	if s.sidecar == sidecar {
		s.sidecar = nil
		wasCurrent = true
	}
	s.mu.Unlock()

	if !wasCurrent {
		return
	}
	if reportErr := unexpectedSidecarExitError(sidecar.expectedExit.Load(), err); reportErr != nil {
		slog.Warn("local MLX sidecar exited", "err", reportErr)
	}
	// A crash or an external kill (e.g. the user reaping a 20GB process in
	// Activity Monitor) leaves the running ACP agent pointing at a dead port:
	// its base URL and API key were baked in at agent start. Respawn on the
	// same port with the same key so the agent keeps working without a
	// restart; only if that fails does the stopped notification go out and
	// the client-side restart machinery take over.
	if !sidecar.expectedExit.Load() && s.respawnSidecar(sidecar) {
		return
	}
	s.notifyStateBestEffort()
}

func unexpectedSidecarExitError(expected bool, err error) error {
	if expected {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("local MLX sidecar exited unexpectedly with status 0")
}

// respawnSidecar relaunches an unexpectedly dead sidecar on its previous port
// and API key, reporting whether the replacement became ready. Crash loops
// are cut off by allowRespawn.
func (s *Server) respawnSidecar(old *managedSidecar) bool {
	if !s.allowRespawn(time.Now()) {
		slog.Warn("local MLX sidecar exited unexpectedly too often; not respawning", "port", old.port)
		return false
	}
	slog.Warn("local MLX sidecar exited unexpectedly; respawning", "port", old.port)

	ctx, cancel := context.WithTimeout(context.Background(), sidecarRespawnReadyTimeout)
	defer cancel()
	cfg, err := s.loadConfig()
	if err != nil {
		slog.Warn("local MLX sidecar respawn failed", "err", err)
		return false
	}
	sidecarExec, workingDir, err := resolveSidecarRuntime(ctx)
	if err != nil {
		slog.Warn("local MLX sidecar respawn failed", "err", err)
		return false
	}
	sidecar, err := s.launchSidecar(sidecarExec, workingDir, old.modelsDirectory, s.defaultModelID(cfg), old.port, old.apiKey)
	if err != nil {
		slog.Warn("local MLX sidecar respawn failed", "err", err)
		return false
	}

	s.mu.Lock()
	if s.sidecar != nil {
		// Something else (e.g. an agent restart) already brought up a
		// replacement; ours is redundant.
		s.mu.Unlock()
		if err := shutdownSidecar(sidecar); err != nil {
			slog.Warn("local MLX sidecar cleanup failed", "err", err)
		}
		return true
	}
	s.sidecar = sidecar
	s.mu.Unlock()

	if err := waitForSidecarReady(ctx, sidecar.baseURL, sidecar.apiKey); err != nil {
		// The old port may have been claimed in the meantime; give up and let
		// the stopped notification drive a full agent restart with fresh env.
		slog.Warn("local MLX sidecar respawn did not become ready", "err", err)
		s.stopSidecar(sidecar)
		return false
	}
	go s.pollSidecarResidency(sidecar)
	slog.Info("local MLX sidecar respawned", "port", old.port)
	s.notifyStateBestEffort()
	return true
}

// allowRespawn rate-limits automatic sidecar respawns: at most
// sidecarRespawnLimit within sidecarRespawnWindow, so a sidecar that dies on
// arrival (e.g. its port was reclaimed) cannot crash-loop.
func (s *Server) allowRespawn(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	recent := s.respawnHistory[:0]
	for _, at := range s.respawnHistory {
		if now.Sub(at) < sidecarRespawnWindow {
			recent = append(recent, at)
		}
	}
	s.respawnHistory = recent
	if len(recent) >= sidecarRespawnLimit {
		return false
	}
	s.respawnHistory = append(recent, now)
	return true
}

// drainSidecarOutput forwards sidecar output to the debug log. It must keep
// consuming until EOF no matter what the sidecar prints: if the drain stops,
// the pipe buffer fills and the sidecar blocks forever inside a stdout write
// (MLXPress emits >64KB single-line diagnostics while loading some models,
// which exceeded the previous bufio.Scanner's max token size, silently ended
// the drain, and wedged model loading mid-print).
func drainSidecarOutput(stream string, r io.Reader) {
	reader := bufio.NewReaderSize(r, sidecarOutputLineLimit)
	continuation := false
	for {
		line, isPrefix, err := reader.ReadLine()
		if err != nil {
			return
		}
		// Log only the first fragment of an over-long line; discard the rest.
		if !continuation {
			slog.Debug("local MLX sidecar", "stream", stream, "line", string(line), "truncated", isPrefix)
		}
		continuation = isPrefix
	}
}

func waitForSidecarReady(ctx context.Context, baseURL, apiKey string) error {
	ctx, cancel := context.WithTimeout(ctx, sidecarReadyTimeout)
	defer cancel()

	ticker := time.NewTicker(sidecarReadyInterval)
	defer ticker.Stop()

	var lastErr error
	for {
		if err := probeSidecar(ctx, baseURL, apiKey); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("local MLX sidecar did not become ready: %w", lastErr)
		case <-ticker.C:
		}
	}
}

func probeSidecar(ctx context.Context, baseURL, apiKey string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("readiness returned status %d", resp.StatusCode)
	}
	return nil
}

func prepareSidecarRuntime(ctx context.Context, binary string) (string, error) {
	binaryDir := filepath.Dir(binary)
	if sidecarMetallibsReady(binaryDir) {
		return binaryDir, nil
	}

	var prepareErr error
	if err := prepareSwiftPMMetallibs(ctx, binary); err != nil {
		prepareErr = err
		slog.Warn("local MLX sidecar Metal library preparation failed", "binary", binary, "error", err)
	}
	if sidecarMetallibsReady(binaryDir) {
		return binaryDir, nil
	}
	if dir := firstSidecarMetallibDir(sidecarMetallibCandidateDirs(binary)); dir != "" {
		return dir, nil
	}

	err := fmt.Errorf("local MLX sidecar Metal library is missing; expected %s next to %s; install Xcode's Metal Toolchain with xcodebuild -downloadComponent MetalToolchain or set MLXPRESS_MLX_METALLIB to a readable metallib", sidecarMetallibDefault, binary)
	if prepareErr != nil {
		return "", fmt.Errorf("%w; preparing it failed: %v", err, prepareErr)
	}
	return "", err
}

func prepareSwiftPMMetallibs(ctx context.Context, binary string) error {
	packageDir, buildTriple, buildConfiguration, ok := swiftBuildProductInfo(binary)
	if !ok {
		return nil
	}
	script := filepath.Join(packageDir, ".build", "checkouts", "vmlx-swift", "scripts", "prepare-mlx-metal.sh")
	if !fileExists(script) {
		return fmt.Errorf("missing %s", script)
	}

	output := filepath.Join(filepath.Dir(binary), sidecarMetallibPrimary)
	cmd := exec.CommandContext(ctx, script, output)
	cmd.Dir = packageDir
	cmd.Env = os.Environ()
	if buildConfiguration != "" {
		cmd.Env = append(cmd.Env, "MLXPRESS_BUILD_CONFIGURATION="+buildConfiguration)
	}
	if buildTriple != "" {
		cmd.Env = append(cmd.Env, "MLXPRESS_BUILD_TRIPLE="+buildTriple)
	}
	outputBytes, err := cmd.CombinedOutput()
	if err != nil {
		output := strings.TrimSpace(string(outputBytes))
		if output != "" {
			return fmt.Errorf("%w: %s", err, output)
		}
		return err
	}
	return nil
}

func swiftBuildProductInfo(binary string) (packageDir, buildTriple, buildConfiguration string, ok bool) {
	dir := filepath.Dir(binary)
	for {
		base := filepath.Base(dir)
		if base == "debug" || base == "release" {
			buildConfiguration = base
			parent := filepath.Dir(dir)
			if filepath.Base(parent) != ".build" {
				buildTriple = filepath.Base(parent)
			}
		}
		if base == ".build" {
			return filepath.Dir(dir), buildTriple, buildConfiguration, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", "", "", false
		}
		dir = parent
	}
}

func sidecarMetallibCandidateDirs(binary string) []string {
	binaryDir := filepath.Dir(binary)
	parentDir := filepath.Dir(binaryDir)
	candidates := []string{
		binaryDir,
		filepath.Join(binaryDir, "Resources"),
		filepath.Join(binaryDir, "binaries"),
		filepath.Join(parentDir, "Resources"),
		filepath.Join(parentDir, "binaries"),
	}
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		candidates = append(candidates, cwd)
	}
	return dedupeStrings(candidates)
}

func firstSidecarMetallibDir(candidates []string) string {
	for _, candidate := range candidates {
		if sidecarMetallibsReady(candidate) {
			return candidate
		}
	}
	return ""
}

// Only default.metallib gates readiness: it is the name compiled into the
// sidecar's Metal loader (METAL_PATH), and the app bundle ships just that
// file. mlx.metallib is a duplicate that dev builds still produce next to it
// (prepare-mlx-metal.sh emits both) but the sidecar never reads.
func sidecarMetallibsReady(dir string) bool {
	return fileExists(filepath.Join(dir, sidecarMetallibDefault))
}

func sidecarExecutablePath() (sidecarExecutable, bool) {
	if path := strings.TrimSpace(os.Getenv(sidecarPathEnv)); path != "" {
		if executableFileExists(path) {
			return sidecarBinaryExecutable(path), true
		}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if path := firstExecutablePath(siblingSidecarCandidates(dir)); path != "" {
			return sidecarBinaryExecutable(path), true
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		if path := firstExecutablePath(developmentDesktopSidecarCandidates(cwd)); path != "" {
			return sidecarBinaryExecutable(path), true
		}
		if !sidecarDevBuildDisabled() {
			if path := firstExecutablePath(developmentSidecarLauncherCandidates(cwd)); path != "" {
				return sidecarExecutable{
					path:       path,
					workingDir: filepath.Dir(path),
				}, true
			}
			if path := firstExecutablePath(developmentSidecarCandidates(cwd)); path != "" {
				return sidecarBinaryExecutable(path), true
			}
		}
	}
	if path, err := exec.LookPath("camber-mlx-sidecar"); err == nil && executableFileExists(path) {
		return sidecarBinaryExecutable(path), true
	}
	return sidecarExecutable{}, false
}

func sidecarInstallHint() string {
	hint := fmt.Sprintf("set %s to the sidecar binary or run pnpm -F @camber/desktop-assistant download:binaries", sidecarPathEnv)
	if !sidecarDevBuildDisabled() {
		hint += ", or run from a source checkout"
	}
	return hint
}

func sidecarDevBuildDisabled() bool {
	value := strings.TrimSpace(os.Getenv(sidecarDisableDevBuildEnv))
	return value != "" && value != "0" && !strings.EqualFold(value, "false")
}

func sidecarBinaryExecutable(path string) sidecarExecutable {
	return sidecarExecutable{path: path, prepareRuntime: true}
}

func siblingSidecarCandidates(dir string) []string {
	candidates := []string{filepath.Join(dir, "camber-mlx-sidecar")}
	if triple := currentTargetTriple(); triple != "" {
		candidates = append(candidates, filepath.Join(dir, "camber-mlx-sidecar-"+triple))
	}
	if matches, err := filepath.Glob(filepath.Join(dir, "camber-mlx-sidecar-*")); err == nil {
		candidates = append(candidates, matches...)
	}
	return candidates
}

func developmentDesktopSidecarCandidates(start string) []string {
	var candidates []string
	for _, dir := range ancestorDirs(start) {
		binaries := filepath.Join(dir, "ui", "apps", "desktop-assistant", "src-tauri", "binaries")
		candidates = append(candidates, siblingSidecarCandidates(binaries)...)
	}
	return dedupeStrings(candidates)
}

func developmentSidecarLauncherCandidates(start string) []string {
	var candidates []string
	for _, dir := range ancestorDirs(start) {
		if filepath.Base(dir) == "camber-mlx-sidecar" {
			candidates = append(candidates, filepath.Join(dir, sidecarDevRunScript))
		}
		candidates = append(candidates, filepath.Join(dir, "cmd", "camber-mlx-sidecar", sidecarDevRunScript))
	}
	return dedupeStrings(candidates)
}

func developmentSidecarCandidates(start string) []string {
	var candidates []string
	for _, dir := range ancestorDirs(start) {
		if filepath.Base(dir) == "camber-mlx-sidecar" {
			candidates = append(candidates, swiftBuildProductCandidates(dir)...)
		}
		candidates = append(candidates, swiftBuildProductCandidates(filepath.Join(dir, "cmd", "camber-mlx-sidecar"))...)
	}
	return dedupeStrings(candidates)
}

func swiftBuildProductCandidates(packageDir string) []string {
	buildDir := filepath.Join(packageDir, ".build")
	candidates := []string{
		filepath.Join(buildDir, "release", "camber-mlx-sidecar"),
		filepath.Join(buildDir, "debug", "camber-mlx-sidecar"),
	}
	for _, configuration := range []string{"release", "debug"} {
		if matches, err := filepath.Glob(filepath.Join(buildDir, "*", configuration, "camber-mlx-sidecar")); err == nil {
			candidates = append(candidates, matches...)
		}
	}
	return candidates
}

func ancestorDirs(start string) []string {
	if abs, err := filepath.Abs(start); err == nil {
		start = abs
	}
	var dirs []string
	for {
		dirs = append(dirs, start)
		parent := filepath.Dir(start)
		if parent == start {
			return dirs
		}
		start = parent
	}
}

func firstExecutablePath(candidates []string) string {
	for _, candidate := range candidates {
		if executableFileExists(candidate) {
			return candidate
		}
	}
	return ""
}

func executableFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	deduped := values[:0]
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		deduped = append(deduped, value)
	}
	return deduped
}

func currentTargetTriple() string {
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "aarch64-apple-darwin"
		}
		if runtime.GOARCH == "amd64" {
			return "x86_64-apple-darwin"
		}
	case "linux":
		if runtime.GOARCH == "arm64" {
			return "aarch64-unknown-linux-gnu"
		}
		if runtime.GOARCH == "amd64" {
			return "x86_64-unknown-linux-gnu"
		}
	case "windows":
		if runtime.GOARCH == "arm64" {
			return "aarch64-pc-windows-msvc"
		}
		if runtime.GOARCH == "amd64" {
			return "x86_64-pc-windows-msvc"
		}
	}
	return ""
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

func randomAPIKey() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "camber-local-" + hex.EncodeToString(b[:]), nil
}

func localRuntimeSupported() bool {
	return runtime.GOOS == "darwin" && runtime.GOARCH == "arm64"
}

func normalizeStandaloneBaseURL(raw string) string {
	baseURL := strings.TrimRight(strings.TrimSpace(raw), "/")
	if strings.HasSuffix(strings.ToLower(baseURL), "/v1") {
		baseURL = strings.TrimRight(baseURL[:len(baseURL)-3], "/")
	}
	return baseURL
}
