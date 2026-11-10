import type { GitHubPRStatus } from "@camber/helperapi";
import { describe, expect, it } from "vitest";
import {
  githubChecksCountLabel,
  githubCommentsCountLabel,
  githubDotColorClass,
  githubPRActionLabel,
  githubReviewDecisionLabel,
  githubStatusCategory,
  githubStatusSummary,
} from "./githubStatus";

function status(overrides: Partial<GitHubPRStatus> = {}): GitHubPRStatus {
  return {
    state: "open",
    number: 1,
    title: "Test PR",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    reviewDecision: "",
    checks: { status: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    commentCount: 0,
    updatedAt: "2026-06-29T00:00:00Z",
    ...overrides,
  };
}

describe("githubStatusCategory", () => {
  it("returns none for missing or no-PR status", () => {
    expect(githubStatusCategory(undefined)).toBe("none");
    expect(githubStatusCategory(status({ state: "none" }))).toBe("none");
  });

  it("maps merged and closed states", () => {
    expect(githubStatusCategory(status({ state: "merged" }))).toBe("merged");
    expect(githubStatusCategory(status({ state: "closed" }))).toBe("closed");
  });

  it("prioritizes failing checks and changes requested over other signals", () => {
    expect(
      githubStatusCategory(status({ checks: { ...status().checks, status: "failure" } })),
    ).toBe("failure");
    expect(githubStatusCategory(status({ reviewDecision: "changes_requested" }))).toBe("failure");
    // changes requested wins even with passing checks
    expect(
      githubStatusCategory(
        status({
          reviewDecision: "changes_requested",
          checks: { ...status().checks, status: "success" },
        }),
      ),
    ).toBe("failure");
  });

  it("returns pending when checks are running", () => {
    expect(
      githubStatusCategory(status({ checks: { ...status().checks, status: "pending" } })),
    ).toBe("pending");
  });

  it("returns draft when not blocked", () => {
    expect(githubStatusCategory(status({ state: "draft" }))).toBe("draft");
    // a draft with failing checks still surfaces the failure
    expect(
      githubStatusCategory(
        status({ state: "draft", checks: { ...status().checks, status: "failure" } }),
      ),
    ).toBe("failure");
  });

  it("returns success when approved or checks pass (checks mode)", () => {
    expect(githubStatusCategory(status({ reviewDecision: "approved" }))).toBe("success");
    expect(
      githubStatusCategory(status({ checks: { ...status().checks, status: "success" } })),
    ).toBe("success");
  });

  it("checks mode: green when nothing is blocking, including a PR with no checks", () => {
    // No checks + no review: nothing is waiting, so it's green (matches a
    // mergeable PR on GitHub with no required checks).
    expect(githubStatusCategory(status())).toBe("success");
  });

  it("review mode: green only when approved, awaiting_review when CI passes unapproved", () => {
    const ciGreen = status({
      checks: { status: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    });
    expect(githubStatusCategory(ciGreen, "review")).toBe("awaiting_review");
    expect(githubStatusCategory({ ...ciGreen, reviewDecision: "approved" }, "review")).toBe(
      "success",
    );
    // blocking signals still win in review mode
    expect(
      githubStatusCategory({ ...ciGreen, reviewDecision: "changes_requested" }, "review"),
    ).toBe("failure");
  });
});

describe("githubDotColorClass", () => {
  it("returns empty string for none (no dot)", () => {
    expect(githubDotColorClass("none")).toBe("");
  });
  it("returns a distinct class per meaningful category", () => {
    const categories = [
      "failure",
      "pending",
      "success",
      "awaiting_review",
      "open",
      "merged",
      "draft",
      "closed",
    ] as const;
    const classes = categories.map((c) => githubDotColorClass(c));
    expect(classes.every((c) => c.length > 0)).toBe(true);
  });
});

describe("githubStatusSummary", () => {
  it("is empty when there is no PR", () => {
    expect(githubStatusSummary(undefined)).toBe("");
    expect(githubStatusSummary(status({ state: "none" }))).toBe("");
  });
  it("includes number, state, checks, and review", () => {
    const summary = githubStatusSummary(
      status({
        number: 42,
        state: "open",
        checks: { status: "success", total: 3, passed: 3, failed: 0, pending: 0 },
        reviewDecision: "approved",
      }),
    );
    expect(summary).toBe("PR #42 open · checks passing · approved");
  });
});

describe("github tooltip labels", () => {
  it("formats the PR action from current status", () => {
    expect(githubPRActionLabel(undefined)).toBe("Open New Pull Request");
    expect(githubPRActionLabel(status({ state: "none" }))).toBe("Open New Pull Request");
    expect(githubPRActionLabel(status({ state: "open" }))).toBe("Open Current Pull Request");
  });

  it("formats counts and review decision for the visual tooltip", () => {
    const pr = status({
      checks: { status: "pending", total: 5, passed: 3, failed: 1, pending: 1 },
      commentCount: 1,
      reviewDecision: "review_required",
    });

    expect(githubChecksCountLabel(pr)).toBe("3/5 checks passing · 1 failed · 1 running");
    expect(githubCommentsCountLabel(pr)).toBe("1 comment");
    expect(githubReviewDecisionLabel(pr)).toBe("review required");
  });

  it("formats compact check rollups without count details", () => {
    expect(
      githubChecksCountLabel(
        status({ checks: { status: "success", total: 0, passed: 0, failed: 0, pending: 0 } }),
      ),
    ).toBe("checks passing");
    expect(
      githubChecksCountLabel(
        status({ checks: { status: "pending", total: 0, passed: 0, failed: 0, pending: 0 } }),
      ),
    ).toBe("checks running");
    expect(
      githubChecksCountLabel(
        status({ checks: { status: "failure", total: 0, passed: 0, failed: 0, pending: 0 } }),
      ),
    ).toBe("checks failing");
  });
});
