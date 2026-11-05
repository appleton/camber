import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("keeps a child top-level when the parent's CHATS section is collapsed", async () => {
    render(Harness, {
      props: {
        projects: [project("/repo")],
        conversations: [conv("p", ACP_CHAT_WORKSPACE_PATH), child("c", "/repo", "p")],
      },
    });
    expect(present("Title c")).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: /Collapse Chats/ }));
    await waitFor(() => expect(present("Title c")).toBe(true));
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
