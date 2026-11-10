// History-backed hash routing for the mobile shell. Four routes:
//
//   #/                    conversation list (root of the stack)
//   #/c/<id>              an open conversation
//   #/c/<id>/f/<path>     a file viewed from that conversation
//   #/settings            settings
//
// Forward navigation pushes real history entries so the platform back button
// (Android system back, browser back/edge swipe) pops pages the way a native
// app would. The shell's in-app back buttons call back() and let the
// resulting popstate drive the view, so both back paths are one code path.
// A reload or PWA resume on a deep route restores it, with the entries
// beneath it seeded so each back lands one level up instead of leaving the
// app.

import type { MobileNavigation, MobileRoute, MobileView } from "@camber/assistant";

const ROOT_HASH = "#/";
const CONVERSATION_PREFIX = "#/c/";
const FILE_SEPARATOR = "/f/";
const SETTINGS_HASH = "#/settings";

const VIEW_DEPTH: Record<MobileView, number> = { list: 0, chat: 1, settings: 1, file: 2 };

export function routeFromLocation(): MobileRoute {
  const hash = window.location.hash;
  if (hash === SETTINGS_HASH) return { view: "settings", conversationId: null, filePath: null };
  if (hash.startsWith(CONVERSATION_PREFIX)) {
    try {
      const rest = hash.slice(CONVERSATION_PREFIX.length);
      const fileAt = rest.indexOf(FILE_SEPARATOR);
      if (fileAt !== -1) {
        const id = decodeURIComponent(rest.slice(0, fileAt));
        const filePath = decodeURIComponent(rest.slice(fileAt + FILE_SEPARATOR.length));
        if (id && filePath) return { view: "file", conversationId: id, filePath };
      } else {
        const id = decodeURIComponent(rest);
        if (id) return { view: "chat", conversationId: id, filePath: null };
      }
    } catch {
      // Malformed escape: treat as the list.
    }
  }
  return { view: "list", conversationId: null, filePath: null };
}

export function hashForRoute(route: MobileRoute): string {
  if (route.view === "settings") return SETTINGS_HASH;
  if (route.view === "file" && route.conversationId && route.filePath) {
    return `${CONVERSATION_PREFIX}${encodeURIComponent(route.conversationId)}${FILE_SEPARATOR}${encodeURIComponent(route.filePath)}`;
  }
  if ((route.view === "chat" || route.view === "file") && route.conversationId) {
    return `${CONVERSATION_PREFIX}${encodeURIComponent(route.conversationId)}`;
  }
  return ROOT_HASH;
}

// The history entries stacked beneath a deep-entry route, shallowest first.
function stackBeneath(route: MobileRoute): MobileRoute[] {
  if (route.view === "file" && route.conversationId) {
    return [{ view: "chat", conversationId: route.conversationId, filePath: null }];
  }
  return [];
}

export function createMobileRouter(): MobileNavigation {
  let current = routeFromLocation();

  if (VIEW_DEPTH[current.view] > 0) {
    // Deep entry: rebuild the stack [list, ..., page] in place.
    history.replaceState(null, "", ROOT_HASH);
    for (const beneath of stackBeneath(current)) {
      history.pushState(null, "", hashForRoute(beneath));
    }
    history.pushState(null, "", hashForRoute(current));
  } else if (window.location.hash !== ROOT_HASH) {
    // Normalize "" (first visit) and garbage hashes to the canonical root.
    history.replaceState(null, "", ROOT_HASH);
  }

  const popHandlers = new Set<(route: MobileRoute) => void>();
  window.addEventListener("popstate", () => {
    current = routeFromLocation();
    for (const handler of popHandlers) handler(current);
  });

  return {
    initialRoute: current,

    back() {
      history.back();
    },

    routeChanged(route: MobileRoute) {
      const next = hashForRoute(route);
      const previousDepth = VIEW_DEPTH[current.view];
      current = route;
      if (next === window.location.hash) return;
      const depth = VIEW_DEPTH[route.view];
      if (depth > previousDepth) {
        history.pushState(null, "", next);
      } else if (depth === previousDepth) {
        // Same level (e.g. switching conversations, or viewing another file):
        // back should still pop one level, so the current entry is replaced
        // rather than buried.
        history.replaceState(null, "", next);
      } else {
        // Programmatic pop that didn't go through back(): consume the real
        // history entries so the stack matches the depth again.
        history.go(depth - previousDepth);
      }
    },

    onPopRoute(handler: (route: MobileRoute) => void) {
      popHandlers.add(handler);
      return () => {
        popHandlers.delete(handler);
      };
    },
  };
}
