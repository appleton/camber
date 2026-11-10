import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileNavigation, MobileRoute } from "@camber/assistant";
import { createMobileRouter, hashForRoute, routeFromLocation } from "./router";

const LIST: MobileRoute = { view: "list", conversationId: null, filePath: null };
const SETTINGS: MobileRoute = { view: "settings", conversationId: null, filePath: null };
const chat = (conversationId: string): MobileRoute => ({
  view: "chat",
  conversationId,
  filePath: null,
});
const file = (conversationId: string, filePath: string): MobileRoute => ({
  view: "file",
  conversationId,
  filePath,
});

function nextPop(router: MobileNavigation): Promise<MobileRoute> {
  return new Promise((resolve) => {
    const unsubscribe = router.onPopRoute((route) => {
      unsubscribe();
      resolve(route);
    });
  });
}

async function popped(router: MobileNavigation, go: () => void): Promise<MobileRoute> {
  const pop = nextPop(router);
  go();
  return await vi.waitFor(async () => await pop);
}

beforeEach(() => {
  // jsdom keeps the history stack between tests; bury the leftovers under a
  // fresh root entry.
  history.pushState(null, "", "#/");
});

describe("routeFromLocation", () => {
  it("parses the four routes", () => {
    history.replaceState(null, "", "#/");
    expect(routeFromLocation()).toEqual(LIST);
    history.replaceState(null, "", "#/settings");
    expect(routeFromLocation()).toEqual(SETTINGS);
    history.replaceState(null, "", "#/c/abc%2Fdef");
    expect(routeFromLocation()).toEqual(chat("abc/def"));
    history.replaceState(null, "", "#/c/one/f/%2Fsrc%2Fmain.go");
    expect(routeFromLocation()).toEqual(file("one", "/src/main.go"));
  });

  it("treats garbage as the list", () => {
    history.replaceState(null, "", "#/c/");
    expect(routeFromLocation()).toEqual(LIST);
    history.replaceState(null, "", "#/c/%zz");
    expect(routeFromLocation()).toEqual(LIST);
    history.replaceState(null, "", "#nonsense");
    expect(routeFromLocation()).toEqual(LIST);
    history.replaceState(null, "", "#/c/one/f/");
    expect(routeFromLocation()).toEqual(LIST);
  });
});

describe("createMobileRouter", () => {
  it("normalizes an empty hash to the root without touching depth", () => {
    history.replaceState(null, "", "/");
    const router = createMobileRouter();
    expect(router.initialRoute).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("pushes on list -> chat so native back pops to the list", async () => {
    history.replaceState(null, "", "#/");
    const router = createMobileRouter();

    router.routeChanged(chat("one"));
    expect(window.location.hash).toBe("#/c/one");

    const route = await popped(router, () => history.back());
    expect(route).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("pushes on chat -> file so native back pops to the chat", async () => {
    history.replaceState(null, "", "#/");
    const router = createMobileRouter();

    router.routeChanged(chat("one"));
    router.routeChanged(file("one", "/src/main.go"));
    expect(window.location.hash).toBe("#/c/one/f/%2Fsrc%2Fmain.go");

    const route = await popped(router, () => history.back());
    expect(route).toEqual(chat("one"));
  });

  it("replaces on same-depth changes so back still reaches the list", async () => {
    history.replaceState(null, "", "#/");
    const router = createMobileRouter();

    router.routeChanged(chat("one"));
    router.routeChanged(chat("two"));
    expect(window.location.hash).toBe("#/c/two");

    const route = await popped(router, () => history.back());
    expect(route).toEqual(LIST);
  });

  it("seeds a list entry beneath a deep initial route", async () => {
    history.replaceState(null, "", "#/c/deep");
    const router = createMobileRouter();
    expect(router.initialRoute).toEqual(chat("deep"));
    expect(window.location.hash).toBe("#/c/deep");

    const route = await popped(router, () => router.back());
    expect(route).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("seeds list and chat entries beneath a deep file route", async () => {
    history.replaceState(null, "", "#/c/deep/f/%2Fsrc%2Fmain.go");
    const router = createMobileRouter();
    expect(router.initialRoute).toEqual(file("deep", "/src/main.go"));
    expect(window.location.hash).toBe("#/c/deep/f/%2Fsrc%2Fmain.go");

    const backToChat = await popped(router, () => router.back());
    expect(backToChat).toEqual(chat("deep"));

    const backToList = await popped(router, () => router.back());
    expect(backToList).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("consumes the pushed entry on a programmatic pop", async () => {
    history.replaceState(null, "", "#/");
    const router = createMobileRouter();

    router.routeChanged(SETTINGS);
    expect(window.location.hash).toBe("#/settings");

    // Shell went shallower without back(): the router pops the real entry.
    const route = await popped(router, () => router.routeChanged(LIST));
    expect(route).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("consumes both pushed entries when popping straight from file to list", async () => {
    history.replaceState(null, "", "#/");
    const router = createMobileRouter();

    router.routeChanged(chat("one"));
    router.routeChanged(file("one", "/src/main.go"));

    const route = await popped(router, () => router.routeChanged(LIST));
    expect(route).toEqual(LIST);
    expect(window.location.hash).toBe("#/");
  });

  it("round-trips conversation ids through the hash", () => {
    const route = chat("agent server/2024-06-05T10:00:00Z");
    history.replaceState(null, "", hashForRoute(route));
    expect(routeFromLocation()).toEqual(route);
  });

  it("round-trips file paths through the hash", () => {
    const route = file("agent server/1", "/Users/dev/My Project/src/file name.ts");
    history.replaceState(null, "", hashForRoute(route));
    expect(routeFromLocation()).toEqual(route);
  });
});
