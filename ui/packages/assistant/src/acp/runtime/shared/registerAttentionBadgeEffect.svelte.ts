import { countAttentionConversations } from "@camber/features/acp";

import type { Repositories } from "./Repositories.svelte";
import type { RuntimeProps } from "./types";

// Number of ACP conversations awaiting the user's attention. A pure query over
// the shared nav state: the helper owns unread/waitingForUser and clears them
// when the conversation is read on any surface, so the badge always agrees
// with the sidebar's unread dots. The local status repository (which marks a
// conversation unread on every locally-driven turn and only clears on a
// focused open) backs OS notifications, not the badge — counting it here left
// the badge nonzero while every sidebar row looked read whenever another
// surface, like a paired phone, had already seen the turn.
export function attentionCount(repositories: Repositories): number {
  return countAttentionConversations(repositories.acpConversationRepo.sessions);
}

// Reports the attention count to the host (the desktop dock badge). Hosts that surface no badge
// (the IDEs) pass no callback, so no effect is registered.
export function registerAttentionBadgeEffect(
  repositories: Repositories,
  onACPAttentionCountChange?: RuntimeProps["onACPAttentionCountChange"],
) {
  if (!onACPAttentionCountChange) return;

  let lastReportedCount = -1;
  $effect(() => {
    const count = attentionCount(repositories);
    if (count === lastReportedCount) return;
    lastReportedCount = count;
    onACPAttentionCountChange(count);
  });
}
