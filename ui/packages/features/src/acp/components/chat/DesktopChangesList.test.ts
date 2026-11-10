import {
  camberGitCommit,
  camberGitDiscard,
  camberGitStage,
  camberGitStatus,
  camberGitUnstage,
  type GitStatusOutput,
} from "@camber/helperapi";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopChangesList from "./DesktopChangesList.svelte";
import {
  DESKTOP_OPEN_DIFF_TAB_EVENT,
  DESKTOP_OPEN_FILE_TAB_EVENT,
  type DesktopOpenDiffTabEventDetail,
} from "./desktopCommandPicker";

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGitCommit: vi.fn(),
  camberGitDiscard: vi.fn(),
  camberGitStage: vi.fn(),
  camberGitStatus: vi.fn(),
  camberGitUnstage: vi.fn(),
}));

const statusMock = vi.mocked(camberGitStatus);

function gitStatus(): GitStatusOutput {
  return {
    isRepo: true,
    branch: "feature",
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [{ path: "changed.ts", status: "modified" }],
    unstaged: [],
    untracked: [],
    stashCount: 0,
    additions: 1,
    deletions: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  statusMock.mockResolvedValue(gitStatus());
  vi.mocked(camberGitCommit).mockResolvedValue(gitStatus());
  vi.mocked(camberGitDiscard).mockResolvedValue(gitStatus());
  vi.mocked(camberGitStage).mockResolvedValue(gitStatus());
  vi.mocked(camberGitUnstage).mockResolvedValue(gitStatus());
});

describe("DesktopChangesList row clicks", () => {
  it("opens the file's diff, not the file itself", async () => {
    const diffEvents: DesktopOpenDiffTabEventDetail[] = [];
    const fileEvents: unknown[] = [];
    const onDiff = (event: Event) =>
      diffEvents.push((event as CustomEvent<DesktopOpenDiffTabEventDetail>).detail);
    const onFile = (event: Event) => fileEvents.push((event as CustomEvent).detail);
    window.addEventListener(DESKTOP_OPEN_DIFF_TAB_EVENT, onDiff);
    window.addEventListener(DESKTOP_OPEN_FILE_TAB_EVENT, onFile);
    try {
      const { findByTitle } = render(DesktopChangesList, {
        props: { worktreePath: "/repo/row-click" },
      });
      // The row button's title is "<path>\n<staging> · click to view diff";
      // the matcher normalizes the newline to a space.
      const row = await findByTitle(/^changed\.ts staged/);

      await fireEvent.click(row);

      // The click is deferred by a double-click grace period before opening.
      await waitFor(() => expect(diffEvents).toHaveLength(1), { timeout: 2000 });
      expect(diffEvents[0]).toEqual({
        worktreePath: "/repo/row-click",
        relativePath: "changed.ts",
      });
      expect(fileEvents).toHaveLength(0);
    } finally {
      window.removeEventListener(DESKTOP_OPEN_DIFF_TAB_EVENT, onDiff);
      window.removeEventListener(DESKTOP_OPEN_FILE_TAB_EVENT, onFile);
    }
  });
});

describe("DesktopChangesList commit message", () => {
  it("shows a first-line character countdown only after typing", async () => {
    const { container, findByPlaceholderText, getByText } = render(DesktopChangesList, {
      props: { worktreePath: "/repo/commit-count" },
    });
    const textarea = await findByPlaceholderText("Commit message (⌘⏎ to commit)");

    expect(container.querySelector(".changes-list-commit-character-count")).toBeNull();

    await fireEvent.input(textarea, { target: { value: "a" } });
    expect(getByText("49")).toBeInTheDocument();

    await fireEvent.input(textarea, { target: { value: `subject\n${"body".repeat(30)}` } });
    expect(getByText("43")).toBeInTheDocument();

    await fireEvent.input(textarea, { target: { value: "a".repeat(51) } });
    await waitFor(() => expect(getByText("-1")).toBeInTheDocument());
  });
});
