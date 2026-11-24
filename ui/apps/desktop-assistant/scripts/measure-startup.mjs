// Cold-launch timing harness for the desktop assistant.
//
// Launches a release build N times against an isolated profile (cloned nav DB,
// cloned assistant config, empty models dir, per-run helper log) with the
// launchd-style minimal PATH a real Finder launch gets, and reports per-phase
// timings from the native startup-timing marks (startup_timing.rs, stderr) and
// the webview startup diagnostics (startupDiagnostics.ts, helper log).
//
// Build the binary it measures with:
//   pnpm exec turbo build --filter='@camber/desktop-assistant^...'  # from repo root
//   pnpm tauri build --no-bundle --config scripts/perf-tauri-config.json
// The turbo step is NOT optional: the production build resolves workspace
// packages (@camber/assistant and friends) through their built dist, so
// skipping it silently measures stale package code. When in doubt, grep the
// built main chunk for a string from the change being measured.
// The perf identifier keeps the instance's single-instance socket and config
// dirs away from a concurrently running production app.
//
// Measure on a quiet machine, never in the same command chain as the build —
// post-build load inflates every phase by hundreds of ms.
//
// Usage: node scripts/measure-startup.mjs [--runs N] [--label name] [--binary path]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const runs = Number(opt("runs", "5"));
const label = opt("label", "run");
// labelDir is recursively deleted below; a label like ".." or "../x" would
// resolve outside perfRoot and rm someone's actual data on a typo.
if (!/^[A-Za-z0-9._-]+$/.test(label) || label === "." || label === "..") {
  console.error(`invalid --label ${JSON.stringify(label)}: use letters, digits, ., _, -`);
  process.exit(1);
}
const binary = opt("binary", path.join(appDir, "src-tauri/target/release/camber-desktop"));
const revealTimeoutMs = 90_000;

const perfRoot = "/tmp/camber-perf";
const templateDir = path.join(perfRoot, "template");
const labelDir = path.join(perfRoot, label);

// Events reported relative to harness spawn time, in display order.
const NATIVE_EVENTS = [
  "native.runBegin",
  "native.shellEnvApplied",
  "native.menuBuildBegin",
  "native.menuBuildEnd",
  "native.setupBegin",
  "native.windowCreated",
  "native.helperSpawnBegin",
  "native.appReady",
  "native.helperReady",
  "native.fontCacheWarm",
  "native.openersCacheWarm",
  "native.settingsCmdBegin",
  "native.settingsRead",
  "native.openerResolved",
  "native.settingsCmdEnd",
];
const WEBVIEW_EVENTS = [
  "diag.init",
  "startup.mainLoaded",
  "start.begin",
  "start.desktopSettings",
  "start.settingsLoaded",
  "start.themeApplied",
  "start.accentApplied",
  "start.windowProbed",
  "start.mounting",
  "start.mounted",
  "boot.agentServersLoaded",
  "boot.navListApplied",
  "boot.draftSessionCreated",
  "startup.initialScreenSettled",
  "startup.revealed",
];

prepareTemplate();
fs.rmSync(labelDir, { recursive: true, force: true });
fs.mkdirSync(labelDir, { recursive: true });

const results = [];
for (let i = 1; i <= runs; i++) {
  console.log(`\n=== ${label} run ${i}/${runs} ===`);
  results.push(await measureOnce(path.join(labelDir, `run-${i}`)));
}

report(results);
fs.writeFileSync(
  path.join(labelDir, "results.json"),
  JSON.stringify({ label, binary, runs: results }, null, 2),
);
console.log(`\nresults written to ${path.join(labelDir, "results.json")}`);

// One-time template: an online .backup of the live nav DB (safe against
// concurrent writers, folds the WAL in) plus the real assistant config, so
// runs boot against realistic data volumes without touching live state.
function prepareTemplate() {
  // Owner-only: the template holds a copy of the real nav DB and assistant
  // config, and /tmp is world-readable by default. chmod explicitly, and
  // before the early return — mkdirSync's mode is ignored for directories
  // that already exist (earlier runs, or a pre-created path).
  fs.mkdirSync(perfRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(perfRoot, 0o700);
  fs.mkdirSync(templateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(templateDir, 0o700);
  if (fs.existsSync(path.join(templateDir, "acp-nav.db"))) return;
  const liveDb = path.join(os.homedir(), "Library/Caches/camber/acp-nav-v1.db");
  execFileSync("sqlite3", [liveDb, `.backup ${path.join(templateDir, "acp-nav.db")}`]);
  const liveConfig = path.join(os.homedir(), ".config/camber/assistant.json");
  fs.copyFileSync(liveConfig, path.join(templateDir, "assistant-config.json"));
  console.log(`template prepared at ${templateDir}`);
}

async function measureOnce(runDir) {
  fs.mkdirSync(path.join(runDir, "models"), { recursive: true });
  // APFS clone: instant, and each run gets a private writable DB.
  execFileSync("cp", ["-c", path.join(templateDir, "acp-nav.db"), path.join(runDir, "acp-nav.db")]);
  fs.copyFileSync(
    path.join(templateDir, "assistant-config.json"),
    path.join(runDir, "assistant-config.json"),
  );
  const helperLog = path.join(runDir, "helper.log");
  const nativeLog = path.join(runDir, "native.log");
  fs.writeFileSync(helperLog, "");
  const stderrFd = fs.openSync(nativeLog, "w");

  const t0 = Date.now();
  const child = spawn(binary, [], {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: {
      // Launchd-shaped environment: minimal PATH so the shell-env capture path
      // runs exactly as it does for a real Finder/Dock launch.
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: os.homedir(),
      USER: os.userInfo().username,
      LOGNAME: os.userInfo().username,
      SHELL: process.env.SHELL ?? "/bin/zsh",
      LANG: "en_US.UTF-8",
      CAMBER_STARTUP_TIMING: "1",
      // Per-label, not per-run: the first run captures cold and later runs
      // exercise the cache-hit path, mirroring real consecutive launches.
      CAMBER_SHELL_ENV_CACHE_PATH: path.join(labelDir, "shell-env.json"),
      CAMBER_DESKTOP_HELPER_LOG_FILE: helperLog,
      CAMBER_ACP_NAV_DB_PATH: path.join(runDir, "acp-nav.db"),
      CAMBER_ASSISTANT_CONFIG_PATH: path.join(runDir, "assistant-config.json"),
      CAMBER_LOCAL_INFERENCE_MODELS_DIR: path.join(runDir, "models"),
    },
  });
  child.on("error", (err) => console.error("spawn failed:", err));

  const revealed = await waitFor(helperLog, "startup.revealed", revealTimeoutMs);
  // Let trailing diagnostic IPC flush before tearing the process down.
  await sleep(500);
  killGroup(child.pid);
  fs.closeSync(stderrFd);

  const events = { ...parseNativeLog(nativeLog), ...parseWebviewLog(helperLog) };
  const relative = {};
  for (const name of [...NATIVE_EVENTS, ...WEBVIEW_EVENTS]) {
    if (events[name] !== undefined) relative[name] = events[name] - t0;
  }
  if (!revealed) relative.TIMED_OUT = true;
  for (const [name, ms] of Object.entries(relative)) {
    console.log(`  ${String(ms).padStart(7)}ms  ${name}`);
  }
  return relative;
}

function parseNativeLog(file) {
  const events = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^startup-timing: (\d+) (\S+)$/);
    if (m) events[m[2]] ??= Number(m[1]);
  }
  return events;
}

// webview-diag lines carry the Rust-side write time (UTC) plus the webview's
// own elapsed-ms counter. Anchor the webview clock with the first line
// (write time minus its elapsed ms), then place every event at anchor+elapsed
// so IPC latency does not skew per-event times.
function parseWebviewLog(file) {
  const events = {};
  let anchor;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/webview-diag: (\S+Z) \+\s*(\d+)ms #\d+ ([\w.]+)/);
    if (!m) continue;
    const [, ts, elapsed, name] = m;
    anchor ??= Date.parse(ts) - Number(elapsed);
    events[name] ??= anchor + Number(elapsed);
  }
  return events;
}

async function waitFor(file, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readFileSync(file, "utf8").includes(needle)) return true;
    await sleep(100);
  }
  console.error(`timed out waiting for ${needle}`);
  return false;
}

function killGroup(pid) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch {
      return;
    }
  }
}

function report(all) {
  console.log(`\n=== ${label}: median over ${all.length} runs (ms from spawn) ===`);
  for (const name of [...NATIVE_EVENTS, ...WEBVIEW_EVENTS]) {
    const values = all.map((r) => r[name]).filter((v) => v !== undefined);
    if (!values.length) continue;
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const spread = `${values[0]}–${values[values.length - 1]}`;
    console.log(`  ${String(median).padStart(7)}ms  ${name}  (${spread})`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
