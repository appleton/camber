import { camberAcpNavList } from "@camber/helperapi";
import type { ACPConversationRepositoryWriter } from "./ConversationRepository.svelte";
import type { ACPProjectRepositoryWriter } from "./ProjectRepository.svelte";

export async function refreshACPNavState(
  projects: Pick<ACPProjectRepositoryWriter, "applyNavState" | "refresh">,
  conversations: Pick<ACPConversationRepositoryWriter, "applyNavState" | "refresh">,
): Promise<void> {
  try {
    const state = await camberAcpNavList({});
    projects.applyNavState(state);
    conversations.applyNavState(state);
  } catch {
    await Promise.allSettled([
      projects.refresh({ showLoading: false }),
      conversations.refresh({ showLoading: false }),
    ]);
  }
}
