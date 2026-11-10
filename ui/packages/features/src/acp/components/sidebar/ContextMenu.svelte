<script lang="ts" module>
  import type { IconName } from "@camber/components/icon";

  export interface ContextMenuAction {
    kind?: "action";
    name: string;
    icon: IconName;
    disabled?: boolean;
    accelerator?: string;
    callback: () => void | Promise<void>;
  }

  export interface ContextMenuSeparator {
    kind: "separator";
  }

  export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
</script>

<script lang="ts">
  import Icon from "@camber/components/icon";
  import { onMount } from "svelte";

  interface Props {
    x: number;
    y: number;
    actions: ContextMenuItem[];
    onClose: () => void;
  }

  let { x, y, actions, onClose }: Props = $props();
  let menuElement = $state<HTMLDivElement | null>(null);
  let left = $state(x);
  let top = $state(y);

  onMount(() => {
    if (!menuElement) return;
    const rect = menuElement.getBoundingClientRect();
    left = Math.min(x, window.innerWidth - rect.width - 8);
    top = Math.min(y, window.innerHeight - rect.height - 8);
  });

  function handlePointerDown(event: PointerEvent) {
    if (menuElement?.contains(event.target as Node)) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  async function run(action: ContextMenuAction) {
    if (action.disabled) return;
    onClose();
    await action.callback();
  }
</script>

<svelte:window
  onpointerdown={handlePointerDown}
  onkeydown={handleKeyDown}
  oncontextmenu={(event) => {
    if (!menuElement?.contains(event.target as Node)) onClose();
  }}
/>

<div
  bind:this={menuElement}
  role="menu"
  class="menu-surface fixed z-[100] min-w-[180px] p-1"
  style:left={`${left}px`}
  style:top={`${top}px`}
>
  {#each actions as action, index (action.kind === "separator" ? `separator-${index}` : action.name)}
    {#if action.kind === "separator"}
      <div role="separator" class="menu-separator"></div>
    {:else}
      <button
        type="button"
        role="menuitem"
        disabled={action.disabled}
        class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background focus-visible:bg-psx-menu-hover-background group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
        onclick={() => run(action)}
      >
        <Icon name={action.icon} size={16} aria-hidden="true" />
        <span class="truncate">{action.name}</span>
        {#if action.accelerator}
          <span class="text-psx-foreground-tertiary ml-auto shrink-0 pl-4 text-xs">
            {action.accelerator}
          </span>
        {/if}
      </button>
    {/if}
  {/each}
</div>
