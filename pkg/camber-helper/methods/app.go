package methods

// App methods carry the desktop's conversation-management operations that do
// not depend on UI state, so the desktop UI and the camber control CLI run the
// same helper code for them.
const appMethodPrefix = "camber/app/"

const (
	AppArchiveConversationMethod = appMethodPrefix + "archiveConversation"
	AppRenameConversationMethod  = appMethodPrefix + "renameConversation"
	AppDeleteConversationMethod  = appMethodPrefix + "deleteConversation"

	AppSetDefaultAgentServerMethod       = appMethodPrefix + "setDefaultAgentServer"
	AppSetAgentDefaultConfigOptionMethod = appMethodPrefix + "setAgentDefaultConfigOption"
	AppInstallAgentServerMethod          = appMethodPrefix + "installAgentServer"
	AppRemoveAgentServerMethod           = appMethodPrefix + "removeAgentServer"
)

// AppArchiveConversationParams selects the conversation to archive, as
// acpNav/archiveConversation does: by id, else by agent session.
type AppArchiveConversationParams struct {
	WorkspacePath  string `json:"workspacePath"`
	ConversationID string `json:"conversationId,omitempty"`
	AgentServer    string `json:"agentServer"`
	SessionID      string `json:"sessionId,omitempty"`
}

// AppArchiveConversationOutput is the navigation state after the archive and
// what it archived.
type AppArchiveConversationOutput struct {
	State ACPNavState `json:"state"`
	// Archived lists the conversations the request selected.
	Archived []string `json:"archived"`
	// Descendants lists the sub-agents archived with them (those rendered
	// under them in the same sidebar group).
	Descendants []string `json:"descendants"`
}

type AppRenameConversationParams struct {
	ConversationID string `json:"conversationId"`
	Name           string `json:"name" doc:"New conversation name; surrounding whitespace is trimmed"`
}

type AppDeleteConversationParams struct {
	ConversationID string `json:"conversationId"`
	// AgentServer and SessionID name the agent session to delete; an empty
	// SessionID with an AgentServer deletes no session. When both are empty
	// the conversation's recorded session is used.
	AgentServer string `json:"agentServer,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	// CancelInFlight cancels a running turn before deleting the session.
	CancelInFlight bool `json:"cancelInFlight,omitempty"`
}

// AppSetDefaultAgentServerParams writes the default agent and its pin.
type AppSetDefaultAgentServerParams struct {
	// AgentServer becomes the default agent; empty leaves the stored default
	// (only valid with Pinned false, to release the pin).
	AgentServer string `json:"agentServer,omitempty"`
	// Pinned true pins AgentServer as the default, false releases the pin.
	// Absent marks a last-used follow, skipped while the default is pinned.
	Pinned *bool `json:"pinned,omitempty"`
}

// AppSetAgentDefaultConfigOptionParams writes an agent's default value for
// one configuration option and its pin.
type AppSetAgentDefaultConfigOptionParams struct {
	AgentServer string `json:"agentServer"`
	OptionID    string `json:"optionId"`
	// Value is the default value; required unless Pinned is false.
	Value string `json:"value,omitempty"`
	// Pinned true pins Value, false releases the pin. Absent marks a last-used
	// follow, skipped while the option is pinned.
	Pinned *bool `json:"pinned,omitempty"`
	// ClearValue, with Pinned false, also removes the stored default value.
	ClearValue bool `json:"clearValue,omitempty"`
}

// AppAgentServersOutput is the agent server store after a mutation. Applied
// is false when the mutation was skipped (a last-used follow over a pin, or
// an agent that is not configured) and State is the unchanged store.
type AppAgentServersOutput struct {
	State   ACPNavAgentServersState `json:"state"`
	Applied bool                    `json:"applied"`
}

// AppInstallAgentServerParams installs an agent from the ACP registry.
type AppInstallAgentServerParams struct {
	AgentServer string `json:"agentServer"`
	// Config is the registry configuration to install; absent resolves it
	// from the ACP registry.
	Config *ACPAgentServerConfig `json:"config,omitempty"`
}

type AppInstallAgentServerOutput struct {
	State ACPNavAgentServersState `json:"state"`
	// Config is the configuration that was installed.
	Config ACPAgentServerConfig `json:"config"`
}

type AppRemoveAgentServerParams struct {
	AgentServer string `json:"agentServer"`
}

// AppRemoveAgentServerOutput is the agent server store after the removal and
// the conversations archived with the agent.
type AppRemoveAgentServerOutput struct {
	State    ACPNavAgentServersState   `json:"state"`
	Archived []AppArchivedConversation `json:"archived"`
	// NavState is the navigation state after the last archive; absent when
	// the agent had no conversations.
	NavState *ACPNavState `json:"navState,omitempty"`
	// ArchiveError reports a failed archive. The agent is removed regardless;
	// the conversations listed in Archived were archived before it.
	ArchiveError string `json:"archiveError,omitempty"`
}

type AppArchivedConversation struct {
	ConversationID string `json:"conversationId"`
	AgentServer    string `json:"agentServer"`
	SessionID      string `json:"sessionId,omitempty"`
}

// DesktopApp methods are helper -> desktop requests for operations that need
// the desktop window's own state (selection, terminals). The desktop webview
// answers them by running the same functions its UI uses.
const desktopAppMethodPrefix = "camber/desktopApp/"

const (
	DesktopAppOpenConversationMethod = desktopAppMethodPrefix + "openConversation"
	DesktopAppRemoveProjectMethod    = desktopAppMethodPrefix + "removeProject"
)

type DesktopAppOpenConversationParams struct {
	ConversationID string `json:"conversationId"`
}

type DesktopAppRemoveProjectParams struct {
	Path string `json:"path"`
}

type DesktopAppOutput struct{}
