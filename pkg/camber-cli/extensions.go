package cambercli

import (
	"github.com/spf13/cobra"
)

// CommandKit gives command extensions (registered from their own files with
// registerCommandExtension) the same building blocks the core commands use, so
// each area adds its commands without editing NewCommandWithClient.
type CommandKit struct {
	// Root is the top-level camber command.
	Root *cobra.Command
	// Group returns the named top-level group, creating it if needed.
	Group func(name, summary string) *cobra.Command
	// Add registers a subcommand that dispatches the named control action with
	// the arguments build returns, and prints the result.
	Add func(parent *cobra.Command, use, summary, action string, args cobra.PositionalArgs, build func(*cobra.Command, []string) (map[string]any, error)) *cobra.Command
	// ChatArgs resolves a conversation ID from the first positional argument or
	// CAMBER_CONVERSATION_ID, as {"conversationId": id}.
	ChatArgs func(*cobra.Command, []string) (map[string]any, error)
}

var commandExtensions []func(kit CommandKit)

// registerCommandExtension adds commands at package init; extensions run in
// registration order after the core commands are built.
func registerCommandExtension(extension func(kit CommandKit)) {
	commandExtensions = append(commandExtensions, extension)
}
