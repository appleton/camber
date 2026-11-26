package acpproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/tliron/glsp"
)

// ReadQuota uses the runtime bundled with the running ACP adapter and its
// environment. Both probes perform account reads without creating chat turns.
func (h *Handler) ReadQuota(ctx context.Context, params *methods.ACPAgentServerParams, gCtx *glsp.Context) (*methods.ACPReadQuotaOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	output := &methods.ACPReadQuotaOutput{Buckets: []methods.ACPQuotaBucket{}}
	if serverName != "claude-acp" && serverName != "codex-acp" {
		return output, nil
	}
	proc, err := h.initializedProcess(gCtx, serverName)
	if err != nil {
		return nil, err
	}
	binary, args, env, dir, _, ok := proc.commandSnapshot()
	if !ok {
		return output, nil
	}

	var read func(*quotaPipe, *methods.ACPReadQuotaOutput) error
	switch serverName {
	case "claude-acp":
		args = append(args, "--cli", "--print", "--input-format", "stream-json", "--output-format", "stream-json",
			"--verbose", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`)
		read = readClaudeQuota
	case "codex-acp":
		args = append(args, "cli", "app-server")
		read = readCodexQuota
	}

	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	configureProcessCommand(cmd)
	cmd.Cancel = func() error { return killProcessTree(cmd) }
	cmd.Env, cmd.Dir = env, dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	defer func() {
		_ = stdin.Close()
		_ = killProcessTree(cmd)
		_ = cmd.Wait()
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	if err := read(&quotaPipe{writer: json.NewEncoder(stdin), reader: scanner}, output); err != nil {
		return nil, fmt.Errorf("%s quota read: %w", serverName, err)
	}
	return output, nil
}

type quotaPipe struct {
	writer *json.Encoder
	reader *bufio.Scanner
}

func (p *quotaPipe) next(match func([]byte) (bool, error)) error {
	for p.reader.Scan() {
		found, err := match(p.reader.Bytes())
		if found || err != nil {
			return err
		}
	}
	if err := p.reader.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

func (p *quotaPipe) codexRequest(id int, method string, params, result any) error {
	request := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		request["params"] = params
	}
	if err := p.writer.Encode(request); err != nil {
		return err
	}
	return p.next(func(line []byte) (bool, error) {
		var reply struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &reply) != nil || reply.ID != id {
			return false, nil
		}
		if len(reply.Error) != 0 || len(reply.Result) == 0 {
			return true, fmt.Errorf("%s failed", method)
		}
		return true, json.Unmarshal(reply.Result, result)
	})
}

func readCodexQuota(p *quotaPipe, output *methods.ACPReadQuotaOutput) error {
	var initialized json.RawMessage
	if err := p.codexRequest(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "camber", "version": "0.1"}}, &initialized); err != nil {
		return err
	}
	if err := p.writer.Encode(map[string]string{"jsonrpc": "2.0", "method": "initialized"}); err != nil {
		return err
	}
	var account struct {
		Account struct {
			Type string `json:"type"`
		} `json:"account"`
	}
	if err := p.codexRequest(2, "account/read", map[string]bool{"refreshToken": false}, &account); err != nil || account.Account.Type != "chatgpt" {
		return err
	}
	var limits struct {
		Default      codexQuotaLimit            `json:"rateLimits"`
		ByID         map[string]codexQuotaLimit `json:"rateLimitsByLimitId"`
		ResetCredits struct {
			AvailableCount *int `json:"availableCount"`
		} `json:"rateLimitResetCredits"`
	}
	if err := p.codexRequest(3, "account/rateLimits/read", nil, &limits); err != nil {
		return err
	}
	output.AvailableResets = limits.ResetCredits.AvailableCount
	if len(limits.ByID) == 0 {
		limits.ByID = map[string]codexQuotaLimit{"codex": limits.Default}
	}
	if standard, ok := limits.ByID["codex"]; ok {
		output.Buckets = appendCodexWindows(output.Buckets, "codex", standard)
		delete(limits.ByID, "codex")
	}
	for _, id := range slices.Sorted(maps.Keys(limits.ByID)) {
		output.Buckets = appendCodexWindows(output.Buckets, id, limits.ByID[id])
	}
	return nil
}

type codexQuotaLimit struct {
	Name      string           `json:"limitName"`
	Primary   codexQuotaWindow `json:"primary"`
	Secondary codexQuotaWindow `json:"secondary"`
}

type codexQuotaWindow struct {
	UsedPercent *float64 `json:"usedPercent"`
	Minutes     int      `json:"windowDurationMins"`
	ResetsAt    int64    `json:"resetsAt"`
}

func appendCodexWindows(buckets []methods.ACPQuotaBucket, id string, limit codexQuotaLimit) []methods.ACPQuotaBucket {
	for i, window := range []codexQuotaWindow{limit.Primary, limit.Secondary} {
		if window.UsedPercent == nil {
			continue
		}
		label := [...]string{"Primary limit", "Secondary limit"}[i]
		switch {
		case window.Minutes == 10080:
			label = "Weekly limit"
		case window.Minutes > 0 && window.Minutes%60 == 0:
			label = fmt.Sprintf("%d-hour limit", window.Minutes/60)
		case window.Minutes > 0:
			label = fmt.Sprintf("%d-minute limit", window.Minutes)
		}
		if id != "codex" {
			name := limit.Name
			if name == "" {
				name = id
			}
			label = name + " · " + label
		}
		bucket := methods.ACPQuotaBucket{Label: label, UsedPercent: *window.UsedPercent}
		if window.ResetsAt > 0 {
			reset := time.Unix(window.ResetsAt, 0).UTC()
			bucket.ResetsAt = &reset
		}
		buckets = append(buckets, bucket)
	}
	return buckets
}

func (p *quotaPipe) claudeRequest(id string, request, result any) error {
	if err := p.writer.Encode(map[string]any{"type": "control_request", "request_id": id, "request": request}); err != nil {
		return err
	}
	return p.next(func(line []byte) (bool, error) {
		var reply struct {
			Type     string `json:"type"`
			Response struct {
				ID      string          `json:"request_id"`
				Subtype string          `json:"subtype"`
				Result  json.RawMessage `json:"response"`
			} `json:"response"`
		}
		if json.Unmarshal(line, &reply) != nil || reply.Type != "control_response" || reply.Response.ID != id {
			return false, nil
		}
		if reply.Response.Subtype != "success" || len(reply.Response.Result) == 0 {
			return true, errors.New("Claude control request failed")
		}
		return true, json.Unmarshal(reply.Response.Result, result)
	})
}

func readClaudeQuota(p *quotaPipe, output *methods.ACPReadQuotaOutput) error {
	var initialized json.RawMessage
	if err := p.claudeRequest("init", map[string]string{"subtype": "initialize"}, &initialized); err != nil {
		return err
	}
	var usage struct {
		Available bool `json:"rate_limits_available"`
		Limits    struct {
			FiveHour claudeQuotaWindow   `json:"five_hour"`
			Weekly   claudeQuotaWindow   `json:"seven_day"`
			Opus     claudeQuotaWindow   `json:"seven_day_opus"`
			Sonnet   claudeQuotaWindow   `json:"seven_day_sonnet"`
			Model    []claudeQuotaWindow `json:"model_scoped"`
			Resets   json.RawMessage     `json:"cedar_ember"`
		} `json:"rate_limits"`
	}
	// This control request backs the Claude SDK's experimental /usage API.
	if err := p.claudeRequest("usage", map[string]any{"subtype": "get_usage", "skip_behaviors": true}, &usage); err != nil || !usage.Available {
		return err
	}
	buckets := output.Buckets
	buckets = appendClaudeWindow(buckets, "5-hour limit", usage.Limits.FiveHour)
	buckets = appendClaudeWindow(buckets, "Weekly · all models", usage.Limits.Weekly)
	if len(usage.Limits.Model) == 0 {
		buckets = appendClaudeWindow(buckets, "Weekly · Opus", usage.Limits.Opus)
		buckets = appendClaudeWindow(buckets, "Weekly · Sonnet", usage.Limits.Sonnet)
	}
	for _, model := range usage.Limits.Model {
		if label := strings.TrimSpace(model.Name); label != "" {
			buckets = appendClaudeWindow(buckets, "Weekly · "+label, model)
		}
	}
	output.Buckets = buckets
	output.AvailableResets = countClaudeResets(usage.Limits.Resets, time.Now())
	return nil
}

// Claude reports promotional reset grants separately from the scheduled
// refill time of each window. Their schema is experimental, so decoding
// a missing or malformed inventory must leave the usage windows intact.
func countClaudeResets(raw json.RawMessage, now time.Time) *int {
	var inventory struct {
		Eligible bool              `json:"eligible"`
		Grants   []json.RawMessage `json:"grants"`
	}
	if json.Unmarshal(raw, &inventory) != nil || !inventory.Eligible || inventory.Grants == nil {
		return nil
	}

	count := 0
	for _, rawGrant := range inventory.Grants {
		var grant struct {
			Remaining int        `json:"resets_left"`
			Paused    bool       `json:"paused"`
			StartsAt  *time.Time `json:"starts_at"`
			EndsAt    *time.Time `json:"ends_at"`
		}
		if json.Unmarshal(rawGrant, &grant) != nil || grant.Remaining <= 0 || grant.Paused ||
			(grant.StartsAt != nil && now.Before(*grant.StartsAt)) ||
			(grant.EndsAt != nil && !now.Before(*grant.EndsAt)) {
			continue
		}
		count += grant.Remaining
	}
	return &count
}

type claudeQuotaWindow struct {
	Name        string   `json:"display_name"`
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func appendClaudeWindow(buckets []methods.ACPQuotaBucket, label string, window claudeQuotaWindow) []methods.ACPQuotaBucket {
	if window.Utilization == nil {
		return buckets
	}
	bucket := methods.ACPQuotaBucket{Label: label, UsedPercent: *window.Utilization}
	if reset, err := time.Parse(time.RFC3339, window.ResetsAt); err == nil {
		bucket.ResetsAt = &reset
	}
	return append(buckets, bucket)
}
