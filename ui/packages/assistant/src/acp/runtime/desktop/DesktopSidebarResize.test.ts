import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebarResize } from "./DesktopSidebarResize.svelte";

describe("DesktopSidebarResize", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.className = "";
  });

  it("clamps and persists explicit sidebar widths", () => {
    const resize = new DesktopSidebarResize({ isDesktop: () => true });

    resize.setWidth(100);
    expect(resize.width).toBe(resize.DESKTOP_SIDEBAR_MIN_WIDTH);
    expect(window.localStorage.getItem("camber.desktop.sidebarWidth")).toBe("220");

    resize.setWidth(1_000);
    expect(resize.width).toBe(resize.DESKTOP_SIDEBAR_MAX_WIDTH);
    expect(window.localStorage.getItem("camber.desktop.sidebarWidth")).toBe("640");
  });

  it("loads a saved width and ignores invalid saved values", () => {
    window.localStorage.setItem("camber.desktop.sidebarWidth", "512");
    const resize = new DesktopSidebarResize({ isDesktop: () => true });

    resize.loadSavedWidth();

    expect(resize.width).toBe(512);

    window.localStorage.setItem("camber.desktop.sidebarWidth", "not-a-number");
    resize.loadSavedWidth();

    expect(resize.width).toBe(260);
  });

  it("tracks a desktop resize gesture", () => {
    const resize = new DesktopSidebarResize({ isDesktop: () => true });
    const startEvent = new MouseEvent("mousedown", { clientX: 100 });
    const preventDefault = vi.spyOn(startEvent, "preventDefault");

    resize.startResize(startEvent);
    resize.moveResize(new MouseEvent("mousemove", { clientX: 180 }));

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(resize.resizing).toBe(true);
    expect(resize.width).toBe(340);
    expect(document.body.classList.contains("desktop-sidebar-resizing")).toBe(true);

    resize.stopResize();

    expect(resize.resizing).toBe(false);
    expect(document.body.classList.contains("desktop-sidebar-resizing")).toBe(false);
  });

  it("does not start resize gestures outside the desktop host", () => {
    const resize = new DesktopSidebarResize({ isDesktop: () => false });
    const startEvent = new MouseEvent("mousedown", { clientX: 100 });
    const preventDefault = vi.spyOn(startEvent, "preventDefault");

    resize.startResize(startEvent);
    resize.moveResize(new MouseEvent("mousemove", { clientX: 180 }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(resize.resizing).toBe(false);
    expect(resize.width).toBe(260);
  });
});
