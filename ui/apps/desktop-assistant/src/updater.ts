import { relaunch } from "@tauri-apps/plugin-process";
import { get, writable } from "svelte/store";

import {
  checkAndStageDesktopUpdate,
  desktopBundleReplaced,
  installStagedDesktopUpdate,
  type DesktopUpdateInfo,
} from "./rpc/host";

// The Rust command owns channel selection, update comparison, signature
// verification, and the download. A single invocation checks once and downloads
// that exact Update value, so a feed or preference change cannot turn a
// confirmed version into a different installed version.
//
// Downloads are staged, never installed in the background: installing replaces
// the running .app in place, and a process running from an unlinked bundle is
// killed by the next native file panel it opens (see bundle_guard.rs). The
// install happens under the Update button, immediately before the relaunch.

const STARTUP_DELAY_MS = 10_000;
const PERIODIC_INTERVAL_MS = 24 * 60 * 60_000;

interface UpdaterHost {
  showInfoMessage(message: string): void;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; progress?: number }
  | { kind: "downloaded"; version: string; notes?: string; waitingForIdle?: boolean }
  // Something outside our updater swapped the bundle on disk. There is nothing
  // to install — only this process is stale — so applying just relaunches.
  | { kind: "replaced" }
  | { kind: "error"; message: string };

/**
 * Trim feed release notes down to what users should see: the workflow appends
 * a `Release source: <tag>@<sha>` provenance trailer to the CrabNebula notes
 * for resume validation, which is meaningless in the What's new popover.
 */
export function userFacingUpdateNotes(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  const stripped = notes
    .split("\n")
    .filter((line) => !line.trim().startsWith("Release source: "))
    .join("\n")
    .trim();
  return stripped || undefined;
}

export const updaterStatus = writable<UpdaterStatus>({ kind: "idle" });

/** Statuses that only a restart can clear. */
function awaitingRestart(status: UpdaterStatus): boolean {
  return status.kind === "downloaded" || status.kind === "replaced";
}

let inFlightStage: Promise<DesktopUpdateInfo | null> | null = null;

function checkAndStage(): Promise<DesktopUpdateInfo | null> {
  if (inFlightStage) return inFlightStage;
  inFlightStage = checkAndStageDesktopUpdate().finally(() => {
    inFlightStage = null;
  });
  return inFlightStage;
}

async function stageAvailableUpdate(silent: boolean): Promise<DesktopUpdateInfo | null> {
  if (awaitingRestart(get(updaterStatus))) return null;
  updaterStatus.set({ kind: "checking" });
  try {
    const update = await checkAndStage();
    if (update) {
      updaterStatus.set({
        kind: "downloaded",
        version: update.version,
        notes: userFacingUpdateNotes(update.notes),
      });
    } else {
      updaterStatus.update((status) => (awaitingRestart(status) ? status : { kind: "idle" }));
    }
    return update;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updaterStatus.update((status) => {
      if (awaitingRestart(status)) return status;
      return silent ? { kind: "idle" } : { kind: "error", message };
    });
    if (silent) console.debug("update check/download failed", error);
    throw error;
  }
}

/**
 * Install the staged download and restart into it.
 *
 * Installing unlinks the running bundle, so it happens here — at the point of
 * restart — rather than in the background. `installStagedDesktopUpdate` does not
 * return on success; the process restarts. When the bundle was replaced by
 * something else there is nothing to install and we only relaunch.
 */
export async function applyDownloadedUpdate(): Promise<void> {
  // Nothing is ever staged in dev (the Rust command no-ops on unstamped local
  // builds), so the mocked pill below just restarts, as it always has.
  if (get(updaterStatus).kind === "replaced" || import.meta.env.DEV) {
    await relaunch();
    return;
  }
  await installStagedDesktopUpdate();
}

/**
 * Notice a bundle swap performed by anything other than our own updater — a DMG
 * dragged over the top, a CI copy, a second instance. Only a restart fixes it,
 * so surface the same Update affordance.
 */
export async function refreshBundleReplacedStatus(): Promise<boolean> {
  let replaced = false;
  try {
    replaced = await desktopBundleReplaced();
  } catch (error) {
    console.debug("bundle replacement check failed", error);
    return false;
  }
  if (replaced) {
    updaterStatus.update((status) =>
      status.kind === "downloaded" ? status : { kind: "replaced" },
    );
  }
  return replaced;
}

/**
 * Silently check and download on startup and daily, and notice a
 * bundle replaced out from under us on the same cadence. Concurrent manual and
 * scheduled checks join the same promise.
 */
export function startAutoUpdateLoop(): void {
  if (import.meta.env.DEV) return;
  const run = async () => {
    if (awaitingRestart(get(updaterStatus))) return;
    // A stale process cannot usefully install anything, so this comes first.
    if (await refreshBundleReplacedStatus()) return;
    await stageAvailableUpdate(true).catch(() => {
      // A later interval retries transient failures.
    });
  };
  setTimeout(() => void run(), STARTUP_DELAY_MS);
  setInterval(() => void run(), PERIODIC_INTERVAL_MS);
}

/** Manual macOS menu entry point with user-facing status. */
export async function runManualUpdateCheck(host: UpdaterHost): Promise<void> {
  if (import.meta.env.DEV) {
    host.showInfoMessage("Updates are disabled in development builds.");
    return;
  }
  const current = get(updaterStatus);
  if (awaitingRestart(current)) {
    // The sidebar Update button already shows the pending restart.
    return;
  }
  if (await refreshBundleReplacedStatus()) {
    host.showInfoMessage("Camber has already been updated on disk — restart to finish updating.");
    return;
  }
  if (inFlightStage) {
    host.showInfoMessage("An update check is already in progress…");
    return;
  }

  host.showInfoMessage("Checking for updates…");
  try {
    const update = await stageAvailableUpdate(false);
    if (!update) {
      host.showInfoMessage("You're on the latest version.");
      return;
    }
    host.showInfoMessage(`Update ${update.version} is ready — use the Update button to restart.`);
  } catch (error) {
    console.debug("update check failed", error);
    host.showInfoMessage("Couldn't check for updates — please try again later.");
  }
}
