package localinference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/tliron/glsp"
)

const (
	residencyPollInterval = 5 * time.Second
	// residencyActivityTolerance absorbs the ±1s jitter of deriving the
	// last-activity timestamp from the sidecar's whole-second idle counter.
	residencyActivityTolerance = 2 * time.Second
	// residencyMemoryDelta is how much the reported footprint must move
	// before a change notification is pushed on its own.
	residencyMemoryDelta = int64(512 * 1024 * 1024)
)

// sidecarResidency is the last-observed model residency of a running sidecar,
// derived from its /health endpoint.
type sidecarResidency struct {
	loadedModelID     string
	memoryBytes       int64
	lastActivity      time.Time
	idleUnloadSeconds int
}

// sidecarHealth mirrors the sidecar's /health response body.
type sidecarHealth struct {
	LoadedModel            string `json:"loadedModel"`
	IdleSeconds            int    `json:"idleSeconds"`
	IdleUnloadAfterSeconds int    `json:"idleUnloadAfterSeconds"`
	MemoryBytes            int64  `json:"memoryBytes"`
}

// UnloadModel releases the model resident in the sidecar's memory without
// stopping the sidecar. A no-op (with current state returned) when no sidecar
// is running.
func (s *Server) UnloadModel(ctx context.Context, _ *methods.LocalInferenceUnloadModelParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	s.mu.Lock()
	sidecar := s.sidecar
	s.mu.Unlock()
	if sidecar == nil || !sidecar.running() {
		return s.notifyState(ctx, gCtx)
	}

	reqCtx, cancel := context.WithTimeout(ctx, s.sidecarProbeTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, sidecar.baseURL+"/admin/unload", nil)
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	if sidecar.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+sidecar.apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return methods.LocalInferenceState{}, fmt.Errorf("local MLX sidecar: unloading model: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return methods.LocalInferenceState{}, fmt.Errorf("local MLX sidecar: unloading model: HTTP %d", resp.StatusCode)
	}

	// Refresh the snapshot immediately so the returned state (and the
	// didChange it fans out) already reflects the unload rather than waiting
	// for the next poll tick.
	s.refreshResidency(ctx, sidecar)
	return s.notifyState(ctx, gCtx)
}

// pollSidecarResidency keeps the sidecar's model-residency snapshot fresh for
// the lifetime of one sidecar process, notifying clients when it changes
// meaningfully (model loaded/unloaded, new activity, or a large memory move).
// The sidecar owns residency transitions — prompts arrive from the ACP agent
// directly and idle/pressure unloads happen inside the sidecar — so polling
// is the only way the helper can observe them.
func (s *Server) pollSidecarResidency(sidecar *managedSidecar) {
	ticker := time.NewTicker(residencyPollInterval)
	defer ticker.Stop()
	for {
		if changed := s.refreshResidency(context.Background(), sidecar); changed {
			s.notifyStateBestEffort()
		}
		select {
		case <-sidecar.done:
			return
		case <-ticker.C:
		}
	}
}

// refreshResidency fetches /health and updates the sidecar's residency
// snapshot, reporting whether it changed enough to notify clients.
func (s *Server) refreshResidency(ctx context.Context, sidecar *managedSidecar) bool {
	health, err := s.fetchSidecarHealth(ctx, sidecar)
	if err != nil {
		// Leave the previous snapshot in place: transient probe failures
		// (e.g. a busy sidecar mid-load) should not flicker the UI.
		return false
	}
	next := &sidecarResidency{
		loadedModelID:     health.LoadedModel,
		memoryBytes:       health.MemoryBytes,
		lastActivity:      time.Now().Add(-time.Duration(health.IdleSeconds) * time.Second),
		idleUnloadSeconds: health.IdleUnloadAfterSeconds,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sidecar != sidecar {
		// The sidecar was replaced while this probe was in flight; its
		// residency is no longer relevant.
		return false
	}
	previous := sidecar.residency
	sidecar.residency = next
	return residencyChanged(previous, next)
}

func residencyChanged(previous, next *sidecarResidency) bool {
	if previous == nil {
		return next.loadedModelID != ""
	}
	if previous.loadedModelID != next.loadedModelID {
		return true
	}
	if next.lastActivity.Sub(previous.lastActivity) > residencyActivityTolerance {
		return true
	}
	delta := next.memoryBytes - previous.memoryBytes
	if delta < 0 {
		delta = -delta
	}
	return next.loadedModelID != "" && delta >= residencyMemoryDelta
}

func (s *Server) fetchSidecarHealth(ctx context.Context, sidecar *managedSidecar) (sidecarHealth, error) {
	reqCtx, cancel := context.WithTimeout(ctx, s.sidecarProbeTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, sidecar.baseURL+"/health", nil)
	if err != nil {
		return sidecarHealth{}, err
	}
	if sidecar.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+sidecar.apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return sidecarHealth{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return sidecarHealth{}, errors.New(resp.Status)
	}
	var health sidecarHealth
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return sidecarHealth{}, err
	}
	return health, nil
}
