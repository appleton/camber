import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationActions } from "../conversationActions.svelte";
import { initializeStatefulModule } from "../hostRpc";
import type { ACPNavConversation, ACPNavProject } from "../navTypes";
import { ACP_CHAT_WORKSPACE_PATH } from "../workspaceScope";
import Harness from "./DesktopSideBar.test.svelte";

// Host RPCs (search index, etc.) are not under test; answer them with nothing.
initializeStatefulModule(async () => undefined);

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);
vi.stubGlobal(
  "matchMedia",
  (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }) as unknown as MediaQueryList,
);

const STORAGE_KEY = "camber.desktop.expandedSubAgents.v1";

function project(path: string, extra: Partial<ACPNavProject> = {}): ACPNavProject {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-07-29T00:00:00Z",
    updatedAt: "2026-07-29T00:00:00Z",
    ...extra,
  };
}

function worktree(path: string, parentPath: string, extra: Partial<ACPNavProject> = {}) {
  return project(path, { isWorktree: true, parentPath, ...extra });
}

// `age` orders rows: the list sorts newest first, so a larger age sits lower.
function conv(
  id: string,
  cwd: string,
  extra: Partial<ACPNavConversation> & { age?: number } = {},
): ACPNavConversation {
  const { age = 0, ...rest } = extra;
  return {
    id,
    workspacePath: cwd,
    agentServer: "poolside",
    sessionId: `session-${id}`,
    cwd,
    title: `Title ${id}`,
    updatedAt: new Date(Date.UTC(2026, 6, 29, 12, 0, 0) - age * 60_000).toISOString(),
    active: true,
    archived: false,
    workingDirectories: [cwd],
    ...rest,
  };
}

const child = (id: string, cwd: string, parentId: string, extra = {}) =>
  conv(id, cwd, { parentId, rootId: parentId, ...extra });

// Collapsed containers stay in the DOM but inert and aria-hidden, so look for
// the accessible row button rather than the text.
const present = (title: string) =>
  screen.queryByRole("button", { name: new RegExp(`^${title} - `) }) !== null;

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe("DesktopSideBar sub-agent nesting", () => {
  it("nests a child under its rendered parent", () => {
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("p", "/repo"), child("c", "/repo", "p")],
      },
    });
    expect(present("Title p")).toBe(true);
    expect(present("Title c")).toBe(false);
    expect(screen.getByRole("button", { name: "Expand 1 sub-agent" })).toBeInTheDocument();
  });

  it("keeps a child top-level in its own section when the parent's worktree is collapsed", () => {
    render(Harness, {
      props: {
        projects: [project("/repo"), worktree("/repo/wt", "/repo", { collapsed: true })],
        conversations: [conv("p", "/repo/wt"), child("c", "/repo", "p")],
      },
    });
    expect(present("Title p")).toBe(false);
    expect(present("Title c")).toBe(true);
    expect(screen.queryByRole("button", { name: /sub-agent/ })).toBeNull();
  });

  it("keeps a child top-level when the parent's project is collapsed", () => {
    render(Harness, {
      props: {
        projects: [project("/a", { collapsed: true }), project("/b")],
        conversations: [conv("p", "/a"), child("c", "/b", "p")],
      },
    });
    expect(present("Title p")).toBe(false);
    expect(present("Title c")).toBe(true);
  });

  it("keeps a child top-level in its own group when the parent lives in another", async () => {
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("p", ACP_CHAT_WORKSPACE_PATH), child("c", "/repo", "p")],
      },
    });
    expect(present("Title c")).toBe(true);
    expect(screen.queryByRole("button", { name: /1 sub-agent/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /Collapse Chats/ }));
    await waitFor(() => expect(present("Title p")).toBe(false));
    expect(present("Title c")).toBe(true);
  });

  it("renders a sub-agent in another worktree under that worktree, not its parent", () => {
    render(Harness, {
      props: {
        projects: [project("/repo"), worktree("/wt", "/repo")],
        conversations: [conv("p", "/repo"), child("c", "/wt", "p")],
      },
    });
    expect(present("Title c")).toBe(true);
    expect(screen.queryByRole("button", { name: /1 sub-agent/ })).toBeNull();
  });

  it("keeps a parent past the limit when a descendant is working, counting hidden descendants", () => {
    const others = [0, 1, 2, 3, 4].map((i) => conv(`o${i}`, "/repo", { age: i }));
    const hiddenPlain = conv("plain", "/repo", { age: 10 });
    const hiddenPlainKid = child("plain-kid", "/repo", "plain", { age: 10 });
    const busyParent = conv("busy", "/repo", { age: 20 });
    const busyKid = child("busy-kid", "/repo", "busy", {
      age: 20,
      liveStatus: { working: true, waitingForUser: false, unread: false },
    });
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [...others, hiddenPlain, hiddenPlainKid, busyParent, busyKid],
      },
    });
    expect(present("Title busy")).toBe(true);
    expect(present("Title plain")).toBe(false);
    // Only the plain parent and its child are hidden.
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 sub-agent · 1 running/ })).toBeInTheDocument();
  });

  it("auto-expands the parent of the open nested child without persisting", () => {
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("p", "/repo"), child("c", "/repo", "p")],
        activeConversationId: "c",
      },
    });
    expect(present("Title c")).toBe(true);
    expect(screen.getByRole("button", { name: /Collapse 1 sub-agent/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("respects an explicit collapse of the auto-expanded parent", async () => {
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("p", "/repo"), child("c", "/repo", "p")],
        activeConversationId: "c",
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: /Collapse 1 sub-agent/ }));
    await waitFor(() => expect(present("Title c")).toBe(false));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  describe("archive cascade", () => {
    const middleClick = (title: string) =>
      fireEvent(
        screen.getByText(title),
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
    const archivedIds = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((call) => call[3]);
    const props = (archiveSession: ReturnType<typeof vi.fn>) => ({
      projects: [project("/repo")],
      conversations: [conv("p", "/repo"), child("c", "/repo", "p")],
      archiveSession,
    });

    it("archives sub-agents after the parent archive succeeds", async () => {
      const archiveSession = vi.fn(async () => {});
      render(Harness, { props: props(archiveSession) });
      await middleClick("Title p");
      await waitFor(() => expect(archivedIds(archiveSession)).toEqual(["p", "c"]));
    });

    it("archives sub-agents spawned after the cascade began", async () => {
      let repo: Parameters<NonNullable<ComponentProps<typeof Harness>["onConversationRepo"]>>[0];
      const archiveSession = vi.fn(async (...args: unknown[]) => {
        if (args[3] === "p") {
          // Parent and child kept running meanwhile and spawned more work.
          repo.replaceConversations([
            conv("p", "/repo"),
            child("c", "/repo", "p"),
            child("n", "/repo", "p", { age: 1 }),
            child("ng", "/repo", "c", { age: 2, rootId: "p" }),
          ]);
        }
      });
      render(Harness, {
        props: { ...props(archiveSession), onConversationRepo: (r: typeof repo) => (repo = r) },
      });
      await middleClick("Title p");
      await waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(4));
      expect(archivedIds(archiveSession).sort()).toEqual(["c", "n", "ng", "p"]);
    });

    it("archives grandchildren when archiving a mid-level child", async () => {
      const archiveSession = vi.fn(async () => {});
      render(Harness, {
        props: {
          projects: [project("/repo")],
          conversations: [
            conv("p", "/repo"),
            child("m", "/repo", "p", { age: 1 }),
            child("g", "/repo", "m", { age: 2, rootId: "p" }),
          ],
          activeConversationId: "m",
          archiveSession,
        },
      });
      await middleClick("Title m");
      await waitFor(() => expect(archivedIds(archiveSession)).toEqual(["m", "g"]));
    });

    it("leaves a sub-agent in another worktree when the parent is archived", async () => {
      const archiveSession = vi.fn(async () => {});
      render(Harness, {
        props: {
          projects: [project("/repo"), worktree("/wt", "/repo")],
          conversations: [
            conv("p", "/repo"),
            child("c", "/repo", "p", { age: 1 }),
            child("w", "/wt", "p", { age: 2 }),
            child("wg", "/repo", "w", { age: 3, rootId: "p" }),
          ],
          archiveSession,
        },
      });
      await middleClick("Title p");
      await waitFor(() => expect(archivedIds(archiveSession).sort()).toEqual(["c", "p", "wg"]));
      expect(present("Title w")).toBe(true);
    });

    it("leaves sub-agents alone when the parent archive fails", async () => {
      const archiveSession = vi.fn(async (...args: unknown[]) => {
        if (args[3] === "p") throw new Error("boom");
      });
      render(Harness, { props: props(archiveSession) });
      await middleClick("Title p");
      await waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(archivedIds(archiveSession)).toEqual(["p"]);
      // Parent is restored together with its sub-agent disclosure.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Expand 1 sub-agent" })).toBeInTheDocument(),
      );
    });
  });
});

describe("DesktopSideBar composer conversation actions", () => {
  const registered = () => {
    const actions = getConversationActions();
    if (!actions) throw new Error("sidebar did not register conversation actions");
    return actions;
  };

  it("offers archive only for conversations the sidebar knows", () => {
    render(Harness, {
      props: { projects: [project("/repo")], conversations: [conv("a", "/repo")] },
    });
    expect(registered().canArchive("a")).toBe(true);
    expect(registered().canArchive("missing")).toBe(false);
    expect(registered().archiveConversation("missing")).toBe(false);
  });

  it("resolves the worktree a conversation runs in, but not from a subdirectory", () => {
    render(Harness, {
      props: {
        projects: [project("/repo"), worktree("/wt", "/repo", { nickname: "Feature" })],
        conversations: [
          conv("root", "/repo"),
          conv("top", "/wt", { age: 1 }),
          conv("sub", "/wt/packages/ui", { age: 2 }),
        ],
      },
    });
    expect(registered().worktreeFor("root")).toBeNull();
    expect(registered().worktreeFor("top")).toEqual({ path: "/wt", name: "Feature" });
    // Worktree removal only cleans up conversations in the worktree itself.
    expect(registered().worktreeFor("sub")).toBeNull();
  });

  it("opens a collapsed sidebar so the archive undo toast is visible", async () => {
    const onCollapsedChange = vi.fn();
    const archiveSession = vi.fn(async () => {});
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("a", "/repo")],
        collapsed: true,
        onCollapsedChange,
        archiveSession,
      },
    });
    expect(registered().archiveConversation("a")).toBe(true);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    // The countdown runs first, so nothing is archived yet and it can be undone.
    expect(archiveSession).not.toHaveBeenCalled();
    expect(await screen.findByText("Archiving conversation...")).toBeInTheDocument();
  });
});
