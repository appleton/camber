<script lang="ts">
  import { InfoMessageType } from "@camber/rpc";
  import type { Snippet } from "svelte";
  import { extractErrorMessage } from "../errors";
  import { getACPAgentRegistryRepo } from "../features/AgentRegistryRepository.svelte";
  import { getACPAgentServersRepo } from "../features/AgentServersRepository.svelte";
  import {
    setACPHandoffConfirmationContext,
    type ACPHandoffConfirmationRequest,
  } from "../features/HandoffConfirmationContext";
  import { getACPSessionRepo } from "../features/SessionRepository.svelte";
  import { rpc } from "../hostRpc";
  import { agentName } from "./chat/menus/config/agentConfig";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const repo = getACPSessionRepo();
  const registry = getACPAgentRegistryRepo();
  const agentServers = getACPAgentServersRepo();
  let confirmation = $state<ACPHandoffConfirmationRequest | null>(null);
  const targetAgentName = $derived(
    confirmation ? agentName(registry, confirmation.targetAgentServer) : "",
  );

  setACPHandoffConfirmationContext({
    request(request) {
      confirmation = request;
    },
  });

  function confirmHandoff(): void {
    const request = confirmation;
    if (!request) return;

    // The confirmation has done its job once the user starts the handoff. Keep
    // the transfer app-scoped and let the normal working state communicate its
    // progress instead of pinning a disabled modal over the chat.
    confirmation = null;
    void repo.handoffSession(request.conversationId, request.targetAgentServer).then(
      () => {
        // A completed handoff is an explicit agent choice: remember it for
        // the next new conversation — but only once it actually happened, so
        // a failed handoff cannot switch the global default. Fire-and-forget,
        // skipped when it already is the remembered agent, and skipped
        // entirely while the default agent is pinned (a pin means the user
        // fixed the default deliberately; last use must not follow).
        if (
          !repo.agents.defaultAgentServerPinned &&
          request.targetAgentServer !== repo.agents.defaultAgentServer
        ) {
          void agentServers
            .setDefaultAgentServer(request.targetAgentServer)
            .catch((error: unknown) => {
              console.error("Failed to remember last-used ACP agent", error);
            });
        }
      },
      (error: unknown) => {
        void rpc.showInfoMessage(
          extractErrorMessage(error, "Unable to hand off the conversation"),
          InfoMessageType.error,
        );
      },
    );
  }
</script>

{@render children()}

{#if confirmation}
  <ConfirmationDialog
    title={`Hand off to ${targetAgentName}?`}
    description={`${targetAgentName} will take over when you send your next message. The current conversation history will remain visible.`}
    confirmLabel="Hand Off"
    onCancel={() => (confirmation = null)}
    onConfirm={confirmHandoff}
  />
{/if}
