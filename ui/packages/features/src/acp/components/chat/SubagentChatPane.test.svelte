<script lang="ts">
  import {
    ClipboardProvider,
    DisplayProvider,
    EnvironmentProvider,
    LogProvider,
  } from "@camber/components/providers";
  import { vi } from "vitest";
  import { setACPAgentRegistryContext } from "../../features/AgentRegistryRepository.svelte";
  import { setACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import type { SessionEvent } from "../../types";
  import SubagentChatPane from "./SubagentChatPane.svelte";

  interface Props {
    events: SessionEvent[];
    subagentKey: string;
    turnActive?: boolean;
  }

  let { events, subagentKey, turnActive = true }: Props = $props();
  const session = {
    sessionId: "session-test",
    conversationId: "conversation-test",
    agentServer: "claude-acp",
    get events() {
      return events;
    },
    turns: [],
    get isPromptActive() {
      return turnActive;
    },
    get activeTurnStartIndex() {
      return turnActive ? 0 : null;
    },
    isSending: false,
  };
  const repo = {
    getSessionByConversationId: () => session,
    agents: { defaultAgentServer: "claude-acp" },
  };

  setACPAgentRegistryContext();
  setACPChatSessionScope(repo as never, () => "conversation-test");
</script>

<EnvironmentProvider name="test">
  <LogProvider onError={vi.fn()} onInfo={vi.fn()}>
    <ClipboardProvider onWrite={vi.fn()}>
      <DisplayProvider>
        <SubagentChatPane {subagentKey} />
      </DisplayProvider>
    </ClipboardProvider>
  </LogProvider>
</EnvironmentProvider>
