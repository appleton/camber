package acpproxy

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/appleton/camber/pkg/camber-helper/internal/shellenv"
)

// MissingRuntimeError marks an agent launch that failed because the runtime
// its distribution launches through is not on this machine. Its message is
// user-facing: the raw lookup error names the launcher binary (npx), which
// users do not install directly — the actionable fix is the runtime that
// provides it.
type MissingRuntimeError struct {
	AgentServer string
	// Launcher is the missing launcher binary, e.g. "npx".
	Launcher string
	// Provider is what users install to get the launcher, e.g. "Node.js".
	Provider string
	Err      error
}

func (e *MissingRuntimeError) Error() string {
	return fmt.Sprintf(
		"This agent runs through %s, which was not found on this machine. Install %s to use this agent.",
		e.Launcher, e.Provider)
}

func (e *MissingRuntimeError) Unwrap() error {
	return e.Err
}

// LookupExecutable resolves name against the same login-shell-merged
// environment agent subprocesses spawn with (see buildProcessEnv), so a
// pre-install runtime check answers exactly what launching the agent would
// find. It returns the resolved path and whether it was found.
func LookupExecutable(name string) (string, bool) {
	return lookupExecutable(name, shellenv.Merge(os.Environ(), userShellEnvProvider()))
}

func lookupExecutable(name string, env []string) (string, bool) {
	resolved, err := resolveExecutablePath(name, env)
	if err != nil || resolved == "" {
		return "", false
	}
	return resolved, true
}

// runtimeProviders maps launcher binaries to the runtimes users install to
// get them.
var runtimeProviders = map[string]string{
	"npx": "Node.js",
	"uvx": "uv",
}

// missingRuntimeLaunchError converts a failed lookup of an agent's launcher
// into a MissingRuntimeError when the launcher belongs to a known runtime;
// other lookup failures return unchanged.
func missingRuntimeLaunchError(serverName, binary string, err error) error {
	launcher := filepath.Base(binary)
	provider, ok := runtimeProviders[launcher]
	if !ok {
		return err
	}
	return &MissingRuntimeError{
		AgentServer: serverName,
		Launcher:    launcher,
		Provider:    provider,
		Err:         err,
	}
}
