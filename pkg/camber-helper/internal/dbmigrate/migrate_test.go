package dbmigrate_test

import (
	"bytes"
	"database/sql"
	"embed"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/dbmigrate"
)

//go:embed testdata/migrations/*.sql
var testMigrationsFS embed.FS

func openTempDB(t *testing.T) (*sql.DB, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=rwc&_foreign_keys=true")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	return db, path
}

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil))
}

func captureLogger() (*slog.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), buf
}

// TestMigrate_FreshDB runs migrations against an empty DB and verifies the
// happy path: code version > db version (0), BeforeUp fires, tables exist.
func TestMigrate_FreshDB(t *testing.T) {
	db, _ := openTempDB(t)

	var beforeUpCalled bool
	var beforeUpFromVersion uint
	status, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          silentLogger(),
		BeforeUp: func(fromVersion uint) error {
			beforeUpCalled = true
			beforeUpFromVersion = fromVersion
			return nil
		},
	})
	require.NoError(t, err)
	assert.False(t, status.RolledForward)
	assert.True(t, beforeUpCalled, "BeforeUp should fire on fresh DB with pending migrations")
	assert.Equal(t, uint(0), beforeUpFromVersion)

	// Schema applied.
	var n int
	assert.NoError(t, db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='widget'").Scan(&n))
	assert.Equal(t, 1, n)
}

// TestMigrate_Tolerates_DbAhead seeds a future migration version and verifies
// the runner logs and returns without attempting to migrate.
func TestMigrate_Tolerates_DbAhead(t *testing.T) {
	db, _ := openTempDB(t)

	// Run migrations once to establish the tracking table.
	_, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          silentLogger(),
	})
	require.NoError(t, err)

	// Forge a future version.
	_, err = db.Exec("DELETE FROM migration")
	require.NoError(t, err)
	_, err = db.Exec("INSERT INTO migration (version, dirty) VALUES (99999999999999, 0)")
	require.NoError(t, err)

	// Insert a data row to ensure nothing is destroyed by the tolerance path.
	_, err = db.Exec("INSERT INTO widget (name) VALUES ('sentinel')")
	require.NoError(t, err)

	logger, buf := captureLogger()
	var beforeUpCalled bool
	status, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          logger,
		BeforeUp: func(fromVersion uint) error {
			beforeUpCalled = true
			return nil
		},
	})
	require.NoError(t, err)
	assert.True(t, status.RolledForward, "expected tolerance to activate")
	assert.Equal(t, uint(99999999999999), status.DBVersion)
	assert.NotZero(t, status.CodeMaxVersion)
	assert.False(t, beforeUpCalled, "BeforeUp must not fire when tolerance is active")

	// Data row survived.
	var name string
	assert.NoError(t, db.QueryRow("SELECT name FROM widget WHERE name='sentinel'").Scan(&name))
	assert.Equal(t, "sentinel", name)

	// Tolerance warning was logged.
	assert.Contains(t, buf.String(), "db is ahead")
}

// TestMigrate_NoOpOnUpToDate runs migrations twice; the second call should
// be a no-op and BeforeUp must not fire.
func TestMigrate_NoOpOnUpToDate(t *testing.T) {
	db, _ := openTempDB(t)

	_, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          silentLogger(),
	})
	require.NoError(t, err)

	var beforeUpCalled bool
	status, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          silentLogger(),
		BeforeUp: func(fromVersion uint) error {
			beforeUpCalled = true
			return nil
		},
	})
	require.NoError(t, err)
	assert.False(t, status.RolledForward)
	assert.False(t, beforeUpCalled, "BeforeUp should not fire when DB is up to date")
	assert.Equal(t, status.DBVersion, status.CodeMaxVersion)
}

// TestMigrate_BeforeUpErrorNonBlocking verifies that a failure in the
// BeforeUp hook does not prevent migrations from running.
func TestMigrate_BeforeUpErrorNonBlocking(t *testing.T) {
	db, _ := openTempDB(t)

	status, err := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    testMigrationsFS,
		MigrationsDir:   "testdata/migrations",
		MigrationsTable: "migration",
		Logger:          silentLogger(),
		BeforeUp: func(fromVersion uint) error {
			return os.ErrPermission
		},
	})
	require.NoError(t, err, "BeforeUp failure must not block migration")
	assert.False(t, status.RolledForward)

	// Migration still ran.
	var n int
	assert.NoError(t, db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='widget'").Scan(&n))
	assert.Equal(t, 1, n)
}
