package mcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp/oauthex"
	"github.com/appleton/camber/pkg/common/secrets"
	"golang.org/x/oauth2"
)

type OAuthConfig struct {
	ClientID     string           `json:"client_id"`
	ClientSecret string           `json:"client_secret"`
	AuthURL      string           `json:"auth_url"`
	TokenURL     string           `json:"token_url"`
	AuthStyle    oauth2.AuthStyle `json:"auth_style,omitempty"`
}

type ServerSecrets struct {
	OAuth    *OAuthData        `json:"oauth,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type OAuthData struct {
	AccessToken  string      `json:"access_token"`
	TokenType    string      `json:"token_type"`
	RefreshToken string      `json:"refresh_token"`
	Expiry       time.Time   `json:"expiry"`
	Config       OAuthConfig `json:"config"`
}

func NewOAuthData(token *oauth2.Token, config *oauth2.Config) *OAuthData {
	return &OAuthData{
		AccessToken:  token.AccessToken,
		TokenType:    token.TokenType,
		RefreshToken: token.RefreshToken,
		Expiry:       token.Expiry,
		Config: OAuthConfig{
			ClientID:     config.ClientID,
			ClientSecret: config.ClientSecret,
			AuthURL:      config.Endpoint.AuthURL,
			TokenURL:     config.Endpoint.TokenURL,
			AuthStyle:    config.Endpoint.AuthStyle,
		},
	}
}

type ServerKey string

func NewServerKey(serverURL, serverID string) (ServerKey, error) {
	if serverURL != "" {
		if _, err := url.ParseRequestURI(serverURL); err != nil {
			return "", fmt.Errorf("invalid server URL: %w", err)
		}
		return ServerKey(serverURL), nil
	}
	if serverID == "" {
		return "", errors.New("either server URL or server ID is required")
	}
	return ServerKey("mcp-server:" + serverID), nil
}

type SecretsServerStore interface {
	Load(ctx context.Context, key ServerKey) (*ServerSecrets, error)
	Save(ctx context.Context, key ServerKey, data *ServerSecrets) error
	Delete(ctx context.Context, key ServerKey) error
}

func NewKeyringSecretsServerStore() SecretsServerStore {
	return secrets.NewKeyringStore[ServerKey, ServerSecrets]("ai.poolside.agent.mcp")
}

// RegisterOAuthClient performs Dynamic Client Registration (RFC 7591). Scopes
// are included in the registration metadata because some providers (e.g.
// Hugging Face) only issue tokens for scopes the client registered for.
func RegisterOAuthClient(ctx context.Context, registrationEndpoint string, redirectURI string, supportedAuthMethods []string, scopes []string) (string, *oauthex.ClientRegistrationResponse, error) {
	return registerOAuthClientWithHTTPClient(ctx, registrationEndpoint, redirectURI, supportedAuthMethods, scopes, newOAuthHTTPClient(discoveryHTTPTimeout))
}

// registerOAuthClientWithHTTPClient lets a caller that already built a guarded
// client reuse it, so registration goes through the same SSRF and redirect
// checks as discovery.
func registerOAuthClientWithHTTPClient(ctx context.Context, registrationEndpoint string, redirectURI string, supportedAuthMethods []string, scopes []string, httpClient *http.Client) (string, *oauthex.ClientRegistrationResponse, error) {
	if err := checkOAuthEndpointURLString(registrationEndpoint, "registration endpoint"); err != nil {
		return "", nil, err
	}
	authMethod := pickTokenEndpointAuthMethod(supportedAuthMethods)
	clientMeta := &oauthex.ClientRegistrationMetadata{
		RedirectURIs:            []string{redirectURI},
		TokenEndpointAuthMethod: authMethod,
		GrantTypes:              []string{"authorization_code"},
		ResponseTypes:           []string{"code"},
		ClientName:              "Camber Client",
		Scope:                   strings.Join(scopes, " "),
	}

	regResponse, err := oauthex.RegisterClient(ctx, registrationEndpoint, clientMeta, httpClient)
	if err != nil {
		return "", nil, fmt.Errorf("failed to register OAuth client: %w", err)
	}
	return authMethod, regResponse, nil
}

func pickTokenEndpointAuthMethod(supported []string) string {
	const specDefault = "client_secret_basic"
	preference := []string{"none", "client_secret_basic", "client_secret_post"}
	if len(supported) == 0 {
		return specDefault
	}
	supportedSet := make(map[string]struct{}, len(supported))
	for _, m := range supported {
		supportedSet[m] = struct{}{}
	}
	for _, m := range preference {
		if _, ok := supportedSet[m]; ok {
			return m
		}
	}
	return supported[0]
}

type OAuthCallbackServer struct {
	server      *http.Server
	codeChan    chan string
	errChan     chan error
	callbackURI string
}

// NewOAuthCallbackServerOnPort starts the loopback OAuth callback listener on
// a fixed port. Pass zero to let the OS choose a free port (used by DCR flows).
func NewOAuthCallbackServerOnPort(state string, port int) (*OAuthCallbackServer, error) {
	codeChan := make(chan string, 1)
	errChan := make(chan error, 1)

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, fmt.Errorf("failed to create listener: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		receivedState := r.URL.Query().Get("state")
		if receivedState != state {
			errChan <- errors.New("invalid state parameter")
			return
		}
		if code == "" {
			errChan <- errors.New("no authorization code received")
			return
		}
		fmt.Fprintf(w, "Authorization successful. You can close this window.")
		codeChan <- code
	})

	server := &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errChan <- err
		}
	}()

	actualPort := listener.Addr().(*net.TCPAddr).Port
	return &OAuthCallbackServer{
		server:      server,
		callbackURI: fmt.Sprintf("http://127.0.0.1:%d/callback", actualPort),
		codeChan:    codeChan,
		errChan:     errChan,
	}, nil
}

func (o *OAuthCallbackServer) CallbackURI() string {
	return o.callbackURI
}

func (o *OAuthCallbackServer) Shutdown(ctx context.Context) error {
	return o.server.Shutdown(ctx)
}

func (o *OAuthCallbackServer) GetCodeAndShutdown(ctx context.Context) (string, error) {
	select {
	case authCode := <-o.codeChan:
		_ = o.server.Shutdown(ctx)
		return authCode, nil
	case err := <-o.errChan:
		_ = o.server.Shutdown(ctx)
		return "", err
	case <-ctx.Done():
		_ = o.server.Shutdown(ctx)
		return "", ctx.Err()
	}
}
