package acpproxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
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
{"id":3,"result":{"rateLimits":{"primary":{"usedPercent":12}},"rateLimitsByLimitId":{"codex_other":{"limitName":"Other","primary":{"usedPercent":87,"windowDurationMins":300}},"codex":{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1795741200},"secondary":{"usedPercent":29,"windowDurationMins":10080}}},"rateLimitResetCredits":{"availableCount":4,"credits":null}}}
`)),
	}
	var output methods.ACPReadQuotaOutput
	require.NoError(t, readCodexQuota(&pipe, &output))
	require.NotNil(t, output.AvailableResets)
	assert.Equal(t, 4, *output.AvailableResets)
	buckets := output.Buckets
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
	var output methods.ACPReadQuotaOutput
	require.NoError(t, readCodexQuota(&pipe, &output))
	assert.Empty(t, output.Buckets)
	assert.Nil(t, output.AvailableResets)
	assert.NotContains(t, requests.String(), `"method":"account/rateLimits/read"`)
}

func TestReadClaudeQuotaUsesFableWindow(t *testing.T) {
	var requests bytes.Buffer
	pipe := quotaPipe{
		writer: json.NewEncoder(&requests),
		reader: bufio.NewScanner(strings.NewReader(`
{"type":"control_response","response":{"request_id":"init","subtype":"success","response":{}}}
{"type":"control_response","response":{"request_id":"usage","subtype":"success","response":{"rate_limits_available":true,"rate_limits":{"five_hour":null,"seven_day":{"utilization":0},"model_scoped":[{"display_name":"Fable","utilization":57.5,"resets_at":"2026-11-27T14:00:00Z"},{"display_name":"Opus","utilization":null}],"cedar_ember":{"eligible":true,"grants":[{"resets_left":2}]}}}}}
`)),
	}
	var output methods.ACPReadQuotaOutput
	require.NoError(t, readClaudeQuota(&pipe, &output))
	require.NotNil(t, output.AvailableResets)
	assert.Equal(t, 2, *output.AvailableResets)
	buckets := output.Buckets
	require.Len(t, buckets, 2)
	assert.Equal(t, "Weekly · all models", buckets[0].Label)
	assert.Zero(t, buckets[0].UsedPercent)
	assert.Equal(t, "Weekly · Fable", buckets[1].Label)
	assert.Equal(t, 57.5, buckets[1].UsedPercent)
	require.NotNil(t, buckets[1].ResetsAt)
	assert.Equal(t, time.Date(2026, 11, 27, 14, 0, 0, 0, time.UTC), *buckets[1].ResetsAt)
	assert.Contains(t, requests.String(), `"skip_behaviors":true`)
}

func TestCountClaudeResets(t *testing.T) {
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	count := countClaudeResets(json.RawMessage(`{
		"eligible": true,
		"grants": [
			{"resets_left": 2, "usable_now": false},
			{"resets_left": 1, "starts_at": "2026-11-25T00:00:00Z", "ends_at": "2026-12-01T00:00:00Z"},
			{"resets_left": 0},
			{"resets_left": 7, "paused": true},
			{"resets_left": 7, "starts_at": "2026-11-27T00:00:00Z"},
			{"resets_left": 7, "ends_at": "2026-11-26T12:00:00Z"},
			{"resets_left": "invalid"}
		]
	}`), now)
	require.NotNil(t, count)
	assert.Equal(t, 3, *count)

	for _, raw := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`{"eligible":false}`)} {
		assert.Nil(t, countClaudeResets(raw, now))
	}
}
