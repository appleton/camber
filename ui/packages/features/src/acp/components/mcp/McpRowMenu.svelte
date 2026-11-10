<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { appState } from "../../hostAdapter";
  import { supportsNativeMenus } from "../chat/desktopContextMenu";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";
  import { mcpMenuDangerItemClass, mcpMenuItemClass } from "./mcpMenu";

  type MenuSpecAction = Extract<MenuSpecItem, { kind: "action" }>;

  // The actions menu shared by the connector rows: the "…" trigger button
  // plus its menu, driven by `items`. Presents an OS-native menu on the
  // macOS desktop host and the melt popover everywhere else, so callers
  // describe their actions once. `busy` swaps the trigger glyph for a
  // spinner. MCP row menus are always flat action lists, so the DOM path
  // doesn't render nested submenus.
  interface Props {
    items: MenuSpecItem[];
    onSelect: (id: string) => void;
    busy?: boolean;
    widthClass?: string;
  }

  let { items, onSelect, busy = false, widthClass = "w-[180px]" }: Props = $props();

  const triggerBaseClass =
    "text-psx-icon hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus flex size-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-2";

  const native = $derived(supportsNativeMenus($appState.environment));

  let triggerButton: HTMLButtonElement | undefined = $state();
  let nativeOpen = $state(false);

  async function openNativeMenu() {
    if (!triggerButton || nativeOpen) return;
    const rect = triggerButton.getBoundingClientRect();
    nativeOpen = true;
    try {
      const id = await presentNativeMenu(items, {
        x: rect.right,
        y: rect.bottom + 4,
        align: "end",
      });
      if (id !== undefined) onSelect(id);
    } finally {
      nativeOpen = false;
    }
  }

  const {
    elements: { trigger, content },
    states: { open },
  } = createPopover({ positioning: { placement: "bottom-end", gutter: 4 }, forceVisible: true });

  function close() {
    open.set(false);
  }

  function selectFromDom(item: MenuSpecAction) {
    close();
    onSelect(item.id);
  }
</script>

{#if native}
  <button
    type="button"
    bind:this={triggerButton}
    class={[
      triggerBaseClass,
      nativeOpen ? "bg-psx-menu-hover-background text-psx-foreground-primary" : "",
    ]}
    aria-label="Connector actions"
    aria-haspopup="menu"
    aria-expanded={nativeOpen}
    onclick={openNativeMenu}
  >
    {#if busy}<Spinner size={14} />{:else}<Icon name="more" size={16} />{/if}
  </button>
{:else}
  <button
    type="button"
    use:melt={$trigger}
    class={[
      triggerBaseClass,
      $open ? "bg-psx-menu-hover-background text-psx-foreground-primary" : "",
    ]}
    aria-label="Connector actions"
  >
    {#if busy}<Spinner size={14} />{:else}<Icon name="more" size={16} />{/if}
  </button>

  {#if $open}
    <div use:melt={$content} class={["menu-surface z-50 flex flex-col gap-0.5 p-1", widthClass]}>
      {#each items as item, index (index)}
        {#if item.kind === "separator"}
          <div class="bg-psx-border my-0.5 h-px"></div>
        {:else if item.kind === "action"}
          {#if item.enabled === false}
            <!-- Disabled actions are informational rather than interactive
                 (e.g. "managed by Camber"): render as inert text, not a
                 disabled button. -->
            <div
              class="text-psx-foreground-secondary flex items-center gap-2 px-2 py-1.5 text-[13px]/[18px]"
            >
              {#if typeof item.icon === "string"}
                <Icon name={item.icon} size={14} class="text-psx-icon shrink-0" />
              {/if}
              {item.label}
            </div>
          {:else}
            <button
              type="button"
              class={item.destructive ? mcpMenuDangerItemClass : mcpMenuItemClass}
              onclick={() => selectFromDom(item)}
            >
              {#if typeof item.icon === "string"}
                <Icon
                  name={item.icon}
                  size={14}
                  class={item.destructive ? "shrink-0" : "text-psx-icon shrink-0"}
                />
              {/if}
              {item.label}
            </button>
          {/if}
        {/if}
      {/each}
    </div>
  {/if}
{/if}
