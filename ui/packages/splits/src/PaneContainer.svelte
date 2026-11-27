<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SplitsController } from "./controller.js";
  import DefaultEmptyPane from "./DefaultEmptyPane.svelte";
  import {
    addTabPointerDragListener,
    canDropTabInPane,
    canDropTabOnTarget,
    hasTabTransfer,
    readTabTransfer,
    registerPaneController,
    sourceControllerForTabTransfer,
    type TabDropZone,
    type TabTransferData,
    type TabPointerDragEvent,
  } from "./internal/drag.js";
  import PaneShape from "./PaneShape.svelte";
  import TabBar from "./TabBar.svelte";
  import type { ContentViewLifecycle, PaneID, PaneState, Tab } from "./types.js";

  type DropZone = TabDropZone;

  interface Props {
    controller: SplitsController;
    pane: PaneState;
    version: number;
    showSplitButtons: boolean;
    tabBarWindowDrag: boolean;
    tabBarLeading?: Snippet<[PaneID]>;
    tabIcon?: Snippet<[Tab]>;
    tabTrailing?: Snippet<[Tab]>;
    newTabButton?: Snippet<[PaneID]>;
    tabBarActions?: Snippet<[PaneID]>;
    tabShortcutLabel?: (tab: Tab) => string | undefined;
    showTabShortcutLabels: boolean;
    onTabContextMenu?: (args: { paneId: PaneID; tabId: string; event: MouseEvent }) => void;
    contentViewLifecycle: ContentViewLifecycle;
    content: Snippet<[Tab, PaneID]>;
    emptyPane?: Snippet<[PaneID]>;
    usePaneShape: boolean;
    paneShapeAnimating: boolean;
    bottomLeftRadius?: number;
    bottomRightRadius?: number;
  }

  let {
    controller,
    pane,
    version,
    showSplitButtons,
    tabBarWindowDrag,
    tabBarLeading,
    tabIcon,
    tabTrailing,
    newTabButton,
    tabBarActions,
    tabShortcutLabel,
    showTabShortcutLabels,
    onTabContextMenu,
    contentViewLifecycle,
    content,
    emptyPane,
    usePaneShape,
    paneShapeAnimating,
    bottomLeftRadius,
    bottomRightRadius,
  }: Props = $props();

  let activeDropZone = $state<DropZone | undefined>();
  let lastDropZone = $state<DropZone>("center");
  let paneElement = $state<HTMLElement>();
  let paneContentElement = $state<HTMLElement>();

  const tabs = $derived.by(() => {
    version;
    return pane.tabs;
  });

  const selectedTab = $derived.by(() => {
    version;
    return pane.tabs.find((tab) => tab.id === pane.selectedTabId);
  });
  function focusPane() {
    controller.focusPane(pane.id);
  }

  $effect(() => {
    return addTabPointerDragListener(handleTabPointerDrag);
  });

  $effect(() => {
    return registerPaneController(pane.id, controller);
  });

  function handleTabPointerDrag(event: TabPointerDragEvent) {
    if (event.type === "end" || event.type === "cancel") {
      activeDropZone = undefined;
      return;
    }

    const element = paneContentElement;
    const transfer = event.transfer;
    if (
      !element ||
      !transfer ||
      event.clientX === undefined ||
      event.clientY === undefined ||
      !canAcceptTransfer(transfer) ||
      !pointIsInsideElement(element, event.clientX, event.clientY)
    ) {
      activeDropZone = undefined;
      return;
    }

    const nextDropZone = zoneForPoint(element, event.clientX, event.clientY);
    if (!canDropTabOnTarget(transfer, controller, pane.id, nextDropZone)) {
      activeDropZone = undefined;
      return;
    }

    activeDropZone = nextDropZone;
    lastDropZone = nextDropZone;
  }

  function dragOver(event: DragEvent) {
    if (!event.dataTransfer || !hasTabTransfer(event.dataTransfer)) {
      return;
    }

    const transfer = readTabTransfer(event.dataTransfer);
    if (!transfer || !canAcceptTransfer(transfer)) {
      return;
    }

    const nextDropZone = zoneForPoint(
      event.currentTarget as HTMLElement,
      event.clientX,
      event.clientY,
    );
    if (!canDropTabOnTarget(transfer, controller, pane.id, nextDropZone)) {
      activeDropZone = undefined;
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    activeDropZone = nextDropZone;
    lastDropZone = nextDropZone;
  }

  function dragLeave(event: DragEvent) {
    if (!event.currentTarget || !event.relatedTarget) {
      activeDropZone = undefined;
      return;
    }

    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
      activeDropZone = undefined;
    }
  }

  function drop(event: DragEvent) {
    if (!event.dataTransfer) {
      return;
    }

    const transfer = readTabTransfer(event.dataTransfer);
    const zone =
      activeDropZone ??
      zoneForPoint(event.currentTarget as HTMLElement, event.clientX, event.clientY);
    activeDropZone = undefined;
    if (
      !transfer ||
      !canAcceptTransfer(transfer) ||
      !canDropTabOnTarget(transfer, controller, pane.id, zone)
    ) {
      return;
    }

    event.preventDefault();
    const sourceController = sourceControllerForTabTransfer(transfer);
    if (!sourceController) {
      return;
    }

    if (zone === "center") {
      controller.moveTabFromController(
        sourceController,
        transfer.tabId,
        transfer.sourcePaneId,
        pane.id,
      );
      return;
    }

    if (!controller.configuration.allowSplits) {
      return;
    }

    controller.moveTabFromControllerToSplit(
      sourceController,
      transfer.tabId,
      transfer.sourcePaneId,
      pane.id,
      orientationForZone(zone),
      {
        insertFirst: zone === "left" || zone === "top",
      },
    );
  }

  function canAcceptTransfer(transfer: TabTransferData): boolean {
    return canDropTabInPane(transfer, controller, pane.id);
  }

  function pointIsInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
    const rect = element.getBoundingClientRect();
    return (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    );
  }

  function zoneForPoint(element: HTMLElement, clientX: number, clientY: number): DropZone {
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const horizontalEdge = Math.max(80, rect.width * 0.25);
    const verticalEdge = Math.max(80, rect.height * 0.25);

    if (x < horizontalEdge) {
      return "left";
    }

    if (x > rect.width - horizontalEdge) {
      return "right";
    }

    if (y < verticalEdge) {
      return "top";
    }

    if (y > rect.height - verticalEdge) {
      return "bottom";
    }

    return "center";
  }

  function orientationForZone(zone: Exclude<DropZone, "center">) {
    return zone === "left" || zone === "right" ? "horizontal" : "vertical";
  }

  const dropPreviewStyle = $derived.by(() => {
    const edge = "4px";
    const halfSize = "calc(50% - 6px)";
    const farSideOffset = "calc(50% + 2px)";
    const fullSize = "calc(100% - 8px)";

    const bounds = {
      center: {
        top: edge,
        left: edge,
        width: fullSize,
        height: fullSize,
      },
      left: {
        top: edge,
        left: edge,
        width: halfSize,
        height: fullSize,
      },
      right: {
        top: edge,
        left: farSideOffset,
        width: halfSize,
        height: fullSize,
      },
      top: {
        top: edge,
        left: edge,
        width: fullSize,
        height: halfSize,
      },
      bottom: {
        top: farSideOffset,
        left: edge,
        width: fullSize,
        height: halfSize,
      },
    } satisfies Record<DropZone, Record<"top" | "left" | "width" | "height", string>>;

    const { top, left, width, height } = bounds[lastDropZone];
    return `--splits-drop-preview-top: ${top}; --splits-drop-preview-left: ${left}; --splits-drop-preview-width: ${width}; --splits-drop-preview-height: ${height};`;
  });
</script>

<section
  bind:this={paneElement}
  class="splits-pane"
  class:splits-pane-has-selected-tab={selectedTab !== undefined}
  data-pane-id={pane.id}
  data-version={version}
  style:--splits-pane-bottom-left-radius={bottomLeftRadius === undefined
    ? undefined
    : `${bottomLeftRadius}px`}
  style:--splits-pane-bottom-right-radius={bottomRightRadius === undefined
    ? undefined
    : `${bottomRightRadius}px`}
>
  {#if usePaneShape}
    <PaneShape
      paneId={pane.id}
      tabId={pane.selectedTabId}
      {version}
      {paneElement}
      {paneContentElement}
      {bottomLeftRadius}
      {bottomRightRadius}
      animating={paneShapeAnimating}
    />
  {/if}

  <TabBar
    {controller}
    {pane}
    {version}
    {showSplitButtons}
    {tabBarWindowDrag}
    {tabBarLeading}
    {tabIcon}
    {tabTrailing}
    {newTabButton}
    {tabBarActions}
    {tabShortcutLabel}
    {showTabShortcutLabels}
    {onTabContextMenu}
  />

  <div
    bind:this={paneContentElement}
    class="splits-pane-content"
    class:splits-drop-active={activeDropZone !== undefined}
    data-splits-pane-content
    data-splits-pane-id={pane.id}
    role="presentation"
    onpointerdown={focusPane}
    ondragover={dragOver}
    ondragleave={dragLeave}
    ondrop={drop}
  >
    {#if tabs.length === 0}
      {#if emptyPane}
        {@render emptyPane(pane.id)}
      {:else}
        <DefaultEmptyPane {controller} paneId={pane.id} {version} />
      {/if}
    {:else if contentViewLifecycle === "keepAllAlive"}
      <div class="splits-content-stack">
        {#each tabs as tab (tab.id)}
          {@const isHidden = tab.id !== pane.selectedTabId}
          <div
            aria-hidden={isHidden ? "true" : undefined}
            inert={isHidden}
            class:splits-content-hidden={isHidden}
            class="splits-content-instance"
          >
            {@render content(tab, pane.id)}
          </div>
        {/each}
      </div>
    {:else if selectedTab}
      {@render content(selectedTab, pane.id)}
    {/if}

    <div class="splits-drop-preview" style={dropPreviewStyle} aria-hidden="true"></div>
  </div>
</section>

<style>
  .splits-pane {
    position: relative;
    isolation: isolate;
    display: flex;
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    height: 100%;
    flex-direction: column;
    overflow: var(--splits-pane-overflow, hidden);
    border: var(--splits-pane-shell-border, var(--splits-pane-border));
    border-radius: var(--splits-pane-radius);
    border-bottom-left-radius: var(--splits-pane-bottom-left-radius, var(--splits-pane-radius));
    border-bottom-right-radius: var(--splits-pane-bottom-right-radius, var(--splits-pane-radius));
    background: var(--splits-pane-shell-background, var(--splits-pane-background));
    box-shadow: var(--splits-pane-shell-shadow, var(--splits-pane-shadow));
  }

  .splits-pane-content {
    position: relative;
    z-index: 1;
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
    border-radius: var(--splits-pane-content-top-left-radius, 0)
      var(--splits-pane-content-top-right-radius, 0)
      var(--splits-pane-bottom-right-radius, var(--splits-pane-radius))
      var(--splits-pane-bottom-left-radius, var(--splits-pane-radius));
    background: transparent;
    box-shadow: none;
  }

  .splits-pane-has-selected-tab .splits-pane-content {
    background: var(--splits-pane-content-background, transparent);
    box-shadow: var(--splits-pane-content-shadow, none);
  }

  /* The silhouette paints the selected tab and its panel as one surface.
     Set these on the tab itself so inherited inactive-pane theme overrides
     cannot bring back a second fill, outline, or shadow at the join. */
  .splits-pane:has(:global([data-pane-shape-ready])) :global(.splits-tab-selected) {
    --splits-active-tab-visual-background: transparent;
    --splits-active-tab-visual-border: transparent;
    --splits-active-tab-shadow: none;
    --splits-active-tab-corner-display: none;
  }

  .splits-pane:has(:global([data-pane-shape-ready])) .splits-pane-content {
    background: transparent;
    box-shadow: none;
  }

  .splits-pane:has(:global(.splits-tab-selected:not([data-splits-tab-index="0"])))
    .splits-pane-content {
    border-top-left-radius: var(
      --splits-pane-content-detached-top-left-radius,
      var(--splits-pane-content-top-left-radius, 0)
    );
  }

  .splits-content-stack,
  .splits-content-instance {
    position: absolute;
    inset: 0;
    min-width: 0;
    min-height: 0;
  }

  .splits-content-hidden {
    opacity: 0;
    pointer-events: none;
    /* Take background tabs out of layout/paint entirely (state is preserved,
       unlike display: none). With keepAllAlive every hidden tab otherwise
       relayouts on every frame of a panel/sidebar/divider animation, which is
       the dominant animation-jank cost once a few terminals are open. The
       instance is absolutely positioned with inset: 0, so size containment
       cannot change its box. */
    content-visibility: hidden;
  }

  .splits-drop-preview {
    position: absolute;
    top: var(--splits-drop-preview-top);
    left: var(--splits-drop-preview-left);
    z-index: 20;
    width: var(--splits-drop-preview-width);
    height: var(--splits-drop-preview-height);
    border: 2px solid var(--splits-accent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--splits-accent) 20%, transparent);
    opacity: 0;
    pointer-events: none;
    transition:
      top var(--splits-animation-duration) ease,
      left var(--splits-animation-duration) ease,
      width var(--splits-animation-duration) ease,
      height var(--splits-animation-duration) ease,
      opacity 100ms ease;
  }

  .splits-drop-active .splits-drop-preview {
    opacity: 1;
  }
</style>
