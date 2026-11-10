<script lang="ts">
  import { createDropdownMenu, melt } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";
  import { setContext, type Snippet } from "svelte";

  interface Props {
    label: string;
    triggerIcon?: IconName;
    triggerIconSize?: number;
    triggerClass?: string;
    /** Opt the trigger out of the host window drag region (desktop title bar). */
    triggerDragRegion?: boolean;
    placement?: "bottom-end" | "bottom-start" | "top-end" | "top-start";
    children: Snippet;
  }

  let {
    label,
    triggerIcon = "more",
    triggerIconSize = 14,
    triggerClass = "",
    triggerDragRegion = false,
    placement = "bottom-end",
    children,
  }: Props = $props();

  const menu = createDropdownMenu({
    positioning: { placement },
    forceVisible: true,
  });

  const {
    elements: { trigger, menu: menuEl },
    states: { open },
  } = menu;

  setContext("dropdown", menu);
  setContext("dropdown-search", {
    get query() {
      return "";
    },
  });
</script>

<button
  type="button"
  use:melt={$trigger}
  aria-label={label}
  title={label}
  class={triggerClass}
  data-tauri-drag-region={triggerDragRegion ? "false" : undefined}
>
  <Icon name={triggerIcon} size={triggerIconSize} aria-hidden="true" />
</button>

{#if $open}
  <div use:melt={$menuEl} class="menu-surface z-50 min-w-[180px] p-1">
    {@render children()}
  </div>
{/if}
