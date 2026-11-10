import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installExternalLinkHandler } from "./externalLinks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe("desktop external links", () => {
  const openExternal = vi.fn();
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    document.body.replaceChildren();
    openExternal.mockClear();
    vi.mocked(invoke).mockClear();
  });

  function click(href: string, type = "click", button = 0) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    const child = document.createElement("span");
    anchor.append(child);
    document.body.append(anchor);
    const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
    child.dispatchEvent(event);
    return event;
  }

  it.each([
    "https://github.com/appleton/camber/docs",
    "http://example.com/",
    "mailto:hello@example.com",
  ])("opens an external link through the explicit host callback: %s", (href) => {
    cleanup = installExternalLinkHandler(openExternal);
    expect(click(href).defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(href);
  });

  it("supports middle-click without handling right-clicks", () => {
    cleanup = installExternalLinkHandler(openExternal);
    expect(click("https://github.com/appleton/camber/", "auxclick", 1).defaultPrevented).toBe(true);
    expect(click("https://github.com/appleton/camber/", "auxclick", 2).defaultPrevented).toBe(
      false,
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("uses the native open command by default in secondary document windows", () => {
    cleanup = installExternalLinkHandler();
    expect(click("https://github.com/appleton/camber/").defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_external_url", {
      url: "https://github.com/appleton/camber/",
    });
  });

  it.each(["/settings", "#heading", "file:///tmp/file.html", "javascript:alert(1)"])(
    "blocks app and unsupported navigation: %s",
    (href) => {
      cleanup = installExternalLinkHandler(openExternal);
      expect(click(href).defaultPrevented).toBe(true);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it("leaves previously handled clicks alone", () => {
    const prevent = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", prevent, { capture: true });
    cleanup = installExternalLinkHandler(openExternal);
    try {
      click("https://github.com/appleton/camber/");
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", prevent, { capture: true });
    }
  });
});
