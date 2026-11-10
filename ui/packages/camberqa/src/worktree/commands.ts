import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { manageStopWithOptions } from "../manage/client.js";
import { isProcessAlive, listStates, logPath, readState } from "../manage/state.js";
import { camberqaDataDirs } from "../targets/vscode.js";
import { portsForSlot, targetCamberQAPort } from "./shared.js";
import {
  claimOrReuseSlot,
  detectGitWorktreeInfo,
  detectWorktree,
  findSlotForWorktreeId,
  findWorktreeEnv,
  findWorktreeRoot,
  listSlots,
  releaseSlot,
  slotOwnerId,
  updateSlotOwner,
  type WorktreeEnv,
} from "./slot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PACKAGE_DIR, "src/cli.ts");

function resolveTsx(cwd: string): string {
  // Prefer the caller workspace's install; package-local node_modules may be absent or stale.
  const pnpmTsx = path.join(cwd, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  if (fs.existsSync(pnpmTsx)) return pnpmTsx;

  // Try camberqa's own node_modules first
  const localTsx = path.join(PACKAGE_DIR, "node_modules", ".bin", "tsx");
  if (fs.existsSync(localTsx)) return localTsx;

  // Last resort: assume tsx is on PATH
  return "tsx";
}

export type AgentModeOverride = "acp" | "classic";

export interface WorktreeUpOptions {
  fast: boolean;
  agentMode?: AgentModeOverride;
  color?: string;
  worktreeName?: string;
}

function parseAgentModeOverride(args: string[]): AgentModeOverride | undefined {
  const acp = args.includes("--acp");
  const lsp = args.includes("--lsp");
  if (acp && lsp) {
    throw new Error("Use either --acp or --lsp, not both.");
  }
  if (acp) return "acp";
  if (lsp) return "classic";
  return undefined;
}

function startManagedProcess(
  name: string,
  command: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  const worktreeRoot = env.CAMBERQA_CALLER_CWD || process.env.CAMBERQA_CALLER_CWD || cwd;
  const tsx = resolveTsx(worktreeRoot);
  const child = spawn(tsx, [CLI_PATH, "manage", "run", "--name", name, "--cwd", cwd, ...command], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const TARGET_SERVICE_PATTERNS: Record<"vscode" | "desktop", RegExp[]> = {
  vscode: [/^vite-s\d+$/, /^camberqa-s\d+$/],
  desktop: [/^desktop-vite-s\d+$/, /^desktop-s\d+$/, /^mobile-vite-s\d+$/],
};

export function servicePatternsForTargets(targets: Array<"vscode" | "desktop">): RegExp[] {
  return targets.flatMap((target) => TARGET_SERVICE_PATTERNS[target]);
}

export function isPathInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isManagedAlive(name: string): boolean {
  const state = readState(name);
  return state !== null && isProcessAlive(state.pid);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function ensurePortFree(port: number, label: string): Promise<void> {
  const free = await isPortFree(port);
  if (!free) {
    console.error(
      `[worktree] Port ${port} (${label}) is already in use, but no managed process is tracked for it.\n` +
        `[worktree] This is likely a leftover from a previous worktree. Inspect with 'camberqa manage list' or 'lsof -i :${port}', stop it ('camberqa manage stop <id>'), then retry.`,
    );
    process.exit(1);
  }
}

function ensureVscodeDependenciesBuilt(worktreeRoot: string): void {
  const extensionDist = path.join(worktreeRoot, "ui/apps/vscode-assistant/dist");
  const viteConfigDist = path.join(worktreeRoot, "ui/config/vite/dist/index.js");
  const svelteConfigDist = path.join(worktreeRoot, "ui/config/svelte/dist/index.js");
  if (
    fs.existsSync(extensionDist) &&
    fs.existsSync(viteConfigDist) &&
    fs.existsSync(svelteConfigDist)
  ) {
    return;
  }

  console.log(
    "[worktree] VS Code assistant not built — running pnpm turbo build -F camber-assistant (first run takes a few minutes)...",
  );
  execFileSync("pnpm", ["turbo", "build", "-F", "camber-assistant"], {
    cwd: worktreeRoot,
    stdio: "inherit",
  });
  console.log("[worktree] VS Code assistant built successfully.");
}

function ensureDesktopDependenciesBuilt(worktreeRoot: string): void {
  const viteConfigDist = path.join(worktreeRoot, "ui/config/vite/dist/index.js");
  const svelteConfigDist = path.join(worktreeRoot, "ui/config/svelte/dist/index.js");
  if (fs.existsSync(viteConfigDist) && fs.existsSync(svelteConfigDist)) {
    return;
  }

  console.log(
    "[worktree] Desktop dependencies not built — running pnpm turbo build -F @camber/desktop-assistant^...",
  );
  execFileSync("pnpm", ["turbo", "build", "-F", "@camber/desktop-assistant^..."], {
    cwd: worktreeRoot,
    stdio: "inherit",
  });
  console.log("[worktree] Desktop dependencies built successfully.");
}

async function waitForProcess(
  name: string,
  opts?: { timeoutMs?: number; healthUrl?: string; stableMs?: number },
): Promise<void> {
  const timeout = opts?.timeoutMs ?? 5000;
  const interval = 300;
  const deadline = Date.now() + timeout;

  // Wait for the managed process state file to appear and verify it's alive
  while (Date.now() < deadline) {
    const state = readState(name);
    if (state) {
      if (!isProcessAlive(state.pid)) {
        const logFile = logPath(name);
        let output = "";
        try {
          output = fs.readFileSync(logFile, "utf-8").trimEnd();
        } catch {}
        throw new Error(
          `Process "${name}" exited immediately after starting.` +
            (output ? `\n\nProcess output:\n${output}` : `\nCheck logs: ${logFile}`),
        );
      }
      // Process is alive — if we have a health URL, try hitting it
      if (opts?.healthUrl) {
        let resp: Response;
        try {
          resp = await fetch(opts.healthUrl);
        } catch {
          // Server not ready yet, keep waiting
          await new Promise((r) => setTimeout(r, interval));
          continue;
        }
        if (resp.ok) {
          if (opts.stableMs) {
            await new Promise((r) => setTimeout(r, opts.stableMs));
            const nextState = readState(name);
            if (!nextState || !isProcessAlive(nextState.pid)) {
              const logFile = logPath(name);
              let output = "";
              try {
                output = fs.readFileSync(logFile, "utf-8").trimEnd();
              } catch {}
              throw new Error(
                `Process "${name}" exited after health check passed.` +
                  (output ? `\n\nProcess output:\n${output}` : `\nCheck logs: ${logFile}`),
              );
            }
            const stableResp = await fetch(opts.healthUrl);
            if (!stableResp.ok) {
              continue;
            }
          }
          return;
        }
      } else {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  // Timed out — check one last time
  const state = readState(name);
  if (!state) {
    const logFile = logPath(name);
    throw new Error(
      `Process "${name}" failed to start (no state file after ${timeout}ms).\nCheck logs: ${logFile}`,
    );
  }
  if (!isProcessAlive(state.pid)) {
    const logFile = logPath(name);
    let output = "";
    try {
      output = fs.readFileSync(logFile, "utf-8").trimEnd();
    } catch {}
    throw new Error(
      `Process "${name}" crashed during startup.` +
        (output ? `\n\nProcess output:\n${output}` : `\nCheck logs: ${logFile}`),
    );
  }
  if (opts?.healthUrl) {
    console.warn(`[worktree] Warning: "${name}" is running but health endpoint not yet responding`);
  }
}

function resolveWorktreeId(): string {
  const startDir = process.env.CAMBERQA_CALLER_CWD || process.cwd();
  const gitInfo = detectGitWorktreeInfo(startDir);
  if (gitInfo) return gitInfo.id;

  // Running from main workspace — not a worktree
  return "main";
}

function isMainWorkspace(id: string): boolean {
  return id === "main";
}

function resolveWorktreeRoot(): string {
  const detected = findWorktreeRoot();
  if (detected) return detected;
  if (process.env.CAMBERQA_CALLER_CWD) return process.env.CAMBERQA_CALLER_CWD;

  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function cleanupDesktopOrphans(slot: number): void {
  if (process.platform !== "darwin") return;

  let psOutput: string;
  try {
    psOutput = execFileSync("ps", ["axo", "pid=,pgid=,command="], { encoding: "utf-8" });
  } catch {
    return;
  }

  const matchingGroups = new Set<number>();
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, , pgidRaw, command] = match;
    if (!command.includes("camberqa-tauri-") || !command.includes(".json")) continue;
    const configPath = command.match(/\/[^ ]*camberqa-tauri-[^ ]+\.json/)?.[0];
    if (!configPath) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        productName?: string;
      };
      if (!config.productName?.includes(`s${slot} `)) continue;
      matchingGroups.add(Number.parseInt(pgidRaw, 10));
    } catch {
      // Ignore unreadable config files.
    }
  }

  for (const pgid of matchingGroups) {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
  }
}

export function parseWorktreeUpOptions(args: string[]): WorktreeUpOptions {
  const colorIdx = args.indexOf("--color");
  const worktreeNameIdx = args.indexOf("--worktree-name");
  return {
    fast: args.includes("--fast"),
    agentMode: parseAgentModeOverride(args),
    color: colorIdx >= 0 && colorIdx + 1 < args.length ? args[colorIdx + 1] : undefined,
    worktreeName:
      worktreeNameIdx >= 0 && worktreeNameIdx + 1 < args.length
        ? args[worktreeNameIdx + 1]
        : undefined,
  };
}

async function worktreeUp(args: string[], target: "vscode" | "desktop" = "vscode"): Promise<void> {
  let opts: WorktreeUpOptions;
  try {
    opts = parseWorktreeUpOptions(args);
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    process.exit(1);
  }
  const id = resolveWorktreeId();
  const slot = isMainWorkspace(id) ? 0 : claimOrReuseSlot(id);
  const ports = portsForSlot(slot);
  const worktreeRoot = resolveWorktreeRoot();

  const envData: WorktreeEnv = {
    slot,
    id,
    ports,
    profile: "worktree",
    agentMode: opts.agentMode,
    pid: process.pid,
  };

  fs.writeFileSync(path.join(worktreeRoot, ".worktree-env.json"), JSON.stringify(envData, null, 2));

  console.log(
    isMainWorkspace(id)
      ? `[worktree] Using default ports (main workspace, slot 0)`
      : `[worktree] Claimed slot ${slot} for ${id}`,
  );
  console.log(
    `[worktree] Ports — VS Code Vite: ${ports.vite}, Desktop Vite: ${ports.desktopVite}, Mobile Vite: ${ports.mobileVite}, API: 8889, VS Code CamberQA: ${ports.camberqa}, Desktop CamberQA: ${ports.desktopCamberQA}, Remote: ${ports.remote}`,
  );
  if (opts.agentMode) {
    console.log(`[worktree] Camber agent mode: ${opts.agentMode}`);
  }

  const isMain = isMainWorkspace(id);
  const selectedVitePort = target === "desktop" ? ports.desktopVite : ports.vite;
  const selectedCamberQAPort = targetCamberQAPort(slot, target);
  const env: Record<string, string> = {
    VITE_DEV_PORT: String(selectedVitePort),
    CAMBERQA_PORT: String(selectedCamberQAPort),
    CAMBERQA_PORT_START: String(selectedCamberQAPort),
    CAMBER_WORKTREE_SLOT: String(slot),
    CAMBER_WORKTREE_ID: isMain ? id : (opts.worktreeName ?? id),
  };
  // Clear stale server state and profile dirs, but never while the server for
  // this target is still alive (re-running `up` reuses it).
  const serverName = target === "desktop" ? `desktop-s${slot}` : `camberqa-s${slot}`;
  if (!isManagedAlive(serverName)) {
    try {
      fs.unlinkSync(`/tmp/camberqa-server-${selectedCamberQAPort}.json`);
    } catch {}
    if (target === "vscode") {
      const dataDirs = camberqaDataDirs(PACKAGE_DIR);
      fs.rmSync(dataDirs.userDir, { recursive: true, force: true });
      fs.rmSync(dataDirs.extensionsDir, { recursive: true, force: true });
    }
  }

  if (target === "desktop") {
    await desktopUp(slot, id, worktreeRoot, envData, opts, env);
    return;
  }

  // Build the extension and its workspace dependencies up front: `turbo dev`
  // would build them too, but a cold build takes minutes and would blow the
  // startup health timeout below.
  ensureVscodeDependenciesBuilt(worktreeRoot);

  // Start Vite dev server
  const viteName = `vite-s${slot}`;
  const viteAppDir = path.join(worktreeRoot, "ui/apps/vscode-assistant");
  if (isManagedAlive(viteName)) {
    console.log(`[worktree] ${viteName} already running — reusing it.`);
  } else {
    await ensurePortFree(ports.vite, "VS Code Vite");
    if (opts.fast) {
      const viteBin = path.join(viteAppDir, "node_modules/.bin/vite");
      startManagedProcess(viteName, [viteBin], viteAppDir, env);
    } else {
      startManagedProcess(
        viteName,
        ["pnpm", "turbo", "dev", "-F", "camber-assistant"],
        worktreeRoot,
        env,
      );
    }
    console.log(
      `[worktree] Started ${viteName}${opts.fast ? " (fast: skipping turbo ^build)" : ""}`,
    );
  }

  try {
    await waitForProcess(viteName, {
      timeoutMs: 60_000,
      healthUrl: `http://localhost:${ports.vite}/`,
    });
    const viteState = readState(viteName);
    if (viteState) {
      updateSlotOwner(slot, id, viteState.pid);
      envData.pid = viteState.pid;
      fs.writeFileSync(
        path.join(worktreeRoot, ".worktree-env.json"),
        JSON.stringify(envData, null, 2),
      );
    }
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    // Stop the dev server we just spawned — a cold `turbo dev` keeps building
    // (and eventually binds the port) even after we bail, leaving orphans.
    await manageStopWithOptions(viteName, { tolerateMissing: true, tolerateErrors: true });
    releaseSlot(slot);
    try {
      fs.unlinkSync(path.join(worktreeRoot, ".worktree-env.json"));
    } catch {}
    process.exit(1);
  }

  // Start camberqa server (launches VS Code)
  const camberqaName = `camberqa-s${slot}`;
  const camberqaTsx = resolveTsx(worktreeRoot);
  const camberqaEnv: Record<string, string> = { ...env };
  if (isManagedAlive(camberqaName)) {
    console.log(`[worktree] ${camberqaName} already running — reusing it.`);
  } else {
    await ensurePortFree(ports.camberqa, "VS Code CamberQA");
    startManagedProcess(
      camberqaName,
      [
        camberqaTsx,
        path.join(PACKAGE_DIR, "src/server.ts"),
        "--dev",
        "--use-profile",
        "--auth-clear",
        ...(opts.agentMode ? ["--agent-mode", opts.agentMode] : []),
      ],
      worktreeRoot,
      camberqaEnv,
    );
    console.log(`[worktree] Started ${camberqaName}`);
  }

  try {
    await waitForProcess(camberqaName, {
      timeoutMs: 15000,
      healthUrl: `http://localhost:${ports.camberqa}/health`,
      stableMs: 2000,
    });
    const camberqaState = readState(camberqaName);
    if (camberqaState) {
      updateSlotOwner(slot, id, camberqaState.pid);
      envData.pid = camberqaState.pid;
      fs.writeFileSync(
        path.join(worktreeRoot, ".worktree-env.json"),
        JSON.stringify(envData, null, 2),
      );
    }
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    // Stop everything we started before bailing
    await manageStopWithOptions(camberqaName, { tolerateMissing: true, tolerateErrors: true });
    await manageStopWithOptions(viteName, { tolerateMissing: true, tolerateErrors: true });
    releaseSlot(slot);
    try {
      fs.unlinkSync(path.join(worktreeRoot, ".worktree-env.json"));
    } catch {}
    process.exit(1);
  }

  console.log(`[worktree] Services started`);
}

async function desktopUp(
  slot: number,
  id: string,
  worktreeRoot: string,
  envData: WorktreeEnv,
  opts: WorktreeUpOptions,
  env: Record<string, string>,
): Promise<void> {
  const ports = portsForSlot(slot);
  const desktopViteName = `desktop-vite-s${slot}`;
  const desktopName = `desktop-s${slot}`;
  const camberqaTsx = resolveTsx(worktreeRoot);
  cleanupDesktopOrphans(slot);

  // Pin the per-slot remote-access env explicitly: shells spawned by another
  // instance's helper leak that instance's CAMBER_REMOTE_* values (e.g. the
  // main desktop's dev-server URL on 5179), and helper.rs treats a pre-set
  // value as a deliberate override — so without the pin, this desktop's
  // helper would proxy the mobile UI to the wrong slot's vite.
  env.CAMBER_REMOTE_PORT = String(ports.remote);
  env.CAMBER_REMOTE_DEV_SERVER = `http://127.0.0.1:${ports.mobileVite}`;
  env.CAMBER_REMOTE_STATIC = path.join(worktreeRoot, "ui/apps/mobile-remote/dist");
  if (opts.color) {
    env.CAMBERQA_DESKTOP_COLOR = opts.color;
    env.VITE_CAMBERQA_COLOR = opts.color;
  }
  if (opts.worktreeName) {
    env.VITE_CAMBERQA_WORKTREE_NAME = opts.worktreeName;
  }

  const desktopAppDir = path.join(worktreeRoot, "ui/apps/desktop-assistant");
  ensureDesktopDependenciesBuilt(worktreeRoot);
  if (isManagedAlive(desktopViteName)) {
    console.log(`[worktree] ${desktopViteName} already running — reusing it.`);
  } else {
    await ensurePortFree(ports.desktopVite, "Desktop Vite");
    startManagedProcess(desktopViteName, ["pnpm", "dev:web"], desktopAppDir, env);
    console.log(`[worktree] Started ${desktopViteName}`);
  }

  try {
    await waitForProcess(desktopViteName, {
      timeoutMs: 60_000,
      healthUrl: `http://localhost:${ports.desktopVite}/`,
    });
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    await manageStopWithOptions(desktopViteName, { tolerateMissing: true, tolerateErrors: true });
    releaseSlot(slot);
    try {
      fs.unlinkSync(path.join(worktreeRoot, ".worktree-env.json"));
    } catch {}
    process.exit(1);
  }

  // Mobile-remote dev server: the desktop helper proxies remote-access UI
  // traffic to it (see remoteaccess/server.go devServerHandler) and falls
  // back to the built bundle when it is not running, so this is best-effort.
  const mobileViteName = `mobile-vite-s${slot}`;
  if (isManagedAlive(mobileViteName)) {
    console.log(`[worktree] ${mobileViteName} already running — reusing it.`);
  } else if (!(await isPortFree(ports.mobileVite))) {
    console.warn(
      `[worktree] Port ${ports.mobileVite} (Mobile Vite) is busy — skipping the mobile-remote dev server; remote access serves the built bundle instead.`,
    );
  } else {
    startManagedProcess(
      mobileViteName,
      ["pnpm", "-F", "@camber/mobile-remote", "dev"],
      worktreeRoot,
      env,
    );
    console.log(`[worktree] Started ${mobileViteName}`);
  }

  if (isManagedAlive(desktopName)) {
    console.log(`[worktree] ${desktopName} already running — reusing it.`);
  } else {
    await ensurePortFree(ports.desktopCamberQA, "Desktop CamberQA");
    startManagedProcess(
      desktopName,
      [
        camberqaTsx,
        path.join(PACKAGE_DIR, "src/server.ts"),
        "--target",
        "desktop",
        "--desktop-dev-port",
        String(ports.desktopVite),
        ...(opts.color ? ["--desktop-color", opts.color] : []),
      ],
      worktreeRoot,
      env,
    );
    console.log(`[worktree] Started ${desktopName}`);
  }

  try {
    await waitForProcess(desktopName, {
      timeoutMs: 90_000,
      healthUrl: `http://localhost:${ports.desktopCamberQA}/health`,
      stableMs: 2000,
    });
    const desktopState = readState(desktopName);
    if (desktopState) {
      updateSlotOwner(slot, id, desktopState.pid);
      envData.pid = desktopState.pid;
      fs.writeFileSync(
        path.join(worktreeRoot, ".worktree-env.json"),
        JSON.stringify(envData, null, 2),
      );
    }
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    await manageStopWithOptions(desktopName, { tolerateMissing: true, tolerateErrors: true });
    await manageStopWithOptions(desktopViteName, { tolerateMissing: true, tolerateErrors: true });
    releaseSlot(slot);
    try {
      fs.unlinkSync(path.join(worktreeRoot, ".worktree-env.json"));
    } catch {}
    process.exit(1);
  }

  console.log(`[worktree] Desktop started`);
}

async function worktreeDown(target: "vscode" | "desktop", args: string[]): Promise<void> {
  const all = args.includes("--all");
  const targets: Array<"vscode" | "desktop"> = all ? ["vscode", "desktop"] : [target];
  const worktreeRoot = realpathSafe(resolveWorktreeRoot());
  const envFile = findWorktreeEnv(process.env.CAMBERQA_CALLER_CWD || process.cwd());
  let env: WorktreeEnv | null = null;
  if (envFile) {
    try {
      env = JSON.parse(fs.readFileSync(envFile, "utf-8"));
    } catch {}
  }

  // Stop the selected targets' managed processes that belong to THIS worktree,
  // identified by their recorded cwd rather than the slot number alone. A stale
  // .worktree-env.json can point at a slot that another worktree has since
  // reclaimed — matching by cwd guarantees we never kill someone else's services.
  const patterns = servicePatternsForTargets(targets);
  const owned = listStates().filter(
    (s) =>
      patterns.some((pattern) => pattern.test(s.id)) &&
      isPathInside(realpathSafe(s.cwd), worktreeRoot),
  );
  for (const state of owned) {
    await manageStopWithOptions(state.id, { tolerateMissing: true, tolerateErrors: true });
  }
  if (owned.length === 0) {
    console.log(`[worktree] No running ${targets.join("/")} services found for this worktree.`);
  }

  // Slot bookkeeping. Trust the recorded slot only while the lock is still ours.
  const id = env?.id ?? detectGitWorktreeInfo()?.id ?? null;
  const ownedSlots = new Set(
    owned
      .map((s) => Number.parseInt(s.id.match(/-s(\d+)$/)?.[1] ?? "-1", 10))
      .filter((n) => n >= 0),
  );
  let slot = env?.slot ?? null;
  if (slot !== null && !ownedSlots.has(slot)) {
    const owner = slotOwnerId(slot);
    if (owner !== null && id !== null && owner !== id) {
      console.warn(
        `[worktree] Slot ${slot} from .worktree-env.json now belongs to "${owner}" — leaving its services untouched.`,
      );
      slot = null;
    }
  }
  if (slot === null && id !== null) slot = findSlotForWorktreeId(id);
  if (slot === null && ownedSlots.size === 1) slot = [...ownedSlots][0];

  if (slot !== null) {
    if (targets.includes("desktop")) {
      cleanupDesktopOrphans(slot);
    }
    // Drop server state files for the stopped targets so later CLI calls fail
    // fast instead of finding a dead server's state.
    for (const t of targets) {
      try {
        fs.unlinkSync(`/tmp/camberqa-server-${targetCamberQAPort(slot, t)}.json`);
      } catch {}
    }
  }

  // Release the slot and env file only once nothing of this worktree is left
  // running (e.g. `desktop down` keeps the slot while vscode is still up).
  const allPatterns = servicePatternsForTargets(["vscode", "desktop"]);
  const remaining = listStates().filter(
    (s) =>
      allPatterns.some((pattern) => pattern.test(s.id)) &&
      isPathInside(realpathSafe(s.cwd), worktreeRoot) &&
      isProcessAlive(s.pid),
  );
  if (remaining.length > 0) {
    console.log(
      `[worktree] Stopped ${targets.join("/")} services; keeping slot ${slot ?? "?"} (${remaining
        .map((s) => s.id)
        .join(", ")} still running)`,
    );
    return;
  }

  if (slot !== null) releaseSlot(slot);
  if (envFile) {
    try {
      fs.unlinkSync(envFile);
    } catch {}
  }
  console.log(
    slot !== null
      ? `[worktree] Slot ${slot} released, services stopped, env cleaned up`
      : "[worktree] Services stopped, env cleaned up",
  );
}

async function worktreeStatus(): Promise<void> {
  const envFile = findWorktreeEnv(process.env.CAMBERQA_CALLER_CWD || process.cwd());
  const detected = detectWorktree();

  if (!envFile && !detected) {
    console.log("Not in a worktree (main workspace, slot 0)");
    console.log(
      `Ports — VS Code Vite: 5173, Desktop Vite: 5177, Mobile Vite: 5179, API: 8889, VS Code CamberQA: 9500, Desktop CamberQA: 9505, Remote: 8737`,
    );
  } else if (envFile) {
    const env: WorktreeEnv = JSON.parse(fs.readFileSync(envFile, "utf-8"));
    console.log(`Worktree: ${env.id}`);
    console.log(`Slot: ${env.slot}`);
    const owner = slotOwnerId(env.slot);
    if (owner !== null && owner !== env.id) {
      console.log(
        `⚠ Stale: slot ${env.slot} now belongs to "${owner}". Re-run 'camberqa vscode|desktop up' here.`,
      );
    }
    console.log(`Profile: ${env.profile}`);
    // Older .worktree-env.json files predate the remote/mobileVite ports.
    const slotPorts = portsForSlot(env.slot);
    console.log(
      `Ports — VS Code Vite: ${env.ports.vite}, Desktop Vite: ${env.ports.desktopVite}, Mobile Vite: ${env.ports.mobileVite ?? slotPorts.mobileVite}, API: 8889, VS Code CamberQA: ${env.ports.camberqa}, Desktop CamberQA: ${env.ports.desktopCamberQA}, Remote: ${env.ports.remote ?? slotPorts.remote}`,
    );
    console.log(`Agent mode override: ${env.agentMode ?? "none"}`);
  }

  console.log("");

  const slots = listSlots();
  if (slots.length === 0) {
    console.log("No active worktree slots.");
  } else {
    console.log("Active worktree slots:");
    for (const s of slots) {
      const ports = portsForSlot(s.slot);
      const status = s.alive ? "alive" : "dead";
      console.log(
        `  Slot ${s.slot}: ${s.id} (PID ${s.pid}, ${status}) — VSCodeVite:${ports.vite} DesktopVite:${ports.desktopVite} MobileVite:${ports.mobileVite} API:8889 VSCodeCamberQA:${ports.camberqa} DesktopCamberQA:${ports.desktopCamberQA} Remote:${ports.remote}`,
      );
    }
  }
}

function worktreeEnvCmd(): void {
  const envFile = findWorktreeEnv(process.env.CAMBERQA_CALLER_CWD || process.cwd());
  const detected = detectWorktree();

  let slot: number;
  let id: string;

  if (envFile) {
    const env: WorktreeEnv = JSON.parse(fs.readFileSync(envFile, "utf-8"));
    slot = env.slot;
    id = env.id;
  } else if (detected) {
    slot = detected.slot;
    id = detected.id;
  } else {
    slot = 0;
    id = "main";
  }

  const ports = portsForSlot(slot);

  console.log(`export CAMBER_WORKTREE_SLOT=${slot}`);
  console.log(`export CAMBER_WORKTREE_ID=${id}`);
  console.log(`export VITE_DEV_PORT=${ports.vite}`);
  console.log(`export DESKTOP_VITE_DEV_PORT=${ports.desktopVite}`);
  console.log(`export CAMBERQA_PORT=${ports.camberqa}`);
  console.log(`export DESKTOP_CAMBERQA_PORT=${ports.desktopCamberQA}`);
  console.log(`export CAMBERQA_PORT_START=${ports.camberqa}`);
  console.log(`export CAMBERQA_STATE_FILE=/tmp/camberqa-server-${ports.camberqa}.json`);
  console.log(`export CAMBER_REMOTE_PORT=${ports.remote}`);
  console.log(`export CAMBER_MOBILE_VITE_PORT=${ports.mobileVite}`);
}

export async function handleTargetCommand(
  target: "vscode" | "desktop",
  args: string[],
): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "up":
      await worktreeUp(args.slice(1), target);
      break;
    case "down":
      await worktreeDown(target, args.slice(1));
      break;
    case "status":
      await worktreeStatus();
      break;
    case "env":
      worktreeEnvCmd();
      break;
    default:
      console.log(`Usage: camberqa ${target} <up|down|status|env>

  up [--fast]${target === "vscode" ? " [--acp|--lsp]" : " [--color HEX] [--worktree-name NAME]"}
                                            Start ${target} services for this worktree
  down [--all]                              Stop ${target} services (--all: both targets);
                                            releases the slot once nothing is left running
  status                                    Show current worktree and all slots
  env                                       Print shell-sourceable env vars`);
      break;
  }
}
