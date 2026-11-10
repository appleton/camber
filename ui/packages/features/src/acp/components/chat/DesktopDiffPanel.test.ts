import {
  camberGitDiffClose,
  camberGitDiffList,
  camberGitDiffOpen,
  camberGitDiffRead,
  camberGitDiffStats,
  camberGitStatus,
  type GitStatusOutput,
} from "@camber/helperapi";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_FILE_TREE_CHANGED_EVENT } from "../../features/DesktopGitChangesState.svelte";
import DesktopDiffPanel from "./DesktopDiffPanel.svelte";

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGitDiffClose: vi.fn(),
  camberGitDiffList: vi.fn(),
  camberGitDiffOpen: vi.fn(),
  camberGitDiffRead: vi.fn(),
  camberGitDiffStats: vi.fn(),
  camberGitStatus: vi.fn(),
}));

// jsdom cannot host @pierre/diffs' shadow-DOM CodeView (no
// CSSStyleSheet.replaceSync); render items through the same mock the
// document tests use.
vi.mock("@camber/components/file-diff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/components/file-diff")>()),
  DiffCodeView: (await import("../shared/DiffCodeView.mock.svelte")).default,
}));

const closeMock = vi.mocked(camberGitDiffClose);
const listMock = vi.mocked(camberGitDiffList);
const openMock = vi.mocked(camberGitDiffOpen);
const readMock = vi.mocked(camberGitDiffRead);
const statsMock = vi.mocked(camberGitDiffStats);
const statusMock = vi.mocked(camberGitStatus);

function unavailableStatus(gitMissing: boolean): GitStatusOutput {
  return {
    isRepo: false,
    gitMissing,
    branch: "",
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    stashCount: 0,
    additions: 0,
    deletions: 0,
  };
}

function cleanStatus(overrides: Partial<GitStatusOutput> = {}): GitStatusOutput {
  return {
    isRepo: true,
    branch: "camber/fair-forecastle",
    detached: false,
    upstream: "origin/camber/fair-forecastle",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    stashCount: 0,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  closeMock.mockResolvedValue();
  listMock.mockResolvedValue({ files: [], complete: true });
  readMock.mockResolvedValue({ complete: true });
  statsMock.mockResolvedValue({ ready: false });
});

afterEach(() => vi.useRealTimers());

describe("DesktopDiffPanel footer", () => {
  it("keeps the scope and actions visible while the diff is loading", () => {
    statusMock.mockReturnValue(new Promise(() => undefined));
    openMock.mockReturnValue(new Promise(() => undefined));

    const { getByRole, getByText, queryByText } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/loading-repo", openToken: 1 },
    });

    expect(getByText("All Uncommitted changes")).toBeInTheDocument();
    expect(getByRole("button", { name: "Collapse All" })).toBeDisabled();
    expect(getByRole("button", { name: "Stage and Commit..." })).toBeEnabled();
    expect(queryByText(/files?$/)).not.toBeInTheDocument();
  });
});

describe("DesktopDiffPanel unavailable states", () => {
  it("shows a benign empty state outside a git repository", async () => {
    statusMock.mockResolvedValue(unavailableStatus(false));
    openMock.mockResolvedValue({
      unavailable: true,
      sessionId: "",
      files: [],
      complete: true,
    });

    const { getByText } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/not-a-repo", openToken: 1 },
    });

    await waitFor(() => expect(getByText("Not a git repository.")).toBeInTheDocument());
    expect(closeMock).not.toHaveBeenCalled();
    expect(statsMock).not.toHaveBeenCalled();
  });

  it("explains when git is not installed", async () => {
    statusMock.mockResolvedValue(unavailableStatus(true));
    openMock.mockResolvedValue({
      unavailable: true,
      gitMissing: true,
      sessionId: "",
      files: [],
      complete: true,
    });

    const { getByText } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/no-git", openToken: 1 },
    });

    await waitFor(() => expect(getByText("Git is not installed.")).toBeInTheDocument());
    expect(closeMock).not.toHaveBeenCalled();
    expect(statsMock).not.toHaveBeenCalled();
  });
});

describe("DesktopDiffPanel empty state", () => {
  it("matches git status for a clean branch that is up to date", async () => {
    statusMock.mockResolvedValue(cleanStatus());
    openMock.mockResolvedValue({
      sessionId: "clean-session",
      files: [],
      complete: true,
    });

    const { getByText } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/clean-repo", openToken: 1 },
    });

    await waitFor(() => expect(getByText("On branch camber/fair-forecastle")).toBeInTheDocument());
    expect(
      getByText("Your branch is up to date with 'origin/camber/fair-forecastle'."),
    ).toBeInTheDocument();
    expect(getByText("nothing to commit, working tree clean")).toBeInTheDocument();
  });
});

describe("DesktopDiffPanel settle gate", () => {
  it("keeps a fresh document hidden until it settles, then reveals it", async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(cleanStatus());
    // Hold the file read open: any resolved read (even an empty one) renders
    // an item and settles the document immediately, hiding the gated state
    // this test observes.
    readMock.mockReturnValue(new Promise(() => undefined));
    openMock.mockResolvedValue({
      sessionId: "gated-session",
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });

    const { container, unmount } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/gated-repo", openToken: 1 },
    });

    await vi.waitFor(() => {
      expect(container.querySelector(".diff-panel-body")).toHaveClass("is-faded");
    });

    // With the read hung, the document settles via its deadline.
    await vi.advanceTimersByTimeAsync(600);
    expect(container.querySelector(".diff-panel-body")).not.toHaveClass("is-faded");
    unmount();
  });

  it("adopts silent reloads into the mounted document without remounting", async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(cleanStatus());
    listMock.mockResolvedValue({
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });
    openMock.mockResolvedValue({
      sessionId: "epoch-A",
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });

    const { container, unmount } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/epoch-repo", openToken: 1 },
    });
    await vi.advanceTimersByTimeAsync(600);
    const documentRoot = container.querySelector(".diff-document");
    expect(documentRoot).not.toBeNull();

    openMock.mockResolvedValue({
      sessionId: "epoch-B",
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });
    window.dispatchEvent(
      new CustomEvent(DESKTOP_FILE_TREE_CHANGED_EVENT, {
        detail: { changes: [{ path: "/tmp/epoch-repo/src/app.ts" }] },
      }),
    );
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(100);

    // Same document node and no fade: the update reconciled in place.
    expect(container.querySelector(".diff-document")).toBe(documentRoot);
    expect(container.querySelector(".diff-panel-body")).not.toHaveClass("is-faded");
    unmount();
  });

  it("keeps the old diff visible during a scope switch and swaps once settled", async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(cleanStatus());
    // Hung reads keep each document settling via its deadline, leaving a
    // window where the incoming scope's document is stacked hidden behind
    // the displayed one.
    readMock.mockReturnValue(new Promise(() => undefined));
    listMock.mockResolvedValue({
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });
    openMock.mockResolvedValue({
      sessionId: "scope-uncommitted",
      files: [{ path: "src/app.ts", status: "modified" }],
      complete: true,
    });

    const { container, getByRole, unmount } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/scope-repo", openToken: 1 },
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(container.querySelectorAll(".diff-panel-doc")).toHaveLength(1);

    openMock.mockResolvedValue({
      sessionId: "scope-staged",
      files: [{ path: "staged.ts", status: "modified" }],
      complete: true,
    });
    await fireEvent.click(getByRole("radio", { name: "Staged" }));
    await vi.advanceTimersByTimeAsync(10);

    // The displayed diff stays fully visible — no fade, no spinner — while
    // the incoming scope's document settles hidden alongside it.
    const stacked = container.querySelectorAll(".diff-panel-doc");
    expect(stacked).toHaveLength(2);
    expect(container.querySelectorAll(".diff-panel-doc.is-hidden")).toHaveLength(1);
    expect(container.querySelector(".diff-panel-body")).not.toHaveClass("is-faded");
    expect(container.querySelector(".diff-panel-fade-spinner")).toBeNull();

    await vi.advanceTimersByTimeAsync(600);
    const remaining = container.querySelectorAll(".diff-panel-doc");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).not.toHaveClass("is-hidden");
    unmount();
  });
});

describe("DesktopDiffPanel refresh", () => {
  it("reloads an open diff when files in its worktree change", async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(cleanStatus());
    openMock.mockResolvedValue({
      sessionId: "diff-session",
      files: [],
      complete: true,
    });

    const { unmount } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/project", openToken: 1 },
    });

    await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(
      new CustomEvent(DESKTOP_FILE_TREE_CHANGED_EVENT, {
        detail: { changes: [{ path: "/tmp/project/src/app.ts" }] },
      }),
    );
    await vi.advanceTimersByTimeAsync(750);

    await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));
    unmount();
  });

  it("ignores file changes from a different worktree", async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(cleanStatus());
    openMock.mockResolvedValue({
      sessionId: "diff-session",
      files: [],
      complete: true,
    });

    const { unmount } = render(DesktopDiffPanel, {
      props: { worktreePath: "/tmp/project", openToken: 1 },
    });

    await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(
      new CustomEvent(DESKTOP_FILE_TREE_CHANGED_EVENT, {
        detail: { changes: [{ path: "/tmp/other/src/app.ts" }] },
      }),
    );
    await vi.advanceTimersByTimeAsync(750);

    expect(openMock).toHaveBeenCalledTimes(1);
    unmount();
  });
});
