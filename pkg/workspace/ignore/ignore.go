// Package ignore provides the file and directory filtering used by workspace search.
package ignore

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/go-git/go-billy/v5"
	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/spf13/afero"

	"github.com/appleton/camber/pkg/common/data"
	"github.com/appleton/camber/pkg/common/sync/bufferpool"
	"github.com/appleton/camber/pkg/git"
	"github.com/appleton/camber/pkg/workspace/afero2billy"
	"github.com/appleton/camber/pkg/workspace/path"
)

const defaultLRUSize = 100000

var defaultGitIgnorePatterns = make(
	[]gitignore.Pattern,
	len(defaultGitIgnoreStrings)+
		len(defaultSensitiveIgnoreStrings)+
		len(data.CommonBinaryExtensions),
)

func init() {
	i := 0
	for _, s := range defaultGitIgnoreStrings {
		defaultGitIgnorePatterns[i] = gitignore.ParsePattern(s, nil)
		i++
	}
	for _, s := range defaultSensitiveIgnoreStrings {
		defaultGitIgnorePatterns[i] = gitignore.ParsePattern(s, nil)
		i++
	}
	for ext := range data.CommonBinaryExtensions {
		defaultGitIgnorePatterns[i] = gitignore.ParsePattern("*"+ext, nil)
		i++
	}
}

// matcher implements gitignore pattern matching with binary filtering.
// It caches results using an LRU cache to improve performance for frequently accessed paths.
type matcher struct {
	opts      options
	fs        afero.Fs
	gitignore gitignore.Matcher
	bp        *bufferpool.BufferPool[byte]
	cache     *lruCache
}

var _ gitignore.Matcher = (*matcher)(nil)

// Match checks if the given path should be ignored.
// It returns true if the path matches any ignore pattern or filter criteria.
//
// The result is cached in an LRU cache to improve performance for frequently
// accessed paths. The cache is thread-safe and automatically evicts least
// recently used entries when it reaches capacity.
func (m *matcher) Match(pth []string, isDir bool) bool {
	if matched, found := m.cache.Get(pth, isDir); found {
		return matched
	}

	if m.gitignore.Match(pth, isDir) {
		m.cache.Add(pth, isDir, true)
		return true
	}

	fp := path.Path(pth).String()

	var (
		fi        os.FileInfo
		err       error
		isSymlink bool
	)

	if !isDir && m.opts.ignoreBinary {
		if lfs, ok := m.fs.(afero.Lstater); ok {
			fi, _, err = lfs.LstatIfPossible(fp)
		} else {
			fi, err = m.fs.Stat(fp)
		}
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				m.cache.Add(pth, isDir, false)
			} else {
				// don't do negative caching for stat errors
				slog.Error("error statting file", "path", fp, "err", err)
			}
			return false
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			isSymlink = true
		}
	}

	if !isDir && !isSymlink && m.opts.ignoreBinary && fi.Size() > 0 {
		isBinary, err := data.IsBinaryFile(fp, data.WithFS(m.fs), data.WithBufferPool(m.bp))
		if err != nil {
			slog.Error("error checking if file is binary", "path", fp, "err", err)
			// don't do negative caching for binary check errors
			return false
		}
		if isBinary {
			m.cache.Add(pth, isDir, true)
			return true
		}
	}

	m.cache.Add(pth, isDir, false)
	return false
}

func defaultPatterns() []gitignore.Pattern {
	return defaultGitIgnorePatterns
}

const (
	commentPrefix    = "#"
	gitDir           = ".git"
	gitignoreFile    = ".gitignore"
	camberignoreFile = ".camberignore"
	infoExcludeFile  = gitDir + string(filepath.Separator) + "info" + string(filepath.Separator) + "exclude"
)

// This was copied from "github.com/go-git/go-git/v5/internal/path_util"
func replaceTildeWithHome(path string) (string, error) {
	if strings.HasPrefix(path, "~") {
		firstSeparator := strings.Index(path, string(filepath.Separator))
		if firstSeparator == 1 {
			home, err := os.UserHomeDir()
			if err != nil {
				return path, err
			}
			return strings.Replace(path, "~", home, 1), nil
		} else if firstSeparator > 1 {
			username := path[1:firstSeparator]
			userAccount, err := user.Lookup(username)
			if err != nil {
				return path, err
			}
			return strings.Replace(path, path[:firstSeparator], userAccount.HomeDir, 1), nil
		}
	}

	return path, nil
}

// readIgnoreFile reads a specific git ignore file.
// This was copied from "github.com/go-git/go-git/v5/plumbing/format/gitignore"
func readIgnoreFile(
	fs billy.Filesystem,
	path []string,
	ignoreFile string,
) (ps []gitignore.Pattern, err error) {
	ignoreFile, _ = replaceTildeWithHome(ignoreFile)

	f, err := fs.Open(fs.Join(append(path, ignoreFile)...))
	if err == nil {
		defer f.Close()

		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			s := scanner.Text()
			if !strings.HasPrefix(s, commentPrefix) && len(strings.TrimSpace(s)) > 0 {
				ps = append(ps, gitignore.ParsePattern(s, path))
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	return
}

// readPatterns reads the .git/info/exclude and then the gitignore patterns
// recursively traversing through the directory structure. The result is in
// the ascending order of priority (last higher).
// This was copied from "github.com/go-git/go-git/v5/plumbing/format/gitignore" and support was
// added for .camberignore files.
func readPatterns(fs billy.Filesystem, path []string) (ps []gitignore.Pattern, err error) {
	ps, _ = readIgnoreFile(fs, path, infoExcludeFile)

	subps, _ := readIgnoreFile(fs, path, gitignoreFile)
	ps = append(ps, subps...)

	subps, _ = readIgnoreFile(fs, path, camberignoreFile)
	ps = append(ps, subps...)

	var fis []os.FileInfo
	fis, err = fs.ReadDir(fs.Join(path...))
	if err != nil {
		return
	}

	// Build the matcher once for all sibling directories at this level,
	// rather than rebuilding inside the loop on every iteration.
	m := gitignore.NewMatcher(ps)

	for _, fi := range fis {
		if fi.IsDir() && fi.Name() != gitDir {
			if m.Match(append(path, fi.Name()), true) {
				continue
			}

			var subps []gitignore.Pattern
			subps, err = readPatterns(fs, append(path, fi.Name()))
			if err != nil {
				return
			}

			if len(subps) > 0 {
				ps = append(ps, subps...)
			}
		}
	}

	return
}

func newMatcher(fs afero.Fs, opts ...Option) (*matcher, error) {
	o := options{}
	o.apply(opts)

	var patterns []gitignore.Pattern
	if o.gitIgnore {
		var err error
		if patterns, err = readPatterns(
			afero2billy.New(fs, string(filepath.Separator)),
			nil,
		); err != nil {
			return nil, fmt.Errorf("error reading gitignore patterns from filesystem: %w", err)
		}
	}

	patterns = append(
		patterns,
		defaultPatterns()..., // default patterns take precedence over fs
	)

	m := gitignore.NewMatcher(patterns)

	var bp *bufferpool.BufferPool[byte]
	if o.ignoreBinary {
		bp = bufferpool.New[byte](data.DefaultBinaryCheckBufSize)
	}

	return &matcher{
		opts:      o,
		fs:        fs,
		gitignore: m,
		cache:     newLRU(defaultLRUSize),
		bp:        bp,
	}, nil
}

type CheckIgnoredFunc = func(path string, isDir bool) bool

func CreateIgnoredChecker(fs afero.Fs, rootPath string) (CheckIgnoredFunc, error) {
	_, wt, err := git.Locate(fs, rootPath)
	if err != nil {
		if !errors.Is(err, git.ErrNoDotGitDir) {
			return nil, err
		}

		// Fallback to rootPath if no .git folder found.
		wt = afero2billy.New(afero.NewBasePathFs(fs, rootPath), rootPath)
	}

	matcher, err := newMatcher(wt.Fs, withGitIgnore(), withIgnoreBinary())
	if err != nil {
		return nil, err
	}

	return func(fpath string, isDir bool) bool {
		if matcher == nil {
			return false
		}

		relPath, err := filepath.Rel(wt.Path, fpath)
		if err == nil {
			fpath = relPath
		}

		return matcher.Match(path.Parse(fpath), isDir)
	}, nil
}
