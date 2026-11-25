import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { getConversationActions } from "../conversationActions.svelte";
import type { ACPSession } from "../features/Session.svelte";
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

function conversation(id: string, cwd: string, workspacePath = cwd): ACPConversationSummary {
  return {
    id,
    cwd,
    workspacePath,
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
          // Sessions started on mobile store the IDE scope as their workspace,
          // which worktree removal would not clean up.
          conversation("ide", "/wt", "IDE"),
        ],
        activeConversationId: null,
        onLeaveConversation: () => {},
      },
    });
    expect(registered().worktreeFor("root")).toBeNull();
    expect(registered().worktreeFor("top")).toEqual({ path: "/wt", name: "Feature" });
    expect(registered().worktreeFor("sub")).toBeNull();
    expect(registered().worktreeFor("ide")).toBeNull();
  });

  it("archives the open conversation and leaves it", async () => {
    const archiveSession = vi.fn(async () => ["a"]);
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

  it("stops a turn running on another surface before deleting its worktree", async () => {
    const order: string[] = [];
    const cancel = vi.fn(async () => {
      order.push("cancel");
    });
    const working = {
      ...conversation("w", "/wt"),
      liveStatus: { working: true, waitingForUser: false, unread: false },
    } as ACPConversationSummary;
    render(Harness, {
      props: {
        projects,
        sessions: [working],
        activeConversationId: "w",
        // Started elsewhere: nothing is prompting from this phone.
        activeSession: {
          sessionId: "session-w",
          isPrompting: false,
          isSending: false,
          cancel,
        } as unknown as ACPSession,
        removeWorktree: async () => {
          order.push("remove");
        },
        onLeaveConversation: () => {},
      },
    });
    registered().deleteWorktree("/wt");
    await fireEvent.click(await screen.findByRole("button", { name: "Delete Worktree" }));
    await waitFor(() => expect(order).toEqual(["cancel", "remove"]));
  });

  it("leaves a sub-agent the helper archived with its parent while the archive ran", async () => {
    let finishArchive = (_archived: string[]) => {};
    const archiveSession = () =>
      new Promise<string[]>((resolve) => {
        finishArchive = resolve;
      });
    const onLeaveConversation = vi.fn();
    const props = {
      projects,
      // The sub-agent "c" appeared after the archive started, so only the
      // helper's result knows it was taken too.
      sessions: [conversation("p", "/repo")],
      activeConversationId: "p" as string | null,
      archiveSession,
      onLeaveConversation,
    };
    const { rerender } = render(Harness, { props });
    expect(registered().archiveConversation("p")).toBe(true);
    await rerender({ ...props, activeConversationId: "c" });
    finishArchive(["p", "c"]);
    await waitFor(() => expect(onLeaveConversation).toHaveBeenCalled());
  });

  it("stays in an unrelated conversation opened while an archive ran", async () => {
    let finishArchive = (_archived: string[]) => {};
    const archiveSession = () =>
      new Promise<string[]>((resolve) => {
        finishArchive = resolve;
      });
    const onLeaveConversation = vi.fn();
    const props = {
      projects,
      sessions: [conversation("p", "/repo"), conversation("other", "/repo")],
      activeConversationId: "p" as string | null,
      archiveSession,
      onLeaveConversation,
    };
    const { rerender } = render(Harness, { props });
    registered().archiveConversation("p");
    await rerender({ ...props, activeConversationId: "other" });
    finishArchive(["p"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onLeaveConversation).not.toHaveBeenCalled();
  });

  it("keeps offering a retry when deletion fails and the list can't be refreshed", async () => {
    const onLeaveConversation = vi.fn();
    render(Harness, {
      props: {
        projects,
        sessions: [conversation("w", "/wt")],
        activeConversationId: "w",
        removeWorktree: async () => {
          throw new Error("connection lost");
        },
        onLeaveConversation,
        refreshFails: true,
      },
    });
    registered().deleteWorktree("/wt");
    await fireEvent.click(await screen.findByRole("button", { name: "Delete Worktree" }));
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument();
    expect(onLeaveConversation).not.toHaveBeenCalled();
  });

  it("leaves the chat that asked even if the list emptied while the dialog was open", async () => {
    const onLeaveConversation = vi.fn();
    const { component } = render(Harness, {
      props: {
        projects,
        sessions: [conversation("w", "/wt")],
        activeConversationId: "w",
        onLeaveConversation,
      },
    });
    registered().deleteWorktree("/wt");
    const confirm = await screen.findByRole("button", { name: "Delete Worktree" });
    component.failConversationList();
    await fireEvent.click(confirm);
    await waitFor(() => expect(onLeaveConversation).toHaveBeenCalled());
  });
});
