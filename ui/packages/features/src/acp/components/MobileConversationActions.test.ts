import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { getConversationActions } from "../conversationActions.svelte";
import type { ACPConversationSummary, ACPNavProject } from "../navTypes";
import Harness from "./MobileConversationActions.test.svelte";

function project(path: string, extra: Partial<ACPNavProject> = {}): ACPNavProject {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
    ...extra,
  };
}

function conversation(id: string, cwd: string): ACPConversationSummary {
  return {
    id,
    cwd,
    workspacePath: cwd,
    agentServer: "poolside",
    sessionId: `session-${id}`,
    title: `Title ${id}`,
    updatedAt: "2026-11-25T00:00:00Z",
  } as ACPConversationSummary;
}

const registered = () => {
  const actions = getConversationActions();
  if (!actions) throw new Error("mobile actions were not registered");
  return actions;
};

const projects = [
  project("/repo"),
  project("/wt", { isWorktree: true, parentPath: "/repo", nickname: "Feature" }),
];

describe("MobileConversationActions", () => {
  it("offers deleting only the worktree a conversation runs in directly", () => {
    render(Harness, {
      props: {
        projects,
        sessions: [
          conversation("root", "/repo"),
          conversation("top", "/wt"),
          conversation("sub", "/wt/pkg"),
        ],
        activeConversationId: null,
        onLeaveConversation: () => {},
      },
    });
    expect(registered().worktreeFor("root")).toBeNull();
    expect(registered().worktreeFor("top")).toEqual({ path: "/wt", name: "Feature" });
    expect(registered().worktreeFor("sub")).toBeNull();
  });

  it("archives the open conversation and leaves it", async () => {
    const archiveSession = vi.fn(async () => {});
    const onLeaveConversation = vi.fn();
    render(Harness, {
      props: {
        projects,
        sessions: [conversation("a", "/repo")],
        activeConversationId: "a",
        archiveSession,
        onLeaveConversation,
      },
    });
    expect(registered().canArchive("a")).toBe(true);
    expect(registered().canArchive("missing")).toBe(false);
    expect(registered().archiveConversation("a")).toBe(true);
    await waitFor(() => expect(onLeaveConversation).toHaveBeenCalled());
    expect(archiveSession).toHaveBeenCalledWith("/repo", "session-a", "poolside", "a");
  });

  it("keeps the confirmation open with the error when deletion fails", async () => {
    const onLeaveConversation = vi.fn();
    render(Harness, {
      props: {
        projects,
        sessions: [conversation("w", "/wt")],
        activeConversationId: "w",
        removeWorktree: async () => {
          throw new Error("teardown failed");
        },
        onLeaveConversation,
      },
    });
    registered().deleteWorktree("/wt");
    await fireEvent.click(await screen.findByRole("button", { name: "Delete Worktree" }));
    expect(await screen.findByText(/teardown failed/)).toBeInTheDocument();
    expect(onLeaveConversation).not.toHaveBeenCalled();
  });

  it("does not leave a conversation opened while the worktree was being deleted", async () => {
    let finishRemoval = () => {};
    const removeWorktree = () =>
      new Promise<void>((resolve) => {
        finishRemoval = resolve;
      });
    const onLeaveConversation = vi.fn();
    const props = {
      projects,
      sessions: [conversation("w", "/wt"), conversation("other", "/repo")],
      activeConversationId: "w" as string | null,
      removeWorktree,
      onLeaveConversation,
    };
    const { rerender } = render(Harness, { props });
    registered().deleteWorktree("/wt");
    await fireEvent.click(await screen.findByRole("button", { name: "Delete Worktree" }));
    await rerender({ ...props, activeConversationId: "other" });
    finishRemoval();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Delete Worktree" })).toBeNull(),
    );
    expect(onLeaveConversation).not.toHaveBeenCalled();
  });
});
