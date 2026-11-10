import type { GitStatusOutput } from "@camber/helperapi";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import DesktopDiffEmptyState from "./DesktopDiffEmptyState.svelte";

function cleanStatus(overrides: Partial<GitStatusOutput> = {}): GitStatusOutput {
  return {
    isRepo: true,
    branch: "feature",
    detached: false,
    upstream: "origin/feature",
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

describe("DesktopDiffEmptyState", () => {
  it("renders the git status wording for a clean tracked branch", () => {
    const { getByText } = render(DesktopDiffEmptyState, {
      props: { scope: "uncommitted", gitStatus: cleanStatus() },
    });

    expect(getByText("On branch feature")).toBeInTheDocument();
    expect(getByText("Your branch is up to date with 'origin/feature'.")).toBeInTheDocument();
    expect(getByText("nothing to commit, working tree clean")).toBeInTheDocument();
  });

  it("reports ahead and diverged tracking states without claiming up to date", async () => {
    const { getByText, queryByText, rerender } = render(DesktopDiffEmptyState, {
      props: { scope: "uncommitted", gitStatus: cleanStatus({ ahead: 1 }) },
    });

    expect(getByText("Your branch is ahead of 'origin/feature' by 1 commit.")).toBeInTheDocument();
    expect(queryByText(/up to date/)).not.toBeInTheDocument();

    await rerender({
      scope: "uncommitted",
      gitStatus: cleanStatus({ ahead: 2, behind: 3 }),
    });
    expect(
      getByText(
        "Your branch and 'origin/feature' have diverged, and have 2 and 3 different commits each, respectively.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps scoped and uncertain empty states truthful", async () => {
    const { getByText, queryByText, rerender } = render(DesktopDiffEmptyState, {
      props: {
        scope: "staged",
        gitStatus: cleanStatus({ untracked: [{ path: "new", status: "added" }] }),
      },
    });

    expect(getByText("No staged changes.")).toBeInTheDocument();
    expect(queryByText(/working tree clean/)).not.toBeInTheDocument();

    await rerender({ scope: "uncommitted", gitStatus: undefined });
    expect(getByText("No changes to show.")).toBeInTheDocument();
    expect(queryByText(/working tree clean/)).not.toBeInTheDocument();
  });
});
