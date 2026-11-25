import { describe, expect, it } from "vitest";
import {
  getConversationActions,
  registerConversationActions,
  type ConversationActions,
} from "./conversationActions.svelte";

function actions(): ConversationActions {
  return {
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
