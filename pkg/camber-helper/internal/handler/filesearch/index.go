package filesearch

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sahilm/fuzzy"
	"github.com/spf13/afero"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/data"
	"github.com/appleton/camber/pkg/workspace/ignore"
)

type searchIndex struct {
	files             []indexedFile
	fileRelativePaths []string
	directories       []indexedFile
	directoryRelPaths []string
}

type fuzzyMatch struct {
	value   string
	index   int
	score   int
	indices []int
}

func buildIndex(ctx context.Context, workspaces []WorkspaceFolder, openFiles []string) (*searchIndex, error) {
	rooted := openFilesOutsideWorkspace(openFiles, workspaces)
	for _, workspace := range workspaces {
		paths, err := workspaceRootedPaths(ctx, workspace)
		if err != nil {
			return nil, err
		}
		rooted = append(rooted, paths...)
	}

	seen := make(map[string]struct{}, len(rooted))
	files := make([]indexedFile, 0, len(rooted))
	fileRelativePaths := make([]string, 0, len(rooted))
	for _, entry := range rooted {
		absolutePath := filepath.Clean(filepath.Join(entry.basePath, filepath.FromSlash(entry.fromBase)))
		if _, ok := seen[absolutePath]; ok {
			continue
		}
		seen[absolutePath] = struct{}{}
		fromBase := strings.TrimSuffix(filepath.ToSlash(entry.fromBase), "/")
		name := filepath.Base(fromBase)
		directory := filepath.ToSlash(filepath.Dir(fromBase))
		if directory == "" {
			directory = "."
		}
		relativePath := name
		if directory != "." {
			relativePath = directory + "/" + name
		}
		files = append(files, indexedFile{
			path:         absolutePath,
			name:         name,
			directory:    directory,
			relativePath: relativePath,
			workspace:    entry.workspace,
			isDirectory:  entry.isDirectory,
		})
		fileRelativePaths = append(fileRelativePaths, relativePath)
	}

	directories := make([]indexedFile, 0)
	directoryRelPaths := make([]string, 0)
	for _, file := range files {
		if file.isDirectory {
			directories = append(directories, file)
			directoryRelPaths = append(directoryRelPaths, file.relativePath)
		}
	}

	return &searchIndex{
		files:             files,
		fileRelativePaths: fileRelativePaths,
		directories:       directories,
		directoryRelPaths: directoryRelPaths,
	}, nil
}

func workspaceRootedPaths(ctx context.Context, workspace WorkspaceFolder) ([]rootedPath, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if paths, ok := getFilesFromGit(ctx, workspace); ok {
		return paths, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return getFilesFromWalk(ctx, workspace)
}

func getFilesFromGit(ctx context.Context, workspace WorkspaceFolder) ([]rootedPath, bool) {
	rootOut, err := exec.CommandContext(ctx, "git", "-C", workspace.Path, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return nil, false
	}
	repoRoot := strings.TrimSpace(string(rootOut))
	if resolvedRepoRoot, err := filepath.EvalSymlinks(repoRoot); err == nil {
		repoRoot = resolvedRepoRoot
	}
	workspacePath := workspace.Path
	if resolvedWorkspacePath, err := filepath.EvalSymlinks(workspacePath); err == nil {
		workspacePath = resolvedWorkspacePath
	}
	prefix := ""
	if rel, err := filepath.Rel(repoRoot, workspacePath); err == nil && rel != "." {
		prefix = filepath.ToSlash(rel) + "/"
	}

	deletedOut, _ := exec.CommandContext(ctx, "git", "-C", workspace.Path, "ls-files", "--full-name", "--deleted").Output()
	deleted := linesToSet(relativizeGitLines(deletedOut, prefix))

	trackedOut, err := exec.CommandContext(ctx, "git", "-C", workspace.Path, "ls-files", "--full-name", "--deduplicate", "--cached", "--recurse-submodules").Output()
	if err != nil {
		trackedOut, err = exec.CommandContext(ctx, "git", "-C", workspace.Path, "ls-files", "--full-name", "--deduplicate", "--cached").Output()
		if err != nil {
			return nil, false
		}
	}
	untrackedOut, _ := exec.CommandContext(ctx, "git", "-C", workspace.Path, "ls-files", "--full-name", "--deduplicate", "--others", "--exclude-standard").Output()

	dirSet := make(map[string]struct{})
	files := make([]rootedPath, 0)
	collect := func(source []byte) {
		for _, raw := range relativizeGitLines(source, prefix) {
			if _, ok := deleted[raw]; ok {
				continue
			}
			files = append(files, rootedPath{fromBase: raw, basePath: workspace.Path, workspace: workspace.Name})
			for dir := filepath.ToSlash(filepath.Dir(raw)); dir != "." && dir != ""; dir = filepath.ToSlash(filepath.Dir(dir)) {
				dirSet[markAsDirectory(dir)] = struct{}{}
			}
		}
	}
	collect(trackedOut)
	collect(untrackedOut)

	dirs := make([]string, 0, len(dirSet))
	for dir := range dirSet {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)

	out := make([]rootedPath, 0, len(dirs)+len(files))
	for _, dir := range dirs {
		out = append(out, rootedPath{fromBase: dir, basePath: workspace.Path, workspace: workspace.Name, isDirectory: true})
	}
	out = append(out, files...)
	return out, true
}

func relativizeGitLines(source []byte, prefix string) []string {
	var out []string
	for _, line := range bytes.Split(source, []byte("\n")) {
		raw := string(line)
		if raw == "" {
			continue
		}
		raw = filepath.ToSlash(raw)
		if prefix != "" {
			if !strings.HasPrefix(raw, prefix) {
				continue
			}
			raw = raw[len(prefix):]
		}
		out = append(out, raw)
	}
	return out
}

func linesToSet(lines []string) map[string]struct{} {
	set := make(map[string]struct{}, len(lines))
	for _, line := range lines {
		set[line] = struct{}{}
	}
	return set
}

func getFilesFromWalk(ctx context.Context, workspace WorkspaceFolder) ([]rootedPath, error) {
	checkIgnored, err := ignore.CreateIgnoredChecker(afero.NewOsFs(), workspace.Path)
	if err != nil {
		checkIgnored = func(string, bool) bool { return false }
	}
	var paths []rootedPath
	err = filepath.WalkDir(workspace.Path, func(path string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return nil
		}
		if path == workspace.Path {
			return nil
		}
		isDir := entry.IsDir()
		if checkIgnored(path, isDir) {
			if isDir {
				return filepath.SkipDir
			}
			return nil
		}
		stat, err := os.Stat(path)
		if err != nil {
			return nil
		}
		isDir = stat.IsDir()
		if !isDir && !stat.Mode().IsRegular() {
			return nil
		}
		if !isDir {
			isBinary, err := data.IsBinaryFile(path)
			if err == nil && isBinary {
				return nil
			}
		}
		rel, err := filepath.Rel(workspace.Path, path)
		if err != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if isDir {
			rel = markAsDirectory(rel)
		}
		paths = append(paths, rootedPath{fromBase: rel, basePath: workspace.Path, workspace: workspace.Name, isDirectory: isDir})
		return nil
	})
	return paths, err
}

func openFilesOutsideWorkspace(openFiles []string, workspaces []WorkspaceFolder) []rootedPath {
	var out []rootedPath
	for _, file := range openFiles {
		if file == "" {
			continue
		}
		inside := false
		for _, workspace := range workspaces {
			if pathContains(workspace.Path, file) {
				inside = true
				break
			}
		}
		if inside {
			continue
		}
		out = append(out, rootedPath{
			fromBase:  filepath.Base(file),
			basePath:  filepath.Dir(file),
			workspace: "Opened Files",
		})
	}
	return out
}

func (idx *searchIndex) search(ctx context.Context, query string, mode queryMode, workspaces []WorkspaceFolder) ([]methods.SearchFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	isDirSearch := strings.HasPrefix(query, "/")
	term := query
	if isDirSearch {
		term = strings.TrimPrefix(query, "/")
	}
	candidates := idx.files
	haystack := idx.fileRelativePaths
	if isDirSearch {
		candidates = idx.directories
		haystack = idx.directoryRelPaths
	}
	if term == "" {
		return filesFromIndexed(candidates, nil, resultLimit, mode, isDirSearch, workspaces), nil
	}

	matches, err := fuzzyFind(ctx, term, haystack, resultLimit)
	if err != nil {
		return nil, err
	}
	return filesFromIndexed(candidates, matches, resultLimit, mode, isDirSearch, workspaces), nil
}

func filesFromIndexed(candidates []indexedFile, matches []fuzzyMatch, limit int, mode queryMode, dirSearch bool, workspaces []WorkspaceFolder) []methods.SearchFile {
	if matches == nil {
		n := min(limit, len(candidates))
		files := make([]methods.SearchFile, 0, n)
		for _, candidate := range candidates[:n] {
			files = append(files, searchFileFromIndexed(candidate, fuzzyMatch{}, mode, workspaces))
		}
		if !dirSearch {
			sort.SliceStable(files, func(i, j int) bool { return !files[i].IsDirectory && files[j].IsDirectory })
		}
		return files
	}

	files := make([]methods.SearchFile, 0, len(matches))
	for _, match := range matches {
		files = append(files, searchFileFromIndexed(candidates[match.index], match, mode, workspaces))
	}
	if !dirSearch {
		sort.SliceStable(files, func(i, j int) bool { return !files[i].IsDirectory && files[j].IsDirectory })
	}
	return files
}

func searchFileFromIndexed(file indexedFile, match fuzzyMatch, mode queryMode, workspaces []WorkspaceFolder) methods.SearchFile {
	nameIndices := extractNameIndices(match.indices, file.directory)
	directoryIndices := extractDirectoryIndices(match.indices, file.directory)
	workspace := &methods.SearchFileMatchable{Value: file.workspace, Score: 0, Indices: []int{}}
	return methods.SearchFile{
		Path:        file.path,
		Name:        methods.SearchFileMatchable{Value: file.name, Score: match.score, Indices: nameIndices},
		Directory:   methods.SearchFileMatchable{Value: file.directory, Score: match.score, Indices: directoryIndices},
		Workspace:   workspace,
		IsDirectory: file.isDirectory,
		Score:       match.score,
		DisplayPath: formatDisplayPath(file.path, mode, file.isDirectory, workspaces),
	}
}

func fuzzyFind(ctx context.Context, term string, values []string, limit int) ([]fuzzyMatch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	results := fuzzy.Find(term, values)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(results) > limit {
		results = results[:limit]
	}
	matches := make([]fuzzyMatch, 0, len(results))
	lowerTerm := strings.ToLower(term)
	for _, result := range results {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		score := result.Score
		lowerValue := strings.ToLower(result.Str)
		name := strings.ToLower(filepath.Base(result.Str))
		// sahilm/fuzzy scores sparse path matches well, but file pickers
		// should prefer literal path substrings and filename-prefix matches.
		if strings.HasPrefix(name, lowerTerm) || strings.Contains(lowerValue, lowerTerm) {
			score *= 2
		}
		matches = append(matches, fuzzyMatch{
			value:   result.Str,
			index:   result.Index,
			score:   score,
			indices: append([]int(nil), result.MatchedIndexes...),
		})
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].score > matches[j].score })
	return matches, nil
}

func extractNameIndices(indices []int, directory string) []int {
	if len(indices) == 0 {
		return []int{}
	}
	nameStart := 0
	if directory != "." {
		nameStart = len([]rune(directory)) + 1
	}
	var out []int
	for _, idx := range indices {
		if idx >= nameStart {
			out = append(out, idx-nameStart)
		}
	}
	if out == nil {
		return []int{}
	}
	return out
}

func extractDirectoryIndices(indices []int, directory string) []int {
	if len(indices) == 0 || directory == "." {
		return []int{}
	}
	var out []int
	dirLen := len([]rune(directory))
	for _, idx := range indices {
		if idx < dirLen {
			out = append(out, idx)
		}
	}
	if out == nil {
		return []int{}
	}
	return out
}
