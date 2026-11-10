package handler

import (
	"fmt"
	"reflect"
	"time"

	"github.com/mitchellh/mapstructure"
	pkgerrors "github.com/pkg/errors"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
)

type ClientCapabilitiesConfig struct {
	// MCPOAuthDeepLink reports that the client registered the camber:// URL
	// scheme with the OS and forwards camber://oauth/callback redirects to
	// the helper via camber/mcpOAuthCallback (the desktop app).
	MCPOAuthDeepLink bool `json:"mcpOAuthDeepLink"`

	// Allow clients to add capabilities without requiring synchronized helper
	// releases.
	_ struct{} `json:"-" additionalProperties:"true"`
}

// Config is the configuration that can be specified in initialize calls.
// See ConfigChange for fields that can be updated via the workspace/didChangeConfiguration
// calls.
type Config struct {
	AssistantHost        string                                `json:"assistantHost"`
	AssistantEnvironment string                                `json:"assistantEnvironment"`
	ClientCapabilities   ClientCapabilitiesConfig              `json:"clientCapabilities,omitempty"`
	SessionID            string                                `json:"sessionId"`
	ACPAgentServers      map[string]acpproxy.AgentServerConfig `json:"agentServers,omitempty"`
}

// ConfigChange are the fields in Config that can be dynamically updated.
// nil means no change. We use zero values to unset fields
type ConfigChange struct {
	ACPAgentServers *map[string]acpproxy.AgentServerConfig `json:"agentServers,omitempty"`
}

func fromInitializationOptions(initOptions any) (*Config, error) {
	conf := Config{}

	// TODO eventually this should be an error
	if initOptions != nil {
		params, ok := initOptions.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("Initialize.initializationOptions was not a map: %T", initOptions)
		}
		err := decodeConfig(params, &conf)
		if err != nil {
			return nil, err
		}
	}

	return &conf, nil
}

func updateConfig(configChange any, c *Config) error {
	change := ConfigChange{}
	err := decodeConfig(configChange, &change)
	if err != nil {
		return fmt.Errorf("failed to decode Config: %w", err)
	}

	if change.ACPAgentServers != nil {
		c.ACPAgentServers = *change.ACPAgentServers
	}

	return nil
}

func decodeConfig(input any, targetPtr any) error {
	config := &mapstructure.DecoderConfig{
		Result:               targetPtr,
		TagName:              "json",
		IgnoreUntaggedFields: true,
		DecodeHook: mapstructure.ComposeDecodeHookFunc(
			mapstructure.StringToTimeHookFunc(time.RFC3339),
			func(f reflect.Kind, t reflect.Kind, data interface{}) (interface{}, error) {
				if f != reflect.String || t != reflect.Struct {
					return data, nil
				}
				if reflect.TypeOf(time.Time{}) != reflect.TypeOf(data) {
					return data, nil
				}
				parsedTime, err := time.Parse(time.RFC3339, data.(string))
				if err != nil {
					return nil, err
				}
				return parsedTime, nil
			}),
	}

	dec, err := mapstructure.NewDecoder(config)

	if err != nil {
		return pkgerrors.Wrap(err, "failed to create decoder config")
	}
	return pkgerrors.WithStack(dec.Decode(input))
}
