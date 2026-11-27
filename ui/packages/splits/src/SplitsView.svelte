<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { SplitsController } from "./controller.js";
  import { computeFlatLayout, layoutBoxStyle, stageMinimumStyle } from "./internal/layout.js";
  import { findPane } from "./internal/tree.js";
  import PaneContainer from "./PaneContainer.svelte";
  import SplitsDivider from "./SplitsDivider.svelte";
  import type { SplitsState, PaneID, SplitID, SplitNode, Tab } from "./types.js";

  interface Props {
    controller: SplitsController;
    class?: string;
    style?: string;
    tabBarWindowDrag?: boolean;
    tabBarLeading?: Snippet<[PaneID]>;
    tabIcon?: Snippet<[Tab]>;
    tabTrailing?: Snippet<[Tab]>;
    newTabButton?: Snippet<[PaneID]>;
    tabBarActions?: Snippet<[PaneID]>;
    tabShortcutLabel?: (tab: Tab) => string | undefined;
    showTabShortcutLabels?: boolean;
    onTabContextMenu?: (args: { paneId: PaneID; tabId: string; event: MouseEvent }) => void;
    usePaneShape?: boolean;
    paneShapeAnimating?: boolean;
    bottomLeftRadius?: number;
    bottomRightRadius?: number;
    children: Snippet<[Tab, PaneID]>;
    emptyPane?: Snippet<[PaneID]>;
  }

  let {
    controller,
    class: className,
    style,
    tabBarWindowDrag = false,
    tabBarLeading,
    tabIcon,
    tabTrailing,
    newTabButton,
    tabBarActions,
    tabShortcutLabel,
    showTabShortcutLabels = false,
    onTabContextMenu,
    usePaneShape = false,
    paneShapeAnimating = false,
    bottomLeftRadius,
    bottomRightRadius,
    children: content,
    emptyPane,
  }: Props = $props();

  let element: HTMLDivElement | undefined = $state();
  let currentState: SplitsState = $state(untrack(() => controller.getState()));
  // Only the dragged divider highlights, but every pane suspends exact shapes
  // while any divider moves.
  let draggingSplitId = $state<SplitID>();
  const isDividerDragging = $derived(draggingSplitId !== undefined);

  const visibleNode = $derived.by<SplitNode>(() => {
    if (currentState.zoomedPaneId) {
      const pane = findPane(currentState.rootNode, currentState.zoomedPaneId);

      if (pane) {
        return {
          type: "pane",
          pane,
        };
      }
    }

    return currentState.rootNode;
  });

  // Panes render flat and absolutely positioned, keyed by pane id, so a tree
  // restructure only moves boxes instead of remounting a pane's chrome.
  const layout = $derived.by(() => {
    currentState.version;
    return computeFlatLayout(visibleNode);
  });

  // Minimums constrain the stage, not the pane: see stageMinimumStyle.
  const stageStyle = $derived(
    stageMinimumStyle(
      layout,
      controller.configuration.appearance.minimumPaneWidth,
      controller.configuration.appearance.minimumPaneHeight,
    ),
  );

  const showSplitButtons = $derived(
    controller.configuration.allowSplits && controller.configuration.appearance.showSplitButtons,
  );
  const tabBarHeight = $derived(controller.configuration.appearance.tabBarHeight);
  const tabActionButtonSize = $derived(Math.round(Math.min(Math.max(tabBarHeight - 12, 22), 26)));
  const tabActionIconSize = $derived(Math.round(Math.min(Math.max(tabBarHeight - 22, 13), 16)));
  const tabIconSize = $derived(Math.round(Math.min(Math.max(tabBarHeight - 22, 14), 16)));
  const tabCloseSize = $derived(Math.round(Math.min(Math.max(tabBarHeight - 20, 16), 18)));
  const tabFontSize = $derived(Math.round(Math.min(Math.max(tabBarHeight - 24, 12), 13)));

  const rootStyle = $derived(
    [
      `--splits-tab-bar-height: ${tabBarHeight}px`,
      `--splits-tab-action-button-size: ${tabActionButtonSize}px`,
      `--splits-tab-action-icon-size: ${tabActionIconSize}px`,
      `--splits-tab-icon-size: ${tabIconSize}px`,
      `--splits-tab-close-size: ${tabCloseSize}px`,
      `--splits-tab-font-size: ${tabFontSize}px`,
      `--splits-tab-min-width: ${controller.configuration.appearance.tabMinWidth}px`,
      `--splits-tab-max-width: ${controller.configuration.appearance.tabMaxWidth}px`,
      `--splits-animation-duration: ${controller.configuration.appearance.animationDuration}s`,
      style,
    ]
      .filter(Boolean)
      .join("; "),
  );

  // A controller prop swap can also replace snippets that resolve tab content.
  // Adopt the new controller's state before rendering those snippets so they
  // can never observe tabs from the previous controller.
  $effect.pre(() => {
    const unsubscribe = controller.subscribe((nextState) => {
      currentState = nextState;
    });

    return unsubscribe;
  });

  $effect(() => {
    const target = element;
    if (!target) {
      return;
    }

    function updateFrame() {
      const rect = target!.getBoundingClientRect();
      controller.setContainerFrame({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }

    updateFrame();

    const observer = new ResizeObserver(updateFrame);
    observer.observe(target);
    target.addEventListener("keydown", keydown);
    window.addEventListener("resize", updateFrame);
    window.addEventListener("scroll", updateFrame, true);

    return () => {
      observer.disconnect();
      target.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", updateFrame);
      window.removeEventListener("scroll", updateFrame, true);
    };
  });

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        controller.navigateFocus("left");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        controller.navigateFocus("right");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        controller.navigateFocus("up");
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        controller.navigateFocus("down");
      }
    }

    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "PageUp") {
      event.preventDefault();
      controller.selectPreviousTab();
    } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "PageDown") {
      event.preventDefault();
      controller.selectNextTab();
    }
  }
</script>

<div bind:this={element} class={["splits-root", className]} style={rootStyle}>
  <div class="splits-stage" style={stageStyle}>
    {#each layout.panes as paneLayout (paneLayout.paneId)}
      {@const pane = findPane(currentState.rootNode, paneLayout.paneId)}
      {@const box = paneLayout.box}
      {@const reachesBottom = Math.abs(box.top.fraction + box.height.fraction - 1) < 1e-9}
      {@const reachesRight = Math.abs(box.left.fraction + box.width.fraction - 1) < 1e-9}
      {#if pane}
        <div class="splits-pane-slot" style={layoutBoxStyle(box)}>
          <PaneContainer
            {controller}
            {pane}
            version={currentState.version}
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
            {usePaneShape}
            bottomLeftRadius={reachesBottom && box.left.fraction === 0
              ? bottomLeftRadius
              : undefined}
            bottomRightRadius={reachesBottom && reachesRight ? bottomRightRadius : undefined}
            paneShapeAnimating={paneShapeAnimating || isDividerDragging}
            contentViewLifecycle={controller.configuration.contentViewLifecycle}
            {content}
            {emptyPane}
          />
        </div>
      {/if}
    {/each}

    {#each layout.dividers as dividerLayout (dividerLayout.splitId)}
      <SplitsDivider
        {controller}
        splitId={dividerLayout.splitId}
        orientation={dividerLayout.orientation}
        box={dividerLayout.box}
        containerBox={dividerLayout.containerBox}
        dragging={draggingSplitId === dividerLayout.splitId}
        onDraggingChange={(dragging) =>
          (draggingSplitId = dragging ? dividerLayout.splitId : undefined)}
      />
    {/each}
  </div>
</div>

<style>
  .splits-root {
    --splits-foreground: var(
      --psx-foreground-primary,
      light-dark(rgb(28, 28, 30), rgb(242, 242, 247))
    );
    --splits-muted-foreground: var(
      --psx-foreground-secondary,
      light-dark(rgb(92, 92, 97), rgb(174, 174, 178))
    );
    --splits-pane-background: var(
      --psx-editor-background,
      light-dark(rgb(255, 255, 255), rgb(28, 28, 30))
    );
    --splits-tab-foreground: var(--psx-tab-inactive-foreground, var(--splits-muted-foreground));
    --splits-active-tab-foreground: var(--psx-tab-active-foreground, var(--splits-foreground));
    --splits-tab-bar-background: var(
      --psx-tab-inactive-background,
      var(--psx-chrome, light-dark(rgb(246, 246, 247), rgb(45, 45, 48)))
    );
    --splits-tab-background: transparent;
    --splits-active-tab-background: var(--psx-tab-active-background, var(--splits-pane-background));
    --splits-tab-hover-background: var(
      --psx-tab-hover-background,
      var(--psx-menu-hover-background, light-dark(rgb(232, 232, 235), rgb(70, 70, 74)))
    );
    --splits-split-gap: 6px;
    --splits-split-gap-background: var(--splits-tab-bar-background);
    --splits-pane-border: 0;
    --splits-pane-radius: 0;
    --splits-pane-shadow: none;
    --splits-separator: var(
      --psx-tab-border,
      var(--psx-border, light-dark(rgb(207, 207, 211), rgb(83, 83, 88)))
    );
    --splits-accent: var(--psx-focus, var(--psx-vibrant, Highlight));
    --splits-focus-ring: color-mix(in srgb, var(--splits-accent) 55%, transparent);

    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--splits-foreground);
    background: var(--splits-pane-background);
    color-scheme: light dark;
    outline: none;
  }

  .splits-stage {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: visible;
    background: var(--splits-split-gap-background);
  }

  .splits-pane-slot {
    position: absolute;
    /* No minimum here on purpose: growing one absolutely positioned box cannot
       push a sibling, so a per-pane minimum would make panes overlap. The
       stage carries the constraint instead (stageMinimumStyle). */
    min-width: 0;
    min-height: 0;
    overflow: visible;
  }

  .splits-root:focus-visible {
    outline: 2px solid var(--splits-focus-ring);
    outline-offset: -2px;
  }
</style>
