package appcontrol

import (
	"context"
	"slices"
	"strings"
	"sync"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// AgentServers runs the desktop's agent-server mutations (Settings > Agents
// install and disable, the default-agent pin, per-option default pins and the
// last-used follows) for both the desktop UI, through camber/app/* methods,
// and the camber control CLI's agents actions. Each mutation is one
// read-modify-write of the whole agent map, so they serialize on one lock:
// two writers can never drop each other's change.
type AgentServers struct {
	mu            sync.Mutex
	store         AgentServerStore
	conversations *Service
}

// AgentServerStore is the helper surface the agent-server mutations write
// through: the handlers behind camber/acpNav/listAgentServers,
// setAgentServers (which stops changed agent subprocesses and broadcasts
// camber/acpNav/agentServersDidChange) and installAgentServer.
type AgentServerStore struct {
	List    func(context.Context, *methods.ACPNavListAgentServersParams, *glsp.Context) (methods.ACPNavAgentServersState, error)
	Set     func(context.Context, *methods.ACPNavSetAgentServersParams, *glsp.Context) (methods.ACPNavAgentServersState, error)
	Install func(context.Context, *methods.ACPNavInstallAgentServerParams, *glsp.Context) (methods.ACPNavInstallAgentServerOutput, error)
	// ResolveRegistry resolves an agent's configuration from the ACP registry
	// for installs that do not carry one.
	ResolveRegistry func(context.Context, string) (methods.ACPAgentServerConfig, error)
}

// NewAgentServers builds the agent-server mutations. conversations archives a
// removed agent's conversations.
func NewAgentServers(store AgentServerStore, conversations *Service) *AgentServers {
	return &AgentServers{store: store, conversations: conversations}
}

// ErrAgentServerExists reports an install of an agent already in the map.
var ErrAgentServerExists = pkgerrors.New("agent is already installed")

// registryAgentServerType marks agents installed from the ACP registry.
const registryAgentServerType = "registry"

// SetDefaultAgentServer writes the default agent and its pin. Pinned true
// pins AgentServer; Pinned false releases the pin (and, with AgentServer,
// also moves the default). Without Pinned the write is the last-used follow:
// it is skipped (Applied false) while the store's default is pinned, so a
// window with a stale pin mirror cannot move a pinned default. The default
// must be a configured agent or the built-in Poolside agent.
func (a *AgentServers) SetDefaultAgentServer(ctx context.Context, params *methods.AppSetDefaultAgentServerParams, g *glsp.Context) (methods.AppAgentServersOutput, error) {
	name := strings.TrimSpace(params.AgentServer)
	if name != "" {
		name = acpproxy.NormalizeAgentServerName(name)
	}
	if name == "" && params.Pinned == nil {
		return methods.AppAgentServersOutput{}, pkgerrors.New("agentServer or pinned is required")
	}
	if name == "" && *params.Pinned {
		return methods.AppAgentServersOutput{}, pkgerrors.New("agentServer is required to pin a default agent")
	}
	return a.edit(ctx, g, func(state methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) (bool, error) {
		if params.Pinned == nil && state.DefaultAgentServerPinned {
			return false, nil
		}
		if name != "" {
			if _, exists := set.AgentServers[name]; !exists && name != acpproxy.DefaultAgentServerName {
				return false, pkgerrors.Errorf("agent %q is not configured", name)
			}
			set.DefaultAgentServer = &name
		}
		if params.Pinned != nil {
			pinned := *params.Pinned
			set.DefaultAgentServerPinned = &pinned
		}
		return true, nil
	})
}

// SetAgentDefaultConfigOption writes an agent's default value for one
// configuration option and its pin, in one write. Pinned true pins Value;
// Pinned false releases the pin, keeping the stored value unless ClearValue.
// Without Pinned the write is the last-used follow: Value becomes the default
// unless the option is pinned in the store (Applied false). An agent that is
// not configured is left alone (Applied false); the built-in Poolside agent
// always counts as configured.
//
// No permission check happens here: the desktop pins whatever the user
// starred. The camber CLI guards permission-bypass values itself.
func (a *AgentServers) SetAgentDefaultConfigOption(ctx context.Context, params *methods.AppSetAgentDefaultConfigOptionParams, g *glsp.Context) (methods.AppAgentServersOutput, error) {
	optionID := strings.TrimSpace(params.OptionID)
	if optionID == "" {
		return methods.AppAgentServersOutput{}, pkgerrors.New("optionId is required")
	}
	pin := params.Pinned != nil && *params.Pinned
	unpin := params.Pinned != nil && !*params.Pinned
	if !unpin && params.Value == "" {
		return methods.AppAgentServersOutput{}, pkgerrors.New("value is required")
	}
	if unpin && params.Value != "" {
		return methods.AppAgentServersOutput{}, pkgerrors.New("value does not apply when unpinning")
	}
	if !unpin && params.ClearValue {
		return methods.AppAgentServersOutput{}, pkgerrors.New("clearValue only applies when unpinning")
	}
	name := acpproxy.NormalizeAgentServerName(strings.TrimSpace(params.AgentServer))
	return a.edit(ctx, g, func(_ methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) (bool, error) {
		cfg, exists := set.AgentServers[name]
		if !exists && name != acpproxy.DefaultAgentServerName {
			return false, nil
		}
		storedPinned := slices.Contains(cfg.PinnedConfigOptions, optionID)
		if params.Pinned == nil && storedPinned {
			return false, nil
		}
		defaults := map[string]string{}
		for key, value := range cfg.DefaultConfigOptions {
			defaults[key] = value
		}
		pinned := append([]string(nil), cfg.PinnedConfigOptions...)
		switch {
		case pin:
			defaults[optionID] = params.Value
			if !storedPinned {
				pinned = append(pinned, optionID)
			}
		case unpin:
			pinned = slices.DeleteFunc(pinned, func(id string) bool { return id == optionID })
			if params.ClearValue {
				delete(defaults, optionID)
			}
		default:
			defaults[optionID] = params.Value
		}
		// Emptied maps and lists are dropped rather than stored empty.
		cfg.DefaultConfigOptions, cfg.PinnedConfigOptions = nil, nil
		if len(defaults) > 0 {
			cfg.DefaultConfigOptions = defaults
		}
		if len(pinned) > 0 {
			cfg.PinnedConfigOptions = pinned
		}
		set.AgentServers[name] = cfg
		return true, nil
	})
}

// InstallAgentServer is Settings > Agents' install: download and record the
// agent (camber/acpNav/installAgentServer), then add it to the agent map.
// Config is the registry entry the caller resolved; without one it is
// resolved from the ACP registry. The download runs outside the lock so a
// slow install never holds up other agent-server writes.
func (a *AgentServers) InstallAgentServer(ctx context.Context, params *methods.AppInstallAgentServerParams, g *glsp.Context) (methods.AppInstallAgentServerOutput, error) {
	name := strings.TrimSpace(params.AgentServer)
	if name == "" {
		return methods.AppInstallAgentServerOutput{}, pkgerrors.New("agentServer is required")
	}
	if a.store.Install == nil {
		return methods.AppInstallAgentServerOutput{}, pkgerrors.New("agent installation is not available in this helper")
	}
	var cfg methods.ACPAgentServerConfig
	if params.Config != nil {
		cfg = *params.Config
	} else {
		if a.store.ResolveRegistry == nil {
			return methods.AppInstallAgentServerOutput{}, pkgerrors.New("the ACP registry is not available in this helper")
		}
		resolved, err := a.store.ResolveRegistry(ctx, name)
		if err != nil {
			return methods.AppInstallAgentServerOutput{}, err
		}
		cfg = resolved
		cfg.Type = registryAgentServerType
	}
	if _, err := a.store.Install(ctx, &methods.ACPNavInstallAgentServerParams{AgentServer: name, Config: cfg}, g); err != nil {
		return methods.AppInstallAgentServerOutput{}, err
	}
	out, err := a.edit(ctx, g, func(_ methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) (bool, error) {
		if _, exists := set.AgentServers[name]; exists {
			return false, pkgerrors.Wrapf(ErrAgentServerExists, "agent %q", name)
		}
		set.AgentServers[name] = cfg
		return true, nil
	})
	if err != nil {
		return methods.AppInstallAgentServerOutput{}, err
	}
	return methods.AppInstallAgentServerOutput{State: out.State, Config: cfg}, nil
}

// RemoveAgentServer is Settings > Agents' disable: drop the agent from the
// map, then archive each of its conversations as the sidebar does
// (ArchiveConversation: the row with the sub-agents under it, then its agent
// session closed, cancelling a running turn). The removal stands even when an
// archive fails; ArchiveError reports it.
func (a *AgentServers) RemoveAgentServer(ctx context.Context, params *methods.AppRemoveAgentServerParams, g *glsp.Context) (methods.AppRemoveAgentServerOutput, error) {
	name := strings.TrimSpace(params.AgentServer)
	if name == "" {
		return methods.AppRemoveAgentServerOutput{}, pkgerrors.New("agentServer is required")
	}
	name = acpproxy.NormalizeAgentServerName(name)
	removed, err := a.edit(ctx, g, func(_ methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) (bool, error) {
		if _, exists := set.AgentServers[name]; !exists {
			return false, pkgerrors.Errorf("agent %q is not configured", name)
		}
		delete(set.AgentServers, name)
		return true, nil
	})
	if err != nil {
		return methods.AppRemoveAgentServerOutput{}, err
	}
	out := methods.AppRemoveAgentServerOutput{State: removed.State, Archived: []methods.AppArchivedConversation{}}
	if err := a.archiveAgentServerConversations(ctx, name, &out, g); err != nil {
		out.ArchiveError = err.Error()
	}
	return out, nil
}

// Edit applies edit to a copy of the stored agent map under the mutation lock
// and writes it back, every other entry (with its default and pinned options)
// exactly as stored. It is the path for agent definitions without a dedicated
// operation (the CLI's custom agents add and edit).
func (a *AgentServers) Edit(ctx context.Context, edit func(methods.ACPNavAgentServersState, *methods.ACPNavSetAgentServersParams) error, g *glsp.Context) (methods.ACPNavAgentServersState, error) {
	out, err := a.edit(ctx, g, func(state methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) (bool, error) {
		return true, edit(state, set)
	})
	return out.State, err
}

// edit is the locked list → modify → set round trip. edit returns false to
// skip the write; the stored state is returned with Applied false.
func (a *AgentServers) edit(ctx context.Context, g *glsp.Context, edit func(methods.ACPNavAgentServersState, *methods.ACPNavSetAgentServersParams) (bool, error)) (methods.AppAgentServersOutput, error) {
	if a.store.List == nil || a.store.Set == nil {
		return methods.AppAgentServersOutput{}, pkgerrors.New("agent server configuration is not available in this helper")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.store.List(ctx, &methods.ACPNavListAgentServersParams{}, g)
	if err != nil {
		return methods.AppAgentServersOutput{}, err
	}
	set := &methods.ACPNavSetAgentServersParams{AgentServers: methods.ACPAgentServers{}}
	for key, cfg := range state.AgentServers {
		set.AgentServers[acpproxy.NormalizeAgentServerName(key)] = cfg
	}
	apply, err := edit(state, set)
	if err != nil {
		return methods.AppAgentServersOutput{}, err
	}
	if !apply {
		return methods.AppAgentServersOutput{State: nonNilAgentServers(state)}, nil
	}
	saved, err := a.store.Set(ctx, set, g)
	if err != nil {
		return methods.AppAgentServersOutput{}, err
	}
	return methods.AppAgentServersOutput{State: nonNilAgentServers(saved), Applied: true}, nil
}

func (a *AgentServers) archiveAgentServerConversations(ctx context.Context, name string, out *methods.AppRemoveAgentServerOutput, g *glsp.Context) error {
	if a.conversations == nil {
		return nil
	}
	state, err := a.conversations.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return err
	}
	byID := map[string]methods.ACPNavConversation{}
	for _, c := range state.Conversations {
		byID[c.ID] = c
	}
	done := map[string]bool{}
	for _, c := range state.Conversations {
		if c.Archived || done[c.ID] || acpproxy.NormalizeAgentServerName(c.AgentServer) != name {
			continue
		}
		archived, err := a.conversations.ArchiveConversation(ctx, &methods.AppArchiveConversationParams{
			WorkspacePath:  c.WorkspacePath,
			ConversationID: c.ID,
			AgentServer:    c.AgentServer,
			SessionID:      c.SessionID,
		}, g)
		if err != nil {
			return err
		}
		navState := archived.State
		out.NavState = &navState
		// The archive cascades to the sub-agents rendered under the
		// conversation; report those too so a client can close their views.
		for _, id := range append(append([]string{c.ID}, archived.Archived...), archived.Descendants...) {
			if done[id] {
				continue
			}
			done[id] = true
			row, ok := byID[id]
			if !ok {
				row = methods.ACPNavConversation{ID: id, AgentServer: c.AgentServer}
			}
			out.Archived = append(out.Archived, methods.AppArchivedConversation{ConversationID: id, AgentServer: acpproxy.NormalizeAgentServerName(row.AgentServer), SessionID: row.SessionID})
		}
	}
	return nil
}

func nonNilAgentServers(state methods.ACPNavAgentServersState) methods.ACPNavAgentServersState {
	if state.AgentServers == nil {
		state.AgentServers = methods.ACPAgentServers{}
	}
	return state
}
