package control

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// MCP connector actions. They call the camber/mcpServers/* handlers the
// desktop's Connectors settings use; every mutation there broadcasts
// camber/mcpServers/didChange, on which an open desktop re-lists the store and
// re-injects the connector set into its live agent sessions.
func init() {
	name := map[string]any{"type": "string", "description": "Connector name (see mcp list)"}
	nameOnly := objectSchema(map[string]any{"name": name}, "name")
	entry := map[string]any{
		"name":              name,
		"command":           map[string]any{"type": "string", "description": "stdio: executable to launch"},
		"args":              map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "stdio: arguments (replaces the stored list)"},
		"env":               map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "stdio: environment to set (merged on edit); values are secret and never echoed"},
		"unsetEnv":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "edit: environment variable names to remove"},
		"url":               map[string]any{"type": "string", "description": "http: endpoint (https, or http on loopback)"},
		"headers":           map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "http: headers to set (merged on edit); values are secret and never echoed"},
		"unsetHeaders":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "edit: header names to remove"},
		"authMode":          map[string]any{"type": "string", "enum": []string{"none", "bearer", "oauth"}, "description": "http: authentication"},
		"bearerToken":       map[string]any{"type": "string", "description": "http: bearer token (authMode bearer); never echoed"},
		"oauthScopes":       map[string]any{"type": "string"},
		"oauthClientId":     map[string]any{"type": "string"},
		"oauthCallbackPort": map[string]any{"type": "integer"},
		"oauthDeepLink":     map[string]any{"type": "boolean"},
		"skipTest":          map[string]any{"type": "boolean", "description": "add: save without the connection test the app requires for non-OAuth connectors"},
	}
	registerAction("mcp.list", RegisteredAction{
		Summary: "List the user's MCP connectors. Environment, header and token values are redacted.",
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			if err := decodeActionArgs(raw, &struct{}{}); err != nil {
				return nil, err
			}
			return s.listMCPServers(ctx, g)
		},
	})
	registerAction("mcp.add", RegisteredAction{
		Summary:     "Add an MCP connector, as the Add connector form does (non-OAuth connectors must pass a connection test first). Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: objectSchema(entry, "name"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a mcpServerArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.addMCPServer(ctx, a, caller, g)
		},
	})
	registerAction("mcp.edit", RegisteredAction{
		Summary:     "Change an MCP connector's command, endpoint, headers, environment or authentication. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: objectSchema(entry, "name"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a mcpServerArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.editMCPServer(ctx, a, caller, g)
		},
	})
	registerAction("mcp.remove", RegisteredAction{
		Summary:     "Delete an MCP connector and its stored sign-in. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: nameOnly,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a mcpNameArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.removeMCPServer(ctx, a.Name, caller, g)
		},
	})
	for action, enabled := range map[string]bool{"mcp.enable": true, "mcp.disable": false} {
		summary := "Enable a configured MCP connector for new and live sessions."
		if !enabled {
			summary = "Disable a configured MCP connector for new and live sessions."
		}
		registerAction(action, RegisteredAction{
			Summary:     summary,
			InputSchema: nameOnly,
			Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
				var a mcpNameArgs
				if err := decodeActionArgs(raw, &a); err != nil {
					return nil, err
				}
				return s.setMCPServerEnabled(ctx, a.Name, enabled, g)
			},
		})
	}
	registerAction("mcp.test", RegisteredAction{
		Summary:     "Probe a configured MCP connector and report its tools, as its Test connection menu item does.",
		InputSchema: nameOnly,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a mcpNameArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			tools, err := s.mcpTools()
			if err != nil {
				return nil, err
			}
			if _, err = s.findMCPServer(ctx, tools, a.Name, g); err != nil {
				return nil, err
			}
			return tools.TestConnection(ctx, &methods.MCPServersTestConnectionParams{Name: a.Name}, g)
		},
	})
	registerAction("mcp.signIn", RegisteredAction{
		Summary:     "Start an OAuth connector's sign-in: the desktop opens the provider's page in the browser and the call returns once the user finishes. Needs --caller-token from a conversation live in a permission-bypass mode.",
		InputSchema: nameOnly,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
			var a mcpNameArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.signInMCPServer(ctx, a.Name, caller, g)
		},
	})
	registerAction("mcp.signOut", RegisteredAction{
		Summary:     "Sign out of an OAuth connector (delete its stored tokens).",
		InputSchema: nameOnly,
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a mcpNameArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			tools, err := s.mcpTools()
			if err != nil {
				return nil, err
			}
			if _, err = tools.SignOut(ctx, &methods.MCPServersSignOutParams{Name: a.Name}, g); err != nil {
				return nil, err
			}
			return map[string]any{"name": a.Name, "signedOut": true}, nil
		},
	})
}

// The form's other authentication modes; the helper names only OAuth.
const (
	mcpAuthModeNone   methods.MCPServerAuthMode = "none"
	mcpAuthModeBearer methods.MCPServerAuthMode = "bearer"
)

// mcpServerNamePattern is the Add connector form's name rule.
var mcpServerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`)

type mcpNameArgs struct {
	Name string `json:"name"`
}

type mcpServerArgs struct {
	Name              string            `json:"name"`
	Command           *string           `json:"command,omitempty"`
	Args              *[]string         `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	UnsetEnv          []string          `json:"unsetEnv,omitempty"`
	URL               *string           `json:"url,omitempty"`
	Headers           map[string]string `json:"headers,omitempty"`
	UnsetHeaders      []string          `json:"unsetHeaders,omitempty"`
	AuthMode          *string           `json:"authMode,omitempty"`
	BearerToken       *string           `json:"bearerToken,omitempty"`
	OAuthScopes       *string           `json:"oauthScopes,omitempty"`
	OAuthClientID     *string           `json:"oauthClientId,omitempty"`
	OAuthCallbackPort *int              `json:"oauthCallbackPort,omitempty"`
	OAuthDeepLink     *bool             `json:"oauthDeepLink,omitempty"`
	SkipTest          bool              `json:"skipTest,omitempty"`
}

// mcpServerSummary is a connector as action output: secret values (env,
// headers, bearer token) are reduced to "[set]".
type mcpServerSummary struct {
	Name               string            `json:"name"`
	Enabled            bool              `json:"enabled"`
	Transport          string            `json:"transport"`
	Command            string            `json:"command,omitempty"`
	Args               []string          `json:"args,omitempty"`
	Env                map[string]string `json:"env,omitempty"`
	URL                string            `json:"url,omitempty"`
	Headers            map[string]string `json:"headers,omitempty"`
	BearerToken        string            `json:"bearerToken,omitempty"`
	AuthMode           string            `json:"authMode,omitempty"`
	OAuthScopes        string            `json:"oauthScopes,omitempty"`
	OAuthClientID      string            `json:"oauthClientId,omitempty"`
	OAuthCallbackPort  int               `json:"oauthCallbackPort,omitempty"`
	OAuthDeepLink      bool              `json:"oauthDeepLink,omitempty"`
	OAuthAuthenticated *bool             `json:"oauthAuthenticated,omitempty"`
	BuiltinID          string            `json:"builtinID,omitempty"`
}

func (s *Service) listMCPServers(ctx context.Context, g *glsp.Context) (any, error) {
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	list, err := tools.List(ctx, &methods.MCPServersListParams{}, g)
	if err != nil {
		return nil, err
	}
	servers := []mcpServerSummary{}
	for _, entry := range list.Servers {
		servers = append(servers, summarizeMCPServer(entry))
	}
	return map[string]any{"servers": servers}, nil
}

// addMCPServer is McpServerForm's submit: refuse an existing name, require a
// passing camber/mcpServers/testConfig probe for non-OAuth connectors, then
// upsert. An OAuth connector is saved unauthenticated; sign in next.
func (s *Service) addMCPServer(ctx context.Context, a mcpServerArgs, caller string, g *glsp.Context) (any, error) {
	if len(a.UnsetEnv) > 0 || len(a.UnsetHeaders) > 0 {
		return nil, pkgerrors.Errorf("unsetEnv and unsetHeaders only apply to mcp edit")
	}
	entry := methods.MCPServerEntry{Name: strings.TrimSpace(a.Name), Enabled: true}
	if err := applyMCPServerArgs(&entry, a); err != nil {
		return nil, err
	}
	if err := validateMCPServerForm(entry); err != nil {
		return nil, err
	}
	if err := s.requireBypassCaller(ctx, caller, "adding MCP connector "+strconv.Quote(entry.Name), g); err != nil {
		return nil, err
	}
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	list, err := tools.List(ctx, &methods.MCPServersListParams{}, g)
	if err != nil {
		return nil, err
	}
	for _, existing := range list.Servers {
		if existing.Name == entry.Name {
			return nil, pkgerrors.Errorf("a connector named %q already exists; use mcp edit", entry.Name)
		}
	}
	out := map[string]any{"name": entry.Name}
	if entry.AuthMode != methods.MCPServerAuthModeOAuth && !a.SkipTest {
		test, testErr := tools.TestConfig(ctx, &methods.MCPServersTestConfigParams{Server: entry}, g)
		if testErr != nil {
			return nil, testErr
		}
		if !test.OK {
			message := test.Error
			if message == "" {
				message = "could not connect to this server"
			}
			return nil, pkgerrors.Errorf("connection test failed: %s (fix the configuration, or pass skipTest to save it anyway)", message)
		}
		out["test"] = test
	}
	if _, err = tools.Upsert(ctx, &methods.MCPServersUpsertParams{Server: entry}, g); err != nil {
		return nil, err
	}
	out["server"] = summarizeMCPServer(entry)
	if entry.AuthMode == methods.MCPServerAuthModeOAuth {
		out["next"] = "sign in with mcp sign-in, or from the desktop's Connectors settings"
	}
	return out, nil
}

// editMCPServer merges changes into a stored connector and upserts it. The
// stored secrets stay unless replaced, so they never have to be re-entered.
func (s *Service) editMCPServer(ctx context.Context, a mcpServerArgs, caller string, g *glsp.Context) (any, error) {
	if a.SkipTest {
		return nil, pkgerrors.Errorf("skipTest only applies to mcp add; run mcp test after editing")
	}
	if err := s.requireBypassCaller(ctx, caller, "editing MCP connector "+strconv.Quote(a.Name), g); err != nil {
		return nil, err
	}
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	stored, err := s.findMCPServer(ctx, tools, a.Name, g)
	if err != nil {
		return nil, err
	}
	entry := stored
	entry.OAuthAuthenticated = nil
	if err = applyMCPServerArgs(&entry, a); err != nil {
		return nil, err
	}
	if err = validateMCPServerForm(entry); err != nil {
		return nil, err
	}
	if _, err = tools.Upsert(ctx, &methods.MCPServersUpsertParams{Server: entry}, g); err != nil {
		return nil, err
	}
	return map[string]any{"name": entry.Name, "server": summarizeMCPServer(entry)}, nil
}

func (s *Service) removeMCPServer(ctx context.Context, name, caller string, g *glsp.Context) (any, error) {
	if err := s.requireBypassCaller(ctx, caller, "removing MCP connector "+strconv.Quote(name), g); err != nil {
		return nil, err
	}
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	if _, err = s.findMCPServer(ctx, tools, name, g); err != nil {
		return nil, err
	}
	if _, err = tools.Delete(ctx, &methods.MCPServersDeleteParams{Name: name}, g); err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "removed": true}, nil
}

func (s *Service) setMCPServerEnabled(ctx context.Context, name string, enabled bool, g *glsp.Context) (any, error) {
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	if _, err = s.findMCPServer(ctx, tools, name, g); err != nil {
		return nil, err
	}
	if _, err = tools.SetEnabled(ctx, &methods.MCPServersSetEnabledParams{Name: name, Enabled: enabled}, g); err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "enabled": enabled}, nil
}

// signInMCPServer runs camber/mcpServers/authenticate over the desktop's
// connection: the helper sends the provider URL to the desktop, which opens
// it in the browser, and returns once the callback lands.
func (s *Service) signInMCPServer(ctx context.Context, name, caller string, g *glsp.Context) (any, error) {
	if err := s.requireBypassCaller(ctx, caller, "signing in to MCP connector "+strconv.Quote(name), g); err != nil {
		return nil, err
	}
	tools, err := s.mcpTools()
	if err != nil {
		return nil, err
	}
	entry, err := s.findMCPServer(ctx, tools, name, g)
	if err != nil {
		return nil, err
	}
	if entry.AuthMode != methods.MCPServerAuthModeOAuth {
		return nil, pkgerrors.Errorf("connector %q does not use OAuth sign-in", name)
	}
	if g == nil || g.Notify == nil {
		return nil, pkgerrors.Errorf("sign in to %q from the Camber desktop app: this request has no desktop connection to open the browser", name)
	}
	if _, err = tools.Authenticate(ctx, &methods.MCPServersAuthenticateParams{Name: name}, g); err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "signedIn": true}, nil
}

func (s *Service) mcpTools() (MCPServerTools, error) {
	tools := s.currentTools().MCPServers
	if tools == nil {
		return nil, unavailableTool("MCP connector management")
	}
	return tools, nil
}

// findMCPServer returns the stored entry, secrets included; callers must
// summarize it before returning it.
func (s *Service) findMCPServer(ctx context.Context, tools MCPServerTools, name string, g *glsp.Context) (methods.MCPServerEntry, error) {
	if strings.TrimSpace(name) == "" {
		return methods.MCPServerEntry{}, pkgerrors.Errorf("name is required")
	}
	list, err := tools.List(ctx, &methods.MCPServersListParams{}, g)
	if err != nil {
		return methods.MCPServerEntry{}, err
	}
	for _, entry := range list.Servers {
		if entry.Name == name {
			return entry, nil
		}
	}
	return methods.MCPServerEntry{}, pkgerrors.Errorf("no MCP connector named %q (see mcp list)", name)
}

// applyMCPServerArgs applies the given fields. Setting a command switches the
// entry to stdio and setting a URL switches it to http, clearing the other
// transport's fields as the form's buildEntry does.
func applyMCPServerArgs(entry *methods.MCPServerEntry, a mcpServerArgs) error {
	if a.Command != nil && a.URL != nil {
		return pkgerrors.Errorf("pass command (stdio) or url (http), not both")
	}
	if a.Command != nil {
		entry.Command = strings.TrimSpace(*a.Command)
		entry.URL, entry.Headers, entry.BearerToken = "", nil, ""
		entry.AuthMode, entry.OAuthScopes, entry.OAuthClientID, entry.OAuthCallbackPort, entry.OAuthDeepLink = "", "", "", 0, false
	}
	if a.URL != nil {
		entry.URL = strings.TrimSpace(*a.URL)
		entry.Command, entry.Args, entry.Env = "", nil, nil
	}
	stdio := entry.Command != ""
	if a.Args != nil {
		if !stdio {
			return pkgerrors.Errorf("args apply to stdio connectors")
		}
		entry.Args = append([]string(nil), (*a.Args)...)
	}
	if len(a.Env) > 0 || len(a.UnsetEnv) > 0 {
		if !stdio {
			return pkgerrors.Errorf("env applies to stdio connectors")
		}
		entry.Env = mergeValues(entry.Env, a.Env, a.UnsetEnv)
	}
	httpFields := len(a.Headers) > 0 || len(a.UnsetHeaders) > 0 || a.AuthMode != nil || a.BearerToken != nil || a.OAuthScopes != nil || a.OAuthClientID != nil || a.OAuthCallbackPort != nil || a.OAuthDeepLink != nil
	if httpFields && entry.URL == "" {
		return pkgerrors.Errorf("headers and authentication apply to http connectors")
	}
	if len(a.Headers) > 0 || len(a.UnsetHeaders) > 0 {
		entry.Headers = mergeValues(entry.Headers, a.Headers, a.UnsetHeaders)
	}
	if a.AuthMode != nil {
		entry.AuthMode = methods.MCPServerAuthMode(strings.TrimSpace(*a.AuthMode))
	}
	if a.BearerToken != nil {
		entry.BearerToken = strings.TrimSpace(*a.BearerToken)
	}
	if a.OAuthScopes != nil {
		entry.OAuthScopes = strings.TrimSpace(*a.OAuthScopes)
	}
	if a.OAuthClientID != nil {
		entry.OAuthClientID = strings.TrimSpace(*a.OAuthClientID)
	}
	if a.OAuthCallbackPort != nil {
		entry.OAuthCallbackPort = *a.OAuthCallbackPort
	}
	if a.OAuthDeepLink != nil {
		entry.OAuthDeepLink = *a.OAuthDeepLink
	}
	if entry.URL != "" && entry.AuthMode == "" {
		entry.AuthMode = mcpAuthModeNone
	}
	// The form only keeps credentials for the chosen authentication.
	if entry.AuthMode != mcpAuthModeBearer {
		entry.BearerToken = ""
	}
	if entry.AuthMode != methods.MCPServerAuthModeOAuth {
		entry.OAuthScopes, entry.OAuthClientID, entry.OAuthCallbackPort, entry.OAuthDeepLink = "", "", 0, false
	}
	return nil
}

// validateMCPServerForm is McpServerForm's validate; the helper's Upsert adds
// URL and OAuth checks of its own.
func validateMCPServerForm(entry methods.MCPServerEntry) error {
	if entry.Name == "" {
		return pkgerrors.Errorf("name is required")
	}
	if !mcpServerNamePattern.MatchString(entry.Name) {
		return pkgerrors.Errorf("name may only contain letters, digits, _ and -")
	}
	if entry.Command == "" && entry.URL == "" {
		return pkgerrors.Errorf("a command (stdio) or url (http) is required")
	}
	switch entry.AuthMode {
	case "", mcpAuthModeNone, mcpAuthModeBearer, methods.MCPServerAuthModeOAuth:
	default:
		return pkgerrors.Errorf("authMode must be none, bearer or oauth")
	}
	if entry.AuthMode == mcpAuthModeBearer && entry.BearerToken == "" {
		return pkgerrors.Errorf("bearerToken is required with authMode bearer")
	}
	return nil
}

func mergeValues(current, set map[string]string, unset []string) map[string]string {
	out := map[string]string{}
	for key, value := range current {
		out[key] = value
	}
	for key, value := range set {
		out[key] = value
	}
	for _, key := range unset {
		delete(out, key)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func summarizeMCPServer(entry methods.MCPServerEntry) mcpServerSummary {
	summary := mcpServerSummary{
		Name:               entry.Name,
		Enabled:            entry.Enabled,
		Transport:          "stdio",
		Command:            entry.Command,
		Args:               entry.Args,
		Env:                redactValues(entry.Env),
		URL:                entry.URL,
		Headers:            redactValues(entry.Headers),
		AuthMode:           string(entry.AuthMode),
		OAuthScopes:        entry.OAuthScopes,
		OAuthClientID:      entry.OAuthClientID,
		OAuthCallbackPort:  entry.OAuthCallbackPort,
		OAuthDeepLink:      entry.OAuthDeepLink,
		OAuthAuthenticated: entry.OAuthAuthenticated,
		BuiltinID:          entry.BuiltinID,
	}
	if entry.URL != "" {
		summary.Transport = "http"
	}
	if entry.BearerToken != "" {
		summary.BearerToken = secretRedaction
	}
	return summary
}
