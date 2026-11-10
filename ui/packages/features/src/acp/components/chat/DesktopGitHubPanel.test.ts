import type { GitHubPRDetail } from "@camber/helperapi";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeStatefulModule } from "../../hostRpc";
import Harness from "./DesktopGitHubPanel.test.svelte";
import TitleLoopHarness from "./DesktopGitHubPanel.title-loop.test.svelte";

const helperApiMocks = vi.hoisted(() => ({
  camberGithubPrDetail: vi.fn(),
}));

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGithubPrDetail: helperApiMocks.camberGithubPrDetail,
}));

function prDetail(overrides: Partial<GitHubPRDetail> = {}): GitHubPRDetail {
  return {
    state: "open",
    number: 7,
    title: "Add feature",
    url: "https://github.com/o/r/pull/7",
    isDraft: false,
    reviewDecision: "approved",
    checks: { status: "success", total: 2, passed: 2, failed: 0, pending: 0 },
    commentCount: 1,
    updatedAt: "2026-06-29T00:00:00Z",
    body: "Body text",
    author: "octocat",
    baseRefName: "main",
    headRefName: "camber/foo",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    checkRuns: [{ name: "build", status: "completed", conclusion: "success", url: "" }],
    reviews: [],
    comments: [{ author: "octocat", body: "LGTM", url: "", createdAt: "2026-06-29T00:00:00Z" }],
    ...overrides,
  };
}

describe("DesktopGitHubPanel", () => {
  let sender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    helperApiMocks.camberGithubPrDetail.mockReset();
    sender = vi.fn().mockResolvedValue(undefined);
    initializeStatefulModule(sender);
  });

  it("prompts to connect when a GitHub repo has no auth", async () => {
    // A supported GitHub remote with no auth: the helper reports
    // repoSupported=true, configured=false.
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: null,
      configured: false,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(Harness, { worktreePath: "/repo/foo" });
    await waitFor(() => expect(screen.getByText(/Connect GitHub/i)).toBeTruthy());
  });

  it("explains how an unsupported GitHub remote is detected", async () => {
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: null,
      configured: false,
      repoSupported: false,
      branch: "",
    });
    render(Harness, { worktreePath: "/repo/foo" });
    await waitFor(() =>
      expect(screen.getByText(/couldn’t detect a supported GitHub remote/i)).toBeTruthy(),
    );
    expect(screen.getByText("origin")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getByText("url.*.insteadOf")).toBeTruthy();
    expect(screen.getByText("git remote get-url origin")).toBeTruthy();
  });

  it("shows the no-PR state for a supported repo without a pull request", async () => {
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: null,
      configured: true,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(Harness, { worktreePath: "/repo/foo" });
    await waitFor(() => expect(screen.getByText(/No open pull request/i)).toBeTruthy());
  });

  it("renders pull-request detail and opens the PR through the host", async () => {
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: prDetail(),
      configured: true,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(Harness, { worktreePath: "/repo/foo" });

    await waitFor(() => expect(screen.getByText("Add feature")).toBeTruthy());
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("LGTM")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    expect(sender).toHaveBeenCalledWith("openExternalURL", ["https://github.com/o/r/pull/7"]);
  });

  it("opens a check run from the full row link", async () => {
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: prDetail({
        checkRuns: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/o/r/actions/runs/123",
          },
        ],
      }),
      configured: true,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(Harness, { worktreePath: "/repo/foo" });

    const checkRunLink = await screen.findByRole("link", { name: "Open build" });
    expect(screen.queryByRole("button", { name: "Open build" })).toBeNull();

    await fireEvent.click(checkRunLink);
    expect(sender).toHaveBeenCalledWith("openExternalURL", [
      "https://github.com/o/r/actions/runs/123",
    ]);
  });

  it("reports the PR number and title for the owning tab", async () => {
    const onTitleChange = vi.fn();
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: prDetail({ number: 42, title: "Ship the thing" }),
      configured: true,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(Harness, { worktreePath: "/repo/foo", onTitleChange });

    await waitFor(() => expect(screen.getByText("Ship the thing")).toBeTruthy());
    expect(onTitleChange).toHaveBeenCalledWith("GitHub");
    expect(onTitleChange).toHaveBeenCalledWith("#42 Ship the thing");
  });

  it("does not reload when the title callback rerenders the parent", async () => {
    helperApiMocks.camberGithubPrDetail.mockResolvedValue({
      detail: prDetail({ number: 42, title: "Ship the thing" }),
      configured: true,
      repoSupported: true,
      branch: "camber/foo",
    });
    render(TitleLoopHarness, { worktreePath: "/repo/foo" });

    await waitFor(() => expect(screen.getByText("Ship the thing")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("title-count").textContent).toBe("2"));
    expect(helperApiMocks.camberGithubPrDetail).toHaveBeenCalledTimes(1);
  });
});
