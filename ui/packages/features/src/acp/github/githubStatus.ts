import type { GitHubPRStatus } from "@camber/helperapi";

export type {
  GitHubCheckRun,
  GitHubChecks,
  GitHubComment,
  GitHubPRDetail,
  GitHubPRStatus,
  GitHubReview,
  GitHubWorktreeStatus,
} from "@camber/helperapi";

// GitHubStatusCategory collapses PR state + CI rollup + review decision into a
// single signal that drives the worktree icon color. Priority order is encoded
// in githubStatusCategory: a failing/blocking signal wins over a neutral one so
// the dot always shows the most important thing about the PR.
export type GitHubStatusCategory =
  | "none"
  | "draft"
  | "open"
  | "pending"
  | "success"
  | "failure"
  | "awaiting_review"
  | "merged"
  | "closed";

// GitHubColorMode controls when a worktree turns green:
//   "checks"  — green as soon as CI passes (CI-focused). Default.
//   "review"  — green only when the PR is approved; a distinct "awaiting
//               review" color shows while CI is green but review is pending.
export type GitHubColorMode = "checks" | "review";

export const GITHUB_COLOR_MODES: { value: GitHubColorMode; label: string; detail: string }[] = [
  {
    value: "checks",
    label: "When checks pass",
    detail: "Turn green as soon as CI is green.",
  },
  {
    value: "review",
    label: "When approved",
    detail: "Show a distinct color while awaiting review; green only once approved.",
  },
];

export function githubStatusCategory(
  status: GitHubPRStatus | undefined,
  mode: GitHubColorMode = "checks",
): GitHubStatusCategory {
  if (!status || status.state === "none") return "none";
  if (status.state === "merged") return "merged";
  if (status.state === "closed") return "closed";

  // Blocking signals win regardless of mode.
  if (status.checks.status === "failure" || status.reviewDecision === "changes_requested") {
    return "failure";
  }
  if (status.checks.status === "pending") return "pending";
  if (status.state === "draft") return "draft";

  if (mode === "review") {
    if (status.reviewDecision === "approved") return "success";
    // CI is green (or has no checks) but the PR still needs a review.
    return "awaiting_review";
  }

  // "checks" mode: green once nothing is blocking. We get here only when checks
  // are not failing and not pending — that includes "success" AND "none" (a PR
  // with no CI configured is not waiting on anything, so it's green, matching
  // GitHub's mergeable state). The "open" category is kept for completeness but
  // is no longer produced here.
  return "success";
}

// githubDotColorClass returns the Tailwind background class for the status dot.
// Empty string means "render no dot" (no PR for this worktree).
export function githubDotColorClass(category: GitHubStatusCategory): string {
  switch (category) {
    case "failure":
      return "bg-psx-error-foreground";
    case "pending":
      return "bg-psx-warning-foreground";
    case "success":
      return "bg-psx-diff-insert-foreground";
    case "awaiting_review":
      return "bg-psx-info-foreground";
    case "merged":
      return "bg-purple-500";
    case "open":
    case "draft":
    case "closed":
      return "bg-psx-foreground-tertiary";
    case "none":
    default:
      return "";
  }
}

function checksLabel(status: GitHubPRStatus): string {
  switch (status.checks.status) {
    case "success":
      return "checks passing";
    case "failure":
      return "checks failing";
    case "pending":
      return "checks running";
    default:
      return "";
  }
}

function reviewLabel(status: GitHubPRStatus): string {
  switch (status.reviewDecision) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes requested";
    case "review_required":
      return "review required";
    default:
      return "";
  }
}

// githubStatusSummary builds a one-line description for the tooltip / aria label,
// e.g. "PR #123 open · checks passing · approved".
export function githubStatusSummary(status: GitHubPRStatus | undefined): string {
  if (!status || status.state === "none") return "";
  const parts = [`PR #${status.number} ${status.state}`];
  const checks = checksLabel(status);
  if (checks) parts.push(checks);
  const review = reviewLabel(status);
  if (review) parts.push(review);
  return parts.join(" · ");
}

export function githubPRActionLabel(status: GitHubPRStatus | undefined): string {
  return status && status.state !== "none" ? "Open Current Pull Request" : "Open New Pull Request";
}

export function githubChecksCountLabel(status: GitHubPRStatus): string {
  if (status.checks.total === 0) {
    switch (status.checks.status) {
      case "success":
        return "checks passing";
      case "failure":
        return "checks failing";
      case "pending":
        return "checks running";
      default:
        return "No checks";
    }
  }
  const parts = [`${status.checks.passed}/${status.checks.total} checks passing`];
  if (status.checks.failed > 0) {
    parts.push(`${status.checks.failed} failed`);
  }
  if (status.checks.pending > 0) {
    parts.push(`${status.checks.pending} running`);
  }
  return parts.join(" · ");
}

export function githubCommentsCountLabel(status: GitHubPRStatus): string {
  return `${status.commentCount} ${status.commentCount === 1 ? "comment" : "comments"}`;
}

export function githubReviewDecisionLabel(status: GitHubPRStatus): string {
  const review = reviewLabel(status);
  return review || "No review decision";
}
