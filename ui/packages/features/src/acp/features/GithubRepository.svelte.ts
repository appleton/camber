import {
  camberAcpNavGetGithubColorMode,
  camberAcpNavSetGithubColorMode,
  camberGithubAuthStatus,
  camberGithubFetchImage,
  camberGithubLinks,
  camberGithubPrDetail,
  camberGithubPrUrl,
  camberGithubSetToken,
  camberGithubWorktreeStatuses,
  type GitHubAuthStatusOutput,
  type GitHubLinksOutput,
  type GitHubPRDetailOutput,
  type GitHubPRStatus,
  type GitHubPRUrlOutput,
  type GitHubWorktreeStatus,
} from "@camber/helperapi";
import { createContext } from "svelte";
import {
  githubStatusCategory,
  type GitHubColorMode,
  type GitHubStatusCategory,
} from "../github/githubStatus";

// How often we re-poll GitHub for the visible worktrees. The helper caches per
// repo for 30s, so this interval mostly costs a cheap helper round-trip.
const POLL_INTERVAL_MS = 45_000;
const RETRY_INTERVAL_MS = 1_500;
const MAX_RETRY_ATTEMPTS = 3;

function normalizeColorMode(value: string | undefined): GitHubColorMode | undefined {
  return value === "checks" || value === "review" ? value : undefined;
}

export type ACPGithubRepository = ACPGithubRepositoryWriter;

// ACPGithubRepositoryWriter is a thin reactive cache over camber/github/*.
// All GitHub I/O happens in the helper; this just holds the latest per-worktree
// status keyed by path and exposes detail/auth passthroughs for the panel and
// settings UI. The sidebar drives polling via start().
export class ACPGithubRepositoryWriter {
  // Reassigned (not mutated in place) on each refresh so template reads react.
  private statuses = $state(new Map<string, GitHubWorktreeStatus>());
  // Whether any GitHub auth is configured. Starts true so we don't flash a
  // "connect" prompt before the first refresh resolves.
  configured = $state(true);
  // How the worktree dot color is derived; user-configurable in settings and
  // persisted in the acpNav settings DB. Defaults to "checks" until loaded.
  colorMode = $state<GitHubColorMode>("checks");

  // Resolved data URIs for auth-gated GitHub images (keyed by source URL).
  private imageCache = new Map<string, string>();
  private getPaths: () => string[] = () => [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private focusHandler: (() => void) | null = null;
  private inFlight = false;
  private retryEnabled = true;
  private retryAttempts = 0;
  private generation = 0;

  statusFor(path: string): GitHubPRStatus | undefined {
    return this.statuses.get(path)?.status;
  }

  worktreeStatusFor(path: string): GitHubWorktreeStatus | undefined {
    return this.statuses.get(path);
  }

  branchFor(path: string): string {
    return this.statuses.get(path)?.branch ?? "";
  }

  // Whether the path has a GitHub remote (independent of whether a PR exists).
  // The canonical "is GitHub supported here?" check for the UI.
  supportedFor(path: string): boolean {
    return this.statuses.get(path)?.supported ?? false;
  }

  // Whether the path is inside a git work tree at all. Undefined until the
  // first status for the path arrives (or when the helper predates the field),
  // so callers can avoid flashing a disabled state while unknown.
  isRepoFor(path: string): boolean | undefined {
    return this.statuses.get(path)?.isRepo;
  }

  categoryFor(path: string): GitHubStatusCategory {
    return githubStatusCategory(this.statuses.get(path)?.status, this.colorMode);
  }

  setColorMode(mode: GitHubColorMode): void {
    this.colorMode = mode;
    void camberAcpNavSetGithubColorMode({ colorMode: mode }).catch(() => {
      // Best-effort persistence; the in-memory value still applies this session.
    });
  }

  // Loads the persisted color mode from the acpNav settings DB. Called on start.
  private async loadColorMode(): Promise<void> {
    try {
      const result = await camberAcpNavGetGithubColorMode();
      const mode = normalizeColorMode(result.colorMode);
      if (mode) this.colorMode = mode;
    } catch {
      // Keep the default on failure.
    }
  }

  // refresh fetches status for the given paths (or the tracked provider's paths)
  // and prunes any cached entries no longer tracked. Failures are swallowed so a
  // transient network/auth error leaves the last-known status visible.
  //
  // The inFlight guard skips redundant overlapping polls, but `force` bypasses
  // it (e.g. after the token changes) so the refresh is guaranteed to run. A
  // generation counter ensures a slower, superseded in-flight poll never
  // overwrites the result of a newer one.
  async refresh(paths?: string[], { force = false }: { force?: boolean } = {}): Promise<void> {
    const targets = paths ?? this.getPaths();
    if (targets.length === 0) {
      this.clearRetry();
      if (this.statuses.size > 0) this.statuses = new Map();
      return;
    }
    if (this.inFlight && !force) return;
    const generation = ++this.generation;
    this.inFlight = true;
    try {
      const result = await camberGithubWorktreeStatuses({ paths: targets });
      if (generation !== this.generation) return; // superseded by a newer refresh
      const next = new Map<string, GitHubWorktreeStatus>();
      for (const entry of result.statuses) {
        next.set(entry.path, entry);
      }
      this.statuses = next;
      this.configured = result.configured;
      this.clearRetry();
    } catch {
      if (generation === this.generation) {
        // Keep prior statuses and retry soon; the regular poll remains a fallback.
        this.scheduleRetry(paths);
      }
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  private scheduleRetry(paths?: string[]): void {
    if (!this.retryEnabled) return;
    if (this.retryTimer !== null) return;
    if (this.retryAttempts >= MAX_RETRY_ATTEMPTS) return;
    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh(paths);
    }, RETRY_INTERVAL_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempts = 0;
  }

  // start wires the path provider and begins periodic + focus-driven polling.
  // Idempotent: safe to call from onMount across remounts.
  start(getPaths: () => string[]): void {
    this.getPaths = getPaths;
    this.retryEnabled = true;
    void this.loadColorMode();
    void this.refresh();
    if (this.timer === null) {
      this.timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    }
    if (typeof window !== "undefined" && this.focusHandler === null) {
      this.focusHandler = () => void this.refresh();
      window.addEventListener("focus", this.focusHandler);
    }
  }

  stop(): void {
    this.retryEnabled = false;
    this.clearRetry();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.focusHandler !== null && typeof window !== "undefined") {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
  }

  async prDetail(path: string): Promise<GitHubPRDetailOutput> {
    return camberGithubPrDetail({ path });
  }

  // Resolves the URL to open for a worktree: the PR if it exists, otherwise the
  // create-PR page for the current branch. Empty url => no GitHub remote.
  async prUrl(path: string): Promise<GitHubPRUrlOutput> {
    return camberGithubPrUrl({ path });
  }

  // Resolves the full set of GitHub destinations for a path (repo, pulls,
  // issues, current/new PR) for the header dropdown.
  async links(path: string): Promise<GitHubLinksOutput> {
    return camberGithubLinks({ path });
  }

  // Fetches an auth-gated GitHub-hosted image as a data URI (cached), so the
  // webview can display private-repo PR attachment images. Returns "" when the
  // image can't be fetched.
  async fetchImage(url: string): Promise<string> {
    const cached = this.imageCache.get(url);
    if (cached !== undefined) return cached;
    let dataUri = "";
    try {
      const result = await camberGithubFetchImage({ url });
      if (result.ok) dataUri = result.dataUri;
    } catch {
      // leave empty
    }
    this.imageCache.set(url, dataUri);
    return dataUri;
  }

  async authStatus(): Promise<GitHubAuthStatusOutput> {
    return camberGithubAuthStatus();
  }

  // setToken stores (or clears, when empty) the fallback token, then refreshes
  // so the icon colors reflect the new auth immediately.
  async setToken(token: string): Promise<void> {
    await camberGithubSetToken({ token });
    // Force past the inFlight guard so an in-progress poll can't swallow this.
    await this.refresh(undefined, { force: true });
  }

  publicAPI(): ACPGithubRepository {
    return this;
  }
}

const [getACPGithubContext, setACPGithubRepositoryContext] = createContext<ACPGithubRepository>();

export { getACPGithubContext };

export function setACPGithubContext(): ACPGithubRepositoryWriter {
  const repo = new ACPGithubRepositoryWriter();
  setACPGithubRepositoryContext(repo.publicAPI());
  return repo;
}

export function getACPGithubRepo(): ACPGithubRepository {
  return getACPGithubContext();
}
