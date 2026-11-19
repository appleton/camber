import { describe, expect, it } from "vitest";
import {
  collectSubAgentDescendants,
  isRenderedSubAgent,
  sharesSidebarGroup,
  type SubAgentCandidate,
} from "./conversationDescendants";
import { ACP_CHAT_WORKSPACE_PATH } from "./workspaceScope";

function conv(
  id: string,
  parentId: string | undefined,
  cwd: string,
  extra: Partial<SubAgentCandidate> = {},
): SubAgentCandidate {
  return { id, parentId, cwd, workspacePath: "/ws", ...extra };
}

function chat(id: string, parentId: string | undefined, cwd: string): SubAgentCandidate {
  return conv(id, parentId, cwd, { workspacePath: ACP_CHAT_WORKSPACE_PATH });
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const index = (items: readonly SubAgentCandidate[]) =>
  new Map(items.map((item) => [item.id, item]));

describe("sharesSidebarGroup", () => {
  it("groups non-chat conversations by working directory", () => {
    expect(sharesSidebarGroup(conv("a", undefined, "/ws"), conv("b", undefined, "/ws"))).toBe(true);
    expect(sharesSidebarGroup(conv("a", undefined, "/ws"), conv("b", undefined, "/wt"))).toBe(
      false,
    );
  });

  it("groups all chats together regardless of cwd, and never with projects", () => {
    expect(sharesSidebarGroup(chat("a", undefined, "/c1"), chat("b", undefined, "/c2"))).toBe(true);
    expect(sharesSidebarGroup(chat("a", undefined, "/ws"), conv("b", undefined, "/ws"))).toBe(
      false,
    );
    expect(sharesSidebarGroup(conv("a", undefined, "/ws"), chat("b", undefined, "/ws"))).toBe(
      false,
    );
  });
});

describe("collectSubAgentDescendants", () => {
  const items = [
    conv("p", undefined, "/ws"),
    conv("c", "p", "/ws"),
    conv("w", "p", "/wt"), // spawned into another worktree
    conv("wg", "w", "/ws"), // back in p's project below it
    conv("wc", "w", "/wt"),
    chat("chat-p", undefined, "/c1"),
    chat("chat-c", "chat-p", "/c2"),
    conv("chat-w", "chat-p", "/ws"),
  ];

  it("keeps same-group descendants and walks through other-group ones", () => {
    expect(ids(collectSubAgentDescendants(items, "p"))).toEqual(["c", "wg"]);
    expect(ids(collectSubAgentDescendants(items, "w"))).toEqual(["wc"]);
    expect(ids(collectSubAgentDescendants(items, "chat-p"))).toEqual(["chat-c"]);
  });

  it("returns nothing for unknown ids and is cycle-safe", () => {
    expect(collectSubAgentDescendants(items, "nope")).toEqual([]);
    const cyclic = [conv("a", "c", "/ws"), conv("b", "a", "/ws"), conv("c", "b", "/ws")];
    expect(ids(collectSubAgentDescendants(cyclic, "a"))).toEqual(["b", "c"]);
  });
});

describe("isRenderedSubAgent", () => {
  it("is true only with a present ancestor in the same group", () => {
    const items = [
      conv("p", undefined, "/ws"),
      conv("c", "p", "/ws"),
      conv("w", "p", "/wt"),
      conv("wg", "w", "/ws"),
      conv("orphan", "gone", "/ws"),
      conv("self", "self", "/ws"),
    ];
    const byId = index(items);
    const rendered = (id: string) => isRenderedSubAgent(byId.get(id)!, byId);
    expect(rendered("p")).toBe(false);
    expect(rendered("c")).toBe(true);
    expect(rendered("w")).toBe(false);
    expect(rendered("wg")).toBe(true);
    expect(rendered("orphan")).toBe(false);
    expect(rendered("self")).toBe(false);
  });

  it("falls back to rootId when the parent is absent", () => {
    const items = [conv("r", undefined, "/ws"), conv("g", "gone", "/ws", { rootId: "r" })];
    const byId = index(items);
    expect(isRenderedSubAgent(byId.get("g")!, byId)).toBe(true);
  });

  it("treats parent cycles as top-level", () => {
    const items = [conv("a", "b", "/ws"), conv("b", "a", "/ws")];
    const byId = index(items);
    expect(isRenderedSubAgent(byId.get("a")!, byId)).toBe(false);
  });
});
