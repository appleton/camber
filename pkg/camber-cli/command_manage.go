package cambercli

import (
	"fmt"

	"github.com/spf13/cobra"
)

// chatWorkspace is the workspacePath of the desktop's Chats section.
const chatWorkspace = "CHAT"

// Conversation, project and worktree management commands. Each dispatches an
// action that runs the same code as the matching desktop operation.
func init() {
	registerCommandExtension(func(kit CommandKit) {
		chat := kit.Group("chat", "Create, configure, and observe conversations")
		for _, spec := range []struct{ name, summary string }{
			{"archive", "Archive a conversation and the sub-agents shown under it, as the sidebar does (cancels a running turn)"},
			{"restore", "Restore an archived conversation"},
			{"open", "Focus the desktop window and select the conversation"},
		} {
			kit.Add(chat, spec.name+" [CHAT]", spec.summary, "chat."+spec.name, cobra.MaximumNArgs(1), kit.ChatArgs)
		}
		kit.Add(chat, "rename CHAT NAME", "Rename a conversation as the desktop does", "chat.rename", cobra.ExactArgs(2), func(cmd *cobra.Command, args []string) (map[string]any, error) {
			return map[string]any{"conversationId": args[0], "name": args[1]}, nil
		})
		deleteChat := kit.Add(chat, "delete CHAT", "Permanently delete a conversation and its agent session (requires --yes)", "chat.delete", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
			if yes, _ := cmd.Flags().GetBool("yes"); !yes {
				return nil, fmt.Errorf("chat delete permanently deletes conversation %s and its agent session; pass --yes to confirm, or use chat archive to keep it restorable", args[0])
			}
			return map[string]any{"conversationId": args[0], "confirm": true}, nil
		})
		deleteChat.Flags().Bool("yes", false, "Confirm permanent deletion")
		addChatNewChatFlag(kit, chat)

		projects := kit.Group("projects", "Discover projects")
		kit.Add(projects, "add PATH", "Register a folder as a project, as the desktop's Add Project does", "projects.add", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
			return map[string]any{"projectPath": absPath(args[0])}, nil
		})
		kit.Add(projects, "remove PATH", "Unregister a project as the desktop sidebar does (files stay on disk)", "projects.remove", cobra.ExactArgs(1), func(cmd *cobra.Command, args []string) (map[string]any, error) {
			return map[string]any{"projectPath": absPath(args[0])}, nil
		})

		worktrees := kit.Group("worktrees", "Inspect and manage project worktrees")
		kit.Add(worktrees, "rename PATH NAME", "Rename a worktree's display name and its helper-created, unpublished branch (directory unchanged; no repo hooks run)", "worktrees.rename", cobra.ExactArgs(2), func(cmd *cobra.Command, args []string) (map[string]any, error) {
			return map[string]any{"workspacePath": absPath(args[0]), "name": args[1]}, nil
		})
	})
}

// addChatNewChatFlag adds --chat to `chat new`: the conversation is created in
// the desktop's Chats section instead of a workspace, as its New Chat does.
// It dispatches chat.new with the same task and configuration arguments.
func addChatNewChatFlag(kit CommandKit, chat *cobra.Command) {
	var newChat *cobra.Command
	for _, cmd := range chat.Commands() {
		if cmd.Name() == "new" {
			newChat = cmd
		}
	}
	if newChat == nil {
		return
	}
	newChat.Flags().Bool("chat", false, "Create the conversation in the Chats section instead of a workspace")
	// Built on a detached parent so it is not listed; its RunE reads the
	// flags of the real `chat new` invocation.
	chatRun := kit.Add(&cobra.Command{}, "new", newChat.Short, "chat.new", cobra.NoArgs, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		for _, name := range []string{"workspace", "worktree", "project", "new-worktree"} {
			if cmd.Flags().Changed(name) {
				return nil, fmt.Errorf("chat new --chat creates a chat in the Chats section and does not accept --%s", name)
			}
		}
		cfg, err := configuration(cmd, nil)
		if err != nil {
			return nil, err
		}
		text, err := readText(getString(cmd, "text"), cmd.InOrStdin())
		if err != nil {
			return nil, err
		}
		return map[string]any{"agentServer": getString(cmd, "agent"), "config": cfg, "model": getString(cmd, "model"), "effort": getString(cmd, "effort"), "mode": getString(cmd, "mode"), "text": text, "requestId": getString(cmd, "request-id"), "workspacePath": chatWorkspace}, nil
	}).RunE
	workspaceRun := newChat.RunE
	newChat.RunE = func(cmd *cobra.Command, args []string) error {
		if asChat, _ := cmd.Flags().GetBool("chat"); asChat {
			return chatRun(cmd, args)
		}
		return workspaceRun(cmd, args)
	}
}
