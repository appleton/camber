import type { ACPNavProject } from "./navTypes";

// Conversation-level actions owned by the host's conversation list (archive,
// delete worktree with confirmation) that the chat composer also exposes as
// slash commands. The composer is not a descendant of the code that owns those
// flows (the desktop sidebar is its sibling; the mobile list is unmounted while
// a chat is open), so the owner registers its handlers here instead of passing
// them down through props. One registry per webview: each window runs its own.

export interface ConversationWorktree {
  path: string;
  name: string;
}

export interface ConversationActions {
  /** Whether the conversation can be archived right now. */
  canArchive(conversationId: string): boolean;
  /** Archive a conversation the way the host's own archive action does. */
  archiveConversation(conversationId: string): boolean;
  /** The worktree a conversation runs in, or null when it is not in a deletable worktree. */
  worktreeFor(conversationId: string): ConversationWorktree | null;
  /** Ask to delete a worktree, through the host's confirmation dialog. */
  deleteWorktree(path: string): void;
}

let registered = $state.raw<ConversationActions | null>(null);

export function registerConversationActions(actions: ConversationActions): () => void {
  registered = actions;
  return () => {
    if (registered === actions) registered = null;
  };
}

export function getConversationActions(): ConversationActions | null {
  return registered;
}

/**
 * The worktree whose directory contains `cwd`. A conversation may run in a
 * subdirectory of a registered worktree, so match whole path components and
 * prefer the deepest match.
 */
export function containingWorktree(
  projects: ReadonlyArray<ACPNavProject>,
  cwd: string,
): ACPNavProject | null {
  let match: ACPNavProject | null = null;
  for (const project of projects) {
    if (!project.isWorktree || !isWithin(cwd, project.path)) continue;
    if (!match || project.path.length > match.path.length) match = project;
  }
  return match;
}

function isWithin(path: string, directory: string): boolean {
  const base = directory.replace(/[\\/]+$/, "");
  if (!base) return false;
  if (path === base) return true;
  return path.startsWith(base) && (path[base.length] === "/" || path[base.length] === "\\");
}
