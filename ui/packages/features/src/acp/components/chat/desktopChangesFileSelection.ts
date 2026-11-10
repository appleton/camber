/**
 * Bridge for preselecting a file in the git Changes panel from elsewhere in
 * the app (e.g. the file tree's "Review Diff..." context menu action).
 *
 * The Changes tab may not be mounted yet when the request is made (opening it
 * is asynchronous), so the request is kept in a module-level pending slot with
 * take semantics in addition to being broadcast as a window event for
 * already-mounted panels.
 */

export const DESKTOP_CHANGES_SELECT_FILE_EVENT = "camber:desktop-changes-select-file";

export interface DesktopChangesSelectFileEventDetail {
  /** Repo-relative path of the file to select, using forward slashes. */
  relativePath: string;
}

let pendingRelativePath: string | undefined;
let pendingSince = 0;

/**
 * A pending selection is only honored briefly — if the target never mounts
 * (e.g. the user closed the sidebar mid-open), a list mounted minutes later
 * must not select a long-forgotten file.
 */
const PENDING_TTL_MS = 15_000;

/**
 * Requests that the Changes panel select the given repo-relative file. Safe to
 * call before the panel exists; combine with `requestDesktopChangesView()` to
 * switch the sidebar into the changes view.
 */
export function requestDesktopChangesFileSelection(relativePath: string): void {
  pendingRelativePath = relativePath;
  pendingSince = Date.now();
  window.dispatchEvent(
    new CustomEvent<DesktopChangesSelectFileEventDetail>(DESKTOP_CHANGES_SELECT_FILE_EVENT, {
      detail: { relativePath },
    }),
  );
}

/** Consumes the pending selection, if any (single-take). */
export function takePendingDesktopChangesFileSelection(): string | undefined {
  const value = pendingRelativePath;
  pendingRelativePath = undefined;
  if (value === undefined || Date.now() - pendingSince > PENDING_TTL_MS) return undefined;
  return value;
}
