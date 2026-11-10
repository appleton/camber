package handler

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptest"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestInitializeSurvivesMalformedAssistantConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "assistant.json")
	require.NoError(t, os.WriteFile(configPath, []byte(`{"agent_servers":`), 0o644))
	t.Setenv("CAMBER_ASSISTANT_CONFIG_PATH", configPath)
	t.Setenv("CAMBER_ACP_NAV_DB_PATH", filepath.Join(dir, "acp-nav.db"))

	h := New()
	gCtx := lsptest.NewDefaultGLSPTestCtx(t)
	_, err := h.Initialize(gCtx, &protocol.InitializeParams{})
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, h.shutdown(gCtx))
	})

	_, err = h.ACPNavListAgentServers(
		context.Background(),
		&methods.ACPNavListAgentServersParams{},
		gCtx,
	)
	require.ErrorContains(t, err, "assistant config: parsing "+configPath)

	require.NoError(t, os.WriteFile(
		configPath,
		[]byte(`{"agent_servers":{"custom":{"command":"custom-agent"}}}`),
		0o644,
	))
	state, err := h.ACPNavListAgentServers(
		context.Background(),
		&methods.ACPNavListAgentServersParams{},
		gCtx,
	)
	require.NoError(t, err)
	require.Equal(t, "custom-agent", state.AgentServers["custom"].Command)
}

// BenchmarkInitializeReady measures the actual initialize request, separately
// from handler construction. Everything stays in temporary stores; the custom
// camber entry prevents background registry/network repair in this fixture.
func BenchmarkInitializeReady(b *testing.B) {
	for _, scenario := range []string{"fresh", "existing", "history"} {
		b.Run(scenario, func(b *testing.B) {
			dir := b.TempDir()
			b.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(dir, "remote.json"))
			b.Setenv("CAMBER_ASSISTANT_CONFIG_PATH", filepath.Join(dir, "assistant.json"))
			dbPath := filepath.Join(dir, "nav.db")
			b.Setenv("CAMBER_ACP_NAV_DB_PATH", dbPath)
			require.NoError(b, os.WriteFile(filepath.Join(dir, "assistant.json"), []byte(`{"agent_servers":{"poolside":{"type":"custom","command":"fixture-agent"}}}`), 0o600))
			ctx := context.Background()
			if scenario != "fresh" {
				store, err := acpnav.Open(ctx, dbPath)
				require.NoError(b, err)
				require.NoError(b, store.Close())
			}
			if scenario == "history" {
				db, err := sql.Open("sqlite3", dbPath)
				require.NoError(b, err)
				tx, err := db.Begin()
				require.NoError(b, err)
				metadata := `{"summary":"` + strings.Repeat("history", 128) + `"}`
				for i := 0; i < 10_000; i++ {
					_, err = tx.Exec(`INSERT INTO conversations(id, workspace_path, agent_server, session_id, cwd, title, metadata_json, created_at, touched_at) VALUES (?,'/fixture','poolside',?,'/fixture','fixture',?,'2026-09-07','2026-09-07')`, fmt.Sprint(i), fmt.Sprint(i), metadata)
					require.NoError(b, err)
				}
				require.NoError(b, tx.Commit())
				require.NoError(b, db.Close())
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				if scenario == "fresh" {
					require.NoError(b, os.RemoveAll(dbPath))
					require.NoError(b, os.RemoveAll(dbPath+"-wal"))
					require.NoError(b, os.RemoveAll(dbPath+"-shm"))
				}
				h := New()
				h.pprofStarted.Do(func() {})
				gCtx := &glsp.Context{Context: ctx}
				b.StartTimer()
				_, err := h.initialize(gCtx, &protocol.InitializeParams{})
				b.StopTimer()
				require.NoError(b, err)
				require.True(b, h.IsInitialized())
				require.NoError(b, h.shutdown(gCtx))
				b.StartTimer()
			}
		})
	}
}
