package cambercli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

const skillMarker = "<!-- Installed by camber skill setup. -->"
const skillStub = "---\nname: camber\ndescription: Control the running Camber desktop, including agent configuration, conversations, projects, and worktrees.\n---\n\n" + skillMarker + "\n\nRun `camber skill show` and follow the guide it prints.\nUse `camber <command> --help` for task-specific details.\nPass the `callerToken` from your Camber host context with `--caller-token` on `chat spawn` and `chat config set`; permission-bypass modes require it. Keep it private.\nIf the guide cannot load, run `camber status --json` and `camber --help`.\n"

func addInstallCommands(root, skill *cobra.Command, emit func(*cobra.Command, json.RawMessage) error) {
	cli := &cobra.Command{Use: "cli", Short: "Manage the native command entrypoint"}
	root.AddCommand(cli)
	install := &cobra.Command{Use: "install", Short: "Link this executable into a directory on PATH", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		directory := getString(cmd, "directory")
		if directory == "" {
			return errors.New("--directory is required; choose a directory on your PATH")
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return err
		}
		path, err := installLink(directory, executable)
		if err != nil {
			return err
		}
		data, _ := json.Marshal(map[string]any{"path": path, "executable": executable})
		return emit(cmd, data)
	}}
	install.Flags().String("directory", "", "Directory on PATH in which to install the camber link")
	cli.AddCommand(install)
	for _, action := range []string{"setup", "status", "remove"} {
		command := &cobra.Command{Use: action, Short: action + " the tiny Poolside agent skill", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			directory, err := skillDirectory(cmd)
			if err != nil {
				return err
			}
			path := filepath.Join(directory, "SKILL.md")
			content, readErr := os.ReadFile(path)
			owned := readErr == nil && strings.Contains(string(content), skillMarker)
			installed := readErr == nil
			switch action {
			case "setup":
				if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
					return readErr
				}
				if installed && !owned {
					return fmt.Errorf("refusing to replace an existing user-owned skill: %s", path)
				}
				if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
					return fmt.Errorf("refusing to replace a symlink: %s", path)
				}
				if err = os.MkdirAll(directory, 0755); err != nil {
					return err
				}
				if err = os.WriteFile(path, []byte(skillStub), 0644); err != nil {
					return err
				}
				installed = true
				owned = true
			case "remove":
				if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
					return readErr
				}
				if installed && !owned {
					return fmt.Errorf("refusing to remove a user-owned skill: %s", path)
				}
				if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
					return fmt.Errorf("refusing to remove a symlink: %s", path)
				}
				if owned {
					if err = os.Remove(path); err != nil {
						return err
					}
					_ = os.Remove(directory)
				}
				installed = false
				owned = false
			case "status":
				if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
					return readErr
				}
			}
			data, _ := json.Marshal(map[string]any{"path": path, "installed": installed, "owned": owned})
			return emit(cmd, data)
		}}
		command.Flags().String("directory", "", "Exact skill directory (overrides --agent and --scope)")
		command.Flags().String("agent", "shared", "Skill host: shared, codex, or claude")
		command.Flags().String("scope", "user", "Installation scope: user or project")
		skill.AddCommand(command)
	}
}

func installLink(directory, executable string) (string, error) {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	path := filepath.Join(absolute, "poolside")
	if path == executable {
		return path, nil
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return "", fmt.Errorf("refusing to replace existing file: %s", path)
		}
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", fmt.Errorf("existing camber link cannot be verified: %w", err)
		}
		if target != executable {
			return "", fmt.Errorf("refusing to replace a link to a different executable: %s", path)
		}
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err = os.MkdirAll(absolute, 0755); err != nil {
		return "", err
	}
	if err = os.Symlink(executable, path); err != nil {
		return "", err
	}
	return path, nil
}
func skillDirectory(cmd *cobra.Command) (string, error) {
	if directory := getString(cmd, "directory"); directory != "" {
		return filepath.Abs(directory)
	}
	agent := getString(cmd, "agent")
	folder := ""
	switch agent {
	case "shared":
		folder = ".agents"
	case "codex":
		folder = ".codex"
	case "claude":
		folder = ".claude"
	default:
		return "", fmt.Errorf("unsupported skill host %q; choose shared, codex, or claude", agent)
	}
	scope := getString(cmd, "scope")
	var root string
	var err error
	switch scope {
	case "user":
		root, err = os.UserHomeDir()
	case "project":
		root, err = os.Getwd()
	default:
		return "", fmt.Errorf("unsupported skill scope %q; choose user or project", scope)
	}
	if err != nil {
		return "", err
	}
	return filepath.Join(root, folder, "skills", "poolside"), nil
}
