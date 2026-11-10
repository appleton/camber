<script lang="ts" module>
  import type { IconName } from "@camber/components/icon";

  export interface MobileSelectOption {
    id: string;
    label: string;
    /** Glyph icon; ignored when agentIcon is set. */
    icon?: IconName;
    /** Optional glyph-only colour or presentation class. */
    iconClass?: string;
    /** Render a registry agent icon (masked URL with its built-in fallback). */
    agentIcon?: {
      iconUrl?: string;
      class?: string;
      overlayIconUrl?: string;
      overlayClass?: string;
    };
    /** Indent one level (e.g. a worktree under its project). */
    indent?: boolean;
    /** Secondary trailing text, e.g. the current value of a submenu row. */
    detail?: string;
    /** Secondary line under the label, e.g. what a config value does. */
    caption?: string;
    /** Row opens another sheet: renders a trailing chevron. */
    submenu?: boolean;
    selected?: boolean;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import Icon from "@camber/components/icon";

  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";

  // Bottom-sheet single-select picker: the touch replacement for the empty
  // state's dropdown menus (see MobileActionSheet for the action-list
  // sibling). Options render as full-width rows sized for thumbs.
  interface Props {
    title: string;
    options: MobileSelectOption[];
    onSelect: (id: string) => void;
    onClose: () => void;
  }

  let { title, options, onSelect, onClose }: Props = $props();

  // NSMenu-style icon column: when any row of the sheet carries an icon,
  // icon-less rows reserve the same box so every label starts at the same
  // x. Sheets with no icons at all stay flush-left.
  const reserveIconBox = $derived(options.some((option) => option.agentIcon || option.icon));

  function pick(option: MobileSelectOption) {
    if (option.disabled) return;
    onClose();
    onSelect(option.id);
  }

  // Drag-to-dismiss from the grab handle: follow the finger down, then close if
  // pulled past a threshold, otherwise snap back.
  const DISMISS_THRESHOLD_PX = 80;
  let dragOffset = $state(0);
  let dragging = $state(false);
  let dragStartY = 0;

  function onDragStart(event: PointerEvent) {
    dragging = true;
    dragStartY = event.clientY;
    dragOffset = 0;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onDragMove(event: PointerEvent) {
    if (!dragging) return;
    dragOffset = Math.max(0, event.clientY - dragStartY);
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (dragOffset > DISMISS_THRESHOLD_PX) onClose();
    else dragOffset = 0;
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

<!-- Height tracks the visual viewport (the area above the keyboard) rather than
     inset-0, so when the composer keeps focus the sheet lands above the
     keyboard instead of behind it. Falls back to the full viewport when no
     keyboard is up. See installMobileViewportTracking. -->
<div
  class="fixed inset-x-0 top-0 z-[110] flex flex-col justify-end"
  style="height: var(--visual-viewport-height, 100dvh)"
>
  <button
    type="button"
    class="absolute inset-0 cursor-default bg-black/40"
    aria-label="Close menu"
    onclick={onClose}
  ></button>
  <!-- Flex column capped at a share of the overlay (which has a definite
       height), so the sheet grows to its content and only the options list
       scrolls once it would exceed the cap. A percentage height on the list
       itself would resolve against this auto-height sheet and misbehave. -->
  <div
    role="listbox"
    aria-label={title}
    class="mobile-select-sheet bg-psx-panel shadow-overlay dark:shadow-overlay-dark relative flex max-h-[85%] flex-col rounded-t-2xl px-2 pt-2"
    class:dragging
    style:transform={`translateY(${dragOffset}px)`}
  >
    <!-- Grab handle + title double as the drag-to-dismiss area. touch-none so
         the browser doesn't hijack the vertical drag as a scroll. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="-mx-2 -mt-2 touch-none px-2 pt-2"
      onpointerdown={onDragStart}
      onpointermove={onDragMove}
      onpointerup={onDragEnd}
      onpointercancel={onDragEnd}
    >
      <div class="bg-psx-border mx-auto mb-2 mt-1 h-1 w-9 rounded-full" aria-hidden="true"></div>
      <div class="text-psx-foreground-primary min-w-0 truncate px-3 pb-2 text-[15px] font-semibold">
        {title}
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {#each options as option (option.id)}
        <button
          type="button"
          role="option"
          aria-selected={option.selected === true}
          disabled={option.disabled}
          class={[
            "outline-hidden active:bg-psx-menu-hover-background focus-visible:outline-psx-focus text-psx-foreground-primary flex w-full gap-3 rounded-lg py-3 pr-3 text-left text-[15px] focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
            option.indent ? "pl-9" : "pl-3",
            // A captioned row anchors its icon and trailing marks to the label
            // rather than to the middle of the taller row.
            option.caption ? "items-start" : "items-center",
          ]}
          onclick={() => pick(option)}
        >
          {#if option.agentIcon || option.icon}
            <!-- Sized to one line of the 15px label so the glyph centres on the
                 first line, not on the whole two-line row. -->
            <span class={["flex shrink-0 items-center", option.caption && "h-[1.5em]"]}>
              {#if option.agentIcon}
                <RegistryAgentIcon
                  iconUrl={option.agentIcon.iconUrl}
                  size={18}
                  class={option.agentIcon.class ?? ""}
                  overlayIconUrl={option.agentIcon.overlayIconUrl}
                  overlayClass={option.agentIcon.overlayClass}
                />
              {:else if option.icon}
                <Icon
                  name={option.icon}
                  size={18}
                  class={["shrink-0", option.iconClass]}
                  aria-hidden="true"
                />
              {/if}
            </span>
          {:else if reserveIconBox}
            <!-- The icon column's empty box (icons render 18px square). -->
            <span class="w-[18px] shrink-0" aria-hidden="true"></span>
          {/if}
          {#if option.caption}
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{option.label}</span>
              <span class="text-psx-foreground-tertiary line-clamp-2 text-[13px] leading-snug">
                {option.caption}
              </span>
            </span>
          {:else}
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
          {/if}
          {#if option.detail}
            <span class="text-psx-foreground-tertiary max-w-[45%] shrink-0 truncate text-sm">
              {option.detail}
            </span>
          {/if}
          {#if option.selected || option.submenu}
            <span class={["flex shrink-0 items-center", option.caption && "h-[1.5em]"]}>
              {#if option.selected}
                <Icon name="checkmark" size={16} class="shrink-0 opacity-70" aria-hidden="true" />
              {:else}
                <Icon
                  name="chevron"
                  size={14}
                  class="shrink-0 -rotate-90 opacity-50"
                  aria-hidden="true"
                />
              {/if}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .mobile-select-sheet {
    padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
    animation: mobile-select-sheet-in 160ms ease-out;
    /* Snap back after a drag that didn't cross the dismiss threshold. */
    transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Track the finger 1:1 while dragging. */
  .mobile-select-sheet.dragging {
    transition: none;
  }

  @keyframes mobile-select-sheet-in {
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
