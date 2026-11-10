package git

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/utils/ioutil"
	"github.com/spf13/afero"

	"github.com/appleton/camber/pkg/workspace/afero2billy"
)

// ErrNoDotGitDir is returned when no .git directory can be found in the current
// directory or any parent directories
var ErrNoDotGitDir = fmt.Errorf("no .git directory found")

type FS = afero2billy.Wrapper

// Locate finds the .git directory starting from the given path and walking up
// the directory tree. It returns two filesystem wrappers: one for the .git
// directory (dot) and one for the working tree (wt).
func Locate(fs afero.Fs, path string) (dot, wt FS, err error) {
	slog.Info("locating .git directory", "path", path)
	if path, err = filepath.Abs(path); err != nil {
		return FS{}, FS{}, err
	}

	// trim windows volume prefix if present
	path = strings.TrimPrefix(path, filepath.VolumeName(path))

	var fi os.FileInfo
	for {
		if fi, err = fs.Stat(filepath.Join(path, gogit.GitDirName)); err == nil {
			// no error; stop
			slog.Info("found dot git", "path", path)
			break
		}
		if !os.IsNotExist(err) {
			// unknown error; stop
			return FS{}, FS{}, err
		}
		// try its parent as long as we haven't reached the root dir
		if dir := filepath.Dir(path); dir != path {
			path = dir
			continue
		}
		// not detecting via parent dirs and the dir does not exist; stop
		return FS{}, FS{}, ErrNoDotGitDir
	}

	wt = afero2billy.New(afero.NewBasePathFs(fs, path), path)

	if fi.IsDir() {
		dotPath := filepath.Join(path, gogit.GitDirName)
		dot = afero2billy.New(afero.NewBasePathFs(fs, dotPath), dotPath)
		return dot, wt, nil
	}

	slog.Info("dot git is not a directory")

	if dot, err = parseDotGitFile(fs, path); err != nil {
		return FS{}, FS{}, err
	}

	return dot, wt, nil
}

// parseDotGitFile reads and parses a .git file that contains a reference to the
// actual Git directory. This is commonly used in Git submodules and worktrees.
func parseDotGitFile(fs afero.Fs, path string) (bfs FS, err error) {
	f, err := fs.Open(filepath.Join(path, gogit.GitDirName))
	if err != nil {
		return FS{}, err
	}

	defer ioutil.CheckClose(f, &err)

	b, err := io.ReadAll(f)
	if err != nil {
		return FS{}, err
	}

	line := string(b)
	const prefix = "gitdir: "
	if !strings.HasPrefix(line, prefix) {
		return FS{}, fmt.Errorf(".git file has no %s prefix", prefix)
	}

	gitdir := strings.Split(line[len(prefix):], "\n")[0]
	gitdir = strings.TrimSpace(gitdir)
	if filepath.IsAbs(gitdir) {
		return afero2billy.New(afero.NewBasePathFs(fs, gitdir), gitdir), nil
	}

	root := filepath.Join(path, gitdir)
	return afero2billy.New(afero.NewBasePathFs(fs, root), root), nil
}
