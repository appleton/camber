import type { GitStatusOutput } from "@camber/helperapi";

export const DESKTOP_NEW_TAB_EVENT = "camber:desktop-new-tab";
/**
 * Asks the splits pane to focus (or create) the files sidebar tab so its
 * changes view can take over — dispatched together with
 * `requestDesktopChangesView()` (e.g. by the file tree's "Review Diff..." menu
 * action).
 */
export const DESKTOP_OPEN_CHANGES_EVENT = "camber:desktop-open-changes";
export const DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT = "camber:desktop-open-conversation-search";
export const DESKTOP_OPEN_FILE_TAB_EVENT = "camber:desktop-open-file-tab";
/**
 * Opens the all-files git diff in the main zone's singleton Diff tab.
 * Dispatched by the file tree's changes view; if a Diff tab is already open
 * it is refocused (and scrolled to the requested file) instead of stacking
 * another tab.
 */
export const DESKTOP_OPEN_DIFF_TAB_EVENT = "camber:desktop-open-diff-tab";
/**
 * Asks the files sidebar tab (DesktopFilesTree) to switch to its changes
 * (review) view — dispatched by the conversation footer's "Stage and Commit...".
 * The splits pane focuses/creates the files tab, then the tree flips its
 * viewMode.
 */
export const DESKTOP_OPEN_CHANGES_VIEW_EVENT = "camber:desktop-open-changes-view";

export type DesktopNewTabKind =
  | "terminal"
  | "files"
  | "diff"
  | "review"
  | "trajectory"
  | "github"
  | "changes";

export interface DesktopNewTabActionAvailability {
  disabled?: boolean;
  disabledReason?: string;
}

export type DesktopNewTabAvailability = Partial<
  Record<DesktopNewTabKind, DesktopNewTabActionAvailability>
>;

export interface DesktopNewTabEventDetail {
  kind?: DesktopNewTabKind;
}

export interface DesktopOpenConversationSearchEventDetail {
  initialQuery?: string;
}

export interface DesktopOpenFileTabEventDetail {
  path?: string;
  line?: number;
  column?: number;
}

export interface DesktopOpenDiffTabEventDetail {
  /** Absolute path of the worktree to diff. */
  worktreePath?: string;
  /**
   * Repo-relative path of the file to scroll into view. The Diff tab always
   * shows every changed file; this only targets the initial scroll.
   */
  relativePath?: string;
}

export function gitViewDisabledReason(
  worktreePath: string | undefined,
  status: GitStatusOutput | undefined,
): string | undefined {
  if (!worktreePath) return "No working directory";
  if (!status) return "Checking Git availability";
  if (status.isRepo) return undefined;
  return status.gitMissing ? "Git is not installed" : "Not a git repository";
}
