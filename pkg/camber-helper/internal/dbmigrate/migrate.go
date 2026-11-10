// Package dbmigrate wraps golang-migrate with a "forward-version tolerance"
// policy: if the DB records a migration version that is ahead of what this
// binary knows about, we log-and-proceed instead of hard-failing.
//
// This is safe only when migrations are strictly additive (ADD COLUMN with
// DEFAULT, CREATE TABLE/INDEX/TRIGGER, etc.). The additive-only property is
// enforced at CI time by a separate linter test in each caller package. The
// escape hatch for truly breaking schema changes is to bump the DB filename,
// which gives users a fresh DB and preserves the old file intact for manual
// downgrade.
package dbmigrate

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// Status reports the outcome of a Migrate call.
type Status struct {
	// RolledForward is true when the DB recorded a version greater than the
	// latest migration embedded in this binary. When true, m.Up() was not
	// called — the DB is used as-is, relying on additive-only compatibility.
	RolledForward bool

	// DBVersion is the migration version recorded in the DB at the start of
	// the call. 0 if the migrations table was empty or absent.
	DBVersion uint

	// CodeMaxVersion is the max migration version known to this binary. 0
	// if no migrations were found (should never happen in practice).
	CodeMaxVersion uint

	// Dirty is true if the DB migration table recorded a failed prior
	// migration. Callers may want to surface this separately.
	Dirty bool
}

// Config parameterises Migrate.
type Config struct {
	// DB is the open SQLite database handle.
	DB *sql.DB
	// MigrationsFS is the embedded filesystem containing .up.sql / .down.sql
	// files.
	MigrationsFS embed.FS
	// MigrationsDir is the directory inside MigrationsFS that holds
	// migration files (e.g. "migrations" or "migrations/sqlite").
	MigrationsDir string
	// MigrationsTable is the name of the migration tracking table
	// (e.g. "migration" or "rag_migrations").
	MigrationsTable string
	// BeforeUp is called once, if non-nil, when Migrate is about to apply
	// at least one pending migration. It receives the DB version before
	// migrations run (0 for a fresh DB), so callers can snapshot the DB
	// before it changes. A non-nil error is logged but does not block
	// migration.
	BeforeUp func(fromVersion uint) error
	// Logger receives structured log events. Must not be nil.
	Logger *slog.Logger
}

// Migrate applies pending migrations if the DB is behind, or records
// "rolled forward" state and returns without calling m.Up() if the DB is
// ahead of this binary's known migrations.
func Migrate(cfg Config) (Status, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	driver, err := sqlite3.WithInstance(cfg.DB, &sqlite3.Config{
		MigrationsTable: cfg.MigrationsTable,
	})
	if err != nil {
		return Status{}, fmt.Errorf("sqlite3.WithInstance: %w", err)
	}

	src, err := iofs.New(cfg.MigrationsFS, cfg.MigrationsDir)
	if err != nil {
		return Status{}, fmt.Errorf("iofs.New: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", src, "", driver)
	if err != nil {
		return Status{}, fmt.Errorf("migrate.NewWithInstance: %w", err)
	}

	codeMax, err := maxSourceVersion(src)
	if err != nil {
		return Status{}, fmt.Errorf("determining max migration version: %w", err)
	}

	dbVersion, dirty, err := m.Version()
	switch {
	case errors.Is(err, migrate.ErrNilVersion):
		dbVersion = 0
	case err != nil:
		return Status{}, fmt.Errorf("reading db migration version: %w", err)
	}

	status := Status{
		DBVersion:      dbVersion,
		CodeMaxVersion: codeMax,
		Dirty:          dirty,
	}

	if dbVersion > codeMax {
		status.RolledForward = true
		cfg.Logger.Warn(
			"db is ahead of this binary's migrations",
			"db_version", dbVersion,
			"code_max_version", codeMax,
			"migrations_table", cfg.MigrationsTable,
			"dirty", dirty,
		)
		return status, nil
	}

	if dbVersion < codeMax && cfg.BeforeUp != nil {
		if err := cfg.BeforeUp(dbVersion); err != nil {
			cfg.Logger.Error(
				"pre-migration BeforeUp hook failed; continuing with migration",
				"err", err,
				"from_version", dbVersion,
				"migrations_table", cfg.MigrationsTable,
			)
		}
	}

	m.Log = migrationLogger{logger: cfg.Logger}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return status, fmt.Errorf("migration up: %w", err)
	}

	return status, nil
}

// maxSourceVersion walks a migration source and returns the highest
// migration version found. Returns 0 if the source is empty.
func maxSourceVersion(src source.Driver) (uint, error) {
	first, err := src.First()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || isPathError(err) {
			return 0, nil
		}
		return 0, err
	}
	max := first
	for {
		next, err := src.Next(max)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || isPathError(err) {
				return max, nil
			}
			return 0, err
		}
		max = next
	}
}

// isPathError matches the fs.PathError that iofs returns when it walks
// past the last migration.
func isPathError(err error) bool {
	var pe *fs.PathError
	return errors.As(err, &pe)
}

type migrationLogger struct {
	logger *slog.Logger
}

func (l migrationLogger) Printf(format string, v ...any) {
	l.logger.Info(fmt.Sprintf("migration: "+format, v...))
}

func (l migrationLogger) Verbose() bool {
	return l.logger.Handler().Enabled(context.Background(), slog.LevelDebug)
}
