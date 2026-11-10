import { invoke } from "@tauri-apps/api/core";
import { mount, unmount } from "svelte";
import "./app.css";
import DesktopStartupFrame, { type StartupIssue } from "./DesktopStartupFrame.svelte";
import {
  completeStartupDiagnostics,
  initStartupDiagnostics,
  logStartupDiagnostic,
} from "./startupDiagnostics";

const STARTUP_TRANSITION_MS = 240;
// Long enough that a slow-but-healthy first launch (helper spawn, agent
// version check) rarely trips it; tripping only shows the issue panel while
// startup keeps going underneath.
const STARTUP_WATCHDOG_MS = 25_000;
// Shorter fuse once an uncaught exception has fired before reveal: a crash
// inside Svelte's flush can leave the reactive graph permanently wedged (data
// keeps loading, timers keep running, but the settle effect never fires), so
// don't sit out the full window. Still long enough for a slow-but-healthy
// startup that logged an incidental error to settle without seeing the panel.
const CRASHED_WATCHDOG_MS = 10_000;
const DIAGNOSTIC_REPORT_LOG_LINES = 2000;
// Silent reload-and-retry backoff for startup failures, one entry per attempt.
// The counter lives in sessionStorage: it survives the reloads but resets on a
// real app relaunch, and a successful reveal clears it.
const AUTO_RETRY_DELAYS_MS = [1000, 3000];
const AUTO_RETRY_COUNT_KEY = "camber.startup.autoRetryCount";

// Dev-only simulation of the startup failure modes so the issue panel and
// retry flows can be exercised without breaking real startup: set
// localStorage["camber.debug.simulateStartupIssue"] to "stall" (settle never
// fires, so the watchdog panel appears), "fail" (start() rejects on every
// attempt, exhausting auto-retry into the failed panel), or "fail-once" (only
// the first attempt rejects, demonstrating silent auto-retry recovery) and
// reload. Dead code in production builds.
const simulatedStartupIssue = import.meta.env.DEV
  ? window.localStorage.getItem("camber.debug.simulateStartupIssue")
  : null;

initStartupDiagnostics();
seedStartupTheme();

const resumedAttempt = readAutoRetryCount();
if (resumedAttempt > 0) {
  logStartupDiagnostic("startup.autoRetryAttempt", { attempt: resumedAttempt });
}

const startupTarget = document.getElementById("desktop-startup-logo");
if (!startupTarget) {
  throw new Error("Desktop startup logo target not found");
}

// The watchdog and issue panel deliberately live outside the app's reactive
// graph (plain timers, separately mounted frame) so they still work when
// startup dies inside it.
let revealed = false;
let watchdog: number | undefined;
// When the armed watchdog fires, as an epoch ms timestamp; only meaningful
// while `watchdog` is set.
let watchdogDeadline = 0;
// Tracks whether the user is currently looking at the issue panel, so a later
// failure never silently reloads the page out from under them (e.g. mid-copy
// of the diagnostic report).
let issueShowing = false;
// First uncaught pre-reveal exception; shown on the issue panel so a wedged
// startup names its cause instead of reading as a generic stall.
let startupCrashMessage: string | undefined;

const startupFrame = mount(DesktopStartupFrame, {
  target: startupTarget,
  props: {
    onCopyReport: copyDiagnosticReport,
    onShowLogs: showHelperLogs,
    onKeepWaiting: () => {
      logStartupDiagnostic("startup.keepWaiting");
      issueShowing = false;
      armWatchdog();
    },
    onContinueAnyway: () => {
      logStartupDiagnostic("startup.continueAnyway");
      void revealApp();
    },
    onRetry: () => {
      logStartupDiagnostic("startup.retry");
      // Reload the whole webview for a fresh startup attempt. The brief delay
      // lets the diagnostic line's IPC flush before navigation tears it down.
      window.setTimeout(() => window.location.reload(), 150);
    },
  },
});
armWatchdog();
window.addEventListener("error", onUncaughtStartupError);

void import("./main")
  .then(
    ({ start }) =>
      new Promise<void>((resolve, reject) => {
        if (
          simulatedStartupIssue === "fail" ||
          (simulatedStartupIssue === "fail-once" && readAutoRetryCount() === 0)
        ) {
          throw new Error(`Simulated startup failure (${simulatedStartupIssue})`);
        }
        logStartupDiagnostic("startup.mainLoaded");
        void start({
          onShellInteractive: () => {
            logStartupDiagnostic("startup.shellInteractive");
            if (simulatedStartupIssue === "stall") return;
            resolve();
          },
          onInitialScreenSettled: () => logStartupDiagnostic("startup.initialScreenSettled"),
        }).catch((error: unknown) => {
          // "stall" simulates a hang: swallow completion and failure alike so
          // the watchdog is what ends the wait.
          if (simulatedStartupIssue === "stall") return;
          reject(error);
        });
      }),
  )
  .then(revealApp)
  .then(() => logStartupDiagnostic("startup.revealed"))
  .catch((error) => {
    logStartupDiagnostic("startup.failed", { error });
    console.error("Unable to start Camber", error);
    if (revealed) return;
    clearWatchdog();
    // Startup failures are often transient (helper still spawning, an IPC
    // hiccup), so retry silently by reloading before involving the user. No
    // error classification: the spinner stays up during retries, so a
    // deterministic failure just reaches the panel a few seconds later. Once
    // the panel is up the user is engaged, so surface the failure instead.
    const attempt = readAutoRetryCount();
    const delayMs = AUTO_RETRY_DELAYS_MS[attempt];
    if (!issueShowing && delayMs !== undefined) {
      if (writeAutoRetryCount(attempt + 1)) {
        logStartupDiagnostic("startup.autoRetry", { attempt: attempt + 1, delayMs });
        window.setTimeout(() => window.location.reload(), delayMs);
        return;
      }
      logStartupDiagnostic("startup.autoRetrySkipped", { reason: "sessionStorage unavailable" });
    }
    showIssue({
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });

async function revealApp(): Promise<void> {
  if (revealed) return;
  revealed = true;
  clearWatchdog();
  window.removeEventListener("error", onUncaughtStartupError);

  // Give Svelte and the browser a full paint with the loaded app held at opacity
  // zero, then reveal the complete shell on the next frame.
  await nextAnimationFrame();
  await nextAnimationFrame();

  document.body.classList.add("desktop-app-ready");
  document.body.classList.remove("desktop-app-starting");

  window.setTimeout(() => {
    void unmount(startupFrame);
    document.getElementById("desktop-startup-frame")?.remove();
    document.body.classList.remove("desktop-app-ready");
  }, STARTUP_TRANSITION_MS);

  clearAutoRetryCount();
  completeStartupDiagnostics();
}

function readAutoRetryCount(): number {
  try {
    return Number(window.sessionStorage.getItem(AUTO_RETRY_COUNT_KEY)) || 0;
  } catch {
    return 0;
  }
}

// Returns whether the write stuck. When it did not (sessionStorage unusable),
// the caller must not schedule a silent reload: a counter that cannot advance
// would retry forever, so the failure goes straight to the issue panel.
function writeAutoRetryCount(count: number): boolean {
  try {
    window.sessionStorage.setItem(AUTO_RETRY_COUNT_KEY, String(count));
    return window.sessionStorage.getItem(AUTO_RETRY_COUNT_KEY) === String(count);
  } catch {
    return false;
  }
}

function clearAutoRetryCount(): void {
  try {
    window.sessionStorage.removeItem(AUTO_RETRY_COUNT_KEY);
  } catch {
    // Best effort; a stale counter only skips future silent retries.
  }
}

// Startup diagnostics already logs every window.error; this listener's job is
// deciding whether one should cut the watchdog short. Only the first error
// arms the short fuse — later ones are usually fallout from the same crash.
// Deliberately not listening for unhandledrejection: a crash that wedges
// Svelte's flush surfaces as an uncaught exception (the flush runs in a
// microtask, not a promise chain), while stray rejections are common enough
// during a healthy startup that they shouldn't shorten the window.
function onUncaughtStartupError(event: ErrorEvent): void {
  if (revealed || issueShowing || startupCrashMessage !== undefined) return;
  startupCrashMessage = event.message || "Unknown error";
  // A crash may only shorten the wait, never extend it: clamp the fuse to
  // whatever remains of the already-armed window.
  const remaining = watchdog === undefined ? CRASHED_WATCHDOG_MS : watchdogDeadline - Date.now();
  const fuseMs = Math.max(0, Math.min(CRASHED_WATCHDOG_MS, remaining));
  logStartupDiagnostic("startup.crashWatchdogArmed", { message: startupCrashMessage, fuseMs });
  armWatchdog(fuseMs);
}

function armWatchdog(delayMs: number = STARTUP_WATCHDOG_MS): void {
  clearWatchdog();
  watchdogDeadline = Date.now() + delayMs;
  watchdog = window.setTimeout(() => {
    if (revealed) return;
    logStartupDiagnostic(
      "startup.watchdogTripped",
      startupCrashMessage === undefined ? undefined : { crashMessage: startupCrashMessage },
    );
    // "Continue anyway" only helps once the app has mounted into #app; before
    // that, force-revealing would leave an empty window with no way back.
    showIssue({ kind: "slow", message: startupCrashMessage, canContinue: appHasMounted() });
  }, delayMs);
}

function showIssue(issue: StartupIssue): void {
  issueShowing = true;
  startupFrame.showIssue(issue);
}

function appHasMounted(): boolean {
  return (document.getElementById("app")?.childElementCount ?? 0) > 0;
}

function clearWatchdog(): void {
  if (watchdog === undefined) return;
  window.clearTimeout(watchdog);
  watchdog = undefined;
}

// The report is the current helper session log tail, which includes the
// webview-diag startup diagnostics — one paste tells support the whole story.
async function copyDiagnosticReport(): Promise<void> {
  logStartupDiagnostic("startup.copyDiagnosticReport");
  const report = await invoke<string>("helper_logs", { lines: DIAGNOSTIC_REPORT_LOG_LINES });
  await invoke("write_text_to_pasteboard", { text: report });
}

function showHelperLogs(): void {
  logStartupDiagnostic("startup.showLogs");
  void invoke("show_helper_logs").catch((error) => {
    console.error("failed to open helper logs", error);
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function seedStartupTheme(): void {
  const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.classList.add(`vscode-${theme}`);
  document.body.classList.add(`vscode-${theme}`);
  document.documentElement.style.colorScheme = theme;
  document.body.style.colorScheme = theme;
}
