<script lang="ts">
  import {
    ClipboardProvider,
    DisplayProvider,
    EnvironmentProvider,
    LogProvider,
  } from "@camber/components/providers";
  import { vi } from "vitest";
  import {
    setACPChatSessionScope,
    type ACPChatSessionScope,
  } from "../features/ChatSessionScope.svelte";
  import { setACPAgentRegistryContext } from "../features/AgentRegistryRepository.svelte";
  import type { ACPSessionRepository } from "../features/SessionRepository.svelte";
  import type { GroupedItem, ToolActivityMode } from "./SessionEventsState.svelte";
  import type { SessionEvent } from "../types";
  import SessionEventsRenderer from "./SessionEventsRenderer.svelte";

  interface Props {
    events: SessionEvent[];
    items: GroupedItem[];
    isPrompting?: boolean;
    toolActivity?: ToolActivityMode;
    scrollElement?: HTMLElement;
    preserveScrollAnchor?: boolean;
  }

  let {
    events,
    items,
    isPrompting = false,
    toolActivity,
    scrollElement,
    preserveScrollAnchor = false,
  }: Props = $props();

  setACPAgentRegistryContext();
  setACPChatSessionScope(
    {
      getSessionByConversationId: () => null,
      agents: {
        get defaultAgentServer() {
          return undefined;
        },
        get nonSessionError() {
          return null;
        },
        authInProgressForAgent: () => false,
        getInitializeResponse: () => undefined,
        isConfigCacheLoadingFor: () => false,
      },
    } as unknown as ACPSessionRepository,
    () => null,
  ) as ACPChatSessionScope;
</script>

<EnvironmentProvider name="test">
  <LogProvider onError={vi.fn()} onInfo={vi.fn()}>
    <ClipboardProvider onWrite={vi.fn()}>
      <DisplayProvider>
        <SessionEventsRenderer
          {events}
          {items}
          {isPrompting}
          {...toolActivity ? { toolActivity } : {}}
          {scrollElement}
          {preserveScrollAnchor}
        />
      </DisplayProvider>
    </ClipboardProvider>
  </LogProvider>
</EnvironmentProvider>
