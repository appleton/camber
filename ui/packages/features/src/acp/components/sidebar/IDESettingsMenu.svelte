<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import Icon, { type IconName } from "@camber/components/icon";
  import { rpc } from "../../hostRpc";
  import IDESettingsPill from "./IDESettingsPill.svelte";
  import { suppressContextMenu } from "./contextMenuHelpers";

  interface Props {
    currentView: "agents" | "connectors";
    onShowAgents: () => void;
    onShowConnectors: () => void;
  }

  let { currentView, onShowAgents, onShowConnectors }: Props = $props();

  const {
    elements: { trigger, content },
    states: { open },
  } = createPopover({
    positioning: { placement: "top-end", gutter: 8 },
    forceVisible: true,
  });

  function select(action: () => void): void {
    open.set(false);
    action();
  }
</script>

{#snippet menuItem(
  icon: IconName,
  title: string,
  description: string,
  onclick: () => void,
  disabled = false,
)}
  <button
    type="button"
    class="hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    {onclick}
    {disabled}
    oncontextmenu={suppressContextMenu}
  >
    <Icon name={icon} size={18} class="text-psx-icon shrink-0" />
    <span class="flex min-w-0 flex-col">
      <span class="text-psx-foreground-primary text-xs font-medium">{title}</span>
      <span class="text-psx-foreground-secondary text-[11px]">{description}</span>
    </span>
  </button>
{/snippet}

<IDESettingsPill trigger={$trigger} active={$open} />

{#if $open}
  <div use:melt={$content} class="menu-surface z-50 flex w-[224px] flex-col gap-0.5 p-1.5">
    {@render menuItem(
      "mcp",
      "Connectors",
      "MCP servers & tools",
      () => select(onShowConnectors),
      currentView === "connectors",
    )}
    {@render menuItem(
      "sparkles",
      "Agents",
      "Configure & enable agents",
      () => select(onShowAgents),
      currentView === "agents",
    )}
    {@render menuItem("gear", "Extension Settings", "Camber extension options", () =>
      select(() => rpc.openSettings()),
    )}
  </div>
{/if}
