package mcpservers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
)

const (
	connectorsFileName = "connectors.json"
	dirMode            = 0o700
	fileMode           = 0o600
)

// connectorsFile is the on-disk format — standard mcpServers JSON shape.
type connectorsFile struct {
	MCPServers map[string]serverRecord `json:"mcpServers"`
}

// serverRecord is stored as extra fields on the ecosystem-standard server block.
type serverRecord struct {
	// stdlib stdio fields
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// http fields
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	BearerToken string            `json:"bearerToken,omitempty"`
	// camber extras
	Enabled           bool                      `json:"enabled"`
	AuthMode          methods.MCPServerAuthMode `json:"authMode,omitempty"`
	OAuthScopes       string                    `json:"oauthScopes,omitempty"`
	OAuthClientID     string                    `json:"oauthClientId,omitempty"`
	OAuthCallbackPort int                       `json:"oauthCallbackPort,omitempty"`
	OAuthDeepLink     bool                      `json:"oauthDeepLink,omitempty"`
	BuiltinID         string                    `json:"builtinID,omitempty"`
}

// defaultPath puts connectors.json in the user config dir, next to assistant.json
// (~/.config/camber/connectors.json), so all user-authored config lives in one
// place. It stays a separate 0600 file (not merged into assistant.json) because it
// can hold tokens and assistant.json is world-readable (0644).
func defaultPath() string {
	return userconfig.CamberConfigFile(connectorsFileName)
}

// Store provides atomic read/write access to connectors.json.
type Store struct {
	mu   sync.RWMutex
	path string
}

func NewStore() *Store {
	return &Store{path: defaultPath()}
}

// Path returns the connectors file location, for external-change watching.
func (s *Store) Path() string {
	return s.path
}

func (s *Store) load() (*connectorsFile, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return &connectorsFile{MCPServers: map[string]serverRecord{}}, nil
		}
		return nil, fmt.Errorf("mcpservers: read %s: %w", s.path, err)
	}
	var f connectorsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mcpservers: parse %s: %w", s.path, err)
	}
	if f.MCPServers == nil {
		f.MCPServers = map[string]serverRecord{}
	}
	return &f, nil
}

func (s *Store) save(f *connectorsFile) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("mcpservers: mkdir %s: %w", dir, err)
	}

	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("mcpservers: serialize: %w", err)
	}

	if err := atomicWriteFile(s.path, data, fileMode); err != nil {
		return fmt.Errorf("mcpservers: save %s: %w", s.path, err)
	}
	return nil
}

// atomicWriteFile writes data to path via a temp file in the same directory
// followed by a rename, so a crash mid-write can't leave a truncated or corrupt
// file. The parent directory must already exist.
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()

	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("chmod temp: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("rename to %s: %w", path, err)
	}
	return nil
}

// List returns all stored servers sorted by name, so the UI render order stays
// stable across reloads (Go map iteration order is randomized).
func (s *Store) List() ([]methods.MCPServerEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	f, err := s.load()
	if err != nil {
		return nil, err
	}
	out := make([]methods.MCPServerEntry, 0, len(f.MCPServers))
	for name, rec := range f.MCPServers {
		out = append(out, recordToEntry(name, rec))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Upsert adds or replaces a server by name. Name is sanitized before storage.
func (s *Store) Upsert(entry methods.MCPServerEntry) error {
	name, err := sanitizeName(entry.Name)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	f, err := s.load()
	if err != nil {
		return err
	}
	f.MCPServers[name] = entryToRecord(entry)
	return s.save(f)
}

// Delete removes a server by name. Not-found is not an error.
func (s *Store) Delete(name string) error {
	sanitized, err := sanitizeName(name)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	f, err := s.load()
	if err != nil {
		return err
	}
	delete(f.MCPServers, sanitized)
	return s.save(f)
}

// SetEnabled enables or disables a server.
func (s *Store) SetEnabled(name string, enabled bool) error {
	sanitized, err := sanitizeName(name)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	f, err := s.load()
	if err != nil {
		return err
	}
	rec, ok := f.MCPServers[sanitized]
	if !ok {
		return fmt.Errorf("mcpservers: server %q not found", name)
	}
	rec.Enabled = enabled
	f.MCPServers[sanitized] = rec
	return s.save(f)
}

// Get returns a single server by name.
func (s *Store) Get(name string) (*methods.MCPServerEntry, error) {
	sanitized, err := sanitizeName(name)
	if err != nil {
		return nil, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	f, err := s.load()
	if err != nil {
		return nil, err
	}
	rec, ok := f.MCPServers[sanitized]
	if !ok {
		return nil, nil
	}
	e := recordToEntry(sanitized, rec)
	return &e, nil
}

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`)

// sanitizeName validates and normalises a server name.
// Server names are the ACP server name and the connectors.json map key.
func sanitizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("mcpservers: server name must not be empty")
	}
	if !namePattern.MatchString(name) {
		return "", fmt.Errorf("mcpservers: server name %q must contain only letters, digits, hyphens, or underscores", name)
	}
	return name, nil
}

func recordToEntry(name string, rec serverRecord) methods.MCPServerEntry {
	// Migrate catalog Slack installs persisted before the deep-link redirect:
	// they carry a loopback callback port that Slack's OAuth app no longer has
	// registered, so authenticating would open a browser flow that can never
	// redirect back. The catalog has no edit mode, so without this rewrite such
	// entries stay stranded until deleted and re-added. Read-path migration
	// keeps List/Get/Authenticate consistent without a store write.
	if rec.BuiltinID == "slack" && rec.AuthMode == methods.MCPServerAuthModeOAuth && !rec.OAuthDeepLink {
		rec.OAuthDeepLink = true
		rec.OAuthCallbackPort = 0
	}
	return methods.MCPServerEntry{
		Name:              name,
		Enabled:           rec.Enabled,
		Command:           rec.Command,
		Args:              rec.Args,
		Env:               rec.Env,
		URL:               rec.URL,
		Headers:           rec.Headers,
		BearerToken:       rec.BearerToken,
		AuthMode:          rec.AuthMode,
		OAuthScopes:       rec.OAuthScopes,
		OAuthClientID:     rec.OAuthClientID,
		OAuthCallbackPort: rec.OAuthCallbackPort,
		OAuthDeepLink:     rec.OAuthDeepLink,
		BuiltinID:         rec.BuiltinID,
	}
}

func entryToRecord(e methods.MCPServerEntry) serverRecord {
	return serverRecord{
		Command:           e.Command,
		Args:              e.Args,
		Env:               e.Env,
		URL:               e.URL,
		Headers:           e.Headers,
		BearerToken:       e.BearerToken,
		Enabled:           e.Enabled,
		AuthMode:          e.AuthMode,
		OAuthScopes:       e.OAuthScopes,
		OAuthClientID:     e.OAuthClientID,
		OAuthCallbackPort: e.OAuthCallbackPort,
		OAuthDeepLink:     e.OAuthDeepLink,
		BuiltinID:         e.BuiltinID,
	}
}

// authHeader is one resolved HTTP header (name + value).
type authHeader struct{ Name, Value string }

// buildAuthHeaders applies a managed bearer/OAuth token to user-supplied headers:
// when token is non-empty it drops any user "Authorization" header
// (case-insensitive) and appends "Authorization: Bearer <token>"; otherwise the
// user's headers (an imported config or non-Bearer scheme) are kept as-is.
// Shared by BuildACPServer (session inject) and the HTTP probe (probe.go).
func buildAuthHeaders(userHeaders map[string]string, token string) []authHeader {
	out := make([]authHeader, 0, len(userHeaders)+1)
	for k, v := range userHeaders {
		if token != "" && strings.EqualFold(k, "authorization") {
			continue
		}
		out = append(out, authHeader{Name: k, Value: v})
	}
	if token != "" {
		out = append(out, authHeader{Name: "Authorization", Value: "Bearer " + token})
	}
	return out
}

// BuildACPServer converts a stored server entry + resolved bearer token into an
// acpsdk.McpServer ready to append to session/new or session/load.
// bearerToken should be empty for non-OAuth servers; for OAuth the caller has
// already resolved the token from the keychain.
func BuildACPServer(entry methods.MCPServerEntry, bearerToken string) (acpsdk.McpServer, error) {
	if entry.Command != "" {
		// stdio transport
		env := make([]acpsdk.EnvVariable, 0, len(entry.Env))
		for k, v := range entry.Env {
			env = append(env, acpsdk.EnvVariable{Name: k, Value: v})
		}
		args := entry.Args
		if args == nil {
			args = []string{}
		}
		return acpsdk.McpServer{Stdio: &acpsdk.McpServerStdio{
			Name:    entry.Name,
			Command: entry.Command,
			Args:    args,
			Env:     env,
		}}, nil
	}
	if entry.URL != "" {
		// Remote transport. Apply auth: a resolved OAuth token takes priority,
		// then static bearer.
		token := bearerToken
		if token == "" {
			token = entry.BearerToken
		}
		headers := make([]acpsdk.HttpHeader, 0, len(entry.Headers)+1)
		for _, h := range buildAuthHeaders(entry.Headers, token) {
			headers = append(headers, acpsdk.HttpHeader{Name: h.Name, Value: h.Value})
		}
		// A "/sse" endpoint speaks the legacy HTTP+SSE transport, not streamable
		// HTTP — emit the matching ACP variant so the agent connects correctly.
		if isSSEURL(entry.URL) {
			return acpsdk.McpServer{Sse: &acpsdk.McpServerSseInline{
				Name:    entry.Name,
				Url:     entry.URL,
				Headers: headers,
				Type:    "sse",
			}}, nil
		}
		return acpsdk.McpServer{Http: &acpsdk.McpServerHttpInline{
			Name:    entry.Name,
			Url:     entry.URL,
			Headers: headers,
			Type:    "http",
		}}, nil
	}
	return acpsdk.McpServer{}, fmt.Errorf("mcpservers: server %q has neither command nor url", entry.Name)
}
