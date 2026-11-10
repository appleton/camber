<script lang="ts">
  import Kbd from "@camber/components/kbd";
  import { MarkdownBlock } from "@camber/components/markdown";
  import type { Snippet } from "svelte";
  import { desktopUpdate } from "../../desktopUpdate";
  import SidebarIconButton from "./SidebarIconButton.svelte";

  interface Props {
    collapsed: boolean;
    width: number;
    minWidth: number;
    maxWidth: number;
    resizing?: boolean;
    showCollapsedActions?: boolean;
    collapseDisabled?: boolean;
    ariaLabel: string;
    toggleTitle: string;
    toggleShortcutHint?: string;
    onCollapsedChange: (collapsed: boolean) => void;
    onResizeStart?: (event: MouseEvent) => void;
    onResizeKeydown?: (event: KeyboardEvent) => void;
    children?: Snippet;
  }

  let {
    collapsed,
    width,
    minWidth,
    maxWidth,
    resizing = false,
    showCollapsedActions = false,
    collapseDisabled = false,
    ariaLabel,
    toggleTitle,
    toggleShortcutHint,
    onCollapsedChange,
    onResizeStart,
    onResizeKeydown,
    children,
  }: Props = $props();

  let toggleDisabled = $derived(collapseDisabled && !collapsed);
  let toggleTooltip = $derived(
    toggleDisabled ? "Cannot hide sidebar while showing settings" : toggleTitle,
  );

  // Self-update "Update" pill (populated by the desktop host once a new version
  // has downloaded). Mirrors Camber Studio: an "Update" text pill (smaller
  // when the sidebar is collapsed), full "Restart to update…" as the tooltip.
  // The pill stays one-click restart; the staged update's release notes open
  // from a separate "What's new" link so wanting to read them never costs an
  // extra click on the restart path.
  let applyingUpdate = $state(false);
  let updateTooltip = $derived.by(() => {
    if (!$desktopUpdate.available) return "";
    if ($desktopUpdate.waitingForIdle) return "Waiting for conversations to finish before updating";
    return $desktopUpdate.version
      ? `Restart to update Camber Assistant to ${$desktopUpdate.version}`
      : "Restart to finish updating Camber Assistant";
  });
  let updateNotes = $derived($desktopUpdate.available ? $desktopUpdate.notes : undefined);
  let notesOpen = $state(false);
  let updateCluster = $state<HTMLDivElement>();
  let notesPanel = $state<HTMLDivElement>();

  // The collapsed titlebar strip has no room for the link, so the popover
  // cannot re-open there; drop its state instead of restoring it stale.
  $effect(() => {
    if (collapsed || !updateNotes) notesOpen = false;
  });

  function closeNotesOnOutsidePointerDown(event: PointerEvent) {
    if (!notesOpen || !updateCluster || updateCluster.contains(event.target as Node)) return;
    notesOpen = false;
  }

  function closeNotesOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") notesOpen = false;
  }

  async function onApplyUpdate() {
    if (applyingUpdate || !$desktopUpdate.available) return;
    applyingUpdate = true;
    try {
      // On success the app relaunches, so the flag never needs resetting; on
      // failure re-enable the button so the restart can be retried.
      await $desktopUpdate.apply();
    } catch (error) {
      console.error("failed to apply desktop update", error);
      applyingUpdate = false;
    }
  }
</script>

<svelte:window onpointerdown={closeNotesOnOutsidePointerDown} onkeydown={closeNotesOnEscape} />

<aside
  class={[
    "desktop-sidebar-panel text-psx-foreground-primary relative z-20 shrink-0 select-none",
    collapsed ? "" : "desktop-sidebar-panel--visible",
    resizing ? "desktop-sidebar-panel--resizing" : "",
  ]}
  style:--desktop-sidebar-width={`${width}px`}
  aria-label={ariaLabel}
>
  {#if !collapsed || showCollapsedActions}
    <div class="desktop-sidebar-toggle-button flex items-center gap-1">
      <SidebarIconButton
        icon={collapsed ? "sidebar-left-closed" : "sidebar-left-open"}
        label={collapsed ? "Show sidebar" : "Hide sidebar"}
        size={16}
        buttonSize="size-[22px]"
        dragRegion
        title={toggleTooltip}
        disabled={toggleDisabled}
        onclick={() => onCollapsedChange(!collapsed)}
      />
      {#if !collapsed && toggleShortcutHint}
        <Kbd label={toggleShortcutHint} class="shrink-0" aria-hidden="true" />
      {/if}
    </div>
  {/if}

  {#if $desktopUpdate.available}
    {#if collapsed}
      <button
        type="button"
        class="desktop-update-button desktop-update-button--collapsed bg-psx-button-primary-background text-psx-button-primary-foreground hover:bg-psx-button-primary-hover-background inline-flex h-5 items-center justify-center rounded-full px-2 text-[10px] font-medium shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-70"
        title={updateTooltip}
        aria-label={updateTooltip}
        data-testid="app-update-action"
        disabled={applyingUpdate}
        onclick={onApplyUpdate}
      >
        {$desktopUpdate.waitingForIdle ? "Waiting…" : "Update"}
      </button>
    {:else}
      <div bind:this={updateCluster} class="desktop-update-cluster flex items-center gap-1.5">
        {#if updateNotes}
          <button
            type="button"
            class="text-psx-foreground-secondary hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus rounded-[4px] px-1 text-[11px] transition-colors focus-visible:outline-2"
            title={`What's new in ${$desktopUpdate.version}`}
            aria-haspopup="dialog"
            aria-expanded={notesOpen}
            data-testid="app-update-notes-toggle"
            onclick={() => (notesOpen = !notesOpen)}
          >
            What's new
          </button>
        {/if}
        <button
          type="button"
          class="desktop-update-button bg-psx-button-primary-background text-psx-button-primary-foreground hover:bg-psx-button-primary-hover-background inline-flex h-6 items-center justify-center rounded-full px-2.5 text-[11px] font-medium shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-70"
          title={updateTooltip}
          aria-label={updateTooltip}
          data-testid="app-update-action"
          disabled={applyingUpdate}
          onclick={onApplyUpdate}
        >
          {$desktopUpdate.waitingForIdle ? "Waiting for conversations…" : "Update"}
        </button>
        {#if notesOpen && updateNotes}
          <div
            bind:this={notesPanel}
            class="desktop-update-notes menu-surface text-psx-foreground-primary"
            role="dialog"
            aria-label={`What's new in ${$desktopUpdate.version}`}
            data-testid="app-update-notes"
          >
            <MarkdownBlock content={updateNotes} scrollElement={notesPanel} />
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if !$desktopUpdate.available && $desktopUpdate.downloading}
    <div
      class="desktop-update-progress bg-psx-chrome border-psx-border text-psx-foreground-secondary absolute flex h-6 w-[132px] items-center overflow-hidden rounded-full border px-2 text-[10px] font-medium shadow-sm"
      role="progressbar"
      aria-label="Downloading update"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={$desktopUpdate.progress === undefined
        ? undefined
        : Math.round($desktopUpdate.progress * 100)}
    >
      <div
        class={[
          "bg-psx-button-primary-background absolute inset-y-0 left-0 opacity-25 transition-[width]",
          $desktopUpdate.progress === undefined && "w-1/3 animate-pulse",
        ]}
        style:width={$desktopUpdate.progress === undefined
          ? undefined
          : `${$desktopUpdate.progress * 100}%`}
      ></div>
      <span class="relative z-10 truncate">
        {$desktopUpdate.progress === undefined
          ? "Downloading update…"
          : `Downloading ${Math.round($desktopUpdate.progress * 100)}%`}
      </span>
    </div>
  {/if}

  <div
    role="slider"
    aria-label="Resize conversations sidebar"
    aria-orientation="vertical"
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    aria-hidden={collapsed ? "true" : undefined}
    tabindex={collapsed ? -1 : 0}
    data-tauri-drag-region="false"
    class={[
      "desktop-sidebar-resize-handle outline-hidden focus-visible:outline-psx-focus absolute inset-y-0 z-40 w-2 cursor-col-resize border-0 bg-transparent p-0 focus-visible:outline-2",
      "before:absolute before:left-1/2 before:-translate-x-1/2 before:rounded-full before:bg-transparent before:transition-colors",
      resizing ? "before:bg-psx-focus" : "",
    ]}
    onmousedown={(event) => onResizeStart?.(event)}
    onkeydown={(event) => onResizeKeydown?.(event)}
  ></div>

  <div class="desktop-sidebar-clip" aria-hidden={collapsed ? "true" : undefined} inert={collapsed}>
    <div class="desktop-sidebar-content">
      {@render children?.()}
    </div>
  </div>
</aside>

<style lang="postcss">
  .desktop-sidebar-panel {
    width: 0;
    margin: 0 0
      var(
        --desktop-sidebar-compensated-inset,
        calc(var(--desktop-main-panel-inset, 8px) - 0.375rem)
      )
      0;
    min-width: 0;
    align-self: stretch;
    overflow: visible;
    /* width/margin are layout properties, so will-change buys nothing here
       (they can never be composited) and only pins extra layer memory. */
    transition:
      width 140ms cubic-bezier(0.2, 0, 0, 1),
      margin-left 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-sidebar-panel--visible {
    width: var(--desktop-sidebar-width);
    margin-left: var(
      --desktop-sidebar-compensated-inset,
      calc(var(--desktop-main-panel-inset, 8px) - 0.375rem)
    );
  }

  .desktop-sidebar-panel--resizing {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-sidebar-panel {
      transition: none;
    }
  }

  .desktop-sidebar-toggle-button {
    position: fixed;
    top: var(--desktop-title-bar-control-top, 12px);
    left: calc(
      var(
          --desktop-sidebar-compensated-inset,
          calc(var(--desktop-main-panel-inset, 8px) - 0.375rem)
        ) +
        var(--desktop-window-controls-space, 88px)
    );
    z-index: 50;
    pointer-events: auto;
  }

  :global(body.desktop-window-fullscreen) .desktop-sidebar-toggle-button {
    left: calc(
      var(
          --desktop-sidebar-compensated-inset,
          calc(var(--desktop-main-panel-inset, 8px) - 0.375rem)
        ) +
        0.375rem + var(--desktop-fullscreen-sidebar-icon-offset, 5px)
    );
  }

  /* "Update" cluster ("What's new" link + pill): anchored to the top-right of
     the sidebar when expanded (mirrors Studio's top:12px / right-of-sidebar
     placement); when collapsed only the pill remains and sits just right of
     the sidebar toggle in the titlebar strip. */
  .desktop-update-cluster {
    position: absolute;
    top: var(--desktop-title-bar-control-top, 12px);
    right: 12px;
    z-index: 50;
    pointer-events: auto;
  }

  .desktop-update-progress {
    top: var(--desktop-title-bar-control-top, 12px);
    right: 12px;
    z-index: 50;
  }

  .desktop-update-button {
    line-height: 1;
    cursor: pointer;
    pointer-events: auto;
  }

  .desktop-update-button--collapsed {
    position: fixed;
    top: var(--desktop-title-bar-control-top, 12px);
    z-index: 50;
    left: calc(
      var(
          --desktop-sidebar-compensated-inset,
          calc(var(--desktop-main-panel-inset, 8px) - 0.375rem)
        ) +
        var(--desktop-window-controls-space, 88px) + 34px
    );
  }

  /* Release notes for the staged update, anchored under the cluster. The
     cluster sits 12px from the right edge of a sidebar that hugs the window's
     left edge, and the root overflow: clip swallows anything past that edge —
     so the panel clamps to the sidebar's width instead of a fixed 320px. */
  .desktop-update-notes {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 320px;
    max-width: calc(var(--desktop-sidebar-width, 260px) - 24px);
    max-height: min(420px, 60vh);
    overflow-y: auto;
    padding: 10px 14px;
    font-size: 12px;
    line-height: 1.5;
    user-select: text;
  }

  .desktop-sidebar-clip {
    /* Wider than the panel: the conversation list scroller extends 4px into
       the sidebar→panel gap so the OS scrollbar paints beside the rows
       (DesktopSideBar's .desktop-sidebar-scroll), and the clip runs another
       4px past that so the thumb's anti-aliased edge isn't shaved at a flush
       clip boundary. The overhang band only ever contains the scrollbar, and
       while collapsed the clip's leftmost 8px show nothing but the list's
       leading padding, so the collapse animation is unaffected. */
    width: calc(100% + 8px);
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .desktop-sidebar-panel--visible .desktop-sidebar-clip {
    pointer-events: auto;
  }

  .desktop-sidebar-content {
    position: relative;
    display: flex;
    flex-direction: column;
    width: var(--desktop-sidebar-width);
    min-width: var(--desktop-sidebar-width);
    height: 100%;
    min-height: 0;
    opacity: 1;
    transform: translateX(0);
    transition: none;
  }

  /* While collapsed, skip the sidebar's whole subtree in layout/paint. The
     panel animates to width 0 but the fixed-width content inside otherwise
     keeps relayouting on every frame of any panel/divider animation.
     content-visibility transitions as discrete: with allow-discrete the
     content stays rendered for the whole collapse slide and flips to hidden
     only at the end, so the animation is visually unchanged. */
  @supports (transition-behavior: allow-discrete) {
    .desktop-sidebar-panel:not(.desktop-sidebar-panel--visible) .desktop-sidebar-content {
      content-visibility: hidden;
    }

    .desktop-sidebar-content {
      transition: content-visibility 140ms allow-discrete;
    }
  }

  .desktop-sidebar-resize-handle {
    /* 4px further out than the gap's centre: the conversation list's OS
       scrollbar paints in the inner half of the gap, and the handle would
       otherwise sit on top of the thumb and steal its pointer events. The
       outer overhang lies over the main panel's inert padding. */
    right: calc(-0.5 * var(--desktop-main-panel-sidebar-gap, 8px) - 0.25rem - 4px);
    opacity: 0;
    pointer-events: none;
  }

  .desktop-sidebar-panel--visible .desktop-sidebar-resize-handle {
    opacity: 1;
    pointer-events: auto;
  }

  .desktop-sidebar-resize-handle::before {
    width: 1px;
    inset-block: 8px;
    mask-image: linear-gradient(
      to bottom,
      transparent,
      #000 40px,
      #000 calc(100% - 40px),
      transparent
    );
  }

  .desktop-sidebar-resize-handle:hover::before,
  .desktop-sidebar-resize-handle:focus-visible::before {
    background: var(--psx-focus);
  }

  /* Keep the desktop sidebar on the native arrow cursor, including drag,
     hover, active, and disabled states supplied by nested controls. */
  .desktop-sidebar-panel,
  .desktop-sidebar-panel :global(*) {
    cursor: default !important;
  }

  /* Except the resize handle — and while a drag is in flight, the whole
     panel — which must win over the arrow-cursor blanket above (both are
     !important, so specificity decides). */
  .desktop-sidebar-panel .desktop-sidebar-resize-handle,
  :global(body.desktop-sidebar-resizing) .desktop-sidebar-panel,
  :global(body.desktop-sidebar-resizing) .desktop-sidebar-panel :global(*) {
    cursor: col-resize !important;
  }
</style>
