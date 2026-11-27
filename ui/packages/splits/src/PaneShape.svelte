<script lang="ts">
  import { tick } from "svelte";
  import { enqueuePaneShapeReveal } from "./internal/paneShapeRevealQueue.js";

  interface PaneShapeFrame {
    width: number;
    height: number;
    contentY: number;
    tabLeft: number;
    tabRight: number;
    hasVisibleTab: boolean;
    edgeRadii: PaneShapeRadii;
    fillRadii: PaneShapeRadii;
  }

  interface PaneShapeRadii {
    tab: number;
    shoulder: number;
    pane: number;
  }

  interface Props {
    paneId: string;
    tabId?: string;
    version: number;
    paneElement?: HTMLElement;
    paneContentElement?: HTMLElement;
    animating: boolean;
    bottomLeftRadius?: number;
    bottomRightRadius?: number;
  }

  let {
    paneId,
    tabId,
    version,
    paneElement,
    paneContentElement,
    animating,
    bottomLeftRadius,
    bottomRightRadius,
  }: Props = $props();

  // Quiet period after self-observed geometry churn before settling back to
  // the full-quality filter and a rounded re-measure.
  const LOCAL_MOTION_SETTLE_MS = 160;

  let shapeFrame = $state<PaneShapeFrame>();
  let shapeVisible = $state(false);
  // Geometry churn this component observes itself (window resizes, tab-strip
  // scrolls, pane resizes). Host-driven motion (panel toggles, divider drags)
  // arrives via the `animating` prop instead.
  let localMotion = $state(false);
  let localMotionTimer: number | undefined;

  const inMotion = $derived(animating || localMotion);

  const clipPathId = $derived(`splits-pane-shape-clip-${safeId(paneId)}`);
  const outerClipPathId = $derived(`splits-pane-shape-outer-clip-${safeId(paneId)}`);
  const edgePath = $derived(
    shapeFrame ? paneShapePathForFrame(shapeFrame, shapeFrame.edgeRadii) : undefined,
  );
  const fillPath = $derived(
    shapeFrame ? paneShapePathForFrame(shapeFrame, shapeFrame.fillRadii) : undefined,
  );
  // An even-odd clip leaves only the area outside the silhouette. Keeping
  // the dark stroke outside and the highlight inside makes their widths
  // independent of the opaque content rendered within the pane.
  const outerClipPath = $derived(
    shapeFrame && edgePath
      ? `M ${-shapeFrame.width} ${-shapeFrame.height} H ${shapeFrame.width * 2} V ${shapeFrame.height * 2} H ${-shapeFrame.width} Z ${edgePath}`
      : undefined,
  );

  function markLocalMotion() {
    localMotion = true;
    if (localMotionTimer !== undefined) window.clearTimeout(localMotionTimer);
    localMotionTimer = window.setTimeout(() => {
      localMotionTimer = undefined;
      localMotion = false;
    }, LOCAL_MOTION_SETTLE_MS);
  }

  $effect(() => () => {
    if (localMotionTimer !== undefined) window.clearTimeout(localMotionTimer);
  });

  $effect(() => {
    version;

    const element = paneElement;
    const contentElement = paneContentElement;
    const selectedTabId = tabId;
    const motion = inMotion;

    if (!element || !selectedTabId) {
      // Nothing valid to draw — the box-shadow fallback must take over.
      shapeVisible = false;
      return;
    }

    let cancelled = false;
    let measureFrame: number | undefined;
    let trackFrame: number | undefined;
    let cancelReveal: (() => void) | undefined;
    let receivedInitialResize = false;
    const tabListElement = element.querySelector<HTMLElement>("[data-splits-tab-list]");

    function findSelectedTabElement(): HTMLElement | undefined {
      return Array.from(element!.querySelectorAll<HTMLElement>("[data-splits-tab-id]")).find(
        (candidate) => candidate.dataset.splitsTabId === selectedTabId,
      );
    }

    function cancelScheduledWork() {
      if (measureFrame !== undefined) {
        cancelAnimationFrame(measureFrame);
        measureFrame = undefined;
      }
      if (trackFrame !== undefined) {
        cancelAnimationFrame(trackFrame);
        trackFrame = undefined;
      }
      cancelReveal?.();
      cancelReveal = undefined;
    }

    function measureShape(rounded: boolean) {
      if (cancelled) return;
      // Round only at rest: animated geometry sits on subpixels, and snapping
      // the silhouette to integers there makes it shimmer against the pane.
      const px = rounded ? Math.round : (value: number) => value;

      const selectedTabElement = findSelectedTabElement();
      if (!selectedTabElement) {
        shapeFrame = undefined;
        return;
      }

      const paneRect = element!.getBoundingClientRect();
      const contentRect = contentElement?.getBoundingClientRect();
      const tabRect = selectedTabElement.getBoundingClientRect();
      const tabViewportRect = tabListElement?.getBoundingClientRect();
      const visibleTabLeft = tabViewportRect
        ? Math.max(tabRect.left, tabViewportRect.left)
        : tabRect.left;
      const visibleTabRight = tabViewportRect
        ? Math.min(tabRect.right, tabViewportRect.right)
        : tabRect.right;
      const hasVisibleTab = visibleTabRight > visibleTabLeft;
      const hiddenTabEdge = tabViewportRect
        ? tabRect.right <= tabViewportRect.left
          ? tabViewportRect.left
          : tabViewportRect.right
        : tabRect.left;
      const shapeTabLeft = hasVisibleTab ? visibleTabLeft : hiddenTabEdge;
      const shapeTabRight = hasVisibleTab ? visibleTabRight : hiddenTabEdge;
      const selectedTabStyle = getComputedStyle(selectedTabElement);
      const paneStyle = getComputedStyle(element!);
      const shapeTopOffset = pixelValue(paneStyle.getPropertyValue("--splits-pane-shape-top"), -1);
      const shapeHeightExtension = pixelValue(
        paneStyle.getPropertyValue("--splits-pane-shape-height-extension"),
        1,
      );
      const shapeTop = paneRect.top + shapeTopOffset;
      const tabRadius = pixelValue(selectedTabStyle.borderTopRightRadius, 6);
      const shoulderRadius = pixelValue(
        paneStyle.getPropertyValue("--splits-pane-shape-shoulder-radius"),
        tabRadius,
      );
      const paneRadius = pixelValue(paneStyle.borderTopRightRadius, 0);

      shapeFrame = {
        width: px(paneRect.width),
        height: px(paneRect.height + shapeHeightExtension),
        contentY: px((contentRect?.top ?? tabRect.bottom) - shapeTop),
        tabLeft: px(shapeTabLeft - paneRect.left),
        tabRight: px(shapeTabRight - paneRect.left),
        hasVisibleTab,
        edgeRadii: {
          tab: tabRadius,
          shoulder: shoulderRadius,
          pane: paneRadius,
        },
        fillRadii: {
          tab: pixelValue(
            paneStyle.getPropertyValue("--splits-pane-shape-fill-tab-radius"),
            tabRadius,
          ),
          shoulder: pixelValue(
            paneStyle.getPropertyValue("--splits-pane-shape-fill-shoulder-radius"),
            shoulderRadius,
          ),
          pane: pixelValue(
            paneStyle.getPropertyValue("--splits-pane-shape-fill-pane-radius"),
            paneRadius,
          ),
        },
      };
    }

    if (motion) {
      // Track motion frame-by-frame: re-measure and redraw so the silhouette
      // rides the animation, skipping the reveal queue. Measuring inside rAF
      // forces layout at the current animation timestamp, so the drawn shape
      // matches what this frame paints. CSS swaps the drop-shadow stack for
      // the cheaper motion filter while this class is present.
      const track = () => {
        trackFrame = undefined;
        if (cancelled) return;
        measureShape(false);
        if (shapeFrame) shapeVisible = true;
        trackFrame = requestAnimationFrame(track);
      };
      trackFrame = requestAnimationFrame(track);
    } else {
      void tick().then(() => {
        if (cancelled) return;
        // Keep any existing shape visible while re-measuring: this path runs
        // on every layout-version bump (tab retitles, selection changes) and
        // on the motion→rest handoff, where geometry is usually already drawn
        // and hiding would flash the box-shadow fallback. The reveal queue
        // swaps the re-measured frame in a single paint.
        if (!shapeFrame) shapeVisible = false;
        measureFrame = requestAnimationFrame(() => {
          measureFrame = undefined;
          measureShape(true);
          if (cancelled || !shapeFrame) return;
          // The geometry write settles first. The following frame mounts the
          // SVG and removes the box-shadow fallback in the same paint.
          cancelReveal = enqueuePaneShapeReveal(() => {
            cancelReveal = undefined;
            if (!cancelled) shapeVisible = true;
          });
        });
      });
    }

    const selectedTabElement = findSelectedTabElement();
    const handleGeometryChange = () => markLocalMotion();
    const handleObservedResize = () => {
      // ResizeObserver delivers an initial notification after observe(); only
      // later notifications are real geometry changes.
      if (!receivedInitialResize) {
        receivedInitialResize = true;
        return;
      }
      markLocalMotion();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(handleObservedResize);
    resizeObserver?.observe(element);
    if (tabListElement) {
      resizeObserver?.observe(tabListElement);
      tabListElement.addEventListener("scroll", handleGeometryChange, { passive: true });
    }
    if (selectedTabElement) resizeObserver?.observe(selectedTabElement);
    window.addEventListener("resize", handleGeometryChange);

    return () => {
      // Do not hide the shape here: this teardown also runs between effect
      // re-runs (every layout-version bump and motion flip), and hiding would
      // flash the box-shadow fallback behind the pane. The next run re-measures
      // and swaps the shape in place, or hides it itself when it cannot draw;
      // on real unmount the SVG leaves the DOM with the component anyway.
      cancelled = true;
      resizeObserver?.disconnect();
      tabListElement?.removeEventListener("scroll", handleGeometryChange);
      window.removeEventListener("resize", handleGeometryChange);
      cancelScheduledWork();
    };
  });

  function safeId(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, "_");
  }

  function pixelValue(value: string, fallback: number): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function pathNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function bottomRadii(frame: PaneShapeFrame, radii: PaneShapeRadii, base: number, limit: number) {
    // Apply the same inset to the adaptive fill as to the regular pane fill.
    const fillInset = frame.edgeRadii.pane - radii.pane;
    return {
      left:
        bottomLeftRadius === undefined
          ? base
          : Math.max(0, Math.min(bottomLeftRadius - fillInset, limit)),
      right:
        bottomRightRadius === undefined
          ? base
          : Math.max(0, Math.min(bottomRightRadius - fillInset, limit)),
    };
  }

  function paneShapePathForFrame(frame: PaneShapeFrame, radii: PaneShapeRadii): string {
    if (!frame.hasVisibleTab) return paneShapeBodyPathForFrame(frame, radii);

    const width = Math.max(0, frame.width);
    const height = Math.max(frame.contentY, frame.height);
    const tabLeft = Math.min(frame.tabLeft, frame.tabRight);
    const tabRight = Math.max(frame.tabLeft, frame.tabRight);
    const tabWidth = Math.max(0, tabRight - tabLeft);
    const tabRadius = Math.max(0, Math.min(radii.tab, tabWidth / 2, frame.contentY));
    const shoulderRadius = Math.max(0, Math.min(radii.shoulder, frame.contentY - tabRadius));
    const paneRadius = Math.max(
      0,
      Math.min(radii.pane, width / 2, Math.max(0, height - frame.contentY)),
    );
    const bottom = bottomRadii(
      frame,
      radii,
      paneRadius,
      Math.min(width, height - frame.contentY) / 2,
    );
    const rightShoulderRadius = Math.min(
      shoulderRadius,
      Math.max(0, width - paneRadius - tabRight),
    );
    const leftShoulderRadius = Math.min(shoulderRadius, tabLeft);
    const topLeftPaneRadius = Math.max(0, Math.min(paneRadius, tabLeft - leftShoulderRadius));
    const n = pathNumber;
    const shoulderRight =
      rightShoulderRadius > 0
        ? [
            `L ${n(tabRight)} ${n(frame.contentY - rightShoulderRadius)}`,
            `Q ${n(tabRight)} ${n(frame.contentY)} ${n(tabRight + rightShoulderRadius)} ${n(frame.contentY)}`,
          ]
        : [`L ${n(tabRight)} ${n(frame.contentY)}`];
    const shoulderLeft =
      leftShoulderRadius > 0
        ? [
            `L ${n(tabLeft - leftShoulderRadius)} ${n(frame.contentY)}`,
            `Q ${n(tabLeft)} ${n(frame.contentY)} ${n(tabLeft)} ${n(frame.contentY - leftShoulderRadius)}`,
          ]
        : [`L ${n(tabLeft)} ${n(frame.contentY)}`];

    return [
      `M ${n(tabLeft + tabRadius)} 0`,
      `L ${n(tabRight - tabRadius)} 0`,
      `Q ${n(tabRight)} 0 ${n(tabRight)} ${n(tabRadius)}`,
      ...shoulderRight,
      `L ${n(width - paneRadius)} ${n(frame.contentY)}`,
      `Q ${n(width)} ${n(frame.contentY)} ${n(width)} ${n(frame.contentY + paneRadius)}`,
      `L ${n(width)} ${n(height - bottom.right)}`,
      `Q ${n(width)} ${n(height)} ${n(width - bottom.right)} ${n(height)}`,
      `L ${n(bottom.left)} ${n(height)}`,
      `Q 0 ${n(height)} 0 ${n(height - bottom.left)}`,
      `L 0 ${n(frame.contentY + topLeftPaneRadius)}`,
      ...(topLeftPaneRadius > 0
        ? [`Q 0 ${n(frame.contentY)} ${n(topLeftPaneRadius)} ${n(frame.contentY)}`]
        : []),
      ...shoulderLeft,
      `L ${n(tabLeft)} ${n(tabRadius)}`,
      `Q ${n(tabLeft)} 0 ${n(tabLeft + tabRadius)} 0`,
      "Z",
    ].join(" ");
  }

  function paneShapeBodyPathForFrame(frame: PaneShapeFrame, radii: PaneShapeRadii): string {
    const width = Math.max(0, frame.width);
    const height = Math.max(frame.contentY, frame.height);
    const top = Math.max(0, Math.min(frame.contentY, height));
    const bodyHeight = Math.max(0, height - top);
    const paneRadius = Math.max(0, Math.min(radii.pane, width / 2, bodyHeight / 2));
    const bottom = bottomRadii(frame, radii, paneRadius, Math.min(width, bodyHeight) / 2);
    const n = pathNumber;

    return [
      `M ${n(paneRadius)} ${n(top)}`,
      `L ${n(width - paneRadius)} ${n(top)}`,
      `Q ${n(width)} ${n(top)} ${n(width)} ${n(top + paneRadius)}`,
      `L ${n(width)} ${n(height - bottom.right)}`,
      `Q ${n(width)} ${n(height)} ${n(width - bottom.right)} ${n(height)}`,
      `L ${n(bottom.left)} ${n(height)}`,
      `Q 0 ${n(height)} 0 ${n(height - bottom.left)}`,
      `L 0 ${n(top + paneRadius)}`,
      `Q 0 ${n(top)} ${n(paneRadius)} ${n(top)}`,
      "Z",
    ].join(" ");
  }
</script>

{#if shapeVisible && edgePath && fillPath && shapeFrame}
  <svg
    class="splits-pane-shape splits-pane-shape-shadow-layer"
    class:splits-pane-shape-in-motion={inMotion}
    data-pane-shape-ready
    viewBox={`0 0 ${shapeFrame.width} ${shapeFrame.height}`}
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path class="splits-pane-shape-shadow" d={edgePath}></path>
  </svg>
  <svg
    class="splits-pane-shape splits-pane-shape-edge-ring-layer"
    viewBox={`0 0 ${shapeFrame.width} ${shapeFrame.height}`}
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path class="splits-pane-shape-edge-ring" d={edgePath}></path>
  </svg>
  <svg
    class="splits-pane-shape splits-pane-shape-surface-layer"
    viewBox={`0 0 ${shapeFrame.width} ${shapeFrame.height}`}
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <!-- Keep this as direct vector geometry. A pane-sized SVG mask makes
         WKWebView software-rasterize the full alpha buffer during repaints. -->
    <path class="splits-pane-shape-surface" d={fillPath}></path>
  </svg>
  <svg
    class="splits-pane-shape splits-pane-shape-rim-layer"
    viewBox={`0 0 ${shapeFrame.width} ${shapeFrame.height}`}
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <defs>
      <clipPath id={clipPathId}>
        <path d={edgePath}></path>
      </clipPath>
      <clipPath id={outerClipPathId}>
        <path d={outerClipPath} clip-rule="evenodd"></path>
      </clipPath>
    </defs>
    <path class="splits-pane-shape-inner-shadow" clip-path={`url(#${clipPathId})`} d={edgePath}
    ></path>
    <path class="splits-pane-shape-stroke" clip-path={`url(#${outerClipPathId})`} d={edgePath}
    ></path>
    <!-- Optional darker outline over the hairline, for consumers whose surface
         needs more edge definition than a light stroke gives. -->
    <path class="splits-pane-shape-edge-stroke" clip-path={`url(#${outerClipPathId})`} d={edgePath}
    ></path>
  </svg>
{/if}

<style>
  .splits-pane-shape {
    position: absolute;
    top: var(--splits-pane-shape-top, -1px);
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 0;
    width: 100%;
    height: calc(100% + var(--splits-pane-shape-height-extension, 1px));
    /* A dedicated compositor layer can make WKWebView omit newly mounted
       sibling pane content until another input forces a repaint. */
    overflow: visible;
    pointer-events: none;
  }

  .splits-pane-shape-shadow-layer {
    filter: var(--splits-pane-shape-filter, none);
  }

  .splits-pane-shape-rim-layer {
    /* Opaque tab/terminal/editor backgrounds must not cover the inner rim. */
    z-index: 2;
  }

  /* Same silhouette, cheaper blur profile while geometry is in motion: fewer
     drop-shadow passes keep the per-frame filter re-rasterization inside the
     frame budget. Consumers without a motion filter keep the settled one. */
  .splits-pane-shape-shadow-layer.splits-pane-shape-in-motion {
    filter: var(--splits-pane-shape-motion-filter, var(--splits-pane-shape-filter, none));
  }

  .splits-pane-shape-shadow {
    fill: var(--splits-pane-shape-shadow-fill, var(--splits-pane-background));
  }

  /* The tight edge shadow is a blurred uniform-width stroke, not a
     drop-shadow() pass: blurring the area silhouette integrates extra
     darkness into the concave shoulder fillet (a visible dark tick in the
     crook), while a stroke keeps constant weight around the whole outline.
     The stroke's inner half is covered by the surface layer painted above,
     so only the outer half shows — matching a drop-shadow edge ring. */
  .splits-pane-shape-edge-ring-layer {
    filter: blur(var(--splits-pane-shape-edge-ring-blur, 1px));
  }

  .splits-pane-shape-edge-ring {
    fill: none;
    stroke: var(--splits-pane-shape-edge-ring-color, transparent);
    stroke-width: var(--splits-pane-shape-edge-ring-width, 0);
    vector-effect: non-scaling-stroke;
  }

  .splits-pane-shape-surface {
    fill: var(--splits-pane-shape-surface-fill, var(--splits-pane-background));
    fill-opacity: var(--splits-pane-shape-surface-alpha, 1);
  }

  .splits-pane-shape-inner-shadow {
    fill: none;
    filter: var(--splits-pane-shape-inner-shadow-filter, none);
    stroke: var(--splits-pane-shape-inner-shadow-color, transparent);
    stroke-width: var(--splits-pane-shape-inner-shadow-width, 0);
    shape-rendering: geometricPrecision;
    vector-effect: non-scaling-stroke;
  }

  .splits-pane-shape-stroke {
    fill: none;
    stroke: var(--splits-pane-shape-border-color, transparent);
    stroke-width: var(--splits-pane-shape-border-width, 0);
    shape-rendering: geometricPrecision;
    vector-effect: non-scaling-stroke;
  }

  .splits-pane-shape-edge-stroke {
    fill: none;
    stroke: var(--splits-pane-shape-edge-stroke-color, transparent);
    stroke-width: var(
      --splits-pane-shape-edge-stroke-width,
      var(--splits-pane-shape-border-width, 0)
    );
    shape-rendering: geometricPrecision;
    vector-effect: non-scaling-stroke;
  }
</style>
