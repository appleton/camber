<script lang="ts" module>
  import type { ContextMenuAction, ContextMenuSeparator } from "./ContextMenu.svelte";

  export interface MobileSheetAction extends ContextMenuAction {
    danger?: boolean;
  }

  export type MobileSheetItem = MobileSheetAction | ContextMenuSeparator;
</script>

<script lang="ts">
  import Icon from "@camber/components/icon";

  interface Props {
    title: string;
    subtitle?: string;
    actions: MobileSheetItem[];
    onClose: () => void;
  }

  let { title, subtitle, actions, onClose }: Props = $props();

  async function run(action: MobileSheetAction) {
    if (action.disabled) return;
    onClose();
    await action.callback();
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }}
/>

<div class="fixed inset-0 z-[110] flex flex-col justify-end">
  <button
    type="button"
    class="absolute inset-0 cursor-default bg-black/40"
    aria-label="Close menu"
    onclick={onClose}
  ></button>
  <div
    role="menu"
    aria-label={`Actions for ${title}`}
    class="mobile-action-sheet bg-psx-panel shadow-overlay dark:shadow-overlay-dark relative rounded-t-2xl px-2 pt-2"
  >
    <div class="bg-psx-border mx-auto mb-2 mt-1 h-1 w-9 rounded-full" aria-hidden="true"></div>
    <div class="min-w-0 px-3 pb-2">
      <div class="text-psx-foreground-primary truncate text-[15px] font-semibold">{title}</div>
      {#if subtitle}
        <div class="text-psx-foreground-secondary truncate text-xs">{subtitle}</div>
      {/if}
    </div>
    {#each actions as action, index (action.kind === "separator" ? `separator-${index}` : action.name)}
      {#if action.kind === "separator"}
        <div role="separator" class="bg-psx-border/70 mx-3 my-1 h-px"></div>
      {:else}
        <button
          type="button"
          role="menuitem"
          disabled={action.disabled}
          class={[
            "outline-hidden active:bg-psx-menu-hover-background focus-visible:outline-psx-focus flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px] focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
            action.danger ? "text-psx-error-foreground" : "text-psx-foreground-primary",
          ]}
          onclick={() => run(action)}
        >
          <Icon name={action.icon} size={18} aria-hidden="true" />
          <span class="min-w-0 truncate">{action.name}</span>
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .mobile-action-sheet {
    padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
    animation: mobile-action-sheet-in 160ms ease-out;
  }

  @keyframes mobile-action-sheet-in {
    from {
      transform: translateY(24px);
      opacity: 0.6;
    }

    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
