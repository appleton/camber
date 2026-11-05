package methods

import "encoding/json"

const acpNavMethodPrefix = "camber/acpNav/"

const (
	ACPNavListMethod                       = acpNavMethodPrefix + "list"
	ACPNavCreateChatMethod                 = acpNavMethodPrefix + "createChat"
	ACPNavUpsertProjectMethod              = acpNavMethodPrefix + "upsertProject"
	ACPNavRenameProjectMethod              = acpNavMethodPrefix + "renameProject"
	ACPNavSetProjectCollapsedMethod        = acpNavMethodPrefix + "setProjectCollapsed"
	ACPNavReorderProjectsMethod            = acpNavMethodPrefix + "reorderProjects"
	ACPNavReorderWorktreesMethod           = acpNavMethodPrefix + "reorderWorktrees"
	ACPNavGetProjectSettingsMethod         = acpNavMethodPrefix + "getProjectSettings"
	ACPNavSetProjectSettingsMethod         = acpNavMethodPrefix + "setProjectSettings"
	ACPNavPrepareWorktreeMethod            = acpNavMethodPrefix + "prepareWorktree"
	ACPNavReleasePreparedWorktreeMethod    = acpNavMethodPrefix + "releasePreparedWorktree"
	ACPNavCreateWorktreeMethod             = acpNavMethodPrefix + "createWorktree"
	ACPNavRemoveProjectMethod              = acpNavMethodPrefix + "removeProject"
	ACPNavRemoveWorktreeMethod             = acpNavMethodPrefix + "removeWorktree"
	ACPNavRenameConversationMethod         = acpNavMethodPrefix + "renameConversation"
	ACPNavUpsertConversationMethod         = acpNavMethodPrefix + "upsertConversation"
	ACPNavPrepareConversationHandoffMethod = acpNavMethodPrefix + "prepareConversationHandoff"
	ACPNavAbortConversationHandoffMethod   = acpNavMethodPrefix + "abortConversationHandoff"
	ACPNavGetConversationHistoryMethod     = acpNavMethodPrefix + "getConversationHistory"
	ACPNavRestoreConversationMethod        = acpNavMethodPrefix + "restoreConversation"
	ACPNavArchiveConversationMethod        = acpNavMethodPrefix + "archiveConversation"
	ACPNavDeleteConversationMethod         = acpNavMethodPrefix + "deleteConversation"
	ACPNavListAgentServersMethod           = acpNavMethodPrefix + "listAgentServers"
	ACPNavCheckAgentRuntimesMethod         = acpNavMethodPrefix + "checkAgentRuntimes"
	ACPNavInstallAgentServerMethod         = acpNavMethodPrefix + "installAgentServer"
	ACPNavSetAgentServersMethod            = acpNavMethodPrefix + "setAgentServers"
	ACPNavGetConfigCacheMethod             = acpNavMethodPrefix + "getConfigCache"
	ACPNavUpsertConfigCacheMethod          = acpNavMethodPrefix + "upsertConfigCache"
	ACPNavSetConversationViewStateMethod   = acpNavMethodPrefix + "setConversationViewState"
	ACPNavGetFileOpenerMethod              = acpNavMethodPrefix + "getFileOpener"
	ACPNavSetFileOpenerMethod              = acpNavMethodPrefix + "setFileOpener"
	ACPNavGetKeybindingsMethod             = acpNavMethodPrefix + "getKeybindings"
	ACPNavSetKeybindingsMethod             = acpNavMethodPrefix + "setKeybindings"
	ACPNavGetGithubColorModeMethod         = acpNavMethodPrefix + "getGithubColorMode"
	ACPNavSetGithubColorModeMethod         = acpNavMethodPrefix + "setGithubColorMode"
	ACPNavDidChangeMethod                  = acpNavMethodPrefix + "didChange"
)

type ACPNavProject struct {
	Path           string  `json:"path"`
	Name           string  `json:"name"`
	Nickname       string  `json:"nickname,omitempty"`
	IsWorktree     bool    `json:"isWorktree"`
	ParentPath     *string `json:"parentPath,omitempty"`
	Collapsed      bool    `json:"collapsed"`
	DisplayOrder   int     `json:"displayOrder"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
	SetupScript    string  `json:"setupScript,omitempty"`
	TeardownScript string  `json:"teardownScript,omitempty"`
	UserPrompt     string  `json:"userPrompt,omitempty"`
}

type ACPNavConversation struct {
	ID                 string                        `json:"id"`
	WorkspacePath      string                        `json:"workspacePath"`
	AgentServer        string                        `json:"agentServer"`
	SessionID          string                        `json:"sessionId,omitempty"`
	Cwd                string                        `json:"cwd"`
	Title              string                        `json:"title,omitempty"`
	Nickname           string                        `json:"nickname,omitempty"`
	UpdatedAt          string                        `json:"updatedAt,omitempty"`
	Active             bool                          `json:"active"`
	Archived           bool                          `json:"archived"`
	WorkingDirectories []string                      `json:"workingDirectories"`
	Metadata           json.RawMessage               `json:"metadata,omitempty"`
	LiveStatus         *ACPNavConversationLiveStatus `json:"liveStatus,omitempty"`
	// ParentID and RootID are set for conversations spawned as children through
	// the control CLI. They are read from control state, not stored by clients.
	ParentID string `json:"parentId,omitempty"`
	RootID   string `json:"rootId,omitempty"`
}

type ACPNavState struct {
	Projects      []ACPNavProject      `json:"projects"`
	Conversations []ACPNavConversation `json:"conversations"`
}

type ACPNavConversationLiveStatus struct {
	Working        bool `json:"working"`
	WaitingForUser bool `json:"waitingForUser"`
	Unread         bool `json:"unread"`
}

type ACPAgentServerConfig struct {
	Type                 string                                      `json:"type,omitempty"`
	Command              string                                      `json:"command,omitempty"`
	Args                 []string                                    `json:"args,omitempty"`
	Env                  map[string]string                           `json:"env,omitempty"`
	Binary               map[string]ACPAgentServerBinaryDistribution `json:"binary,omitempty"`
	DefaultConfigOptions map[string]string                           `json:"default_config_options,omitempty"`
	// PinnedConfigOptions lists config option ids whose default value in
	// DefaultConfigOptions was explicitly pinned by the user. Clients skip
	// automatic default updates (such as last-used tracking) for pinned ids.
	PinnedConfigOptions []string `json:"pinned_config_options,omitempty"`
}

type ACPAgentServerBinaryDistribution struct {
	Archive string            `json:"archive"`
	SHA256  string            `json:"sha256,omitempty"`
	Cmd     string            `json:"cmd"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type ACPAgentServers map[string]ACPAgentServerConfig

type ACPNavAgentServersState struct {
	AgentServers       ACPAgentServers `json:"agentServers"`
	DefaultAgentServer string          `json:"defaultAgentServer,omitempty"`
	// DefaultAgentServerPinned reports whether the default agent server choice
	// itself was explicitly pinned by the user, so clients skip automatic
	// default updates (such as last-used tracking) for the choice.
	DefaultAgentServerPinned bool `json:"default_agent_server_pinned,omitempty"`
}

type ACPNavConfigCacheEntry struct {
	AgentServer       string          `json:"agentServer"`
	ConfigOptions     json.RawMessage `json:"configOptions"`
	Modes             json.RawMessage `json:"modes"`
	AvailableCommands json.RawMessage `json:"availableCommands"`
	// PromptCapabilities is the agent's initialize-time promptCapabilities
	// (image / embeddedContext / audio). Cached so the client knows what kinds
	// of content a prompt may carry without re-connecting to the agent.
	PromptCapabilities json.RawMessage `json:"promptCapabilities,omitempty"`
	// AgentInfo is the agent's initialize-time implementation info. Cached so
	// the client can show the installed agent version without re-connecting.
	AgentInfo json.RawMessage `json:"agentInfo,omitempty"`
	CachedAt  string          `json:"cachedAt"`
}

type ACPNavConfigCacheState struct {
	Entry *ACPNavConfigCacheEntry `json:"entry,omitempty"`
}

type ACPNavListParams struct{}

type ACPNavCreateChatParams struct {
	SessionID string `json:"sessionId"`
}

type ACPNavCreateChatOutput struct {
	Path string `json:"path"`
}

type ACPNavUpsertProjectParams struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	IsWorktree bool    `json:"isWorktree"`
	ParentPath *string `json:"parentPath,omitempty"`
}

type ACPNavSetProjectCollapsedParams struct {
	Path      string `json:"path"`
	Collapsed bool   `json:"collapsed"`
}

type ACPNavRenameProjectParams struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type ACPNavReorderProjectsParams struct {
	Paths []string `json:"paths"`
}

type ACPNavReorderWorktreesParams struct {
	ParentPath string   `json:"parentPath"`
	Paths      []string `json:"paths"`
}

type ACPNavProjectSettings struct {
	Path           string `json:"path"`
	SetupScript    string `json:"setupScript"`
	TeardownScript string `json:"teardownScript"`
	UserPrompt     string `json:"userPrompt"`
}

type ACPNavGetProjectSettingsParams struct {
	Path string `json:"path"`
}

type ACPNavProjectSettingsState struct {
	Settings ACPNavProjectSettings `json:"settings"`
}

type ACPNavSetProjectSettingsParams struct {
	Path           string `json:"path"`
	SetupScript    string `json:"setupScript"`
	TeardownScript string `json:"teardownScript"`
	UserPrompt     string `json:"userPrompt"`
}

type ACPNavCreateWorktreeParams struct {
	ProjectPath  string `json:"projectPath"`
	WorktreeName string `json:"worktreeName"`
}

type ACPNavPrepareWorktreeParams struct {
	ProjectPath string `json:"projectPath"`
}

type ACPNavReleasePreparedWorktreeParams struct {
	Path string `json:"path"`
}

type ACPNavReleasePreparedWorktreeOutput struct{}

type ACPNavRemoveProjectParams struct {
	Path string `json:"path"`
}

type ACPNavRemoveWorktreeParams struct {
	Path string `json:"path"`
}

type ACPNavRenameConversationParams struct {
	ConversationID string `json:"conversationId"`
	Nickname       string `json:"nickname"`
	Title          string `json:"title,omitempty"`
}

type ACPNavUpsertConversationParams struct {
	Conversation ACPNavConversation `json:"conversation"`
}

type ACPNavConversationLeg struct {
	HandoffID         string          `json:"handoffId"`
	Ordinal           int             `json:"ordinal"`
	AgentServer       string          `json:"agentServer"`
	SessionID         string          `json:"sessionId"`
	TargetAgentServer string          `json:"targetAgentServer"`
	TargetSessionID   string          `json:"targetSessionId"`
	SchemaVersion     int             `json:"schemaVersion"`
	Events            json.RawMessage `json:"events"`
	Turns             json.RawMessage `json:"turns"`
	Plan              json.RawMessage `json:"plan"`
	CreatedAt         string          `json:"createdAt"`
}

type ACPNavPrepareConversationHandoffParams struct {
	HandoffID         string          `json:"handoffId"`
	ConversationID    string          `json:"conversationId"`
	SourceAgentServer string          `json:"sourceAgentServer"`
	SourceSessionID   string          `json:"sourceSessionId"`
	TargetAgentServer string          `json:"targetAgentServer"`
	Events            json.RawMessage `json:"events"`
	Turns             json.RawMessage `json:"turns"`
	Plan              json.RawMessage `json:"plan"`
	CreatedAt         string          `json:"createdAt"`
}

type ACPNavAbortConversationHandoffParams struct {
	HandoffID string `json:"handoffId"`
}

type ACPNavGetConversationHistoryParams struct {
	ConversationID string `json:"conversationId"`
}

type ACPNavConversationHistory struct {
	Legs []ACPNavConversationLeg `json:"legs"`
}

type ACPNavConversationHandoffOutput struct{}

type ACPNavRestoreConversationParams struct {
	Conversation ACPNavConversation `json:"conversation"`
}

type ACPNavArchiveConversationParams struct {
	WorkspacePath  string `json:"workspacePath"`
	ConversationID string `json:"conversationId,omitempty"`
	AgentServer    string `json:"agentServer"`
	SessionID      string `json:"sessionId,omitempty"`
}

type ACPNavDeleteConversationParams struct {
	ConversationID string `json:"conversationId,omitempty"`
	AgentServer    string `json:"agentServer,omitempty"`
	SessionID      string `json:"sessionId,omitempty"`
}

type ACPNavListAgentServersParams struct{}

type ACPNavCheckAgentRuntimesParams struct{}

// ACPNavAgentRuntimesState reports whether the runtimes registry agent
// distributions launch through are available on this machine, so the
// marketplace can warn before an install instead of failing on first launch.
type ACPNavAgentRuntimesState struct {
	NPX ACPNavAgentRuntimeStatus `json:"npx"`
}

type ACPNavAgentRuntimeStatus struct {
	Available bool `json:"available"`
	// Path is the resolved executable path when available.
	Path string `json:"path,omitempty"`
}

type ACPNavInstallAgentServerParams struct {
	AgentServer string               `json:"agentServer"`
	Config      ACPAgentServerConfig `json:"config"`
}

type ACPNavInstallAgentServerOutput struct {
	Installed bool `json:"installed"`
}

type ACPNavSetAgentServersParams struct {
	AgentServers       ACPAgentServers `json:"agentServers"`
	DefaultAgentServer *string         `json:"defaultAgentServer,omitempty"`
	// DefaultAgentServerPinned pins or unpins the default agent server choice.
	// Like DefaultAgentServer, it is only written when present: a set that
	// omits it preserves the stored pinned flag.
	DefaultAgentServerPinned *bool `json:"default_agent_server_pinned,omitempty"`
}

type ACPNavGetConfigCacheParams struct {
	AgentServer string `json:"agentServer"`
}

type ACPNavUpsertConfigCacheParams struct {
	AgentServer        string          `json:"agentServer"`
	ConfigOptions      json.RawMessage `json:"configOptions"`
	Modes              json.RawMessage `json:"modes"`
	AvailableCommands  json.RawMessage `json:"availableCommands"`
	PromptCapabilities json.RawMessage `json:"promptCapabilities,omitempty"`
	AgentInfo          json.RawMessage `json:"agentInfo,omitempty"`
}

type ACPNavSetConversationViewStateParams struct {
	AgentServer string `json:"agentServer"`
	SessionID   string `json:"sessionId"`
	Active      bool   `json:"active"`
	// Reset drops every view-state entry this client connection reported
	// before applying the update. Surfaces whose view resets without a
	// disconnect (a desktop webview reload) send it on their first report so
	// sessions left open before the reload stop counting as watched.
	Reset bool `json:"reset,omitempty"`
}

type ACPNavGetFileOpenerParams struct{}

type ACPNavSetFileOpenerParams struct {
	FileOpener string `json:"fileOpener"`
}

// ACPNavFileOpenerState carries the user's preferred desktop file opener (the
// app used to open files and projects). An empty FileOpener means no explicit
// choice has been made and the client should fall back to its platform default.
type ACPNavFileOpenerState struct {
	FileOpener string `json:"fileOpener"`
}

type ACPNavGetGithubColorModeParams struct{}

type ACPNavSetGithubColorModeParams struct {
	ColorMode string `json:"colorMode"`
}

// ACPNavGithubColorModeState carries the user's worktree status color mode
// ("checks" or "review"). An empty ColorMode means no explicit choice has been
// made and the client should fall back to its default.
type ACPNavGithubColorModeState struct {
	ColorMode string `json:"colorMode"`
}

type ACPNavGetKeybindingsParams struct{}

type ACPNavSetKeybindingsParams struct {
	Keybindings ACPNavKeybindings `json:"keybindings"`
}

// ACPNavKeybindings maps a command id to the user's chord override. A nil value
// (JSON null) means the command is explicitly unbound; an absent key means no
// override (the client falls back to its registry default).
type ACPNavKeybindings map[string]*string

// ACPNavKeybindingsState carries the user's desktop keyboard-shortcut overrides.
// An empty map means no overrides have been persisted.
type ACPNavKeybindingsState struct {
	Keybindings ACPNavKeybindings `json:"keybindings"`
}

type ACPNavDidChangeParams struct {
	State ACPNavState `json:"state"`
}

func (p ACPNavDidChangeParams) MethodName() string {
	return ACPNavDidChangeMethod
}
