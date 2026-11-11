import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ACPConversationSummary, ACPNavProject } from "../../navTypes";
import DesktopProjectSection from "./DesktopProjectSection.svelte";

const sidebar = vi.hoisted(() => ({
  isLoading: false,
  isRenamingWorkspace: vi.fn(() => false),
  isRenamingConversation: vi.fn(() => false),
  rowState: vi.fn((_session: { id: string }) => ({ selected: false })),
  getSessionAgentServer: vi.fn(
    (session: { agentServer?: string }) => session.agentServer ?? "poolside",
  ),
  reviewSessionKey: vi.fn((session: { id: string }) => session.id),
  agentIconColorClass: vi.fn(() => ""),
  liveSessionFor: vi.fn(() => null),
  openConversationPreview: vi.fn(),
  leaveConversationPreview: vi.fn(),
  cancelConversationPreviewOpen: vi.fn(),
  unmountConversationPreviewRow: vi.fn(),
  refreshConversationPreview: vi.fn(),
  closeConversationPreview: vi.fn(),
  newConversation: vi.fn(),
}));

const github = vi.hoisted(() => ({
  isRepoFor: vi.fn(() => true),
  worktreeStatusFor: vi.fn(() => undefined),
  categoryFor: vi.fn(() => "none"),
  prDetail: vi.fn(),
}));

vi.mock("./SidebarController.svelte", () => ({
  getAcpSidebarController: () => sidebar,
}));

vi.mock("../../features/GithubRepository.svelte", () => ({
  getACPGithubRepo: () => github,
}));

const project: ACPNavProject = {
  path: "/repo",
  name: "Repo",
  isWorktree: false,
  collapsed: false,
  displayOrder: 0,
  createdAt: "2026-07-27T10:00:00Z",
  updatedAt: "2026-07-27T10:00:00Z",
};

const worktree: ACPNavProject = {
  path: "/repo/worktrees/feature",
  name: "feature",
  isWorktree: true,
  parentPath: "/repo",
  collapsed: false,
  displayOrder: 0,
  createdAt: "2026-07-27T10:00:00Z",
  updatedAt: "2026-07-27T10:00:00Z",
};

const activeWorktreeSession: ACPConversationSummary = {
  id: "active-conversation",
  sessionId: "active-session",
  cwd: worktree.path,
  title: "Active conversation",
  agentServer: "poolside",
  workingDirectories: [worktree.path],
  updatedAt: "2026-07-27T10:00:00Z",
  source: "native_session",
  readOnly: false,
  errorMessage: null,
  cancellationReason: null,
  conversationId: "active-conversation",
  conversationKind: "agentic",
  agentId: null,
  _meta: {},
};

describe("DesktopProjectSection", () => {
  afterEach(() => {
    sidebar.rowState.mockReset();
    sidebar.rowState.mockReturnValue({ selected: false });
  });

  it("invokes the delete action from the worktree row", async () => {
    const onRemoveWorktree = vi.fn();

    render(DesktopProjectSection, {
      props: {
        project,
        projectSessions: [],
        worktrees: [worktree],
        searchQuery: "",
        sessionVisibleLimit: 5,
        projectContentVisible: true,
        projectCollapsed: false,
        projectSessionsExpanded: true,
        canOpenWorkspace: false,
        isCurrentWorkspace: () => false,
        sessionsFor: () => [],
        isSessionGroupExpanded: () => true,
        onToggleProjectCollapsed: vi.fn(),
        onToggleSessionsExpanded: vi.fn(),
        onAddWorktree: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRemoveWorktree,
        onArchiveSession: vi.fn(),
        onArchiveSessionNow: vi.fn(),
        onProjectContextMenu: vi.fn(),
        onWorktreeContextMenu: vi.fn(),
        onSessionContextMenu: vi.fn(),
        onReorderWorktrees: vi.fn(),
        onWorktreeDragActiveChange: vi.fn(),
      },
    });

    const deleteButton = screen.getByRole("button", {
      name: "Delete worktree feature",
    });

    await fireEvent.click(deleteButton);

    expect(onRemoveWorktree).toHaveBeenCalledWith("/repo/worktrees/feature");
  });

  // The removed row is still on screen while it flies out, so the empty state
  // must not appear underneath it.
  it("holds back the empty state until the exit animation finishes", async () => {
    const emptyProjectProps = {
      project,
      projectSessions: [],
      worktrees: [],
      searchQuery: "",
      sessionVisibleLimit: 5,
      projectContentVisible: true,
      projectCollapsed: false,
      projectSessionsExpanded: true,
      canOpenWorkspace: false,
      isCurrentWorkspace: () => false,
      sessionsFor: () => [],
      isSessionGroupExpanded: () => true,
      onToggleProjectCollapsed: vi.fn(),
      onToggleSessionsExpanded: vi.fn(),
      onAddWorktree: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRemoveWorktree: vi.fn(),
      onArchiveSession: vi.fn(),
      onArchiveSessionNow: vi.fn(),
      onProjectContextMenu: vi.fn(),
      onWorktreeContextMenu: vi.fn(),
      onSessionContextMenu: vi.fn(),
      onReorderWorktrees: vi.fn(),
      onWorktreeDragActiveChange: vi.fn(),
    };

    const { rerender } = render(DesktopProjectSection, {
      props: { ...emptyProjectProps, rowExitAnimating: true },
    });

    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();

    await rerender({ ...emptyProjectProps, rowExitAnimating: false });

    expect(screen.getByText("No conversations")).toBeInTheDocument();
  });

  // The worktree subtree has its own "No conversations" copy; archiving a
  // worktree's only conversation must not reveal it under the flying row.
  it("holds back the worktree empty state until the exit animation finishes", async () => {
    const emptyWorktreeProps = {
      project,
      projectSessions: [],
      worktrees: [worktree],
      searchQuery: "",
      sessionVisibleLimit: 5,
      projectContentVisible: true,
      projectCollapsed: false,
      projectSessionsExpanded: true,
      canOpenWorkspace: false,
      isCurrentWorkspace: () => false,
      sessionsFor: () => [],
      isSessionGroupExpanded: () => true,
      onToggleProjectCollapsed: vi.fn(),
      onToggleSessionsExpanded: vi.fn(),
      onAddWorktree: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRemoveWorktree: vi.fn(),
      onArchiveSession: vi.fn(),
      onArchiveSessionNow: vi.fn(),
      onProjectContextMenu: vi.fn(),
      onWorktreeContextMenu: vi.fn(),
      onSessionContextMenu: vi.fn(),
      onReorderWorktrees: vi.fn(),
      onWorktreeDragActiveChange: vi.fn(),
    };

    const { rerender } = render(DesktopProjectSection, {
      props: { ...emptyWorktreeProps, rowExitAnimating: true },
    });

    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();

    await rerender({ ...emptyWorktreeProps, rowExitAnimating: false });

    expect(screen.getByText("No conversations")).toBeInTheDocument();
  });

  it("hoists the active worktree's Open badge to a collapsed project header", () => {
    sidebar.rowState.mockImplementation((session: { id: string }) => ({
      selected: session.id === activeWorktreeSession.id,
    }));

    render(DesktopProjectSection, {
      props: {
        project,
        projectSessions: [],
        worktrees: [worktree],
        searchQuery: "",
        sessionVisibleLimit: 5,
        projectContentVisible: false,
        projectCollapsed: true,
        projectSessionsExpanded: true,
        canOpenWorkspace: false,
        isCurrentWorkspace: () => false,
        sessionsFor: (path) => (path === worktree.path ? [activeWorktreeSession] : []),
        isSessionGroupExpanded: () => true,
        onToggleProjectCollapsed: vi.fn(),
        onToggleSessionsExpanded: vi.fn(),
        onAddWorktree: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRemoveWorktree: vi.fn(),
        onArchiveSession: vi.fn(),
        onArchiveSessionNow: vi.fn(),
        onProjectContextMenu: vi.fn(),
        onWorktreeContextMenu: vi.fn(),
        onSessionContextMenu: vi.fn(),
        onReorderWorktrees: vi.fn(),
        onWorktreeDragActiveChange: vi.fn(),
      },
    });

    const projectHeader = screen.getByRole("button", { name: "Expand Repo" }).parentElement;
    expect(projectHeader).toHaveTextContent("Open");
  });

  it("marks a worktree open when its collapsed row hides the selected sub-agent", () => {
    const nested = { ...activeWorktreeSession, id: "nested", conversationId: "nested" };
    sidebar.rowState.mockImplementation((session: { id: string }) => ({
      selected: session.id === "nested",
    }));

    render(DesktopProjectSection, {
      props: {
        project,
        projectSessions: [],
        worktrees: [worktree],
        searchQuery: "",
        sessionVisibleLimit: 5,
        projectContentVisible: true,
        projectCollapsed: false,
        projectSessionsExpanded: true,
        canOpenWorkspace: false,
        isCurrentWorkspace: () => false,
        sessionsFor: (path: string) => (path === worktree.path ? [activeWorktreeSession] : []),
        descendantsFor: (session: ACPConversationSummary) =>
          session.id === activeWorktreeSession.id ? [nested] : [],
        isSessionGroupExpanded: () => true,
        onToggleProjectCollapsed: vi.fn(),
        onToggleSessionsExpanded: vi.fn(),
        onAddWorktree: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRemoveWorktree: vi.fn(),
        onArchiveSession: vi.fn(),
        onArchiveSessionNow: vi.fn(),
        onProjectContextMenu: vi.fn(),
        onWorktreeContextMenu: vi.fn(),
        onSessionContextMenu: vi.fn(),
        onReorderWorktrees: vi.fn(),
        onWorktreeDragActiveChange: vi.fn(),
      },
    });

    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
  });
});
