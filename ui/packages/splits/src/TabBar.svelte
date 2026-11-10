<script lang="ts">
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import type { SplitsController } from "./controller.js";
  import {
    addTabPointerDragListener,
    cancelTabPointerDrag,
    canDropTabInPane,
    canDropTabOnTarget,
    controllerForPaneId,
    endTabPointerDrag,
    sourceControllerForTabTransfer,
    startTabPointerDrag,
    updateTabPointerDrag,
    type TabDropZone,
    type TabPointerDragEvent,
    type TabTransferData,
  } from "./internal/drag.js";
  import type { PaneID, PaneState, SplitOrientation, Tab, TabID } from "./types.js";
  import Icon from "@camber/components/icon";

  type TabRenderItem =
    | {
        type: "tab";
        key: string;
        tab: Tab;
        index: number;
      }
    | {
        type: "drop-space";
        key: string;
      };

  type DropZone = TabDropZone;

  interface PendingPointerDrag {
    pointerId: number;
    tab: Tab;
    tabId: TabID;
    startClientX: number;
    startClientY: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    tabWidth: number;
    tabHeight: number;
    previewBackground: string;
    previewForeground: string;
    previewBorderColor: string;
  }

  interface ActivePointerDrag {
    pointerId: number;
    transfer: TabTransferData;
  }

  interface DragPreview {
    tab: Tab;
    clientX: number;
    clientY: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    width: number;
    height: number;
    background: string;
    foreground: string;
    borderColor: string;
  }

  const pointerDragThreshold = 4;
  // Content-box width at or below which a tab collapses to icon-only styling.
  // Mirrors the old `@container (max-width: 64px)` query threshold.
  const narrowTabMaxWidth = 64;

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
  }: Props = $props();

  let dropTargetIndex = $state<number | undefined>();
  let activeTransfer = $state<TabTransferData | undefined>();
  let tabListElement = $state<HTMLElement>();
  let hasOverflowStart = $state(false);
  let hasOverflowEnd = $state(false);
  // Tab ids whose content box is at most NARROW_TAB_MAX_WIDTH px wide. Drives
  // the collapsed icon-only tab styling. This used to be a container query
  // (container-type: inline-size on every tab), but WebKit re-evaluates size
  // containers with a second layout pass on every frame of any ancestor
  // animation — measured as the single largest layout cost while opening or
  // closing panels with many tabs open. A ResizeObserver only costs when a
  // tab actually crosses the threshold.
  let narrowTabs = $state<Record<string, boolean>>({});
  let tabWidthObserver: ResizeObserver | undefined;
  let pendingPointerDrag: PendingPointerDrag | undefined;
  let activePointerDrag: ActivePointerDrag | undefined;
  let dragPreview = $state<DragPreview>();
  let suppressNextClick = false;
  let dragScrollVelocity = 0;
  let dragScrollFrame: number | undefined;
  let lastDragClientX: number | undefined;

  const tabs = $derived.by(() => {
    version;
    return pane.tabs;
  });

  const selectedTabId = $derived.by(() => {
    version;
    return pane.selectedTabId;
  });

  const isFocused = $derived.by(() => {
    version;
    return controller.focusedPaneId === pane.id;
  });

  const canCloseTabs = $derived(controller.configuration.allowCloseTabs);
  const canDragTabs = $derived(controller.configuration.allowTabReordering);
  const activeSourceIndex = $derived.by(() => {
    if (
      activeTransfer?.sourceController !== controller ||
      activeTransfer.sourcePaneId !== pane.id
    ) {
      return -1;
    }

    return tabs.findIndex((tab) => tab.id === activeTransfer?.tabId);
  });
  const dropGapIndex = $derived.by(() => {
    if (dropTargetIndex === undefined) {
      return undefined;
    }

    if (activeSourceIndex !== -1) {
      if (dropTargetIndex === activeSourceIndex || dropTargetIndex === activeSourceIndex + 1) {
        return undefined;
      }
    }

    return dropTargetIndex;
  });
  const shouldHideSourceTab = $derived(activeSourceIndex !== -1 && dropGapIndex !== undefined);
  const dropSpaceWidth = $derived.by(() => {
    const sourceWidth = activeTransfer?.tabWidth;
    if (sourceWidth && sourceWidth > 0) {
      return Math.round(
        Math.min(
          Math.max(sourceWidth, controller.configuration.appearance.tabMinWidth),
          controller.configuration.appearance.tabMaxWidth,
        ),
      );
    }

    return controller.configuration.appearance.tabMinWidth;
  });
  const dropSpaceStyle = $derived(`--splits-tab-drop-space-width: ${dropSpaceWidth}px;`);
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tabFlip = $derived({
    duration:
      controller.configuration.appearance.enableAnimations &&
      !prefersReducedMotion &&
      dropGapIndex !== undefined
        ? 120
        : 0,
    easing: cubicOut,
  });
  const tabRenderItems = $derived.by(() => {
    const items: TabRenderItem[] = [];

    for (const [index, tab] of tabs.entries()) {
      if (dropGapIndex === index) {
        items.push({
          type: "drop-space",
          key: "drop-space",
        });
      }

      if (shouldHideSourceTab && index === activeSourceIndex) {
        continue;
      }

      items.push({
        type: "tab",
        key: `tab:${tab.id}`,
        tab,
        index,
      });
    }

    if (dropGapIndex === tabs.length) {
      items.push({
        type: "drop-space",
        key: "drop-space",
      });
    }

    return items;
  });

  $effect(() => {
    const element = tabListElement;
    if (!element) {
      return;
    }

    updateOverflowState();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  });

  $effect(() => {
    // Re-run when the rendered tab set changes so new tab elements get
    // observed (tabRenderItems is the render source of truth).
    tabRenderItems;
    const element = tabListElement;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    tabWidthObserver?.disconnect();
    tabWidthObserver = new ResizeObserver((observerEntries) => {
      let changed = false;
      const next = { ...untrack(() => narrowTabs) };
      for (const observerEntry of observerEntries) {
        const target = observerEntry.target as HTMLElement;
        const tabId = target.dataset.splitsTabId;
        if (!tabId) continue;
        const width = observerEntry.contentBoxSize?.[0]?.inlineSize ?? target.clientWidth;
        const isNarrow = width <= narrowTabMaxWidth;
        if ((next[tabId] ?? false) !== isNarrow) {
          next[tabId] = isNarrow;
          changed = true;
        }
      }
      if (changed) {
        narrowTabs = next;
      }
    });

    const seenTabIds = new Set<string>();
    for (const tabElement of element.querySelectorAll<HTMLElement>("[data-splits-tab-id]")) {
      const tabId = tabElement.dataset.splitsTabId;
      if (tabId) seenTabIds.add(tabId);
      tabWidthObserver.observe(tabElement);
    }

    // Prune entries for tabs that closed or moved to another pane. Untracked:
    // this effect must re-run only when the tab set changes, not on every
    // narrow/wide flip (which would tear down and recreate the observer).
    // Skipped when no tab elements are queryable at all — that means this
    // effect ran before the DOM for the current render was attached, not
    // that every tab closed; wiping the map would flash tabs wide.
    untrack(() => {
      if (seenTabIds.size === 0) return;
      const staleIds = Object.keys(narrowTabs).filter((tabId) => !seenTabIds.has(tabId));
      if (staleIds.length > 0) {
        const next = { ...narrowTabs };
        for (const tabId of staleIds) delete next[tabId];
        narrowTabs = next;
      }
    });

    return () => {
      tabWidthObserver?.disconnect();
      tabWidthObserver = undefined;
    };
  });

  $effect(() => {
    return addTabPointerDragListener(handleTabPointerDrag);
  });

  $effect(() => {
    version;
    const tabId = selectedTabId;

    void tick().then(() => {
      if (tabId) {
        scrollTabIntoView(tabId);
      }
      updateOverflowState();
    });
  });

  onDestroy(() => {
    cleanupPointerDrag();
    setPointerDragCursor(false);
  });

  function select(tab: Tab) {
    controller.selectTab(tab.id);
  }

  function close(event: MouseEvent, tab: Tab) {
    event.stopPropagation();
    controller.closeTab(tab.id, pane.id);
  }

  function tabAuxClick(event: MouseEvent, tab: Tab) {
    if (event.button !== 1 || !canCloseTabs || tab.isClosable === false) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    controller.closeTab(tab.id, pane.id);
  }

  function createNewTab() {
    const tabId = controller.createTab("Untitled", { inPane: pane.id });
    if (tabId) {
      controller.focusPane(pane.id);
    }
  }

  function splitWithNewTab(orientation: SplitOrientation) {
    controller.splitPane({
      paneId: pane.id,
      orientation,
    });
  }

  function tabKeydown(event: KeyboardEvent, tab: Tab) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    select(tab);
  }

  function shortcutLabelForTab(tab: Tab): string | undefined {
    return showTabShortcutLabels ? tabShortcutLabel?.(tab) : undefined;
  }

  function tabPointerDown(event: PointerEvent, tab: Tab) {
    if (
      event.button !== 0 ||
      !canDragTabs ||
      (event.target instanceof Element && event.target.closest("button"))
    ) {
      return;
    }

    const tabElement = event.currentTarget as HTMLElement;
    const tabRect = tabElement.getBoundingClientRect();
    const previewTheme = dragPreviewTheme(tabElement);
    pendingPointerDrag = {
      pointerId: event.pointerId,
      tab,
      tabId: tab.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerOffsetX: event.clientX - tabRect.left,
      pointerOffsetY: event.clientY - tabRect.top,
      tabWidth: Math.round(tabRect.width),
      tabHeight: Math.round(tabRect.height),
      previewBackground: previewTheme.background,
      previewForeground: previewTheme.foreground,
      previewBorderColor: previewTheme.borderColor,
    };

    window.addEventListener("pointermove", pointerDragMove);
    window.addEventListener("pointerup", pointerDragEnd);
    window.addEventListener("pointercancel", pointerDragCancel);
  }

  function pointerDragMove(event: PointerEvent) {
    const pending = pendingPointerDrag;
    const active = activePointerDrag;
    if (!pending && !active) {
      return;
    }

    const pointerId = active?.pointerId ?? pending?.pointerId;
    if (event.pointerId !== pointerId) {
      return;
    }

    if (!active && pending) {
      const distance = Math.hypot(
        event.clientX - pending.startClientX,
        event.clientY - pending.startClientY,
      );
      if (distance < pointerDragThreshold) {
        return;
      }

      const transfer: TabTransferData = {
        tabId: pending.tabId,
        sourcePaneId: pane.id,
        sourceController: controller,
        tabWidth: pending.tabWidth,
      };
      activePointerDrag = {
        pointerId: pending.pointerId,
        transfer,
      };
      activeTransfer = transfer;
      dragPreview = {
        tab: pending.tab,
        clientX: event.clientX,
        clientY: event.clientY,
        pointerOffsetX: pending.pointerOffsetX,
        pointerOffsetY: pending.pointerOffsetY,
        width: pending.tabWidth,
        height: pending.tabHeight,
        background: pending.previewBackground,
        foreground: pending.previewForeground,
        borderColor: pending.previewBorderColor,
      };
      setPointerDragCursor(true);
      startTabPointerDrag(transfer, event.clientX, event.clientY);
    } else {
      updateDragPreview(event.clientX, event.clientY);
      updateTabPointerDrag(event.clientX, event.clientY);
    }

    event.preventDefault();
  }

  function pointerDragEnd(event: PointerEvent) {
    const active = activePointerDrag;
    const pending = pendingPointerDrag;

    if (active && event.pointerId === active.pointerId) {
      const transfer = active.transfer;
      const dropTarget = pointerDropTargetForPoint(transfer, event.clientX, event.clientY);
      endTabPointerDrag(event.clientX, event.clientY);
      if (dropTarget) {
        applyPointerDrop(transfer, dropTarget);
      }
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 0);
      event.preventDefault();
    } else if (pending && event.pointerId !== pending.pointerId) {
      return;
    }

    cleanupPointerDrag();
  }

  function pointerDragCancel(event: PointerEvent) {
    const pointerId = activePointerDrag?.pointerId ?? pendingPointerDrag?.pointerId;
    if (event.pointerId !== pointerId) {
      return;
    }

    cancelTabPointerDrag();
    cleanupPointerDrag();
  }

  function cleanupPointerDrag() {
    pendingPointerDrag = undefined;
    activePointerDrag = undefined;
    dragPreview = undefined;
    setPointerDragCursor(false);
    clearDropTarget();
    window.removeEventListener("pointermove", pointerDragMove);
    window.removeEventListener("pointerup", pointerDragEnd);
    window.removeEventListener("pointercancel", pointerDragCancel);
  }

  function updateDragPreview(clientX: number, clientY: number) {
    if (!dragPreview) return;
    dragPreview = {
      ...dragPreview,
      clientX,
      clientY,
    };
  }

  function portalToBody(node: HTMLElement) {
    document.body.appendChild(node);

    return {
      destroy() {
        node.remove();
      },
    };
  }

  function dragPreviewTheme(tabElement: HTMLElement): {
    background: string;
    foreground: string;
    borderColor: string;
  } {
    const tabStyle = getComputedStyle(tabElement);

    return {
      background:
        resolveColorValue(
          tabElement,
          tabStyle.getPropertyValue("--splits-active-tab-background"),
          "background",
        ) || tabStyle.backgroundColor,
      foreground:
        resolveColorValue(
          tabElement,
          tabStyle.getPropertyValue("--splits-active-tab-foreground"),
          "color",
        ) || tabStyle.color,
      borderColor:
        resolveColorValue(tabElement, tabStyle.getPropertyValue("--splits-separator"), "color") ||
        tabStyle.borderTopColor,
    };
  }

  function resolveColorValue(
    context: HTMLElement,
    value: string,
    property: "background" | "color",
  ): string {
    const trimmedValue = value.trim();
    if (!trimmedValue) return "";

    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.pointerEvents = "none";
    probe.style.visibility = "hidden";
    if (property === "background") {
      probe.style.backgroundColor = trimmedValue;
    } else {
      probe.style.color = trimmedValue;
    }

    context.appendChild(probe);
    const resolvedStyle = getComputedStyle(probe);
    const resolved =
      property === "background" ? resolvedStyle.backgroundColor : resolvedStyle.color;
    probe.remove();
    return resolved;
  }

  function dragPreviewStyle(preview: DragPreview): string {
    return [
      `width: ${preview.width}px`,
      `height: ${preview.height}px`,
      `transform: translate3d(${preview.clientX - preview.pointerOffsetX}px, ${
        preview.clientY - preview.pointerOffsetY
      }px, 0)`,
      `background: ${preview.background}`,
      `color: ${preview.foreground}`,
      `border-color: ${preview.borderColor}`,
    ].join("; ");
  }

  function setPointerDragCursor(isDragging: boolean) {
    document.body.classList.toggle("splits-tab-pointer-dragging", isDragging);
  }

  function handleTabPointerDrag(event: TabPointerDragEvent) {
    if (event.type === "end" || event.type === "cancel") {
      clearDropTarget();
      return;
    }

    const transfer = event.transfer;
    const element = tabListElement;
    if (
      !transfer ||
      !element ||
      event.clientX === undefined ||
      event.clientY === undefined ||
      !canAcceptTransfer(transfer)
    ) {
      dropTargetIndex = undefined;
      stopDragAutoScroll();
      return;
    }

    activeTransfer = transfer;
    if (!pointIsInsideElement(element, event.clientX, event.clientY)) {
      dropTargetIndex = undefined;
      stopDragAutoScroll();
      return;
    }

    lastDragClientX = event.clientX;
    dropTargetIndex = insertionIndexForClientXInTabList(element, event.clientX);
    updateDragAutoScrollForClientX(event.clientX);
    void tick().then(updateOverflowState);
  }

  function canAcceptTransfer(transfer: TabTransferData): boolean {
    return canDragTabs && canDropTabInPane(transfer, controller, pane.id);
  }

  function insertionIndexForClientX(clientX: number): number {
    const tabList = tabListElement;
    if (!tabList) {
      return tabs.length;
    }

    return insertionIndexForClientXInTabList(tabList, clientX);
  }

  function insertionIndexForClientXInTabList(tabList: HTMLElement, clientX: number): number {
    const tabElements = [...tabList.querySelectorAll<HTMLElement>("[data-splits-tab-index]")];
    if (tabElements.length === 0) {
      return 0;
    }

    for (const [index, tabElement] of tabElements.entries()) {
      const tabRect = tabElement.getBoundingClientRect();
      if (clientX < tabRect.left + tabRect.width / 2) {
        return tabIndexFromElement(tabElement) ?? index;
      }
    }

    const lastIndex = tabIndexFromElement(tabElements.at(-1)!);
    return lastIndex === undefined ? tabElements.length : lastIndex + 1;
  }

  function pointerDropTargetForPoint(
    transfer: TabTransferData,
    clientX: number,
    clientY: number,
  ):
    | { type: "tab-bar"; controller: SplitsController; paneId: PaneID; index: number }
    | { type: "pane"; controller: SplitsController; paneId: PaneID; zone: DropZone }
    | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    if (!(element instanceof Element)) {
      return undefined;
    }

    const tabList = element.closest<HTMLElement>("[data-splits-tab-list]");
    const tabListPaneId = tabList?.dataset.splitsPaneId;
    const tabListController = tabListPaneId ? controllerForPaneId(tabListPaneId) : undefined;
    if (
      tabList &&
      tabListPaneId &&
      tabListController &&
      canDropTabOnTarget(transfer, tabListController, tabListPaneId, "tab-bar")
    ) {
      return {
        type: "tab-bar",
        controller: tabListController,
        paneId: tabListPaneId,
        index: insertionIndexForClientXInTabList(tabList, clientX),
      };
    }

    const paneContent = element.closest<HTMLElement>("[data-splits-pane-content]");
    const paneContentPaneId = paneContent?.dataset.splitsPaneId;
    const paneContentController = paneContentPaneId
      ? controllerForPaneId(paneContentPaneId)
      : undefined;
    if (paneContent && paneContentPaneId && paneContentController) {
      const zone = zoneForPaneContentPoint(paneContent, clientX, clientY);
      if (!canDropTabOnTarget(transfer, paneContentController, paneContentPaneId, zone)) {
        return undefined;
      }

      return {
        type: "pane",
        controller: paneContentController,
        paneId: paneContentPaneId,
        zone,
      };
    }

    return undefined;
  }

  function applyPointerDrop(
    transfer: TabTransferData,
    dropTarget:
      | { type: "tab-bar"; controller: SplitsController; paneId: PaneID; index: number }
      | { type: "pane"; controller: SplitsController; paneId: PaneID; zone: DropZone },
  ) {
    const sourceController = sourceControllerForTabTransfer(transfer, controller);
    if (!sourceController) {
      return;
    }

    if (dropTarget.type === "tab-bar") {
      dropTarget.controller.moveTabFromController(
        sourceController,
        transfer.tabId,
        transfer.sourcePaneId,
        dropTarget.paneId,
        dropTarget.index,
      );
      return;
    }

    if (dropTarget.zone === "center") {
      dropTarget.controller.moveTabFromController(
        sourceController,
        transfer.tabId,
        transfer.sourcePaneId,
        dropTarget.paneId,
      );
      return;
    }

    if (!dropTarget.controller.configuration.allowSplits) {
      return;
    }

    dropTarget.controller.moveTabFromControllerToSplit(
      sourceController,
      transfer.tabId,
      transfer.sourcePaneId,
      dropTarget.paneId,
      orientationForZone(dropTarget.zone),
      {
        insertFirst: dropTarget.zone === "left" || dropTarget.zone === "top",
      },
    );
  }

  function pointIsInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
    const rect = element.getBoundingClientRect();
    return (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    );
  }

  function zoneForPaneContentPoint(
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): DropZone {
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

  function tabIndexFromElement(element: HTMLElement): number | undefined {
    const index = Number(element.dataset.splitsTabIndex);
    return Number.isInteger(index) ? index : undefined;
  }

  function clearDropTarget() {
    dropTargetIndex = undefined;
    activeTransfer = undefined;
    stopDragAutoScroll();
  }

  function updateOverflowState() {
    const element = tabListElement;
    if (!element) {
      hasOverflowStart = false;
      hasOverflowEnd = false;
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    hasOverflowStart = element.scrollLeft > 1;
    hasOverflowEnd = maxScrollLeft > 1 && element.scrollLeft < maxScrollLeft - 1;
  }

  function scrollTabIntoView(tabId: string) {
    const element = tabListElement;
    if (!element) {
      return;
    }

    const tabElement = [...element.querySelectorAll<HTMLElement>("[data-splits-tab-id]")].find(
      (candidate) => candidate.dataset.splitsTabId === tabId,
    );
    if (!tabElement) {
      return;
    }

    const padding = 12;
    const visibleLeft = element.scrollLeft;
    const visibleRight = visibleLeft + element.clientWidth;
    const tabLeft = tabElement.offsetLeft;
    const tabRight = tabLeft + tabElement.offsetWidth;

    let nextScrollLeft: number | undefined;
    if (tabLeft < visibleLeft + padding) {
      nextScrollLeft = Math.max(0, tabLeft - padding);
    } else if (tabRight > visibleRight - padding) {
      nextScrollLeft = tabRight - element.clientWidth + padding;
    }

    if (nextScrollLeft === undefined) {
      return;
    }

    element.scrollTo({
      left: nextScrollLeft,
      behavior: controller.configuration.appearance.enableAnimations ? "smooth" : "auto",
    });
  }

  function updateDragAutoScrollForClientX(clientX: number) {
    const element = tabListElement;
    if (!element) {
      stopDragAutoScroll();
      return;
    }

    const rect = element.getBoundingClientRect();
    const edgeSize = 44;
    const maxVelocity = 14;
    let velocity = 0;

    if (clientX < rect.left + edgeSize) {
      const intensity = (rect.left + edgeSize - clientX) / edgeSize;
      velocity = -Math.max(2, maxVelocity * intensity);
    } else if (clientX > rect.right - edgeSize) {
      const intensity = (clientX - (rect.right - edgeSize)) / edgeSize;
      velocity = Math.max(2, maxVelocity * intensity);
    }

    setDragScrollVelocity(velocity);
  }

  function setDragScrollVelocity(velocity: number) {
    dragScrollVelocity = velocity;

    if (velocity === 0) {
      stopDragAutoScroll();
      return;
    }

    if (dragScrollFrame === undefined) {
      dragScrollFrame = requestAnimationFrame(dragAutoScrollStep);
    }
  }

  function dragAutoScrollStep() {
    const element = tabListElement;
    if (!element || dragScrollVelocity === 0) {
      dragScrollFrame = undefined;
      return;
    }

    element.scrollLeft += dragScrollVelocity;
    updateOverflowState();

    if (lastDragClientX !== undefined) {
      dropTargetIndex = insertionIndexForClientX(lastDragClientX);
    }

    dragScrollFrame = requestAnimationFrame(dragAutoScrollStep);
  }

  function stopDragAutoScroll() {
    dragScrollVelocity = 0;
    lastDragClientX = undefined;

    if (dragScrollFrame !== undefined) {
      cancelAnimationFrame(dragScrollFrame);
      dragScrollFrame = undefined;
    }
  }
</script>

<div
  class:splits-tab-bar-focused={isFocused}
  class="splits-tab-bar"
  style={`--splits-tab-spacing: ${controller.configuration.appearance.tabSpacing}px;`}
>
  {#if tabBarLeading}
    {@render tabBarLeading(pane.id)}
  {/if}

  <div
    class:splits-tabs-overflow-start={hasOverflowStart}
    class:splits-tabs-overflow-end={hasOverflowEnd}
    class="splits-tabs-frame"
  >
    <div
      bind:this={tabListElement}
      class="splits-tabs"
      data-splits-tab-list
      data-splits-pane-id={pane.id}
      role="tablist"
      tabindex="-1"
      onscroll={updateOverflowState}
    >
      {#each tabRenderItems as item (item.key)}
        <div
          role="tab"
          data-splits-tab-id={item.type === "tab" ? item.tab.id : undefined}
          data-splits-tab-index={item.type === "tab" ? item.index : undefined}
          tabindex={item.type === "tab" ? (selectedTabId === item.tab.id ? 0 : -1) : undefined}
          class:splits-tab={item.type === "tab"}
          class:splits-tab-selected={item.type === "tab" && selectedTabId === item.tab.id}
          class:splits-tab-narrow={item.type === "tab" && narrowTabs[item.tab.id]}
          class:splits-tab-dragging={item.type === "tab" &&
            activeTransfer?.sourcePaneId === pane.id &&
            activeTransfer.tabId === item.tab.id}
          class:splits-tab-drop-space={item.type === "drop-space"}
          style={item.type === "drop-space" ? dropSpaceStyle : undefined}
          draggable={false}
          aria-selected={item.type === "tab" ? selectedTabId === item.tab.id : undefined}
          aria-hidden={item.type === "drop-space" ? "true" : undefined}
          title={item.type === "tab" ? item.tab.title : undefined}
          animate:flip={tabFlip}
          onpointerdown={(event) => {
            if (item.type === "tab") {
              tabPointerDown(event, item.tab);
            }
          }}
          onauxclick={(event) => {
            if (item.type === "tab") {
              tabAuxClick(event, item.tab);
            }
          }}
          onclick={(event) => {
            if (suppressNextClick) {
              event.preventDefault();
              event.stopPropagation();
              suppressNextClick = false;
              return;
            }
            if (item.type === "tab") {
              select(item.tab);
            }
          }}
          onkeydown={(event) => {
            if (item.type === "tab") {
              tabKeydown(event, item.tab);
            }
          }}
          oncontextmenu={(event) => {
            if (item.type === "tab" && onTabContextMenu) {
              event.preventDefault();
              onTabContextMenu({ paneId: pane.id, tabId: item.tab.id, event });
            }
          }}
        >
          {#if item.type === "tab"}
            {@const shortcutLabel = shortcutLabelForTab(item.tab)}
            <span class="splits-tab-shoulder-edge splits-tab-shoulder-edge-left" aria-hidden="true"
            ></span>
            <span class="splits-tab-shoulder-edge splits-tab-shoulder-edge-right" aria-hidden="true"
            ></span>
            {#if tabIcon || item.tab.icon}
              <span class="splits-tab-icon-slot" aria-hidden="true">
                {#if tabIcon}
                  {@render tabIcon(item.tab)}
                {:else if item.tab.icon}
                  <span class="splits-tab-icon" data-icon={item.tab.icon}></span>
                {/if}
              </span>
            {/if}
            <span class="splits-tab-title">{item.tab.title}</span>
            <span class="splits-tab-spacer" aria-hidden="true"></span>
            {#if tabTrailing}
              <span class="splits-tab-trailing-slot">
                {@render tabTrailing(item.tab)}
              </span>
            {/if}
            {#if item.tab.isDirty}
              <span class="splits-dirty-indicator" aria-label="Modified"></span>
            {/if}
            {#if shortcutLabel}
              <span class="splits-tab-shortcut-hint" aria-hidden="true">
                {shortcutLabel}
              </span>
            {/if}
            {#if canCloseTabs && item.tab.isClosable !== false}
              <button
                type="button"
                aria-label={`Close ${item.tab.title}`}
                class="splits-close"
                onclick={(event) => close(event, item.tab)}
              >
                <Icon name="cross" size={12} />
              </button>
            {/if}
          {/if}
        </div>
      {/each}
      {#if newTabButton}
        {@render newTabButton(pane.id)}
      {:else}
        <button
          type="button"
          class="splits-icon-button splits-new-tab-button"
          aria-label="New tab"
          title="New Tab"
          onclick={createNewTab}
        >
          <Icon name="plus" aria-hidden="true" size={18} weight={0.85} />
        </button>
      {/if}
      {#if tabBarWindowDrag}
        <div
          class="splits-tabs-window-drag-region"
          role="presentation"
          aria-hidden="true"
          data-tauri-drag-region="deep"
        ></div>
      {/if}
    </div>
  </div>

  {#if tabBarActions || showSplitButtons}
    <div class="splits-tab-actions">
      {#if showSplitButtons}
        <button
          type="button"
          class="splits-icon-button"
          aria-label="Split right"
          title="Split Right"
          onclick={() => splitWithNewTab("horizontal")}
        >
          <span class="splits-split-horizontal-icon" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="splits-icon-button"
          aria-label="Split down"
          title="Split Down"
          onclick={() => splitWithNewTab("vertical")}
        >
          <span class="splits-split-vertical-icon" aria-hidden="true"></span>
        </button>
      {/if}

      {#if tabBarActions}
        {@render tabBarActions(pane.id)}
      {/if}
    </div>
  {/if}
</div>

{#if dragPreview}
  <div
    use:portalToBody
    class="splits-tab-drag-preview"
    style={dragPreviewStyle(dragPreview)}
    aria-hidden="true"
  >
    {#if tabIcon}
      {@render tabIcon(dragPreview.tab)}
    {:else if dragPreview.tab.icon}
      <span class="splits-tab-icon" data-icon={dragPreview.tab.icon} aria-hidden="true"></span>
    {/if}
    <span class="splits-tab-title">{dragPreview.tab.title}</span>
  </div>
{/if}

<style>
  .splits-tab-bar {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: stretch;
    height: var(--splits-tab-bar-height);
    min-height: var(--splits-tab-bar-height);
    overflow: visible;
    background: var(--splits-tab-bar-background);
  }

  .splits-tab-bar::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 0;
    display: var(--splits-tab-bar-separator-display, block);
    height: 1px;
    background: var(--splits-separator);
    pointer-events: none;
  }

  .splits-tab-bar:not(.splits-tab-bar-focused) .splits-tabs-frame,
  .splits-tab-bar:not(.splits-tab-bar-focused) .splits-tab-actions > .splits-icon-button {
    filter: saturate(0);
  }

  .splits-tabs-frame {
    position: relative;
    z-index: 1;
    display: flex;
    min-width: 0;
    flex: 1;
  }

  .splits-tabs {
    --splits-tabs-mask-start: black;
    --splits-tabs-mask-end: black;
    --splits-tabs-mask-fade-width: 16px;

    display: flex;
    box-sizing: border-box;
    /* Let an opt-in selected-tab shadow reach the pane's top and left gutters.
       The scroller still ends at the content seam, clipping its bottom shadow. */
    height: calc(100% + var(--splits-tab-shadow-gutter, 0px));
    min-width: 0;
    flex: 1;
    gap: var(--splits-tab-spacing);
    margin-top: calc(var(--splits-tab-shadow-gutter, 0px) * -1);
    margin-left: calc(var(--splits-tab-shadow-gutter, 0px) * -1);
    padding-top: var(--splits-tab-shadow-gutter, 0px);
    padding-right: var(--splits-tab-radius, 6px);
    padding-left: var(--splits-tab-shadow-gutter, 0px);
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-mask-image: linear-gradient(
      to right,
      var(--splits-tabs-mask-start) 0,
      black var(--splits-tabs-mask-fade-width),
      black calc(100% - var(--splits-tabs-mask-fade-width)),
      var(--splits-tabs-mask-end) 100%
    );
    mask-image: linear-gradient(
      to right,
      var(--splits-tabs-mask-start) 0,
      black var(--splits-tabs-mask-fade-width),
      black calc(100% - var(--splits-tabs-mask-fade-width)),
      var(--splits-tabs-mask-end) 100%
    );
    -webkit-mask-mode: alpha;
    mask-mode: alpha;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
    scrollbar-width: none;
  }

  .splits-tabs-overflow-start .splits-tabs {
    --splits-tabs-mask-start: transparent;
  }

  .splits-tabs-overflow-end .splits-tabs {
    --splits-tabs-mask-end: transparent;
  }

  .splits-tabs-window-drag-region {
    min-width: 0;
    flex: 1 1 0;
  }

  .splits-tabs::-webkit-scrollbar {
    display: none;
  }

  .splits-tab {
    position: relative;
    display: flex;
    flex: 0 1 var(--splits-tab-max-width);
    min-width: var(--splits-tab-min-width);
    max-width: var(--splits-tab-max-width);
    top: var(--splits-tab-top, -1px);
    height: calc(var(--splits-tab-bar-height) + var(--splits-tab-height-extension, 1px));
    align-items: center;
    gap: 6px;
    border: var(--psx-hairline, 1px) solid
      var(--splits-tab-border, var(--splits-tab-bar-background));
    border-bottom: 0;
    border-radius: var(--splits-tab-radius, 6px) var(--splits-tab-radius, 6px) 0 0;
    padding: var(--splits-tab-padding-top, 0) var(--splits-tab-padding-right, 10px)
      var(--splits-tab-padding-bottom, 0) var(--splits-tab-padding-left, 12px);
    background: var(--splits-tab-background);
    color: var(--splits-tab-foreground);
    font-family:
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    font-size: var(--splits-tab-font-size);
    line-height: 1;
    text-align: left;
    outline: none;
    box-sizing: border-box;
    cursor: default;
    user-select: none;
  }

  .splits-tab:not(.splits-tab-selected) {
    border-radius: var(--splits-tab-radius, 6px) var(--splits-tab-radius, 6px)
      var(--splits-inactive-tab-bottom-radius, 0) var(--splits-inactive-tab-bottom-radius, 0);
  }

  .splits-tab:hover {
    background: var(--splits-tab-hover-visual-background, var(--splits-tab-hover-background));
    color: var(--splits-active-tab-foreground);
  }

  .splits-tab[data-splits-tab-index="0"] {
    margin-left: var(--splits-first-tab-margin-left, -1px);
  }

  .splits-tab-dragging {
    cursor: default;
    opacity: 0.45;
  }

  .splits-tab:focus-visible {
    outline: 2px solid var(--splits-focus-ring);
    outline-offset: -2px;
  }

  .splits-tab-selected {
    z-index: 1;
    border-color: var(
      --splits-active-tab-visual-border,
      var(--splits-active-tab-border, var(--splits-separator))
    );
    background: var(--splits-active-tab-visual-background, var(--splits-active-tab-background));
    box-shadow: var(--splits-active-tab-shadow, none);
    color: var(--splits-active-tab-foreground);
  }

  .splits-tab-selected:hover {
    background: var(--splits-active-tab-visual-background, var(--splits-active-tab-background));
    color: var(--splits-active-tab-foreground);
  }

  .splits-tab-selected::before,
  .splits-tab-selected::after {
    content: "";
    position: absolute;
    bottom: 0;
    width: var(--splits-tab-radius, 6px);
    height: var(--splits-tab-radius, 6px);
    display: var(--splits-active-tab-corner-display, block);
    background: transparent;
    pointer-events: none;
  }

  .splits-tab-selected::before {
    left: calc(var(--splits-tab-radius, 6px) * -1);
    border-radius: 0 0 var(--splits-tab-radius, 6px) 0;
    box-shadow:
      calc(var(--splits-tab-radius, 6px) / 2) calc(var(--splits-tab-radius, 6px) / 2) 0
        calc(var(--splits-tab-radius, 6px) / 2) var(--splits-active-tab-background),
      calc(var(--splits-tab-radius, 6px) / 2) calc(var(--splits-tab-radius, 6px) / 2) 0
        calc(var(--splits-tab-radius, 6px) / 2 + 1px)
        var(--splits-active-tab-border, var(--splits-separator));
  }

  .splits-tab-selected[data-splits-tab-index="0"]::before {
    display: none;
  }

  .splits-tab-selected::after {
    right: calc(var(--splits-tab-radius, 6px) * -1);
    border-radius: 0 0 0 var(--splits-tab-radius, 6px);
    box-shadow:
      calc(var(--splits-tab-radius, 6px) / -2) calc(var(--splits-tab-radius, 6px) / 2) 0
        calc(var(--splits-tab-radius, 6px) / 2) var(--splits-active-tab-background),
      calc(var(--splits-tab-radius, 6px) / -2) calc(var(--splits-tab-radius, 6px) / 2) 0
        calc(var(--splits-tab-radius, 6px) / 2 + 1px)
        var(--splits-active-tab-border, var(--splits-separator));
  }

  .splits-tab-shoulder-edge {
    position: absolute;
    bottom: 0;
    width: var(--splits-tab-radius, 6px);
    height: var(--splits-tab-radius, 6px);
    display: none;
    background-repeat: no-repeat;
    pointer-events: none;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }

  .splits-tab-selected > .splits-tab-shoulder-edge {
    display: var(--splits-active-tab-corner-display, block);
  }

  .splits-tab-shoulder-edge-left {
    left: calc(var(--splits-tab-radius, 6px) * -1);
    background-image: radial-gradient(
      circle at 0 0,
      transparent
        calc(var(--splits-tab-radius, 6px) - var(--splits-active-tab-shoulder-edge-width, 0px)),
      var(--splits-active-tab-shoulder-edge-color, transparent)
        calc(
          var(--splits-tab-radius, 6px) - var(--splits-active-tab-shoulder-edge-width, 0px) * 0.5
        ),
      transparent var(--splits-tab-radius, 6px)
    );
    -webkit-mask-image: conic-gradient(
      from 0deg at 0 0,
      transparent 90deg,
      black 102deg,
      black 168deg,
      transparent 180deg
    );
    mask-image: conic-gradient(
      from 0deg at 0 0,
      transparent 90deg,
      black 102deg,
      black 168deg,
      transparent 180deg
    );
  }

  .splits-tab-selected[data-splits-tab-index="0"] > .splits-tab-shoulder-edge-left {
    display: none;
  }

  .splits-tab-shoulder-edge-right {
    right: calc(var(--splits-tab-radius, 6px) * -1);
    background-image: radial-gradient(
      circle at 100% 0,
      transparent
        calc(var(--splits-tab-radius, 6px) - var(--splits-active-tab-shoulder-edge-width, 0px)),
      var(--splits-active-tab-shoulder-edge-color, transparent)
        calc(
          var(--splits-tab-radius, 6px) - var(--splits-active-tab-shoulder-edge-width, 0px) * 0.5
        ),
      transparent var(--splits-tab-radius, 6px)
    );
    -webkit-mask-image: conic-gradient(
      from 0deg at 100% 0,
      transparent 180deg,
      black 192deg,
      black 258deg,
      transparent 270deg
    );
    mask-image: conic-gradient(
      from 0deg at 100% 0,
      transparent 180deg,
      black 192deg,
      black 258deg,
      transparent 270deg
    );
  }

  .splits-tab-icon-slot {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
  }

  .splits-tab-trailing-slot {
    display: contents;
  }

  .splits-tab-icon-slot {
    width: var(--splits-tab-icon-size);
    height: var(--splits-tab-icon-size);
  }

  .splits-tab-icon-slot:empty {
    display: none;
  }

  .splits-tab-icon {
    position: relative;
    width: var(--splits-tab-icon-size);
    height: var(--splits-tab-icon-size);
    flex: 0 0 auto;
    opacity: 0.8;
  }

  .splits-tab-icon::before {
    content: "";
    position: absolute;
    inset: 1px 2px;
    border: 1.5px solid currentColor;
    border-radius: 2px;
  }

  .splits-tab-icon[data-icon="star"]::before {
    inset: 2px;
    border-radius: 999px;
  }

  .splits-tab-title {
    min-width: 0;
    line-height: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .splits-tab-spacer {
    flex: 1 1 auto;
    min-width: 4px;
  }

  .splits-dirty-indicator {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.55;
  }

  .splits-tab-shortcut-hint {
    display: inline-flex;
    height: 14px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    padding: 0 1px;
    color: currentColor;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0;
    opacity: 0.76;
    pointer-events: none;
    animation: splits-shortcut-hint-in 90ms ease-out;
  }

  .splits-close {
    position: relative;
    display: none;
    width: var(--splits-tab-close-size);
    height: var(--splits-tab-close-size);
    flex: 0 0 auto;
    border: 0;
    border-radius: 999px;
    padding: 0;
    background: transparent;
    color: currentColor;
    cursor: default;
    opacity: 0.8;
    justify-content: center;
    align-items: center;
    transform: translateX(2px);
  }

  .splits-tab:hover .splits-close,
  .splits-close:hover,
  .splits-tab:focus-visible .splits-close {
    display: inline-flex;
  }

  .splits-tab:hover .splits-dirty-indicator:has(+ .splits-close) {
    display: none;
  }

  .splits-close:hover {
    background: var(--splits-tab-hover-background);
    opacity: 1;
  }

  /* Narrow (icon-only) tab styling. .splits-tab-narrow is set from a
     ResizeObserver rather than a container query: container-type:
     inline-size on every tab forced WebKit into a second per-tab layout pass
     on every frame of any ancestor animation (panel/sidebar slides, divider
     drags), which was the single largest remaining layout cost. */
  .splits-tab-narrow:has(.splits-tab-icon-slot) .splits-tab-title,
  .splits-tab-narrow:has(.splits-tab-icon-slot) .splits-tab-spacer,
  .splits-tab-narrow:has(.splits-tab-icon-slot) .splits-tab-trailing-slot,
  .splits-tab-narrow:has(.splits-tab-icon-slot) .splits-dirty-indicator,
  .splits-tab-narrow:has(.splits-tab-icon-slot) .splits-tab-shortcut-hint,
  .splits-tab-narrow:has(.splits-close):hover .splits-tab-title,
  .splits-tab-narrow:has(.splits-close):hover .splits-tab-spacer,
  .splits-tab-narrow:has(.splits-close):hover .splits-tab-trailing-slot,
  .splits-tab-narrow:has(.splits-close):hover .splits-dirty-indicator,
  .splits-tab-narrow:has(.splits-close):hover .splits-tab-shortcut-hint,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-tab-title,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-tab-spacer,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-tab-trailing-slot,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-dirty-indicator,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-tab-shortcut-hint {
    display: none;
  }

  .splits-tab-narrow .splits-tab-icon-slot,
  .splits-tab-narrow .splits-close {
    margin-right: auto;
    margin-left: auto;
  }

  .splits-tab-narrow .splits-close {
    transform: none;
  }

  .splits-tab-narrow:has(.splits-close):hover .splits-tab-icon-slot,
  .splits-tab-narrow:has(.splits-close):focus-visible .splits-tab-icon-slot {
    display: none;
  }

  .splits-tab-drop-space {
    position: relative;
    display: inline-flex;
    width: var(--splits-tab-drop-space-width);
    min-width: var(--splits-tab-drop-space-width);
    max-width: var(--splits-tab-drop-space-width);
    height: calc(var(--splits-tab-bar-height) - 1px);
    flex: 0 0 var(--splits-tab-drop-space-width);
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .splits-tab-actions {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: var(--splits-tab-actions-padding-top, 0) var(--splits-tab-actions-padding-right, 8px)
      var(--splits-tab-actions-padding-bottom, 0) var(--splits-tab-actions-padding-left, 6px);
  }

  .splits-icon-button {
    position: relative;
    display: inline-flex;
    width: var(--splits-tab-action-button-size);
    height: var(--splits-tab-action-button-size);
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--splits-muted-foreground);
    cursor: default;
  }

  .splits-icon-button:hover {
    background: var(--splits-tab-hover-background);
    color: var(--splits-foreground);
  }

  .splits-icon-button:focus-visible {
    outline: 2px solid var(--splits-focus-ring);
    outline-offset: 1px;
  }

  .splits-new-tab-button {
    flex: 0 0 var(--splits-tab-action-button-size);
    align-self: center;
    margin: 0 4px;
  }

  .splits-split-horizontal-icon,
  .splits-split-vertical-icon {
    border: 1.5px solid currentColor;
    border-radius: 2px;
  }

  .splits-split-horizontal-icon::before,
  .splits-split-vertical-icon::before {
    content: "";
    position: absolute;
    background: currentColor;
  }

  .splits-split-horizontal-icon::before {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1.5px;
    transform: translateX(-50%);
  }

  .splits-split-vertical-icon::before {
    top: 50%;
    right: 0;
    left: 0;
    height: 1.5px;
    transform: translateY(-50%);
  }

  .splits-tab-drag-preview {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--splits-separator);
    border-radius: 6px;
    padding: 0 10px 0 12px;
    background: var(--splits-active-tab-background);
    color: var(--splits-active-tab-foreground);
    box-shadow:
      0 8px 24px color-mix(in srgb, black 18%, transparent),
      0 2px 8px color-mix(in srgb, black 12%, transparent);
    box-sizing: border-box;
    cursor: default;
    opacity: 0.92;
    pointer-events: none;
    user-select: none;
  }

  :global(body.splits-tab-pointer-dragging),
  :global(body.splits-tab-pointer-dragging *) {
    cursor: default !important;
    user-select: none;
  }

  @keyframes splits-shortcut-hint-in {
    from {
      opacity: 0;
      transform: translateY(1px);
    }

    to {
      opacity: 0.76;
      transform: translateY(0);
    }
  }
</style>
