package acpproxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadCodexQuotaUsesNamedWindows(t *testing.T) {
	var requests bytes.Buffer
	pipe := quotaPipe{
		writer: json.NewEncoder(&requests),
		reader: bufio.NewScanner(strings.NewReader(`
{"id":1,"result":{}}
{"method":"account/rateLimits/updated","params":{}}
{"id":2,"result":{"account":{"type":"chatgpt"}}}
{"id":3,"result":{"rateLimits":{"primary":{"usedPercent":12}},"rateLimitsByLimitId":{"codex_other":{"limitName":"Other","primary":{"usedPercent":87,"windowDurationMins":300}},"codex":{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1795741200},"secondary":{"usedPercent":29,"windowDurationMins":10080}}}}}
`)),
	}
	buckets, err := readCodexQuota(&pipe)
	require.NoError(t, err)
	require.Len(t, buckets, 3)
	assert.Equal(t, "5-hour limit", buckets[0].Label)
	assert.Zero(t, buckets[0].UsedPercent)
	require.NotNil(t, buckets[0].ResetsAt)
	assert.Equal(t, int64(1795741200), buckets[0].ResetsAt.Unix())
	assert.Equal(t, "Weekly limit", buckets[1].Label)
	assert.Equal(t, 29.0, buckets[1].UsedPercent)
	assert.Equal(t, "Other · 5-hour limit", buckets[2].Label)
	assert.Contains(t, requests.String(), `"method":"account/rateLimits/read"`)
}

func TestReadCodexQuotaSkipsAPIKeyAccounts(t *testing.T) {
	var requests bytes.Buffer
	pipe := quotaPipe{
		writer: json.NewEncoder(&requests),
		reader: bufio.NewScanner(strings.NewReader(`
{"id":1,"result":{}}
{"id":2,"result":{"account":{"type":"apiKey"}}}
`)),
	}
	buckets, err := readCodexQuota(&pipe)
	require.NoError(t, err)
	assert.Empty(t, buckets)
	assert.NotContains(t, requests.String(), `"method":"account/rateLimits/read"`)
}

func TestReadClaudeQuotaUsesFableWindow(t *testing.T) {
	var requests bytes.Buffer
	pipe := quotaPipe{
		writer: json.NewEncoder(&requests),
		reader: bufio.NewScanner(strings.NewReader(`
{"type":"control_response","response":{"request_id":"init","subtype":"success","response":{}}}
{"type":"control_response","response":{"request_id":"usage","subtype":"success","response":{"rate_limits_available":true,"rate_limits":{"five_hour":null,"seven_day":{"utilization":0},"model_scoped":[{"display_name":"Fable","utilization":57.5,"resets_at":"2026-11-27T14:00:00Z"},{"display_name":"Opus","utilization":null}]}}}}
`)),
	}
	buckets, err := readClaudeQuota(&pipe)
	require.NoError(t, err)
	require.Len(t, buckets, 2)
	assert.Equal(t, "Weekly · all models", buckets[0].Label)
	assert.Zero(t, buckets[0].UsedPercent)
	assert.Equal(t, "Weekly · Fable", buckets[1].Label)
	assert.Equal(t, 57.5, buckets[1].UsedPercent)
	require.NotNil(t, buckets[1].ResetsAt)
	assert.Equal(t, time.Date(2026, 11, 27, 14, 0, 0, 0, time.UTC), *buckets[1].ResetsAt)
	assert.Contains(t, requests.String(), `"skip_behaviors":true`)
}
