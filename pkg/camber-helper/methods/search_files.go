package methods

type SearchFilesParams struct {
	Query                             string                       `json:"query"`
	Workspaces                        []SearchFilesWorkspaceFolder `json:"workspaces,omitempty"`
	ExcludeOpenFilesOutsideWorkspaces bool                         `json:"excludeOpenFilesOutsideWorkspaces,omitempty"`
}

func (p SearchFilesParams) MethodName() string {
	return "camber/searchFiles"
}

func (p SearchFilesParams) Description() string {
	return "searches workspace and filesystem paths for the file picker"
}

type SearchFilesWorkspaceFolder struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Index int    `json:"index"`
}

type SearchFilesOutput struct {
	Workspaces []string                `json:"workspaces,omitempty"`
	Files      []SearchFile            `json:"files"`
	Controls   []SearchFileMenuControl `json:"controls,omitempty"`
}

type SearchFileMenuControl struct {
	Kind        string `json:"kind" enum:"parent,current"`
	Path        string `json:"path,omitempty"`
	DisplayPath string `json:"displayPath,omitempty"`
}

type SearchFileMatchable struct {
	Value   string `json:"value"`
	Score   int    `json:"score"`
	Indices []int  `json:"indices"`
}

type SearchFile struct {
	Path           string               `json:"path"`
	Name           SearchFileMatchable  `json:"name"`
	Directory      SearchFileMatchable  `json:"directory"`
	Workspace      *SearchFileMatchable `json:"workspace,omitempty"`
	IsDirectory    bool                 `json:"isDirectory,omitempty"`
	NavigationPath string               `json:"navigationPath,omitempty"`
	VirtualKind    string               `json:"virtualKind,omitempty" enum:"workspace-folder"`
	Score          int                  `json:"score,omitempty"`
	DisplayPath    string               `json:"displayPath,omitempty"`
}
