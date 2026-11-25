<script lang="ts">
  // Test harness: provides the contexts PromptConfigControls reads. The repo
  // double backs both the session repository context and the chat session
  // scope, exactly as the real wiring does.
  import { _setACPAgentRegistryContextForTests } from "../../../../features/AgentRegistryRepository.svelte";
  import { _setACPAgentServersContextForTests } from "../../../../features/AgentServersRepository.svelte";
  import { setACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import { setACPHandoffConfirmationContext } from "../../../../features/HandoffConfirmationContext";
  import {
    _setACPContextForTests,
    type ACPSessionRepository,
  } from "../../../../features/SessionRepository.svelte";
  import PromptConfigControls from "./PromptConfigControls.svelte";

  interface Props {
    repo: unknown;
    registry?: unknown;
    agentServers?: unknown;
    handoff?: { request: (request: unknown) => void };
    conversationId?: string | null;
  }

  let {
    repo,
    registry = { getAgent: () => undefined },
    agentServers = { setDefaultAgentServer: async () => {} },
    handoff = { request: () => {} },
    conversationId = "conversation:test",
  }: Props = $props();

  _setACPContextForTests(repo as ACPSessionRepository);
  _setACPAgentRegistryContextForTests(registry as never);
  _setACPAgentServersContextForTests(agentServers as never);
  setACPHandoffConfirmationContext(handoff as never);
  setACPChatSessionScope(repo as ACPSessionRepository, () => conversationId);
</script>

<PromptConfigControls />
