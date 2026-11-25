package control

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/appcontrol"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Agent actions. Every change runs the shared appcontrol.AgentServers
// operation the desktop's Settings > Agents panel and default pins call
// (camber/app/installAgentServer, removeAgentServer, setDefaultAgentServer,
// setAgentDefaultConfigOption), under the same lock. Each write goes through
// camber/acpNav/setAgentServers, which stops agent subprocesses whose
// configuration changed and broadcasts camber/acpNav/agentServersDidChange,
// so an open desktop re-reads the store.
func init() {
	agent := map[string]any{"type": "string", "description": "Agent server id (see agents list)"}
	registerAction("agents.install", RegisteredAction{
		Summary:     "Install an agent from the ACP registry and enable it, as Settings > Agents does. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: objectSchema(map[string]any{"agentServer": agent}, "agentServer"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a agentServerArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.installAgentServer(ctx, a.AgentServer, caller, g)
		},
	})
	definition := objectSchema(map[string]any{
		"agentServer": agent,
		"command":     map[string]any{"type": "string", "description": "Executable that speaks ACP over stdio"},
		"args":        map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Arguments (replaces the stored list)"},
		"env":         map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "Environment variables to set (merged into the stored ones); values are never echoed"},
		"unsetEnv":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Environment variable names to remove (edit only)"},
	}, "agentServer")
	registerAction("agents.add", RegisteredAction{
		Summary:     "Add a custom agent server definition (an assistant.json entry). Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: definition,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a agentDefinitionArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.defineAgentServer(ctx, a, true, caller, g)
		},
	})
	registerAction("agents.edit", RegisteredAction{
		Summary:     "Change a custom agent server's command, arguments or environment. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: definition,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a agentDefinitionArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.defineAgentServer(ctx, a, false, caller, g)
		},
	})
	registerAction("agents.remove", RegisteredAction{
		Summary:     "Remove (disable) an agent and archive its conversations, as Settings > Agents does. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: objectSchema(map[string]any{"agentServer": agent}, "agentServer"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a agentServerArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.removeAgentServer(ctx, a.AgentServer, caller, g)
		},
	})
	registerAction("agents.default", RegisteredAction{
		Summary: "Pin the default agent for new conversations, or release the pin so the default follows the last used agent.",
		InputSchema: objectSchema(map[string]any{
			"agentServer": agent,
			"unpin":       map[string]any{"type": "boolean", "description": "Release the pin instead (agentServer must be empty)"},
		}),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a agentDefaultArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.setDefaultAgentServer(ctx, a, g)
		},
	})
	registerAction("agents.config.default", RegisteredAction{
		Summary: "Pin an agent's default value for a configuration option (the star in the chat config menus), or unpin it. Pinning a permission-bypass mode needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: objectSchema(map[string]any{
			"agentServer": agent,
			"optionId":    map[string]any{"type": "string", "description": "Option id from agents config options"},
			"value":       map[string]any{"type": "string", "description": "Value to pin (required unless unpin)"},
			"unpin":       map[string]any{"type": "boolean", "description": "Release the pin; the stored default stays unless clearValue"},
			"clearValue":  map[string]any{"type": "boolean", "description": "With unpin, also remove the stored default value"},
		}, "agentServer", "optionId"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a agentConfigDefaultArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.setAgentConfigDefault(ctx, a, caller, g)
		},
	})
	registerAction("agents.restart", RegisteredAction{
		Summary: "Restart an agent's subprocess, as the app's Restart agent does. Refuses while its conversations are working unless force.",
		InputSchema: objectSchema(map[string]any{
			"agentServer": agent,
			"force":       map[string]any{"type": "boolean", "description": "Restart even while conversations are working (their turns are interrupted)"},
		}, "agentServer"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a agentRestartArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.restartAgentServer(ctx, a, g)
		},
	})
	registerAction("agents.runtimes", RegisteredAction{
		Summary: "Report whether the runtimes registry agents launch through (npx) are available.",
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			if err := decodeActionArgs(raw, &struct{}{}); err != nil {
				return nil, err
			}
			tools, err := s.agentServerTools()
			if err != nil {
				return nil, err
			}
			if tools.CheckRuntimes == nil {
				return nil, unavailableTool("agent runtime checks")
			}
			return tools.CheckRuntimes(ctx, &methods.ACPNavCheckAgentRuntimesParams{}, g)
		},
	})
}

const (
	defaultAgentServerName       = "poolside"
	legacyDefaultAgentServerName = "default"
	registryAgentServerType      = "registry"
	customAgentServerType        = "custom"
)

var agentServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

type agentServerArgs struct {
	AgentServer string `json:"agentServer"`
}

type agentDefinitionArgs struct {
	AgentServer string            `json:"agentServer"`
	Command     *string           `json:"command,omitempty"`
	Args        *[]string         `json:"args,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	UnsetEnv    []string          `json:"unsetEnv,omitempty"`
}

type agentDefaultArgs struct {
	AgentServer string `json:"agentServer,omitempty"`
	Unpin       bool   `json:"unpin,omitempty"`
}

type agentConfigDefaultArgs struct {
	AgentServer string `json:"agentServer"`
	OptionID    string `json:"optionId"`
	Value       string `json:"value,omitempty"`
	Unpin       bool   `json:"unpin,omitempty"`
	ClearValue  bool   `json:"clearValue,omitempty"`
}

type agentRestartArgs struct {
	AgentServer string `json:"agentServer"`
	Force       bool   `json:"force,omitempty"`
}

// agentServerSummary is an agent server definition as action output. Env
// values are redacted: they commonly hold API keys.
type agentServerSummary struct {
	ID                   string            `json:"id"`
	Type                 string            `json:"type,omitempty"`
	Command              string            `json:"command,omitempty"`
	Args                 []string          `json:"args,omitempty"`
	Env                  map[string]string `json:"env,omitempty"`
	BinaryTargets        []string          `json:"binaryTargets,omitempty"`
	DefaultConfigOptions map[string]string `json:"defaultConfigOptions,omitempty"`
	PinnedConfigOptions  []string          `json:"pinnedConfigOptions,omitempty"`
	Default              bool              `json:"default,omitempty"`
}

// installAgentServer is the settings panel's install
// (appcontrol.AgentServers.InstallAgentServer), with the agent's
// configuration resolved from the ACP registry.
func (s *Service) installAgentServer(ctx context.Context, name, caller string, g *glsp.Context) (any, error) {
	name, err := editableAgentServerName(name)
	if err != nil {
		return nil, err
	}
	if err = s.requireBypassCaller(ctx, caller, "installing agent "+strconv.Quote(name), g); err != nil {
		return nil, err
	}
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	// Checked before the download too, so a repeat install fails fast.
	current, err := tools.List(ctx, &methods.ACPNavListAgentServersParams{}, g)
	if err != nil {
		return nil, err
	}
	if _, exists := current.AgentServers[name]; exists {
		return nil, pkgerrors.Errorf("agent %q is already installed", name)
	}
	installed, err := tools.Ops.InstallAgentServer(ctx, &methods.AppInstallAgentServerParams{AgentServer: name}, g)
	if errors.Is(err, appcontrol.ErrAgentServerExists) {
		return nil, pkgerrors.Errorf("agent %q is already installed", name)
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{"agentServer": name, "installed": true, "agent": summarizeAgentServer(name, installed.State.AgentServers[name], installed.State.DefaultAgentServer)}
	if installed.Config.Command == "npx" && tools.CheckRuntimes != nil {
		if runtimes, rtErr := tools.CheckRuntimes(ctx, &methods.ACPNavCheckAgentRuntimesParams{}, g); rtErr == nil && !runtimes.NPX.Available {
			out["warning"] = "npx was not found on the agent environment's PATH; install Node.js before starting this agent"
		}
	}
	return out, nil
}

// defineAgentServer adds or edits a custom agent server: the assistant.json
// entry the settings panel's custom section points users at.
func (s *Service) defineAgentServer(ctx context.Context, a agentDefinitionArgs, add bool, caller string, g *glsp.Context) (any, error) {
	name, err := editableAgentServerName(a.AgentServer)
	if err != nil {
		return nil, err
	}
	if add && (a.Command == nil || strings.TrimSpace(*a.Command) == "") {
		return nil, pkgerrors.Errorf("command is required")
	}
	if add && len(a.UnsetEnv) > 0 {
		return nil, pkgerrors.Errorf("unsetEnv only applies to agents edit")
	}
	if !add && a.Command == nil && a.Args == nil && len(a.Env) == 0 && len(a.UnsetEnv) == 0 {
		return nil, pkgerrors.Errorf("command, args, env or unsetEnv is required")
	}
	verb := "editing"
	if add {
		verb = "adding"
	}
	if err = s.requireBypassCaller(ctx, caller, verb+" agent "+strconv.Quote(name), g); err != nil {
		return nil, err
	}
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	saved, err := tools.Ops.Edit(ctx, func(_ methods.ACPNavAgentServersState, params *methods.ACPNavSetAgentServersParams) error {
		cfg, exists := params.AgentServers[name]
		switch {
		case add && exists:
			return pkgerrors.Errorf("agent %q already exists; use agents edit", name)
		case !add && !exists:
			return pkgerrors.Errorf("agent %q is not configured", name)
		case !add && cfg.Type != customAgentServerType && cfg.Type != "":
			return pkgerrors.Errorf("agent %q is a %s agent; only custom agents can be edited", name, cfg.Type)
		}
		if add {
			cfg = methods.ACPAgentServerConfig{Type: customAgentServerType}
		}
		if a.Command != nil {
			cfg.Command = strings.TrimSpace(*a.Command)
			if cfg.Command == "" {
				return pkgerrors.Errorf("command cannot be empty")
			}
		}
		if a.Args != nil {
			cfg.Args = append([]string(nil), (*a.Args)...)
		}
		if len(a.Env) > 0 || len(a.UnsetEnv) > 0 {
			env := map[string]string{}
			for key, value := range cfg.Env {
				env[key] = value
			}
			for key, value := range a.Env {
				if strings.TrimSpace(key) == "" {
					return pkgerrors.Errorf("environment variable names cannot be empty")
				}
				env[key] = value
			}
			for _, key := range a.UnsetEnv {
				delete(env, key)
			}
			cfg.Env = env
			if len(env) == 0 {
				cfg.Env = nil
			}
		}
		params.AgentServers[name] = cfg
		return nil
	}, g)
	if err != nil {
		return nil, err
	}
	return map[string]any{"agentServer": name, "agent": summarizeAgentServer(name, saved.AgentServers[name], saved.DefaultAgentServer)}, nil
}

// removeAgentServer is the settings panel's disable
// (appcontrol.AgentServers.RemoveAgentServer): drop the agent, then archive
// its conversations.
func (s *Service) removeAgentServer(ctx context.Context, name, caller string, g *glsp.Context) (any, error) {
	name, err := editableAgentServerName(name)
	if err != nil {
		return nil, err
	}
	if err = s.requireBypassCaller(ctx, caller, "removing agent "+strconv.Quote(name), g); err != nil {
		return nil, err
	}
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	removed, err := tools.Ops.RemoveAgentServer(ctx, &methods.AppRemoveAgentServerParams{AgentServer: name}, g)
	if err != nil {
		return nil, err
	}
	archived := make([]string, 0, len(removed.Archived))
	for _, c := range removed.Archived {
		archived = append(archived, c.ConversationID)
	}
	out := map[string]any{"agentServer": name, "removed": true, "archivedConversations": archived}
	if removed.ArchiveError != "" {
		out["archiveError"] = removed.ArchiveError
	}
	return out, nil
}

// setDefaultAgentServer is the chat menus' default-agent pin and unpin
// (appcontrol.AgentServers.SetDefaultAgentServer).
func (s *Service) setDefaultAgentServer(ctx context.Context, a agentDefaultArgs, g *glsp.Context) (any, error) {
	name := strings.TrimSpace(a.AgentServer)
	if a.Unpin == (name != "") {
		return nil, pkgerrors.Errorf("pass agentServer to pin a default agent, or unpin alone to release the pin")
	}
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	pinned := !a.Unpin
	saved, err := tools.Ops.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: name, Pinned: &pinned}, g)
	if err != nil {
		return nil, err
	}
	return map[string]any{"defaultAgentServer": saved.State.DefaultAgentServer, "pinned": saved.State.DefaultAgentServerPinned}, nil
}

// setAgentConfigDefault is the chat config menus' star
// (appcontrol.AgentServers.SetAgentDefaultConfigOption): the pin and the
// default value land in one write. The value is judged against the agent's
// schema by value and display name, as chat config set judges selections,
// and pinning a permission-bypass value needs a bypass caller. That guard is
// the CLI's alone: the desktop pins whatever the user starred.
func (s *Service) setAgentConfigDefault(ctx context.Context, a agentConfigDefaultArgs, caller string, g *glsp.Context) (any, error) {
	name := normalizeAgentServerID(a.AgentServer)
	optionID := strings.TrimSpace(a.OptionID)
	if strings.TrimSpace(a.AgentServer) == "" || optionID == "" {
		return nil, pkgerrors.Errorf("agentServer and optionId are required")
	}
	if a.Unpin && a.Value != "" {
		return nil, pkgerrors.Errorf("value does not apply with unpin")
	}
	if !a.Unpin && a.ClearValue {
		return nil, pkgerrors.Errorf("clearValue only applies with unpin")
	}
	if !a.Unpin {
		if a.Value == "" {
			return nil, pkgerrors.Errorf("value is required")
		}
		displayName, err := s.agentOptionValueName(ctx, name, optionID, a.Value, g)
		if err != nil {
			return nil, err
		}
		if isDangerousModeValue(a.Value) || isDangerousModeValue(displayName) {
			if err = s.requireBypassCaller(ctx, caller, "pinning "+bypassModeText(a.Value)+" as a default", g); err != nil {
				return nil, err
			}
		}
	}
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	pinned := !a.Unpin
	saved, err := tools.Ops.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: name, OptionID: optionID, Value: a.Value, Pinned: &pinned, ClearValue: a.ClearValue}, g)
	if err != nil {
		return nil, err
	}
	if !saved.Applied {
		return nil, pkgerrors.Errorf("agent %q is not configured", name)
	}
	cfg := saved.State.AgentServers[name]
	return map[string]any{"agentServer": name, "defaultConfigOptions": cfg.DefaultConfigOptions, "pinnedConfigOptions": cfg.PinnedConfigOptions}, nil
}

// restartAgentServer is AgentRepository.restart: stop the subprocess through
// camber/acp/server/restart. The helper's serverDidExit notification makes an
// open desktop drop its connection and mark that agent's sessions for
// restore, as its own restart does. Like the app's Restart agent, it waits
// for working conversations unless forced.
func (s *Service) restartAgentServer(ctx context.Context, a agentRestartArgs, g *glsp.Context) (any, error) {
	if strings.TrimSpace(a.AgentServer) == "" {
		return nil, pkgerrors.Errorf("agentServer is required")
	}
	name := normalizeAgentServerID(a.AgentServer)
	tools, err := s.agentServerTools()
	if err != nil {
		return nil, err
	}
	if tools.Restart == nil {
		return nil, unavailableTool("agent restart")
	}
	current, err := tools.List(ctx, &methods.ACPNavListAgentServersParams{}, g)
	if err != nil {
		return nil, err
	}
	if _, exists := current.AgentServers[name]; !exists {
		return nil, pkgerrors.Errorf("agent %q is not configured", name)
	}
	if !a.Force {
		state, listErr := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
		if listErr != nil {
			return nil, listErr
		}
		for _, c := range state.Conversations {
			if !c.Archived && normalizeAgentServerID(c.AgentServer) == name && c.LiveStatus != nil && c.LiveStatus.Working {
				return nil, pkgerrors.Errorf("agent %q has working conversations (for example %s); wait for them to finish, or pass force to interrupt them", name, c.ID)
			}
		}
	}
	if _, err = tools.Restart(ctx, &methods.ACPAgentServerParams{AgentServer: name}, g); err != nil {
		return nil, err
	}
	return map[string]any{"agentServer": name, "restarted": true}, nil
}

func (s *Service) agentServerTools() (AgentServerTools, error) {
	tools := s.currentTools().AgentServers
	if tools.List == nil || tools.Ops == nil {
		return tools, unavailableTool("agent server configuration")
	}
	return tools, nil
}

// agentOptionValueName validates value against the agent's configuration
// schema (the cached one the app keeps, else a fresh probe) and returns its
// display name.
func (s *Service) agentOptionValueName(ctx context.Context, agentServer, optionID, value string, g *glsp.Context) (string, error) {
	var options, modes json.RawMessage
	if cache, err := s.nav.GetConfigCache(ctx, &methods.ACPNavGetConfigCacheParams{AgentServer: agentServer}, g); err == nil && cache.Entry != nil {
		options, modes = cache.Entry.ConfigOptions, cache.Entry.Modes
	} else {
		probed, probeErr := s.probe(ctx, Args{AgentServer: agentServer}, g)
		if probeErr != nil {
			return "", pkgerrors.Wrapf(probeErr, "reading agent %q configuration options", agentServer)
		}
		if result, ok := probed.(map[string]any); ok {
			options, _ = result["configOptions"].(json.RawMessage)
			modes, _ = result["modes"].(json.RawMessage)
		}
	}
	for _, o := range parseOptions(options) {
		if o.ID != optionID {
			continue
		}
		if o.Type == "boolean" {
			if value != "true" && value != "false" {
				return "", pkgerrors.Errorf("option %s takes true or false", optionID)
			}
			return value, nil
		}
		name, found := optionEntryName(o.Options, value)
		if !found {
			return "", pkgerrors.Errorf("unsupported value %q for option %s (see agents config options)", value, optionID)
		}
		return name, nil
	}
	if optionID == "mode" {
		var legacy struct {
			Available []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"availableModes"`
		}
		_ = json.Unmarshal(modes, &legacy)
		for _, m := range legacy.Available {
			if m.ID == value {
				return m.Name, nil
			}
		}
	}
	return "", pkgerrors.Errorf("agent %q does not offer option %s with value %q (see agents config options)", agentServer, optionID, value)
}

// editableAgentServerName validates an agent id an action may install, define
// or remove. The Poolside agent is managed by the app.
func editableAgentServerName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", pkgerrors.Errorf("agentServer is required")
	}
	if !agentServerNamePattern.MatchString(name) {
		return "", pkgerrors.Errorf("agent id %q may only contain letters, digits, '.', '_' and '-'", name)
	}
	if normalized := normalizeAgentServerID(name); normalized == defaultAgentServerName {
		return "", pkgerrors.Errorf("agent %q is managed by the app; update it from Settings > Agents", normalized)
	}
	return name, nil
}

// normalizeAgentServerID maps the legacy and empty ids to the default agent,
// as the helper's stores do.
func normalizeAgentServerID(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == legacyDefaultAgentServerName {
		return defaultAgentServerName
	}
	return name
}

func summarizeAgentServer(name string, cfg methods.ACPAgentServerConfig, defaultAgentServer string) agentServerSummary {
	return agentServerSummary{
		ID:                   name,
		Type:                 cfg.Type,
		Command:              cfg.Command,
		Args:                 cfg.Args,
		Env:                  redactValues(cfg.Env),
		BinaryTargets:        sortedKeys(cfg.Binary),
		DefaultConfigOptions: cfg.DefaultConfigOptions,
		PinnedConfigOptions:  cfg.PinnedConfigOptions,
		Default:              normalizeAgentServerID(defaultAgentServer) == name,
	}
}
