package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/appcontrol"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Conversation, project and worktree management. Each action runs the code
// the desktop runs for the same operation: the shared appcontrol helpers
// (also behind the desktop's camber/app/* methods), the acpnav methods the
// desktop calls directly, or, for operations that need the desktop window's
// own state, a request the desktop webview answers with its own functions.

// ManagedConversation is the result of a conversation management action.
type ManagedConversation struct {
	ConversationID string `json:"conversationId"`
	// Archived and Descendants list what chat.archive archived: the
	// conversation and the sub-agents rendered under it.
	Archived    []string `json:"archived,omitempty"`
	Descendants []string `json:"descendants,omitempty"`
	Restored    bool     `json:"restored,omitempty"`
	Deleted     bool     `json:"deleted,omitempty"`
	Opened      bool     `json:"opened,omitempty"`
	// Conversation is the updated summary, when the conversation still exists.
	Conversation *ConversationSummary `json:"conversation,omitempty"`
}

func init() {
	conversationID := map[string]any{"type": "string", "description": "Conversation ID"}
	registerAction("chat.archive", RegisteredAction{
		Summary:     "Archive a conversation as the desktop sidebar does: cancel a running turn, close its agent session, archive it, and archive the sub-agents rendered under it (closing their sessions too). A conversation that runs, or would resume, in a permission-bypass mode needs its own callerToken, or its parent's or origin's while that conversation is live in a bypass mode.",
		InputSchema: objectSchema(map[string]any{"conversationId": conversationID}, "conversationId"),
		Run:         runConversationAction((*Service).archiveConversation),
	})
	registerAction("chat.restore", RegisteredAction{
		Summary:     "Restore an archived conversation as the desktop's archive list does, re-registering its workspace if needed. Its agent session reopens on the next prompt. Sub-agents archived with it stay archived. Same permission-bypass rule as chat.archive.",
		InputSchema: objectSchema(map[string]any{"conversationId": conversationID}, "conversationId"),
		Run:         runConversationAction((*Service).restoreConversation),
	})
	registerAction("chat.rename", RegisteredAction{
		Summary: "Rename a conversation as the desktop does: set its name, and when the agent supports session rename also its title and the agent-side session title. Same permission-bypass rule as chat.archive.",
		InputSchema: objectSchema(map[string]any{
			"conversationId": conversationID,
			"name":           map[string]any{"type": "string", "description": "New name"},
		}, "conversationId", "name"),
		Run: runConversationAction((*Service).renameConversation),
	})
	registerAction("chat.delete", RegisteredAction{
		Summary: "Permanently delete a conversation as the desktop does: cancel a running turn, remove it from navigation and delete its agent session. Requires confirm=true (CLI --yes). Sub-agents are not deleted. Refused when the agent does not support deleting sessions (the desktop does not offer delete then either); archive instead. Same permission-bypass rule as chat.archive.",
		InputSchema: objectSchema(map[string]any{
			"conversationId": conversationID,
			"confirm":        map[string]any{"type": "boolean", "description": "Must be true: deletion cannot be undone"},
		}, "conversationId", "confirm"),
		Run: runConversationAction((*Service).deleteConversation),
	})
	registerAction("chat.open", RegisteredAction{
		Summary:     "Focus the desktop window and select the conversation there, as clicking its notification does. Fails when no desktop window is attached. Same permission-bypass rule as chat.archive.",
		InputSchema: objectSchema(map[string]any{"conversationId": conversationID}, "conversationId"),
		Run:         runConversationAction((*Service).openConversation),
	})

	projectPath := map[string]any{"type": "string", "description": "Absolute project path"}
	registerAction("projects.add", RegisteredAction{
		Summary:     "Register a folder as a project, as the desktop's Add Project does (a linked git worktree registers under its root project). Agents may then work in it, so the request needs the callerToken of a conversation that is live in a permission-bypass mode.",
		InputSchema: objectSchema(map[string]any{"projectPath": projectPath}, "projectPath"),
		Run:         addProject,
	})
	registerAction("projects.remove", RegisteredAction{
		Summary:     "Remove a registered root project as the desktop sidebar does: unregister it and its worktrees, drop their conversations from navigation and close the project's desktop terminals. Files on disk and agent sessions are left alone. Needs a desktop window, and the callerToken of a conversation that is live in a permission-bypass mode.",
		InputSchema: objectSchema(map[string]any{"projectPath": projectPath}, "projectPath"),
		Run:         removeProject,
	})
	registerAction("worktrees.rename", RegisteredAction{
		Summary: "Rename a registered worktree's display name as the desktop does; its directory is unchanged. A helper-created, unpublished branch is renamed to follow it (prefix + slug of the name), run without repository hooks.",
		InputSchema: objectSchema(map[string]any{
			"workspacePath": map[string]any{"type": "string", "description": "Absolute worktree path"},
			"name":          map[string]any{"type": "string", "description": "New display name"},
		}, "workspacePath", "name"),
		Run: renameWorktree,
	})
}

type conversationActionArgs struct {
	ConversationID string `json:"conversationId"`
	Name           string `json:"name,omitempty"`
	Confirm        bool   `json:"confirm,omitempty"`
}

type projectActionArgs struct {
	ProjectPath string `json:"projectPath"`
}

type worktreeRenameArgs struct {
	WorkspacePath string `json:"workspacePath"`
	Name          string `json:"name"`
}

// runConversationAction decodes conversation arguments, loads the
// conversation and applies the permission-bypass rule shared with chat.send
// before running action.
func runConversationAction(action func(*Service, context.Context, View, conversationActionArgs, string, *glsp.Context) (any, error)) func(context.Context, *Service, json.RawMessage, string, *glsp.Context) (any, error) {
	return func(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
		var a conversationActionArgs
		if err := decodeActionArgs(raw, &a); err != nil {
			return nil, err
		}
		v, err := s.view(ctx, a.ConversationID, g)
		if err != nil {
			return nil, err
		}
		return action(s, ctx, v, a, caller, g)
	}
}

func (s *Service) archiveConversation(ctx context.Context, v View, _ conversationActionArgs, caller string, g *glsp.Context) (any, error) {
	if err := s.checkPromptEscalation(ctx, v, caller, "archiving", g); err != nil {
		return nil, err
	}
	// The sidebar archives with the conversation's working directory as the
	// workspace (session.cwd) and its own id and session.
	out, err := s.app().ArchiveConversation(ctx, &methods.AppArchiveConversationParams{
		WorkspacePath:  v.Cwd,
		ConversationID: v.ID,
		AgentServer:    v.AgentServer,
		SessionID:      v.SessionID,
	}, g)
	if err != nil {
		return nil, err
	}
	return ManagedConversation{ConversationID: v.ID, Archived: out.Archived, Descendants: out.Descendants}, nil
}

func (s *Service) restoreConversation(ctx context.Context, v View, _ conversationActionArgs, caller string, g *glsp.Context) (any, error) {
	if err := s.checkPromptEscalation(ctx, v, caller, "restoring", g); err != nil {
		return nil, err
	}
	if !v.Archived {
		return nil, pkgerrors.Errorf("conversation %s is not archived", v.ID)
	}
	if _, err := s.nav.RestoreConversation(ctx, &methods.ACPNavRestoreConversationParams{Conversation: restorableConversation(v.ACPNavConversation)}, g); err != nil {
		return nil, err
	}
	return s.managedResult(ctx, v.ID, ManagedConversation{ConversationID: v.ID, Restored: true}, g), nil
}

func (s *Service) renameConversation(ctx context.Context, v View, a conversationActionArgs, caller string, g *glsp.Context) (any, error) {
	if strings.TrimSpace(a.Name) == "" {
		return nil, pkgerrors.New("name is required")
	}
	if err := s.checkPromptEscalation(ctx, v, caller, "renaming", g); err != nil {
		return nil, err
	}
	if _, err := s.app().RenameConversation(ctx, &methods.AppRenameConversationParams{ConversationID: v.ID, Name: a.Name}, g); err != nil {
		return nil, err
	}
	return s.managedResult(ctx, v.ID, ManagedConversation{ConversationID: v.ID}, g), nil
}

func (s *Service) deleteConversation(ctx context.Context, v View, a conversationActionArgs, caller string, g *glsp.Context) (any, error) {
	if !a.Confirm {
		return nil, pkgerrors.Errorf("chat.delete permanently deletes conversation %s and its agent session; pass confirm=true (CLI --yes) to proceed, or use chat.archive to keep it restorable", v.ID)
	}
	if err := s.checkPromptEscalation(ctx, v, caller, "deleting", g); err != nil {
		return nil, err
	}
	app := s.app()
	if caps := app.Capabilities(v.AgentServer); v.SessionID != "" && caps.Known && !caps.Delete {
		return nil, pkgerrors.Errorf("agent %s does not support deleting sessions, so the desktop does not offer to delete conversation %s either; use chat.archive instead", v.AgentServer, v.ID)
	}
	// The desktop cancels the running turn of the conversation it shows
	// before deleting it; a control caller has no such view, so always do.
	if _, err := app.DeleteConversation(ctx, &methods.AppDeleteConversationParams{
		ConversationID: v.ID,
		AgentServer:    v.AgentServer,
		SessionID:      v.SessionID,
		CancelInFlight: true,
	}, g); err != nil {
		return nil, err
	}
	return ManagedConversation{ConversationID: v.ID, Deleted: true}, nil
}

func (s *Service) openConversation(ctx context.Context, v View, _ conversationActionArgs, caller string, g *glsp.Context) (any, error) {
	if err := archivedError(v); err != nil {
		return nil, err
	}
	if err := s.checkPromptEscalation(ctx, v, caller, "opening", g); err != nil {
		return nil, err
	}
	if err := s.app().OpenConversation(ctx, v.ID, g); err != nil {
		return nil, err
	}
	return ManagedConversation{ConversationID: v.ID, Opened: true}, nil
}

func addProject(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
	path, err := decodeProjectPath(raw)
	if err != nil {
		return nil, err
	}
	if err := s.checkProjectChange(ctx, caller, "adding a project", g); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, pkgerrors.Wrapf(err, "project folder %s is not accessible", path)
	}
	if !info.IsDir() {
		return nil, pkgerrors.Errorf("project path %s is not a folder", path)
	}
	// The desktop's folder picker names the project after the folder.
	return s.nav.UpsertProject(ctx, &methods.ACPNavUpsertProjectParams{Path: path, Name: filepath.Base(path)}, g)
}

func removeProject(ctx context.Context, s *Service, raw json.RawMessage, caller string, g *glsp.Context) (any, error) {
	path, err := decodeProjectPath(raw)
	if err != nil {
		return nil, err
	}
	if err := s.checkProjectChange(ctx, caller, "removing a project", g); err != nil {
		return nil, err
	}
	root, err := s.registeredRootProject(ctx, path, g)
	if err != nil {
		return nil, err
	}
	if err := s.app().RemoveProject(ctx, root, g); err != nil {
		return nil, err
	}
	return map[string]any{"projectPath": root, "removed": true}, nil
}

func renameWorktree(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
	var a worktreeRenameArgs
	if err := decodeActionArgs(raw, &a); err != nil {
		return nil, err
	}
	path, err := cleanControlPath("workspacePath", a.WorkspacePath)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(a.Name)
	if path == "" {
		return nil, pkgerrors.New("workspacePath is required")
	}
	if name == "" {
		return nil, pkgerrors.New("name is required")
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return nil, err
	}
	target := canonicalControlPath(path)
	for _, p := range state.Projects {
		if !p.IsWorktree || canonicalControlPath(p.Path) != target {
			continue
		}
		renamed, err := s.nav.RenameProject(ctx, &methods.ACPNavRenameProjectParams{Path: p.Path, Name: name}, g)
		if err != nil {
			return nil, err
		}
		for _, updated := range renamed.Projects {
			if updated.Path == p.Path {
				return updated, nil
			}
		}
		return p, nil
	}
	return nil, pkgerrors.Errorf("worktree %s is not registered (see worktrees list)", path)
}

// app returns the conversation-management operations shared with the desktop.
func (s *Service) app() *appcontrol.Service {
	return appcontrol.New(s.nav, s.agent)
}

// checkProjectChange guards changes to the registered folders, which decide
// where agents may work: only a token-proven conversation that is live in a
// permission-bypass mode may make them.
func (s *Service) checkProjectChange(ctx context.Context, caller, what string, g *glsp.Context) error {
	if caller != "" {
		if v, err := s.view(ctx, caller, g); err == nil && s.provenDangerousCaller(caller, v) {
			return nil
		}
	}
	return &methods.JSONRPCError{Code: methods.CamberErrorCodeEntityInvalid, Message: "PERMISSION_ESCALATION: " + what + " changes which folders agents may work in, so it is only allowed when the request carries --caller-token proving it comes from a conversation that is running in a permission-bypass mode right now. Pass the callerToken from your Camber host context, or ask the user to make the change in the Camber desktop app."}
}

// managedResult attaches the conversation's updated summary when it can be
// read; the action already succeeded either way.
func (s *Service) managedResult(ctx context.Context, id string, out ManagedConversation, g *glsp.Context) ManagedConversation {
	if v, err := s.displayView(ctx, id, g); err == nil {
		summary := summarize(v)
		out.Conversation = &summary
	}
	return out
}

func decodeProjectPath(raw json.RawMessage) (string, error) {
	var a projectActionArgs
	if err := decodeActionArgs(raw, &a); err != nil {
		return "", err
	}
	path, err := cleanControlPath("projectPath", a.ProjectPath)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", pkgerrors.New("projectPath is required")
	}
	return path, nil
}

// restorableConversation is the row the desktop's archive list restores: the
// conversation in its workspace, falling back to its working directory when it
// has none, active and no longer archived.
func restorableConversation(c methods.ACPNavConversation) methods.ACPNavConversation {
	workspacePath := c.WorkspacePath
	if workspacePath == "" || workspacePath == "/" {
		workspacePath = c.Cwd
	}
	return methods.ACPNavConversation{
		ID:                 c.ID,
		WorkspacePath:      workspacePath,
		AgentServer:        c.AgentServer,
		SessionID:          c.SessionID,
		Cwd:                c.Cwd,
		Title:              c.Title,
		Nickname:           c.Nickname,
		UpdatedAt:          c.UpdatedAt,
		Active:             true,
		Archived:           false,
		WorkingDirectories: c.WorkingDirectories,
		Metadata:           c.Metadata,
		ParentID:           c.ParentID,
		RootID:             c.RootID,
	}
}
