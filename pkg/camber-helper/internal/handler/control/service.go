// Package control exposes desktop conversation orchestration to local clients.
package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type Agent interface {
	NewSession(context.Context, *methods.ACPNewSessionParams, *glsp.Context) (*methods.ACPNewSessionOutput, error)
	LoadSession(context.Context, *methods.ACPLoadSessionParams, *glsp.Context) (*methods.ACPLoadSessionOutput, error)
	CloseSession(context.Context, *methods.ACPCloseSessionParams, *glsp.Context) (*methods.ACPCloseSessionOutput, error)
	SetConfigOption(context.Context, *methods.ACPSetConfigOptionParams, *glsp.Context) (*methods.ACPSetConfigOptionOutput, error)
	SetMode(context.Context, *methods.ACPSetModeParams, *glsp.Context) (*methods.ACPSetModeOutput, error)
	Prompt(context.Context, *methods.ACPPromptParams, *glsp.Context) (*methods.ACPPromptOutput, error)
	Steer(context.Context, *methods.ACPSteerParams, *glsp.Context) (*methods.ACPSteerOutput, error)
	Cancel(context.Context, *methods.ACPCancelParams, *glsp.Context) (*methods.ACPCancelOutput, error)
}

type Service struct {
	nav        *acpnav.Server
	agent      Agent
	log        *remoteaccess.SessionLog
	mu         sync.Mutex
	operations map[string]chan struct{}
}

func New(nav *acpnav.Server, agent Agent, log *remoteaccess.SessionLog) *Service {
	return &Service{nav: nav, agent: agent, log: log}
}

type Args struct {
	Name           string         `json:"name,omitempty"`
	Topic          string         `json:"topic,omitempty"`
	ConversationID string         `json:"conversationId,omitempty"`
	ParentID       string         `json:"parentId,omitempty"`
	AgentServer    string         `json:"agentServer,omitempty"`
	WorkspacePath  string         `json:"workspacePath,omitempty"`
	ProjectPath    string         `json:"projectPath,omitempty"`
	WorktreeName   string         `json:"worktreeName,omitempty"`
	Text           string         `json:"text,omitempty"`
	RequestID      string         `json:"requestId,omitempty"`
	TurnID         string         `json:"turnId,omitempty"`
	Config         map[string]any `json:"config,omitempty"`
	Model          string         `json:"model,omitempty"`
	Effort         string         `json:"effort,omitempty"`
	Mode           string         `json:"mode,omitempty"`
	Cursor         string         `json:"cursor,omitempty"`
	WaitMs         int            `json:"waitMs,omitempty"`
}

type Record struct {
	PreparationEpoch string                   `json:"preparationEpoch,omitempty"`
	TurnRequestHash  string                   `json:"turnRequestHash,omitempty"`
	EndCursor        string                   `json:"endCursor,omitempty"`
	Task             string                   `json:"task,omitempty"`
	RequestHash      string                   `json:"requestHash,omitempty"`
	Status           string                   `json:"status,omitempty"`
	TurnID           string                   `json:"turnId,omitempty"`
	Cursor           string                   `json:"cursor,omitempty"`
	Error            string                   `json:"error,omitempty"`
	Result           *methods.ACPPromptOutput `json:"result,omitempty"`
	ConfigOptions    json.RawMessage          `json:"configOptions,omitempty"`
	Modes            json.RawMessage          `json:"modes,omitempty"`
	OwnsWorktree     bool                     `json:"ownsWorktree,omitempty"`
}

// View merges the navigation row with the durable control record. The parent
// and root links live only on the nav row (promoted as v.ParentID/v.RootID) so
// the flat JSON has a single parentId/rootId; they are persisted via storedRecord.
type View struct {
	methods.ACPNavConversation
	Record
}

// storedRecord is the persisted shape of "conversation/<id>" control state,
// which carries top-level parentId/rootId alongside the Record fields.
type storedRecord struct {
	Record
	ParentID string `json:"parentId,omitempty"`
	RootID   string `json:"rootId,omitempty"`
}

var commands = []string{"actions.list", "actions.describe", "skill.show", "context", "status", "agents.list", "agents.inspect", "agents.config.options", "projects.list", "worktrees.list", "worktrees.inspect", "worktrees.create", "worktrees.remove", "chat.list", "chat.inspect", "chat.children", "chat.spawn", "chat.send", "chat.steer", "chat.stop", "chat.poll", "chat.output", "chat.snapshot", "chat.config.list", "chat.config.set"}

func (s *Service) Dispatch(ctx context.Context, params *methods.ControlDispatchParams, g *glsp.Context) (json.RawMessage, error) {
	// CLI actions arrive over the primary desktop connection but render no local
	// transcript. Tag them separately so user prompts reach every GUI surface.
	ctx = methods.WithClientOrigin(ctx, "control")
	// Bound helper work even when the desktop transport stops awaiting its response.
	ctx, cancel := context.WithTimeout(ctx, 9*time.Minute)
	defer cancel()
	var a Args
	if len(params.Args) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(params.Args))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&a); err != nil {
			return nil, pkgerrors.Wrap(err, "invalid control arguments")
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return nil, pkgerrors.Errorf("arguments must contain one JSON object")
		}
	}
	if a.WaitMs < 0 || a.WaitMs > 30000 {
		return nil, pkgerrors.Errorf("waitMs must be between 0 and 30000")
	}
	var out any
	var err error
	switch params.Command {
	case "actions.list":
		actions := []any{}
		for _, name := range commands {
			if descriptor, e := s.describe(name); e == nil {
				actions = append(actions, descriptor)
			}
		}
		out = map[string]any{"commands": commands, "actions": actions, "version": 1}
	case "actions.describe":
		out, err = s.describe(a.Name)
	case "skill.show":
		out, err = guide(a.Topic)
	case "context":
		out, err = s.callerContext(ctx, a, g)
	case "status":
		out = map[string]any{"ready": s.nav.HasStore(), "protocolVersion": 1}
	case "agents.list":
		var state methods.ACPNavAgentServersState
		state, err = s.nav.ListAgentServers(ctx, &methods.ACPNavListAgentServersParams{}, g)
		descriptors := []map[string]any{}
		for name, cfg := range state.AgentServers {
			descriptors = append(descriptors, map[string]any{"id": name, "type": cfg.Type, "defaultConfigOptions": cfg.DefaultConfigOptions})
		}
		sort.Slice(descriptors, func(i, j int) bool { return descriptors[i]["id"].(string) < descriptors[j]["id"].(string) })
		out = map[string]any{"agents": descriptors, "defaultAgentServer": state.DefaultAgentServer}
	case "agents.inspect", "agents.config.options":
		out, err = s.probe(ctx, a, g)
	case "projects.list", "worktrees.list", "worktrees.inspect":
		out, err = s.projects(ctx, params.Command, a, g)
	case "worktrees.create":
		out, err = s.createWorktree(ctx, a, g)
	case "worktrees.remove":
		out, err = s.removeWorktree(ctx, a, g)
	case "chat.list", "chat.children":
		out, err = s.list(ctx, a, params.Command == "chat.children", g)
	case "chat.inspect":
		out, err = s.displayView(ctx, a.ConversationID, g)
	case "chat.spawn":
		out, err = s.spawn(ctx, a, g)
	case "chat.send":
		out, err = s.send(ctx, a, g)
	case "chat.steer":
		out, err = s.steer(ctx, a, g)
	case "chat.stop":
		out, err = s.stop(ctx, a, g)
	case "chat.poll", "chat.output", "chat.snapshot":
		out, err = s.poll(ctx, a, params.Command, g)
	case "chat.config.list", "chat.config.set":
		out, err = s.configure(ctx, a, params.Command == "chat.config.set", g)
	default:
		err = pkgerrors.Errorf("unknown control action %q; run actions.list", params.Command)
	}
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(out)
	return raw, pkgerrors.WithStack(err)
}

func (s *Service) view(ctx context.Context, id string, g *glsp.Context) (View, error) {
	if id == "" {
		return View{}, pkgerrors.Errorf("conversationId is required")
	}
	c, err := s.nav.ControlConversation(ctx, id)
	if err != nil {
		return View{}, err
	}
	return s.viewFrom(ctx, c)
}

func (s *Service) viewFrom(ctx context.Context, c methods.ACPNavConversation) (View, error) {
	v := View{ACPNavConversation: c}
	var stored storedRecord
	err := s.nav.ReadControlState(ctx, "conversation/"+c.ID, &stored)
	v.Record = stored.Record
	if v.ParentID == "" {
		v.ParentID = stored.ParentID
	}
	if v.RootID == "" {
		v.RootID = stored.RootID
	}
	if err == nil && v.Status == "preparing" && v.PreparationEpoch != "" && v.PreparationEpoch != s.log.ProcessEpoch() {
		v.Status = "interrupted"
		v.Error = "helper restarted during preparation; inspect owned resources before retrying"
		err = s.save(ctx, v)
	}
	if err == nil && v.Status == "running" && v.Cursor != "" && !s.log.CursorEpochCurrent(v.Cursor) {
		v.Status = "interrupted"
		v.Error = "helper restarted; the previous turn outcome is unknown"
		err = s.save(ctx, v)
	}
	return v, err
}
func (s *Service) list(ctx context.Context, a Args, children bool, g *glsp.Context) (any, error) {
	parent := a.ParentID
	if parent == "" {
		parent = a.ConversationID
	}
	if children && parent == "" {
		return nil, pkgerrors.Errorf("parentId is required")
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return nil, err
	}
	out := []View{}
	for _, c := range state.Conversations {
		v, viewErr := s.viewFrom(ctx, c)
		if viewErr != nil {
			return nil, viewErr
		}

		if !children || v.ParentID == parent {
			out = append(out, s.withLiveState(v))
		}
	}
	return map[string]any{"conversations": out}, nil
}
func (s *Service) projects(ctx context.Context, command string, a Args, g *glsp.Context) (any, error) {
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return nil, err
	}
	out := []methods.ACPNavProject{}
	for _, p := range state.Projects {
		if command == "projects.list" && p.IsWorktree {
			continue
		}
		if command != "projects.list" && !p.IsWorktree {
			continue
		}
		if a.ProjectPath != "" && p.Path != a.ProjectPath && (p.ParentPath == nil || *p.ParentPath != a.ProjectPath) {
			continue
		}
		if a.WorkspacePath != "" && p.Path != a.WorkspacePath {
			continue
		}
		out = append(out, p)
	}
	if command == "worktrees.inspect" {
		if len(out) != 1 {
			return nil, pkgerrors.Errorf("worktree selection must match exactly one worktree")
		}
		return out[0], nil
	}
	return map[string]any{"projects": out}, nil
}
func (s *Service) save(ctx context.Context, v View) error {
	return s.nav.WriteControlState(ctx, "conversation/"+v.ID, storedRecord{Record: v.Record, ParentID: v.ParentID, RootID: v.RootID})
}
func captureConfig(value any) (json.RawMessage, json.RawMessage) {
	raw, _ := json.Marshal(value)
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	return m["configOptions"], m["modes"]
}
func content(text string) []acpsdk.ContentBlock {
	var blocks []acpsdk.ContentBlock
	raw, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
	_ = json.Unmarshal(raw, &blocks)
	return blocks
}
func (s *Service) probe(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	if a.AgentServer == "" {
		return nil, pkgerrors.Errorf("agentServer is required")
	}
	if err := s.initialize(ctx, a.AgentServer, g); err != nil {
		return nil, err
	}
	resp, err := s.agent.NewSession(ctx, &methods.ACPNewSessionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: a.AgentServer}, NewSessionRequest: acpsdk.NewSessionRequest{Cwd: a.WorkspacePath, McpServers: []acpsdk.McpServer{}, Meta: map[string]any{"camber/configProbe": true}}}, g)
	if err != nil {
		return nil, err
	}
	// Closing a probe is best effort: some ACP agents do not implement close.
	defer s.agent.CloseSession(context.WithoutCancel(ctx), &methods.ACPCloseSessionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: a.AgentServer}, CloseSessionRequest: acpsdk.CloseSessionRequest{SessionId: resp.SessionId}}, g)
	options, modes := captureConfig(resp)
	return map[string]any{"agentServer": a.AgentServer, "configOptions": options, "modes": modes}, nil
}

func (s *Service) spawn(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	if strings.TrimSpace(a.Text) == "" {
		return nil, pkgerrors.Errorf("text is required")
	}
	raw, _ := json.Marshal(a)
	sum := sha256.Sum256(raw)
	requestHash := hex.EncodeToString(sum[:])
	id := uuid.NewString()
	if a.RequestID != "" {
		digest := sha256.Sum256([]byte(a.ParentID + "\x00" + a.RequestID))
		id = "child-" + hex.EncodeToString(digest[:16])
	}
	release, lockErr := s.lockConversation(ctx, id)
	if lockErr != nil {
		return nil, lockErr
	}
	defer release()
	if a.RequestID != "" {
		var saved Record
		if e := s.nav.ReadControlState(ctx, "conversation/"+id, &saved); e != nil {
			return nil, e
		}
		if saved.RequestHash != "" && saved.RequestHash != requestHash {
			return nil, pkgerrors.Errorf("requestId was already used with different arguments")
		}
		existing, e := s.view(ctx, id, g)
		if e != nil && saved.Status != "" {
			return nil, pkgerrors.Errorf("previous spawn %s did not finish preparation: %s", id, saved.Error)
		}
		if e == nil {
			if existing.RequestHash != requestHash {
				return nil, pkgerrors.Errorf("requestId was already used with different arguments")
			}
			// Spawn retries refer to the initial task even after the child
			// has received further turns through the desktop or CLI.
			var initial Record
			if readErr := s.nav.ReadControlState(ctx, "turn/"+id+"/"+a.RequestID, &initial); readErr != nil {
				return nil, readErr
			}
			if initial.TurnID != "" {
				if initial.Status == "failed" {
					return nil, pkgerrors.Errorf("previous spawn %s failed: %s", id, initial.Error)
				}
				return map[string]any{"conversation": existing, "turnId": initial.TurnID, "cursor": initial.Cursor, "configOptions": initial.ConfigOptions}, nil
			}
			if existing.Status == "failed" {
				return nil, pkgerrors.Errorf("previous spawn %s failed: %s", id, existing.Error)
			}
			if existing.Status == "preparing" || (existing.Status == "interrupted" && existing.TurnID == "") {
				return nil, pkgerrors.Errorf("spawn preparation was interrupted; inspect conversation %s before retrying", id)
			}
			return nil, pkgerrors.Errorf("initial spawn turn for conversation %s is unavailable; inspect the conversation before retrying", id)
		}
	}
	var parent View
	if a.ParentID != "" {
		var err error
		parent, err = s.view(ctx, a.ParentID, g)
		if err != nil {
			return nil, err
		}
		if a.WorkspacePath == "" {
			a.WorkspacePath = parent.WorkspacePath
		}
		if a.AgentServer == "" {
			a.AgentServer = parent.AgentServer
		}
		if a.ProjectPath == "" {
			a.ProjectPath = parent.WorkspacePath
			if state, e := s.nav.List(ctx, &methods.ACPNavListParams{}, g); e == nil {
				for _, p := range state.Projects {
					if p.Path == a.ProjectPath && p.ParentPath != nil {
						a.ProjectPath = *p.ParentPath
						break
					}
				}
			}
		}
	}
	if a.AgentServer == "" {
		agents, err := s.nav.ListAgentServers(ctx, &methods.ACPNavListAgentServersParams{}, g)
		if err != nil {
			return nil, err
		}
		a.AgentServer = agents.DefaultAgentServer
	}
	if a.WorkspacePath == "" {
		a.WorkspacePath = a.ProjectPath
	}
	if a.WorkspacePath == "" {
		return nil, pkgerrors.Errorf("workspacePath or parentId is required")
	}
	v := View{ACPNavConversation: methods.ACPNavConversation{ID: id, WorkspacePath: a.WorkspacePath, Cwd: a.WorkspacePath, AgentServer: a.AgentServer, Title: compactText(a.Text, 256), WorkingDirectories: []string{a.WorkspacePath}}, Record: Record{Task: compactText(a.Text, 4096), RequestHash: requestHash, Status: "preparing", PreparationEpoch: s.log.ProcessEpoch()}}
	v.ParentID, v.RootID = a.ParentID, parent.RootID
	if v.RootID == "" {
		v.RootID = a.ParentID
	}
	if v.RootID == "" {
		v.RootID = id
	}
	if err := s.save(ctx, v); err != nil {
		return nil, err
	}
	if _, err := s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, g); err != nil {
		v.Status = "failed"
		v.Error = err.Error()
		_ = s.save(context.WithoutCancel(ctx), v)
		return nil, err
	}
	if a.WorktreeName != "" {
		p, err := s.nav.CreateWorktree(ctx, &methods.ACPNavCreateWorktreeParams{ProjectPath: a.ProjectPath, WorktreeName: a.WorktreeName}, g)
		if err != nil {
			v.Status = "failed"
			v.Error = err.Error()
			if p.Path != "" {
				v.WorkspacePath = p.Path
				v.Cwd = p.Path
				v.OwnsWorktree = true
				_, _ = s.nav.UpsertConversation(context.WithoutCancel(ctx), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, g)
			}
			_ = s.save(context.WithoutCancel(ctx), v)
			return nil, err
		}
		v.WorkspacePath = p.Path
		v.Cwd = p.Path
		v.WorkingDirectories = []string{p.Path}
		v.OwnsWorktree = true
		if err = s.save(ctx, v); err != nil {
			return nil, err
		}
		if _, err = s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, g); err != nil {
			return nil, err
		}
		settings, settingsErr := s.nav.GetProjectSettings(ctx, &methods.ACPNavGetProjectSettingsParams{Path: a.ProjectPath}, g)
		if settingsErr == nil {
			settingsErr = runWorktreeScript(ctx, v.Cwd, settings.Settings.SetupScript)
		}
		if settingsErr != nil {
			v.Status = "failed"
			v.Error = settingsErr.Error()
			_ = s.save(context.WithoutCancel(ctx), v)
			return nil, settingsErr
		}
	}
	if _, err := s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, g); err != nil {
		return nil, err
	}
	if err := s.initialize(ctx, a.AgentServer, g); err != nil {
		v.Status = "failed"
		v.Error = err.Error()
		_ = s.save(context.WithoutCancel(ctx), v)
		return nil, err
	}
	resp, err := s.agent.NewSession(ctx, &methods.ACPNewSessionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: a.AgentServer}, NewSessionRequest: acpsdk.NewSessionRequest{Cwd: v.Cwd, McpServers: []acpsdk.McpServer{}, Meta: map[string]any{acp.MetaKeySessionConversationID: id}}}, g)
	if err != nil {
		v.Status = "failed"
		v.Error = err.Error()
		_ = s.save(context.WithoutCancel(ctx), v)
		return nil, err
	}
	v.SessionID = string(resp.SessionId)
	v.ConfigOptions, v.Modes = captureConfig(resp)
	if _, err = s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, g); err != nil {
		return nil, err
	}
	if parent.AgentServer == v.AgentServer {
		parentLive := false
		if source, ok := s.agent.(interface {
			SessionConfiguration(string, string) (json.RawMessage, json.RawMessage, bool)
		}); ok {
			if options, modes, found := source.SessionConfiguration(parent.AgentServer, parent.SessionID); found {
				parent.ConfigOptions = options
				parent.Modes = modes
				parentLive = true
			}
		}
		if !parentLive {
			if err = useSavedParentConfiguration(&parent); err != nil {
				v.Status = "failed"
				v.Error = err.Error()
				_ = s.save(context.WithoutCancel(ctx), v)
				return nil, err
			}
		}
	}
	if err = validateConfigKeys(v.ConfigOptions, a.Config); err != nil {
		v.Status = "failed"
		v.Error = err.Error()
		_ = s.save(context.WithoutCancel(ctx), v)
		return nil, err
	}
	// The selected model determines which effort and mode selections can be
	// inherited. Apply it before filtering inherited dependent values.
	modelID, modelValue := "", a.Model
	for _, o := range parseOptions(v.ConfigOptions) {
		if o.Category == "model" || o.ID == "model" {
			modelID = o.ID
			if explicit, ok := a.Config[o.ID].(string); ok {
				if modelValue != "" && modelValue != explicit {
					return nil, pkgerrors.Errorf("conflicting values for option %s", o.ID)
				}
				modelValue = explicit
			}
			if modelValue == "" && parent.AgentServer == v.AgentServer {
				for _, p := range parseOptions(parent.ConfigOptions) {
					if p.ID == o.ID {
						if value, ok := p.Current.(string); ok && allowed(o.Options, value) {
							modelValue = value
						}
					}
				}
			}
			break
		}
	}
	if modelValue != "" {
		modelArgs := Args{Model: modelValue}
		if modelID != "" {
			modelArgs = Args{Config: map[string]any{modelID: modelValue}}
		}
		if err = s.applyConfig(ctx, &v, modelArgs, g); err != nil {
			v.Status = "failed"
			v.Error = err.Error()
			_ = s.save(context.WithoutCancel(ctx), v)
			return nil, err
		}
	}
	if parent.AgentServer == v.AgentServer {
		// Explicit settings win over inheritance, so only inherit the legacy
		// mode when the caller did not set a mode option through the config map.
		explicitMode := configSetsCategory(v.ConfigOptions, a.Config, "mode")
		a.Config = inheritCompatible(parent.ConfigOptions, v.ConfigOptions, a)
		if a.Mode == "" && !explicitMode {
			var current struct {
				ID string `json:"currentModeId"`
			}
			var available struct {
				Modes []struct {
					ID string `json:"id"`
				} `json:"availableModes"`
			}
			_ = json.Unmarshal(parent.Modes, &current)
			_ = json.Unmarshal(v.Modes, &available)
			for _, m := range available.Modes {
				if current.ID != "" && current.ID == m.ID {
					a.Mode = current.ID
				}
			}
		}
	}

	if err = s.applyConfig(ctx, &v, a, g); err != nil {
		v.Status = "failed"
		v.Error = err.Error()
		_ = s.save(context.WithoutCancel(ctx), v)
		return nil, err
	}
	if err = s.launch(ctx, &v, a, g); err != nil {
		return nil, err
	}
	return map[string]any{"conversation": v, "turnId": v.TurnID, "cursor": v.Cursor, "configOptions": v.ConfigOptions}, nil
}

func (s *Service) launch(ctx context.Context, v *View, a Args, g *glsp.Context) error {
	if v.SessionID == "" {
		return pkgerrors.Errorf("conversation has no agent session")
	}
	turn := a.RequestID
	if turn == "" {
		turn = uuid.NewString()
	}
	turn = v.ID + "/" + turn
	textHash := sha256.Sum256([]byte(a.Text))
	v.TurnRequestHash = hex.EncodeToString(textHash[:])
	v.Status = "running"
	v.TurnID = turn
	v.Cursor = s.log.ControlCursor(v.AgentServer, v.SessionID)
	v.Error = ""
	v.Result = nil
	v.EndCursor = ""
	if err := s.nav.WriteControlState(ctx, "turn/"+turn, v.Record); err != nil {
		return err
	}
	if err := s.save(ctx, *v); err != nil {
		return err
	}
	copyView := *v
	taskPrompt := content(a.Text)
	settingsPath := v.WorkspacePath
	if state, e := s.nav.List(ctx, &methods.ACPNavListParams{}, g); e == nil {
		for _, p := range state.Projects {
			if p.Path == v.WorkspacePath && p.ParentPath != nil {
				settingsPath = *p.ParentPath
			}
		}
	}
	if settings, err := s.nav.GetProjectSettings(ctx, &methods.ACPNavGetProjectSettingsParams{Path: settingsPath}, g); err == nil && strings.TrimSpace(settings.Settings.UserPrompt) != "" {
		taskPrompt = append(taskPrompt, acpsdk.TextBlock("<camber-system-instructions>\n<project-instructions>\n"+settings.Settings.UserPrompt+"\n</project-instructions>\n</camber-system-instructions>"))
	}
	// A request disconnect must not terminate a delegated agent turn.
	go func() {
		resp, err := s.agent.Prompt(context.WithoutCancel(ctx), &methods.ACPPromptParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: copyView.AgentServer}, PromptRequest: acpsdk.PromptRequest{SessionId: acpsdk.SessionId(copyView.SessionID), Prompt: taskPrompt, Meta: map[string]any{"camber/turnId": turn}}}, g)
		endCursor := s.log.ControlCursor(copyView.AgentServer, copyView.SessionID)
		if boundaries, ok := s.agent.(interface {
			TurnEndCursor(context.Context, string, string, string) (string, int64, bool, error)
		}); ok {
			epoch, seq, found, boundaryErr := boundaries.TurnEndCursor(context.WithoutCancel(ctx), copyView.AgentServer, copyView.SessionID, turn)
			if boundaryErr != nil && err == nil {
				err = boundaryErr
			}
			if found {
				endCursor = s.log.CursorAt(copyView.AgentServer, copyView.SessionID, epoch, seq)
			}
		}
		release, lockErr := s.lockConversation(context.Background(), copyView.ID)
		if lockErr != nil {
			return
		}
		defer release()
		latest, e := s.view(context.Background(), copyView.ID, g)
		if e != nil || latest.TurnID != turn {
			return
		}
		latest.EndCursor = endCursor
		latest.Result = resp
		latest.Status = "completed"
		if resp != nil && resp.StopReason == acpsdk.StopReasonCancelled {
			latest.Status = "cancelled"
		}
		if err != nil {
			latest.Status = "failed"
			latest.Error = err.Error()
		}
		_ = s.nav.WriteControlState(context.Background(), "turn/"+turn, latest.Record)
		_ = s.save(context.Background(), latest)
	}()
	return nil
}
func (s *Service) send(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	release, lockErr := s.lockConversation(ctx, a.ConversationID)
	if lockErr != nil {
		return nil, lockErr
	}
	defer release()
	if strings.TrimSpace(a.Text) == "" {
		return nil, pkgerrors.Errorf("text is required")
	}
	v, err := s.view(ctx, a.ConversationID, g)
	if err != nil {
		return nil, err
	}
	if a.RequestID != "" {
		var saved Record
		if err = s.nav.ReadControlState(ctx, "turn/"+v.ID+"/"+a.RequestID, &saved); err != nil {
			return nil, err
		}
		if saved.TurnID != "" {
			digest := sha256.Sum256([]byte(a.Text))
			if saved.TurnRequestHash != hex.EncodeToString(digest[:]) {
				return nil, pkgerrors.Errorf("requestId was already used with different text")
			}
			return map[string]any{"conversationId": v.ID, "turnId": saved.TurnID, "cursor": saved.Cursor}, nil
		}
	}

	if v.Status == "running" || s.log.Cursor(v.AgentServer, v.SessionID).TurnActive {
		return nil, pkgerrors.Errorf("conversation already has a running turn")
	}
	if source, ok := s.agent.(interface {
		SessionConfiguration(string, string) (json.RawMessage, json.RawMessage, bool)
	}); ok {
		if _, _, found := source.SessionConfiguration(v.AgentServer, v.SessionID); !found {
			if err = s.restoreSession(ctx, &v, g); err != nil {
				return nil, err
			}
		}
	}

	if err = s.launch(ctx, &v, a, g); err != nil {
		return nil, err
	}
	return map[string]any{"conversationId": v.ID, "turnId": v.TurnID, "cursor": v.Cursor}, nil
}
func (s *Service) steer(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	if a.RequestID != "" {
		return nil, pkgerrors.Errorf("steering does not support requestId; inspect the turn before retrying an uncertain delivery")
	}
	v, err := s.view(ctx, a.ConversationID, g)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Text) == "" {
		return nil, pkgerrors.Errorf("text is required")
	}

	return s.agent.Steer(ctx, &methods.ACPSteerParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: v.AgentServer}, ACPSteerRequest: methods.ACPSteerRequest{SessionID: acpsdk.SessionId(v.SessionID), Prompt: content(a.Text), Meta: expectedTurnMeta(a.TurnID)}}, g)
}
func (s *Service) stop(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	v, err := s.view(ctx, a.ConversationID, g)
	if err != nil {
		return nil, err
	}

	_, err = s.agent.Cancel(ctx, &methods.ACPCancelParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: v.AgentServer}, CancelNotification: acpsdk.CancelNotification{SessionId: acpsdk.SessionId(v.SessionID), Meta: expectedTurnMeta(a.TurnID)}}, g)
	return map[string]any{"conversationId": v.ID, "cancelRequested": err == nil}, err
}

func compactText(text string, max int) string {
	r := []rune(text)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return text
}

func expectedTurnMeta(id string) map[string]any {
	if id == "" {
		return nil
	}
	return map[string]any{"camber/expectedTurnId": id}
}

// initialize uses the desktop's existing ACP capabilities. Initialize is a
// cached no-op when another surface has already started the agent process.
func (s *Service) initialize(ctx context.Context, agent string, g *glsp.Context) error {
	if initializer, ok := s.agent.(interface {
		Initialize(context.Context, *methods.ACPInitializeParams, *glsp.Context) (*methods.ACPInitializeOutput, error)
	}); ok {
		var request acpsdk.InitializeRequest
		err := json.Unmarshal([]byte(`{"protocolVersion":1,"clientInfo":{"name":"camber-desktop","version":"local"},"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false,"auth":{"terminal":true},"_meta":{"terminal-auth":true,"subagent-transcript":true}},"_meta":{"terminal-auth":true}}`), &request)
		if err != nil {
			return pkgerrors.WithStack(err)
		}
		_, err = initializer.Initialize(ctx, &methods.ACPInitializeParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: agent}, InitializeRequest: request}, g)
		return err
	}
	return nil
}

// displayView combines durable lineage/results with actual live UI or CLI
// session state, without overwriting orchestration records owned by a turn.
func (s *Service) displayView(ctx context.Context, id string, g *glsp.Context) (View, error) {
	v, err := s.view(ctx, id, g)
	if err != nil {
		return v, err
	}
	return s.withLiveState(v), nil
}

func (s *Service) withLiveState(v View) View {
	if source, ok := s.agent.(interface {
		CurrentTurn(string, string) (string, string, bool)
	}); ok {
		if turn, status, found := source.CurrentTurn(v.AgentServer, v.SessionID); found {
			if turn != v.TurnID {
				v.TurnID = turn
				v.Cursor = s.log.TurnCursor(v.AgentServer, v.SessionID)
				v.EndCursor = ""
				v.Result = nil
				v.Error = ""
			}
			v.Status = status
		}
	}
	if source, ok := s.agent.(interface {
		SessionConfiguration(string, string) (json.RawMessage, json.RawMessage, bool)
	}); ok {
		if options, modes, found := source.SessionConfiguration(v.AgentServer, v.SessionID); found {
			v.ConfigOptions = options
			v.Modes = modes
		}
	}
	if v.LiveStatus != nil && v.LiveStatus.WaitingForUser {
		v.Status = "waiting_for_input"
	}
	return v
}

func (s *Service) reserveIdle(ctx context.Context, agent, session string) (func(), error) {
	if source, ok := s.agent.(interface {
		ReserveIdleSession(context.Context, string, string) (func(), error)
	}); ok {
		return source.ReserveIdleSession(ctx, agent, session)
	}
	return func() {}, nil
}

// lockConversation serializes one conversation's preparation and mutations.
// Waiting is cancellable; unrelated conversations and stop/steer remain usable.
func (s *Service) lockConversation(ctx context.Context, id string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		if done, busy := s.operations[id]; busy {
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-done:
				continue
			}
		}
		if s.operations == nil {
			s.operations = make(map[string]chan struct{})
		}
		done := make(chan struct{})
		s.operations[id] = done
		s.mu.Unlock()
		var once sync.Once
		return func() { once.Do(func() { s.mu.Lock(); delete(s.operations, id); close(done); s.mu.Unlock() }) }, nil
	}
}
