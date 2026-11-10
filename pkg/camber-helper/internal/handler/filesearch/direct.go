package filesearch

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type classifiedEntry struct {
	name        string
	isDirectory bool
}

type workspaceSegment struct {
	folder  WorkspaceFolder
	segment string
}

func resolveDirectFilesystemPath(ctx context.Context, query string, workspaces []WorkspaceFolder) (directoryListing, error) {
	classified := classifyQuery(query)
	if classified.mode == queryModeFuzzy {
		return directoryListing{}, nil
	}
	if classified.mode == queryModeRelative && len(workspaces) > 1 {
		return resolveMultiRootRelativePath(ctx, classified.bare, workspaces)
	}

	var absolutePath string
	switch classified.mode {
	case queryModeUser:
		home, err := os.UserHomeDir()
		if err != nil {
			return directoryListing{}, nil
		}
		if classified.bare == "~" {
			absolutePath = home
		} else {
			absolutePath = filepath.Join(home, classified.bare[2:])
		}
	case queryModeAbsolute:
		if classified.bare == "/" {
			return directoryListing{}, nil
		}
		absolutePath = classified.bare
	case queryModeRelative:
		if len(workspaces) == 0 {
			return directoryListing{}, nil
		}
		root := workspaces[0].Path
		absolutePath = filepath.Clean(filepath.Join(root, classified.bare))
		if !pathContains(root, absolutePath) {
			return directoryListing{}, nil
		}
	}

	if absolutePath == "" {
		return directoryListing{}, nil
	}

	wantsListing := hasTrailingPathSeparator(classified.bare)
	absolutePath = stripTrailingPathSeparators(absolutePath)
	if wantsListing {
		root := ""
		if classified.mode == queryModeRelative && len(workspaces) > 0 {
			root = workspaces[0].Path
		}
		return listDirectoryEntries(ctx, absolutePath, "", listDirectoryOptions{
			includeCurrent: true,
			includeParent:  canNavigateToParent(classified.mode, absolutePath, root),
			mode:           classified.mode,
			workspaces:     workspaces,
		})
	}

	if stat, err := os.Stat(absolutePath); err == nil && (stat.IsDir() || stat.Mode().IsRegular()) {
		return directoryListing{
			files: []methods.SearchFile{pathToSearchFile(absolutePath, stat.IsDir(), formatDisplayPath(absolutePath, classified.mode, stat.IsDir(), workspaces))},
		}, nil
	}

	dir := filepath.Dir(absolutePath)
	root := ""
	if classified.mode == queryModeRelative && len(workspaces) > 0 {
		root = workspaces[0].Path
		if !pathContains(root, dir) {
			return directoryListing{}, nil
		}
	}
	listing, err := listDirectoryEntries(ctx, dir, strings.ToLower(filepath.Base(absolutePath)), listDirectoryOptions{
		includeCurrent: true,
		includeParent:  canNavigateToParent(classified.mode, dir, root),
		mode:           classified.mode,
		workspaces:     workspaces,
	})
	if classified.mode == queryModeAbsolute && isFilesystemRoot(dir) && len(listing.files) == 0 {
		return directoryListing{}, err
	}
	return listing, err
}

type listDirectoryOptions struct {
	includeCurrent bool
	includeParent  bool
	mode           queryMode
	workspaces     []WorkspaceFolder
}

func listDirectoryEntries(ctx context.Context, dir string, partial string, opts listDirectoryOptions) (directoryListing, error) {
	if err := ctx.Err(); err != nil {
		return directoryListing{}, err
	}
	controls := directoryControls(dir, opts)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if stat, statErr := os.Stat(dir); statErr == nil && stat.IsDir() {
			return directoryListing{controls: controls}, nil
		}
		return directoryListing{}, nil
	}

	showHidden := strings.HasPrefix(partial, ".")
	candidates := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if !showHidden && strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidates = append(candidates, entry)
	}

	var ranked []classifiedEntry
	if partial == "" {
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].Name() < candidates[j].Name() })
		classified := make([]classifiedEntry, 0, len(candidates))
		for _, entry := range candidates {
			if c, ok := classifyDirectoryEntry(dir, entry); ok {
				classified = append(classified, c)
			}
		}
		for _, entry := range classified {
			if len(ranked) >= resultLimit {
				break
			}
			if entry.isDirectory {
				ranked = append(ranked, entry)
			}
		}
		for _, entry := range classified {
			if len(ranked) >= resultLimit {
				break
			}
			if !entry.isDirectory {
				ranked = append(ranked, entry)
			}
		}
	} else {
		names := make([]string, 0, len(candidates))
		byName := make(map[string]os.DirEntry, len(candidates))
		for _, entry := range candidates {
			names = append(names, entry.Name())
			byName[entry.Name()] = entry
		}
		matches, err := fuzzyFind(ctx, partial, names, resultLimit)
		if err != nil {
			return directoryListing{}, err
		}
		for _, match := range matches {
			if c, ok := classifyDirectoryEntry(dir, byName[match.value]); ok {
				ranked = append(ranked, c)
			}
		}
	}

	files := make([]methods.SearchFile, 0, len(ranked))
	for _, entry := range ranked {
		absolutePath := filepath.Join(dir, entry.name)
		files = append(files, pathToSearchFile(absolutePath, entry.isDirectory, formatDisplayPath(absolutePath, opts.mode, entry.isDirectory, opts.workspaces)))
	}

	return directoryListing{files: files, controls: controls}, nil
}

func classifyDirectoryEntry(dir string, entry os.DirEntry) (classifiedEntry, bool) {
	if entry.Type().IsRegular() {
		return classifiedEntry{name: entry.Name()}, true
	}
	if entry.IsDir() {
		return classifiedEntry{name: entry.Name(), isDirectory: true}, true
	}
	if entry.Type()&os.ModeSymlink == 0 {
		return classifiedEntry{}, false
	}
	stat, err := os.Stat(filepath.Join(dir, entry.Name()))
	if err != nil {
		return classifiedEntry{}, false
	}
	if stat.IsDir() {
		return classifiedEntry{name: entry.Name(), isDirectory: true}, true
	}
	if stat.Mode().IsRegular() {
		return classifiedEntry{name: entry.Name()}, true
	}
	return classifiedEntry{}, false
}

func directoryControls(dir string, opts listDirectoryOptions) []methods.SearchFileMenuControl {
	var controls []methods.SearchFileMenuControl
	if opts.includeParent {
		controls = append(controls, methods.SearchFileMenuControl{Kind: "parent"})
	}
	if opts.includeCurrent {
		controls = append(controls, methods.SearchFileMenuControl{
			Kind:        "current",
			Path:        dir,
			DisplayPath: formatDisplayPath(dir, opts.mode, true, opts.workspaces),
		})
	}
	return controls
}

func canNavigateToParent(mode queryMode, dir string, root string) bool {
	switch mode {
	case queryModeAbsolute:
		return dir != filepath.VolumeName(dir)+string(filepath.Separator)
	case queryModeUser:
		home, err := os.UserHomeDir()
		return err == nil && pathContains(home, dir) && dir != home
	case queryModeRelative:
		return root != "" && pathContains(root, dir) && dir != root
	default:
		return false
	}
}

func isFilesystemRoot(path string) bool {
	return path == filepath.VolumeName(path)+string(filepath.Separator)
}

func formatDisplayPath(absolutePath string, mode queryMode, isDirectory bool, workspaces []WorkspaceFolder) string {
	if mode == queryModeAbsolute {
		return withDirectoryTrailingSeparator(absolutePath, isDirectory)
	}
	if mode == queryModeUser {
		home, err := os.UserHomeDir()
		if err == nil {
			rel, relErr := filepath.Rel(home, absolutePath)
			if relErr == nil && rel == "." {
				return "~"
			}
			if relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
				return withDirectoryTrailingSeparator("~"+string(filepath.Separator)+rel, isDirectory)
			}
		}
		return withDirectoryTrailingSeparator(absolutePath, isDirectory)
	}
	for _, workspace := range workspaces {
		rel, err := filepath.Rel(workspace.Path, absolutePath)
		if err == nil && rel == "." {
			return "."
		}
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return withDirectoryTrailingSeparator(rel, isDirectory)
		}
	}
	return withDirectoryTrailingSeparator(absolutePath, isDirectory)
}

func withDirectoryTrailingSeparator(displayPath string, isDirectory bool) string {
	if !isDirectory || hasTrailingPathSeparator(displayPath) {
		return displayPath
	}
	return displayPath + string(filepath.Separator)
}

func resolveMultiRootRelativePath(ctx context.Context, bare string, workspaces []WorkspaceFolder) (directoryListing, error) {
	segments := getWorkspaceSegments(workspaces)
	remainder, ok := relativeQueryRemainder(bare)
	if !ok {
		return directoryListing{}, nil
	}
	separatorIndex := firstPathSeparatorIndex(remainder)
	segmentQuery := remainder
	childQuery := ""
	hasChild := false
	if separatorIndex >= 0 {
		segmentQuery = remainder[:separatorIndex]
		childQuery = remainder[separatorIndex+1:]
		hasChild = true
	}
	var selected *workspaceSegment
	for i := range segments {
		if segments[i].segment == segmentQuery {
			selected = &segments[i]
			break
		}
	}
	if selected == nil || !hasChild {
		files, err := matchingVirtualWorkspaces(ctx, segmentQuery, segments)
		if err != nil {
			return directoryListing{}, err
		}
		return directoryListing{files: files}, nil
	}

	root := selected.folder.Path
	absolutePath := filepath.Clean(filepath.Join(root, childQuery))
	if !pathContains(root, absolutePath) {
		return directoryListing{}, nil
	}
	wantsListing := hasTrailingPathSeparator(bare)
	absolutePath = stripTrailingPathSeparators(absolutePath)
	if wantsListing {
		listing, err := listDirectoryEntries(ctx, absolutePath, "", listDirectoryOptions{
			includeCurrent: true,
			includeParent:  absolutePath == root || canNavigateToParent(queryModeRelative, absolutePath, root),
			mode:           queryModeRelative,
			workspaces:     []WorkspaceFolder{selected.folder},
		})
		return applyVirtualWorkspaceDisplayPaths(listing, *selected), err
	}
	if stat, err := os.Stat(absolutePath); err == nil && (stat.IsDir() || stat.Mode().IsRegular()) {
		displayPath := virtualWorkspaceDisplayPath(root, absolutePath, selected.segment, stat.IsDir())
		return directoryListing{files: []methods.SearchFile{pathToSearchFile(absolutePath, stat.IsDir(), displayPath)}}, nil
	}
	dir := filepath.Dir(absolutePath)
	if !pathContains(root, dir) {
		return directoryListing{}, nil
	}
	listing, err := listDirectoryEntries(ctx, dir, strings.ToLower(filepath.Base(absolutePath)), listDirectoryOptions{
		includeCurrent: true,
		includeParent:  dir == root || canNavigateToParent(queryModeRelative, dir, root),
		mode:           queryModeRelative,
		workspaces:     []WorkspaceFolder{selected.folder},
	})
	return applyVirtualWorkspaceDisplayPaths(listing, *selected), err
}

func relativeQueryRemainder(bare string) (string, bool) {
	if bare == "." {
		return "", true
	}
	if strings.HasPrefix(bare, "./") || strings.HasPrefix(bare, ".\\") {
		return bare[2:], true
	}
	return "", false
}

func getWorkspaceSegments(workspaces []WorkspaceFolder) []workspaceSegment {
	baseSegments := make([]string, len(workspaces))
	counts := make(map[string]int)
	for i, workspace := range workspaces {
		base := sanitizeWorkspaceSegment(workspace.Name, workspace.Index)
		baseSegments[i] = base
		counts[base]++
	}
	used := make(map[string]struct{})
	segments := make([]workspaceSegment, 0, len(workspaces))
	for i, workspace := range workspaces {
		base := baseSegments[i]
		segment := base
		if counts[base] > 1 {
			segment = base + "-" + intString(workspace.Index)
		}
		for suffix := 1; ; suffix++ {
			if _, ok := used[segment]; !ok {
				break
			}
			segment = base + "-" + intString(workspace.Index) + "-" + intString(suffix)
		}
		used[segment] = struct{}{}
		segments = append(segments, workspaceSegment{folder: workspace, segment: segment})
	}
	return segments
}

func sanitizeWorkspaceSegment(name string, fallbackIndex int) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-")
	segment := strings.TrimSpace(replacer.Replace(name))
	if segment == "" {
		return "workspace-" + intString(fallbackIndex)
	}
	return segment
}

func intString(value int) string {
	return strconv.Itoa(value)
}

func matchingVirtualWorkspaces(ctx context.Context, partial string, workspaces []workspaceSegment) ([]methods.SearchFile, error) {
	if partial == "" {
		files := make([]methods.SearchFile, 0, len(workspaces))
		for _, workspace := range workspaces {
			files = append(files, virtualWorkspaceFile(workspace))
		}
		return files, nil
	}
	segments := make([]string, len(workspaces))
	for i, workspace := range workspaces {
		segments[i] = workspace.segment
	}
	matches, err := fuzzyFind(ctx, partial, segments, resultLimit)
	if err != nil {
		return nil, err
	}
	files := make([]methods.SearchFile, 0, len(matches))
	for _, match := range matches {
		files = append(files, virtualWorkspaceFile(workspaces[match.index]))
	}
	return files, nil
}

func virtualWorkspaceFile(workspace workspaceSegment) methods.SearchFile {
	isDir := true
	return methods.SearchFile{
		Path:           workspace.folder.Path,
		Name:           matchless(workspace.segment),
		Directory:      matchless("."),
		Workspace:      &methods.SearchFileMatchable{Value: workspace.folder.Name, Score: 0, Indices: []int{}},
		IsDirectory:    isDir,
		NavigationPath: "./" + workspace.segment + "/",
		VirtualKind:    "workspace-folder",
		DisplayPath:    "./" + workspace.segment + "/",
	}
}

func virtualWorkspaceDisplayPath(root string, absolutePath string, segment string, isDirectory bool) string {
	rel, err := filepath.Rel(root, absolutePath)
	if err != nil || rel == "." {
		return "./" + segment + "/"
	}
	display := "./" + segment + "/" + filepath.ToSlash(rel)
	if isDirectory && !strings.HasSuffix(display, "/") {
		display += "/"
	}
	return display
}

func applyVirtualWorkspaceDisplayPaths(listing directoryListing, workspace workspaceSegment) directoryListing {
	root := workspace.folder.Path
	for i, control := range listing.controls {
		if control.Kind == "parent" {
			continue
		}
		listing.controls[i].DisplayPath = virtualWorkspaceDisplayPath(root, control.Path, workspace.segment, true)
	}
	for i, file := range listing.files {
		displayPath := virtualWorkspaceDisplayPath(root, file.Path, workspace.segment, file.IsDirectory)
		listing.files[i].DisplayPath = displayPath
		listing.files[i].Directory = matchless(displayDirectoryPath(displayPath))
	}
	return listing
}
