<script lang="ts">
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { appState } from "../../../../hostAdapter";
  import { getACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import ConfigSelectDropdown from "./ConfigSelectDropdown.svelte";
  import {
    configValueAppearance,
    modeIconClass,
    selectedValueName,
    selectValueName,
  } from "./configOptions";

  interface Props {
    option: SessionConfigOption;
    placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  }

  let { option, placement = "top-start" }: Props = $props();

  const chatSession = getACPChatSessionScope();

  const pending = $derived(chatSession.pendingConfigOption(option.id));
  const isPending = $derived(Boolean(pending && !pending.error));
  const displayValue = $derived(
    isPending && pending && option.type === "select" ? pending.value : option.currentValue,
  );
  // Resolved per option kind: the permission taxonomy for the approval mode,
  // the build/plan pair when an agent's collaboration option needs a picker.
  const appearance = $derived(configValueAppearance(option, String(displayValue)));
  const iconClass = $derived(modeIconClass(appearance));
  const label = $derived(
    isPending && pending ? selectValueName(option, pending.value) : selectedValueName(option),
  );
  // The phone footer shares one row with the config trigger and compose
  // actions; a long mode name must yield rather than push them off-screen.
  const isMobile = $derived($appState.environment.assistantHost === "mobile");
</script>

<ConfigSelectDropdown {option} {placement}>
  {#snippet trigger({ open })}
    <span
      class={[
        "text-psx-foreground-primary hover:bg-psx-chrome-hover flex h-7 items-center gap-1 rounded-md px-1.5 text-sm transition-colors",
        open && "bg-psx-chrome-hover",
        isPending && "opacity-60",
      ]}
    >
      <Icon
        name={appearance.icon}
        size={14}
        class={["text-psx-icon shrink-0", iconClass]}
        aria-hidden="true"
      />
      <span class={["truncate", isMobile ? "max-w-[8rem]" : "max-w-[10rem]"]}>{label}</span>
      <Icon name="chevron" size={12} class="shrink-0 opacity-60" aria-hidden="true" />
    </span>
  {/snippet}
</ConfigSelectDropdown>
