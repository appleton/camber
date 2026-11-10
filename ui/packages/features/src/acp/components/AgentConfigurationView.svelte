<script lang="ts">
  import Icon from "@camber/components/icon";
  import { appState } from "../hostAdapter";
  import AcpAgentConfigurationSection from "./AgentConfigurationSection.svelte";

  interface Props {
    onDone?: () => void;
  }

  let { onDone }: Props = $props();
  let isDesktop = $derived($appState.environment.assistantHost === "desktop");
</script>

<section class="bg-psx-panel text-psx-foreground-primary flex h-full min-w-0 flex-col">
  <div
    class="border-psx-border relative flex h-fit shrink-0 flex-col items-start gap-2 border-b px-4 py-1.5 pb-3"
    data-tauri-drag-region={isDesktop ? "deep" : undefined}
  >
    <button
      type="button"
      data-tauri-drag-region="false"
      class="text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus relative z-10 flex shrink-0 -translate-x-1 items-center gap-1 py-1.5 text-sm transition-colors duration-200 ease-out focus-visible:outline-2"
      onclick={onDone}
    >
      <Icon name="chevron" size={16} class="rotate-90" aria-hidden="true" />
      <span>Back to Chats</span>
    </button>
    <div class="pointer-events-none relative z-10 flex min-w-0 flex-col gap-1">
      <h1 class="text-psx-foreground-primary truncate text-sm">Configure ACP agents</h1>
      <p class="text-psx-foreground-secondary truncate text-sm">
        Agents are installed and stored locally on this machine.
      </p>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="settings-section-stack">
      <AcpAgentConfigurationSection />
    </div>
  </div>
</section>
