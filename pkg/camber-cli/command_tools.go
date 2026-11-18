package cambercli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// Agents, MCP connectors, skills and local models. Each command dispatches a
// helper action that runs the desktop's own handler for the operation (see
// control/tools*.go). Commands that define something the desktop will run or
// connect to need --caller-token from a conversation in a permission-bypass
// mode; secret values are read from files or stdin and never printed.
func init() {
	registerCommandExtension(addAgentToolCommands)
	registerCommandExtension(addMCPCommands)
	registerCommandExtension(addSkillsAndModelsCommands)
}

const bypassNote = " Needs --caller-token from a conversation running in a permission-bypass mode."

func addAgentToolCommands(kit CommandKit) {
	agents := kit.Group("agents", "Discover agents and their configuration")
	agentArg := func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"agentServer": args[0]}, nil
	}
	kit.Add(agents, "install AGENT", "Install an agent from the ACP registry, as Settings > Agents does."+bypassNote, "agents.install", cobra.ExactArgs(1), agentArg)
	definition := func(add bool) func(*cobra.Command, []string) (map[string]any, error) {
		return func(cmd *cobra.Command, args []string) (map[string]any, error) {
			input := map[string]any{"agentServer": args[0]}
			if cmd.Flags().Changed("command") {
				input["command"] = getString(cmd, "command")
			}
			if err := argsInput(cmd, input); err != nil {
				return nil, err
			}
			env, err := keyValueInput(cmd, "env", "env-file")
			if err != nil {
				return nil, err
			}
			if len(env) > 0 {
				input["env"] = env
			}
			if !add {
				if unset, _ := cmd.Flags().GetStringArray("unset-env"); len(unset) > 0 {
					input["unsetEnv"] = unset
				}
			}
			return input, nil
		}
	}
	addAgent := kit.Add(agents, "add AGENT", "Add a custom agent server (an assistant.json entry)."+bypassNote, "agents.add", cobra.ExactArgs(1), definition(true))
	editAgent := kit.Add(agents, "edit AGENT", "Change a custom agent server's command, arguments or environment."+bypassNote, "agents.edit", cobra.ExactArgs(1), definition(false))
	for _, cmd := range []*cobra.Command{addAgent, editAgent} {
		cmd.Flags().String("command", "", "Executable that speaks ACP over stdio")
		argsFlags(cmd)
		keyValueFlags(cmd, "env", "env-file", "an environment variable")
	}
	editAgent.Flags().StringArray("unset-env", nil, "Environment variable to remove (repeatable)")
	kit.Add(agents, "remove AGENT", "Remove (disable) an agent and archive its conversations, as Settings > Agents does."+bypassNote, "agents.remove", cobra.ExactArgs(1), agentArg)
	defaultAgent := kit.Add(agents, "default [AGENT]", "Pin the default agent for new conversations, or --unpin to let it follow the last used agent", "agents.default", cobra.MaximumNArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		unpin, _ := cmd.Flags().GetBool("unpin")
		if unpin == (len(args) == 1) {
			return nil, errors.New("pass AGENT to pin a default agent, or --unpin alone")
		}
		if unpin {
			return map[string]any{"unpin": true}, nil
		}
		return map[string]any{"agentServer": args[0]}, nil
	})
	defaultAgent.Flags().Bool("unpin", false, "Release the default-agent pin")
	config := subcommand(agents, "config", "Agent configuration discovery")
	configDefault := kit.Add(config, "default AGENT OPTION [VALUE]", "Pin an agent's default value for a configuration option, or --unpin it. Pinning a permission-bypass mode needs --caller-token from a conversation running in a permission-bypass mode.", "agents.config.default", cobra.RangeArgs(2, 3), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		unpin, _ := cmd.Flags().GetBool("unpin")
		clear, _ := cmd.Flags().GetBool("clear-value")
		input := map[string]any{"agentServer": args[0], "optionId": args[1]}
		switch {
		case unpin && len(args) == 3:
			return nil, errors.New("VALUE does not apply with --unpin")
		case !unpin && len(args) == 2:
			return nil, errors.New("VALUE is required (or pass --unpin)")
		case !unpin && clear:
			return nil, errors.New("--clear-value only applies with --unpin")
		}
		if unpin {
			input["unpin"] = true
			if clear {
				input["clearValue"] = true
			}
		} else {
			input["value"] = args[2]
		}
		return input, nil
	})
	configDefault.Flags().Bool("unpin", false, "Release the pin (the stored default stays unless --clear-value)")
	configDefault.Flags().Bool("clear-value", false, "With --unpin, also remove the stored default value")
	restart := kit.Add(agents, "restart AGENT", "Restart an agent's subprocess, as the app's Restart agent does", "agents.restart", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		input := map[string]any{"agentServer": args[0]}
		if force, _ := cmd.Flags().GetBool("force"); force {
			input["force"] = true
		}
		return input, nil
	})
	restart.Flags().Bool("force", false, "Restart even while its conversations are working (interrupts their turns)")
	kit.Add(agents, "runtimes", "Report whether the runtimes registry agents launch through (npx) are available", "agents.runtimes", cobra.NoArgs, noActionArgs)
}

func addMCPCommands(kit CommandKit) {
	mcp := kit.Group("mcp", "Manage MCP connectors")
	nameArg := func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"name": args[0]}, nil
	}
	kit.Add(mcp, "list", "List MCP connectors (secret values redacted)", "mcp.list", cobra.NoArgs, noActionArgs)
	entry := func(add bool) func(*cobra.Command, []string) (map[string]any, error) {
		return func(cmd *cobra.Command, args []string) (map[string]any, error) {
			input, err := readObject(getString(cmd, "input"), cmd.InOrStdin())
			if err != nil {
				return nil, err
			}
			input["name"] = args[0]
			for flag, key := range map[string]string{"command": "command", "url": "url", "auth": "authMode", "oauth-scopes": "oauthScopes", "oauth-client-id": "oauthClientId"} {
				if cmd.Flags().Changed(flag) {
					input[key] = getString(cmd, flag)
				}
			}
			if cmd.Flags().Changed("oauth-callback-port") {
				input["oauthCallbackPort"], _ = cmd.Flags().GetInt("oauth-callback-port")
			}
			if cmd.Flags().Changed("oauth-deep-link") {
				input["oauthDeepLink"], _ = cmd.Flags().GetBool("oauth-deep-link")
			}
			if err = argsInput(cmd, input); err != nil {
				return nil, err
			}
			for _, pair := range [][3]string{{"env", "env-file", "env"}, {"header", "header-file", "headers"}} {
				values, valuesErr := keyValueInput(cmd, pair[0], pair[1])
				if valuesErr != nil {
					return nil, valuesErr
				}
				if len(values) > 0 {
					merged, _ := input[pair[2]].(map[string]any)
					if merged == nil {
						merged = map[string]any{}
					}
					for key, value := range values {
						merged[key] = value
					}
					input[pair[2]] = merged
				}
			}
			if path := getString(cmd, "bearer-token-file"); path != "" {
				token, tokenErr := readSecretFile(path, cmd.InOrStdin())
				if tokenErr != nil {
					return nil, tokenErr
				}
				input["bearerToken"] = strings.TrimSpace(token)
			}
			if add {
				if skip, _ := cmd.Flags().GetBool("skip-test"); skip {
					input["skipTest"] = true
				}
			} else {
				for flag, key := range map[string]string{"unset-env": "unsetEnv", "unset-header": "unsetHeaders"} {
					if values, _ := cmd.Flags().GetStringArray(flag); len(values) > 0 {
						input[key] = values
					}
				}
			}
			return input, nil
		}
	}
	addMCP := kit.Add(mcp, "add NAME", "Add a connector, as the Add connector form does (non-OAuth connectors must pass a connection test)."+bypassNote, "mcp.add", cobra.ExactArgs(1), entry(true))
	editMCP := kit.Add(mcp, "edit NAME", "Change a connector; stored secrets stay unless replaced."+bypassNote, "mcp.edit", cobra.ExactArgs(1), entry(false))
	for _, cmd := range []*cobra.Command{addMCP, editMCP} {
		cmd.Flags().String("input", "{}", "Connector fields as a JSON object, @file, or @- for stdin (flags override)")
		cmd.Flags().String("command", "", "stdio: executable to launch")
		argsFlags(cmd)
		keyValueFlags(cmd, "env", "env-file", "a stdio environment variable")
		cmd.Flags().String("url", "", "http: endpoint (https, or http on loopback)")
		keyValueFlags(cmd, "header", "header-file", "an HTTP header")
		cmd.Flags().String("auth", "", "http: authentication (none, bearer or oauth)")
		cmd.Flags().String("bearer-token-file", "", "http: file holding the bearer token, or - for stdin")
		cmd.Flags().String("oauth-scopes", "", "http: space-separated OAuth scopes")
		cmd.Flags().String("oauth-client-id", "", "http: pre-registered OAuth client ID")
		cmd.Flags().Int("oauth-callback-port", 0, "http: loopback port registered for the OAuth client")
		cmd.Flags().Bool("oauth-deep-link", false, "http: use the desktop's deep-link OAuth redirect")
	}
	addMCP.Flags().Bool("skip-test", false, "Save without the connection test")
	editMCP.Flags().StringArray("unset-env", nil, "Environment variable to remove (repeatable)")
	editMCP.Flags().StringArray("unset-header", nil, "Header to remove (repeatable)")
	kit.Add(mcp, "remove NAME", "Delete a connector and its stored sign-in."+bypassNote, "mcp.remove", cobra.ExactArgs(1), nameArg)
	kit.Add(mcp, "enable NAME", "Enable a connector for new and live sessions", "mcp.enable", cobra.ExactArgs(1), nameArg)
	kit.Add(mcp, "disable NAME", "Disable a connector for new and live sessions", "mcp.disable", cobra.ExactArgs(1), nameArg)
	kit.Add(mcp, "test NAME", "Probe a configured connector and list its tools", "mcp.test", cobra.ExactArgs(1), nameArg)
	kit.Add(mcp, "sign-in NAME", "Sign in to an OAuth connector: the desktop opens the browser and this waits for the user to finish."+bypassNote, "mcp.signIn", cobra.ExactArgs(1), nameArg)
	kit.Add(mcp, "sign-out NAME", "Sign out of an OAuth connector", "mcp.signOut", cobra.ExactArgs(1), nameArg)
}

func addSkillsAndModelsCommands(kit CommandKit) {
	skills := kit.Group("skills", "List installed skills")
	listSkills := kit.Add(skills, "list", "List installed skills and where each comes from", "skills.list", cobra.NoArgs, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		input := map[string]any{}
		if workspace := getPath(cmd, "workspace"); workspace != "" {
			input["workspacePath"] = workspace
		}
		if agent := getString(cmd, "agent"); agent != "" {
			input["agentServer"] = agent
		}
		return input, nil
	})
	listSkills.Flags().String("workspace", "", "Registered project or worktree to scan instead of the desktop's workspace folders")
	listSkills.Flags().String("agent", "", "Also include skill commands this agent publishes")

	models := kit.Group("models", "Manage local models")
	modelArg := func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"modelId": args[0]}, nil
	}
	kit.Add(models, "list", "List local models and the local runtime's state", "models.list", cobra.NoArgs, noActionArgs)
	kit.Add(models, "search QUERY", "Search Hugging Face for installable local models", "models.search", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return map[string]any{"query": args[0]}, nil
	})
	download := &cobra.Command{Use: "download MODEL", Short: "Start downloading a local model, or --cancel a download", Args: cobra.ExactArgs(1)}
	cancelRun := kit.Add(&cobra.Command{}, "cancel", "", "models.cancel", cobra.ExactArgs(1), modelArg).RunE
	downloadRun := kit.Add(&cobra.Command{}, "download", "", "models.download", cobra.ExactArgs(1), modelArg).RunE
	download.RunE = func(cmd *cobra.Command, args []string) error {
		if cancel, _ := cmd.Flags().GetBool("cancel"); cancel {
			return cancelRun(cmd, args)
		}
		return downloadRun(cmd, args)
	}
	download.Flags().Bool("cancel", false, "Cancel the model's download instead")
	models.AddCommand(download)
	kit.Add(models, "delete MODEL", "Delete a downloaded local model from disk", "models.delete", cobra.ExactArgs(1), modelArg)
	kit.Add(models, "default MODEL", "Make a downloaded model the local agent's default", "models.default", cobra.ExactArgs(1), modelArg)
	kit.Add(models, "unload", "Release the model resident in the local runtime's memory", "models.unload", cobra.NoArgs, noActionArgs)
}

func noActionArgs(*cobra.Command, []string) (map[string]any, error) { return map[string]any{}, nil }

// subcommand returns parent's named subcommand, creating it if needed.
func subcommand(parent *cobra.Command, name, summary string) *cobra.Command {
	for _, existing := range parent.Commands() {
		if existing.Name() == name {
			return existing
		}
	}
	cmd := &cobra.Command{Use: name, Short: summary}
	parent.AddCommand(cmd)
	return cmd
}

func argsFlags(cmd *cobra.Command) {
	cmd.Flags().StringArray("arg", nil, "Argument (repeatable, in order); replaces the stored list")
	cmd.Flags().Bool("clear-args", false, "Remove all arguments")
}

func argsInput(cmd *cobra.Command, input map[string]any) error {
	values, _ := cmd.Flags().GetStringArray("arg")
	clear, _ := cmd.Flags().GetBool("clear-args")
	switch {
	case clear && len(values) > 0:
		return errors.New("use --arg or --clear-args, not both")
	case clear:
		input["args"] = []string{}
	case len(values) > 0:
		input["args"] = values
	}
	return nil
}

func keyValueFlags(cmd *cobra.Command, flag, fileFlag, what string) {
	cmd.Flags().StringArray(flag, nil, fmt.Sprintf("Set %s as KEY=VALUE (repeatable); prefer --%s for secrets, which keeps them out of the process list", what, fileFlag))
	cmd.Flags().String(fileFlag, "", "File of KEY=VALUE lines (one per line), or - for stdin")
}

// keyValueInput merges --FILEFLAG lines and repeated --FLAG KEY=VALUE pairs.
func keyValueInput(cmd *cobra.Command, flag, fileFlag string) (map[string]string, error) {
	values := map[string]string{}
	if path := getString(cmd, fileFlag); path != "" {
		text, err := readSecretFile(path, cmd.InOrStdin())
		if err != nil {
			return nil, err
		}
		scanner := bufio.NewScanner(strings.NewReader(text))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, err := splitKeyValue(line, "--"+fileFlag)
			if err != nil {
				return nil, err
			}
			values[key] = value
		}
	}
	pairs, _ := cmd.Flags().GetStringArray(flag)
	for _, pair := range pairs {
		key, value, err := splitKeyValue(pair, "--"+flag)
		if err != nil {
			return nil, err
		}
		values[key] = value
	}
	return values, nil
}

// splitKeyValue never quotes the value in its error: it may be a secret.
func splitKeyValue(pair, source string) (string, string, error) {
	key, value, ok := strings.Cut(pair, "=")
	key = strings.TrimSpace(key)
	if !ok || key == "" {
		return "", "", fmt.Errorf("%s entries must be KEY=VALUE", source)
	}
	return key, value, nil
}

func readSecretFile(path string, stdin io.Reader) (string, error) {
	if path == "-" {
		data, err := io.ReadAll(io.LimitReader(stdin, maxFrameBytes+1))
		if len(data) > maxFrameBytes {
			return "", errors.New("input exceeds 1 MiB")
		}
		return string(data), err
	}
	data, err := os.ReadFile(path)
	if len(data) > maxFrameBytes {
		return "", errors.New("input exceeds 1 MiB")
	}
	return string(data), err
}
