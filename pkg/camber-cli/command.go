package cambercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// Caller is the desktop control transport; supplied implementations are useful to embedders.
type Caller interface {
	Call(context.Context, string, any) (json.RawMessage, error)
}

// NewCommand builds the CLI without starting or owning an agent process.
func NewCommand() *cobra.Command { return NewCommandWithClient(&Client{}) }

func NewCommandWithClient(caller Caller) *cobra.Command {
	var instanceID string
	var callerToken string
	var jsonOutput bool
	var timeout time.Duration
	root := &cobra.Command{Use: "poolside", Short: "Control a running Camber desktop", SilenceUsage: true, SilenceErrors: true}
	root.PersistentFlags().StringVar(&instanceID, "instance", os.Getenv("CAMBER_INSTANCE_ID"), "Desktop instance ID (otherwise use inherited context or the unique running instance)")
	root.PersistentFlags().StringVar(&callerToken, "caller-token", os.Getenv("CAMBER_CALLER_TOKEN"), "Caller token from your Camber host context; proves which conversation is asking (needed for permission-bypass modes on chat spawn and chat config set)")
	root.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Print structured JSON (NDJSON when following)")
	root.PersistentFlags().DurationVar(&timeout, "timeout", 10*time.Minute, "Deadline for each desktop request (including workspace setup)")
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		if client, ok := caller.(*Client); ok {
			client.InstanceID = instanceID
			client.Timeout = timeout
		}
		return nil
	}
	emit := func(cmd *cobra.Command, value json.RawMessage) error {
		if !json.Valid(value) {
			return errors.New("desktop returned invalid JSON")
		}
		if jsonOutput {
			return writeJSON(cmd.OutOrStdout(), value, false)
		}
		return writeJSON(cmd.OutOrStdout(), value, true)
	}
	dispatch := func(cmd *cobra.Command, name string, args map[string]any) (json.RawMessage, error) {
		params := map[string]any{"command": name, "args": args}
		if callerToken != "" {
			params["callerToken"] = callerToken
		}
		return caller.Call(cmd.Context(), "camber/control/dispatch", params)
	}
	run := func(name string, build func(*cobra.Command, []string) (map[string]any, error)) func(*cobra.Command, []string) error {
		return func(cmd *cobra.Command, args []string) error {
			input, err := build(cmd, args)
			if err != nil {
				return err
			}
			value, err := dispatch(cmd, name, input)
			if err != nil {
				return err
			}
			return emit(cmd, value)
		}
	}
	empty := func(*cobra.Command, []string) (map[string]any, error) { return map[string]any{}, nil }
	add := func(parent *cobra.Command, use, summary, name string, args cobra.PositionalArgs, build func(*cobra.Command, []string) (map[string]any, error)) *cobra.Command {
		cmd := &cobra.Command{Use: use, Short: summary, Args: args, RunE: run(name, build)}
		parent.AddCommand(cmd)
		return cmd
	}
	group := func(name, summary string) *cobra.Command {
		cmd := &cobra.Command{Use: name, Short: summary}
		root.AddCommand(cmd)
		return cmd
	}
	chatArgs := func(cmd *cobra.Command, args []string) (map[string]any, error) {
		id := os.Getenv("CAMBER_CONVERSATION_ID")
		if len(args) > 0 {
			id = args[0]
		}
		if id == "" {
			return nil, errors.New("a conversation ID is required (or set CAMBER_CONVERSATION_ID)")
		}
		return map[string]any{"conversationId": id}, nil
	}
	instances := group("instances", "Discover running desktop instances")
	instances.AddCommand(&cobra.Command{Use: "list", Short: "List live, identity-verified desktops", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		client, ok := caller.(*Client)
		if !ok {
			return errors.New("instance discovery requires the desktop transport")
		}
		value, err := client.Instances(cmd.Context())
		if err != nil {
			return err
		}
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return emit(cmd, data)
	}})
	root.AddCommand(&cobra.Command{Use: "status", Short: "Inspect the selected desktop connection", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		value, err := caller.Call(cmd.Context(), "camber/control/status", map[string]any{})
		if err != nil {
			return err
		}
		return emit(cmd, value)
	}})
	add(root, "context", "Inspect inherited caller context", "context", cobra.NoArgs, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"conversationId": os.Getenv("CAMBER_CONVERSATION_ID"), "projectPath": os.Getenv("CAMBER_PROJECT_PATH"), "workspacePath": os.Getenv("CAMBER_WORKSPACE_PATH")}, nil
	})
	actions := group("actions", "Discover registered desktop actions")
	add(actions, "list", "List supported actions", "actions.list", cobra.NoArgs, empty)
	add(actions, "describe ACTION", "Inspect an action's contract", "actions.describe", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"name": args[0]}, nil
	})
	var actionInput string
	do := &cobra.Command{Use: "do ACTION", Short: "Invoke a registered action", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		input, err := readObject(actionInput, cmd.InOrStdin())
		if err != nil {
			return err
		}
		value, err := dispatch(cmd, args[0], input)
		if err != nil {
			return err
		}
		return emit(cmd, value)
	}}
	do.Flags().StringVar(&actionInput, "input", "{}", "JSON argument object, @file, or @- for stdin")
	root.AddCommand(do)
	agents := group("agents", "Discover agents and their configuration")
	add(agents, "list", "List available agents", "agents.list", cobra.NoArgs, empty)
	agentArgs := func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"agentServer": args[0], "workspacePath": getString(cmd, "workspace")}, nil
	}
	inspectAgent := add(agents, "inspect AGENT", "Inspect an agent and its configuration", "agents.inspect", cobra.ExactArgs(1), agentArgs)
	inspectAgent.Flags().String("workspace", "", "Workspace path used for session-specific options")
	agentConfig := &cobra.Command{Use: "config", Short: "Agent configuration discovery"}
	agents.AddCommand(agentConfig)
	options := add(agentConfig, "options AGENT", "Discover option schemas, allowed values, and defaults", "agents.config.options", cobra.ExactArgs(1), agentArgs)
	options.Flags().String("workspace", "", "Workspace path used for session-specific options")
	projects := group("projects", "Discover projects")
	add(projects, "list", "List projects", "projects.list", cobra.NoArgs, empty)
	worktrees := group("worktrees", "Inspect and manage project worktrees")
	listWorktrees := add(worktrees, "list", "List project worktrees", "worktrees.list", cobra.NoArgs, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"projectPath": getString(cmd, "project")}, nil
	})
	listWorktrees.Flags().String("project", os.Getenv("CAMBER_PROJECT_PATH"), "Project path")
	inspectWorktree := add(worktrees, "inspect PATH", "Inspect a worktree", "worktrees.inspect", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"workspacePath": args[0], "projectPath": getString(cmd, "project")}, nil
	})
	inspectWorktree.Flags().String("project", os.Getenv("CAMBER_PROJECT_PATH"), "Project path")
	createWorktree := add(worktrees, "create NAME", "Create a project worktree", "worktrees.create", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"projectPath": getString(cmd, "project"), "worktreeName": args[0]}, nil
	})
	createWorktree.Flags().String("project", os.Getenv("CAMBER_PROJECT_PATH"), "Project path")
	removeWorktree := add(worktrees, "remove PATH", "Remove a worktree through normal application validation", "worktrees.remove", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"projectPath": getString(cmd, "project"), "workspacePath": args[0]}, nil
	})
	removeWorktree.Flags().String("project", os.Getenv("CAMBER_PROJECT_PATH"), "Project path")
	chat := group("chat", "Create, configure, and observe conversations")
	add(chat, "list", "List conversations", "chat.list", cobra.NoArgs, empty)
	for _, name := range []string{"inspect", "children", "snapshot"} {
		add(chat, name+" [CHAT]", "Inspect or select a conversation", "chat."+name, cobra.MaximumNArgs(1), chatArgs)
	}
	config := &cobra.Command{Use: "config", Short: "Inspect and change effective conversation configuration"}
	chat.AddCommand(config)
	add(config, "list [CHAT]", "Inspect effective options, values, and modes", "chat.config.list", cobra.MaximumNArgs(1), chatArgs)
	set := add(config, "set CHAT [KEY]", "Set one option or a batch before the next prompt", "chat.config.set", cobra.RangeArgs(1, 2), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		input, err := configuration(cmd, args)
		if err != nil {
			return nil, err
		}
		return map[string]any{"conversationId": args[0], "config": input, "model": getString(cmd, "model"), "effort": getString(cmd, "effort"), "mode": getString(cmd, "mode")}, nil
	})
	configFlags(set)
	set.Flags().String("value-json", "", "JSON string or boolean value for KEY")
	spawn := add(chat, "spawn [PARENT]", "Create a child and apply configuration before its initial prompt", "chat.spawn", cobra.MaximumNArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		parent := os.Getenv("CAMBER_CONVERSATION_ID")
		if len(args) > 0 {
			parent = args[0]
		}
		cfg, err := configuration(cmd, nil)
		if err != nil {
			return nil, err
		}
		text, err := readText(getString(cmd, "text"), cmd.InOrStdin())
		if err != nil {
			return nil, err
		}
		return map[string]any{"parentId": parent, "agentServer": getString(cmd, "agent"), "workspacePath": getString(cmd, "workspace"), "projectPath": getString(cmd, "project"), "worktreeName": getString(cmd, "new-worktree"), "config": cfg, "model": getString(cmd, "model"), "effort": getString(cmd, "effort"), "mode": getString(cmd, "mode"), "text": text, "requestId": getString(cmd, "request-id")}, nil
	})
	configFlags(spawn)
	spawn.Flags().String("agent", "", "Destination agent ID")
	spawn.Flags().String("workspace", "", "Existing workspace path")
	spawn.Flags().String("worktree", "", "Alias for --workspace")
	spawn.Flags().String("project", os.Getenv("CAMBER_PROJECT_PATH"), "Project path")
	spawn.Flags().String("new-worktree", "", "New worktree name")
	spawn.Flags().String("text", "", "Initial prompt, @file, or @- for stdin")
	spawn.Flags().String("request-id", "", "Caller-supplied request ID")
	spawn.Flags().String("idempotency-key", "", "Alias for --request-id")
	for _, name := range []string{"send", "steer"} {
		command := &cobra.Command{Use: name + " [CHAT]", Short: "Submit a prompt to an existing conversation", Args: cobra.MaximumNArgs(1)}
		command.Flags().String("text", "", "Prompt text, @file, or @- for stdin")
		if name == "steer" {
			command.Flags().String("turn", "", "Target turn ID")
		} else {
			command.Flags().String("request-id", "", "Caller-supplied request ID")
			command.Flags().String("idempotency-key", "", "Alias for --request-id")
		}
		command.Flags().Bool("follow", false, "Observe output after submitting; disconnecting never stops generation")
		command.RunE = func(cmd *cobra.Command, args []string) error {
			input, err := chatArgs(cmd, args)
			if err != nil {
				return err
			}
			text, err := readText(getString(cmd, "text"), cmd.InOrStdin())
			if err != nil {
				return err
			}
			if text == "" {
				return errors.New("--text is required")
			}
			input["text"] = text
			input["requestId"] = getString(cmd, "request-id")
			if name == "steer" {
				input["turnId"] = getString(cmd, "turn")
			}
			value, err := dispatch(cmd, "chat."+name, input)
			if err != nil {
				return err
			}
			follow, _ := cmd.Flags().GetBool("follow")
			if !follow {
				return emit(cmd, value)
			}
			if err = writeJSON(cmd.OutOrStdout(), value, false); err != nil {
				return err
			}
			var started struct {
				ConversationID string `json:"conversationId"`
				TurnID         string `json:"turnId"`
				Cursor         string `json:"cursor"`
			}
			if err = json.Unmarshal(value, &started); err != nil {
				return err
			}
			if started.ConversationID == "" {
				started.ConversationID = input["conversationId"].(string)
			}
			return followConversation(cmd, dispatch, started.ConversationID, started.TurnID, started.Cursor)
		}
		chat.AddCommand(command)
	}
	stop := add(chat, "stop [CHAT]", "Explicitly cancel generation for a conversation", "chat.stop", cobra.MaximumNArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		input, err := chatArgs(cmd, args)
		if err != nil {
			return nil, err
		}
		input["turnId"] = getString(cmd, "turn")
		return input, nil
	})
	stop.Flags().String("turn", "", "Target turn ID")
	for _, name := range []string{"poll", "output", "watch"} {
		command := &cobra.Command{Use: name + " [CHAT]", Short: "Read conversation output with a reusable cursor", Args: cobra.MaximumNArgs(1)}
		command.Flags().String("cursor", "", "Resume after this opaque output cursor")
		command.Flags().String("turn", "", "Observe a specific turn")
		command.Flags().Int("wait-ms", 0, "Wait up to this many milliseconds for new output (maximum 30000)")
		command.Flags().Bool("follow", name == "watch", "Follow output as NDJSON until the turn completes")
		command.RunE = func(cmd *cobra.Command, args []string) error {
			input, err := chatArgs(cmd, args)
			if err != nil {
				return err
			}
			cursor := getString(cmd, "cursor")
			turn := getString(cmd, "turn")
			wait, _ := cmd.Flags().GetInt("wait-ms")
			if wait < 0 || wait > 30000 {
				return errors.New("--wait-ms must be between 0 and 30000")
			}
			follow, _ := cmd.Flags().GetBool("follow")
			if follow {
				return followConversation(cmd, dispatch, input["conversationId"].(string), turn, cursor)
			}
			input["cursor"] = cursor
			input["turnId"] = turn
			input["waitMs"] = wait
			method := name
			if method == "watch" {
				method = "poll"
			}
			value, err := dispatch(cmd, "chat."+method, input)
			if err != nil {
				return err
			}
			return emit(cmd, value)
		}
		chat.AddCommand(command)
	}
	skill := group("skill", "Load the installed desktop's agent guide")
	show := &cobra.Command{Use: "show [TOPIC]", Short: "Print the selected desktop's current guide", Args: cobra.MaximumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		topic := ""
		if len(args) > 0 {
			topic = args[0]
		}
		value, err := dispatch(cmd, "skill.show", map[string]any{"topic": topic})
		if err != nil {
			return err
		}
		if jsonOutput {
			return emit(cmd, value)
		}
		var guide struct {
			Guide string `json:"guide"`
			Text  string `json:"text"`
		}
		if json.Unmarshal(value, &guide) == nil {
			text := guide.Guide
			if text == "" {
				text = guide.Text
			}
			if text != "" {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), text)
				return err
			}
		}
		var text string
		if json.Unmarshal(value, &text) == nil {
			_, err = fmt.Fprintln(cmd.OutOrStdout(), text)
			return err
		}
		return emit(cmd, value)
	}}
	skill.AddCommand(show)
	addInstallCommands(root, skill, emit)
	return root
}

func configFlags(cmd *cobra.Command) {
	cmd.Flags().String("input", "{}", "Configuration JSON object, @file, or @- for stdin")
	cmd.Flags().String("config", "", "Alias for --input")
	cmd.Flags().String("model", "", "Model ID from discovered options")
	cmd.Flags().String("effort", "", "Reasoning effort from discovered options")
	cmd.Flags().String("mode", "", "Agent mode ID")
}
func getString(cmd *cobra.Command, name string) string {
	value, _ := cmd.Flags().GetString(name)
	aliases := map[string]string{"input": "config", "workspace": "worktree", "request-id": "idempotency-key"}
	if alias := aliases[name]; alias != "" && cmd.Flags().Lookup(alias) != nil && cmd.Flags().Changed(alias) && !cmd.Flags().Changed(name) {
		value, _ = cmd.Flags().GetString(alias)
	}
	return value
}
func configuration(cmd *cobra.Command, args []string) (map[string]any, error) {
	input, err := readObject(getString(cmd, "input"), cmd.InOrStdin())
	if err != nil {
		return nil, err
	}
	if len(args) == 2 {
		if cmd.Flags().Changed("input") || cmd.Flags().Changed("config") {
			return nil, errors.New("use KEY --value-json or --input, rather than both")
		}
		raw := getString(cmd, "value-json")
		if raw == "" {
			return nil, errors.New("--value-json is required with KEY")
		}
		var value any
		if err = json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, fmt.Errorf("invalid --value-json: %w", err)
		}
		input[args[1]] = value
	} else if cmd.Flags().Lookup("value-json") != nil && cmd.Flags().Changed("value-json") {
		return nil, errors.New("KEY is required with --value-json")
	}
	for key, value := range input {
		switch value.(type) {
		case string, bool:
		default:
			return nil, fmt.Errorf("configuration %q must be a string or boolean", key)
		}
	}
	return input, nil
}
func readObject(value string, stdin io.Reader) (map[string]any, error) {
	text, err := readText(value, stdin)
	if err != nil {
		return nil, err
	}
	var object map[string]any
	if err = json.Unmarshal([]byte(text), &object); err != nil {
		return nil, fmt.Errorf("invalid JSON object: %w", err)
	}
	if object == nil {
		return nil, errors.New("input must be a JSON object")
	}
	return object, nil
}
func readText(value string, stdin io.Reader) (string, error) {
	if strings.HasPrefix(value, "@@") {
		return strings.TrimPrefix(value, "@"), nil
	}
	if value == "@-" || value == "-" {
		data, err := io.ReadAll(io.LimitReader(stdin, maxFrameBytes+1))
		if len(data) > maxFrameBytes {
			return "", errors.New("input exceeds 1 MiB")
		}
		return string(data), err
	}
	if strings.HasPrefix(value, "@") {
		data, err := os.ReadFile(strings.TrimPrefix(value, "@"))
		if len(data) > maxFrameBytes {
			return "", errors.New("input exceeds 1 MiB")
		}
		return string(data), err
	}
	return value, nil
}
func writeJSON(writer io.Writer, value json.RawMessage, pretty bool) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	if pretty {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(value)
}
func followConversation(cmd *cobra.Command, dispatch func(*cobra.Command, string, map[string]any) (json.RawMessage, error), conversationID, turnID, cursor string) error {
	retries := 0
	previousWaiting := ""
	for {
		value, err := dispatch(cmd, "chat.poll", map[string]any{"conversationId": conversationID, "turnId": turnID, "cursor": cursor, "waitMs": 30000})
		if err != nil {
			// Polling is read-only. Retry a dropped reader from the last emitted
			// cursor, never resubmitting a prompt or hiding prolonged failure.
			if retries < 3 && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)) {
				timer := time.NewTimer(100 * time.Millisecond << retries)
				retries++
				select {
				case <-cmd.Context().Done():
					timer.Stop()
					return cmd.Context().Err()
				case <-timer.C:
					continue
				}
			}
			return err
		}
		retries = 0
		var page struct {
			Cursor        string `json:"cursor"`
			NextCursor    string `json:"nextCursor"`
			TurnActive    bool   `json:"turnActive"`
			HasMore       bool   `json:"hasMore"`
			ResetRequired bool   `json:"resetRequired"`
			Terminal      bool   `json:"terminal"`
			Status        string `json:"status"`
			Error         string `json:"error"`
		}
		if err = json.Unmarshal(value, &page); err != nil {
			return err
		}
		if page.Status != "waiting_for_input" || string(value) != previousWaiting {
			if err = writeJSON(cmd.OutOrStdout(), value, false); err != nil {
				return err
			}
		}
		previousWaiting = ""
		if page.Status == "waiting_for_input" {
			previousWaiting = string(value)
		}
		if page.ResetRequired {
			return errors.New("output cursor expired; retained output is incomplete; inspect chat snapshot and the desktop transcript")
		}
		if page.NextCursor != "" {
			cursor = page.NextCursor
		} else {
			cursor = page.Cursor
		}
		if !page.HasMore && page.Status != "waiting_for_input" && (page.Terminal || !page.TurnActive) {
			switch page.Status {
			case "completed":
				return nil
			case "failed", "cancelled", "interrupted":
				if page.Error != "" {
					return fmt.Errorf("turn %s: %s", page.Status, page.Error)
				}
				return fmt.Errorf("turn %s", page.Status)
			default:
				return fmt.Errorf("no completed turn observed (status %q)", page.Status)
			}
		}
		// Pending interactions return immediately so polling callers can act.
		// A streaming reader should not flood stdout while waiting for a person.
		delay := 50 * time.Millisecond
		if page.Status == "waiting_for_input" {
			delay = 5 * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-cmd.Context().Done():
			timer.Stop()
			return cmd.Context().Err()
		case <-timer.C:
		}
	}
}
