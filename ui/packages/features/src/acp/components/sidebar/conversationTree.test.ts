import { describe, expect, it } from "vitest";
import {
  buildConversationTree,
  hasAttentionDescendant,
  sliceVisibleSessions,
  subAgentSummaryLabel,
  summarizeDescendants,
  type ConversationTreeNode,
} from "./conversationTree";

const node = (id: string, parentId?: string, rootId?: string): ConversationTreeNode => ({
  id,
  parentId,
  rootId,
});
const ids = (items: readonly ConversationTreeNode[]) => items.map((item) => item.id);

describe("buildConversationTree", () => {
  it("keeps unrelated conversations top-level in input order", () => {
    const tree = buildConversationTree([node("a"), node("b")]);
    expect(ids(tree.topLevel)).toEqual(["a", "b"]);
    expect(tree.descendantsOf("a")).toEqual([]);
  });

  it("nests a child under its parent and removes it from top-level", () => {
    const tree = buildConversationTree([node("p"), node("c", "p", "p")]);
    expect(ids(tree.topLevel)).toEqual(["p"]);
    expect(ids(tree.descendantsOf("p"))).toEqual(["c"]);
    expect(tree.isNested("c")).toBe(true);
    expect(tree.topAncestorOf("c")?.id).toBe("p");
  });

  it("nests regardless of input order (child before parent)", () => {
    const tree = buildConversationTree([node("c", "p", "p"), node("p")]);
    expect(ids(tree.topLevel)).toEqual(["p"]);
    expect(ids(tree.descendantsOf("p"))).toEqual(["c"]);
  });

  it("flattens grandchildren under the top-most ancestor in input order", () => {
    const tree = buildConversationTree([
      node("gc", "c", "r"),
      node("r"),
      node("c2", "r", "r"),
      node("c", "r", "r"),
    ]);
    expect(ids(tree.topLevel)).toEqual(["r"]);
    expect(ids(tree.descendantsOf("r"))).toEqual(["gc", "c2", "c"]);
    expect(tree.descendantsOf("c")).toEqual([]);
  });

  it("treats a missing parent as an orphan", () => {
    const tree = buildConversationTree([node("c", "gone", "gone")]);
    expect(ids(tree.topLevel)).toEqual(["c"]);
    expect(tree.isNested("c")).toBe(false);
  });

  it("treats an archived parent (absent from the visible set) as an orphan", () => {
    const tree = buildConversationTree([node("c", "archived", "archived"), node("other")]);
    expect(ids(tree.topLevel)).toEqual(["c", "other"]);
  });

  it("falls back to a visible root when an intermediate parent is not visible", () => {
    const tree = buildConversationTree([node("r"), node("gc", "hidden", "r")]);
    expect(ids(tree.descendantsOf("r"))).toEqual(["gc"]);
  });

  it("prefers walking parentId over trusting rootId", () => {
    const tree = buildConversationTree([node("r"), node("p", "r", "r"), node("c", "p", "r")]);
    expect(tree.topAncestorOf("c")?.id).toBe("r");
    const lying = buildConversationTree([node("x"), node("p"), node("c", "p", "x")]);
    expect(ids(lying.descendantsOf("p"))).toEqual(["c"]);
    expect(lying.descendantsOf("x")).toEqual([]);
  });

  it("treats rootId equal to its own id with no parent as top-level", () => {
    const tree = buildConversationTree([node("a", undefined, "a"), node("b", "", "b")]);
    expect(ids(tree.topLevel)).toEqual(["a", "b"]);
    expect(tree.isNested("a")).toBe(false);
  });

  it("treats an empty parentId as top-level even when rootId points elsewhere", () => {
    const tree = buildConversationTree([node("r"), node("a", "", "r")]);
    expect(ids(tree.topLevel)).toEqual(["r", "a"]);
  });

  it("does not loop on a self parent", () => {
    const tree = buildConversationTree([node("a", "a", "a")]);
    expect(ids(tree.topLevel)).toEqual(["a"]);
  });

  it("keeps every member of a cycle visible", () => {
    const tree = buildConversationTree([node("a", "b"), node("b", "a"), node("c", "a")]);
    expect(ids(tree.topLevel)).toEqual(["a", "b", "c"]);
  });

  it("supports nesting across worktrees since it only looks at ids", () => {
    const tree = buildConversationTree([
      { id: "p", cwd: "/repo" },
      { id: "c", cwd: "/repo-wt", parentId: "p", rootId: "p" },
    ]);
    expect(tree.descendantsOf("p")[0]?.cwd).toBe("/repo-wt");
  });

  it("flat mode disables nesting", () => {
    const tree = buildConversationTree([node("p"), node("c", "p", "p")], { flat: true });
    expect(ids(tree.topLevel)).toEqual(["p", "c"]);
  });
});

describe("summarizeDescendants", () => {
  const status = (working: boolean, waitingForUser = false, unread = false) => ({
    working,
    waitingForUser,
    unread,
  });

  it("rolls up running, waiting and unread children", () => {
    const summary = summarizeDescendants(
      [status(true), status(true), status(false, true), status(false, false, true)],
      (s) => s,
    );
    expect(summary).toEqual({ count: 4, working: 2, waitingForUser: true, unread: true });
  });

  it("labels collapsed parents with running count only", () => {
    const summary = { count: 3, working: 1, waitingForUser: false, unread: false };
    expect(subAgentSummaryLabel(summary, false)).toBe("3 sub-agents · 1 running");
    expect(subAgentSummaryLabel(summary, true)).toBe("3 sub-agents");
    expect(subAgentSummaryLabel({ ...summary, count: 1, working: 0 }, false)).toBe("1 sub-agent");
  });
});

describe("buildConversationTree canNestUnder", () => {
  it("keeps a child top-level when its parent cannot host nested rows", () => {
    const tree = buildConversationTree([node("p"), node("c", "p", "p")], {
      canNestUnder: (ancestor) => ancestor.id !== "p",
    });
    expect(ids(tree.topLevel)).toEqual(["p", "c"]);
    expect(tree.isNested("c")).toBe(false);
    expect(tree.descendantsOf("p")).toEqual([]);
  });

  it("nests under the highest ancestor that can host rows", () => {
    const items = [node("a"), node("b", "a", "a"), node("c", "b", "a")];
    const tree = buildConversationTree(items, { canNestUnder: (ancestor) => ancestor.id !== "a" });
    expect(ids(tree.topLevel)).toEqual(["a", "b"]);
    expect(ids(tree.descendantsOf("b"))).toEqual(["c"]);
    expect(tree.topAncestorOf("c")?.id).toBe("b");
  });
});

describe("sliceVisibleSessions", () => {
  it("keeps flagged sessions past the limit in original order", () => {
    const sessions = ["a", "b", "c", "d", "e"];
    expect(sliceVisibleSessions(sessions, 2, (id) => id === "d")).toEqual(["a", "b", "d"]);
  });
});

describe("hasAttentionDescendant", () => {
  it("is true for working, waiting, unread or selected descendants", () => {
    const state = (flags: object) => () => flags;
    expect(hasAttentionDescendant([1], state({}))).toBe(false);
    expect(hasAttentionDescendant([1], state({ working: true }))).toBe(true);
    expect(hasAttentionDescendant([1], state({ waitingForUser: true }))).toBe(true);
    expect(hasAttentionDescendant([1], state({ unread: true }))).toBe(true);
    expect(hasAttentionDescendant([1], state({ selected: true }))).toBe(true);
  });
});
