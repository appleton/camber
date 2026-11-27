import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitsController } from "./controller.js";
import PaneShapeMotionHarness from "./PaneShapeMotionHarness.test.svelte";

// Runtime coverage for the pane-shape motion loop: while geometry animates the
// SVG silhouette must stay mounted, re-measure every frame (unrounded), and
// carry the cheaper motion filter class; at rest it settles through the reveal
// queue with rounded geometry. jsdom has no layout, so element rects are
// stubbed and rAF is pumped manually.

class MockResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function domRect(rect: Rect): DOMRect {
  return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect;
}

describe("pane shape motion", () => {
  let frameQueue: FrameRequestCallback[];
  let nextFrameId: number;
  let target: HTMLElement;

  // The pane's animatable geometry; rect stubs read it live so tests can
  // change it between pumped frames like a CSS transition would.
  const geometry = { paneWidth: 640, paneHeight: 400 };

  beforeAll(() => {
    // jsdom doesn't implement scrollTo (TabBar scrolls the selected tab into
    // view) or the Web Animations API (the tab list uses animate:flip).
    HTMLElement.prototype.scrollTo = vi.fn();
    Element.prototype.getAnimations = vi.fn().mockReturnValue([]);
    Element.prototype.animate = vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      finished: Promise.resolve(),
      onfinish: null,
      pause: vi.fn(),
      play: vi.fn(),
      reverse: vi.fn(),
    }));
  });

  beforeEach(() => {
    // Re-stubbed per test: afterEach's unstubAllGlobals clears it.
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    document.body.innerHTML = "";
    target = document.createElement("div");
    document.body.appendChild(target);
    geometry.paneWidth = 640;
    geometry.paneHeight = 400;
    frameQueue = [];
    nextFrameId = 1;
    // Restrict fake timers to timeouts: the default set would also fake
    // requestAnimationFrame and clobber the manual pump below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return nextFrameId++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      // Ids are not tracked per callback; cancellation drops nothing here
      // because each test pumps exactly the frames it expects.
      void id;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function pumpFrame() {
    const callbacks = frameQueue.splice(0);
    for (const callback of callbacks) callback(performance.now());
    flushSync();
  }

  function stubRects() {
    const pane = target.querySelector<HTMLElement>(".splits-pane")!;
    const content = target.querySelector<HTMLElement>("[data-splits-pane-content]")!;
    const tab = target.querySelector<HTMLElement>("[data-splits-tab-id]")!;
    const tabList = target.querySelector<HTMLElement>("[data-splits-tab-list]")!;

    pane.getBoundingClientRect = () =>
      domRect({
        top: 0,
        left: 0,
        right: geometry.paneWidth,
        bottom: geometry.paneHeight,
        width: geometry.paneWidth,
        height: geometry.paneHeight,
      });
    content.getBoundingClientRect = () =>
      domRect({
        top: 28,
        left: 0,
        right: geometry.paneWidth,
        bottom: geometry.paneHeight,
        width: geometry.paneWidth,
        height: geometry.paneHeight - 28,
      });
    tab.getBoundingClientRect = () =>
      domRect({ top: 0, left: 10, right: 110, bottom: 28, width: 100, height: 28 });
    tabList.getBoundingClientRect = () =>
      domRect({
        top: 0,
        left: 0,
        right: geometry.paneWidth,
        bottom: 28,
        width: geometry.paneWidth,
        height: 28,
      });
  }

  async function mountSettledHarness() {
    const controller = new SplitsController();
    const component = mount(PaneShapeMotionHarness, { target, props: { controller } });
    flushSync();
    stubRects();
    await tick();
    pumpFrame(); // measure
    pumpFrame(); // reveal queue
    return component;
  }

  function shadowLayer(): SVGElement | null {
    return target.querySelector<SVGElement>("[data-pane-shape-ready]");
  }

  it("reveals the settled shape through the reveal queue without the motion class", async () => {
    const component = await mountSettledHarness();

    const svg = shadowLayer();
    expect(svg, "shadow layer SVG").not.toBeNull();
    expect(svg!.classList.contains("splits-pane-shape-in-motion")).toBe(false);
    expect(svg!.getAttribute("viewBox")).toBe("0 0 640 401");

    void unmount(component);
  });

  it("updates and restores one bottom corner without waiting for a window resize", async () => {
    const component = await mountSettledHarness();
    const path = shadowLayer()!.querySelector("path")!;
    const initial = path.getAttribute("d")!;

    component.setBottomRightRadius(30);
    flushSync();
    expect(path.getAttribute("d")).toBe(
      initial.replace("L 640 401 Q 640 401 640 401", "L 640 371 Q 640 401 610 401"),
    );

    component.setBottomRightRadius(undefined);
    flushSync();
    expect(path.getAttribute("d")).toBe(initial);

    void unmount(component);
  });

  it("keeps the SVG mounted and re-measures every frame while animating", async () => {
    const component = await mountSettledHarness();
    const settledSvg = shadowLayer()!;

    component.setAnimating(true);
    flushSync();
    expect(shadowLayer(), "SVG survives the motion flip").toBe(settledSvg);
    expect(settledSvg.classList.contains("splits-pane-shape-in-motion")).toBe(true);

    geometry.paneWidth = 500.5;
    pumpFrame();
    // Unrounded: subpixel geometry must reach the silhouette as-is.
    expect(settledSvg.getAttribute("viewBox")).toBe("0 0 500.5 401");
    const firstFramePath = settledSvg.querySelector("path")!.getAttribute("d");

    geometry.paneWidth = 520.25;
    pumpFrame();
    expect(settledSvg.getAttribute("viewBox")).toBe("0 0 520.25 401");
    expect(settledSvg.querySelector("path")!.getAttribute("d")).not.toBe(firstFramePath);
    expect(shadowLayer()).toBe(settledSvg);

    void unmount(component);
  });

  it("settles back to rounded geometry and the full filter after motion ends", async () => {
    const component = await mountSettledHarness();
    const svg = shadowLayer()!;

    component.setAnimating(true);
    flushSync();
    geometry.paneWidth = 520.25;
    pumpFrame();

    component.setAnimating(false);
    flushSync();
    await tick();
    pumpFrame(); // rounded re-measure
    pumpFrame(); // reveal queue
    expect(shadowLayer(), "SVG survives the settle handoff").toBe(svg);
    expect(svg.classList.contains("splits-pane-shape-in-motion")).toBe(false);
    expect(svg.getAttribute("viewBox")).toBe("0 0 520 401");

    void unmount(component);
  });

  it("enters and leaves motion on self-observed geometry churn (window resize)", async () => {
    const component = await mountSettledHarness();
    const svg = shadowLayer()!;

    window.dispatchEvent(new Event("resize"));
    flushSync();
    expect(svg.classList.contains("splits-pane-shape-in-motion")).toBe(true);

    geometry.paneWidth = 610.75;
    pumpFrame();
    expect(svg.getAttribute("viewBox")).toBe("0 0 610.75 401");

    vi.advanceTimersByTime(160);
    flushSync();
    await tick();
    pumpFrame(); // rounded re-measure
    pumpFrame(); // reveal queue
    expect(svg.classList.contains("splits-pane-shape-in-motion")).toBe(false);
    expect(svg.getAttribute("viewBox")).toBe("0 0 611 401");

    void unmount(component);
  });
});
