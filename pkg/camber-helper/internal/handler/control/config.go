package control

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type option struct {
	ID       string            `json:"id"`
	Category string            `json:"category"`
	Type     string            `json:"type"`
	Current  any               `json:"currentValue"`
	Options  []json.RawMessage `json:"options"`
}

func parseOptions(raw json.RawMessage) []option {
	var out []option
	_ = json.Unmarshal(raw, &out)
	return out
}
func allowed(raw []json.RawMessage, value string) bool {
	for _, r := range raw {
		var v struct {
			Value   string            `json:"value"`
			Options []json.RawMessage `json:"options"`
		}
		if json.Unmarshal(r, &v) == nil && (v.Value == value || allowed(v.Options, value)) {
			return true
		}
	}
	return false
}

// configSetsCategory reports whether config sets any option of the child
// schema that belongs to category (by category, or by the conventional id).
func configSetsCategory(child json.RawMessage, config map[string]any, category string) bool {
	for _, o := range parseOptions(child) {
		if _, ok := config[o.ID]; ok && optionInCategory(o, category) {
			return true
		}
	}
	return false
}

func optionInCategory(o option, category string) bool {
	return o.Category == category || o.ID == category || (category == "thought_level" && (o.ID == "reasoning_effort" || o.ID == "effort"))
}

func inheritCompatible(parent, child json.RawMessage, a Args) map[string]any {
	explicit := a.Config
	skip := map[string]bool{}
	for _, category := range []string{"model", "thought_level", "mode"} {
		if configSetsCategory(child, explicit, category) {
			skip[category] = true
		}
	}
	out := map[string]any{}
	byID := map[string]option{}
	for _, o := range parseOptions(child) {
		byID[o.ID] = o
	}
	for _, p := range parseOptions(parent) {
		o, ok := byID[p.ID]
		if !ok {
			continue
		}
		if (a.Model != "" || skip["model"]) && optionInCategory(o, "model") {
			continue
		}
		if (a.Effort != "" || skip["thought_level"]) && optionInCategory(o, "thought_level") {
			continue
		}
		if (a.Mode != "" || skip["mode"]) && optionInCategory(o, "mode") {
			continue
		}
		switch o.Type {
		case "select":
			text, ok := p.Current.(string)
			if ok && allowed(o.Options, text) {
				out[p.ID] = text
			}
		case "boolean":
			if v, ok := p.Current.(bool); ok {
				out[p.ID] = v
			}
		}
	}
	for k, v := range explicit {
		out[k] = v
	}
	return out
}

func (s *Service) configure(ctx context.Context, a Args, set bool, g *glsp.Context) (any, error) {
	releaseOperation, lockErr := s.lockConversation(ctx, a.ConversationID)
	if lockErr != nil {
		return nil, lockErr
	}
	defer releaseOperation()
	v, err := s.view(ctx, a.ConversationID, g)
	if err != nil {
		return nil, err
	}
	cached := false
	if source, ok := s.agent.(interface {
		SessionConfiguration(string, string) (json.RawMessage, json.RawMessage, bool)
	}); ok {
		if options, modes, found := source.SessionConfiguration(v.AgentServer, v.SessionID); found {
			v.ConfigOptions = options
			v.Modes = modes
			cached = true
			if !set {
				return map[string]any{"conversationId": v.ID, "configOptions": options, "modes": modes}, nil
			}
		}
	}
	if set {
		refs := []View{v}
		if v.ParentID != "" {
			if parent, perr := s.view(ctx, v.ParentID, g); perr == nil {
				refs = append(refs, parent)
			}
		}
		if err = s.checkEscalation(a, "the conversation or its parent", refs); err != nil {
			return nil, err
		}
	}
	if v.Status == "running" || s.log.Cursor(v.AgentServer, v.SessionID).TurnActive {
		return nil, pkgerrors.Errorf("configuration discovery and changes require an idle conversation")
	}
	release, err := s.reserveIdle(ctx, v.AgentServer, v.SessionID)
	if err != nil {
		return nil, err
	}
	defer release()
	if !cached {
		if err = s.restoreSessionReserved(ctx, &v, g); err != nil {
			return nil, err
		}
	}

	if set {
		if len(a.Config) == 0 && a.Model == "" && a.Effort == "" && a.Mode == "" {
			return nil, pkgerrors.Errorf("config, model, effort or mode is required")
		}
		if err = s.applyConfig(ctx, &v, a, g); err != nil {
			return nil, err
		}
	}
	if err = s.save(ctx, v); err != nil {
		return nil, err
	}
	return map[string]any{"conversationId": v.ID, "configOptions": v.ConfigOptions, "modes": v.Modes}, nil
}
func (s *Service) applyConfig(ctx context.Context, v *View, a Args, g *glsp.Context) error {
	return s.applyConfigWithPersistence(ctx, v, a, g, true)
}

// Explicit updates retain accepted partial changes. Restoration must preserve
// the saved selections until all of them have been successfully reapplied.
func (s *Service) applyConfigWithPersistence(ctx context.Context, v *View, a Args, g *glsp.Context, persist bool) (resultErr error) {
	if persist {
		defer func() {
			if persistErr := s.persistSessionConfig(context.WithoutCancel(ctx), v, g); resultErr == nil && persistErr != nil {
				resultErr = persistErr
			}
		}()
	}
	opts := parseOptions(v.ConfigOptions)
	values := map[string]any{}
	for k, x := range a.Config {
		values[k] = x
	}
	for category, value := range map[string]string{"model": a.Model, "thought_level": a.Effort, "mode": a.Mode} {
		if value == "" {
			continue
		}
		found := ""
		for _, o := range opts {
			if o.Category == category || o.ID == category || (category == "thought_level" && (o.ID == "reasoning_effort" || o.ID == "effort")) {
				if found != "" && found != o.ID {
					return pkgerrors.Errorf("multiple %s options; use an explicit option id", category)
				}
				found = o.ID
			}
		}
		if found == "" {
			if category == "mode" {
				continue
			}
			return pkgerrors.Errorf("agent does not expose a %s configuration option", category)
		}
		if prior, ok := values[found]; ok && prior != value {
			return pkgerrors.Errorf("conflicting values for option %s", found)
		}
		values[found] = value
	}
	// Validate option identities and wire types before changing the model. A
	// model change may advertise a different set of effort values, so validate
	// those selections against the authoritative schema returned afterwards.
	initial := map[string]option{}
	for _, o := range opts {
		initial[o.ID] = o
	}
	for id, value := range values {
		o, ok := initial[id]
		if !ok {
			return pkgerrors.Errorf("unknown configuration option %q", id)
		}
		if o.Type == "boolean" {
			if _, ok := value.(bool); !ok {
				return pkgerrors.Errorf("configuration option %s requires a boolean", id)
			}
		} else if o.Type == "select" {
			if _, ok := value.(string); !ok {
				return pkgerrors.Errorf("configuration option %s requires a string", id)
			}
		} else {
			return pkgerrors.Errorf("unsupported configuration option type %q", o.Type)
		}
	}
	for _, o := range opts {
		if o.Category != "model" && o.ID != "model" {
			continue
		}
		value, wanted := values[o.ID]
		if !wanted || value == o.Current {
			continue
		}
		if text, ok := value.(string); !ok || !allowed(o.Options, text) {
			return pkgerrors.Errorf("unsupported value for configuration option %s", o.ID)
		}
		if len(values) > 1 {
			modelOnly := Args{Config: map[string]any{o.ID: value}}
			if err := s.applyConfigWithPersistence(ctx, v, modelOnly, g, persist); err != nil {
				return err
			}
			opts = parseOptions(v.ConfigOptions)
		}
		break
	}
	// A later failure can leave the requested model applied. Explicit updates
	// persist this effective state; failed restoration will invalidate it.

	byID := map[string]option{}
	for _, o := range opts {
		byID[o.ID] = o
	}
	for id, value := range values {
		o, ok := byID[id]
		if !ok {
			return pkgerrors.Errorf("unknown configuration option %q", id)
		}
		switch o.Type {
		case "boolean":
			if _, ok = value.(bool); !ok {
				return pkgerrors.Errorf("configuration option %s requires a boolean", id)
			}
		case "select":
			text, ok := value.(string)
			if !ok || !allowed(o.Options, text) {
				return pkgerrors.Errorf("unsupported value for configuration option %s", id)
			}
		default:
			return pkgerrors.Errorf("unsupported configuration option type %q", o.Type)
		}
	}
	modeLegacy := a.Mode != ""
	for _, o := range opts {
		if o.Category == "mode" || o.ID == "mode" {
			modeLegacy = false
		}
	}
	if modeLegacy {
		var modes struct {
			Available []struct {
				ID string `json:"id"`
			} `json:"availableModes"`
		}
		_ = json.Unmarshal(v.Modes, &modes)
		valid := false
		for _, m := range modes.Available {
			if m.ID == a.Mode {
				valid = true
			}
		}
		if !valid {
			return pkgerrors.Errorf("unsupported mode %q", a.Mode)
		}
	}
	ids := make([]string, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if byID[ids[i]].Category == "model" {
			return byID[ids[j]].Category != "model"
		}
		if byID[ids[j]].Category == "model" {
			return false
		}
		return ids[i] < ids[j]
	})
	for _, id := range ids {
		if byID[id].Current == values[id] {
			continue
		}
		payload := map[string]any{"sessionId": v.SessionID, "configId": id, "value": values[id]}
		if byID[id].Type == "boolean" {
			payload["type"] = "boolean"
		}
		raw, _ := json.Marshal(payload)
		var req acpsdk.SetSessionConfigOptionRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return pkgerrors.WithStack(err)
		}
		resp, err := s.agent.SetConfigOption(ctx, &methods.ACPSetConfigOptionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: v.AgentServer}, SetSessionConfigOptionRequest: req}, g)
		if err != nil {
			return err
		}
		v.ConfigOptions, _ = captureConfig(resp)
		if persist {
			if err = s.save(ctx, *v); err != nil {
				return err
			}
		}
	}
	syncLegacyMode(v)
	if modeLegacy {
		_, err := s.agent.SetMode(ctx, &methods.ACPSetModeParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: v.AgentServer}, SetSessionModeRequest: acpsdk.SetSessionModeRequest{SessionId: acpsdk.SessionId(v.SessionID), ModeId: acpsdk.SessionModeId(a.Mode)}}, g)
		if err != nil {
			return err
		}
		var modes map[string]any
		_ = json.Unmarshal(v.Modes, &modes)
		if modes != nil {
			modes["currentModeId"] = a.Mode
			v.Modes, _ = json.Marshal(modes)
		}
	}
	// Agent responses are authoritative: reject a silently ignored setting.
	current := map[string]any{}
	for _, o := range parseOptions(v.ConfigOptions) {
		current[o.ID] = o.Current
	}
	for id, value := range values {
		if current[id] != value {
			return pkgerrors.Errorf("agent did not apply configuration option %s", id)
		}
	}
	return nil
}

func (s *Service) persistSessionConfig(ctx context.Context, v *View, g *glsp.Context) error {
	if len(v.ConfigOptions) == 0 && len(v.Modes) == 0 {
		return nil
	}
	selections := map[string]any{}
	for _, o := range parseOptions(v.ConfigOptions) {
		switch value := o.Current.(type) {
		case string, bool:
			selections[o.ID] = value
		}
	}
	syncLegacyMode(v)
	var mode struct {
		Current any `json:"currentModeId"`
	}
	_ = json.Unmarshal(v.Modes, &mode)
	snapshot, err := json.Marshal(map[string]any{"selections": selections, "modeId": mode.Current})
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	return s.nav.SetConversationConfig(ctx, v.ID, v.AgentServer, v.SessionID, snapshot, g)
}

func validateConfigKeys(raw json.RawMessage, values map[string]any) error {
	byID := map[string]option{}
	for _, o := range parseOptions(raw) {
		byID[o.ID] = o
	}
	for id, value := range values {
		o, found := byID[id]
		if !found {
			return pkgerrors.Errorf("unknown configuration option %q", id)
		}
		switch o.Type {
		case "select":
			if _, ok := value.(string); !ok {
				return pkgerrors.Errorf("configuration option %s requires a string", id)
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return pkgerrors.Errorf("configuration option %s requires a boolean", id)
			}
		default:
			return pkgerrors.Errorf("unsupported configuration option type %q", o.Type)
		}
	}
	return nil
}

// restoreSession follows the desktop loader's persisted selection semantics
// when a detached conversation is used after helper/agent restart or close.
func (s *Service) restoreSession(ctx context.Context, v *View, g *glsp.Context) error {
	release, err := s.reserveIdle(ctx, v.AgentServer, v.SessionID)
	if err != nil {
		return err
	}
	defer release()
	return s.restoreSessionReserved(ctx, v, g)
}

// The caller already holds the idle-session reservation. Configuration reads
// and partial updates must restore the same saved selections as a continuation.
func (s *Service) restoreSessionReserved(ctx context.Context, v *View, g *glsp.Context) (resultErr error) {
	saved, _, err := savedConfiguration(v.Metadata)
	if err != nil {
		return err
	}
	if err = s.initialize(ctx, v.AgentServer, g); err != nil {
		return err
	}
	defer func() {
		if resultErr != nil {
			// LoadSession and setters populate the live cache before recovery
			// finishes. A failure must force the next operation to retry it.
			if cache, ok := s.agent.(interface {
				InvalidateSessionConfiguration(string, string)
			}); ok {
				cache.InvalidateSessionConfiguration(v.AgentServer, v.SessionID)
			}
		}
	}()
	resp, err := s.agent.LoadSession(ctx, &methods.ACPLoadSessionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: v.AgentServer}, LoadSessionRequest: acpsdk.LoadSessionRequest{SessionId: acpsdk.SessionId(v.SessionID), Cwd: v.Cwd, McpServers: []acpsdk.McpServer{}}}, g)
	if err != nil {
		return err
	}
	v.ConfigOptions, v.Modes = captureConfig(resp)
	if saved.Mode != "" && configSetsCategory(v.ConfigOptions, saved.Config, "mode") {
		// The option is authoritative; never replay both representations.
		saved.Mode = ""
	}
	if len(saved.Config) == 0 && saved.Mode == "" {
		return nil
	}
	// A continuation must not silently substitute a different model or effort
	// when the persisted selection is no longer supported by this agent.
	if err = s.applyConfigWithPersistence(ctx, v, saved, g, false); err != nil {
		return err
	}
	return s.persistSessionConfig(ctx, v, g)
}

func savedConfiguration(raw json.RawMessage) (Args, bool, error) {
	var metadata struct {
		Config *struct {
			Selections map[string]any `json:"selections"`
			Mode       string         `json:"modeId"`
		} `json:"sessionConfig"`
	}
	if len(raw) == 0 {
		return Args{}, false, nil
	}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return Args{}, false, pkgerrors.WithStack(err)
	}
	if metadata.Config == nil {
		return Args{}, false, nil
	}
	return Args{Config: metadata.Config.Selections, Mode: metadata.Config.Mode}, true, nil
}

// Persisted UI selections are authoritative when the parent's session is not
// live. Only supply values here: compatibility is checked against the child's
// discovered schema, after applying its selected model.
func useSavedParentConfiguration(parent *View) error {
	saved, found, err := savedConfiguration(parent.Metadata)
	if err != nil || !found {
		return err
	}
	opts := make([]option, 0, len(saved.Config))
	for id, value := range saved.Config {
		opts = append(opts, option{ID: id, Current: value})
	}
	sort.Slice(opts, func(i, j int) bool { return opts[i].ID < opts[j].ID })
	parent.ConfigOptions, err = json.Marshal(opts)
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	parent.Modes, err = json.Marshal(map[string]any{"currentModeId": saved.Mode})
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	return nil
}

// syncLegacyMode keeps the legacy modes state aligned with a mode-category
// config option, which is authoritative when an agent exposes both.
func syncLegacyMode(v *View) {
	if len(v.Modes) == 0 {
		return
	}
	for _, o := range parseOptions(v.ConfigOptions) {
		if !optionInCategory(o, "mode") {
			continue
		}
		value, ok := o.Current.(string)
		if !ok {
			continue
		}
		var modes map[string]any
		if json.Unmarshal(v.Modes, &modes) != nil || modes == nil {
			return
		}
		available, _ := modes["availableModes"].([]any)
		for _, m := range available {
			if entry, ok := m.(map[string]any); ok && entry["id"] == value {
				modes["currentModeId"] = value
				v.Modes, _ = json.Marshal(modes)
				return
			}
		}
		return
	}
}

// isDangerousModeValue reports permission-bypass mode values (no approval
// gates). Keep in sync with modeValueAppearance in
// ui/packages/features/src/acp/components/chat/menus/config/configOptions.ts.
func isDangerousModeValue(value string) bool {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	switch n := b.String(); n {
	case "alwaysallow", "allowall", "fullaccess", "agentfullaccess", "yolo":
		return true
	default:
		return strings.HasPrefix(n, "bypass")
	}
}

func permissionEscalationError(value, who string) error {
	return &methods.JSONRPCError{Code: methods.CamberErrorCodeEntityInvalid, Message: "PERMISSION_ESCALATION: permission-bypass mode " + strconv.Quote(value) + " cannot be selected through the control CLI unless " + who + " already uses one"}
}

// explicitDangerousValue returns a permission-bypass value the caller asked
// for. It needs no schema, so it can run before any agent-side change.
func explicitDangerousValue(a Args) string {
	for _, v := range []string{a.Mode, a.Model, a.Effort} {
		if isDangerousModeValue(v) {
			return v
		}
	}
	for _, v := range a.Config {
		if text, ok := v.(string); ok && isDangerousModeValue(text) {
			return text
		}
	}
	return ""
}

// optionsDangerous reports whether the effective mode is a bypass mode. A
// mode-category option is authoritative over legacy modes.
func optionsDangerous(options, modes json.RawMessage) bool {
	found := false
	for _, o := range parseOptions(options) {
		if !optionInCategory(o, "mode") {
			continue
		}
		value, ok := o.Current.(string)
		if !ok {
			continue
		}
		found = true
		if isDangerousModeValue(value) {
			return true
		}
		for _, r := range o.Options {
			var entry struct {
				Value string `json:"value"`
				Name  string `json:"name"`
			}
			if json.Unmarshal(r, &entry) == nil && entry.Value == value && isDangerousModeValue(entry.Name) {
				return true
			}
		}
	}
	if found {
		return false
	}
	var legacy struct {
		Current string `json:"currentModeId"`
	}
	_ = json.Unmarshal(modes, &legacy)
	return isDangerousModeValue(legacy.Current)
}

// conversationDangerous reports whether a conversation currently runs in a
// permission-bypass mode, from live session state, else saved selections.
func (s *Service) conversationDangerous(v View) bool {
	if source, ok := s.agent.(interface {
		SessionConfiguration(string, string) (json.RawMessage, json.RawMessage, bool)
	}); ok && v.SessionID != "" {
		if options, modes, found := source.SessionConfiguration(v.AgentServer, v.SessionID); found {
			return optionsDangerous(options, modes)
		}
	}
	if _, found, _ := savedConfiguration(v.Metadata); found {
		saved := v
		if useSavedParentConfiguration(&saved) == nil {
			return optionsDangerous(saved.ConfigOptions, saved.Modes)
		}
	}
	return optionsDangerous(v.ConfigOptions, v.Modes)
}

// checkEscalation rejects explicitly requested bypass modes unless one of the
// reference conversations (target and/or parent) already uses one.
func (s *Service) checkEscalation(a Args, who string, refs []View) error {
	value := explicitDangerousValue(a)
	if value == "" {
		return nil
	}
	for _, ref := range refs {
		if s.conversationDangerous(ref) {
			return nil
		}
	}
	return permissionEscalationError(value, who)
}
