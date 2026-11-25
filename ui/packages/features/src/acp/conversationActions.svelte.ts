// Conversation-level actions owned by the desktop sidebar (archive with undo,
// delete worktree with confirmation) that the chat composer also exposes as
// slash commands. The sidebar and chat pane are siblings, so the sidebar
// registers its handlers here instead of passing them down through props.
// One registry per webview: each desktop window runs its own sidebar.

export interface ConversationWorktree {
  path: string;
  name: string;
}

export interface ConversationActions {
  /** Archive a conversation the same way the sidebar's archive button does. */
  archiveConversation(conversationId: string): boolean;
  /** The worktree a conversation runs in, or null when it is not in a deletable worktree. */
  worktreeFor(conversationId: string): ConversationWorktree | null;
  /** Ask to delete a worktree, using the sidebar's confirmation dialog. */
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
