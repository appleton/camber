<script lang="ts">
  import Icon from "@camber/components/icon";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { agentServerIconUrl } from "../../localAgentIcon";
  import type { SessionHandoff } from "../../types";
  import { agentName } from "../chat/menus/config/agentConfig";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import Tooltip from "../ui/Tooltip.svelte";

  interface Props {
    event: SessionHandoff;
  }

  let { event }: Props = $props();
  const registry = getACPAgentRegistryRepo();

  function iconUrl(agentServer: string): string | undefined {
    return agentServerIconUrl(agentServer, registry.getAgent(agentServer));
  }
</script>

<div data-session-handoff class="flex items-center py-1">
  <span class="handoff-divider border-psx-border flex-1 dark:border-white/20" aria-hidden="true"
  ></span>
  <Tooltip
    placement="top"
    gutter={4}
    text={`Conversation handed off from ${agentName(registry, event.sourceAgentServer)} to ${agentName(registry, event.targetAgentServer)}`}
  >
    <div
      class="handoff-pill text-psx-foreground-secondary border-psx-border flex cursor-default items-center gap-2 rounded-full px-3 py-1 text-xs dark:border-white/20"
    >
      <span data-handoff-agent="source" class="flex items-center gap-1">
        <RegistryAgentIcon iconUrl={iconUrl(event.sourceAgentServer)} size={13} />
        <span>{agentName(registry, event.sourceAgentServer)}</span>
      </span>
      <Icon name="arrow-right" size={12} aria-hidden="true" />
      <span data-handoff-agent="target" class="flex items-center gap-1">
        <RegistryAgentIcon iconUrl={iconUrl(event.targetAgentServer)} size={13} />
        <span>{agentName(registry, event.targetAgentServer)}</span>
      </span>
      <span class="sr-only">Session handed off</span>
    </div>
  </Tooltip>
  <span class="handoff-divider border-psx-border flex-1 dark:border-white/20" aria-hidden="true"
  ></span>
</div>

<style>
  /* Hairline: one device pixel regardless of backing scale. */
  .handoff-pill {
    border-width: 1px;
  }
  .handoff-divider {
    border-top-width: 1px;
  }
  .handoff-divider:first-child {
    mask-image: linear-gradient(to right, transparent, black 64px);
  }
  .handoff-divider:last-child {
    mask-image: linear-gradient(to left, transparent, black 64px);
  }
  @media (min-resolution: 2dppx) {
    .handoff-pill {
      border-width: 0.5px;
    }
    .handoff-divider {
      border-top-width: 0.5px;
    }
  }
</style>
