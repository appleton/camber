<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import {
    ACPMCPSettingsRepositoryWriter,
    getUserMCPServersRepo,
    setACPMCPSettingsContext,
    type ACPSessionRepository,
  } from "@camber/features/acp";

  interface Props {
    children: Snippet;
    acp?: ACPSessionRepository | null;
    activeConversationId?: string | null;
  }

  let { children, acp = null, activeConversationId = null }: Props = $props();

  let stopConnectorRefresh: (() => void) | undefined;

  if (acp) {
    const repo = new ACPMCPSettingsRepositoryWriter(acp, {
      getActiveSession: () => {
        const session = acp.getSessionByConversationId(activeConversationId);
        return session
          ? {
              agentServer: session.agentServer,
              sessionId: session.sessionId,
            }
          : null;
      },
    });
    setACPMCPSettingsContext(repo.publicAPI());

    // Same-webview fallback trigger: keeps connector mutations refreshing
    // sessions on helpers that predate the mcpServers/didChange broadcast
    // (which arrives via WebviewRPCServer.mcpServersDidChange and shares the
    // repository's coalesced sweep).
    stopConnectorRefresh = getUserMCPServersRepo().onDidChange(() => {
      acp.refreshMCPServersForAllSessions().catch((error) => {
        console.error("Failed to refresh ACP sessions after connector changes", error);
      });
    });
  }

  onDestroy(() => stopConnectorRefresh?.());
</script>

{@render children()}
