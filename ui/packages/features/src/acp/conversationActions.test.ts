import { describe, expect, it } from "vitest";
import {
  containingWorktree,
  getConversationActions,
  registerConversationActions,
  type ConversationActions,
} from "./conversationActions.svelte";
import type { ACPNavProject } from "./navTypes";

function actions(): ConversationActions {
  return {
    canArchive: () => true,
    archiveConversation: () => true,
    worktreeFor: () => null,
    deleteWorktree: () => {},
  };
}

describe("conversation actions registry", () => {
  it("exposes the registered actions until they are unregistered", () => {
    const registered = actions();
    const unregister = registerConversationActions(registered);
    expect(getConversationActions()).toBe(registered);

    unregister();
    expect(getConversationActions()).toBeNull();
  });

  it("keeps a newer registration when a stale one unregisters", () => {
    const first = actions();
    const second = actions();
    const unregisterFirst = registerConversationActions(first);
    const unregisterSecond = registerConversationActions(second);

    unregisterFirst();
    expect(getConversationActions()).toBe(second);

    unregisterSecond();
    expect(getConversationActions()).toBeNull();
  });
});

describe("containingWorktree", () => {
  const project = (path: string, isWorktree = true): ACPNavProject => ({
    path,
    name: path.split("/").at(-1) ?? path,
    isWorktree,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
  });

  it("matches a worktree's own directory and its subdirectories", () => {
    const worktree = project("/repos/wt");
    expect(containingWorktree([worktree], "/repos/wt")).toBe(worktree);
    expect(containingWorktree([worktree], "/repos/wt/packages/ui")).toBe(worktree);
  });

  it("does not match a sibling that only shares a name prefix", () => {
    expect(containingWorktree([project("/repos/wt")], "/repos/wt-other")).toBeNull();
  });

  it("ignores root projects and prefers the deepest worktree", () => {
    const outer = project("/repos/wt");
    const inner = project("/repos/wt/nested");
    expect(containingWorktree([project("/repos", false), outer, inner], "/repos/wt/nested/x")).toBe(
      inner,
    );
    expect(containingWorktree([project("/repos", false)], "/repos/app")).toBeNull();
  });
});
