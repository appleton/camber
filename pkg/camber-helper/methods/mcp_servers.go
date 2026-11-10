package methods

// MCPServerAuthMode describes how secrets are stored for an MCP server.
type MCPServerAuthMode string

const (
	MCPServerAuthModeOAuth MCPServerAuthMode = "oauth"
)

// MCPServerEntry is the wire representation for a single user MCP server.
// Transport is implied: Command non-empty ⇒ stdio; URL non-empty ⇒ http.
type MCPServerEntry struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`

	// stdio
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`

	// http
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	BearerToken string            `json:"bearerToken,omitempty"`

	// auth
	AuthMode          MCPServerAuthMode `json:"authMode,omitempty"`
	OAuthScopes       string            `json:"oauthScopes,omitempty"`
	OAuthClientID     string            `json:"oauthClientId,omitempty"`
	OAuthCallbackPort int               `json:"oauthCallbackPort,omitempty"`
	// OAuthDeepLink opts the server into the camber://oauth/callback redirect
	// when the client can receive OS deep links (the desktop app). The deep-link
	// redirect URI must be registered with the OAuth provider. Hosts without
	// deep-link support fall back to the loopback callback (OAuthCallbackPort
	// for pre-registered clients).
	OAuthDeepLink bool `json:"oauthDeepLink,omitempty"`
	// OAuthAuthenticated reports whether a stored OAuth token exists for the
	// server. Computed on list responses only (never persisted, ignored on
	// upsert); nil for non-OAuth servers and on helpers that predate it.
	OAuthAuthenticated *bool `json:"oauthAuthenticated,omitempty"`

	// provenance
	BuiltinID string `json:"builtinID,omitempty"`
}

// MCPServerStatus describes per-session availability of a server for a given agent.
type MCPServerStatus struct {
	ServerName string `json:"serverName"`
	// reason is non-empty when the server cannot be injected
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// --- camber/mcpServers/list ---

type MCPServersListParams struct{}

func (p MCPServersListParams) MethodName() string { return "camber/mcpServers/list" }

type MCPServersListOutput struct {
	Servers []MCPServerEntry `json:"servers"`
}

// --- camber/mcpServers/upsert ---

type MCPServersUpsertParams struct {
	Server MCPServerEntry `json:"server"`
}

func (p MCPServersUpsertParams) MethodName() string { return "camber/mcpServers/upsert" }

type MCPServersUpsertOutput struct{}

// --- camber/mcpServers/delete ---

type MCPServersDeleteParams struct {
	Name string `json:"name"`
}

func (p MCPServersDeleteParams) MethodName() string { return "camber/mcpServers/delete" }

type MCPServersDeleteOutput struct{}

// --- camber/mcpServers/setEnabled ---

type MCPServersSetEnabledParams struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func (p MCPServersSetEnabledParams) MethodName() string { return "camber/mcpServers/setEnabled" }

type MCPServersSetEnabledOutput struct{}

// --- camber/mcpServers/authenticate ---

type MCPServersAuthenticateParams struct {
	Name string `json:"name"`
}

func (p MCPServersAuthenticateParams) MethodName() string {
	return "camber/mcpServers/authenticate"
}

type MCPServersAuthenticateOutput struct{}

// --- camber/mcpServers/signOut ---

type MCPServersSignOutParams struct {
	Name string `json:"name"`
}

func (p MCPServersSignOutParams) MethodName() string { return "camber/mcpServers/signOut" }

type MCPServersSignOutOutput struct{}

// --- camber/mcpServers/testConnection ---

type MCPServersTestConnectionParams struct {
	Name string `json:"name"`
}

func (p MCPServersTestConnectionParams) MethodName() string {
	return "camber/mcpServers/testConnection"
}

type MCPServersTestConnectionOutput struct {
	OK        bool     `json:"ok"`
	ToolCount int      `json:"toolCount"`
	ToolNames []string `json:"toolNames,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// --- camber/mcpServers/setPoolServerDisabled ---

// MCPServersSetPoolServerDisabledParams sets the disabled flag for a pool/agent
// MCP server in the user-global camber settings, so it applies across all
// workspaces (rather than the agent's default workspace-local scope).
type MCPServersSetPoolServerDisabledParams struct {
	ServerName string `json:"serverName"`
	Disabled   bool   `json:"disabled"`
}

func (p MCPServersSetPoolServerDisabledParams) MethodName() string {
	return "camber/mcpServers/setPoolServerDisabled"
}

type MCPServersSetPoolServerDisabledOutput struct{}

// --- camber/mcpServers/testConfig ---

// MCPServersTestConfigParams probes an inline server config that has not been
// saved yet. Used to validate a connector before adding it.
type MCPServersTestConfigParams struct {
	Server MCPServerEntry `json:"server"`
}

func (p MCPServersTestConfigParams) MethodName() string {
	return "camber/mcpServers/testConfig"
}

type MCPServersTestConfigOutput = MCPServersTestConnectionOutput

// --- camber/mcpServers/sessionResolved (helper notification) ---

type MCPServersSessionResolvedParams struct {
	AgentServer string            `json:"agentServer"`
	SessionID   string            `json:"sessionId"`
	Injected    []MCPServerStatus `json:"injected"`
	Unavailable []MCPServerStatus `json:"unavailable"`
}

func (p MCPServersSessionResolvedParams) MethodName() string {
	return "camber/mcpServers/sessionResolved"
}

// --- camber/mcpServers/didChange (helper notification) ---

// MCPServersDidChangeParams is broadcast to every surface (primary + remotes)
// after the user's MCP connector store mutates (upsert/delete/toggle/sign-in/
// sign-out). The store is shared on disk across helper instances but change
// listeners are in-memory per client, so without this push a connector changed
// on one surface never reaches live sessions hosted by another. The payload is
// empty: receivers re-list the store, which keeps coalesced or reordered
// notifications idempotent.
type MCPServersDidChangeParams struct{}

func (p MCPServersDidChangeParams) MethodName() string {
	return "camber/mcpServers/didChange"
}
