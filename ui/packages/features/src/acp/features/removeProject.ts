import type { ACPConversationRepository } from "./ConversationRepository.svelte";
import type { ACPProjectRepository } from "./ProjectRepository.svelte";
import type { ACPWorktreeRepository } from "./WorktreeRepository";

export interface RemoveProjectDeps {
  projects: Pick<ACPProjectRepository, "removeProject">;
  worktrees: Pick<ACPWorktreeRepository, "closeProject">;
  conversations: Pick<ACPConversationRepository, "refresh">;
}

// Removes a project the way the desktop does: unregister it (the helper drops
// its worktrees and their conversation rows; files stay on disk), close its
// terminals and setup output, then reload the conversation list. Shared by the
// sidebar, project settings and `camber projects remove` (which reaches the
// webview as camber/desktopApp/removeProject).
export async function removeProjectFromApp(
  { projects, worktrees, conversations }: RemoveProjectDeps,
  path: string,
): Promise<void> {
  await projects.removeProject(path);
  await worktrees.closeProject(path);
  await conversations.refresh();
}
