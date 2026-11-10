<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import type { Snippet } from "svelte";
  import { desktopUpdate } from "../../desktopUpdate";

  interface DesktopSettingsBreadcrumb {
    label: string;
    icon?: IconName;
    onClick?: () => void;
  }

  interface Props {
    title: string;
    subtitle?: string;
    // Leading label rendered before the breadcrumbs (defaults to "Settings").
    // Standalone panels such as Connectors pass their own root label.
    rootLabel?: string;
    breadcrumbs?: readonly DesktopSettingsBreadcrumb[];
    // Only standalone panels (Connectors) can collapse the sidebar; settings
    // sections pin it open and leave this undefined. When defined, the header
    // reserves room for the macOS traffic lights while the sidebar is
    // collapsed, mirroring the chat tab bar's spacer.
    sidebarCollapsed?: boolean;
    children?: Snippet;
  }

  let { title, rootLabel = "Settings", breadcrumbs, sidebarCollapsed, children }: Props = $props();
  let headerBreadcrumbs = $derived(breadcrumbs ?? [{ label: title }]);
  let hasPaneTopOverflow = $state(false);
  let hasPaneBottomOverflow = $state(false);

  function updatePaneOverflow(element: HTMLDivElement): void {
    const nextTopOverflow = element.scrollTop > 1;
    const nextBottomOverflow = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
    if (hasPaneTopOverflow !== nextTopOverflow) hasPaneTopOverflow = nextTopOverflow;
    if (hasPaneBottomOverflow !== nextBottomOverflow) {
      hasPaneBottomOverflow = nextBottomOverflow;
    }
  }

  // Install observers as a node action so overflow-state DOM updates cannot
  // invalidate their own lifecycle and repeatedly recreate the observers.
  function observePaneOverflow(element: HTMLDivElement) {
    updatePaneOverflow(element);

    let animationFrame: number | undefined;
    const scheduleOverflowUpdate = () => {
      if (animationFrame !== undefined) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined;
        updatePaneOverflow(element);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleOverflowUpdate);
    resizeObserver.observe(element);
    let observedContent = element.firstElementChild;
    if (observedContent) resizeObserver.observe(observedContent);

    const mutationObserver = new MutationObserver(() => {
      const nextContent = element.firstElementChild;
      if (nextContent !== observedContent) {
        if (observedContent) resizeObserver.unobserve(observedContent);
        observedContent = nextContent;
        if (observedContent) resizeObserver.observe(observedContent);
      }
      scheduleOverflowUpdate();
    });
    // Content and text changes can affect scroll height. Attribute changes are
    // deliberately excluded: this pane writes its own overflow data attributes,
    // and observing those writes creates a render-observer feedback cycle.
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

    return {
      destroy() {
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      },
    };
  }
</script>

<section class="desktop-settings-panel text-psx-foreground-primary">
  <div class="desktop-settings-top-drag-region" data-tauri-drag-region="deep"></div>
  <div class="desktop-settings-frame">
    <div class="desktop-settings-header" data-tauri-drag-region="deep">
      {#if sidebarCollapsed !== undefined}
        <div
          class={[
            "desktop-settings-traffic-light-spacer",
            sidebarCollapsed ? "" : "desktop-settings-traffic-light-spacer--hidden",
            sidebarCollapsed && $desktopUpdate.available
              ? "desktop-settings-traffic-light-spacer--with-update"
              : "",
          ]}
          data-tauri-drag-region="deep"
          aria-hidden="true"
        ></div>
      {/if}
      <div class="flex w-full min-w-0 items-center gap-2 text-sm/[20px]">
        <h1 class="text-psx-foreground-primary truncate px-0.5 font-medium">{rootLabel}</h1>
        {#each headerBreadcrumbs as crumb (crumb.label)}
          <span class="text-psx-foreground-tertiary" aria-hidden="true">→</span>
          {#if crumb.onClick}
            <button
              type="button"
              data-tauri-drag-region="false"
              class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus flex min-w-0 items-center gap-1 rounded-[5px] px-1 py-0.5 focus-visible:outline-2"
              onclick={crumb.onClick}
            >
              {#if crumb.icon}
                <Icon name={crumb.icon} size={14} class="shrink-0" aria-hidden="true" />
              {/if}
              <span class="min-w-0 truncate">{crumb.label}</span>
            </button>
          {:else}
            <span
              class="text-psx-foreground-secondary flex min-w-0 items-center gap-1 truncate rounded-[5px] px-0.5 py-0.5"
            >
              {#if crumb.icon}
                <Icon name={crumb.icon} size={14} class="shrink-0" aria-hidden="true" />
              {/if}
              <span class="min-w-0 truncate">{crumb.label}</span>
            </span>
          {/if}
        {/each}
      </div>
    </div>
    <div
      use:observePaneOverflow
      class="desktop-settings-pane"
      data-overflow-top={hasPaneTopOverflow}
      data-overflow-bottom={hasPaneBottomOverflow}
      onscroll={(event) => updatePaneOverflow(event.currentTarget)}
    >
      {@render children?.()}
    </div>
  </div>
</section>

<style lang="postcss">
  .desktop-settings-panel {
    --desktop-splits-tab-top-margin: 6px;
    --desktop-splits-shadow-gutter: 6px;
    --settings-section-stack-inline-padding: 0px;
    /* Keep the settings card's soft, layered lift aligned with the chat pane. */
    --desktop-splits-pane-shadow:
      0 4px 12px rgba(0, 0, 0, 0.05), 0 1px 6px rgba(0, 0, 0, 0.025),
      0 0.5px 2px rgba(0, 0, 0, 0.05);
    --desktop-splits-panel-top-inset: max(
      0px,
      calc(var(--desktop-splits-tab-top-margin) - var(--desktop-splits-shadow-gutter))
    );
    --desktop-splits-panel-inset: max(
      0px,
      calc(var(--desktop-main-panel-inset, 8px) - var(--desktop-splits-shadow-gutter))
    );
    --desktop-splits-panel-sidebar-gap: max(
      0px,
      calc(var(--desktop-main-panel-sidebar-gap, 8px) - var(--desktop-splits-shadow-gutter))
    );

    position: relative;
    z-index: 10;
    box-sizing: border-box;
    padding: var(--desktop-splits-panel-top-inset) var(--desktop-splits-panel-inset)
      var(--desktop-splits-panel-inset) var(--desktop-splits-panel-sidebar-gap);
    min-width: 0;
    height: 100%;
    min-height: 0;
    align-self: stretch;
    flex: 1 1 0;
  }

  .desktop-settings-top-drag-region {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 1;
    height: var(--desktop-splits-tab-top-margin);
  }

  :global(.vscode-dark) .desktop-settings-panel {
    --desktop-splits-pane-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), 0 1px 6px rgba(0, 0, 0, 0.2);
  }

  .desktop-settings-frame {
    display: flex;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: visible;
    border-radius: var(--desktop-main-panel-radius, 10px);
    padding: var(--desktop-splits-shadow-gutter);
    background: var(--psx-panel);
  }

  .desktop-settings-header {
    display: flex;
    box-sizing: border-box;
    height: 34px;
    min-height: 34px;
    align-items: center;
    padding: 0 16px;
  }

  /* Mirrors .desktop-tab-bar-traffic-light-spacer in DesktopSplitsPane. */
  .desktop-settings-traffic-light-spacer {
    width: calc(var(--desktop-window-controls-space, 88px) + 24px);
    min-width: calc(var(--desktop-window-controls-space, 88px) + 24px);
    height: 100%;
    flex: 0 0 auto;
    transition:
      width 180ms cubic-bezier(0.2, 0, 0, 1),
      min-width 180ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-settings-traffic-light-spacer--hidden {
    width: 0;
    min-width: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-settings-traffic-light-spacer {
      transition: none;
    }
  }

  /* Collapsed sidebar + a downloaded update: reserve extra room so the sidebar
     "Update" pill doesn't overlap the header. */
  .desktop-settings-traffic-light-spacer--with-update {
    width: calc(var(--desktop-window-controls-space, 88px) + 24px + 72px);
    min-width: calc(var(--desktop-window-controls-space, 88px) + 24px + 72px);
  }

  :global(body.desktop-window-fullscreen) .desktop-settings-traffic-light-spacer {
    width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px);
    min-width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px);
  }

  :global(body.desktop-window-fullscreen) .desktop-settings-traffic-light-spacer--with-update {
    width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px + 72px);
    min-width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px + 72px);
  }

  :global(body.desktop-window-fullscreen) .desktop-settings-traffic-light-spacer--hidden {
    width: 0;
    min-width: 0;
  }

  .desktop-settings-pane {
    --desktop-settings-overflow-fade-height: 28px;
    --desktop-settings-overflow-mask-top: #000;
    --desktop-settings-overflow-mask-bottom: #000;

    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    flex: 1 1 0;
    margin-inline: calc(var(--desktop-splits-shadow-gutter) * -1);
    padding-inline: var(--desktop-splits-shadow-gutter);
    overflow-x: hidden;
    overflow-y: auto;
    border-radius: var(--desktop-main-panel-radius, 10px);
    -webkit-mask-image: linear-gradient(
      to bottom,
      var(--desktop-settings-overflow-mask-top) 0,
      #000 var(--desktop-settings-overflow-fade-height),
      #000 calc(100% - var(--desktop-settings-overflow-fade-height)),
      var(--desktop-settings-overflow-mask-bottom) 100%
    );
    mask-image: linear-gradient(
      to bottom,
      var(--desktop-settings-overflow-mask-top) 0,
      #000 var(--desktop-settings-overflow-fade-height),
      #000 calc(100% - var(--desktop-settings-overflow-fade-height)),
      var(--desktop-settings-overflow-mask-bottom) 100%
    );
    -webkit-mask-mode: alpha;
    mask-mode: alpha;
    scrollbar-gutter: stable;
  }

  .desktop-settings-pane[data-overflow-top="true"] {
    --desktop-settings-overflow-mask-top: transparent;
  }

  .desktop-settings-pane[data-overflow-bottom="true"] {
    --desktop-settings-overflow-mask-bottom: transparent;
  }
</style>
