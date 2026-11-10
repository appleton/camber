import type { GitStatusOutput } from "@camber/helperapi";
import { describe, expect, it } from "vitest";
import { gitViewDisabledReason } from "./desktopCommandPicker";

function gitStatus(overrides: Partial<GitStatusOutput> = {}): GitStatusOutput {
  return {
    isRepo: true,
    branch: "main",
    detached: false,
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

describe("gitViewDisabledReason", () => {
  it("disables git views without a working directory or resolved status", () => {
    expect(gitViewDisabledReason(undefined, undefined)).toBe("No working directory");
    expect(gitViewDisabledReason("/repo", undefined)).toBe("Checking Git availability");
  });

  it("distinguishes a missing git binary from a non-repository", () => {
    expect(gitViewDisabledReason("/repo", gitStatus({ isRepo: false, gitMissing: true }))).toBe(
      "Git is not installed",
    );
    expect(gitViewDisabledReason("/repo", gitStatus({ isRepo: false }))).toBe(
      "Not a git repository",
    );
  });

  it("enables git views inside a repository", () => {
    expect(gitViewDisabledReason("/repo", gitStatus())).toBeUndefined();
  });
});
