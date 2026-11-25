package control

import (
	"context"
	"sort"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/appcontrol"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Tools is the helper surface behind the agents, MCP, and skills
// actions. Each field is the handler the desktop's own JSON-RPC method runs
// (wired in handler.controlTools), so a CLI change takes exactly the path an
// app change takes, including its change notifications.
type Tools struct {
	AgentServers AgentServerTools
	MCPServers   MCPServerTools
	// ListSkills runs camber/listSkills's discovery. Nil workspacePaths means
	// the desktop's own workspace folders, as the app's skill listing uses.
	ListSkills func(workspacePaths []string) []InstalledSkill
}

// AgentServerTools holds the handlers behind camber/acpNav/listAgentServers
// and checkAgentRuntimes and camber/acp/server/restart, and Ops: the shared
// agent-server mutations the desktop's camber/app/* agent methods run.
type AgentServerTools struct {
	List          func(context.Context, *methods.ACPNavListAgentServersParams, *glsp.Context) (methods.ACPNavAgentServersState, error)
	CheckRuntimes func(context.Context, *methods.ACPNavCheckAgentRuntimesParams, *glsp.Context) (methods.ACPNavAgentRuntimesState, error)
	Restart       func(context.Context, *methods.ACPAgentServerParams, *glsp.Context) (*methods.ACPRestartServerOutput, error)
	// Ops is the helper's one agent-server mutation instance: every write
	// (from the desktop or a control action) serializes on its lock.
	Ops *appcontrol.AgentServers
}

// MCPServerTools is the camber/mcpServers/* handler set (mcpservers.Server).
type MCPServerTools interface {
	List(context.Context, *methods.MCPServersListParams, *glsp.Context) (*methods.MCPServersListOutput, error)
	Upsert(context.Context, *methods.MCPServersUpsertParams, *glsp.Context) (*methods.MCPServersUpsertOutput, error)
	Delete(context.Context, *methods.MCPServersDeleteParams, *glsp.Context) (*methods.MCPServersDeleteOutput, error)
	SetEnabled(context.Context, *methods.MCPServersSetEnabledParams, *glsp.Context) (*methods.MCPServersSetEnabledOutput, error)
	Authenticate(context.Context, *methods.MCPServersAuthenticateParams, *glsp.Context) (*methods.MCPServersAuthenticateOutput, error)
	SignOut(context.Context, *methods.MCPServersSignOutParams, *glsp.Context) (*methods.MCPServersSignOutOutput, error)
	TestConnection(context.Context, *methods.MCPServersTestConnectionParams, *glsp.Context) (*methods.MCPServersTestConnectionOutput, error)
	TestConfig(context.Context, *methods.MCPServersTestConfigParams, *glsp.Context) (*methods.MCPServersTestConfigOutput, error)
}

// InstalledSkill is one skill found by camber/listSkills's discovery.
type InstalledSkill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Location is "user" or "workspace"; DirPath is the skill's directory.
	Location string `json:"location"`
	DirPath  string `json:"dirPath,omitempty"`
}

// SetTools installs the handlers the agents-and-tools actions call.
func (s *Service) SetTools(tools Tools) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools = tools
}

// secretRedaction replaces a secret value in action output: key names stay
// visible, values never leave the helper.
const secretRedaction = "[set]"

// requireBypassCaller enforces the agents-and-tools guardrail. Defining
// something the helper will later execute or connect to (an agent command, an
// MCP server command or endpoint), removing one, or loosening permissions
// needs a token-proven caller whose loaded session is in a permission-bypass
// mode right now, the same proof provenDangerousCaller gives chat actions.
func (s *Service) requireBypassCaller(ctx context.Context, caller, what string, g *glsp.Context) error {
	if caller != "" {
		if ref, err := s.view(ctx, caller, g); err == nil && s.provenDangerousCaller(caller, ref) {
			return nil
		}
	}
	return toolsEscalationError(what)
}

func (s *Service) currentTools() Tools {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tools
}

func toolsEscalationError(what string) error {
	return &methods.JSONRPCError{Code: methods.CamberErrorCodeEntityInvalid, Message: "PERMISSION_ESCALATION: " + what + " is only allowed when the request carries --caller-token from a conversation that is running in a permission-bypass mode right now. Pass the callerToken from your Camber host context in such a conversation, or ask the user to make this change in the Camber desktop app."}
}

func redactValues(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for key := range values {
		out[key] = secretRedaction
	}
	return out
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func unavailableTool(name string) error {
	return &methods.JSONRPCError{Code: methods.CamberErrorCodeInternalError, Message: name + " is not available in this helper"}
}
