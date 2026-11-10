package filesearch

import (
	"path/filepath"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const resultLimit = 25

type WorkspaceFolder = methods.SearchFilesWorkspaceFolder

type indexedFile struct {
	path         string
	name         string
	directory    string
	relativePath string
	workspace    string
	isDirectory  bool
}

type rootedPath struct {
	fromBase    string
	basePath    string
	workspace   string
	isDirectory bool
}

type queryMode string

const (
	queryModeAbsolute queryMode = "absolute"
	queryModeUser     queryMode = "user"
	queryModeRelative queryMode = "relative"
	queryModeFuzzy    queryMode = "fuzzy"
)

type classifiedQuery struct {
	mode        queryMode
	bare        string
	quoted      bool
	closedQuote bool
}

type directoryListing struct {
	files    []methods.SearchFile
	controls []methods.SearchFileMenuControl
}

func matchless(value string) methods.SearchFileMatchable {
	return methods.SearchFileMatchable{Value: value, Score: 0, Indices: []int{}}
}

func pathToSearchFile(absolutePath string, isDirectory bool, displayPath string) methods.SearchFile {
	if displayPath == "" {
		displayPath = absolutePath
	}
	return methods.SearchFile{
		Path:        absolutePath,
		Name:        matchless(filepath.Base(stripDisplayPathTrailingSeparators(displayPath))),
		Directory:   matchless(displayDirectoryPath(displayPath)),
		Workspace:   &methods.SearchFileMatchable{Value: "Filesystem", Score: 0, Indices: []int{}},
		IsDirectory: isDirectory,
		DisplayPath: displayPath,
	}
}

func markAsDirectory(value string) string {
	if strings.HasSuffix(value, "/") {
		return value
	}
	return value + "/"
}

func hasTrailingPathSeparator(value string) bool {
	return strings.HasSuffix(value, "/") || strings.HasSuffix(value, "\\")
}

func stripTrailingPathSeparators(value string) string {
	stripped := value
	root := filepath.VolumeName(stripped) + string(filepath.Separator)
	for len(stripped) > len(root) && hasTrailingPathSeparator(stripped) {
		stripped = stripped[:len(stripped)-1]
	}
	return stripped
}

func stripDisplayPathTrailingSeparators(value string) string {
	stripped := value
	for len(stripped) > 1 && hasTrailingPathSeparator(stripped) && !isWindowsDriveRoot(stripped) {
		stripped = stripped[:len(stripped)-1]
	}
	return stripped
}

func isWindowsDriveRoot(value string) bool {
	if len(value) != 3 {
		return false
	}
	return ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) &&
		value[1] == ':' &&
		(value[2] == '/' || value[2] == '\\')
}

func displayDirectoryPath(displayPath string) string {
	stripped := stripDisplayPathTrailingSeparators(displayPath)
	if strings.Contains(stripped, "\\") && !strings.Contains(stripped, "/") {
		return filepath.ToSlash(filepath.Dir(stripped))
	}
	return filepath.ToSlash(filepath.Dir(stripped))
}

func pathContains(root string, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func classifyQuery(query string) classifiedQuery {
	bare := query
	quoted := false
	closedQuote := false
	if strings.HasPrefix(bare, `"`) {
		quoted = true
		bare = strings.TrimPrefix(bare, `"`)
		if strings.HasSuffix(bare, `"`) {
			closedQuote = true
			bare = strings.TrimSuffix(bare, `"`)
		}
	}
	switch {
	case strings.HasPrefix(bare, "/") || isWindowsAbsolute(bare):
		return classifiedQuery{mode: queryModeAbsolute, bare: bare, quoted: quoted, closedQuote: closedQuote}
	case bare == "~" || strings.HasPrefix(bare, "~/") || strings.HasPrefix(bare, "~\\"):
		return classifiedQuery{mode: queryModeUser, bare: bare, quoted: quoted, closedQuote: closedQuote}
	case bare == "." || bare == "./" || bare == ".\\" || strings.HasPrefix(bare, "./") || strings.HasPrefix(bare, ".\\"):
		return classifiedQuery{mode: queryModeRelative, bare: bare, quoted: quoted, closedQuote: closedQuote}
	default:
		return classifiedQuery{mode: queryModeFuzzy, bare: bare, quoted: quoted, closedQuote: closedQuote}
	}
}

func isWindowsAbsolute(value string) bool {
	if len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && (value[2] == '/' || value[2] == '\\') {
		return true
	}
	return strings.HasPrefix(value, `\\`) || strings.HasPrefix(value, `//`)
}

func firstPathSeparatorIndex(value string) int {
	slash := strings.Index(value, "/")
	backslash := strings.Index(value, "\\")
	if slash == -1 {
		return backslash
	}
	if backslash == -1 {
		return slash
	}
	if slash < backslash {
		return slash
	}
	return backslash
}

func workspaceNames(workspaces []WorkspaceFolder) []string {
	if len(workspaces) == 0 {
		return nil
	}
	names := make([]string, 0, len(workspaces))
	for _, workspace := range workspaces {
		names = append(names, workspace.Name)
	}
	return names
}
