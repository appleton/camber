import { invoke } from "@tauri-apps/api/core";

// Startup diagnostics for debugging launches that never leave the startup
// frame. Captures webview errors and a periodic snapshot of the initial-screen
// gate, appending everything to the current camber-helper session log (via
// the record_startup_diagnostic command) so one log file tells the whole
// story, interleaved with helper activity.
//
// Capture is scoped to startup: completeStartupDiagnostics() (called once the
// app has revealed) tears down the hooks and probes after a short grace
// period, so steady-state console traffic stays out of the log (only the
// first TEARDOWN_GRACE_MS after reveal can still be captured). Explicit
// logStartupDiagnostic() checkpoints keep working after teardown.
//
// The probe hook is installed as an optional global so shared packages can
// feed it without depending on this module: hosts that don't install the
// global (VS Code, mobile) are unaffected.
//
// Hosts also route assistant-reported errors (DesktopHost.reportError) through
// logStartupDiagnostic() after startup, so those errors land in the same log.

const PROBE_INTERVAL_MS = 1000;
// Log every probe change immediately, with a heartbeat so a wedged-but-stable
// state still shows the log is alive.
const PROBE_HEARTBEAT_TICKS = 30;
// Cap sampling for launches that never reveal; teardown usually stops probes
// long before this.
const PROBE_STOP_AFTER_MS = 5 * 60_000;
// Keep capturing briefly after reveal so late startup fallout is still seen.
const TEARDOWN_GRACE_MS = 15_000;
const MAX_STRING_LENGTH = 4000;
const MAX_LINE_LENGTH = 6000;

const startedAt = Date.now();
let sequence = 0;
let tornDown = false;
let teardownScheduled = false;
const teardowns: (() => void)[] = [];

export function logStartupDiagnostic(event: string, data?: unknown): void {
  logStartupDiagnosticJson(event, data === undefined ? undefined : safeStringify(data));
}

function logStartupDiagnosticJson(event: string, json: string | undefined): void {
  const elapsed = Date.now() - startedAt;
  let line = `+${String(elapsed).padStart(6, " ")}ms #${sequence++} ${event}`;
  if (json !== undefined) {
    line += ` ${json}`;
  }
  if (line.length > MAX_LINE_LENGTH) {
    line = `${line.slice(0, MAX_LINE_LENGTH)}…(truncated)`;
  }
  void invoke("record_startup_diagnostic", { message: line }).catch(() => {
    // Diagnostics must never break startup; drop the line if the host call fails.
  });
}

export function initStartupDiagnostics(): void {
  logStartupDiagnostic("diag.init", {
    href: location.href,
    visibility: document.visibilityState,
    userAgent: navigator.userAgent,
    // Decomposes the window-created -> first-JS gap: how long the document
    // request, parse, and render-blocking CSS took before this module ran.
    pageTiming: pageLoadTiming(),
  });

  const onError = (event: ErrorEvent) => {
    logStartupDiagnostic("window.error", {
      message: event.message,
      source: `${event.filename}:${event.lineno}:${event.colno}`,
      error: errorInfo(event.error),
    });
  };
  window.addEventListener("error", onError);
  teardowns.push(() => window.removeEventListener("error", onError));

  const onRejection = (event: PromiseRejectionEvent) => {
    logStartupDiagnostic("window.unhandledrejection", { reason: errorInfo(event.reason) });
  };
  window.addEventListener("unhandledrejection", onRejection);
  teardowns.push(() => window.removeEventListener("unhandledrejection", onRejection));

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logStartupDiagnostic("console.error", args.map(errorInfo));
    originalError(...args);
  };
  teardowns.push(() => {
    console.error = originalError;
  });
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    logStartupDiagnostic("console.warn", args.map(errorInfo));
    originalWarn(...args);
  };
  teardowns.push(() => {
    console.warn = originalWarn;
  });

  const onVisibilityChange = () => {
    logStartupDiagnostic("document.visibilitychange", { visibility: document.visibilityState });
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  teardowns.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

  const globals = globalThis as StartupDiagnosticsGlobals;
  globals.__camberStartupDiag = logStartupDiagnostic;
  globals.__camberRegisterStartupProbe = registerStartupProbe;
}

// Called once the app has revealed: startup capture has served its purpose, so
// unhook everything after a short grace period. Idempotent.
export function completeStartupDiagnostics(): void {
  if (teardownScheduled) return;
  teardownScheduled = true;
  setTimeout(() => {
    tornDown = true;
    logStartupDiagnostic("diag.teardown");
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  }, TEARDOWN_GRACE_MS);
}

interface StartupDiagnosticsGlobals {
  __camberStartupDiag?: (event: string, data?: unknown) => void;
  __camberRegisterStartupProbe?: (name: string, probe: () => unknown) => void;
}

// Samples `probe` once per second, logging on change (heartbeat otherwise),
// until teardown or PROBE_STOP_AFTER_MS. A probe that throws is itself
// diagnostic signal (e.g. a broken reactive graph), so the error is logged and
// sampling continues.
function registerStartupProbe(name: string, probe: () => unknown): void {
  if (tornDown) return;
  logStartupDiagnostic("probe.registered", { name });
  let lastLoggedJson = "";
  let ticksSinceLogged = 0;

  const sample = () => {
    let json: string;
    try {
      json = safeStringify(probe());
    } catch (error) {
      json = safeStringify({ probeThrew: errorInfo(error) });
    }
    ticksSinceLogged += 1;
    if (json === lastLoggedJson && ticksSinceLogged < PROBE_HEARTBEAT_TICKS) return;
    lastLoggedJson = json;
    ticksSinceLogged = 0;
    logStartupDiagnosticJson(`probe.${name}`, json);
  };

  sample();
  const timer = setInterval(() => {
    if (tornDown || Date.now() - startedAt > PROBE_STOP_AFTER_MS) {
      clearInterval(timer);
      logStartupDiagnostic("probe.stopped", { name });
      return;
    }
    sample();
  }, PROBE_INTERVAL_MS);
  teardowns.push(() => clearInterval(timer));
}

// Millisecond offsets from the navigation start of the boot document. All of
// this precedes module evaluation, so it can only be reported after the fact.
function pageLoadTiming(): Record<string, number> | undefined {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!nav) return undefined;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    fetchStart: round(nav.fetchStart),
    responseEnd: round(nav.responseEnd),
    domInteractive: round(nav.domInteractive),
    moduleEvaluated: round(performance.now()),
  };
}

function errorInfo(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncate(value.stack ?? "", MAX_STRING_LENGTH),
    };
  }
  return value;
}

function safeStringify(value: unknown): string {
  // Ancestor stack rather than a visited set, so shared (diamond) references
  // serialize normally and only true cycles report as circular.
  const ancestors: object[] = [];
  try {
    return (
      JSON.stringify(value, function (this: unknown, _key, entry: unknown) {
        if (entry instanceof Error) return errorInfo(entry);
        if (typeof entry === "function") return `[function ${entry.name || "anonymous"}]`;
        if (typeof entry === "bigint") return entry.toString();
        if (typeof entry === "string") return truncate(entry, MAX_STRING_LENGTH);
        if (typeof entry === "object" && entry !== null) {
          while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(entry)) return "[circular]";
          ancestors.push(entry);
        }
        return entry;
      }) ?? "undefined"
    );
  } catch (error) {
    return `[unstringifiable: ${String(error)}]`;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}
