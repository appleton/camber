import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, FrameLocator, Locator, Page } from "playwright";
import { sleep } from "../utils.js";
import { slotColor } from "../worktree/shared.js";
import type { PanelInfo, WebIssue, WindowBounds, WindowInfo } from "./types.js";

export interface DesktopLaunchOptions {
  devPort?: number;
  worktreeSlot?: number;
  worktreeId?: string;
  color?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
}

export class DesktopTarget {
  readonly kind = "desktop" as const;

  private process: ChildProcess | null = null;
  private refMap: Map<string, Locator> = new Map();
  private lastSnapshot: string | null = null;
  private logLines: string[] = [];
  private logFile: string | null = null;
  private pendingCommands: Array<{ id: string; command: string; args: string[] }> = [];
  private pollWaiters: Array<() => void> = [];
  private bridgeSeenAt = 0;
  private bridgeResults = new Map<string, { ok: boolean; body?: string; error?: string }>();

  async launch(opts: DesktopLaunchOptions = {}): Promise<void> {
    const repoRoot = await this.findRepoRoot();
    if (!repoRoot) throw new Error("Cannot find repo root.");

    const appDir = path.join(repoRoot, "ui/apps/desktop-assistant");
    const viteConfigDist = path.join(repoRoot, "ui/config/vite/dist/index.js");
    const svelteConfigDist = path.join(repoRoot, "ui/config/svelte/dist/index.js");
    if (!fs.existsSync(viteConfigDist) || !fs.existsSync(svelteConfigDist)) {
      console.log(
        "[camberqa] Desktop dependencies not built — running pnpm turbo build -F @camber/desktop-assistant^...",
      );
      execFileSync("pnpm", ["turbo", "build", "-F", "@camber/desktop-assistant^..."], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      console.log("[camberqa] Desktop dependencies built successfully.");
    }

    // Spawning the `tauri` script below skips the `dev` script's
    // download:binaries step, so fetch the helper/sidecar binaries here. The
    // script reuses complete version-stamped binaries without a network call;
    // failures (for example, a fresh offline checkout) fall through to whatever
    // is already on disk.
    try {
      execFileSync("pnpm", ["download:binaries"], { cwd: appDir, stdio: "inherit" });
    } catch {
      console.warn(
        "[camberqa] download:binaries failed — continuing with the binaries already in src-tauri/binaries.",
      );
    }

    const devPort = opts.devPort ?? Number(process.env.VITE_DEV_PORT ?? 5177);
    const slot =
      (opts.worktreeSlot ?? Number(process.env.CAMBER_WORKTREE_SLOT || "0")) || undefined;
    const worktreeId = opts.worktreeId ?? process.env.CAMBER_WORKTREE_ID ?? "main";
    const isMain = !slot && worktreeId === "main";
    const folderName = path.basename(repoRoot);
    const color = isMain
      ? undefined
      : (opts.color ?? process.env.CAMBERQA_DESKTOP_COLOR ?? slotColor(slot));
    const titleSuffix = slot ? `s${slot} ${worktreeId}` : worktreeId;
    const title = `Camber ${titleSuffix}`;
    const identSuffix = crypto
      .createHash("sha256")
      .update(`${repoRoot}:${slot ?? 0}:${worktreeId}`)
      .digest("hex")
      .slice(0, 8);
    const configPath = path.join(os.tmpdir(), `camberqa-tauri-${identSuffix}.json`);
    const launchLogPath = path.join(os.tmpdir(), `camberqa-tauri-${identSuffix}.log`);
    const helperLogPath = path.join(os.tmpdir(), `camberqa-desktop-helper-${identSuffix}.log`);
    const devUrl = new URL(`http://localhost:${devPort}`);
    if (color) devUrl.searchParams.set("camberqaColor", color);
    if (!isMain) devUrl.searchParams.set("camberqaWorktreeName", worktreeId);
    devUrl.searchParams.set("camberqaFolderName", folderName);
    if (opts.bridgeUrl && opts.bridgeToken) {
      devUrl.searchParams.set("camberqaBridgeUrl", opts.bridgeUrl);
      devUrl.searchParams.set("camberqaBridgeToken", opts.bridgeToken);
    }
    this.logFile = helperLogPath;

    // Give each worktree its own dock icon + dock-hover name. The icon is
    // compiled into the Tauri binary via generate_context!(), so a --config
    // overlay cannot change it; instead the Rust side tints the app icon to the
    // slot colour at runtime (src-tauri/src/app_icon.rs). A main / slot-less
    // launch passes no colour and keeps the untinted icon.

    const config = {
      identifier: `io.github.appleton.camber.camberqa.${identSuffix}`,
      productName: title,
      mainBinaryName: title,
      build: {
        devUrl: devUrl.toString(),
        beforeDevCommand: "",
      },
      app: {
        windows: [
          {
            label: "main",
            create: false,
            title,
            titleBarStyle: "Overlay",
            hiddenTitle: true,
            trafficLightPosition: {
              x: 16,
              y: 25,
            },
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 600,
            // WKWebView (macOS 14+) fully suspends JS in occluded windows by
            // default, which kills the bridge's fetch-poll loop whenever the
            // camberqa window sits behind another window. Automation must
            // keep working while hidden.
            backgroundThrottling: "disabled",
          },
        ],
      },
      bundle: {
        macOS: {
          bundleName: title,
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(launchLogPath, "");
    fs.writeFileSync(helperLogPath, "");

    this.process = spawn(
      "pnpm",
      ["tauri", "dev", "--config", configPath, "--features", "camberqa-profiling"],
      {
        cwd: appDir,
        env: {
          ...process.env,
          VITE_DEV_PORT: String(devPort),
          CAMBERQA_APP_NAME: title,
          ...(color ? { CAMBERQA_DOCK_ICON_COLOR: color } : {}),
          ...(color ? { VITE_CAMBERQA_COLOR: color } : {}),
          ...(!isMain ? { VITE_CAMBERQA_WORKTREE_NAME: worktreeId } : {}),
          ...(opts.bridgeUrl && opts.bridgeToken
            ? {
                VITE_CAMBERQA_BRIDGE_URL: opts.bridgeUrl,
                VITE_CAMBERQA_BRIDGE_TOKEN: opts.bridgeToken,
              }
            : {}),
          CAMBER_DESKTOP_HELPER_LOG_FILE: helperLogPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const appendLog = (chunk: Buffer) => {
      const text = chunk.toString();
      fs.appendFileSync(launchLogPath, text);
      this.logLines.push(...text.split(/\r?\n/));
      if (this.logLines.length > 500) this.logLines = this.logLines.slice(-500);
    };
    this.process.stdout?.on("data", appendLog);
    this.process.stderr?.on("data", appendLog);

    await this.waitForDevServer(devPort);
    await this.waitForBridge();
  }

  async close(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
    this.process = null;
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  async checkAlive(): Promise<boolean> {
    return Date.now() - this.bridgeSeenAt < 35_000;
  }

  async ensureReady(): Promise<boolean> {
    return this.checkAlive();
  }

  async focusWebview(): Promise<void> {
    // The Tauri window is the target; focusing is currently handled by the OS/app.
  }

  async reacquireAfterReload(): Promise<void> {
    throw new Error("Desktop target does not support reload through camberqa yet.");
  }

  async getWindowInfo(): Promise<WindowInfo> {
    throw new Error("Desktop target does not support native windowInfo yet.");
  }

  async setWindowBounds(_bounds: WindowBounds): Promise<void> {
    throw new Error("Desktop target does not support native setWindowBounds yet.");
  }

  getPage(): Page {
    throw new Error("Desktop target does not expose a Playwright Page.");
  }

  getWebviewFrame(): FrameLocator {
    throw new Error("Desktop target does not expose a Playwright frame.");
  }

  getRawFrame(): Frame | null {
    return null;
  }

  getCamberWebviewFrame(): FrameLocator {
    return this.getWebviewFrame();
  }

  getCamberRawFrame(): Frame | null {
    return this.getRawFrame();
  }

  async discoverPanels(): Promise<PanelInfo[]> {
    return [];
  }

  async selectPanel(name: string): Promise<void> {
    if (!"desktop".includes(name.toLowerCase())) {
      throw new Error('Panel not found. Available: "Desktop"');
    }
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  getCurrentPanelName(): string {
    return "Desktop";
  }

  setRefMap(refs: Map<string, Locator>) {
    this.refMap = refs;
  }

  resolveRef(selector: string): { locator: Locator } | { selector: string } {
    if (selector.startsWith("@e")) {
      const ref = selector.slice(1);
      const locator = this.refMap.get(ref);
      if (!locator) throw new Error(`Ref ${selector} not found. Run 'snapshot' to get fresh refs.`);
      return { locator };
    }
    return { selector };
  }

  setLastSnapshot(text: string | null) {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  getWebIssues(_opts: { includeAll?: boolean; limit?: number; clear?: boolean } = {}): WebIssue[] {
    throw new Error("Desktop web errors are collected through the webview bridge.");
  }

  findLatestHelperLog(): string | null {
    return this.logFile;
  }

  findLatestHelperLogByName(_helperLogName: string): string | null {
    return this.logFile;
  }

  async getDesktopRuntimeInfo(): Promise<{
    rustPid: number;
    rustExecutable: string;
    helperPid: number | null;
    helperLogPath: string | null;
    helperPprofUrl: string | null;
    rustProfilingEnabled: boolean;
  }> {
    const rustProcess = this.findRustProcess();
    if (!rustProcess) {
      throw new Error("Desktop Tauri shell process not found.");
    }

    const helperLogs =
      this.logFile && fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, "utf-8") : "";

    return {
      rustPid: rustProcess.pid,
      rustExecutable: rustProcess.command,
      helperPid: parseHelperPidFromLogs(helperLogs),
      helperLogPath: this.logFile,
      helperPprofUrl: parseHelperPprofURLFromLogs(helperLogs),
      rustProfilingEnabled: false,
    };
  }

  async runBridgeCommand(command: string, args: string[]): Promise<string> {
    const id = crypto.randomUUID();
    this.pendingCommands.push({ id, command, args });
    this.wakePoller();

    const timeoutMs =
      command === "camberqaProfileRustCpu"
        ? (Number.parseInt(args[0] || "30", 10) + 30) * 1000
        : 60_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = this.bridgeResults.get(id);
      if (result) {
        this.bridgeResults.delete(id);
        if (!result.ok) throw new Error(result.error ?? "Desktop bridge command failed");
        if ((command === "screenshot" || command === "screenshotElement") && result.body) {
          return this.materializeScreenshot(result.body);
        }
        return result.body ?? "";
      }
      await sleep(50);
    }
    throw new Error(`Desktop bridge command timed out: ${command}`);
  }

  async nextBridgeCommand(
    timeoutMs = 25_000,
  ): Promise<{ id: string; command: string; args: string[] } | null> {
    this.bridgeSeenAt = Date.now();
    const existing = this.pendingCommands.shift();
    if (existing) return existing;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.pollWaiters = this.pollWaiters.filter((candidate) => candidate !== waiter);
        resolve();
      }, timeoutMs);
      this.pollWaiters.push(waiter);
    });
    this.bridgeSeenAt = Date.now();
    return this.pendingCommands.shift() ?? null;
  }

  completeBridgeCommand(id: string, result: { ok: boolean; body?: string; error?: string }): void {
    this.bridgeSeenAt = Date.now();
    this.bridgeResults.set(id, result);
  }

  private wakePoller(): void {
    const waiter = this.pollWaiters.shift();
    waiter?.();
  }

  private materializeScreenshot(raw: string): string {
    const parsed = JSON.parse(raw) as {
      output: string;
      dataUrl?: string;
      sourcePath?: string;
      crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
        viewportWidth: number;
        viewportHeight: number;
      };
    };
    if (parsed.dataUrl) {
      const base64 = parsed.dataUrl.replace(/^data:image\/png;base64,/, "");
      fs.writeFileSync(parsed.output, Buffer.from(base64, "base64"));
    } else if (parsed.sourcePath && parsed.crop) {
      this.cropNativeScreenshot(parsed.sourcePath, parsed.output, parsed.crop);
    } else if (parsed.sourcePath) {
      fs.copyFileSync(parsed.sourcePath, parsed.output);
    }
    return `Screenshot saved to ${parsed.output}`;
  }

  private cropNativeScreenshot(
    sourcePath: string,
    outputPath: string,
    crop: {
      x: number;
      y: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    },
  ): void {
    const { width: imageWidth, height: imageHeight } = this.imageDimensions(sourcePath);
    const scaleX = imageWidth / crop.viewportWidth;
    const scaleY = imageHeight / crop.viewportHeight;
    const x = Math.max(0, Math.floor(crop.x * scaleX));
    const y = Math.max(0, Math.floor(crop.y * scaleY));
    const width = Math.max(1, Math.min(imageWidth - x, Math.ceil(crop.width * scaleX)));
    const height = Math.max(1, Math.min(imageHeight - y, Math.ceil(crop.height * scaleY)));

    execFileSync("sips", [
      "--cropToHeightWidth",
      String(height),
      String(width),
      "--cropOffset",
      String(y),
      String(x),
      sourcePath,
      "--out",
      outputPath,
    ]);
  }

  private imageDimensions(imagePath: string): { width: number; height: number } {
    const output = execFileSync(
      "sips",
      ["--getProperty", "pixelWidth", "--getProperty", "pixelHeight", imagePath],
      { encoding: "utf-8" },
    );
    const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Could not read screenshot dimensions for ${imagePath}`);
    }
    return { width, height };
  }

  private async waitForDevServer(port: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.process?.exitCode !== null) {
        throw new Error(
          `Desktop process exited during startup.\n${this.logLines.slice(-80).join("\n")}`,
        );
      }
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok || resp.status === 404) return;
      } catch {
        // keep waiting
      }
      await sleep(500);
    }
    throw new Error(`Timed out waiting for desktop dev server on port ${port}`);
  }

  private async waitForBridge(timeout = 180_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.checkAlive()) return;
      await sleep(250);
    }
    throw new Error("Timed out waiting for desktop webview bridge.");
  }

  private async findRepoRoot(): Promise<string | null> {
    const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const fromPackage = path.resolve(packageDir, "../../..");
    if (fs.existsSync(path.join(fromPackage, "ui/apps/desktop-assistant/package.json"))) {
      return fromPackage;
    }

    try {
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        cwd: process.cwd(),
      }).trim();
      if (fs.existsSync(path.join(root, "ui/apps/desktop-assistant/package.json"))) {
        return root;
      }
    } catch {
      // Not in a git repo.
    }

    return null;
  }

  private findRustProcess(): { pid: number; command: string } | null {
    const rootPid = this.process?.pid;
    if (!rootPid) return null;

    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf-8",
    })
      .split(/\r?\n/)
      .map(parseProcessRow)
      .filter((row): row is ProcessRow => row !== null);
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const siblings = children.get(row.ppid) ?? [];
      siblings.push(row);
      children.set(row.ppid, siblings);
    }

    const descendants: ProcessRow[] = [];
    const queue = [...(children.get(rootPid) ?? [])];
    while (queue.length > 0) {
      const row = queue.shift()!;
      descendants.push(row);
      queue.push(...(children.get(row.pid) ?? []));
    }

    return (
      // The overlay names the dev binary after the slot title, so match any
      // binary built into the desktop app's debug target.
      descendants.find((row) => row.command.includes("/src-tauri/target/debug/")) ?? null
    );
  }
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function parseProcessRow(line: string): ProcessRow | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    ppid: Number.parseInt(match[2], 10),
    command: match[3],
  };
}

function parseHelperPprofURLFromLogs(logs: string): string | null {
  const matches = [...logs.matchAll(/pprof listening on.*?\baddr=(?:"([^"]+)"|([^\s]+))/g)];
  const lastMatch = matches[matches.length - 1];
  const raw = lastMatch?.[1] ?? lastMatch?.[2];
  if (!raw) return null;

  const port = raw.match(/:(\d+)$/)?.[1];
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}

function parseHelperPidFromLogs(logs: string): number | null {
  const matches = [...logs.matchAll(/\bpid=(\d+)/g)];
  const raw = matches[matches.length - 1]?.[1];
  return raw ? Number.parseInt(raw, 10) : null;
}
