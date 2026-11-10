package handler

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDecodeConfig(t *testing.T) {
	expectedConfig := Config{
		AssistantEnvironment: "test",
	}

	conf := Config{}
	options := map[string]any{
		"assistantEnvironment": "test",
		"unknown":              "ignored",
	}

	assert.NoError(t, decodeConfig(options, &conf))
	assert.Equal(t, expectedConfig, conf)
}
